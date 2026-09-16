// Bundle export/import (M6, docs/plan.md REST API): GET /boards/:id/export
// zips a self-contained bundle — manifest, version SOURCES, comments, asset
// bytes, and the board's event rows as an audit snapshot. POST /boards/import
// recreates the board from a bundle under a NEW id.
//
// Import is the D18 foreign-content path (docs/security.md "Import
// quarantine"): every byte of the bundle is untrusted. Markdown re-renders
// through the full publish pipeline (DOMPurify again), html re-derives through
// renderHtmlDocument (fresh anchor injection), assets re-verify through the
// shared ingest core (verifyAssetBytes), and the bundle's derived data
// (anchors, event seqs) is never trusted. The zip is parsed in memory only —
// no bundle byte is ever used as a filesystem path (zip-slip).
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import {
  ingestAsset,
  listAssets,
  MAX_ASSET_BYTES,
  MAX_BOARD_ASSET_BYTES,
  type VerifiedAsset,
  verifyAssetBytes,
} from "./assets.ts";
import { listComments } from "./comments.ts";
import type {
  Anchor,
  Board,
  BoardEvent,
  BoardFormat,
  BoardStatus,
} from "./domain.ts";
import {
  appendEvent,
  appendEventDb,
  getBoardEventsUnbounded,
  mirrorEventFiles,
} from "./events.ts";
import { HttpError, MAX_BODY_BYTES, readCappedBody } from "./http.ts";
import { shortId } from "./ids.ts";
import { renderHtmlDocument, renderMarkdownDocument } from "./render.ts";
import {
  BoardNotFound,
  createBoard,
  endBoard,
  getBoard,
  getVersion,
  listVersions,
  publishVersion,
  StoreError,
} from "./store.ts";
import { asAnchor } from "./validate.ts";

// Bumped on any bundle-format change; import rejects everything else (422).
export const BUNDLE_SCHEMA_VERSION = 1;

// Import request cap: a bundle legitimately holds multiple ≤8MB versions plus
// the ≤8MB asset quota, so the 8 MB document cap does not transfer; 64 MB
// bounds the zip while keeping hostile-input render cost finite. The zip is
// the DoS bound — everything inside is validated before any write.
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export class ImportRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRejected";
  }
}

