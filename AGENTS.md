# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: this applies to you too.

## What this is

`board` is a local-first shared board system: an always-on Bun daemon hosts rich boards (markdown + interactive HTML) that agents publish via MCP/REST, a human annotates with anchored comments in a web UI, and everyone consumes via an append-only event log.

**Current status: M5-lite complete** — the feedback loop is live end to end and dogfooded: agents publish boards via REST or MCP (`:7800/mcp`, 10 tools, stateless Streamable HTTP), humans comment in the web UI with anchored text/section/row comments (threads, resolve, live SSE), agents consume feedback via the comments cursor — the one consumption path (D15). `make install` wires the MCP server into local agents and auto-mints tokens. Remaining: M5 webhooks, M4 board-origin boards, M6 assets/import/export, then dogfooding toward v1. The approved v1 plan is [docs/plan.md](docs/plan.md). Read the plan before writing code; read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) before touching `server/`.

## Read order

1. [docs/plan.md](docs/plan.md) — scope, data model, milestones (source of truth)
2. [docs/architecture.md](docs/architecture.md) — two-origin model, request flows, events
3. [docs/security.md](docs/security.md) — threat model and the invariants below
4. [docs/style-guide.md](docs/style-guide.md) — code conventions
5. [docs/decisions.md](docs/decisions.md) — why things are the way they are

## Commands

`make list`/`export`/`import` arrive with later milestones; `make deps` and `make install` are live:

| Task | Command |
|---|---|
| Install deps | `make deps` (wraps `bun install`) |
| Wire agents (MCP + skill + tokens) | `make install` (`--force` via `make install FLAGS=--force`) |
| Test | `make test` (wraps `bun test`) |
| Typecheck | `bunx tsc --noEmit` |
| Lint + format | `bunx biome check --write .` |
| Run daemon | `make serve` |
| Dev (hot reload) | `make dev` |
| Mint agent token | `make token add <name>` |
| Build web app | `make web` |
| Open UI | `make open [board id]` |

Run typecheck, lint, and tests before finishing any change. If a command doesn't exist yet, you're early — don't invent behavior that contradicts the plan.

## Non-negotiable invariants

These exist for security reasons ([docs/security.md](docs/security.md)). Do not violate them, even temporarily, even in tests:

1. Bind loopback only (`127.0.0.1`) unless the user explicitly configures otherwise.
2. Board iframes are `sandbox="allow-scripts"` — never add `allow-same-origin`, `allow-forms`, `allow-popups`, or `allow-top-navigation`.
3. Never widen the board-origin CSP beyond the allowlist in [docs/security.md](docs/security.md) (`connect-src 'none'` stays).
4. All writes go through the daemon API. Agents never write to `~/.board` directly.
5. Events are append-only. Never mutate or delete an event row.
6. Markdown/agent text rendered in the host app passes through DOMPurify. No exceptions.
7. Asset ingest verifies magic bytes + mime allowlist + size cap; the `{path}` file-copy route must never be usable to read non-image files.
8. Never log or commit tokens; tokens are stored hashed.

## Conventions

- TypeScript strict mode; formatting via biome — see [docs/style-guide.md](docs/style-guide.md).
- A change that affects the API surface, anchor schema, event types, or security headers updates the matching doc in the same change.
- Decisions that deviate from the plan get a new entry in [docs/decisions.md](docs/decisions.md) — don't silently amend the plan.
- Mark milestone progress by appending status to the milestone bullet in [docs/plan.md](docs/plan.md).
- Commit messages: short imperative subject, e.g. `m1: wire publish + 409 conflict handling`.
- `~/.board` is user data — tests and dev runs use a temp `BOARD_DATA_DIR`, never the real one.
