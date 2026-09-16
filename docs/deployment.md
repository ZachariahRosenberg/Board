# Deployment

Installing, running, and supervising the daemon — on the host, under systemd, and in Docker — plus the agent-managed session instances (D20). The daemon is a **local-first, loopback-only** service for one human and their agents; nothing in this document changes that (invariant 1, [security.md](security.md)). Operations live in the Makefile (D10); this doc is the reference behind `make --help`.

## Install

```
make deps        # bun install (workspaces: server, cli, web)
make web         # build the SPA the daemon serves from web/dist (repeat after UI changes)
make install     # wire the board MCP server into local agents + mint their tokens
```

`make install` (→ `bun run cli/src/main.ts install`, flags via `make install FLAGS="--agents … --force"`):

- Probes `GET /api/health` first (a down daemon is a warning, not a failure).
- Mints one agent token per target agent, named `board-<agent>`. The plaintext is **printed once** — it is stored SHA-256 and cannot be shown again (invariant 7/8). Lost it? Re-mint.
- Wires **opencode**: comment-preserving merge of an `mcp.board` entry (remote, `http://127.0.0.1:7800/mcp`, bearer header) into `~/.config/opencode/opencode.jsonc`, plus the skill copied to `~/.config/opencode/skills/board/`.
- Wires **claude code**: `claude mcp add --transport http --scope user board http://127.0.0.1:7800/mcp --header "Authorization: Bearer …"` plus the skill at `~/.claude/skills/board/`.
- **codex / pi**: prints a TOML snippet to paste (no automated wiring) and copies the skill to `~/.agents/skills/board/`.
- `--force` re-mints a taken token name — names are permanent (D17): the old token is revoked and the fresh one lands under the first free suffix (`board-<agent>`, `board-<agent>-2`, …).

Tokens by hand (any agent, or scripts): `make token add <name>` (`board token add <name> [--force]`), `board token list`, `board token revoke <name>`. Minting is **CLI-only by design** — no API route ever creates or echoes a token.

## Run

| Command | What it does |
|---|---|
| `make serve` | foreground daemon: `bun run server/src/main.ts` — listens on `127.0.0.1:7800` |
| `make dev` | daemon (`bun --watch`) + vite dev server on `127.0.0.1:5173` (proxying `/api`, `/assets`, `/libs`); Ctrl-C takes both down |
| `bun run server/src/main.ts` | the daemon directly — `make serve` is exactly this |

- The daemon serves the **built** SPA from `web/dist`; without it, pages answer `404 web_not_built` (`make web`) while the API stays live. `make dev` bypasses the build with vite's dev server.
- One process, one port: the SPA, `/api/*` REST, `/mcp` (Streamable HTTP), `/api/stream` (SSE), `/assets/<id>`, and `/libs/*` vendored libraries ([architecture.md](architecture.md)).

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `BOARD_DATA_DIR` | `~/.board` | data directory (`~` expanded; relative paths resolve against cwd) |
| `BOARD_PORT` | `7800` | listen port (0–65535) |
| `BOARD_HOST` | `127.0.0.1` | **the** bind address. Loopback is invariant 1; changing it is the explicit, documented opt-out (see Docker below) |
| `BOARD_BIND` | `127.0.0.1` | comma list of **additional Host-header names to accept** — it does NOT add bind addresses. Use it so clients whose `Host` header is not loopback (e.g. `host.docker.internal`) pass the DNS-rebinding allowlist |
| `BOARD_SSE_HEARTBEAT_MS` | `25000` | SSE heartbeat interval (a test knob; leave alone in production) |

These are the **daemon's** variables. Two CLI-level variables are deliberately absent — they configure the `board` CLI, never the daemon: `BOARD_INSTANCE` (target a session instance instead of the shared daemon, [below](#session-instances-agent-managed)) and `BOARD_TOKEN` (the REST credential for `list`/`status`/`export`/`import`).

## The data directory