function reject(message: string): never {
  throw new ImportRejected(message);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

// fflate over hand-rolling zip: tiny, sync, does zip+unzip, zero config, and
// deterministic on identical input (same entries → same bytes — bundles are
// comparable in tests; the manifest's exported_at is the only per-call
// variance). Hand-rolling a zip container is format-risk not worth taking.
const ZIP_OPTIONS = { level: 6 } as const;

interface ManifestVersionEntry {
  n: number;
  file: string;
  label: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

interface ManifestAssetEntry {
  id: string;
  file: string;
  mime: string;
  size: number;
  source: string;
  created_by: string;
  created_at: string;
}

interface Manifest {
  schema_version: number;
  source_board_id: string;
  exported_at: string;
  board: {
    title: string;
    format: BoardFormat;
    status: BoardStatus;
    tags: string[];
    created_by: string;
    created_at: string;
  };
  versions: ManifestVersionEntry[];
  comments: { count: number };
  assets: ManifestAssetEntry[];
}

function versionFileName(n: number, format: BoardFormat): string {
  return `content/${n}.${format === "markdown" ? "md" : "html"}`;
}

function assetFileName(file: string): string {
  return `assets/${file}`;
}

// Build the zip for one board. Board must exist (404 at the route layer).
// Everything is buffered: board docs are ≤8MB and assets ≤8MB total, so
// in-memory assembly is fine (streaming would buy nothing at these sizes).
export function buildBundle(
  db: Database,
  dataDir: string,
  boardId: string,
): Uint8Array {
  const board = getBoard(db, boardId);
  if (board === null) {
    throw new BoardNotFound(boardId);
  }

  const entries: Record<string, Uint8Array> = {};
  const versionIndex: ManifestVersionEntry[] = [];
  for (const meta of listVersions(db, boardId)) {
    const full = getVersion(db, boardId, meta.n);
    if (full === null) {
      throw new StoreError(
        `version ${meta.n} of board "${boardId}" is indexed but missing`,
      );
    }
    // SOURCE content only (docs/plan.md "bundle export"). Format is per
    // publish: a markdown version keeps source_md (the derived HTML is
    // re-computed on import — re-sanitized, fresh anchors); an html version
    // carries the stored id-injected document, which IS its source per D18
    // (import re-derives anchors from it, keepExisting keeps the ids).
    const isMarkdown = full.source_md !== null;
    const source = isMarkdown ? full.source_md : full.content;
    if (source === null) {
      throw new StoreError(
        `version ${meta.n} of board "${boardId}" has no source to export`,
      );
    }
    const file = versionFileName(meta.n, isMarkdown ? "markdown" : "html");
    entries[file] = new TextEncoder().encode(source);
    versionIndex.push({
      n: meta.n,
      file,
      label: meta.label,
      note: meta.note,
      created_by: meta.created_by,
      created_at: meta.created_at,
    });
  }

  const assetIndex: ManifestAssetEntry[] = [];
  for (const asset of listAssets(db, boardId)) {
    const path = join(dataDir, "boards", boardId, "assets", asset.file);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new StoreError(
        `asset "${asset.id}" of board "${boardId}" is missing its bundle file`,
      );
    }
    entries[assetFileName(asset.file)] = bytes;
    assetIndex.push({
      id: asset.id,
      file: assetFileName(asset.file),
      mime: asset.mime,
      size: asset.size,
      source: asset.source,
      created_by: asset.created_by,
      created_at: asset.created_at,
    });
  }

  // Comments replay as data: strip board_id and seq (db-isms of the source
  // board — the new board mints fresh ids and fresh event seqs).
  const comments = listComments(db, boardId).map((c) => ({
    id: c.id,
    version_n: c.version_n,
    anchor: c.anchor,
    body: c.body,
    author: c.author,
    in_reply_to: c.in_reply_to,
    created_at: c.created_at,
    edited_at: c.edited_at,
    resolved_at: c.resolved_at,
    resolved_by: c.resolved_by,
  }));

  // Audit snapshot: this board's event rows verbatim. Import never replays
  // them into the live log (invariant 4 keeps the global seq append-only and
  // monotonic) — the snapshot exists so the bundle preserves its own history.
  const events = getBoardEventsUnbounded(db, boardId);

  const manifest: Manifest = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    source_board_id: board.id,
    exported_at: new Date().toISOString(),
    board: {
      title: board.title,
      format: board.format,
      status: board.status,
      tags: board.tags,
      created_by: board.created_by,
      created_at: board.created_at,
    },
    versions: versionIndex,
    comments: { count: comments.length },
    assets: assetIndex,
  };

  return zipSync(
    {
      "manifest.json": new TextEncoder().encode(
        JSON.stringify(manifest, null, 2),
      ),
      "comments.json": new TextEncoder().encode(
        JSON.stringify({ comments }, null, 2),
      ),
      "events.jsonl": new TextEncoder().encode(
        events.map((ev) => JSON.stringify(ev)).join("\n"),
      ),
      ...entries,
    },
    ZIP_OPTIONS,
  );
}

// ---------------------------------------------------------------------------
// Import — quarantine (docs/security.md "Import quarantine")
// ---------------------------------------------------------------------------

// Zip-slip + layout defense: every entry name must match the expected layout
// exactly. This one table rejects absolute paths, `..`, backslashes, NULs,
// directory entries, and any unexpected file — nothing else gets read.
const ENTRY_PATTERNS: ReadonlyArray<RegExp> = [
  /^manifest\.json$/,
  /^comments\.json$/,
  /^events\.jsonl$/,
  /^content\/(\d+)\.(md|html)$/,
  /^assets\/([0-9A-Za-z]{10})\.([a-z0-9]+)$/,
];

interface BundleVersion {
  n: number;
  format: BoardFormat;
  label: string | null;
  note: string | null;
  source: string;
}

