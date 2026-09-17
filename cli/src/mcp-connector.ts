// Agent-side stdio MCP connector (wave 1): the local MCP server agent
// harnesses (opencode) spawn — always connects, tools always listed — and
// which resolves a REAL backend per request: the shared daemon when healthy
// (with its token), else the newest healthy session instance (D20), else an
// honest offline answer. The user's opencode has no bun on PATH, so the
// wiring runs this file as `node cli/src/mcp-connector.ts` under node ≥24
// type-stripping — the whole import graph must stay Bun-free and
// erasable-syntax-only (no enums, namespaces, or parameter properties; no
// bun: sqlite/Bun APIs; the SDK is not resolvable from cli/ under node).
//
// Wire protocol: newline-delimited JSON-RPC on stdin/stdout. stdout is
// protocol ONLY; stderr carries rare diagnostics and never tokens
// (invariant 7). The connector never writes to disk (invariant 3). Loopback
// discipline (invariant 1) holds in two different ways: registry-derived
// (instance) URLs are enforced structurally — only a literal
// http://127.0.0.1:<port> is ever fetched — while the shared-daemon URL is
// built from the BOARD_* environment and trusted as explicit configuration
// (invariant 1's carve-out: the documented Docker opt-out in
// docs/deployment.md).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfig } from "../../server/src/config.ts";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  offlineToolList,
} from "../../server/src/mcp-tools.ts";
import { parseInstanceEnv, parseInstanceJson } from "./instance-registry.ts";

// The SDK 1.30 LATEST_PROTOCOL_VERSION. Hardcoded because the SDK package is
// not node-resolvable from cli/src; it only matters for clients that omit
// protocolVersion in initialize (opencode always sends one, which we echo).
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const HEALTH_TIMEOUT_MS = 1_000;
const PROXY_TIMEOUT_MS = 60_000;

// The structural guard for registry urls (M8 audit lesson: a crafted entry
// can falsify identity, not filesystem shape). Only a LITERAL loopback http
// URL is ever fetched — localhost aliases, other hosts, other schemes, and
// malformed strings are skipped without a single request.
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+$/;

const NO_BACKEND_GUIDANCE =
  "no board server is running. Start one: run `make up` (or `board up`) " +
  "for a task-scoped session board you own, or ask the human to start the " +
  "shared library (`make serve`). The connector re-resolves on every call — " +
  "retry after starting one.";

export interface ConnectorContext {
  // The shared daemon's config-derived URL (http://<host>:<port>); null when
  // the BOARD_* environment is invalid.
  sharedUrl: string | null;
  // Shared-library credential from BOARD_MCP_TOKEN (what `make install`
  // wires into agent configs) — never logged, only forwarded as a bearer.
  sharedToken: string | null;
  // <dataDir>/instances — the D20 registry to scan for session daemons.
  instancesDir: string | null;
  // Diagnostic channel for per-request backend lines (stderr in the real
  // process, a collector in tests) — the same channel as the invalid-env
  // diagnostic below.
  diagnose: (message: string) => void;
}

// Resolution provenance, carried end to end: the per-request stderr
// diagnostic labels the backend `(shared)` or `(instance <id>)`, and a
// shared-backend 401 appends the re-mint hint — a shared-credential fix. An
// instance token is ephemeral and re-resolved per request, so it gets neither.
type Backend =
  | { kind: "shared"; url: string; token: string | null }
  | { kind: "instance"; id: string; url: string; token: string | null };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Environment → connector context. The env is static for the process's
// lifetime, so this parses ONCE; the BACKENDS it points at are re-resolved
// per request (health changes, instances come and go).
export function connectorContext(
  env: Record<string, string | undefined>,
  diagnose: (message: string) => void,
): ConnectorContext {
  try {
    const config = makeConfig(env);
    // Empty string counts as absent: {env:VAR} interpolation in opencode
    // configs yields "" when the variable is unset, and an empty credential
    // must not pin routing to the shared daemon (it would 401 there instead
    // of falling through to the session instances).
    const sharedToken = env.BOARD_MCP_TOKEN;
    return {
      sharedUrl: `http://${config.host}:${config.port}`,
      sharedToken:
        sharedToken !== undefined && sharedToken.trim().length > 0
          ? sharedToken
          : null,
      instancesDir: join(config.dataDir, "instances"),
      diagnose,
    };
  } catch (err) {
    // Invalid BOARD_* env must never crash the client's spawn: one stderr
    // diagnostic, then the connector serves the offline manifest.
    diagnose(
      `board mcp: ignoring invalid BOARD_* environment (${errText(err)})`,
    );
    return {
      sharedUrl: null,
      sharedToken: null,
      instancesDir: null,
      diagnose,
    };
  }
}

