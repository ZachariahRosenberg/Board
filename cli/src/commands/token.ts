import type { Database } from "bun:sqlite";
import type { Config } from "../../../server/src/config.ts";
import { openDb } from "../../../server/src/db.ts";
import {
  type CreatedToken,
  createToken,
  listTokens,
  reMintToken,
  revokeToken,
  TokenNameTaken,
} from "../../../server/src/tokens.ts";
import { dbTarget } from "../resolve.ts";
import { renderTable } from "../table.ts";
import { scan } from "./rest.ts";

export interface CommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface TokenCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
}

export const TOKEN_USAGE =
  "usage: board token add <name> [--force] [--instance <id>] | board token list [--instance <id>] | board token revoke <name> [--instance <id>]";

function tokenAdd(
  db: Database,
  name: string,
  force: boolean,
  io: CommandIo,
): number {
  if (force) {
    // D17: names are permanent, so --force re-mints — revoke whatever row
    // holds the name and mint fresh under the first free suffix, keeping
    // the audit trail. Both facts print; the store-it-now line is the one
    // sanctioned plaintext surface (invariant 8).
    const { previous, created } = reMintToken(db, { name });
    if (previous !== null) {
      io.stdout(`revoked old token "${previous.name}"`);
    }
    io.stdout(
      `token for "${created.name}" (store it now, it is not recoverable):`,
    );
    io.stdout(created.token);
    return 0;
  }
  let created: CreatedToken;
  try {
    created = createToken(db, { name });
  } catch (err) {
    if (err instanceof TokenNameTaken) {
      // The message carries the agent name only; no token material exists in this branch (invariant 8).
      io.stderr(`board: ${err.message}`);
      // actionable tail (dogfooded dead-end: the owner hit this and had no
      // next step) — a taken name is permanent, so re-mint or rename
      io.stderr(
        "a taken name is permanent (D17); re-mint with --force or pick a new name",
      );
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
  for (const line of renderTable(header, rows)) {
    io.stdout(line);
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

// The human's-tool local-db path (invariant 4's sanctioned exception, same as
// `open`): token rows live in the target db — the shared data dir by default,
// the instance's temp db with --instance (D20 wave 2, resolve.ts). Opened only
// after argv/resolution pass, so usage errors never create the data dir (the
// twice-bitten footgun).
function withDb(
  config: Config,
  instance: string | undefined,
  io: CommandIo,
  run: (db: Database) => number,
): number {
  const target = dbTarget(config, instance);
  if (typeof target === "string") {
    io.stderr(`board: ${target}`);
    return 1;
  }
  const db = openDb(target.dataDir);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export function runTokenCommand({
  config,
  argv,
  io,
}: TokenCommandInput): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add": {
      // simple argv scan: flags and the name commute — `add --force cli` and
      // `add cli --force` both parse
      const scanned = scan(rest, ["--instance"], ["--force"]);
      if (typeof scanned === "string") {
        io.stderr(`board: ${scanned}`);
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      const name = scanned.positional[0];
      if (name === undefined || name.length === 0) {
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      return withDb(config, scanned.values.get("instance"), io, (db) =>
        tokenAdd(db, name, scanned.bools.has("force"), io),
      );
    }
    case "list": {
      const scanned = scan(rest, ["--instance"], []);
      if (typeof scanned === "string") {
        io.stderr(`board: ${scanned}`);
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      return withDb(config, scanned.values.get("instance"), io, (db) =>
        tokenList(db, io),
      );
    }
    case "revoke": {
      const scanned = scan(rest, ["--instance"], []);
      if (typeof scanned === "string") {
        io.stderr(`board: ${scanned}`);
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      const name = scanned.positional[0];
      if (name === undefined || name.length === 0) {
        io.stderr(TOKEN_USAGE);
        return 1;
      }
      return withDb(config, scanned.values.get("instance"), io, (db) =>
        tokenRevoke(db, name, io),
      );
    }
    default:
      io.stderr(TOKEN_USAGE);
      return 1;
  }
}
