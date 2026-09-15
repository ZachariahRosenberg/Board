import type { Database } from "bun:sqlite";
import {
  type CreatedToken,
  createToken,
  listTokens,
  revokeToken,
  TokenNameTaken,
} from "../../../server/src/tokens.ts";

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface TokenCommandInput {
  db: Database;
  argv: string[];
  io: CommandIo;
}

const TOKEN_USAGE =
  "usage: board token add <name> | board token list | board token revoke <name>";

function tokenAdd(db: Database, name: string, io: CommandIo): number {
  let created: CreatedToken;
  try {
    created = createToken(db, { name });
  } catch (err) {
    if (err instanceof TokenNameTaken) {
      // The message carries the agent name only; no token material exists in this branch (invariant 8).
      io.stderr(`board: ${err.message}`);
      return 1;
    }
    throw err;
  }
  io.stdout(
    `token for "${created.name}" (store it now, it is not recoverable):`,
  );
  io.stdout(created.token);
  return 0;
}

function tokenList(db: Database, io: CommandIo): number {
  const tokens = listTokens(db);
  if (tokens.length === 0) {
    io.stdout("no tokens yet; create one with: board token add <name>");
    return 0;
  }
  const header = ["NAME", "CREATED", "LAST USED", "REVOKED"];
  const rows = tokens.map((info) => [
    info.name,
    info.created_at,
    info.last_used_at ?? "never",
    info.revoked_at === null ? "no" : "yes",
  ]);
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
  io.stdout(render(header));
  for (const row of rows) {
    io.stdout(render(row));
  }
  return 0;
}

function tokenRevoke(db: Database, name: string, io: CommandIo): number {
  const info = revokeToken(db, name);
  if (info === null) {
    io.stderr(`board: no token named "${name}"`);
    return 1;
  }
  io.stdout(`revoked token "${info.name}"`);
  return 0;
}

export function runTokenCommand({ db, argv, io }: TokenCommandInput): number {
  const [sub, ...rest] = argv;
  const name = rest[0];
  switch (sub) {
    case "add":
      if (name === undefined || name.length === 0) {
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      return tokenAdd(db, name, io);
    case "list":
      return tokenList(db, io);
    case "revoke":
      if (name === undefined || name.length === 0) {
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      return tokenRevoke(db, name, io);
    default:
      io.stderr(TOKEN_USAGE);
      return 1;
  }
}
