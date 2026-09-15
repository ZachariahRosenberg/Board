.PHONY: install test typecheck lint serve dev token

install:
	bun install

test:
	bun test

typecheck:
	bunx tsc --noEmit

lint:
	bunx biome check --write .

serve:
	bun run server/src/main.ts

dev:
	bun --watch server/src/main.ts

# `make token add myagent` — pass-through args (plan.md: make token add|list| revoke AGENT)
token:
	bun run cli/src/main.ts token $(filter-out $@,$(MAKECMDGOALS))
%:
	@:
