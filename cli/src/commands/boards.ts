// list / export / import (M6, docs/plan.md "Operations"): REST commands
// against the live daemon — unlike token/open/install these never touch the
// local db, because every write (import) must flow through the daemon API
// (invariant 3) and reads want the same view agents see.
import type { Config } from "../../../server/src/config.ts";
import { originUrlFor } from "../../../server/src/daemon.ts";
import type { CommandIo } from "./token.ts";

export const BOARDS_USAGE =
  "usage: board list | board export <board_id> [file] | board import <file>";

// The commands only ever call fetch with (url, init) — the seam's fakes don't
// implement the platform fetch surface (preconnect), so the field type is the
// narrow shape the commands use.
type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

interface BoardsCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a fake so nothing touches the network (open.ts's
  // openUrl pattern).
  fetchImpl?: FetchLike;
}

interface ParsedArgs {
  positional: string[];
  token: string;
}

// Token precedence: --token flag > BOARD_TOKEN env. No token-file plumbing —
// the existing mint path (`make token add <name>`) prints a token once and
// the caller keeps it like the dogfood token.
function parseArgs(argv: string[], maxPositional: number): ParsedArgs | string {
  const positional: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token") {
      token = argv[i + 1];
      i++;
      continue;
    }
    if (arg?.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > maxPositional) {
    return `unexpected argument "${positional[maxPositional]}"`;
  }
  if (token === undefined || token.length === 0) {
    const env = process.env.BOARD_TOKEN;
    if (env !== undefined && env.trim().length > 0) {
      token = env.trim();
    }
  }
  if (token === undefined || token.length === 0) {
    return "no token: pass --token <token> or set BOARD_TOKEN (mint one with: make token add cli)";
  }
  return { positional, token };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

// Same table style as `token list`: pad columns, trim the ragged right edge.
function renderTable(header: string[], rows: string[][]): string[] {
  const widths = header.map(
    (label, i) =>
      label.length +
      rows.reduce((max, row) => Math.max(max, row[i].length - label.length), 0),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i], " "))
      .join("  ")
      .trimEnd();
  return [render(header), ...rows.map(render)];
}

async function runListCommand(
  input: BoardsCommandInput,
  parsed: ParsedArgs,
): Promise<number> {
  const { io, config, fetchImpl } = input;
  const url = new URL("/api/boards", originUrlFor(config.host, config.port));
  const res = await (fetchImpl ?? fetch)(url, {
    headers: bearer(parsed.token),
  });
  if (!res.ok) {
    io.stderr(`board: ${await errorMessage(res)}`);
    return 1;
  }
  interface ListRow {
    id: string;
    status: string;
    current_version: number;
    unresolved_comments: number;
    title: string;
  }
  const boards = (await res.json()) as ListRow[];
  if (boards.length === 0) {
    io.stdout("no boards yet; publish one with the board MCP tools");
    return 0;
  }
  for (const line of renderTable(
    ["ID", "STATUS", "VERSIONS", "UNRESOLVED", "TITLE"],
    boards.map((b) => [
      b.id,
      b.status,
      String(b.current_version),
      String(b.unresolved_comments),
      b.title,
    ]),
  )) {
    io.stdout(line);
  }
  return 0;
}

async function runExportCommand(
  input: BoardsCommandInput,
  parsed: ParsedArgs,
): Promise<number> {
  const { io, config, fetchImpl } = input;
  const boardId = parsed.positional[0];
  if (boardId === undefined || boardId.length === 0) {
    io.stderr("board: export needs a board id");
    io.stderr(BOARDS_USAGE);
    return 1;
  }
  // default: <board_id>.zip in the current directory
  const file = parsed.positional[1] ?? `${boardId}.zip`;
  const url = new URL(
    `/api/boards/${boardId}/export`,
    originUrlFor(config.host, config.port),
  );
  const res = await (fetchImpl ?? fetch)(url, {
    headers: bearer(parsed.token),
  });
  if (!res.ok) {
    io.stderr(`board: ${await errorMessage(res)}`);
    return 1;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    await Bun.write(file, bytes);
  } catch (err) {
    io.stderr(
      `board: could not write ${file} (${err instanceof Error ? err.message : String(err)})`,
    );
    return 1;
  }
  io.stdout(`wrote ${file} (${bytes.byteLength} bytes)`);
  return 0;
}

async function runImportCommand(
  input: BoardsCommandInput,
  parsed: ParsedArgs,
): Promise<number> {
  const { io, config, fetchImpl } = input;
  const file = parsed.positional[0];
  if (file === undefined || file.length === 0) {
    io.stderr("board: import needs a bundle file");
    io.stderr(BOARDS_USAGE);
    return 1;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  } catch (err) {
    io.stderr(
      `board: could not read ${file} (${err instanceof Error ? err.message : String(err)})`,
    );
    return 1;
  }
  const url = new URL(
    "/api/boards/import",
    originUrlFor(config.host, config.port),
  );
  const res = await (fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { ...bearer(parsed.token), "content-type": "application/zip" },
    body: bytes,
  });
  if (!res.ok) {
    io.stderr(`board: ${await errorMessage(res)}`);
    return 1;
  }
  const board = (await res.json()) as { id: string; title: string };
  io.stdout(`imported "${board.title}" as board ${board.id}`);
  return 0;
}

function argError(io: CommandIo, message: string): number {
  io.stderr(`board: ${message}`);
  io.stderr(BOARDS_USAGE);
  return 1;
}

export async function runBoardsCommand(
  command: string,
  input: BoardsCommandInput,
): Promise<number> {
  const parsed =
    command === "list"
      ? parseArgs(input.argv, 0)
      : command === "export"
        ? parseArgs(input.argv, 2)
        : command === "import"
          ? parseArgs(input.argv, 1)
          : null;
  if (parsed === null) {
    input.io.stderr(BOARDS_USAGE);
    return 1;
  }
  if (typeof parsed === "string") {
    return argError(input.io, parsed);
  }
  if (command === "list") {
    return runListCommand(input, parsed);
  }
  if (command === "export") {
    return runExportCommand(input, parsed);
  }
  return runImportCommand(input, parsed);
}
