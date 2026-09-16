import type { Database } from "bun:sqlite";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// The id length every URL-visible short id shares (boards, assets); the
// asset-serving route pattern keys on exactly this shape.
export const SHORT_ID_LENGTH = 10;

export function shortId(length = SHORT_ID_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += BASE62[byte % BASE62.length];
  }
  return id;
}

// only used in-module by newId's exists seam
type IdExists = (id: string) => boolean;

const MAX_RETRIES = 5;

// Shared unique-short-id helper (boards, assets): retries past collisions
// detected via the exists seam. The default seam consults the boards table —
// callers for other tables pass their own.
export function newId(
  db: Database,
  exists: IdExists = (id) =>
    db.prepare("SELECT 1 FROM boards WHERE id = ?").get(id) !== null,
): string {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const id = shortId();
    if (!exists(id)) {
      return id;
    }
  }
  throw new Error(
    `could not generate a unique id after ${MAX_RETRIES} retries`,
  );
}