interface BundleAsset {
  oldId: string;
  mime: string;
  bytes: Uint8Array;
}

interface BundleComment {
  id: string;
  version_n: number;
  anchor: Anchor;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface ParsedBundle {
  manifest: Manifest;
  versions: BundleVersion[];
  assets: BundleAsset[];
  comments: BundleComment[];
}

function readString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    reject(`${what} must be a string`);
  }
  return value;
}

function readStringOrNull(value: unknown, what: string): string | null {
  if (value === null) {
    return null;
  }
  return readString(value, what);
}

function readInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    reject(`${what} must be an integer`);
  }
  return value;
}

function readArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    reject(`${what} must be an array`);
  }
  return value;
}

function readObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Strict manifest parse: unknown top-level keys are rejected — the schema
// version gate is what future formats use, so v1 stays exact.
function parseManifest(value: unknown): Manifest {
  const root = readObject(value, "manifest.json");
  for (const key of Object.keys(root)) {
    if (
      ![
        "schema_version",
        "source_board_id",
        "exported_at",
        "board",
        "versions",
        "comments",
        "assets",
      ].includes(key)
    ) {
      reject(`manifest.json: unknown field "${key}"`);
    }
  }
  const schemaVersion = readInt(
    root.schema_version,
    "manifest.json: schema_version",
  );
  if (schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    reject(
      `manifest.json: unknown bundle schema version ${schemaVersion} (expected ${BUNDLE_SCHEMA_VERSION})`,
    );
  }
  const board = readObject(root.board, "manifest.json: board");
  const format = readString(board.format, "manifest.json: board.format");
  if (format !== "markdown" && format !== "html") {
    reject('manifest.json: board.format must be "markdown" or "html"');
  }
  const status = readString(board.status, "manifest.json: board.status");
  if (status !== "open" && status !== "ended") {
    reject('manifest.json: board.status must be "open" or "ended"');
  }
  const tags = readArray(board.tags, "manifest.json: board.tags");
  for (const tag of tags) {
    readString(tag, "manifest.json: board.tags entry");
  }

  const versions: ManifestVersionEntry[] = readArray(
    root.versions,
    "manifest.json: versions",
  ).map((raw, i) => {
    const v = readObject(raw, `manifest.json: versions[${i}]`);
    const n = readInt(v.n, `manifest.json: versions[${i}].n`);
    return {
      n,
      file: readString(v.file, `manifest.json: versions[${i}].file`),
      label: readStringOrNull(v.label, `manifest.json: versions[${i}].label`),
      note: readStringOrNull(v.note, `manifest.json: versions[${i}].note`),
      created_by: readString(
        v.created_by,
        `manifest.json: versions[${i}].created_by`,
      ),
      created_at: readString(
        v.created_at,
        `manifest.json: versions[${i}].created_at`,
      ),
    };
  });

  const commentsObj = readObject(root.comments, "manifest.json: comments");
  const assets: ManifestAssetEntry[] = readArray(
    root.assets,
    "manifest.json: assets",
  ).map((raw, i) => {
    const a = readObject(raw, `manifest.json: assets[${i}]`);
    const size = readInt(a.size, `manifest.json: assets[${i}].size`);
    if (size < 0) {
      reject(`manifest.json: assets[${i}].size must be non-negative`);
    }
    return {
      id: readString(a.id, `manifest.json: assets[${i}].id`),
      file: readString(a.file, `manifest.json: assets[${i}].file`),
      mime: readString(a.mime, `manifest.json: assets[${i}].mime`),
      size,
      source: readString(a.source, `manifest.json: assets[${i}].source`),
      created_by: readString(
        a.created_by,
        `manifest.json: assets[${i}].created_by`,
      ),
      created_at: readString(
        a.created_at,
        `manifest.json: assets[${i}].created_at`,
      ),
    };
  });

  return {
    schema_version: schemaVersion,
    source_board_id: readString(
      root.source_board_id,
      "manifest.json: source_board_id",
    ),
    exported_at: readString(root.exported_at, "manifest.json: exported_at"),
    board: {
      title: readString(board.title, "manifest.json: board.title"),
      format,
      status,
      tags: tags as string[],
      created_by: readString(
        board.created_by,
        "manifest.json: board.created_by",
      ),
      created_at: readString(
        board.created_at,
        "manifest.json: board.created_at",
      ),
    },
    versions,
    comments: {
      count: readInt(commentsObj.count, "manifest.json: comments.count"),
    },
    assets,
  };
}

