// The MCP tool surface's MANIFEST: names, descriptions, and zod input
// schemas — metadata only, no handlers. Consumed twice: server/src/mcp.ts
// registers the handlers against it (the daemon's /mcp endpoint), and
// cli/src/mcp-connector.ts reads it to answer tools/list when no backend is
// up (offline parity). The module is imported by node under type-stripping
// (opencode spawns the connector as `node …/mcp-connector.ts` — no bun on
// that PATH), so it may import ONLY zod and pure types: no Bun APIs, no
// bun:sqlite, no store/daemon internals.
import type { ZodRawShape } from "zod";
import { z } from "zod";

export const MCP_SERVER_NAME = "board";
// Consumed by the SDK handshake: it rides the initialize response's
// serverInfo.version (clients read it as getServerVersion()).
export const MCP_SERVER_VERSION = "0.7.0";

export type McpToolName =
  | "board_create"
  | "board_publish"
  | "board_list"
  | "board_get"
  | "board_get_comments"
  | "board_reply"
  | "board_resolve"
  | "board_restore"
  | "board_end"
  | "board_subscribe"
  | "board_status"
  | "board_upload_image"
  | "board_export";

export interface McpToolDef {
  name: McpToolName;
  description: string;
  // The raw zod shape exactly as registerTool receives it — the SDK wraps it
  // in z.object() and validates tool arguments against it before the handler
  // runs.
  inputSchema: ZodRawShape;
}

// Registration order is the tools/list order (the SDK preserves it) — do not
// reorder casually; the connector's offline listing must stay identical.
export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "board_create",
    description:
      "Open a new board with a title, an optional format, and optional tags.",
    inputSchema: {
      title: z.string().min(1),
      format: z.enum(["markdown", "html"]).default("markdown"),
      tags: z.array(z.string()).optional(),
    },
  },
  {
    name: "board_publish",
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
  {
    name: "board_list",
    description:
      "List boards with unresolved comment counts, optionally filtered by status, tag, or author.",
    inputSchema: {
      status: z.enum(["open", "ended"]).optional(),
      tag: z.string().optional(),
      author: z.string().optional(),
    },
  },
  {
    name: "board_get",
    description: "Get a board with its full version metadata list.",
    inputSchema: { board_id: z.string() },
  },
  {
    name: "board_get_comments",
    description:
      "Fetch comments with anchors and resolve state since a seq cursor — the one feedback consumption path; polls count as presence.",
    inputSchema: {
      board_id: z.string(),
      since: z.number().int().nonnegative().default(0),
    },
  },
  {
    name: "board_reply",
    description: "Reply in-thread to a comment, inheriting its anchor.",
    inputSchema: {
      comment_id: z.string(),
      body: z.string(),
    },
  },
  {
    name: "board_resolve",
    description:
      "Mark a comment resolved once its feedback is actually addressed.",
    inputSchema: { comment_id: z.string() },
  },
  {
    name: "board_restore",
    description:
      "Republish an old version as a new one, keeping history linear.",
    inputSchema: {
      board_id: z.string(),
      from_n: z.number().int(),
      expected_version: z.number().int(),
    },
  },
  {
    name: "board_end",
    description: "End a board, making it read-only for all further writes.",
    inputSchema: { board_id: z.string() },
  },
  {
    name: "board_subscribe",
    description:
      "Register a webhook URL that receives signed board events as they are appended; re-subscribing replaces the previous URL.",
    inputSchema: {
      board_id: z.string(),
      webhook_url: z.string(),
      webhook_secret: z.string().optional(),
    },
  },
  {
    name: "board_status",
    description:
      "Report daemon liveness plus board and subscriber counts, optionally for one board.",
    inputSchema: { board_id: z.string().optional() },
  },
  {
    name: "board_upload_image",
    description:
      "Copy a local image file (absolute path on the daemon's host) into a board as a verified, sanitized asset. Returns the asset id plus ready-to-paste embed snippets.",
    inputSchema: {
      board_id: z.string(),
      path: z.string().min(1),
    },
  },
  {
    name: "board_export",
    description:
      "Export a board as a self-contained zip bundle (manifest, version sources, comments, assets, event audit snapshot), base64-encoded in the `data` field of the result — decode it and save as <board_id>.zip. Works on ended boards; bundles over 8 MB must use REST GET /api/boards/:id/export instead.",
    inputSchema: { board_id: z.string() },
  },
];

// Offline tools/list rendering (the connector's no-backend answer). The
// daemon's own tools/list renders each raw shape through the SDK, which for
// zod v4 delegates to zod's toJSONSchema (draft-7 target, input io) — the
// same call made here, so the two listings agree; the execution field is the
// SDK's own default for non-task tools. Verified element-wise against a live
// daemon in cli/src/mcp-connector.test.ts; the SDK package itself is NOT
// imported because the connector (cli/src) cannot resolve it under node.
export function offlineToolList(): Array<{
  name: McpToolName;
  description: string;
  inputSchema: unknown;
  execution: { taskSupport: "forbidden" };
}> {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(tool.inputSchema), {
      target: "draft-7",
      io: "input",
    }),
    execution: { taskSupport: "forbidden" as const },
  }));
}
