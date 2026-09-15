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
