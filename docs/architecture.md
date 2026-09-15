# Architecture

System design for v1. Scope and milestones live in [plan.md](plan.md); the threat model in [security.md](security.md).

## Process model

One process — `boardd` — listens on two loopback ports. Different ports are different origins, which is the foundation of the sandbox model:

| Port | Origin role | Serves |
|---|---|---|
| `127.0.0.1:7800` | **host** (trusted chrome) | React SPA, `/api/*` REST, `/mcp` (Streamable HTTP), `/api/stream` SSE |
| `127.0.0.1:7801` | **board origin** (untrusted content) | `/b/<id>/<version>` HTML documents, `/libs/*` vendored libs, `/assets/<id>` images |

The host app never renders agent HTML directly. HTML boards are embedded via `<iframe sandbox="allow-scripts">` pointing at the board origin, so even a malicious board is origin-isolated from the comment store, tokens, and host DOM. Boards are served as real documents from their own origin — never via `srcdoc` or `blob:` URLs on the host origin (that would leave the sandbox as the only barrier).

Ports are configurable (`BOARD_PORT`, `BOARD_ORIGIN_PORT`); default bind is `127.0.0.1` only, with an explicit, documented bind-list option for Docker-hosted agents.

## On disk

```
~/.board/                     BOARD_DATA_DIR (overridable)
  board.db                    SQLite (WAL): boards, versions, comments, events, tokens, subscribers
  events.jsonl                global append-only event log
  boards/<id>/                self-contained board bundle (a zip of this dir = full export)
    board.json                metadata snapshot
    versions/NNN.html         immutable documents (+ NNN.md source for markdown input)
    assets/<id>.<ext>         images, bundled with their board
    events.jsonl              per-board event channel
```

SQLite is the queryable source of truth; the bundle layout exists so a board is one portable, greppable unit. Export/import are direct zips of `boards/<id>/`. All writes flow through the daemon's API — agents never touch these files.

## One document model, two display modes

Every version is stored and served as **one HTML document**. `format` (markdown | html) is input convenience:

- **markdown** → the daemon renders at publish (marked GFM → DOMPurify → mermaid strict → katex → code highlighting), auto-injecting `data-ba` ids on every top-level block, heading, and table row. The derived document is script-free by construction (DOMPurify strips scripts), so the UI renders it **in the host chrome** — enabling v1 text-highlight, section, and row anchoring right next to the comment sidebar. The markdown source is kept alongside the derived HTML.
- **html** → served verbatim from the board origin inside the sandboxed iframe; annotatable sections come from opt-in `data-ba` markers extracted at publish. In-iframe text/element anchoring arrives with the v1.1 bridge (nonce-handshaked postMessage overlay, plannotator-style).

## Request flows

**Agent publishes.** MCP tool or REST call → bearer auth (token → agent identity) → `format: markdown` rendered + anchors extracted → new immutable version row (`expected_version` mismatch → 409) → content mirrored into the bundle → event appended (db + global jsonl + per-board jsonl) → SSE broadcast → webhooks dispatched.

**Human comments.** Selection in the UI → anchor JSON (`section` / `text` with quoted original / `row` / `image` with overlay) → comment row (author, timestamp, thread parent) → event → agents receive it on their next cursor poll, event tail, or webhook.

**Agents consume.** Per-agent cursors (`workspace:agent`) return exactly the unacknowledged backlog; `GET /boards/:id/feedback` serializes unresolved threads as the feedback markdown grammar (human-readable, agent-parseable); presence is derived from real behavior — SSE connections, cursor reads, and webhook registrations — not from heartbeats agents must remember to send.

**MCP (agents, first-class).** `POST /mcp` on the host port speaks Streamable HTTP in stateless JSON mode (D16): every request gets a fresh MCP server + transport (no sessions, no GET SSE stream; non-POST → 405), auth is agent-token-only (header or `?token=`; valid human session tokens are rejected), and tools call the same service-layer functions the REST routes call — MCP agents and REST agents are indistinguishable in the event log. The 10-tool surface is defined in [plan.md](plan.md); feedback consumption is one path (D15): `board_get_comments` + `since` cursor.

## Events

Global monotonic `seq`; every mutation is one event: `board.created/published/ended/restored`, `comment.created/replied/resolved`, `asset.added`, `agent.subscribed`, `webhook.failed`, … Events are append-only (an invariant) and the audit view is a filter over them.

Delivery is layered:

| Channel | For | Guarantee |
|---|---|---|
| SSE (`/api/stream`) | the web UI, agents that want push | best-effort; reconnect resumes via last seq |
| `?since=` cursor polling | agents (the reliable baseline) | at-least-once, restart-safe |
| `events.jsonl` tails | hook systems (Claude `FileChanged`, opencode plugin events), scripts | plain file, zero client library |
| HMAC-signed webhooks | opt-in push per subscriber | 3 retries, backoff, dead-letter events on failure |

## Versioning & conflicts

Versions are immutable and numbered per board. Publishing takes `expected_version`; a stale value returns 409 so two agents can't silently clobber each other (open-artifacts' model). "Restore" publishes a copy of an old version as a new one — history stays linear and honest; nothing is ever mutated in place.

## Multi-agent notes

Every publish/comment/event carries an actor (the human, or a named agent via its token). Agents in different worktrees/processes all talk to the same daemon. Docker-hosted agents can't reach host loopback by default — options (documented in `docs/deployment.md` when it lands): run with `--network=host`, use `extra_hosts: ["host.docker.internal:host-gateway"]` with the daemon's bind list, or volume-mount `~/.board` and tail per-board `events.jsonl` from inside the container.
