# Research survey

Consolidated from a five-agent research pass (2026-09-15): the projects we evaluated, what each does well, and what `board` borrows. Scope consequences live in [plan.md](plan.md).

## Evaluated as a base — all rejected as forks

| Project | What it is | Why not a base |
|---|---|---|
| [plannotator](https://github.com/backnotprop/plannotator) | Local browser annotation layer for agent plans/diffs/HTML (8.7k★, very active, MIT/Apache-2.0; installed on this machine) | Per-session review model — boards are ephemeral; no MCP, no events, no multi-agent boards. But the best annotation UX anywhere. |
| [open-canvas](https://github.com/langchain-ai/open-canvas) | OSS Canvas clone (LangChain + Next.js) | Archived Feb 2026; hard-depends on Supabase + cloud API keys; no comments/annotations at all. |
| [OpenDesign](https://github.com/nexu-io/open-design) | Agent-driven local design studio (96k★, 5 months old) | Enormous, fast-moving ecosystem + always-on scrubbed telemetry; wrong mass for a single-user tool. |
| [open-artifacts](https://github.com/coda0HQ/open-artifacts) | Self-hosted artifact publisher (Cloudflare Workers) | Cloudflare-bound substrate; but the best *versioning* model of the four. |

## What we borrow, from whom

- **plannotator** — the feedback markdown grammar (numbered items, quoted anchor text, replies, label summary — human-readable *and* agent-parseable in one artifact); the block + offset + quoted-text anchor model with re-anchoring by text match; the decision-contract pattern (stdout JSON / exit codes / result file); the bridge-overlay approach for v1.1 in-HTML anchoring; flat-file bundle instincts; skills-as-thin-launchers distribution.
- **easel** ([The-Sentience-Company/easel](https://github.com/The-Sentience-Company/easel)) — the architectural blueprint: always-on local daemon, boards that outlive sessions, publish rounds, per-agent workspace-scoped feedback cursors, "nothing delivered until the human clicks Send."
- **open-artifacts** — immutable versions with labels; `expectedVersion` → 409 optimistic concurrency; CSP-sandbox serving of untrusted HTML.
- **Claude Code Artifacts** — proof of the product loop at scale: comment threads with send-to-agent, agent watch/reply/resolve lifecycle, version pinning and "always share latest" semantics; the CSP-allowlist rendering approach; token-cost guidance for boards.
- **OpenDesign** — MCP surface design (per-agent MCP install snippets, `--json` CLI parity); per-run agent attribution.
- **HumanLayer** — the QRSPI phase taxonomy; "the doc is the interface to the code."
- **MADR / spec-kit / OpenSpec** — the decision-brief template shape; delta-spec sections as a future interop substrate.
- **opencode itself** — precedent for a multi-client agent server (`opencode serve`, SSE event bus, programmatic permission responses). Future phase: the board as a *client* of agents (approval cards that answer permission requests).

## Anti-patterns to avoid

1. The wall-of-text spec review — chunk review into anchored, per-option decisions with explicit verdict fields.
2. Rigid waterfall gates everywhere — gates are opt-in per task.
3. Rich content living in terminal scrollback.
4. Plans that evaporate with the session — boards are files.
5. Vendor/harness lock-in — bet on MCP, plain files, vendored libs.
6. Token-bloated boards (data-URI rasters, gratuitous interactivity, inlined datasets).
7. Silent or unversioned mutation — every change is an attributed event.
8. Chat-app gravity — the board is primary; chat stays in the terminal.
9. Running agent JS with privileges.
10. Auto-triggering/auto-publishing without an ask.

## Niche check

Nothing found that is simultaneously **localhost, local-first, multi-agent, annotation-anchored** (text / table row / image region), **versioned, audit-logged, and event-subscribable**. Closest neighbors, each missing pieces: Claude Code Artifacts (cloud, single-agent), HumanLayer (team SaaS, $100/user/mo), easel (macOS-only, no MCP), Nimbalyst/ex-Crystal (desktop IDE), Liveblocks (hosted infra — but its anchored-threads + MCP patterns are worth imitating). The niche is open.
