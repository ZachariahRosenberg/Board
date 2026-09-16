// MCP Streamable HTTP endpoint (M5-lite, D16): twelve tools mapping 1:1 onto the
// service layer — the same functions the REST routes call, so the event log
// never distinguishes MCP agents from REST agents. Transport is the SDK's
// web-standard server transport in stateless JSON mode: every POST gets a
// fresh server + transport (no sessions), responses are application/json,
// and no SSE stream is ever held open on the daemon.
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ingestAssetFromPath } from "./assets.ts";
import { resolveRequestToken } from "./auth.ts";
import {
  countUnresolvedRoots,
  listComments,
  maxCommentSeq,
  recordCursorPresence,
  replyComment,
  resolveComment,
} from "./comments.ts";
import type { Actor } from "./domain.ts";
import { HttpError, readJsonBody } from "./http.ts";
import { filterBoards } from "./routes/boards.ts";
import {
  BoardNotFound,
  createBoard,
  endBoard,
  getBoard,
  listBoards,
  listVersions,
  publishVersion,
  restoreVersion,
  VersionConflict,
} from "./store.ts";
import { verifyToken } from "./tokens.ts";
import { subscribeWebhook } from "./webhooks.ts";

const MCP_SERVER_NAME = "board";
const MCP_SERVER_VERSION = "0.6.0";

interface McpContext {
  db: Database;
  dataDir: string;
  actor: Actor;
}

