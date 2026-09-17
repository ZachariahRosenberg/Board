.PHONY: setup deps install test typecheck lint serve dev token web open list export import smoke up down instances

# `make setup` — one-command bootstrap (D21): bun check, deps, web build, agent
# wiring (`install FLAGS=--force`). Never starts the shared daemon: session
# boards (`make up`) run with no daemon; `make serve` is the optional library.
setup:
	bash scripts/setup.sh

deps:
	bun install

# wire the board MCP server into local agents + mint per-agent tokens.
# GNU make eats dash-flags as its own options, so --force goes through a
# variable: `make install FLAGS=--force`
install:
	bun run cli/src/main.ts install $(FLAGS)

test:
	bun test

# M7 final smoke: self-verifying end-to-end loop (two agents + a human) against
# a throwaway daemon — temp BOARD_DATA_DIR + scratch ports, never ~/.board/:7800
smoke:
	bun scripts/smoke.ts

typecheck:
	bunx tsc --noEmit

lint:
	bunx biome check --write .

serve:
	bun run server/src/main.ts

# daemon + vite dev server concurrently; kill 0 makes Ctrl-C take both down.
dev:
	@trap 'kill 0' INT TERM; \
	bun --watch server/src/main.ts & \
	if [ -f web/package.json ]; then \
	  (cd web && bunx vite --host 127.0.0.1 --port 5173) & \
	else \
	  echo "board: web/ not present yet; daemon only (vite dev server skipped)" >&2; \
	fi; \
	wait

# `make token add myagent` — pass-through args (plan.md: make token add|list| revoke AGENT);
# names are permanent (D17): adding a taken name fails — either mint a fresh name, or
# re-mint the taken one with `make token add <name> FLAGS=--force` (revokes the old
# credential, new plaintext lands under the first free suffix).
token:
	bun run cli/src/main.ts token $(filter-out $@,$(MAKECMDGOALS)) $(FLAGS)
%:
	@:

# build the SPA the daemon serves from web/dist on the host port
web:
	@if [ ! -f web/package.json ]; then \
	  echo "board: web/package.json not found; the web workspace is not present yet, nothing to build" >&2; \
	  exit 1; \
	fi
	cd web && bunx vite build

# `make open [ID]` — open the web UI in a browser via a one-time exchange token
open:
	bun run cli/src/main.ts open $(filter-out $@,$(MAKECMDGOALS))

# `make list` — boards with status/version/unresolved counts (needs a token:
# pass BOARD_TOKEN in the env or run the CLI directly with --token)
list:
	bun run cli/src/main.ts list $(filter-out $@,$(MAKECMDGOALS))

# `make export ID=<id> [file]` (or positional: `make export <id> [file]`) — save
# a board bundle as a zip (default <id>.zip)
export:
	bun run cli/src/main.ts export $(ID) $(filter-out $@,$(MAKECMDGOALS))

# `make import FILE=<bundle.zip>` (or positional) — recreate a board from a
# bundle under a fresh board id
import:
	bun run cli/src/main.ts import $(FILE) $(filter-out $@,$(MAKECMDGOALS))

# `make up [FILE=<md>] [TITLE="..."]` (or positional: `make up plan.md`) —
# spawn a session instance (D20); a FILE publishes as v1 and prints a one-time
# human link. Other flags ride FLAGS= (e.g. `make up FILE=plan.md
# FLAGS="--tags review --open"`) — per-flag vars would collide with ambient
# env (this box exports AGENT=1, which a $(AGENT:...) pass-through would eat).
up:
	bun run cli/src/main.ts up $(FILE) $(if $(TITLE),--title '$(TITLE)') $(FLAGS) $(filter-out $@,$(MAKECMDGOALS))

# `make down [ID=s-xxxx]` (or positional) — tear down a session instance
# ($BOARD_INSTANCE or id); --keep-data/--no-export via FLAGS=
down:
	bun run cli/src/main.ts down $(ID) $(filter-out $@,$(MAKECMDGOALS))

# `make instances` — live session instances; FLAGS=--all (closed) / --prune
instances:
	bun run cli/src/main.ts instances $(FLAGS) $(filter-out $@,$(MAKECMDGOALS))
