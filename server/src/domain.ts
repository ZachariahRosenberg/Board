// Domain types per docs/plan.md "Data model" — defined once, imported everywhere (style guide).

export type BoardFormat = "markdown" | "html";
export type BoardStatus = "open" | "ended";

export interface Board {
  id: string;
  title: string;
  format: BoardFormat;
  status: BoardStatus;
  tags: string[];
  created_by: string;
  created_at: string;
  current_version: number;
}

export interface VersionMeta {
  board_id: string;
  n: number;
  label: string | null;
  note: string | null;
  anchors: ExtractedAnchor[];
  created_by: string;
  created_at: string;
}

export interface Version extends VersionMeta {
  content: string;
  source_md: string | null;
}

// Anchors extracted from a published document (data-ba ids); comment anchors reference these.
export interface ExtractedAnchor {
  id: string;
  kind: "block" | "heading" | "row";
  label?: string;
}

// Comment anchor variants per docs/plan.md (plannotator's block+offset+quote model).
export type Anchor =
  | BoardAnchor
  | SectionAnchor
  | TextAnchor
  | RowAnchor
  | ImageAnchor;

export interface BoardAnchor {
  type: "board";
}

export interface SectionAnchor {
  type: "section";
  section_id: string;
}

export interface TextAnchor {
  type: "text";
  section_id: string;
  originalText: string;
  startOffset: number;
  endOffset: number;
}

export interface RowAnchor {
  type: "row";
  section_id: string;
  row_id: string;
}

export interface ImageAnchor {
  type: "image";
  asset_id: string;
  overlay?: ImageOverlay;
}

export interface ImageOverlay {
  arrows: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  boxes: Array<{ x: number; y: number; text: string }>;
}

export interface Comment {
  id: string;
  board_id: string;
  version_n: number;
  seq: number;
  anchor: Anchor;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export type EventType =
  | "board.created"
  | "board.published"
  | "board.ended"
  | "board.restored"
  | "comment.created"
  | "comment.replied"
  | "comment.resolved"
  | "asset.added"
  | "agent.subscribed"
  | "webhook.failed";

export interface BoardEvent {
  seq: number;
  ts: string;
  actor: string;
  type: EventType;
  board_id: string | null;
  payload: Record<string, unknown>;
}

export type SubscriberKind = "sse" | "cursor" | "webhook";

export interface Subscriber {
  id: string | null;
  board_id: string;
  principal: string;
  kind: SubscriberKind;
  webhook_url: string | null;
  last_seq: number;
  last_seen: string;
}

export interface TokenInfo {
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface Actor {
  kind: "human" | "agent";
  name: string;
}