// Agent-only surface (D16): browser sessions are valid credentials elsewhere
// but never here (docs/security.md — the MCP endpoint is not a browser surface).
export function requireMcpActor(req: Request, db: Database): Actor {
  const token = resolveRequestToken(req);
  if (token === null || token.length === 0) {
    throw new HttpError(401, "unauthorized", "missing bearer token");
  }
  const info = verifyToken(db, token);
  if (info === null) {
    throw new HttpError(401, "unauthorized", "invalid or revoked token");
  }
  return { kind: "agent", name: info.name };
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Store errors are tool results (isError), never JSON-RPC protocol errors —
// the agent reads the message and retries. VersionConflict carries
// current_version so the retry can proceed without a second round-trip.
function toolErrorResult(err: unknown): CallToolResult {
  const message =
    err instanceof VersionConflict
      ? `${err.message} (current_version: ${err.current})`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(
  fn: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolErrorResult(err);
  }
}

function requireBoard(
  db: Database,
  boardId: string,
): NonNullable<ReturnType<typeof getBoard>> {
  const board = getBoard(db, boardId);
  if (board === null) {
    throw new BoardNotFound(boardId);
  }
  return board;
}

// Version metadata only — full content never rides back through MCP (publish
// payloads can be megabytes; the agent already holds what it published).
// content_bytes is the published source's byte length: the same measure the
// store's size cap applies to.
function versionMetaResult(
  version: Awaited<ReturnType<typeof publishVersion>>,
  contentBytes: number,
): CallToolResult {
  return textResult({
    board_id: version.board_id,
    n: version.n,
    label: version.label,
    note: version.note,
    anchors: version.anchors,
    created_by: version.created_by,
    created_at: version.created_at,
    content_bytes: contentBytes,
  });
}

// The service layer is async for publish/restore (render pipeline) and sync
// everywhere else; handlers await uniformly.
function registerBoardTools(
  server: McpServer,
  db: Database,
  dataDir: string,
  actor: Actor,
): void {
  server.registerTool(
    "board_create",
    {
      description:
        "Open a new board with a title, an optional format, and optional tags.",
      inputSchema: {
        title: z.string().min(1),
        format: z.enum(["markdown", "html"]).default("markdown"),
        tags: z.array(z.string()).optional(),
      },
    },
    ({ title, format, tags }) =>
      run(() =>
        textResult(
          createBoard(db, dataDir, {
            title,
            format,
            tags,
            actor: actor.name,
          }),
        ),
      ),
  );

  server.registerTool(
    "board_publish",
    {
      description:
        "Publish content to a board as a new immutable version, failing with current_version on a stale expected_version.",
      inputSchema: {
        board_id: z.string(),
        format: z.enum(["markdown", "html"]),
        content: z.string(),
        expected_version: z.number().int(),
        label: z.string().optional(),
        note: z.string().optional(),
      },
    },
    ({ board_id, format, content, expected_version, label, note }) =>
      run(async () => {
        const version = await publishVersion(db, dataDir, board_id, {
          format,
          content,
          expected_version,
          label,
          note,
          actor: actor.name,
        });
        return versionMetaResult(version, Buffer.byteLength(content, "utf8"));
      }),
  );

  server.registerTool(
    "board_list",
    {
      description:
        "List boards with unresolved comment counts, optionally filtered by status, tag, or author.",
      inputSchema: {
        status: z.enum(["open", "ended"]).optional(),
        tag: z.string().optional(),
        author: z.string().optional(),
      },
    },
    ({ status, tag, author }) =>
      run(() => {
        const boards = listBoards(db).map((board) => ({
          ...board,
          unresolved_comments: countUnresolvedRoots(db, board.id),
        }));
        return textResult(filterBoards(boards, { status, tag, author }));
      }),
  );

  server.registerTool(
    "board_get",
    {
      description: "Get a board with its full version metadata list.",
      inputSchema: { board_id: z.string() },
    },
    ({ board_id }) =>
      run(() => {
        const board = requireBoard(db, board_id);
        return textResult({ board, versions: listVersions(db, board_id) });
      }),
  );

  server.registerTool(
    "board_get_comments",
    {
      description:
        "Fetch comments with anchors and resolve state since a seq cursor — the one feedback consumption path; polls count as presence.",
      inputSchema: {
        board_id: z.string(),
        since: z.number().int().nonnegative().default(0),
      },
    },
    ({ board_id, since }) =>
      run(() => {
        requireBoard(db, board_id);
        recordCursorPresence(db, board_id, actor);
        const comments = listComments(db, board_id, since);
        const lastSeq = maxCommentSeq(db, board_id);
        return textResult({
          comments,
          last_seq:
            comments.length > 0 ? (comments.at(-1)?.seq ?? lastSeq) : lastSeq,
        });
      }),
  );

  server.registerTool(
    "board_reply",
    {
      description: "Reply in-thread to a comment, inheriting its anchor.",
      inputSchema: {
        comment_id: z.string(),
        body: z.string(),
      },
    },
    ({ comment_id, body }) =>
      run(() =>
        textResult(
          replyComment(db, dataDir, comment_id, { body, actor: actor.name }),
        ),
      ),
  );

  server.registerTool(
    "board_resolve",
    {
      description:
        "Mark a comment resolved once its feedback is actually addressed.",
      inputSchema: { comment_id: z.string() },
    },
    ({ comment_id }) =>
      run(() =>
        textResult(resolveComment(db, dataDir, comment_id, actor.name)),
      ),
  );

  server.registerTool(
    "board_restore",
    {
      description:
        "Republish an old version as a new one, keeping history linear.",
      inputSchema: {
        board_id: z.string(),
        from_n: z.number().int(),
        expected_version: z.number().int(),
      },
    },
    ({ board_id, from_n, expected_version }) =>
      run(async () =>
        textResult(
          await restoreVersion(db, dataDir, board_id, {
            from_n,
            expected_version,
            actor: actor.name,
          }),
        ),
      ),
  );

  server.registerTool(
    "board_end",
    {
      description: "End a board, making it read-only for all further writes.",
      inputSchema: { board_id: z.string() },
    },
    ({ board_id }) =>
      run(() => textResult(endBoard(db, dataDir, board_id, actor.name))),
  );

  server.registerTool(
    "board_subscribe",
    {
      description:
        "Register a webhook URL that receives signed board events as they are appended; re-subscribing replaces the previous URL.",
      inputSchema: {
        board_id: z.string(),
        webhook_url: z.string(),
        webhook_secret: z.string().optional(),
      },
    },
    ({ board_id, webhook_url, webhook_secret }) =>
      run(() =>
        textResult(
          subscribeWebhook(db, dataDir, board_id, {
            webhook_url,
            webhook_secret,
            actor: actor.name,
          }),
        ),
      ),
  );

  server.registerTool(
    "board_status",
    {
      description:
        "Report daemon liveness plus board and subscriber counts, optionally for one board.",
      inputSchema: { board_id: z.string().optional() },
    },
    ({ board_id }) =>
      run(() => {
        const boards = listBoards(db);
        const subscribers = db
          .prepare("SELECT COUNT(*) AS c FROM subscribers")
          .get() as { c: number };
        const status: Record<string, unknown> = {
          status: "ok",
          boards: {
            open: boards.filter((board) => board.status === "open").length,
            ended: boards.filter((board) => board.status === "ended").length,
          },
          subscribers: subscribers.c,
        };
        if (board_id !== undefined) {
          const board = requireBoard(db, board_id);
          status.board = {
            id: board.id,
            status: board.status,
            current_version: board.current_version,
            unresolved_comments: countUnresolvedRoots(db, board.id),
          };
        }
        return textResult(status);
      }),
  );

  server.registerTool(
    "board_upload_image",
    {
      description:
        "Copy a local image file (absolute path on the daemon's host) into a board as a verified, sanitized asset. Returns the asset id plus ready-to-paste embed snippets.",
      inputSchema: {
        board_id: z.string(),
        path: z.string().min(1),
      },
    },
    ({ board_id, path }) =>
      run(() => {
        const asset = ingestAssetFromPath(db, dataDir, board_id, {
          path,
          actor: actor.name,
        });
        return textResult({
          asset_id: asset.id,
          board_id: asset.board_id,
          mime: asset.mime,
          size: asset.size,
          embed_markdown: `![image](asset:${asset.id})`,
          embed_html: `<img src="/assets/${asset.id}">`,
        });
      }),
  );
}

export function handleMcpNonPost(): Response {
  // Stateless endpoint: no GET SSE stream and no sessions to DELETE
  // (Streamable HTTP spec — 405 for both, Allow: POST).
  return new Response(
    JSON.stringify({
      error: {
        code: "method_not_allowed",
        message: "MCP endpoint accepts POST only",
      },
    }),
    {
      status: 405,
      headers: { allow: "POST", "content-type": "application/json" },
    },
  );
}

export async function handleMcpPost(
  req: Request,
  ctx: McpContext,
): Promise<Response> {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  registerBoardTools(server, ctx.db, ctx.dataDir, ctx.actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // Read through readJsonBody so the 8 MB cap applies before the transport
  // sees the bytes; an empty body is left for the transport to reject as a
  // JSON-RPC parse error.
  const body = await readJsonBody(req);
  return transport.handleRequest(req, { parsedBody: body });
}
