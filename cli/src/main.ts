#!/usr/bin/env bun

import { loadConfig } from "../../server/src/config.ts";
import { openDb } from "../../server/src/db.ts";
import { runBoardsCommand } from "./commands/boards.ts";
import {
  INSTALL_USAGE,
  parseInstallArgs,
  runInstallCommand,
} from "./commands/install.ts";
import { runOpenCommand } from "./commands/open.ts";
import { runServe } from "./commands/serve.ts";
import {
  type CommandIo,
  runTokenCommand,
  TOKEN_USAGE,
} from "./commands/token.ts";

const USAGE = `board — local-first shared boards

usage: board <command> [args]

commands:
  serve                run the board daemon (loopback only)
  token add <name>     create an agent token; printed once, never recoverable
  token list           list tokens: name, created, last used, revoked
  token revoke <name>  revoke an agent token
  install              wire the board MCP server into local agents (mints tokens)
  list                 list boards: status, current version, unresolved comments
  open [board id]      open the web UI in a browser (one-time token)
  export <id> [file]   save a board bundle as a zip (default <id>.zip)
  import <file>        recreate a board from a bundle under a fresh board id
  status               (not yet implemented)

REST commands (list/export/import) authenticate with --token <token> or
BOARD_TOKEN; mint one with: make token add cli
`;

export function usage(): string {
  return USAGE;
}

function consoleIo(): CommandIo {
  return {
    stdout: (text) => {
      console.log(text);
    },
    stderr: (text) => {
      console.error(text);
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    case "serve":
      runServe();
      return 0;
    case "token": {
      // Validate before opening the db: usage-error paths must not create the
      // data dir (twice-bitten footgun — an empty ~/.board from `make token`).
      const [sub] = rest;
      if (sub !== "add" && sub !== "list" && sub !== "revoke") {
        console.error(TOKEN_USAGE);
        return 1;
      }
      // Invariant 4 bars agents from writing ~/.board directly; this CLI is the human's local tool, so opening the db here is the sanctioned path.
      const config = loadConfig();
      const db = openDb(config.dataDir);
      try {
        return runTokenCommand({ db, argv: rest, io: consoleIo() });
      } finally {
        db.close();
      }
    }
    case "install": {
      // Validate before opening the db: usage-error paths must not create the
      // data dir (same footgun as `token`). runInstallCommand re-parses its
      // argv so tests can drive it standalone; the parse is cheap.
      if (typeof parseInstallArgs(rest) === "string") {
        console.error(INSTALL_USAGE);
        return 1;
      }
      // Same sanctioned local-db path as token: the human's tool.
      const config = loadConfig();
      const db = openDb(config.dataDir);
      try {
        return runInstallCommand({ db, argv: rest, io: consoleIo() });
      } finally {
        db.close();
      }
    }
    case "open": {
      // Same sanctioned local-db path as token: the human's tool.
      const config = loadConfig();
      const db = openDb(config.dataDir);
      try {
        return runOpenCommand({
          db,
          argv: rest,
          config,
          io: consoleIo(),
        });
      } finally {
        db.close();
      }
    }
    case "list":
    case "export":
    case "import": {
      // REST against the live daemon — deliberately no local db here: import
      // is a write and every write goes through the daemon API (invariant 3).
      return await runBoardsCommand(command, {
        config: loadConfig(),
        argv: rest,
        io: consoleIo(),
      });
    }
    default:
      console.error(`board: unknown command "${command}"`);
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
