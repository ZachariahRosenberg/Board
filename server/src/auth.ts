import type { Database } from "bun:sqlite";
import type { Actor } from "./domain.ts";
import { HttpError } from "./http.ts";
import { verifySessionToken } from "./sessions.ts";
import { verifyToken } from "./tokens.ts";

export function requireAuth(req: Request, db: Database): Actor {
  const header = req.headers.get("authorization");
  if (header === null) {
    throw new HttpError(401, "unauthorized", "missing Authorization header");
  }
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  const scheme = space === -1 ? "" : trimmed.slice(0, space).toLowerCase();
  const token = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (scheme !== "bearer" || token.length === 0) {
    throw new HttpError(
      401,
      "unauthorized",
      "expected Authorization: Bearer <token>",
    );
  }
  const info = verifyToken(db, token);
  if (info !== null) {
    return { kind: "agent", name: info.name };
  }
  // Human browser sessions (docs/security.md): a kind='session' row from the
  // one-time ?token= exchange authenticates as the single local human.
  if (verifySessionToken(db, token)) {
    return { kind: "human", name: "human" };
  }
  // Invariant 8 (AGENTS.md): the token value must never surface in errors or logs — describe the failure, not the credential.
  throw new HttpError(401, "unauthorized", "invalid or revoked token");
}
