import type { Database } from "bun:sqlite";
import { createHash, getRandomValues } from "node:crypto";

// docs/security.md "human browser session": `board open` mints a one-time
// exchange token for the URL; the SPA swaps it at /api/session/exchange for a
// long-lived bearer stored in localStorage. Both kinds are random ≥128-bit
// (we use 256-bit like agent tokens) and stored SHA-256 only — the plaintext
// exists solely in the minting call's return value (invariant 8).

export class InvalidExchangeToken extends Error {
  constructor() {
    // Deliberately generic: no token material and no reason code, so callers
    // can't distinguish "never issued" from "already spent" by the message.
    super("exchange token is invalid, expired, or already used");
    this.name = "InvalidExchangeToken";
  }
}

interface SessionRow {
  token_hash: string;
  kind: string;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
  board_id: string | null;
}

const TOKEN_BYTES = 32;
const EXCHANGE_TTL_MS = 10 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return Buffer.from(getRandomValues(new Uint8Array(TOKEN_BYTES))).toString(
    "base64url",
  );
}

export function createExchangeToken(db: Database, boardId?: string): string {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXCHANGE_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (token_hash, kind, created_at, expires_at, board_id) VALUES (?, 'exchange', ?, ?, ?)",
  ).run(hashToken(token), now.toISOString(), expiresAt, boardId ?? null);
  return token;
}

export function exchangeSession(db: Database, exchangeToken: string): string {
  const now = new Date();
  // One transaction so the used_at claim and the session insert commit together:
  // a crash in between can never leave a spent exchange without its session.
  const exchange = db.transaction((): string => {
    const row = db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(hashToken(exchangeToken)) as SessionRow | null;
    if (
      row === null ||
      row.kind !== "exchange" ||
      row.used_at !== null ||
      (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime())
    ) {
      throw new InvalidExchangeToken();
    }
    // Conditional update = atomic one-time claim, the real reuse guard.
    const claimed = db
      .prepare(
        "UPDATE sessions SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
      )
      .run(now.toISOString(), row.token_hash);
    if (claimed.changes !== 1) {
      throw new InvalidExchangeToken();
    }
    const sessionToken = newToken();
    db.prepare(
      "INSERT INTO sessions (token_hash, kind, created_at, board_id) VALUES (?, 'session', ?, ?)",
    ).run(hashToken(sessionToken), now.toISOString(), row.board_id);
    return sessionToken;
  });
  return exchange();
}

export function verifySessionToken(db: Database, token: string): boolean {
  const row = db
    .prepare("SELECT kind, expires_at FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as Pick<SessionRow, "kind" | "expires_at"> | null;
  if (row === null || row.kind !== "session") {
    return false;
  }
  // Sessions have no expiry (exchange tokens do); the guard keeps this honest
  // if a future migration ever adds one.
  return row.expires_at === null || Date.parse(row.expires_at) > Date.now();
}
