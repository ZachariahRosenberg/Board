import type { Database, SQLQueryBindings } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BoardEvent, EventType } from "./domain.ts";

export interface EventInput {
  actor: string;
  type: EventType;
  boardId?: string;
  payload?: Record<string, unknown>;
}

interface EventRow {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  board_id: string | null;
  payload: string;
}

export const DEFAULT_EVENT_LIMIT = 200;

export function appendEvent(
  db: Database,
  dataDir: string,
  ev: EventInput,
): BoardEvent {
  const row = db
    .prepare(
      "INSERT INTO events (ts, actor, type, board_id, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq, ts, actor, type, board_id, payload",
    )
    .get(
      new Date().toISOString(),
      ev.actor,
      ev.type,
      ev.boardId ?? null,
      JSON.stringify(ev.payload ?? {}),
    ) as EventRow;
  const event = mapEventRow(row);
  const line = `${JSON.stringify(event)}\n`;
  // db row first, file mirrors second: on a crash the jsonl files can lag the db
  // (a missing tail line) but never lead it (a line whose seq never committed).
  appendFileSync(join(dataDir, "events.jsonl"), line);
  if (event.board_id !== null) {
    const boardDir = join(dataDir, "boards", event.board_id);
    mkdirSync(boardDir, { recursive: true });
    appendFileSync(join(boardDir, "events.jsonl"), line);
  }
  return event;
}

export interface GetEventsOptions {
  since?: number;
  boardId?: string;
  limit?: number;
}

export function getEvents(
  db: Database,
  opts: GetEventsOptions = {},
): BoardEvent[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (opts.since !== undefined) {
    where.push("seq > ?");
    params.push(opts.since);
  }
  if (opts.boardId !== undefined) {
    where.push("board_id = ?");
    params.push(opts.boardId);
  }
  params.push(opts.limit ?? DEFAULT_EVENT_LIMIT);
  const sql = `
    SELECT seq, ts, actor, type, board_id, payload FROM events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY seq ASC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map(mapEventRow);
}

export function getBoardEvents(
  db: Database,
  boardId: string,
  since?: number,
): BoardEvent[] {
  return getEvents(db, { boardId, since });
}

function mapEventRow(row: EventRow): BoardEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    type: row.type as EventType,
    board_id: row.board_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}
