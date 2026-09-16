import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Board,
  BoardFormat,
  BoardStatus,
  ExtractedAnchor,
  Version,
  VersionMeta,
} from "./domain.ts";
import { appendEventDb, type EventInput, mirrorEventFiles } from "./events.ts";
import { MAX_BODY_BYTES } from "./http.ts";
import { newId } from "./ids.ts";
import { renderHtmlDocument, renderMarkdownDocument } from "./render.ts";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export class BoardNotFound extends StoreError {
  constructor(boardId: string) {
    super(`board "${boardId}" not found`);
    this.name = "BoardNotFound";
  }
}

export class VersionNotFound extends StoreError {
  constructor(boardId: string, n: number) {
    super(`version ${n} of board "${boardId}" not found`);
    this.name = "VersionNotFound";
  }
}

export class VersionConflict extends StoreError {
  readonly expected: number;
  readonly current: number;

  constructor(boardId: string, expected: number, current: number) {
    super(
      `version conflict on board "${boardId}": expected ${expected}, current ${current}`,
    );
    this.name = "VersionConflict";
    this.expected = expected;
    this.current = current;
  }
}

export class BoardEnded extends StoreError {
  constructor(boardId: string) {
    super(`board "${boardId}" is ended`);
    this.name = "BoardEnded";
  }
}

export class ContentTooLarge extends StoreError {
  constructor(bytes: number) {
    super(
      `content is ${bytes} bytes, exceeding the ${MAX_BODY_BYTES} byte cap (docs/security.md "Content rules")`,
    );
    this.name = "ContentTooLarge";
  }
}

// Shared "board exists and is open" gate for every write path (assets imports
// it too): BoardNotFound for unknown ids, BoardEnded for writes after end
// (docs/plan.md: end → writes 409).
export function requireOpenBoard(db: Database, boardId: string): Board {
  const board = getBoard(db, boardId);
  if (board === null) {
    throw new BoardNotFound(boardId);
  }
  if (board.status !== "open") {
    throw new BoardEnded(boardId);
  }
  return board;
}

interface BoardRow {
  id: string;
  title: string;
  format: string;
  status: string;
  tags: string;
  created_by: string;
  created_at: string;
  current_version: number;
}

interface VersionRow {
  board_id: string;
  n: number;
  label: string | null;
  note: string | null;
  content?: string;
  source_md?: string | null;
  anchors: string;
  created_by: string;
  created_at: string;
}

function mapBoardRow(row: BoardRow): Board {
  return {
    id: row.id,
    title: row.title,
    format: row.format as BoardFormat,
    status: row.status as BoardStatus,
    tags: JSON.parse(row.tags) as string[],
    created_by: row.created_by,
    created_at: row.created_at,
    current_version: row.current_version,
  };
}

