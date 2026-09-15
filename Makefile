.PHONY: install test typecheck lint serve dev

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
