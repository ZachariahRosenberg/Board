# Shared Board — v1 Implementation Plan

A local-first, always-on shared board system: a Bun daemon hosting rich boards (markdown + interactive HTML) that agents publish via MCP/REST, you annotate with anchored comments, and everyone consumes via an append-only event log. Working name: **board** (repo is `/home/zr/geek/board`; rename anytime).

> **Approved 2026-09-15.** This document is the source of truth for v1 scope. The decision log is [decisions.md](decisions.md); the survey behind it is [research.md](research.md). Milestones get status markers appended as they complete.

## Locked decisions

| Decision | Choice |
|---|---|
| Stack | TypeScript + Bun; single daemon process, two origins |
| Agent feedback model | **Async only** — no blocking waits; agents poll cursors / tail events / SSE |
| Anchoring | **Phased**: v1 = sections + text highlights on markdown boards, `data-ba` section markers + board-level on HTML boards; full in-HTML bridge overlay deferred to v1.1 |
| Preloaded libs (pinned, vendored, no CDNs) | mermaid, tailwind (play-cdn script), plotly, katex |
| Base | Build from scratch; steal patterns from plannotator (feedback grammar, anchor model), easel (daemon, rounds, per-agent cursors), open-artifacts (immutable versions + `expected_version` 409), Claude Artifacts (thread lifecycle, CSP allowlist approach) |

## Architecture

```
~/.board/                          (BOARD_DATA_DIR, overridable)
  board.db                         SQLite (WAL) — boards, versions, comments, events, tokens, subscribers
  events.jsonl                     append-only GLOBAL event log (audit + integration substrate)
  boards/<id>/                     self-contained, zip-portable board bundle
    board.json                     metadata snapshot
    versions/NNN.html              immutable documents (+ NNN.md source when markdown input)
    assets/<id>.<ext>              images bundled with their board
    events.jsonl                   per-board event channel (mirrors this board's rows in board.db)

one process: boardd (Bun.serve x2)
  127.0.0.1:7800  host app (React+Vite SPA) | /api/* REST | /mcp (Streamable HTTP) | /api/stream SSE
  127.0.0.1:7801  board origin: /b/<id>/<version> documents | /libs/* vendored libs | /assets/<id>/*
```

- **Two origins** so sandboxed board content is origin-isolated from the host chrome (MDN guidance; Claude Artifacts pattern). Ports configurable (`BOARD_PORT`, `BOARD_ORIGIN_PORT`); default bind `127.0.0.1`, with a configurable bind list for Docker-hosted agents (see Deployment docs).
- **SQLite is the queryable source of truth; every board is also a self-contained bundle on disk** — `boards/<id>/` holds its versions, assets, metadata, and its own `events.jsonl`, so a board zips/moves/greps as one unit (export/import are built on this). The global `events.jsonl` remains the machine-wide audit log + tail/file-watch substrate (Claude `FileChanged`, opencode plugin events) requiring no client library.
- **Lifecycle via Makefile** — the primary operational interface: `make serve` (foreground daemon; tmux/systemd unit documented), `make open`, `make list`, `make token`, `make install`, `make test`, `make dev`. No auto-spawn magic.

## Data model (SQLite)

