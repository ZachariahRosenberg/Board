# board

A local-first **shared board** for humans and AI coding agents.

An always-on localhost daemon hosts rich, interactive boards — plans, decision briefs, technical explainers, dashboards, progress reports. Agents publish them over MCP or REST; you comment and annotate in the browser, anchored to specific text, sections, table rows, and images; everyone stays in sync through an append-only event log.

## Why

Terminal agents are powerful, but the interface is a single scrolling transcript:

- **Decisions get buried.** While you're reading one thing, subagent output pushes it off-screen; the question that needed your answer is lost in the scroll.
- **Context evaporates.** Discussing item 4 of a 10-item table means scrolling back to the table; plans and findings vanish with the session.
- **Text-only limits.** The best explanations are visual — workflows as diagrams, options as tables, data as charts — and a TUI can't host them.

`board` gives that work a persistent, richer home: boards outlive sessions, feedback is anchored to what it's about, and multiple agents (opencode, claude code, codex, …) share the same surface as you — with attribution for who said what.

## The loop

```
 agents ──publish (MCP / REST)──▶ boardd ──host render (D18)──▶ you (browser)
    ▲                                                            │
    └── events / cursor polls / webhooks ◀── anchored comments ──┘
```

Boards render markdown (mermaid + katex) and agent-authored HTML+CSS+JS (chart.js preloaded and pinned, more vendored libs on the way) directly in the app — full host-render at the owner's decision (D18). Your comments anchor to text highlights, section headers, and table rows on **every** board; agents read them as structured, anchored feedback — never blocking, always attributable.

## Status

**M1–M6 complete — the feedback loop is live end to end.** Agents publish boards over REST or MCP (`:7800/mcp`, 13 tools, stateless Streamable HTTP); every board — markdown and agent HTML — renders in the host chrome with full anchoring and, for agent HTML, running scripts (D18); you comment with threads, resolve, and live SSE; agents consume feedback via the comments cursor or HMAC-signed webhooks; assets ingest through verification (magic bytes + mime allowlist) and boards round-trip through export/import. `make install` wires the MCP server into local agents and auto-mints tokens. Remaining: M7 audit view + restore UI + hardening + final smoke. The approved v1 plan lives in [docs/plan.md](docs/plan.md) (milestones M1–M7).

## Documentation

| Document | Contents |
|---|---|
| [docs/plan.md](docs/plan.md) | Approved v1 plan: scope, data model, API/MCP surface, milestones |
| [docs/architecture.md](docs/architecture.md) | System design: process model, board bundles, request flows, events |
| [docs/security.md](docs/security.md) | Threat model, render trust model (D18), CSP, hard invariants |
| [docs/stack.md](docs/stack.md) | Technology choices and rationale |
| [docs/research.md](docs/research.md) | Survey of similar tools and what we borrow from each |
| [docs/decisions.md](docs/decisions.md) | Decision log (ADR-style) |
| [docs/style-guide.md](docs/style-guide.md) | Code style and conventions |
| [docs/api.md](docs/api.md) | The API inventory: REST routes, MCP tools, error codes |
| [docs/anchors.md](docs/anchors.md) | Anchor schema: `data-ba` ids, anchor variants, image overlays |
| [docs/feedback-grammar.md](docs/feedback-grammar.md) | Agent-side feedback loop: cursors, threads, webhooks, presence |
| [docs/deployment.md](docs/deployment.md) | Install, run, systemd, data + backups, Docker (loopback rules) |

Agent instructions: [AGENTS.md](AGENTS.md).

## Planned layout

```
server/   the daemon — REST API, MCP endpoint, SSE, SQLite storage (:7800)
web/      host app (React + Vite): board list, board view, comment sidebar, audit view
cli/      `board` CLI — make targets wrap it
skills/   agent skill + board templates
docs/     this documentation
```

## Quickstart

```
make deps                  # bun install
make web                   # build the web app (once, and after UI changes)
make install               # wire the board MCP server into your agents (mints tokens)
make serve                 # daemon on 127.0.0.1:7800
make open                  # open the web UI in your browser (one-time session token)
make list                  # boards with status, version, unresolved counts
make export ID=<id>        # self-contained zip bundle of a board
make import FILE=<id>.zip  # recreate a board from a bundle (D18 quarantine re-runs)
make smoke                 # self-verifying end-to-end loop check (temp daemon, scratch ports)
```

Then, as an agent (or curl):

```
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Hello","format":"markdown"}' http://127.0.0.1:7800/api/boards
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"# Hi\n\nfirst board","expected_version":0}' \
  http://127.0.0.1:7800/api/boards/<id>/publish
```

Agent wiring for opencode + claude code: `make install` (auto-mints per-agent tokens, writes the MCP config, installs the skill).

Reference for agents and operators: [docs/api.md](docs/api.md) (every route, tool, error code), [docs/feedback-grammar.md](docs/feedback-grammar.md) (the consumption loop), [docs/anchors.md](docs/anchors.md), [docs/deployment.md](docs/deployment.md).

## Principles

1. **Local-first.** Single human, multiple named agents, one machine. No cloud, no accounts.
2. **Boards are bundles.** Every board is self-contained on disk — versions, assets, and its own event channel — zippable, greppable, portable.
3. **Interactive by default.** Agent HTML runs in the app's own origin (D18, owner decision) under a CSP that never opens network egress (`connect-src 'self'`) or form navigation. Security headers are never loosened for convenience.
4. **Async feedback.** Agents never block on humans; they poll per-agent cursors, tail the event log, or receive signed webhooks.
5. **One writer.** All state changes flow through the daemon's API; agents never write files directly.
