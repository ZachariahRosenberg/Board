import type { Database } from "bun:sqlite";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function shortId(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += BASE62[byte % BASE62.length];
  }
  return id;
}

export type BoardIdExists = (id: string) => boolean;

const MAX_RETRIES = 5;

export function newBoardId(
  db: Database,
  exists: BoardIdExists = (id) =>
    db.prepare("SELECT 1 FROM boards WHERE id = ?").get(id) !== null,
): string {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const id = shortId();
    if (!exists(id)) {
      return id;
    }
  }
  throw new Error(
    `could not generate a unique board id after ${MAX_RETRIES} retries`,
  );
}