```
~/.board/                     BOARD_DATA_DIR (overridable)
  board.db                    SQLite (WAL): boards, versions, comments, events, tokens, subscribers, sessions
  board.db-wal/-shm           WAL sidecar files (part of the db — back them up together)
  events.jsonl                global append-only event log
  boards/<id>/                self-contained board bundle
    board.json                metadata snapshot
    versions/NNN.html         immutable documents (+ NNN.md source for markdown input)
    assets/<id>.<ext>         images
    events.jsonl              per-board event channel
```

SQLite is the queryable source of truth; the bundle mirrors exist so a board is one portable, greppable unit. Agents never write here — **all writes flow through the daemon's API** (invariant 3); the CLI's token/session commands are the human's sanctioned local exception.

**Backup story.** Two layers, use both:

- **Per board (portable):** `make export ID=<id>` — a self-contained zip (manifest, version sources, comments, assets, the board's events as an audit snapshot). `make import FILE=<id>.zip` recreates it — under a **new board id**, through the import quarantine ([security.md](security.md)). Export/import is the save/load-old-boards story, and works on ended boards.
- **Whole state (everything at once):** stop the daemon, copy the entire `BOARD_DATA_DIR` (db **with** its WAL sidecars, event logs, bundles), restart. A live copy of a WAL-mode SQLite file can be inconsistent — don't; a per-db `sqlite3 board.db ".backup '<dest>'"` is the in-place alternative for the db itself (bundles/logs still want the dir copy).

## Session instances (agent-managed)

D20 gives agents a task-scoped loop they own end to end: `board up` spawns a **throwaway loopback daemon** (an "instance"), the agent drives it over REST/CLI, `board down` tears it down with keepsakes. This is the one place an agent manages a daemon lifecycle — the shared `:7800` daemon and `~/.board` stay human-managed. Multiple instances may run concurrently; nothing about the shared daemon changes.

| Command | What it does |
|---|---|
| `board up [file] [--title T] [--format markdown\|html] [--tags a,b] [--agent NAME] [--resume[=latest\|all\|<instance-id>]] [--open]` | spawn a session instance; a file is published as v1 and a one-time human link printed (`--open` also xdg-opens it); `--resume` reimports a prior session's keepsake boards ([below](#resuming-a-prior-session-up---resume)) |
| `board down [<id>] [--instance <id>] [--keep-data] [--no-export]` | tear down: end open boards, keep zip keepsakes, stop the daemon, purge temp data + env file |
| `board instances [--all] [--prune]` | registry view — live by default, `--all` adds closed, `--prune` cleans stale entries |

Make wrappers (D10 pattern): `make up [FILE=<md>] [TITLE="…"] [FLAGS="…"]` (or positional `make up plan.md`), `make down [ID=s-xxxx] [FLAGS="…"]`, `make instances [FLAGS=--all|--prune]`. There are deliberately no per-flag vars (`TAGS=`, `AGENT=`, `OPEN=`) — they would collide with ambient environment variables; extra flags ride `FLAGS=`.

### What `up` prints and writes

- **Data dir:** always an OS-temp directory (`board-instance-*` under the system tmp), never under `~/.board`. **Port:** kernel-assigned (`BOARD_PORT=0`), so instances never collide with `:7800` or each other. **Bind + Host allowlist:** pinned to loopback over whatever `BOARD_HOST`/`BOARD_BIND` the invoking shell inherited (D20 boundary; invariant 1). **Child env:** scrubbed — every inherited `BOARD_*` key is stripped before the pins are applied, so a sourced previous-session env file cannot leak its live `BOARD_TOKEN` into the daemon's process environment.
- One agent token is minted **before** the daemon spawns (named by `--agent`, default `session`) and printed once — `instance.json` and `daemon.log` never see token material.
- A registry entry at `<BOARD_DATA_DIR>/instances/<id>/`:

```
~/.board/instances/s-<id>/   registry dir (the daemon's data dir is elsewhere, in OS temp)
  instance.json              id, pid, port, url, dataDir, agentTokenName, createdAt
                             (+ closedAt, boards at teardown) — never token plaintext
  env                        mode 0600: export BOARD_INSTANCE=<id> BOARD_PORT=<port>
                             BOARD_TOKEN=<token> — sourceable; purged at down
  daemon.log                 both daemon streams, for post-mortem
  boards/                    keepsake zips, written at teardown
```

- With a file argument, `up` creates and publishes the board over REST and prints a one-time human exchange link (`http://127.0.0.1:<port>/?token=<ex>#/boards/<id>`) — the same session-exchange model as `board open`. When `web/dist` is missing it warns (the link would 404 the UI until `make web`; the API half still works).
- `up` self-heals the registry: stale (dead-pid) entries are pruned first, keepsakes included; aged `boot-orphan` entries (an `up` killed mid-boot) are reaped the same way, young `booting` ones are left alone (another shell may still be starting one); corrupt entries — a `dataDir` outside the OS-temp `board-instance-*` shape — are reported, never acted on.

The printed output:

```
$ board up plan.md
instance s-AbCdEfGhIj listening on http://127.0.0.1:43211
agent token (print once — it is not recoverable): <token>
credentials env file (agent shells: source it): /home/you/.board/instances/s-AbCdEfGhIj/env
human link: http://127.0.0.1:43211/?token=<ex>#/boards/<board_id>
tear down with: board down s-AbCdEfGhIj
```

### The env-file workflow

Source the env file in the shell that owns the task, then drive the instance over REST:

```sh
source /home/you/.board/instances/s-AbCdEfGhIj/env
curl -s -H "authorization: Bearer $BOARD_TOKEN" -H 'content-type: application/json' \
  -d '{"format":"markdown","content":"…revised…","expected_version":1}' \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/publish"
curl -s -H "authorization: Bearer $BOARD_TOKEN" \
  "http://127.0.0.1:${BOARD_PORT}/api/boards/<board_id>/comments?since=0"
```

The env file is the session-credential *delivery* artifact (D20) — mode 0600, the analogue of the human's localStorage bearer, never logged or committed, deleted by `down`/prune. Invariant 7 is untouched: every db stores only hashes.

### `down` semantics

- **Target resolution:** `--instance <id>` flag > id argument > `$BOARD_INSTANCE` > error listing the live ids.
- **Pid identity before any signal:** `/proc/<pid>/cmdline` must match the server entry and the readable environ must carry the instance's `BOARD_DATA_DIR` — re-verified immediately before the signal itself (the check reruns after the REST export phase, shrinking the pid-recycle race to microseconds), and an unreadable environ fails closed. A pid that is alive but is not this daemon is refused outright: never signalled, and never sent credentials.
- **Structural guard:** the entry's `dataDir` must be an OS-temp `board-instance-*` dir — a corrupt or crafted `instance.json` can falsify a pid, but not filesystem shape, so `down` refuses to signal or purge anything outside it (exit 1, nothing touched). Registry ids are shape-checked (`s-<10 alphanumerics>`) before any path use.
- **Alive:** open boards are ended over REST (already-ended 409s tolerated), each board is exported to `boards/<board_id>.zip`, then SIGTERM with an ≤8 s liveness poll, then SIGKILL. **Dead:** the same zips are built straight from the on-disk bundles (a dead single writer's WAL replays safely).
- The temp data dir is purged unless `--keep-data`; the env file is deleted **always** — the credential dies with the session even when the data is kept; `closedAt` + the kept board ids are stamped on `instance.json`. `down` on an already-closed instance is a no-op.
- **Interrupted boots:** SIGINT/SIGTERM during `up`'s boot window clean up everything (no daemon, no dirs, exit 130/143). A SIGKILLed `up` leaves a `booting` registry entry — recover with `board down <id>` (the entry already carries the pid + dataDir teardown needs).

### Closed and stale instances

- `board instances` derives liveness at read time from pid identity — never a stored status (statuses: `live`, `stale`, `booting` / `boot-orphan` — a boot entry older than the boot grace window, reapable with `down` or `--prune` — and `closed`). A stale entry is reported with a `--prune` hint.
- `list`, `open`, `export`, `import`, `status`, and `token add|list|revoke` accept `--instance <id>` (or `BOARD_INSTANCE`) and target that instance's daemon/db; REST against a closed/stale instance fails with a pointer to closed-instance export; `open` needs the live daemon (nothing serves the human link otherwise). A registry url whose host is not loopback is refused before any credential is sent — the same no-workaround-hint refusal as a foreign pid.
- `board export --instance <id> <board_id>` works on a **closed** instance: it zips the kept data dir's bundle to `./<board_id>.zip` — the same convention as a live export. If the data dir was purged, the error points at the `boards/` keepsake zips.
- Credential precedence for instance-targeted REST: `--token` > `BOARD_TOKEN` > the instance env file.

### Keepsakes

After `down`, the registry dir keeps `instance.json` (the audit record), `daemon.log`, and `boards/*.zip` — `make import`-compatible bundles, and the substrate `board up --resume` rehydrates ([below](#resuming-a-prior-session-up---resume)). In-flight webhook deliveries may be dropped at teardown; cursor polling (D15) is the reliable consumption path for sessions.

### Resuming a prior session (`up --resume`)

The keepsake zips are the session-continuity story (D20; owner green-light 2026-09-16 on the dogfood board): `board up --resume` reimports a prior session's boards into the fresh instance — "continue where I left off" without hand-running `make import` per zip.

- **Flag forms:** `--resume` (bare) ≡ `--resume=latest` — the most recent closed instance that has ≥1 keepsake zip. `--resume=all` — every prior instance's zips. `--resume=<instance-id>` — only that instance's zips. Via make: `make up FLAGS="--resume=latest"` — there is no dedicated make variable; `FLAGS` rides the existing `up` target exactly as `down`'s flags do. (Use the `=` form; bare `--resume` means latest anywhere among the flags.)
- **Discovery:** the registry is scanned for `instances/<id>/boards/*.zip` — **the zips on disk are the truth**; a drifted `boards` stamp in `instance.json` is ignored. "Most recent" = the greatest `closedAt` in `instance.json`, falling back to the registry dir's mtime when the stamp is absent. The instance being created is skipped, and live instances have no zips by construction (keepsakes are written at teardown).
- **Mechanics:** one `POST /api/boards/import` per zip against the NEW instance's daemon, authenticated with the freshly minted agent token — the same request `board import` builds, with import semantics unchanged (the M6 import quarantine re-runs).
- **New-id rule:** import always mints a NEW board id ([security.md](security.md) "Import quarantine"), so a resume is a fresh **copy**, never a moved board. Resumed ids never match the originals — do not expect id stability across resumes — and because the zips persist after `down`, `--resume=<id>` works repeatedly: each resume produces fresh copies with fresh ids.
- **Ordering:** with a file argument, the file board is published FIRST (it is the primary), then the resume imports; both finish before `up` prints its summary.
- **Output:** one line per resumed board — `resumed N board(s) from <instance-id>: <new-id> — "<title>"` (N counts the boards resumed from that instance) — plus a hint line per board, `hint: board open --instance <up-instance-id> <board-id>`, which is how the agent mints the human link for a resumed board.
- **Failure tolerance:** a zip that fails import (e.g. a 422 quarantine rejection on a corrupt keepsake) prints a notice per failure and the remaining zips still import; `up` still exits 0 — a bad keepsake must not break the new session it is resurrected into. With nothing discoverable, `up` prints `no previous session boards to resume` and continues normally (a `--resume=<unknown-id>` behaves the same, naming the id); only a malformed id value (`--resume=…` that is neither `latest`, `all`, nor `s-<10 alphanumerics>`) is a usage error before anything spawns.

**Boundaries (D20).** Loopback bind + Host allowlist are pinned at spawn and cannot be widened by inherited env (the child env is scrubbed of every `BOARD_*` key); instance data is always OS-temp, and teardown purges only dirs of that shape — signals go only to pid-verified processes, re-checked at signal time; the 0600 env file is the one sanctioned ephemeral credential-delivery artifact. The shared daemon and persistent `~/.board` remain human-managed.

## Supervised running (systemd, user unit)

The daemon is an always-on user service. `~/.config/systemd/user/board.service`:

```ini
[Unit]
Description=board daemon — loopback shared boards
After=network.target

[Service]
WorkingDirectory=%h/geek/board
ExecStart=%h/.bun/bin/bun %h/geek/board/server/src/main.ts
Environment=BOARD_DATA_DIR=%h/.board
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now board
loginctl enable-linger $USER   # keep it running after logout (it is meant to be always-on)
```

No `BOARD_HOST` override — the default loopback bind is the invariant doing its work. A tmux `make serve` is the informal alternative. This daemon has no auto-spawn magic (D10, D14: agents detect a down daemon via `board_status` and ask you to restart it) — the shared daemon and the persistent data dir stay human-managed. The one agent-managed exception is a throwaway session instance (D20, [above](#session-instances-agent-managed)).

## Docker

The image builds the SPA, runs the daemon as non-root, and keeps all state in a volume. The Dockerfile is multi-stage (deps → web build → prod deps → runtime), bases on `oven/bun`, and bakes **no token** — credentials are minted inside the running container (below).

```
docker build -t board .
```

### The loopback tension — read before you run

Invariant 1 binds `127.0.0.1` only. In a container, `127.0.0.1` is the **container's** loopback, so two supported run forms exist and nothing else:

- **Published port** — `docker run -e BOARD_HOST=0.0.0.0 -p 127.0.0.1:7800:7800 board`. Inside the container the daemon binds all interfaces (`BOARD_HOST=0.0.0.0` — necessary, or the docker proxy cannot reach it), but the **publish form is what holds the security line**: `-p 127.0.0.1:7800:7800` maps host loopback to container loopback-facing port, so only the host's own users reach the daemon. The Host-header allowlist and every other hardening layer still apply to each request.
- **`--network host`** — `docker run --network host board` (Linux). No network namespace: the container's `127.0.0.1` **is** the host's loopback, the default `BOARD_HOST=127.0.0.1` is correct as-is, and invariant 1 holds literally.

**Never `-p 7800:7800`.** It publishes on every host interface and exposes the daemon to the network — the one misconfiguration this doc exists to prevent. The daemon is never to be exposed beyond the host; there is no remote mode (ngrok etc. are unshipped and would be re-examined before shipping, [security.md](security.md)).

Agents in *other* containers reaching the daemon over the docker network pass through the Host-header allowlist only if you add their hostname: `-e BOARD_BIND=host.docker.internal` (plus `extra_hosts: ["host.docker.internal:host-gateway"]` on their side). Alternatively, volume-mount the data dir into the agent container and tail `boards/<id>/events.jsonl` — no network at all.

### Data

`ENV BOARD_DATA_DIR=/data` and `VOLUME /data` are baked in; keep state on a volume or bind mount:

```
docker run -e BOARD_HOST=0.0.0.0 -p 127.0.0.1:7800:7800 -v board-data:/data board
```

Backups are unchanged: `make export` per board (against the published port), or stop the container and copy the volume.

### Tokens (minting inside the container)

No credential is baked into the image. Mint inside the running container — the exec inherits `BOARD_DATA_DIR=/data` and the `bun` user's write access:

```
docker exec board bun cli/src/main.ts token add <name>          # print-once plaintext
docker exec board bun cli/src/main.ts token list
docker exec board bun cli/src/main.ts token revoke <name>
```

(the `make token add <name>`-equivalent; names are permanent — `--force` re-mints under a suffixed name, D17). Point host-side agent configs at the published port with the minted token — `make install` itself is a host-side flow (it writes per-agent configs under the *executing* user's home, so run it on the host, not via exec).

### Health

The image's `HEALTHCHECK` polls `GET /api/health` (the daemon's one unauthenticated route, `{ok: true}`) every 30 s via `bun -e`; `docker inspect` / `docker ps` report it. The same endpoint is what `make install` probes and what agents should treat as the daemon-liveness signal (D14).
