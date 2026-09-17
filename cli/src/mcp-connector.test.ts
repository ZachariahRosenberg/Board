// MCP connector tests (wave 1). The proxy path runs against REAL daemons
// (the repo's integration precedent: REST + MCP via the SDK client) — the
// connector's own resolution logic runs in-process through handleMessage,
// plus real subprocess proofs for both runtimes it ships as: bun via the
// cli dispatch, and node (the opencode path: `node cli/src/mcp-connector.ts`
// with NO bun on PATH — the environment fact that motivated the connector).
// Temp BOARD_DATA_DIR everywhere — never ~/.board.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../../server/test/helpers.ts";
import { parseInstanceEnv, parseInstanceJson } from "./instance-registry.ts";
import {
  instancePaths,
  spawnInstance,
  writeInstanceEntry,
} from "./instances.ts";
import {
  type ConnectorContext,
  connectorContext,
  handleLine,
  handleMessage,
} from "./mcp-connector.ts";

const dirs: string[] = [];
const spawned: Array<{ pid: number; dataDir: string }> = [];

afterAll(async () => {
  for (const { pid, dataDir } of spawned) {
    if (existsSync(`/proc/${pid}`)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A loopback port with nothing on it (closed immediately) — the "shared
// daemon down" fixture.
function closedPort(): number {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  server.close();
  return port;
}

function connectorEnv(opts: {
  dataDir: string;
  port: number;
  token?: string;
}): Record<string, string> {
  return {
    BOARD_DATA_DIR: opts.dataDir,
    BOARD_HOST: "127.0.0.1",
    BOARD_PORT: String(opts.port),
    ...(opts.token === undefined ? {} : { BOARD_MCP_TOKEN: opts.token }),
  };
}

function contextFor(opts: { dataDir: string; port: number; token?: string }): {
  ctx: ConnectorContext;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  return {
    ctx: connectorContext(connectorEnv(opts), (m) => diagnostics.push(m)),
    diagnostics,
  };
}

// One JSON-RPC request through the connector; returns the parsed response.
async function rpc(
  ctx: ConnectorContext,
  method: string,
  params?: Record<string, unknown>,
  id: number | null = 1,
): Promise<Record<string, unknown>> {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) {
    message.id = id;
  }
  if (params !== undefined) {
    message.params = params;
  }
  const out = await handleMessage(message, ctx);
  if (out === null) {
    throw new Error(`expected a response for ${method}, got none`);
  }
  return JSON.parse(out) as Record<string, unknown>;
}

async function callTool(
  ctx: ConnectorContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await rpc(ctx, "tools/call", { name, arguments: args });
  return res.result as Record<string, unknown>;
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0]?.text ?? "";
}

async function liveToolsList(
  s: TestServer,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${s.hostUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  return body.result.tools;
}

describe("mcp connector — proxy path (real daemon)", () => {
  test("tools/call board_create works end to end against a real temp daemon", async () => {
    const s = startTestServer();
    try {
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: (await s.createAgent("connector-agent")).token,
      });
      const result = await callTool(ctx, "board_create", {
        title: "Via connector",
        format: "markdown",
      });
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(toolText(result)) as { id: string };
      expect(created.id).toBeTruthy();
      // The board really exists on the proxied daemon.
      const token = (await s.createAgent("connector-verifier")).token;
      const res = await s.api.get(`/api/boards/${created.id}`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        board: { title: string; current_version: number };
      };
      expect(body.board.title).toBe("Via connector");
      expect(body.board.current_version).toBe(0);
    } finally {
      await s.stop();
    }
  });

  test("relayed response and diagnostics never contain the token", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("hygiene-agent")).token;
      const { ctx, diagnostics } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token,
      });
      // Drive initialize, tools/list, and a proxied call — the full message
      // surface — collecting every stdout line the connector would emit.
      const lines: Array<string | null> = [];
      for (const message of [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "board_list", arguments: {} },
        },
        "not json at all",
      ]) {
        lines.push(await handleMessage(message, ctx));
      }
      const stdout = lines.filter((l): l is string => l !== null).join("\n");
      expect(stdout.length).toBeGreaterThan(0);
      expect(stdout).not.toContain(token);
      // Per-request backend diagnostics (they name the resolved backend, by
      // design) never carry credential material — same invariant as stdout.
      expect(diagnostics.join("\n")).not.toContain(token);
    } finally {
      await s.stop();
    }
  });
});

