# Decision log

ADR-style, oldest first. Entries are append-only: superseding a decision adds a new entry that references the old one; entries are never edited after acceptance.

## D1 — Build from scratch, not a fork — 2026-09-15

- **Context:** Evaluated plannotator, open-canvas, OpenDesign, open-artifacts as bases ([research.md](research.md)).
- **Decision:** Minimal greenfield build; steal patterns, not codebases.
- **Consequences:** No upstream baggage; we own the whole surface. We implement the annotation UX ourselves (the hardest part) and must keep scope honest.

## D2 — TypeScript + Bun, raw `Bun.serve`, no web framework — 2026-09-15

- **Context:** All reference implementations are TS; Bun is already on the machine; two small routers don't need a framework.
- **Decision:** Bun runtime, strict TS, flat router tables, `bun:sqlite` (WAL) storage, biome + `tsc --noEmit`, `bun test`.
- **Consequences:** Single-language codebase and possible single-binary distribution; validation/middleware are hand-rolled and tested.

## D3 — Async-only agent feedback — 2026-09-15

- **Context:** Agents could block on human review (plannotator's gate model) or continue asynchronously.
- **Decision (user):** Async only. Agents poll per-agent cursors, tail `events.jsonl`, or receive signed webhooks. No blocking wait tool exists.
- **Consequences:** Long-lived boards work; no `wait_for_comments`; agents must build a consumption habit — taught by the skill's polling loop.

## D4 — Phased anchoring — 2026-09-15

- **Context:** Full in-HTML anchoring (the bridge overlay) is the single hardest component.
- **Decision (user):** v1 = sections + text highlights + table rows on markdown-derived boards (host-chrome rendering) and `data-ba` section markers on HTML boards; v1.1 = bridge overlay for in-iframe anchoring.
- **Consequences:** Core value lands early; text comments inside HTML boards wait for v1.1; the anchor schema is designed bridge-compatible from day one.

## D5 — One document model (HTML), two display modes — 2026-09-15

- **Context:** Pure HTML-only-everything-in-iframe would drop v1 text-highlight anchoring; two *stored* types would split the pipeline.
- **Decision (user question):** Every version is one HTML document; `format` is input convenience. Markdown renders at publish with auto-injected anchors and displays in the host chrome (script-free by construction); authored HTML displays in the sandboxed iframe.
- **Consequences:** One storage/serving path and one anchor model; display logic branches on provenance; markdown boards can't embed live widgets until the phase-2 applet idea.

## D6 — SQLite source of truth + self-contained board bundles — 2026-09-15

- **Context:** Needs: concurrent agent writes, portability, greppability, audit.
- **Decision (user input):** SQLite (WAL) for state; per-board bundle dirs (`versions/`, `assets/`, `events.jsonl`, `board.json`) mirrored on disk; export/import = zip of a bundle; global `events.jsonl` for machine-wide tailing.
- **Consequences:** Slight dual-write cost; boards zip/move/grep as units; agents integrate with zero client library by tailing jsonl.

## D7 — Two-origin sandboxing — 2026-09-15

- **Context:** Agent-authored HTML must never touch trusted chrome.
- **Decision:** Host `:7800` / board origin `:7801`; `sandbox="allow-scripts"` only; strict CSPs ([security.md](security.md)).
- **Consequences:** Defense in depth against malicious boards; board↔host communication must go through a nonce-handshaked postMessage bridge (v1.1).

## D8 — Vendored, pinned sandbox libraries — 2026-09-15

- **Context:** Boards need common libraries without runtime CDNs.
- **Decision (user):** mermaid, tailwind (play-cdn script), plotly, katex — vendored, exact pins, served from the board origin.
- **Consequences:** Boards render identically offline, forever; library upgrades are deliberate events.

## D9 — MCP Streamable HTTP + REST parity; events as substrate — 2026-09-15

- **Context:** Multiple agent harnesses (opencode, claude code, codex, pi) need one integration path; CLI agents aren't listening services.
- **Decision:** One daemon serves REST + MCP (Streamable HTTP, rev 2026-07-28) + SSE; append-only events with a global `seq` are the audit log and universal subscription mechanism; webhooks are opt-in push with HMAC + retry + dead-letter.
- **Consequences:** Every harness integrates the same way; push is best-effort, cursor polling is the reliable baseline.

## D10 — Makefile as the operational interface — 2026-09-15

- **Context:** Daemon lifecycle could be auto-spawned magic or explicit commands.
- **Decision (user):** `make serve/open/list/token/install/test/dev/export/import` wrapping a thin `board` CLI; no auto-spawn.
- **Consequences:** Predictable, greppable ops; systemd/tmux documented but optional.

## D11 — Patched happy-dom for DOMPurify correctness — 2026-09-15

- **Context:** Server-side markdown sanitization (invariant 6) runs DOMPurify against a happy-dom window. Under the pinned versions (happy-dom 20.x, dompurify 3.4.x) two happy-dom bugs silently break sanitization: the base `Node.prototype.nodeName` getter returns `""` (every element classifies as tag `""` and gets stripped, hoisting script content into text), and `NodeIterator` stops after the first mid-walk removal (everything following a removed node escapes sanitization).
- **Decision:** Ship two minimal, why-commented compatibility patches in `server/src/render.ts` — a receiver-correct spec `nodeName` getter and a removal-robust pre-order `createNodeIterator` replacement installed on the exact document DOMPurify caches from — guarded by the golden-document render test and adversarial mXSS-shaped probes.
- **Consequences:** Sanitization is actually correct under Bun today; the patches are coupled to DOMPurify's caching internals, so any `bun update` of dompurify/happy-dom must re-run the render suite (the probes fail loudly if the patches stop applying). Revisit when either library fixes the underlying bugs.

## D12 — Mermaid renders client-side in the host chrome — 2026-09-15

- **Context:** docs/plan.md's publish pipeline lists mermaid in the server-side chain (marked → DOMPurify → mermaid → katex), but mermaid's renderer needs real layout measurement (SVG text metrics) and fights headless DOMs — and markdown boards display in the trusted host chrome anyway.
- **Decision:** The daemon's publish pipeline (marked → DOMPurify → data-ba injection → katex → shiki) leaves mermaid fences as `<pre class="mermaid">` source blocks in the stored document; the web app renders them client-side (npm mermaid, `securityLevel: "strict"`), degrading to source text on render failure.
- **Consequences:** No headless-mermaid hack on top of D11's patches; stored documents stay render-free at publish; web mermaid stays strict-mode pinned. HTML-format boards (M4) will use the vendored board-origin mermaid inside the sandbox instead.

## D13 — SSE auth via query param; client-held cursors — 2026-09-15

- **Context:** EventSource cannot set Authorization headers, and docs/plan.md's per-agent cursors were worded as a server-acked backlog ("resume returns exactly the unacknowledged").
- **Decision:** `GET /api/stream` accepts the agent/session token via the Authorization header (preferred) or `?token=` (the EventSource fallback — why-commented in the route; tokens never logged). Comment cursors stay CLIENT-held: `?since=` is exclusive on the comment's stamped creation-event seq — at-least-once, restart-safe; agent-token polls refresh a `subscribers` presence row (kind `cursor`) rather than acking.
- **Consequences:** Browser SSE works without cookies; presence (M5) can show "listening" agents derived from real cursor reads. A server-acked backlog remains a phase-2 option if agent crash-recovery proves to need it.

## D14 — Agent-managed daemon lifecycle — phase 2 — 2026-09-15

- **Context:** D10 made the Makefile the operational interface with no auto-spawn magic. The seamless workflow — an agent mid-task spins up boardd when it needs a human decision, shares a session link, and owns the daemon lifecycle — is the natural endgame for the dogfood loop.
- **Decision (user, 2026-09-15):** Defer to phase 2. For the MVP the human keeps the server running; the `board_status` tool and the skill detect a down daemon and instruct recovery (`make serve`). Full agent lifecycle management (spawn via tmux/nohup, link sharing, shutdown) gets its own decision later, with explicit safety boundaries.
- **Consequences:** M5-lite ships without lifecycle tools; the skill documents the manual path. The daemon-down case stays a first-class detectable state, not a mystery failure.

## D15 — One agent-facing consumption path: comments only — 2026-09-15

- **Context:** docs/plan.md exposed both `board_get_comments` (raw JSON, cursor-driven) and `board_get_feedback` (the rendered feedback grammar) as MCP tools — two overlapping ways to consume the same data.
- **Decision (user, 2026-09-15):** The MCP surface ships exactly one consumption path: `board_get_comments` with the `since` cursor — agents interpret the JSON themselves. The feedback grammar stays at the REST layer (`GET /boards/:id/feedback`) for humans, scripts, and reports.
- **Consequences:** The v1 MCP tool list is 10 tools; the serializer remains maintained and tested (it powers the REST endpoint and future digest tooling). Tool minimalism per the user's one-way preference.

## D16 — MCP over stateless JSON-mode Streamable HTTP — 2026-09-15

- **Context:** the MCP endpoint (`POST /mcp`) needed a transport on Bun — `Bun.serve` is web-standard while the SDK's classic `StreamableHTTPServerTransport` speaks Node `req`/`res`.
- **Decision:** use the SDK's `WebStandardStreamableHTTPServerTransport` (v1.30+) in stateless JSON mode — `sessionIdGenerator: undefined`, `enableJsonResponse: true`, a fresh `McpServer` + transport per POST. No sessions, no GET SSE stream on `/mcp` (non-POST → 405); agents receive feedback by polling comments (D15), so the daemon never holds a long-lived MCP connection.
- **Consequences:** one request = one JSON response; MCP requests get the same hardening as `/api` (Host allowlist, cross-site rejection, JSON-only bodies, 8 MB cap) and agent-only auth (human session tokens rejected). Had the web-standard transport not existed, the fallback was a hand-rolled Transport over the SDK protocol layer.

## D17 — Token names are permanent; `--force` mints suffixed — 2026-09-15

- **Context:** `board install --force` re-mints an agent's token, but `tokens.name` is the PRIMARY KEY — a revoked row holds its name forever.
- **Decision:** `--force` revokes the old token, then mints under the first free suffix (`board-<agent>`, `board-<agent>-2`, …). Revocation kills the old credential immediately; the suffix is the visible trace of the re-mint.
- **Consequences:** token names are not stable identifiers across re-mints — `token list` shows the suffix history. The alternative (deleting rows) would erase the audit trail of a token's lifecycle.

## D18 — Full host-render: agent HTML runs in the app origin — 2026-09-15

- **Context:** M4 built the two-origin sandbox end to end (origin server `:7801`, `sandbox="allow-scripts"` iframe embed, fragment aiming, a section picker for comment creation). After one dogfood round the owner rejected the trade: the picker was clunky, in-frame text anchoring would need a bridge, and the wall costs interactivity. Owner position: "I would prefer this be a highly useful, interactive, engaging tool and accept the risks of arbitrary HTML + JS running."
- **Decision (owner, 2026-09-15):** every board renders in the **host chrome**. Agent HTML (`format: html`) mounts into the app's DOM with scripts running — no iframe, no second origin. Markdown boards keep the DOMPurify pipeline; html-format boards are exempt from sanitization by this decision.
- **Accepted risks (named, eyes open):** board script shares the app's origin — it can read the session token from localStorage, act on the API as the human, and paint arbitrary UI over the app. Rationale: locally published boards come from the user's own agents, which already hold machine-level access (arbitrary bash) — the board is not the weakest link. **Foreign content (M6 import, remote/ngrok modes) must be re-examined before those paths ship.**
- **Guards that remain:** the host CSP — `connect-src 'self'` never opens (the network-exfiltration kill-switch), `form-action 'self'` (boards cannot form-navigate the app away), `frame-ancestors 'none'`, `script-src 'self' 'unsafe-inline'` (the accepted cost); loopback-only binding; the single-local-human model.
- **Consequences:** the board-origin server (`:7801`), `/b/:id/:n`, the origin `/libs` route, `board-bootstrap-1.js`, and `BOARD_ORIGIN_PORT` were removed (net −525 lines); `/libs/*` is served by the host; html publishes store an id-injected derived document (auto `data-ba` on unlabeled top-level blocks and table rows — full hover/selection anchoring on every board, no picker); previously stored versions are not retro-injected; the v1.1 postMessage bridge and markdown applet-block phase-2 items are obsolete and dropped.
- **Retrospective:** the sandbox was built, dogfooded for exactly one round, and removed the same day — the feedback loop doing what it exists to do.

## D19 — The `sse` presence kind is removed; sessions expire — 2026-09-16

- **Context (M7 hardening audit):** the plan's subscribers schema carries `kind` (`sse` | `cursor` | `webhook`), but nothing ever wrote an `sse` row — the docs wave flagged the kind as dead. Wiring it up for real has an architectural mismatch: presence rows are board-scoped (`subscribers` is keyed by `board_id` and listed per board) while `/api/stream` is a global channel with no board to stamp, and a truthful "listening right now" row needs connect/disconnect bookkeeping plus a crash-recovery sweep (lingering rows after a daemon restart would lie) — more machinery than the observation is worth when cursor polls already say "this agent is alive and reading."
- **Decision:** remove `sse` from the domain `SubscriberKind` and correct the docs that overstated SSE presence (architecture.md "Agents consume" / webhook delivery); D13's model — presence from cursor polls, SSE as best-effort delivery only — is unchanged and stays the truth. The v1 migration's CHECK constraint keeps the literal (migrations are immutable history); nothing writes it.
- **Same audit, same number (session lifetime):** live sessions had `expires_at` NULL — immortal credentials in localStorage, with no claim in security.md promising either way. Decision: sessions now expire **30 days** after exchange (`SESSION_TTL_MS`, stamped at exchange, enforced at auth time by the existing `verifySessionToken` check; migration v6 backfills pre-TTL rows). Revocation stays the leak remediation; expiry is the forgot-to-revoke backstop. Recovery is `board open`.
- **Consequences:** `GET /api/sessions` now always shows a real `expires_at` for live sessions; a 30-day-old tab re-runs `board open` once. No behavioral change to presence: it was already cursor/webhook-only in fact.

## D20 — Agent-managed session instances (`board up` / `board down`) — 2026-09-16

- **Context:** D14 deferred full agent lifecycle management to "its own decision later, with explicit safety boundaries." The friction it left is real: an agent mid-task that wants a human decision must detect a down daemon and stop to ask the human to run `make serve` (the skill's documented recovery path). The owner asked for the agent to own the whole loop: spin up, publish, share a link, iterate, close.
- **Decision (owner, 2026-09-16):** the `board` CLI grows session-instance lifecycle commands. `board up [file]` spawns a **background ephemeral daemon** — OS-tmp data dir, kernel-assigned port (`BOARD_PORT=0`), loopback bind and Host-allowlist pinned regardless of inherited env — mints one agent token before spawn, optionally publishes a first board and prints a one-time human exchange link. `board down` ends open boards, exports each as a zip keepsake, stops the process, and purges the temp data dir and credential env file. A registry at `<BOARD_DATA_DIR>/instances/<id>/` (`instance.json` — never tokens — plus `daemon.log`, `env`, `boards/`) is the discovery substrate for `board instances`.
- **Safety boundaries (explicit, per D14's promise):**
  - The **shared daemon and persistent `~/.board` data stay human-managed** — D10's no-auto-spawn rationale is untouched for persistent state; only throwaway instances are agent-owned. Session data dirs are always OS-tmp, never under `~/.board`.
  - Loopback bind + Host-header allowlist are pinned on spawn: an inherited `BOARD_HOST=0.0.0.0` or widened `BOARD_BIND` cannot widen a session instance.
  - Auth unchanged: bearer agent token (hashed in the instance db, plaintext printed once by `up`); human access only via the one-time exchange link.
  - **Credential env file:** `up` writes `<instances>/<id>/env` (mode 0600: `BOARD_INSTANCE`, `BOARD_PORT`, `BOARD_TOKEN`) so agent shells can `source` it; it is deleted on `down`/prune. This is a session-credential *delivery* artifact (the human's localStorage bearer is the analogue), not a token store — invariant 7 (hashed at rest) still governs every db. Named risk, owner-accepted: a plaintext credential briefly at rest in the user's own data dir, ephemeral lifetime, never logged or committed.
  - **Teardown signals only verified pids:** `/proc/<pid>/cmdline` match (plus an environ `BOARD_DATA_DIR` match when readable) before any signal — a recycled pid is never killed. A dead instance still yields keepsake zips from its on-disk bundles, then cleans up.
  - MCP wiring is static (it points at the shared daemon's fixed port), so the session loop rides REST/CLI with the instance token; the skill teaches it. No new REST routes.
- **Consequences:** `make up/down/instances` wrappers follow (D10 pattern); the skill gains the session loop (up → source env → REST publish/poll → down); `board up` self-heals by pruning stale registry entries; `down` keeps `boards/*.zip`, `instance.json`, and `daemon.log` as the audit keepsake (re-importable via `make import`). In-flight webhook deliveries may be dropped at teardown — cursor polling (D15) stays the reliable consumption path for sessions.
