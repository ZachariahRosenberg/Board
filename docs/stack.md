# Technology stack

What we build with and why. Companions: [decisions.md](decisions.md) (the decision log) and [architecture.md](architecture.md) (the system design).

## Choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | One tool for runtime + test runner; `bun:sqlite` builtin; can compile to a single binary for distribution (plannotator precedent). Already on this machine via opencode/plannotator. |
| Language | **TypeScript (strict)** | All reference implementations and the MCP SDK are TS; one language across daemon, web, CLI. |
| HTTP | **raw `Bun.serve()`** — no framework | One host origin, one flat router (API + MCP + statics) doesn't earn a framework's weight; plannotator ships this way. Routing stays a flat, readable table. |
| Storage | **SQLite (`bun:sqlite`, WAL)** + on-disk mirrors | Queryable source of truth; concurrent agent writes safe under WAL; version content mirrored as files inside per-board bundles for portability and greppability. |
| Web UI | **React + Vite** | Standard SPA built to `dist/` and served by the daemon; plannotator/OpenDesign precedent. |
| Markdown | **marked (GFM) → DOMPurify → data-ba injection → katex → Shiki** | Rendered server-side at publish; sanitized once, stored as the immutable HTML document. Mermaid fences stay source in the stored doc — the web app renders them client-side (D12). |
| Sandbox libs | vendored, exact pin: **chart.js@4** served from `/libs/*` on the host origin; mermaid ships as client-side npm (D12) | No runtime CDNs — supply-chain control (D8, as trimmed by D18: one origin, one vendored lib so far); a board authored today renders identically next year. |
| MCP | **`@modelcontextprotocol/sdk`**, Streamable HTTP (rev 2026-07-28) | Rides the same daemon/port; opencode, claude code, and codex all support it natively; plain REST stays first-class alongside. |
| Lint/format | **biome** | One fast tool for both; `bunx tsc --noEmit` remains the typecheck. |
| Tests | **bun test** | Builtin, fast, no config sprawl. |
| Ops | **Makefile** wrapping a thin `board` CLI | The user-facing operational interface (`make serve/open/install/test/dev`); no auto-spawn magic. |

## Deliberately avoided

- **Forks as a base.** open-canvas (archived, Supabase-bound), open-artifacts (Cloudflare-bound), OpenDesign (96k-star ecosystem with always-on telemetry), plannotator (per-session review model — wrong persistence shape). We steal patterns, not codebases; see [research.md](research.md).
- **Web frameworks (Express/Hono/Fastify).** Two static-ish routers; a framework adds dependencies without adding safety.
- **Next.js / SSR / Electron.** Localhost SPA served by the daemon; no desktop packaging in v1.
- **CRDTs (Yjs/Automerge) in v1.** Boards are agent-published immutable rounds, not concurrently-edited documents. Revisit in phase 2.
- **External CDNs at runtime.** Everything vendored + pinned under `/libs/` on the host origin.
- **A chat pane in the web UI.** The terminal stays the chat; the board is for artifacts + anchored feedback.

## Versioning policy

- App dependencies: standard semver ranges, lockfile committed.
- Vendored sandbox libraries: **exact pins**, upgraded deliberately and never floating — old boards must keep rendering.