describe("mcp connector — no backend", () => {
  test("tools/call answers isError with the start-one guidance", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const result = await callTool(ctx, "board_create", { title: "x" });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe(
      "no board server is running. Start one: run `make up` (or `board up`) " +
        "for a task-scoped session board you own, or ask the human to start " +
        "the shared library (`make serve`). The connector re-resolves on " +
        "every call — retry after starting one.",
    );
  });

  test("offline tools/list matches the live daemon's tools/list exactly", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("parity-agent")).token;
      const live = await liveToolsList(s, token);
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: closedPort(),
      });
      const res = await rpc(ctx, "tools/list");
      const offline = (res.result as { tools: Array<Record<string, unknown>> })
        .tools;
      // Same order, same names/descriptions/schemas — element-wise deep
      // compare (the parity hard requirement).
      expect(offline).toEqual(live);
      expect(offline).toHaveLength(13);
    } finally {
      await s.stop();
    }
  });

  test("other methods get -32601 with no backend; unparsable lines get -32700 id null", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const res = await rpc(ctx, "resources/list");
    expect(res.error).toEqual({
      code: -32601,
      message: expect.stringContaining("resources/list"),
    });
    // -32700 is the FRAMING layer's answer (JSON.parse happens on the line,
    // before message logic) — handleLine is that seam.
    const bad = await handleLine("{{{", ctx);
    expect(bad).not.toBeNull();
    expect(JSON.parse(bad as string)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: expect.any(String) },
    });
  });

  test("initialize answers immediately without any backend", async () => {
    const { ctx } = contextFor({
      dataDir: freshDir("board-connector-test-"),
      port: closedPort(),
    });
    const res = await rpc(ctx, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode", version: "1.18.31" },
    });
    expect(res.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "board", version: "0.7.0" },
    });
    // notifications get no response at all
    expect(
      await handleMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ctx,
      ),
    ).toBeNull();
  });

  test("invalid BOARD_* environment degrades to offline mode with one diagnostic", async () => {
    const diagnostics: string[] = [];
    const ctx = connectorContext(
      { BOARD_DATA_DIR: "/tmp/opencode/unused", BOARD_PORT: "not-a-port" },
      (m) => diagnostics.push(m),
    );
    expect(ctx.sharedUrl).toBeNull();
    expect(ctx.instancesDir).toBeNull();
    expect(diagnostics).toHaveLength(1);
    const res = await rpc(ctx, "tools/list");
    expect((res.result as { tools: unknown[] }).tools).toHaveLength(13);
  });
});

