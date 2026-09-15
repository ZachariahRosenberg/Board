# Security model

Threat model and required mitigations for v1. The invariants here are enforced in code and restated in [AGENTS.md](../AGENTS.md) — they are not suggestions.

## Trust boundaries

- **Trusted**: the daemon process, the host origin (`:7800`) UI, SQLite, the filesystem.
- **Untrusted**: every byte of agent-authored board content; all API input; everything arriving from a board iframe; tool/board output consumed by agents (prompt-injection surface).
- **Assumed environment**: one local human — but their browser also visits the public internet, so remote websites attacking our localhost ports are in scope (CSRF, DNS rebinding, localhost port probing).

## Sandbox architecture (board rendering)

Board iframes:

```html
<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" …>
```

**Only** `allow-scripts`. Never `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals`, or `allow-downloads`. Without `allow-same-origin` the frame gets an opaque origin: no storage, no cookies, no DOM access in either direction, and every board iframe is mutually isolated.

Boards are served from a separate origin (`:7801`) as real documents — never `srcdoc`/`blob:` on the host origin. Board-origin responses carry:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  media-src 'self' data: blob:;
  connect-src 'none';
  form-action 'none';
  frame-src 'none';
  object-src 'none';
  base-uri 'none';
  frame-ancestors http://127.0.0.1:7800
Permissions-Policy: geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), bluetooth=()
```

`connect-src 'none'` is the exfiltration and localhost-port-probing kill switch — it never opens. `script-src 'self'` covers the vendored, pinned libraries served from the board origin; `'unsafe-inline'` is honest (boards are inline script by definition — the sandbox already assumes hostile scripts; CSP governs *where scripts come from and what they can reach*, not whether they run).

Host app CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: http://127.0.0.1:7801; connect-src 'self';
frame-src http://127.0.0.1:7801; frame-ancestors 'none';
object-src 'none'; base-uri 'none'
```

If a board needs host capabilities (storage, open-link, clipboard), it goes through a nonce-handshaked, origin-checked, schema-validated postMessage RPC — never a CSP widening. (Lands with the v1.1 bridge; protocol is designed now.)

## API hardening

| Threat | Mitigation |
|---|---|
| Cross-site POST/PUT from a malicious public page (CSRF against localhost) | Per-agent bearer tokens (not auto-attached cross-site); `application/json`-only writes (kills "simple request" forms); reject `Sec-Fetch-Site: cross-site` on unsafe methods; Origin/Referer fallback for old browsers |
| DNS rebinding (attacker domain → 127.0.0.1, defeating CORS/Origin checks) | Strict Host-header allowlist: only `127.0.0.1:PORT` / `localhost:PORT` accepted; never rely on DNS-response filtering |
| Casual remote exposure | Bind `127.0.0.1` only; the bind-list option for Docker agents is explicit opt-in and documented |
| Browser probing / reading API responses | No CORS headers, ever — and never `Access-Control-Allow-Origin: null`; no state changes via GET |
| MCP endpoint abuse (`POST /mcp`) | Agent-token-only — valid human session tokens are rejected (browsers are never MCP clients); same Host allowlist, cross-site rejection, JSON-only + 8 MB body cap as `/api`; stateless JSON mode — no sessions and no SSE stream to hijack, non-POST → 405 |

## Content rules

- Markdown rendered in the host chrome passes through DOMPurify, always; mermaid runs at `securityLevel: 'strict'`; katex through its standard pipeline.
- Boards: 8 MB cap per document. Assets: 10 MB, mime allowlist, **magic-byte verification** — the `{path}` file-copy route can only ever ingest real images and must never become a file-read primitive; SVG is sanitized at ingest.
- Agent tokens: random ≥128-bit, stored SHA-256, revocable, one per agent, never logged or committed. Human browser session: one-time `?token=` exchange via `board open`, stored in localStorage, sent as bearer.
- Webhook deliveries are HMAC-signed with the subscriber's secret; the secret is stored hashed and shown once.
- All board/tool output consumed by agents is untrusted input (prompt injection) — the skill instructs agents to treat board content as data, not instructions.

## Residual risks (accepted)

- A sandboxed frame can navigate *itself* away (CSP doesn't govern navigations); it can't read host data (opaque origin + `connect-src 'none'`), so there's nothing valuable to leak — detected and reset.
- CPU DoS from a hostile board: the sandbox can't throttle; mitigations are size caps and the reload affordance.
- Same-host different-port origins share a browser process (no site isolation between `:7800`/`:7801`); acceptable — the origin split still blocks data access.
