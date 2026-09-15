import type { Database } from "bun:sqlite";
import type { Config } from "../../../server/src/config.ts";
import { originUrlFor } from "../../../server/src/daemon.ts";
import { createExchangeToken } from "../../../server/src/sessions.ts";
import type { CommandIo } from "./token.ts";

type OpenUrl = (url: string, io: CommandIo) => void;

interface OpenCommandInput {
  db: Database;
  argv: string[];
  config: Config;
  io: CommandIo;
  // Seam: tests inject a recorder; the default spawns xdg-open.
  openUrl?: OpenUrl;
}

// xdg-open can be absent (headless boxes) or fail (no default browser). The
// URL is printed either way, so a failed spawn only downgrades UX — never the
// exit status.
function spawnXdgOpen(url: string): boolean {
  try {
    const proc = Bun.spawnSync(["xdg-open", url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function defaultOpener(url: string, io: CommandIo): void {
  if (!spawnXdgOpen(url)) {
    io.stderr("board: xdg-open failed; open the printed URL in a browser");
  }
}

function boardOpenUrl(
  config: Config,
  exchangeToken: string,
  boardId?: string,
): string {
  const base = `${originUrlFor(config.host, config.port)}/?token=${exchangeToken}`;
  return boardId === undefined ? base : `${base}#/boards/${boardId}`;
}

export function runOpenCommand({
  db,
  argv,
  config,
  io,
  openUrl = defaultOpener,
}: OpenCommandInput): number {
  const [first] = argv;
  const boardId = first !== undefined && first.length > 0 ? first : undefined;
  // docs/security.md: a one-time exchange token rides the URL; the SPA swaps
  // it for a localStorage session bearer via POST /api/session/exchange.
  const exchangeToken = createExchangeToken(db, boardId);
  const url = boardOpenUrl(config, exchangeToken, boardId);
  io.stdout(url);
  openUrl(url, io);
  return 0;
}