describe("mcp connector — backend resolution order", () => {
  test("shared daemon preferred when healthy AND BOARD_MCP_TOKEN present", async () => {
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "instance-agent",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port),
        token: (await s.createAgent("shared-agent")).token,
      });
      const result = await callTool(ctx, "board_create", {
        title: "Shared wins",
      });
      const created = JSON.parse(toolText(result)) as { id: string };
      // The board landed on the SHARED daemon, not the instance.
      const token = (await s.createAgent("shared-verifier")).token;
      const res = await s.api.get(`/api/boards/${created.id}`, { token });
      expect(res.status).toBe(200);
      const instRes = await fetch(
        `${instance.entry.url}/api/boards/${created.id}`,
        { headers: { authorization: `Bearer ${instance.token}` } },
      );
      expect(instRes.status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  test("instance used when shared daemon is down", async () => {
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "instance-agent",
    });
    spawned.push({ pid: instance.entry.pid, dataDir: instance.entry.dataDir });
    const { ctx } = contextFor({
      dataDir: registry,
      port: closedPort(), // shared: down
    });
    const result = await callTool(ctx, "board_create", {
      title: "Instance serves",
    });
    expect(result.isError).toBeUndefined();
    const created = JSON.parse(toolText(result)) as { id: string };
    const res = await fetch(`${instance.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${instance.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("empty-string BOARD_MCP_TOKEN counts as absent: instance serves", async () => {
    // {env:VAR} interpolation in opencode configs yields "" when the variable
    // is unset — an empty credential must not pin routing to the shared daemon.
    const s = startTestServer();
    try {
      const registry = freshDir("board-connector-test-");
      const instance = await spawnInstance({
        registryDataDir: registry,
        agentTokenName: "empty-token-agent",
      });
      spawned.push({
        pid: instance.entry.pid,
        dataDir: instance.entry.dataDir,
      });
      const { ctx } = contextFor({
        dataDir: registry,
        port: Number(new URL(s.hostUrl).port), // shared: healthy
        token: "",
      });
      const result = await callTool(ctx, "board_create", {
        title: "Empty token falls through",
      });
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(toolText(result)) as { id: string };
      const res = await fetch(
        `${instance.entry.url}/api/boards/${created.id}`,
        {
          headers: { authorization: `Bearer ${instance.token}` },
        },
      );
      expect(res.status).toBe(200); // landed on the instance, not shared
    } finally {
      await s.stop();
    }
  });

  test("shared 401 relays the re-mint hint (credential missing or rejected)", async () => {
    const s = startTestServer();
    try {
      // Well-formed but unknown credential: shared healthy, branch 1 routes
      // there, the daemon 401s — the relay must name the fix.
      const { ctx } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
        token: "tok_revoked0000000000000000000000000000000000000",
      });
      const res = await rpc(ctx, "tools/list");
      const message = (res.error as { message: string }).message;
      expect(message).toContain("returned HTTP 401");
      expect(message).toContain(
        "re-mint + rewire with: make install FLAGS=--force",
      );
      // Same hint on the no-token path (shared healthy, nothing wired): its
      // 401 is the honest misconfiguration signal — now with the fix attached.
      const { ctx: bare } = contextFor({
        dataDir: freshDir("board-connector-test-"),
        port: Number(new URL(s.hostUrl).port),
      });
      const bareRes = await rpc(bare, "tools/list");
      expect((bareRes.error as { message: string }).message).toContain(
        "re-mint + rewire with: make install FLAGS=--force",
      );
    } finally {
      await s.stop();
    }
  });

  test("multiple healthy instances: newest createdAt wins", async () => {
    const registry = freshDir("board-connector-test-");
    const older = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "older-agent",
    });
    const newer = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "newer-agent",
    });
    spawned.push(
      { pid: older.entry.pid, dataDir: older.entry.dataDir },
      { pid: newer.entry.pid, dataDir: newer.entry.dataDir },
    );
    // Deterministic recency: stamp the entries' own createdAt fields.
    const olderPaths = instancePaths(registry, older.entry.id);
    const newerPaths = instancePaths(registry, newer.entry.id);
    writeInstanceEntry(olderPaths, {
      ...older.entry,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    writeInstanceEntry(newerPaths, {
      ...newer.entry,
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
    const result = await callTool(ctx, "board_create", {
      title: "Newest wins",
    });
    const created = JSON.parse(toolText(result)) as { id: string };
    const onNewer = await fetch(`${newer.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${newer.token}` },
    });
    expect(onNewer.status).toBe(200);
    const onOlder = await fetch(`${older.entry.url}/api/boards/${created.id}`, {
      headers: { authorization: `Bearer ${older.token}` },
    });
    expect(onOlder.status).toBe(404);
    // Flip the stamps: routing follows recency, not scan order.
    writeInstanceEntry(olderPaths, {
      ...older.entry,
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    writeInstanceEntry(newerPaths, {
      ...newer.entry,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const flipped = await callTool(ctx, "board_create", {
      title: "Older now newest",
    });
    const created2 = JSON.parse(toolText(flipped)) as { id: string };
    const onOlder2 = await fetch(
      `${older.entry.url}/api/boards/${created2.id}`,
      {
        headers: { authorization: `Bearer ${older.token}` },
      },
    );
    expect(onOlder2.status).toBe(200);
  });

  test("structural guard: non-loopback/malformed urls are skipped and never fetched", async () => {
    // The trap: a LIVE server behind a url that must NEVER be fetched
    // ("localhost" is not the literal 127.0.0.1 the guard demands).
    let hits = 0;
    const trap = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const registry = freshDir("board-connector-test-");
      const instances = join(registry, "instances");
      const write = (id: string, url: string): void => {
        mkdirSync(join(instances, id), { recursive: true });
        writeFileSync(
          join(instances, id, "instance.json"),
          JSON.stringify({
            id,
            pid: 1,
            url,
            dataDir: "/tmp/opencode/unused",
            agentTokenName: "trap",
            createdAt: "2026-09-02T00:00:00.000Z",
          }),
        );
      };
      write("s-trapurl0001", `http://localhost:${trap.port}`); // alias — must be skipped
      write("s-trapbind0002", `http://0.0.0.0:${trap.port}`); // wildcard — skipped
      write("s-trapschm0003", `https://127.0.0.1:${trap.port}`); // wrong scheme — skipped
      write("s-trapgarb0004", "not-a-url"); // malformed — skipped
      // A shape-valid instance that is simply DOWN: proves the isError below
      // comes from the guard having skipped the trap, not from "no entries".
      write("s-trapdead0005", `http://127.0.0.1:${closedPort()}`);
      const { ctx } = contextFor({ dataDir: registry, port: closedPort() });
      const result = await callTool(ctx, "board_create", { title: "x" });
      expect(result.isError).toBe(true);
      expect(hits).toBe(0); // the trap was never fetched, not even health-checked
    } finally {
      await trap.stop(true);
    }
  });
});