- **boards**: `id` (short nanoid), `title`, `format` (`markdown`|`html` — input convenience only; **every version is stored and served as an HTML document**), `status` (`open`|`ended`), `tags`, `created_by`, `created_at`, `current_version`
- **versions**: `board_id`, `n`, `label?`, `note?`, `content` (HTML document) + `source_md?` (original markdown when `format: markdown`), `anchors` (extracted at publish), `created_by`, `created_at` — **immutable**; publish with `expected_version` → **409** on conflict
- **comments**: `id`, `board_id`, `version_n`, `anchor`, `body`, `author` (human | agent name), `in_reply_to?`, `created_at`, `edited_at?`, `resolved_at?`, `resolved_by?`
  - `anchor` variants: `{type:"board"}` | `{type:"section", section_id}` | `{type:"text", section_id, originalText, startOffset, endOffset}` (plannotator's block+offset+quote model; re-anchor by `originalText` match) | `{type:"row", section_id, row_id}` | `{type:"image", asset_id, overlay?}`
- **events**: global monotonic `seq`, `ts`, `actor`, `type` (`board.created`, `board.published`, `board.ended`, `board.restored`, `comment.created`, `comment.replied`, `comment.resolved`, `asset.added`, `agent.subscribed`, `webhook.failed`…), `board_id?`, `payload` — queryable globally or per board (db + per-board jsonl mirror)
- **subscribers**: `board_id`, `agent`, `kind` (`sse` | `cursor` | `webhook`), `webhook_url?`, `secret?` (HMAC key), `last_seq`, `last_seen` — presence tracking + webhook registry
- **tokens**: agent name, SHA-256 hash, scopes, `created_at` — per-agent bearer tokens

## Boards: one document model, two display modes

**Unified document model** (answering your question): there is only one stored artifact — every version is an **HTML document**, stored and served from `:7801` as one immutable file inside the board bundle. `format` is an input convenience only:

- `format: markdown` — the daemon renders it at publish (`marked` GFM → **DOMPurify** → mermaid `securityLevel:'strict'` → katex → code highlighting) and **auto-injects `data-ba` ids onto every top-level block, heading, and table row** — sections and rows become annotatable with zero agent effort. Both markdown source and derived HTML are kept.
- `format: html` — the author's document, served verbatim; annotatable sections via opt-in `data-ba="section-id"` markers (optional `data-ba-label`), extracted at publish into the version's `anchors`.

**What pure HTML-only (everything in the iframe) would cost in v1**: arbitrary text-highlight comments (requirement 3.a would slip to v1.1 with the bridge) and the tight trusted-chrome selection UX. So we keep a **display-mode hybrid**: markdown-derived boards are script-free by construction (DOMPurify strips scripts), so the UI renders them in the **host chrome** — preserving v1 text-highlight + section + row anchoring right next to the comment sidebar. Hand-authored HTML boards render in the sandboxed iframe (`<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">`) with `data-ba` section anchoring until the v1.1 bridge. Everything else *is* unified: one storage/serving path, one anchor model, and `format: html` boards freely mix prose + custom widgets.

**Image annotation** — images are **file-copy ingested** (on localhost, "upload" is really a local copy): human drag/drop in the UI, or agent `POST /assets` with a binary body **or** `{"path": "/abs/file.png"}` for the daemon to copy locally. Path ingest is safe by construction: magic-byte image verification + mime allowlist + size cap mean it cannot be repurposed to read arbitrary host files. Assets live inside the board bundle (`boards/<id>/assets/`), served from `:7801/assets/<id>`. Annotation overlay = JSON `{arrows:[{x1,y1,x2,y2}], boxes:[{x,y,text}]}` rendered as an SVG overlay; an overlay set is a comment anchored to `{type:"image", asset_id, overlay}` (timestamped, author-tagged, threaded). Schema documented so agents can annotate screenshots programmatically. Hand-rolled minimal editor (drag arrow, drag textbox) — no excalidraw dependency. **Docker-hosted agents** can't reach host loopback by default — documented options: run with `--network=host`, or `extra_hosts: ["host.docker.internal:host-gateway"]` with the daemon's configurable bind list, or volume-mount `~/.board` and tail `boards/<id>/events.jsonl` from inside the container.

## REST API (`:7800/api`, bearer auth)

- `POST /boards` · `GET /boards` (filters: status/tag/author; flags unresolved-comment counts + live subscriber count) · `GET /boards/:id` · `GET /boards/:id/versions/:n`
- `POST /boards/:id/publish` (new version; `expected_version` → 409) · `POST /boards/:id/end` (writes → 409, reads stay) · `POST /boards/:id/restore` (publishes copy of an old version as a new one, noted)
- `GET /boards/:id/comments?since=<seq>` — **per-agent cursors** (`workspace:agent` scoped; resume returns exactly the unacked backlog)
- `POST /boards/:id/comments` · `POST /comments/:id/reply` · `POST /comments/:id/resolve`
- `GET /boards/:id/feedback?since=` — **feedback markdown grammar** (plannotator-style): numbered items with anchor type, section/row refs, quoted `originalText`, `> comment`, nested replies, resolve state, label summary — one artifact, human-readable *and* agent-parseable
- **Subscriptions, callbacks & presence**: `POST /boards/:id/subscribe` (`{webhook_url?, webhook_secret?}`; SSE/cursor subscribers are detected automatically from their tokens) · `GET /boards/:id/subscribers` (who is listening, how, `last_seq`/`last_seen`) · `DELETE /boards/:id/subscribe`. Webhook deliveries are HMAC-signed POSTs (3 retries, backoff); failures become `webhook.failed` events (dead-letter, visible in the audit view)
- `GET /events?since=` · `GET /boards/:id/events?since=` (per-board channel — also readable directly as `boards/<id>/events.jsonl`) · `GET /stream` (SSE, 25s heartbeats, reconnect via last seq)
- `POST /assets` (binary body or `{path}` file-copy; caps: board 8 MB, asset 10 MB; SVG sanitized at ingest)
- `GET /boards/:id/export` (zip of the self-contained bundle) · `POST /boards/import` (recreate a board from a bundle — the save/load-old-boards story)

## MCP server (Streamable HTTP, `:7800/mcp`, rev 2026-07-28, `@modelcontextprotocol/sdk`)

Tools: `board_create`, `board_publish`, `board_list`, `board_get`, `board_get_comments(since)`, `board_get_feedback`, `board_reply`, `board_resolve`, `board_end`, `board_upload_image`, `board_subscribe` (presence + optional webhook registration), `board_export`, `board_status`. No wait/blocking tool (async-only). Optional: `board://<id>` resources (list/read) if time allows.

Async consumption loop (documented in skill): publish → `board_get_comments?since=cursor` on each iteration / on task boundaries; or tail `~/.board/events.jsonl`.

## Security implementation checklist

- Board origin CSP: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:7800` + `Permissions-Policy` deny-all
- Host CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://127.0.0.1:7801; connect-src 'self'; frame-src http://127.0.0.1:7801; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`
- API middleware: Host-header allowlist (127.0.0.1/localhost only — DNS-rebinding defense), reject `Sec-Fetch-Site: cross-site` on unsafe methods, `application/json`-only writes, no CORS, no GET mutations
- Per-agent bearer tokens (hashed at rest); human browser session via one-time `?token=` exchange from `board open` (stored localStorage, sent as bearer)
- DOMPurify for all markdown/agent text in host chrome; mermaid strict; uploads mime-allowlisted + size-capped; SVG sanitized
- PostMessage nonce-handshake protocol designed now, implemented with the v1.1 bridge

## Web UI (React + Vite, served by daemon)

1. **Board list** — status, author, unresolved-comment counts, **presence badges (which agents are subscribed/listening, and how — SSE / cursor / webhook)**, tags; create/open/end
2. **Board view** — rendered board + **comment sidebar**: select text → comment; hover section header → comment; comment a table row; general board comment; threaded replies; resolve; author badges (you vs. each agent) + timestamps; version switcher; restore-to-version
3. **Audit view** — filterable event log (all boards / per board), derived from the events table
4. **Image viewer** — overlay annotation editor (arrow + textbox) and display
5. Live updates via SSE. Ended boards render read-only.

## Documentation & skills (first-class deliverables)

- **`docs/`**: `README.md` (quickstart via make), `api.md` (REST + curl examples), `mcp.md`, `anchors.md` (`data-ba` conventions + anchor JSON schema), `feedback-grammar.md` (machine-parseable spec), `templates.md`, `security.md` (threat model, headers, token model), `deployment.md` (loopback, tmux/systemd, **Docker agents**, ngrok caveats)
- **Skills** — `skills/board/SKILL.md` in-repo; `make install` places per-agent copies (opencode, claude, `~/.agents/skills/`): board-creation patterns, template usage, `data-ba` convention, vendored-lib paths, the async consumption loop (cursor polling / `events.jsonl` tailing / webhook), and how to read the feedback grammar
- **`templates/`**: plan, decision-brief (MADR-shaped: context → drivers → options w/ per-option pros/cons → verdict field), explainer, progress report, HTML dashboard starter — markdown templates get auto-anchors; HTML templates carry `data-ba` markers
- **`.mcp.json`** at repo root

## Operations: Makefile + install

**Makefile is the primary interface**: `make serve` · `make open [ID]` · `make list` · `make token add|list|revoke AGENT` · `make install` · `make test` · `make dev` (daemon + web hot-reload) · `make export ID=` / `make import FILE=` — thin wrappers over the `board` CLI; no auto-spawn magic.

`make install` writes, per agent:
- **opencode** (live on this machine): `mcp` entry in `~/.config/opencode/opencode.jsonc` + skill in `~/.config/opencode/skills/` + npm plugin stub
- **claude code** (live): `claude mcp add --transport http board ...` (user scope) + skill in `~/.claude/skills/`
- **codex / pi** (not installed here): emit `.mcp.json` + `~/.agents/skills/` placement (the cross-agent dir this machine already uses); instructions written, testing deferred until installed

## Milestones (each ends runnable + verified)

- **M1** Scaffold (Bun workspaces monorepo: `server/`, `web/`, `cli/`, `skill/`, `docs/`), daemon on two ports, SQLite + WAL, board-bundle layout, global + per-board events (dual-write), auth middleware (Host/Sec-Fetch/bearer), board + version CRUD with the unified HTML document model (markdown rendered at publish), 409 conflict, Makefile, `tsc --noEmit` + biome + `bun test` wired
- **M2** Web shell: board list, markdown-derived boards rendered in host chrome (marked → DOMPurify → mermaid → katex, auto `data-ba`), version switcher, token exchange flow
- **M3** Comments + anchoring (section, text-highlight, and table-row anchors; re-anchor by quote), sidebar w/ threads + resolve, SSE live updates, feedback-markdown serializer, per-agent comment cursors
- **M4** HTML boards: `:7801` serving + security headers, sandboxed iframe embed, vendored/pinned mermaid+tailwind+plotly+katex, publish-time anchor extraction (`data-ba`), HTML dashboard template working end-to-end inside the sandbox
- **M5** MCP Streamable HTTP endpoint + all tools; SDK-client integration test; subscriptions/presence + webhook dispatcher (HMAC, retry, dead-letter); skill + templates + `.mcp.json` + `make install` for opencode + claude
- **M6** Assets + image annotation (file-copy ingest via binary or `{path}`, overlay editor + SVG render, image-anchored comments, agent-side overlay schema); bundle export/import
- **M7** Audit view, restore UI, docs complete (api / anchors / feedback-grammar / security / deployment incl. Docker), hardening pass (caps, sanitize, headers audit), full smoke: two simulated agents + human comments → async feedback consumed via cursor and webhook

**Verification per milestone**: `bun test` (unit: storage/anchors/serializer/auth; integration: REST + MCP via SDK client) + manual UI checklist. Final acceptance = the two-agent + human smoke run.

## Phase 2 backlog (explicitly deferred)

Bridge overlay for full in-HTML anchoring (text highlights/elements inside interactive boards — the plannotator bridge pattern) · word-level round diffs (easel-grade) · native MCP `subscriptions/listen` push + Claude channels · CRDT co-editing (Yjs) · anchors surviving edits beyond quote re-match · live agent-telemetry board regions (opencode/claude SSE as board content) · markdown boards embedding inline sandboxed applet blocks (prose + widgets in one board) · ngrok remote mode · vendored lib expansion (htmx, alpine, d3)

## Out of scope

Cloud hosting, accounts, sharing portals · chat pane in the board (terminal stays chat) · code-review/PR viewers (plannotator's niche) · Electron/desktop packaging · kanban/task management · server-side execution of agent code · multi-human user management

## Risks / open items

- Mermaid + plotly inside `sandbox="allow-scripts"` iframes: expected to work (DOM + inline scripts allowed, no storage needed) — verified first thing in M4; static-render fallback if a lib fights the sandbox
- Tailwind play-cdn script vendored & pinned (single script; confirmed pattern)
- Concurrent multi-agent writes: SQLite WAL + busy-retry; the daemon is the single writer (all writes go through the API — agents never write files directly)
- `{path}` file-copy ingest: magic-byte image verification + mime allowlist + size cap prevent repurposing it to read arbitrary host files
- Docker-agent networking: loopback unreachable from containers by default — deployment doc covers `--network=host`, `host.docker.internal` + bind list, and volume-mounted events tailing
- Codex/pi install paths written but unverifiable on this machine until installed
- Name/branding: `board` is a placeholder