function parseCommentAnchor(value: unknown, what: string): Anchor {
  // asAnchor throws HttpError(400); import rejections are 422 — translate.
  try {
    return asAnchor(value, what);
  } catch (err) {
    if (err instanceof HttpError) {
      reject(err.message);
    }
    throw err;
  }
}

const ASSET_REF_PATTERNS = [
  /asset:([0-9A-Za-z]{10})/g,
  /src="\/assets\/([0-9A-Za-z]{10})"/g,
];

// The remap regex is those two validation patterns joined as one alternation
// — derived, not re-typed, so the two encodings cannot drift: group 1 is the
// `asset:` embed id, group 2 the html src id.
const ASSET_REF_REMAP_PATTERN = new RegExp(
  ASSET_REF_PATTERNS.map((pattern) => pattern.source).join("|"),
  "g",
);

// Asset ids are remapped BEFORE the version re-renders (markdown `asset:`
// embeds and html src="/assets/<id>" references). Anything referencing an id
// the bundle does not carry is rejected in validation: imports are
// self-contained by construction, and a dangling id could otherwise silently
// resolve to a DIFFERENT board's asset (the asset index is global).
function remapAssetRefs(source: string, map: Map<string, string>): string {
  return source.replace(
    ASSET_REF_REMAP_PATTERN,
    (whole, mdId: string | undefined, htmlId: string | undefined) => {
      const oldId = mdId ?? htmlId;
      if (oldId === undefined) {
        // unreachable by the regex, but never invent an id if that drifts
        return whole;
      }
      const newId = map.get(oldId);
      if (newId === undefined) {
        // validation rejects unknown refs; keep the text if that ever drifts
        return whole;
      }
      return mdId !== undefined ? `asset:${newId}` : `src="/assets/${newId}"`;
    },
  );
}