describe("mcp connector — subprocess proofs", () => {
  test("node spawn (the opencode path): PATH without bun, initialize + instance-proxied tools/list", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "node not found on PATH — the opencode-path test needs it",
      );
    }
    // Instance-resolved call: no BOARD_MCP_TOKEN and a closed shared port —
    // the D21 default shape (shared daemon down, a session instance live).
    // This is the routing branch whose silent wrongness (newest-first across
    // concurrent instances) the per-request stderr diagnostic exists to
    // surface, so the real-opencode path must show the diagnostic too.
    const registry = freshDir("board-connector-test-");
    const instance = await spawnInstance({
      registryDataDir: registry,
      agentTokenName: "node-spawn-agent",
    });
    spawned.push({
      pid: instance.entry.pid,
      dataDir: instance.entry.dataDir,
    });
    const proc = Bun.spawn([node, join(import.meta.dir, "mcp-connector.ts")], {
      // opencode's environment shape: node on PATH, bun nowhere in it.
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpdir(),
        BOARD_DATA_DIR: registry,
        BOARD_HOST: "127.0.0.1",
        BOARD_PORT: String(closedPort()), // shared: down
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "opencode", version: "1.18.31" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const lines: string[] = [];
    let rawStdout = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (lines.length < 2 && Date.now() < deadline) {
      const chunk = (await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
      ])) as Awaited<ReturnType<typeof reader.read>> | "timeout";
      if (chunk === "timeout" || chunk.done) {
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      rawStdout += text;
      buffer += text;
      const split = buffer.split("\n");
      buffer = split.pop() ?? "";
      for (const line of split) {
        if (line.trim().length > 0) {
          lines.push(line);
        }
      }
    }
    expect(lines.length).toBe(2); // initialize + tools/list; notification silent
    const init = JSON.parse(lines[0]) as {
      id: number;
      result: Record<string, unknown>;
    };
    expect(init.id).toBe(1);
    expect(init.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "board", version: "0.7.0" },
    });
    const list = JSON.parse(lines[1]) as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(list.id).toBe(2);
    expect(list.result.tools).toHaveLength(13); // proxied to the live instance

    proc.stdin.end();
    expect(await proc.exited).toBe(0); // stdin EOF → exit 0
    // Credential + diagnostic hygiene across both streams of the real
    // subprocess (stdout already accumulated above — the stream is consumed):
    // the per-request diagnostic names the resolved backend but never the
    // instance credential it read from the registry env file.
    const stderr = await new Response(proc.stderr).text();
    expect(rawStdout).not.toContain(instance.token);
    expect(stderr).not.toContain(instance.token);
    expect(stderr).toContain(
      `board connector: backend ${instance.entry.url} (instance ${instance.entry.id})`,
    );
  });

  test("SIGTERM exits 0 promptly (the harness's shutdown signal)", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "node not found on PATH — the opencode-path test needs it",
      );
    }
    const proc = Bun.spawn([node, join(import.meta.dir, "mcp-connector.ts")], {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpdir(),
        BOARD_DATA_DIR: freshDir("board-connector-test-"),
        BOARD_PORT: String(closedPort()),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Wait until the connector is serving (it answers initialize) — a signal
    // during module load would take the default action, which is not the
    // scenario being tested (opencode signals an ESTABLISHED session).
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const initDeadline = Date.now() + 5_000;
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
      ]);
      if (Date.now() > initDeadline || (chunk !== "timeout" && chunk.done)) {
        throw new Error("connector never answered initialize");
      }
      if (chunk !== "timeout" && chunk.value.length > 0) {
        reader.cancel();
        break;
      }
    }
    proc.kill("SIGTERM");
    const exitedBefore = Promise.race([
      proc.exited,
      new Promise<1500>((r) => setTimeout(() => r(1500), 1500)),
    ]);
    expect(await exitedBefore).toBe(0);
    if (existsSync(`/proc/${proc.pid}`)) {
      proc.kill("SIGKILL"); // only if the prompt-exit assert failed
      await proc.exited;
    }
  });

  test("bun dispatch: `board mcp` (cli main) serves initialize + proxies a call", async () => {
    const s = startTestServer();
    try {
      const token = (await s.createAgent("dispatch-agent")).token;
      const registry = freshDir("board-connector-test-");
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "main.ts"), "mcp"],
        {
          env: connectorEnv({
            dataDir: registry,
            port: Number(new URL(s.hostUrl).port),
            token,
          }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const send = (message: unknown): void => {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        proc.stdin.flush();
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli", version: "0" },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "board_create", arguments: { title: "Dispatched" } },
      });
      const lines: string[] = [];
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 15_000;
      while (lines.length < 2 && Date.now() < deadline) {
        const chunk = (await Promise.race([
          reader.read(),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
        ])) as Awaited<ReturnType<typeof reader.read>> | "timeout";
        if (chunk === "timeout" || chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const split = buffer.split("\n");
        buffer = split.pop() ?? "";
        for (const line of split) {
          if (line.trim().length > 0) {
            lines.push(line);
          }
        }
      }
      expect(lines.length).toBe(2);
      const created = JSON.parse(lines[1]) as {
        id: number;
        result: { content: Array<{ text: string }> };
      };
      expect(created.id).toBe(2);
      const board = JSON.parse(created.result.content[0].text) as {
        id: string;
      };
      // The dispatched call really landed on the daemon.
      const verifier = (await s.createAgent("dispatch-verifier")).token;
      const res = await s.api.get(`/api/boards/${board.id}`, {
        token: verifier,
      });
      expect(res.status).toBe(200);
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).not.toContain(token);
    } finally {
      await s.stop();
    }
  });
});

// The shared parser module the connector depends on — pinned here because
// the connector's instance discovery and hygiene ride on its exact
// semantics (the same file instances.ts writes).
describe("instance-registry parsers", () => {
  test("parseInstanceEnv reads the writer's line discipline; garbage ignored", () => {
    const envText = [
      "# board session s-abc — source me; purged by board down",
      "export BOARD_INSTANCE=s-abc1234567",
      "export BOARD_PORT=7913",
      "export BOARD_TOKEN=tok_abcdef123456",
    ].join("\n");
    expect(parseInstanceEnv(envText)).toEqual({
      instance: "s-abc1234567",
      port: 7913,
      token: "tok_abcdef123456",
    });
    expect(parseInstanceEnv("export BOARD_TOKEN=")).toEqual({});
    expect(parseInstanceEnv("export  BOARD_TOKEN=x")).toEqual({}); // two spaces: not the writer's format
    expect(parseInstanceJson("not json")).toBeNull();
  });
});
