#!/usr/bin/env bash
# board one-command bootstrap (D21, docs/decisions.md): prerequisites check,
# deps, web build, agent wiring. It never starts the shared daemon — session
# boards (`make up`) run with no daemon; `make serve` is the optional
# persistent library, not a setup step.

set -euo pipefail

# run from the repo root regardless of the caller's cwd
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# set -e alone would exit silently mid-script; name the failing step instead.
# Every step is idempotent, so the honest failure message is: fix and re-run.
STEP="unknown"
trap 'rc=$?; echo; echo "board: setup FAILED at step: ${STEP} (exit ${rc}) — fix the error printed above and re-run; every step is safe to re-run." >&2' ERR

step() {
    STEP="$1"
    echo
    echo "== ${STEP} =="
}

# prerequisites: bun on PATH. Not auto-installed — installing a toolchain out
# of a setup script is too aggressive; the human decides how bun arrives.
step "prerequisites: bun"
if ! command -v bun >/dev/null 2>&1; then
    echo "board: bun is not on your PATH."
    echo "  install it with:  curl -fsSL https://bun.sh/install | bash"
    echo "  https://bun.sh — then open a fresh shell and re-run ./scripts/setup.sh"
    exit 1
fi
echo "bun $(bun --version) found."

step "step 1/3: dependencies (make deps)"
make deps

# required: a fresh clone has no web/dist and the UI would 404 (web_not_built)
step "step 2/3: web app (make web)"
make web

# --force is deliberate: it re-mints each agent's token so re-runs keep exactly
# ONE live token per agent (old credential revoked, fresh plaintext lands under
# the next suffix — D17); a plain re-run would stack zombie tokens. install
# prints each plaintext token exactly once — this script never captures or
# echoes tokens (token hygiene, invariant 7).
step "step 3/3: agent wiring (make install FLAGS=--force)"
make install FLAGS=--force

echo
echo "== setup complete =="
echo "what just happened:"
echo "  - dependencies built (bun workspaces: server, cli, web)"
echo "  - web app built to web/dist (the UI boards render in)"
echo "  - agents wired: board MCP server + skill + one live token each"
echo "    (opencode / claude code — if a CLI was missing, its manual wiring"
echo "    instructions are in the output above; codex/pi get a TOML snippet)"
echo
echo "note: re-running setup rotates agent tokens — previous ones are revoked."
echo
echo "next: restart your opencode/claude session, then say:"
echo '  "spin up a board"'
echo "the agent will start a session board and hand you a link (no server needed)."
echo
echo "optional: want a persistent board library (browse/reuse boards across tasks)?"
echo "  make serve    # foreground daemon — or the systemd unit in docs/deployment.md"
echo "  make open     # then verify: the board list should load"