// Validate EVERYTHING before a single byte is written (import is atomic in
// the quarantine sense: any rejection leaves the data dir untouched).
// Rendering here is the quarantine re-examination itself — markdown is
// re-rendered through the full publish pipeline and html re-derived, so a
// hostile derived document in the bundle never reaches storage.
async function parseBundle(zipBytes: Uint8Array): Promise<ParsedBundle> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    reject("request body is not a valid zip bundle");
  }
  for (const name of Object.keys(entries)) {
    if (!ENTRY_PATTERNS.some((pattern) => pattern.test(name))) {
      reject(`unexpected bundle entry "${name}"`);
    }
  }
  const manifestRaw = entries["manifest.json"];
  const commentsRaw = entries["comments.json"];
  const eventsRaw = entries["events.jsonl"];
  if (
    manifestRaw === undefined ||
    commentsRaw === undefined ||
    eventsRaw === undefined
  ) {
    reject("bundle is missing manifest.json, comments.json, or events.jsonl");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(manifestRaw));
  } catch {
    reject("manifest.json is not valid JSON");
  }
  const manifest = parseManifest(manifestValue);

  // versions: ns must be exactly 1..N (contiguous — publishVersion assigns
  // n = current_version + 1, so gaps cannot be expressed by the store)
  const ns = manifest.versions.map((v) => v.n);
  ns.sort((a, b) => a - b);
  for (let i = 0; i < ns.length; i++) {
    if (ns[i] !== i + 1) {
      reject(
        `manifest.json: version numbers must be 1..${ns.length}, found gap or duplicate at ${ns[i]}`,
      );
    }
  }

  const versions: BundleVersion[] = [];
  for (const v of manifest.versions) {
    // per-version format from the file extension (format is per publish)
    const fileMatch = new RegExp(`^content/${v.n}\\.(md|html)$`).exec(v.file);
    if (fileMatch === null) {
      reject(
        `manifest.json: versions[${v.n}].file must be "content/${v.n}.md" or "content/${v.n}.html"`,
      );
    }
    const format: BoardFormat = v.file.endsWith(".md") ? "markdown" : "html";
    const bytes = entries[v.file];
    if (bytes === undefined) {
      reject(`bundle is missing version content "${v.file}"`);
    }
    if (bytes.byteLength > MAX_BODY_BYTES) {
      reject(
        `version ${v.n} content is ${bytes.byteLength} bytes, exceeding the ${MAX_BODY_BYTES} byte cap`,
      );
    }
    const source = new TextDecoder().decode(bytes);
    try {
      // the quarantine re-render: markdown goes through DOMPurify again, html
      // through renderHtmlDocument — failures name the version (the derived
      // documents in the bundle are NOT trusted, docs/security.md)
      if (format === "markdown") {
        await renderMarkdownDocument(source);
      } else {
        renderHtmlDocument(source);
      }
    } catch (err) {
      reject(
        `version ${v.n} failed to render: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    versions.push({ n: v.n, format, label: v.label, note: v.note, source });
  }

  // assets: re-verify through the shared ingest core (magic bytes, mime
  // allowlist, svg re-sanitization)
  const totalAssets = manifest.assets.reduce((sum, a) => sum + a.size, 0);
  if (totalAssets > MAX_BOARD_ASSET_BYTES) {
    reject(
      `bundle assets total ${totalAssets} bytes, exceeding the ${MAX_BOARD_ASSET_BYTES} byte per-board cap`,
    );
  }
  const assets: BundleAsset[] = [];
  for (const a of manifest.assets) {
    if (!/^[0-9A-Za-z]{10}$/.test(a.id)) {
      reject(`manifest.json: asset id "${a.id}" has an unexpected shape`);
    }
    if (!new RegExp(`^assets/${a.id}\\.[a-z0-9]+$`).test(a.file)) {
      reject(
        `manifest.json: assets[${a.id}].file must be "assets/${a.id}.<ext>"`,
      );
    }
    const bytes = entries[a.file];
    if (bytes === undefined) {
      reject(`bundle is missing asset file "${a.file}"`);
    }
    if (bytes.byteLength !== a.size) {
      reject(
        `asset "${a.id}" is ${bytes.byteLength} bytes but the manifest says ${a.size}`,
      );
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      reject(
        `asset "${a.id}" is ${bytes.byteLength} bytes, exceeding the ${MAX_ASSET_BYTES} byte per-asset cap`,
      );
    }
    let verified: VerifiedAsset;
    try {
      verified = verifyAssetBytes(bytes, a.mime);
    } catch (err) {
      reject(
        `asset "${a.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Tamper gate for svg: ingest stores SANITIZED bytes, so our own exports
    // re-sanitize to a no-op. Bytes that change under re-sanitization mean
    // the bundle was modified after export (e.g. a script injected into an
    // svg) — reject rather than laundering the payload. Benign svgs pass
    // through the same pipeline unchanged.
    if (a.mime === "image/svg+xml" && !bytesEqual(verified.bytes, bytes)) {
      reject(
        `asset "${a.id}": svg bytes are not the sanitized form — the bundle was modified after export`,
      );
    }
    assets.push({ oldId: a.id, mime: a.mime, bytes });
  }
  const assetIds = new Set(assets.map((a) => a.oldId));

  // every asset reference in every version must resolve inside the bundle
  for (const v of versions) {
    for (const pattern of ASSET_REF_PATTERNS) {
      for (const match of v.source.matchAll(pattern)) {
        if (!assetIds.has(match[1])) {
          reject(
            `version ${v.n} references asset "${match[1]}" which the bundle does not contain`,
          );
        }
      }
    }
  }

  const comments = parseCommentsFile(commentsRaw, ns.length);
  if (comments.length !== manifest.comments.count) {
    reject(
      `manifest.json: comments.count is ${manifest.comments.count} but comments.json has ${comments.length}`,
    );
  }
  // image anchors reference the bundle's own assets
  for (const c of comments) {
    if (c.anchor.type === "image" && !assetIds.has(c.anchor.asset_id)) {
      reject(
        `comment "${c.id}" anchors asset "${c.anchor.asset_id}" which the bundle does not contain`,
      );
    }
  }
  // no unreferenced payload: every content/ and assets/ entry must be named
  // by the manifest — a smuggled-but-ignored file must not ride along
  const referenced = new Set([
    ...manifest.versions.map((v) => v.file),
    ...manifest.assets.map((a) => a.file),
  ]);
  for (const name of Object.keys(entries)) {
    if (
      (name.startsWith("content/") || name.startsWith("assets/")) &&
      !referenced.has(name)
    ) {
      reject(`bundle entry "${name}" is not in the manifest`);
    }
  }

  return { manifest, versions, assets, comments };
}

function parseCommentsFile(
  raw: Uint8Array,
  versionCount: number,
): BundleComment[] {
  // JSON.parse of comments.json is separate from the manifest's: each file
  // gets its own rejection message.
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    reject("comments.json is not valid JSON");
  }
  const list = readArray(
    readObject(value, "comments.json").comments,
    "comments.json: comments",
  );
  const seen = new Set<string>();
  const out: BundleComment[] = [];
  for (let i = 0; i < list.length; i++) {
    const what = `comments.json: comments[${i}]`;
    const c = readObject(list[i], what);
    const id = readString(c.id, `${what}.id`);
    if (seen.has(id)) {
      reject(`${what}: duplicate comment id "${id}"`);
    }
    seen.add(id);
    const versionN = readInt(c.version_n, `${what}.version_n`);
    if (versionN < 1 || versionN > versionCount) {
      reject(`${what}.version_n ${versionN} is not a version of this bundle`);
    }
    if (c.in_reply_to !== null && c.in_reply_to !== undefined) {
      // parents-first order: export writes comments in creation order, and a
      // reply always cites an already-seen parent
      const parent = readString(c.in_reply_to, `${what}.in_reply_to`);
      if (!seen.has(parent)) {
        reject(`${what}: in_reply_to "${parent}" is not an earlier comment`);
      }
    }
    out.push({
      id,
      version_n: versionN,
      anchor: parseCommentAnchor(c.anchor, `${what}.anchor`),
      body: readString(c.body, `${what}.body`),
      author: readString(c.author, `${what}.author`),
      in_reply_to:
        c.in_reply_to === null || c.in_reply_to === undefined
          ? null
          : (c.in_reply_to as string),
      created_at: readString(c.created_at, `${what}.created_at`),
      edited_at: readStringOrNull(c.edited_at, `${what}.edited_at`),
      resolved_at: readStringOrNull(c.resolved_at, `${what}.resolved_at`),
      resolved_by: readStringOrNull(c.resolved_by, `${what}.resolved_by`),
    });
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const INSERT_IMPORTED_COMMENT =
  "INSERT INTO comments (id, board_id, version_n, anchor, body, author, in_reply_to, created_at, edited_at, resolved_at, resolved_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

// Always mints a NEW board id: restore = import to a new id. Ids are cheap;
// collision logic / in-place restore is a state machine we don't need.
// Validation already passed, so the write phase reuses the audited service
// functions (createBoard / ingestAsset / publishVersion) exactly as a live
// publish would — deliberately NOT one mega-transaction, because those
// functions mirror their events to the jsonl files after their own commits,
// and an outer transaction rolling back would leave the mirrors ahead of the
// db (events.ts invariant). A crash mid-write leaves the same harmless orphan
// files a crashed publish would.
export async function importBoard(
  db: Database,
  dataDir: string,
  zipBytes: Uint8Array,
  actor: string,
): Promise<Board> {
  const bundle = await parseBundle(zipBytes);

  const board = createBoard(db, dataDir, {
    title: bundle.manifest.board.title,
    format: bundle.manifest.board.format,
    tags: bundle.manifest.board.tags,
    actor,
  });
  appendEvent(db, dataDir, {
    actor,
    type: "board.imported",
    boardId: board.id,
    payload: {
      source_board_id: bundle.manifest.source_board_id,
      versions: bundle.versions.length,
      assets: bundle.assets.length,
      comments: bundle.comments.length,
    },
  });

  // assets first, so version sources can be remapped to the NEW ids
  const assetIdMap = new Map<string, string>();
  for (const asset of bundle.assets) {
    const ingested = ingestAsset(db, dataDir, board.id, {
      bytes: asset.bytes,
      mime: asset.mime,
      // imported bytes are copied from the bundle (file-copy semantics);
      // original provenance stays in the manifest's asset index
      source: "copy",
      actor,
    });
    assetIdMap.set(asset.oldId, ingested.id);
  }

  // versions re-publish through the real pipeline: markdown re-renders
  // (DOMPurify, fresh anchors), html re-derives (renderHtmlDocument,
  // keepExisting — the bundle's data-ba ids are kept, so comment anchors
  // hold). Label/note survive; created_by/created_at are the import's
  // (honest provenance — the originals live in the bundle's audit snapshot).
  for (const v of bundle.versions) {
    await publishVersion(db, dataDir, board.id, {
      format: v.format,
      content: remapAssetRefs(v.source, assetIdMap),
      expected_version: v.n - 1,
      label: v.label ?? undefined,
      note: v.note ?? undefined,
      actor,
    });
  }

  // comments replay as data with fresh ids (original ids→new ids), original
  // authors/anchors/threading/resolve state/timestamps; each becomes a fresh
  // event on the new board's log (seqs are new — the global seq is never
  // reused). One transaction so threading inserts atomically; mirrors fire
  // after commit in seq order.
  const idMap = new Map<string, string>();
  const toMirror: BoardEvent[] = [];
  const write = db.transaction(() => {
    for (const c of bundle.comments) {
      const newId = shortId();
      const parentId =
        c.in_reply_to === null ? null : (idMap.get(c.in_reply_to) ?? null);
      const isReply = parentId !== null;
      const ev = appendEventDb(db, {
        // the ORIGINAL author is the event actor — the comment is replayed
        // with their authorship; the import itself is attributed to `actor`
        // via board.created/board.imported above
        actor: c.author,
        type: isReply ? "comment.replied" : "comment.created",
        boardId: board.id,
        payload: isReply
          ? { comment_id: newId, parent_id: parentId }
          : { comment_id: newId, version_n: c.version_n, anchor: c.anchor },
      });
      db.prepare(INSERT_IMPORTED_COMMENT).run(
        newId,
        board.id,
        c.version_n,
        JSON.stringify(c.anchor),
        c.body,
        c.author,
        parentId,
        c.created_at,
        c.edited_at,
        c.resolved_at,
        c.resolved_by,
        ev.seq,
      );
      toMirror.push(ev);
      if (c.resolved_at !== null) {
        const resEv = appendEventDb(db, {
          actor: c.resolved_by ?? c.author,
          type: "comment.resolved",
          boardId: board.id,
          payload: { comment_id: newId },
        });
        toMirror.push(resEv);
      }
      idMap.set(c.id, newId);
    }
  });
  write();
  for (const ev of toMirror) {
    mirrorEventFiles(dataDir, ev);
  }

  // Restore as the EXPORTED status: the save/load-old-boards story wants
  // fidelity — an ended board comes back ended (and read-only).
  if (bundle.manifest.board.status === "ended") {
    endBoard(db, dataDir, board.id, actor);
  }
  const imported = getBoard(db, board.id);
  if (imported === null) {
    throw new StoreError(`imported board "${board.id}" missing after import`);
  }
  return imported;
}

// Raw-body reader for the import route: the shared capped read core with the
// import error type — over-cap bundles are 422 import_rejected, nothing
// buffered past the cap (docs/security.md "Import quarantine" request cap).
export async function readImportBody(req: Request): Promise<Uint8Array> {
  return readCappedBody(req, MAX_IMPORT_BYTES, () => {
    throw new ImportRejected(`request body exceeds ${MAX_IMPORT_BYTES} bytes`);
  });
}
