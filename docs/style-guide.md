# Style guide

Conventions for this repo. Formatting is enforced by biome; the rest is review convention. When in doubt, match the surrounding code.

## TypeScript

- `strict: true`, no implicit `any`. Domain types (`Board`, `Version`, `Comment`, `Anchor`, `Event`, …) are defined once in a shared domain module and imported — no duplicate shapes drifting between server and web.
- Named exports only (no default exports) — keeps refactors and greps cheap.
- No `any` unless interfacing with an untyped library; narrow at the boundary and leave a comment saying why.
- Errors: throw `Error` subclasses; API handlers translate errors to HTTP status codes in one place, never inline.
- Validate all external input (API bodies, query params, MCP tool args) at the boundary — parse into typed values, don't sprinkle ad-hoc checks.

## Files & naming

- `kebab-case.ts` files; `PascalCase` for types/components; `camelCase` for functions/variables/props.
- Tests colocated: `foo.test.ts` next to `foo.ts`; cross-module integration tests under `server/test/`.
- One module = one responsibility; keep route handlers thin and push logic into testable functions.

## Formatting & tooling

- biome defaults (2-space indent, double quotes, semicolons). Run `bunx biome check --write .` before finishing.
- `bunx tsc --noEmit` must be clean.
- `bun test` for unit + integration; no snapshot tests for API responses — assert shapes explicitly.

## Comments & docs

- Comments explain *why*, not *what*; delete comments that narrate the code.
- Non-obvious security decisions get a comment pointing at [security.md](security.md).
- Any change touching the API surface, anchors, events, or security headers updates the matching doc in the same change.

## Commits

- Short imperative subject, e.g. `m3: re-anchor comments by quote match`.
- One logical change per commit; small, reviewable diffs; never commit tokens or secrets.

## Testing rules

- Never touch `~/.board` in tests — always a temp `BOARD_DATA_DIR`.
- Every API endpoint gets at least one happy-path and one auth-failure test.
- Invariants (append-only events, 409 on version conflict, sandbox headers, magic-byte ingest) get regression tests.
