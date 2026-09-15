.PHONY: deps install test typecheck lint serve dev token web open

deps:
	bun install

# wire the board MCP server into local agents + mint per-agent tokens.
# GNU make eats dash-flags, so for --force run `bun run cli/src/main.ts install --force`.
install:
	bun run cli/src/main.ts install $(filter-out $@,$(MAKECMDGOALS))

test:
	bun test

typecheck:
	bunx tsc --noEmit

lint:
	bunx biome check --write .

serve:
	bun run server/src/main.ts

# daemon + vite dev server concurrently; kill 0 makes Ctrl-C take both down.
# daemon-only (with a note) until the web workspace lands.
dev:
	@trap 'kill 0' INT TERM; \
	bun --watch server/src/main.ts & \
	if [ -f web/package.json ]; then \
	  (cd web && bunx vite --host 127.0.0.1 --port 5173) & \
	else \
	  echo "board: web/ not present yet; daemon only (vite dev server skipped)" >&2; \
	fi; \
	wait

# `make token add myagent` — pass-through args (plan.md: make token add|list| revoke AGENT)
token:
	bun run cli/src/main.ts token $(filter-out $@,$(MAKECMDGOALS))
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
