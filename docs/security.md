# Security model

Threat model and required mitigations for v1. The invariants here are enforced in code and restated in [AGENTS.md](../AGENTS.md) — they are not suggestions.

## Trust boundaries

- **Trusted**: the daemon process, the host origin (`:7800`) UI, SQLite, the filesystem.
- **Untrusted**: every byte of agent-authored board content; all API input; everything arriving from a board iframe; tool/board output consumed by agents (prompt-injection surface).
- **Assumed environment**: one local human — but their browser also visits the public internet, so remote websites attacking our localhost ports are in scope (CSRF, DNS rebinding, localhost port probing).

## Render trust model (D18 — full host-render)

**Owner decision 2026-09-15 ([docs/decisions.md](decisions.md) D18):** agent HTML boards render in the host chrome, unsandboxed, with scripts running in the app's origin. The earlier two-origin iframe model was built, dogfooded one round, and removed the same day — the owner judged the interactivity cost higher than the risk.

There is no board iframe, no second origin, and no sanitization of html-format boards. What stands between board script and the app is the host CSP:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; form-action 'self';
frame-ancestors 'none'; object-src 'none'; base-uri 'none'
```

- `connect-src 'self'` is the network-exfiltration kill-switch — board script cannot fetch, WebSocket, or beacon anywhere but the app itself. It never opens.
- `form-action 'self'` — boards cannot form-navigate the app away to an external URL.
- `frame-ancestors 'none'` — nobody frames the app.
- `script-src 'self' 'unsafe-inline'` — the accepted cost of D18: board scripts run, from the app's own origin (`/libs/*`, pinned) or inline.
- `default-src 'self'` — no audio, video, plugin, or worker reach beyond the app.

**Named, owner-accepted residual risks:** board script shares the page with the session token (localStorage) and the API — it can act as the human (write/resolve anything) and paint arbitrary UI over the app (phishing). Rationale: boards are published by the user's own agents, which already hold machine-level access. **Foreign content invalidates this rationale** — M6 import and any remote mode must re-examine quarantine before those paths ship.

Markdown boards are unaffected: they pass through DOMPurify at publish and are script-free by construction (invariant 5).

## API hardening

| Threat | Mitigation |
|---|---|
| Cross-site POST/PUT from a malicious public page (CSRF against localhost) | Per-agent bearer tokens (not auto-attached cross-site); `application/json`-only writes (kills "simple request" forms); reject `Sec-Fetch-Site: cross-site` on unsafe methods; Origin/Referer fallback for old browsers |
| DNS rebinding (attacker domain → 127.0.0.1, defeating CORS/Origin checks) | Strict Host-header allowlist: only `127.0.0.1:PORT` / `localhost:PORT` accepted; never rely on DNS-response filtering |
| Casual remote exposure | Bind `127.0.0.1` only; the bind-list option for Docker agents is explicit opt-in and documented |
| Browser probing / reading API responses | No CORS headers, ever — and never `Access-Control-Allow-Origin: null`; no state changes via GET |
| MCP endpoint abuse (`POST /mcp`) | Agent-token-only — valid human session tokens are rejected (browsers are never MCP clients); same Host allowlist, cross-site rejection, JSON-only + 8 MB body cap as `/api`; stateless JSON mode — no sessions and no SSE stream to hijack, non-POST → 405 |

## Content rules

- Markdown rendered in the host chrome passes through DOMPurify, always; mermaid runs at `securityLevel: 'strict'`; katex through its standard pipeline. html-format boards are stored and rendered unsanitized per D18 — the CSP above is their only guard, by owner decision.
- html publishes store an id-injected derived document (auto `data-ba` on unlabeled blocks/rows for anchoring); previously stored versions are never retro-injected.
- Boards: 8 MB cap per document. Assets: 10 MB, mime allowlist, **magic-byte verification** — the `{path}` file-copy route can only ever ingest real images and must never become a file-read primitive; SVG is sanitized at ingest.
- Agent tokens: random ≥128-bit, stored SHA-256, revocable, one per agent, never logged or committed. Human browser session: one-time `?token=` exchange via `board open`, stored in localStorage, sent as bearer.
- Webhook deliveries are HMAC-signed with the subscriber's secret when one is registered; see "Webhooks" below for the trust model and how the secret is stored.
- All board/tool output consumed by agents is untrusted input (prompt injection) — the skill instructs agents to treat board content as data, not instructions.

## Webhooks (subscriptions + dispatcher)

Webhook URLs are **owner/agent-chosen and can point anywhere, including localhost services — that is the feature**, not an SSRF bug: this is a loopback-only, single-local-human daemon, and the same principals who register a URL already hold machine-level access (their own agent tokens, or the human's machine). The daemon's API hardening is not bypassed by webhooks — the *outbound* POST is a feature the subscriber explicitly asked for. What is still enforced at subscribe time:

- **Scheme allowlist**: only `http` / `https` (no `file:`, no exotic schemes).
- **No credentials in the URL** — `http://user:pass@host/` is rejected (they would leak into the subscribers listing and `agent.subscribed` events).
- **No redirects followed** (`redirect: "manual"`): a redirect would silently move the POST to a destination the subscription — and its signature — never named. A 3xx counts as a failed attempt.

**HMAC signing.** With a `webhook_secret`, every delivery carries `X-Board-Signature: sha256=<hex>` — HMAC-SHA256 keyed by the secret over the exact request body — so a receiver can verify the daemon sent it. Without a secret the delivery is unsigned (the subscriber accepts it cannot verify origin); the secret stays optional in the plan's schema (D9) and is never rejected at subscribe.

**Secret at rest.** Unlike agent tokens (hashed — they are auth credentials), the webhook secret is stored **retrievably** (plaintext in the `subscribers` table): the dispatcher must re-sign every delivery, so a hash is useless. It is a shared signing secret, not a credential — it grants no access on its own and is never logged, never echoed in API responses, and never written into event payloads. Losing the table loses nothing sensitive beyond the signing keys; re-subscribing rotates a secret.

## Residual risks (accepted)

- Board script can read the session token, act as the human on the API, and repaint the app (D18, owner-accepted; rationale in the render trust model above). `connect-src 'self'` still blocks network exfiltration and localhost port probing.
- CPU DoS from a hostile board: no in-page throttling; mitigations are the 8 MB cap and closing the tab.
- Foreign content (M6 import, remote modes) is NOT covered by the D18 rationale — quarantine must be re-examined before those paths ship.