// Registry scan → candidate backends, newest-first by the entry's own
// createdAt (the field `board up` stamps). Sync, cheap, re-run per request.
// Everything here is an instance backend by construction — the shared daemon
// never comes from the registry.
interface InstanceCandidate {
  kind: "instance";
  id: string;
  url: string;
  token: string | null;
  createdAtMs: number;
}

function instanceCandidates(instancesDir: string | null): Backend[] {
  if (instancesDir === null) {
    return [];
  }
  let ids: string[];
  try {
    ids = readdirSync(instancesDir);
  } catch {
    return []; // no registry yet — no instances
  }
  const candidates: InstanceCandidate[] = [];
  for (const id of ids) {
    let entry: ReturnType<typeof parseInstanceJson>;
    try {
      entry = parseInstanceJson(
        readFileSync(join(instancesDir, id, "instance.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (entry === null) {
      continue; // unreadable/torn entry — corrupt, never fetched
    }
    if (entry.closedAt !== undefined) {
      continue; // torn down: env purged, daemon dead by construction
    }
    if (typeof entry.url !== "string" || !LOOPBACK_URL.test(entry.url)) {
      continue; // structural guard: skip without fetching
    }
    let token: string | null = null;
    try {
      token =
        parseInstanceEnv(readFileSync(join(instancesDir, id, "env"), "utf8"))
          .token ?? null;
    } catch {
      token = null; // env file unreadable → no credential; health still checked
    }
    const createdAtMs = Date.parse(entry.createdAt);
    candidates.push({
      kind: "instance",
      id,
      url: entry.url,
      token,
      createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
    });
  }
  return candidates
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map(({ kind, id, url, token }) => ({ kind, id, url, token }));
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // not listening / timed out
  }
}

// Resolution order, per request, never cached:
//   1. shared daemon healthy + BOARD_MCP_TOKEN present → shared wins (the
//      persistent library, D21);
//   2. else session instances, newest-first, first healthy wins (we hold the
//      instance env file's credential);
//   3. shared healthy but NO token env → route to shared anyway so its 401
//      surfaces the misconfiguration honestly, unless an instance can serve.
async function resolveBackend(ctx: ConnectorContext): Promise<Backend | null> {
  const sharedHealthy =
    ctx.sharedUrl !== null && (await isHealthy(ctx.sharedUrl));
  if (sharedHealthy && ctx.sharedToken !== null && ctx.sharedUrl !== null) {
    return { kind: "shared", url: ctx.sharedUrl, token: ctx.sharedToken };
  }
  for (const candidate of instanceCandidates(ctx.instancesDir)) {
    if (await isHealthy(candidate.url)) {
      return candidate;
    }
  }
  if (sharedHealthy && ctx.sharedUrl !== null) {
    return { kind: "shared", url: ctx.sharedUrl, token: null };
  }
  return null;
}

function errorResponse(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Stateless JSON mode (D16) on the backend: one POST = one complete
// JSON-RPC response, relayed verbatim. Never throws.
async function proxyToBackend(
  backend: Backend,
  message: Record<string, unknown>,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${backend.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The Streamable HTTP transport requires both accept types on POST;
        // the stateless JSON endpoint (D16) still answers application/json.
        accept: "application/json, text/event-stream",
        ...(backend.token !== null
          ? { authorization: `Bearer ${backend.token}` }
          : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (err) {
    return JSON.stringify(
      errorResponse(
        message.id ?? null,
        -32603,
        `board server at ${backend.url} is unreachable: ${errText(err)}`,
      ),
    );
  }
  const body = await res.text();
  if (!res.ok) {
    // The daemon's HTTP-level rejections (401/405/413…) carry its own
    // {error:{code,message}} envelope, not a JSON-RPC response — relaying
    // those verbatim would hand the client a non-protocol object, so the
    // failure surfaces as a JSON-RPC error naming the status instead. A
    // shared-backend 401 is the revoked/unwired-credential case, so the
    // relay appends the re-mint fix; other statuses (405/413 — not credential
    // problems) and instance backends (ephemeral credentials, re-resolved per
    // request) get no hint.
    const reMintHint =
      backend.kind === "shared" && res.status === 401
        ? " — the shared-library credential is missing or rejected; " +
          "re-mint + rewire with: make install FLAGS=--force"
        : "";
    return JSON.stringify(
      errorResponse(
        message.id ?? null,
        -32603,
        `board server at ${backend.url} returned HTTP ${res.status}${reMintHint}`,
      ),
    );
  }
  return body;
}

// One parsed stdin message → one stdout line (or null: notifications and
// client-initiated chatter never get a response). Local answers (initialize,
// ping) never touch a backend; everything else resolves one per request.
export async function handleMessage(
  message: unknown,
  ctx: ConnectorContext,
): Promise<string | null> {
  if (!isRecord(message) || typeof message.method !== "string") {
    // Batch arrays and other non-request shapes are not part of the stdio
    // line protocol — answered as invalid request where an id exists.
    const id = isRecord(message) ? (message.id ?? null) : null;
    return JSON.stringify(errorResponse(id, -32600, "invalid request"));
  }
  if (!("id" in message)) {
    return null; // notification: consume silently, never responded
  }
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      // Respond immediately without any backend (opencode handshakes before
      // any daemon may exist). Mirrors the daemon's initialize response
      // shape: protocolVersion, capabilities, serverInfo.
      const params = isRecord(message.params) ? message.params : {};
      const requested = params.protocolVersion;
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof requested === "string" ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
    }
    case "ping":
      return JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    default:
      break;
  }

  const backend = await resolveBackend(ctx);
  if (backend === null) {
    if (message.method === "tools/list") {
      // Offline manifest: the same thirteen tools with the same JSON Schemas
      // the live daemon advertises (parity pinned by tests).
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: offlineToolList() },
      });
    }
    if (message.method === "tools/call") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: NO_BACKEND_GUIDANCE }],
          isError: true,
        },
      });
    }
    return JSON.stringify(
      errorResponse(
        id,
        -32601,
        `method "${message.method}" not found: no board server is running`,
      ),
    );
  }
  // One stderr line per proxied request naming the resolved backend (D22
  // audit finding): with concurrent session instances the newest-first route
  // can silently land a call on the wrong instance — this surfaces the choice
  // in the harness's MCP log. stdout stays protocol-only, and no token
  // material ever reaches either stream (invariant 7).
  ctx.diagnose(
    backend.kind === "shared"
      ? `board connector: backend ${backend.url} (shared)`
      : `board connector: backend ${backend.url} (instance ${backend.id})`,
  );
  return proxyToBackend(backend, message);
}