function mapVersionRow(row: VersionRow): Version {
  return {
    board_id: row.board_id,
    n: row.n,
    label: row.label,
    note: row.note,
    content: row.content ?? "",
    source_md: row.source_md ?? null,
    anchors: JSON.parse(row.anchors) as ExtractedAnchor[],
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function mapVersionMetaRow(row: VersionRow): VersionMeta {
  return {
    board_id: row.board_id,
    n: row.n,
    label: row.label,
    note: row.note,
    anchors: JSON.parse(row.anchors) as ExtractedAnchor[],
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function boardJsonPath(dataDir: string, boardId: string): string {
  return join(dataDir, "boards", boardId, "board.json");
}

// board.json is the human-greppable metadata snapshot of the bundle (no db-isms:
// domain shapes only).
function writeBoardJson(dataDir: string, board: Board): void {
  writeFileSync(
    boardJsonPath(dataDir, board.id),
    `${JSON.stringify(board, null, 2)}\n`,
  );
}

function versionsDir(dataDir: string, boardId: string): string {
  return join(dataDir, "boards", boardId, "versions");
}

interface CreateBoardInput {
  title: string;
  format: BoardFormat;
  tags?: string[];
  actor: string;
}

export function createBoard(
  db: Database,
  dataDir: string,
  input: CreateBoardInput,
): Board {
  const id = newId(db);
  const board: Board = {
    id,
    title: input.title,
    format: input.format,
    status: "open",
    tags: [...(input.tags ?? [])],
    created_by: input.actor,
    created_at: new Date().toISOString(),
    current_version: 0,
  };
  // Write-order discipline (events.ts:41): the db row and its event commit
  // together in this transaction; the bundle files (dirs, board.json, jsonl
  // mirrors) are written after the commit — on a crash the files can lag the
  // db but never lead it.
  const write = db.transaction(() => {
    db.prepare(
      "INSERT INTO boards (id, title, format, status, tags, created_by, created_at, current_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      board.id,
      board.title,
      board.format,
      board.status,
      JSON.stringify(board.tags),
      board.created_by,
      board.created_at,
      board.current_version,
    );
    return appendEventDb(db, {
      actor: input.actor,
      type: "board.created",
      boardId: id,
      payload: { title: board.title, format: board.format },
    });
  });
  const ev = write();
  mkdirSync(versionsDir(dataDir, id), { recursive: true });
  mkdirSync(join(dataDir, "boards", id, "assets"), { recursive: true });
  writeBoardJson(dataDir, board);
  mirrorEventFiles(dataDir, ev);
  return board;
}

export function getBoard(db: Database, id: string): Board | null {
  const row = db
    .prepare("SELECT * FROM boards WHERE id = ?")
    .get(id) as BoardRow | null;
  return row === null ? null : mapBoardRow(row);
}

export function listBoards(db: Database): Board[] {
  const rows = db
    .prepare("SELECT * FROM boards ORDER BY created_at DESC, id DESC")
    .all() as BoardRow[];
  return rows.map(mapBoardRow);
}

interface PublishVersionInput {
  format: BoardFormat;
  content: string;
  expected_version: number;
  label?: string;
  note?: string;
  actor: string;
}

export async function publishVersion(
  db: Database,
  dataDir: string,
  boardId: string,
  input: PublishVersionInput,
): Promise<Version> {
  const board = requireOpenBoard(db, boardId);
  if (input.expected_version !== board.current_version) {
    throw new VersionConflict(
      boardId,
      input.expected_version,
      board.current_version,
    );
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new ContentTooLarge(bytes);
  }

  let content: string;
  let sourceMd: string | null;
  let anchors: ExtractedAnchor[];
  if (input.format === "markdown") {
    const rendered = await renderMarkdownDocument(input.content);
    content = rendered.html;
    sourceMd = input.content;
    anchors = rendered.anchors;
  } else {
    // D18: html boards are derived documents too — data-ba ids are injected
    // at publish (opt-in markers kept) and the injected document is the
    // stored version content. Deliberately NO DOMPurify on this path: agent
    // scripts running in the host chrome is the owner's explicit decision
    // (risk acceptance recorded in docs/decisions.md). Old versions are
    // never retro-injected — versions are immutable, so documents stored
    // before this model keep their original content.
    const rendered = renderHtmlDocument(input.content);
    content = rendered.html;
    sourceMd = null;
    anchors = rendered.anchors;
  }

  const n = board.current_version + 1;
  writeVersionBundle(dataDir, boardId, n, content, sourceMd);
  writeBoardJson(dataDir, { ...board, current_version: n });

  const payload: Record<string, unknown> = { n, format: input.format };
  if (input.label !== undefined) {
    payload.label = input.label;
  }
  if (input.note !== undefined) {
    payload.note = input.note;
  }
  return commitVersion(
    db,
    dataDir,
    boardId,
    n,
    {
      label: input.label ?? null,
      note: input.note ?? null,
      content,
      source_md: sourceMd,
      anchors,
      actor: input.actor,
      created_at: new Date().toISOString(),
    },
    {
      actor: input.actor,
      type: "board.published",
      boardId,
      payload,
    },
  );
}

// Shared publish/restore tail (the two were ~80% duplicated). Callers have
// already rendered and written the bundle files (writeVersionBundle +
// writeBoardJson) — write-order invariants live here, at the one site both
// paths share:
//
// Bundle files FIRST, db second: an orphan file after a crash is harmless (no
// row points at it), but a committed row without its file is not — the db is
// the source of truth and must never reference missing files. The (board_id,
// n) PK is the backstop against racing publishers: the second INSERT fails
// and rolls back, leaving only its orphan file.
//
// EVENTS run the opposite discipline (events.ts:41: db row first, file
// mirrors second): appendEventDb commits INSIDE this transaction and the
// jsonl mirrors are written AFTER it — on a crash the mirrors can lag the db
// but never lead it. Same pattern as comments.ts/webhooks.ts/assets.ts.
function commitVersion(
  db: Database,
  dataDir: string,
  boardId: string,
  n: number,
  fields: {
    label: string | null;
    note: string | null;
    content: string;
    source_md: string | null;
    anchors: ExtractedAnchor[];
    actor: string;
    created_at: string;
  },
  event: EventInput,
): Version {
  const write = db.transaction(() => {
    db.prepare(
      "INSERT INTO versions (board_id, n, label, note, content, source_md, anchors, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      boardId,
      n,
      fields.label,
      fields.note,
      fields.content,
      fields.source_md,
      JSON.stringify(fields.anchors),
      fields.actor,
      fields.created_at,
    );
    db.prepare("UPDATE boards SET current_version = ? WHERE id = ?").run(
      n,
      boardId,
    );
    return appendEventDb(db, event);
  });
  const appended = write();
  mirrorEventFiles(dataDir, appended);
  const version = getVersion(db, boardId, n);
  if (version === null) {
    throw new StoreError(
      `version ${n} of board "${boardId}" missing after commit`,
    );
  }
  return version;
}

function writeVersionBundle(
  dataDir: string,
  boardId: string,
  n: number,
  content: string,
  sourceMd: string | null,
): void {
  const dir = versionsDir(dataDir, boardId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${n}.html`), content);
  if (sourceMd !== null) {
    writeFileSync(join(dir, `${n}.md`), sourceMd);
  }
}

export function getVersion(
  db: Database,
  boardId: string,
  n: number,
): Version | null {
  const row = db
    .prepare("SELECT * FROM versions WHERE board_id = ? AND n = ?")
    .get(boardId, n) as VersionRow | null;
  return row === null ? null : mapVersionRow(row);
}

export function listVersions(db: Database, boardId: string): VersionMeta[] {
  // metadata only — the content column is deliberately not selected
  const rows = db
    .prepare(
      "SELECT board_id, n, label, note, anchors, created_by, created_at FROM versions WHERE board_id = ? ORDER BY n ASC",
    )
    .all(boardId) as VersionRow[];
  return rows.map(mapVersionMetaRow);
}

export function endBoard(
  db: Database,
  dataDir: string,
  boardId: string,
  actor: string,
): Board {
  const board = getBoard(db, boardId);
  if (board === null) {
    throw new BoardNotFound(boardId);
  }
  if (board.status !== "open") {
    // no second board.ended event for an already-ended board
    throw new BoardEnded(boardId);
  }
  const ended: Board = { ...board, status: "ended" };
  // UPDATE + event commit atomically (a board must never read as ended while
  // its board.ended event is missing); bundle files mirror after the commit —
  // same write-order discipline as the other store writes (events.ts:41).
  const write = db.transaction(() => {
    db.prepare("UPDATE boards SET status = ? WHERE id = ?").run(
      "ended",
      boardId,
    );
    return appendEventDb(db, {
      actor,
      type: "board.ended",
      boardId,
      payload: {},
    });
  });
  const ev = write();
  writeBoardJson(dataDir, ended);
  mirrorEventFiles(dataDir, ev);
  return ended;
}

interface RestoreVersionInput {
  from_n: number;
  expected_version: number;
  actor: string;
}

// Restore republishes an old version as a new one — history stays linear; the
// stored document is copied verbatim (no re-render). Like every write, restore
// is rejected once the board is ended (docs/plan.md: end → writes 409).
export async function restoreVersion(
  db: Database,
  dataDir: string,
  boardId: string,
  input: RestoreVersionInput,
): Promise<Version> {
  const board = requireOpenBoard(db, boardId);
  if (input.expected_version !== board.current_version) {
    throw new VersionConflict(
      boardId,
      input.expected_version,
      board.current_version,
    );
  }
  const from = getVersion(db, boardId, input.from_n);
  if (from === null) {
    throw new VersionNotFound(boardId, input.from_n);
  }

  const n = board.current_version + 1;
  writeVersionBundle(dataDir, boardId, n, from.content, from.source_md);
  writeBoardJson(dataDir, { ...board, current_version: n });

  return commitVersion(
    db,
    dataDir,
    boardId,
    n,
    {
      label: `restore of v${input.from_n}`,
      note: null,
      content: from.content,
      source_md: from.source_md,
      anchors: from.anchors,
      actor: input.actor,
      created_at: new Date().toISOString(),
    },
    {
      actor: input.actor,
      type: "board.restored",
      boardId,
      payload: { from: input.from_n, to: n },
    },
  );
}
