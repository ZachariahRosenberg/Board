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
 agents ──publish (MCP / REST)──▶ boardd ──sandboxed render──▶ you (browser)
   ▲                                                            │
   └── events / cursor polls / webhooks ◀── anchored comments ──┘
```

Boards render markdown (with mermaid + katex) and agent-authored HTML+CSS+JS (tailwind, plotly, mermaid, katex preloaded and pinned) inside a strict sandbox. Your comments anchor to text highlights, section headers, table rows, and image regions; agents read them as structured, anchored feedback — never blocking, always attributable.

## Status

**M3 complete — the dogfood loop is live.** Agents publish boards over REST; you comment in the browser with anchored text highlights, sections, and table rows; threads resolve; everything updates live over SSE; agents read feedback as a structured markdown grammar via cursors. MCP + one-command agent wiring (`make install`) land with M5. The approved v1 plan lives in [docs/plan.md](docs/plan.md) (milestones M1–M7).

## Documentation

| Document | Contents |
|---|---|
| [docs/plan.md](docs/plan.md) | Approved v1 plan: scope, data model, API/MCP surface, milestones |
| [docs/architecture.md](docs/architecture.md) | System design: two-origin model, board bundles, request flows, events |
| [docs/security.md](docs/security.md) | Threat model, sandbox/CSP requirements, hard invariants |
| [docs/stack.md](docs/stack.md) | Technology choices and rationale |
| [docs/research.md](docs/research.md) | Survey of similar tools and what we borrow from each |
| [docs/decisions.md](docs/decisions.md) | Decision log (ADR-style) |
| [docs/style-guide.md](docs/style-guide.md) | Code style and conventions |

Agent instructions: [AGENTS.md](AGENTS.md).

## Planned layout

```
server/   the daemon — REST API, MCP endpoint, SSE, SQLite storage, board origin (:7801)
web/      host app (React + Vite): board list, board view, comment sidebar, audit view
cli/      `board` CLI — make targets wrap it
skill/    agent skill + board templates
docs/     this documentation
```

## Quickstart

```
make install              # bun install
make web                  # build the web app (once, and after UI changes)
make token add myagent    # mint an agent token (printed once — store it)
make serve                # daemon on 127.0.0.1:7800 (+ board origin :7801)
make open                 # open the web UI in your browser (one-time session token)
```

Then, as an agent (or curl):

```
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Hello","format":"markdown"}' http://127.0.0.1:7800/api/boards
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"# Hi\n\nfirst board","expected_version":0}' \
  http://127.0.0.1:7800/api/boards/<id>/publish
```

Agent wiring (`make install`) lands with M5.

## Principles

1. **Local-first.** Single human, multiple named agents, one machine. No cloud, no accounts.
2. **Boards are bundles.** Every board is self-contained on disk — versions, assets, and its own event channel — zippable, greppable, portable.
3. **Sandbox by default.** Agent-authored HTML runs in a sandboxed iframe under a strict CSP. Security headers are never loosened for convenience.
4. **Async feedback.** Agents never block on humans; they poll per-agent cursors, tail the event log, or receive signed webhooks.
5. **One writer.** All state changes flow through the daemon's API; agents never write files directly.