// One stdin LINE → one stdout line (or null: notifications never get a
// response). The framing seam: unparsable JSON is a -32700 error with a null
// id here, before any message logic runs.
export async function handleLine(
  line: string,
  ctx: ConnectorContext,
): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return JSON.stringify(
      errorResponse(null, -32700, "parse error: line is not valid JSON"),
    );
  }
  return handleMessage(message, ctx);
}

// Full session: newline-delimited JSON-RPC from stdin until EOF, responses to
// stdout (drained per line so nothing is lost at exit). Returns the process
// exit code — 0 for a clean EOF.
export async function runMcpConnector(): Promise<number> {
  const ctx = connectorContext(process.env, (message) => {
    process.stderr.write(`board mcp: ${message}\n`);
  });
  // Prompt exit on the harness's shutdown signals — no in-flight request is
  // worth lingering for.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  const writeLine = (line: string): Promise<void> =>
    new Promise((resolveWrite) => {
      process.stdout.write(`${line}\n`, () => resolveWrite());
    });

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const out = await handleLine(line, ctx);
      if (out !== null) {
        await writeLine(out);
      }
    }
  }
  if (buffer.length > 0) {
    const out = await handleLine(buffer, ctx); // final line without its newline
    if (out !== null) {
      await writeLine(out);
    }
  }
  return 0;
}

// Direct node entry — the opencode wiring spawns exactly this:
// `node cli/src/mcp-connector.ts`. import.meta.main is a bun-ism (undefined
// under node), so the node case detects the entry by argv comparison.
const entryPath = process.argv[1];
if (
  import.meta.main ||
  (entryPath !== undefined &&
    resolve(entryPath) === fileURLToPath(import.meta.url))
) {
  void runMcpConnector().then((code) => process.exit(code));
}
