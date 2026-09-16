# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: this applies to you too.

## What this is

`board` is a local-first shared board system: an always-on Bun daemon hosts rich boards (markdown + interactive HTML) that agents publish via MCP/REST, a human annotates with anchored comments in a web UI, and everyone consumes via an append-only event log.

**Current status: M5 + M6 complete (M1–M6 all shipped), M7 remaining** — the feedback loop is live end to end and dogfooded: agents publish boards via REST or MCP (`:7800/mcp`, 13 tools, stateless Streamable HTTP), every board — markdown and agent HTML — renders in the host chrome with full anchoring (text selection, sections, rows, images; html boards get auto-injected `data-ba` at publish, scripts run per D18), humans comment with threads + resolve + live SSE (image comments carry arrow/box overlays), agents consume feedback via the comments cursor (D15) or HMAC-signed webhooks; assets ingest through verification (magic bytes + mime allowlist + caps, SVG sanitized) and boards round-trip through export/import with the D18 quarantine re-examination. `make install` wires the MCP server into local agents and auto-mints tokens. Remaining: M7 audit view + restore UI + hardening + final smoke. The approved v1 plan is [docs/plan.md](docs/plan.md). Read the plan before writing code; read [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) before touching `server/`.

## Read order

1. [docs/plan.md](docs/plan.md) — scope, data model, milestones (source of truth)
2. [docs/architecture.md](docs/architecture.md) — process model, request flows, events
3. [docs/security.md](docs/security.md) — threat model and the invariants below
4. [docs/style-guide.md](docs/style-guide.md) — code conventions
5. [docs/decisions.md](docs/decisions.md) — why things are the way they are

## Commands

All targets are live (`make list`/`export`/`import` arrived with M6):

| Task | Command |
|---|---|
| Install deps | `make deps` (wraps `bun install`) |
| Wire agents (MCP + skill + tokens) | `make install` (`--force` via `make install FLAGS=--force`) |
| Test | `make test` (wraps `bun test`) |
| Typecheck | `bunx tsc --noEmit` |
| Lint + format | `bunx biome check --write .` |
| Run daemon | `make serve` |
| Dev (hot reload) | `make dev` |
| Mint agent token | `make token add <name>` (`--force` via `make token add <name> FLAGS=--force` re-mints a taken name, D17) |
| Build web app | `make web` |
| Open UI | `make open [board id]` |

Run typecheck, lint, and tests before finishing any change. If a command doesn't exist yet, you're early — don't invent behavior that contradicts the plan.

## Non-negotiable invariants

These exist for security reasons ([docs/security.md](docs/security.md)). Do not violate them, even temporarily, even in tests:

1. Bind loopback only (`127.0.0.1`) unless the user explicitly configures otherwise.
2. Agent HTML boards render in the host chrome with scripts running (D18, owner decision 2026-09-15). The host CSP is the guard: `connect-src 'self'` never opens, `form-action 'self'` stays. Never widen the host CSP beyond the allowlist in [docs/security.md](docs/security.md).
3. All writes go through the daemon API. Agents never write to `~/.board` directly.
4. Events are append-only. Never mutate or delete an event row.
5. Markdown published content passes through DOMPurify — no exceptions. html-format boards are exempt per D18; never add sanitization to them, or skip it for markdown, without the owner's say-so.
6. Asset ingest verifies magic bytes + mime allowlist + size cap; the `{path}` file-copy route must never be usable to read non-image files.
7. Never log or commit tokens; tokens are stored hashed.

## Conventions

- TypeScript strict mode; formatting via biome — see [docs/style-guide.md](docs/style-guide.md).
- **Minimal codebase**: when a feature is removed, its code, tests, and fixtures are removed in the same change — no dead code, no vestigial surfaces, no "might be useful later."
- **Decision comments**: every non-obvious decision site in code carries a short comment with its why (and a [docs/decisions.md](docs/decisions.md) reference when one exists) so future agents inherit the context.
- A change that affects the API surface, anchor schema, event types, or security headers updates the matching doc in the same change.
- Decisions that deviate from the plan get a new entry in [docs/decisions.md](docs/decisions.md) — don't silently amend the plan.
- Mark milestone progress by appending status to the milestone bullet in [docs/plan.md](docs/plan.md).
- Commit messages: short imperative subject, e.g. `m1: wire publish + 409 conflict handling`.
- `~/.board` is user data — tests and dev runs use a temp `BOARD_DATA_DIR`, never the real one.
