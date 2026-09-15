import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { createToken } from "../src/tokens.ts";

export interface RequestOptions {
  token?: string;
  headers?: Record<string, string>;
}

export interface HttpClient {
  get(path: string, options?: RequestOptions): Promise<Response>;
  post(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Response>;
  put(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Response>;
  patch(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Response>;
  delete(path: string, options?: RequestOptions): Promise<Response>;
}

function makeHttpClient(baseUrl: string): HttpClient {
  const send = (
    method: string,
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<Response> => {
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }
    if (body === undefined) {
      return fetch(new URL(path, baseUrl), { method, headers });
    }
    headers["content-type"] = "application/json";
    return fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: JSON.stringify(body),
    });
  };
  return {
    get: (path, options) => send("GET", path, undefined, options),
    post: (path, body, options) => send("POST", path, body, options),
    put: (path, body, options) => send("PUT", path, body, options),
    patch: (path, body, options) => send("PATCH", path, body, options),
    delete: (path, options) => send("DELETE", path, undefined, options),
  };
}

export interface TestServer {
  dataDir: string;
  db: Database;
  hostUrl: string;
  originUrl: string;
  api: HttpClient;
  origin: HttpClient;
  createAgent(name: string): Promise<{ name: string; token: string }>;
  stop(): Promise<void>;
}

// Tests never touch the real ~/.board (invariant in AGENTS.md) — always a fresh temp BOARD_DATA_DIR.
export function startTestServer(): TestServer {
  const dataDir = mkdtempSync(join(tmpdir(), "board-test-"));
  const config = makeConfig({
    BOARD_DATA_DIR: dataDir,
    BOARD_HOST: "127.0.0.1",
    BOARD_PORT: "0",
    BOARD_ORIGIN_PORT: "0",
  });
  const daemon = startDaemon(config);
  return {
    dataDir,
    db: daemon.db,
    hostUrl: daemon.hostUrl,
    originUrl: daemon.originUrl,
    api: makeHttpClient(daemon.hostUrl),
    origin: makeHttpClient(daemon.originUrl),
    createAgent: async (name: string) => {
      const created = createToken(daemon.db, { name });
      return { name: created.name, token: created.token };
    },
    stop: () => daemon.stop(),
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function rawRequest(
  port: number,
  request: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      socket.write(
        request.endsWith("\r\n\r\n") ? request : `${request}\r\n\r\n`,
      );
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
    socket.on("close", () => {
      const raw = Buffer.concat(chunks).toString();
      const [head, ...rest] = raw.split("\r\n\r\n");
      const [statusLine, ...headerLines] = (head ?? "").split("\r\n");
      const status = Number.parseInt(
        (statusLine ?? "").split(" ")[1] ?? "0",
        10,
      );
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const sep = line.indexOf(":");
        if (sep === -1) {
          continue;
        }
        const name = line.slice(0, sep).trim().toLowerCase();
        const value = line.slice(sep + 1).trim();
        headers[name] =
          headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      resolve({ status, headers, body: rest.join("\r\n\r\n") });
    });
  });
}
