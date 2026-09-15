#!/usr/bin/env bun

import { loadConfig } from "../../server/src/config.ts";
import { openDb } from "../../server/src/db.ts";
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
  list                 (not yet implemented)
  open [board id]      open the web UI in a browser (one-time token)
  export               (not yet implemented)
  import               (not yet implemented)
  status               (not yet implemented)
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

export function main(argv: string[]): number {
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
    default:
      console.error(`board: unknown command "${command}"`);
      console.error(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
