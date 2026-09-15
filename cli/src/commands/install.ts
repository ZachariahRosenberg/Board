import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyEdits,
  modify,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import {
  type CreatedToken,
  createToken,
  listTokens,
  revokeToken,
  TokenNameTaken,
} from "../../../server/src/tokens.ts";
import type { CommandIo } from "./token.ts";

export const BOARD_MCP_URL = "http://127.0.0.1:7800/mcp";
const BOARD_HEALTH_URL = "http://127.0.0.1:7800/api/health";
export const INSTALL_USAGE =
  "usage: board install [--agents opencode,claude,codex,pi] [--force]";

const AGENTS = ["opencode", "claude", "codex", "pi"] as const;
type Agent = (typeof AGENTS)[number];

const DEFAULT_AGENTS: Agent[] = ["opencode", "claude"];

interface InstallArgs {
  agents: Agent[];
  force: boolean;
}

interface InstallCommandInput {
  db: Database;
  argv: string[];
  io: CommandIo;
  // Seams (open.ts pattern): tests inject fakes so nothing touches the
  // network or the real claude CLI.
  checkHealth?: () => boolean;
  claudeOnPath?: () => boolean;
  runClaude?: (args: string[]) => number;
}

export function parseInstallArgs(argv: string[]): InstallArgs | string {
  let agents: Agent[] = [...DEFAULT_AGENTS];
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    const raw =
      arg === "--agents"
        ? argv[i + 1]
        : arg?.startsWith("--agents=")
          ? arg.slice("--agents=".length)
          : undefined;
    if (arg === "--agents" || arg?.startsWith("--agents=")) {
      i++;
      if (raw === undefined || raw.length === 0) {
        return "--agents needs a comma-separated list";
      }
      agents = [];
      for (const part of raw.split(",")) {
        const name = part.trim();
        if (!(AGENTS as readonly string[]).includes(name)) {
          return `unknown agent "${name}" (known: ${AGENTS.join(", ")})`;
        }
        if (!agents.includes(name as Agent)) {
          agents.push(name as Agent);
        }
      }
      if (agents.length === 0) {
        return "--agents needs at least one agent";
      }
      continue;
    }
    return `unknown argument "${arg}"`;
  }
  return { agents, force };
}

// Sync probe via a spawned bun fetch (open.ts's spawnXdgOpen pattern) — keeps
// the whole command synchronous. Any failure means "not reachable", which only
// downgrades UX: install continues.
function defaultCheckHealth(): boolean {
  try {
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        "const r = await fetch(process.env.BOARD_HEALTH_URL, { signal: AbortSignal.timeout(2000) }).catch(() => null); process.exit(r?.ok ? 0 : 1);",
      ],
      {
        env: { ...process.env, BOARD_HEALTH_URL: BOARD_HEALTH_URL },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

function defaultClaudeOnPath(): boolean {
  return Bun.which("claude") !== null;
}

function defaultRunClaude(args: string[]): number {
  const proc = Bun.spawnSync(["claude", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

const REPO_SKILL = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "skills",
  "board",
  "SKILL.md",
);

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim().length > 0) {
    return xdg;
  }
  return join(homedir(), ".config");
}

// os.homedir() caches and ignores a live HOME change (bun/node), so read $HOME
// directly — tests redirect it, and POSIX shells always set it.
function homeDir(): string {
  const home = process.env.HOME;
  if (home !== undefined && home.trim().length > 0) {
    return home;
  }
  return homedir();
}

function copySkill(dest: string, io: CommandIo): boolean {
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(REPO_SKILL, dest);
    io.stdout(`skill: ${dest}`);
    return true;
  } catch (err) {
    io.stderr(
      `board: could not copy the board skill to ${dest} (${err instanceof Error ? err.message : String(err)}); copy ${REPO_SKILL} there manually`,
    );
    return false;
  }
}

export class OpencodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeConfigError";
  }
}

interface BoardMcpEntry {
  type: "remote";
  url: string;
  enabled: boolean;
  headers: { Authorization: string };
}

// Comment-preserving merge into opencode.jsonc: modify computes a surgical
// edit at ["mcp", "board"], so unrelated keys and comments survive verbatim.
export function mergeOpencodeConfig(
  text: string,
  entry: BoardMcpEntry,
): string {
  if (text.trim().length === 0) {
    return `${JSON.stringify({ mcp: { board: entry } }, null, 2)}\n`;
  }
  const errors: ParseError[] = [];
  parseTree(text, errors);
  if (errors.length > 0) {
    throw new OpencodeConfigError(
      `not valid JSONC (${errors.map((e) => printParseErrorCode(e.error)).join(", ")})`,
    );
  }
  const edits = modify(text, ["mcp", "board"], entry, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      insertFinalNewline: true,
    },
  });
  return applyEdits(text, edits);
}

function manualHeader(agent: Agent): string {
  return `Authorization: Bearer <board-${agent}-token> (replace with the token printed above)`;
}

function wireOpencode(token: string, io: CommandIo): boolean {
  const configPath = join(configHome(), "opencode", "opencode.jsonc");
  const skillDest = join(
    configHome(),
    "opencode",
    "skills",
    "board",
    "SKILL.md",
  );
  const entry: BoardMcpEntry = {
    type: "remote",
    url: BOARD_MCP_URL,
    enabled: true,
    headers: { Authorization: `Bearer ${token}` },
  };
  let ok = true;
  try {
    const existing = existsSync(configPath)
      ? readFileSync(configPath, "utf8")
      : "";
    const merged = mergeOpencodeConfig(existing, entry);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, merged);
    io.stdout(`wired: ${configPath}`);
  } catch (err) {
    ok = false;
    io.stderr(
      `board: could not merge the board MCP entry into ${configPath} (${err instanceof Error ? err.message : String(err)}); add it manually under "mcp":`,
    );
    io.stderr(`  "board": {`);
    io.stderr(`    "type": "remote",`);
    io.stderr(`    "url": "${BOARD_MCP_URL}",`);
    io.stderr(`    "enabled": true,`);
    io.stderr(
      `    "headers": { "Authorization": "Bearer <board-opencode-token>" }`,
    );
    io.stderr(`  }`);
    io.stderr(`  (${manualHeader("opencode")})`);
  }
  return copySkill(skillDest, io) && ok;
}

function printClaudeManual(io: CommandIo): void {
  io.stdout(
    "claude CLI not found on PATH or `claude mcp add` failed; add the board server manually:",
  );
  io.stdout(
    `  claude mcp add --transport http --scope user board ${BOARD_MCP_URL} --header "Authorization: Bearer <board-claude-token>"`,
  );
  io.stdout(
    "  (--scope user makes the server available in all projects; " +
      manualHeader("claude") +
      ")",
  );
}

function wireClaude(
  token: string,
  io: CommandIo,
  claudeOnPath: () => boolean,
  runClaude: (args: string[]) => number,
): boolean {
  let ok = true;
  if (claudeOnPath()) {
    const args = [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "board",
      BOARD_MCP_URL,
      "--header",
      `Authorization: Bearer ${token}`,
    ];
    try {
      if (runClaude(args) === 0) {
        io.stdout("wired: claude mcp (user scope)");
      } else {
        ok = false;
        printClaudeManual(io);
      }
    } catch {
      ok = false;
      printClaudeManual(io);
    }
  } else {
    // Guidance, not a failure: a machine without claude installed is fine.
    printClaudeManual(io);
  }
  return (
    copySkill(join(homeDir(), ".claude", "skills", "board", "SKILL.md"), io) &&
    ok
  );
}

function wireTomlAgent(agent: Agent, io: CommandIo): boolean {
  if (agent === "codex") {
    io.stdout(
      "no automated wiring for codex; add this to ~/.codex/config.toml (example, verify against your codex version):",
    );
  } else {
    io.stdout(
      "no automated wiring for pi; add an equivalent MCP server entry to your pi config (codex-style TOML example, verify against your version):",
    );
  }
  io.stdout(`  [mcp_servers.board]`);
  io.stdout(`  url = "${BOARD_MCP_URL}"`);
  io.stdout(
    `  http_headers = { "Authorization" = "Bearer <board-${agent}-token>" }`,
  );
  io.stdout(`  (${manualHeader(agent)})`);
  return copySkill(
    join(homeDir(), ".agents", "skills", "board", "SKILL.md"),
    io,
  );
}

function wireAgent(
  agent: Agent,
  token: string,
  io: CommandIo,
  claudeOnPath: () => boolean,
  runClaude: (args: string[]) => number,
): boolean {
  switch (agent) {
    case "opencode":
      return wireOpencode(token, io);
    case "claude":
      return wireClaude(token, io, claudeOnPath, runClaude);
    case "codex":
    case "pi":
      return wireTomlAgent(agent, io);
  }
}

function mintToken(
  db: Database,
  agent: Agent,
  force: boolean,
  io: CommandIo,
): CreatedToken | null {
  const name = `board-${agent}`;
  if (force) {
    const existing = listTokens(db).find((t) => t.name === name);
    if (existing !== undefined && existing.revoked_at === null) {
      revokeToken(db, name);
      io.stdout(`--force: revoked old token "${name}"`);
    }
    // tokens.name is the PRIMARY KEY, so even a revoked token keeps its name;
    // the fresh mint falls back to the first free suffix (board-<agent>-2 …)
    // — the suffix is the visible trace of the re-mint (D17).
    return firstFreeCreate(db, name);
  }
  try {
    return createToken(db, { name });
  } catch (err) {
    if (err instanceof TokenNameTaken) {
      // Without --force there is nothing to wire: the plaintext token is
      // gone (stored hashed, invariant 8), so re-minting is required. Give
      // the exact runnable commands — `make install --force` does NOT work
      // (GNU make eats dash-flags as its own options).
      io.stdout(
        `already installed for ${agent} — re-mint with: make install FLAGS=--force (or: bun run cli/src/main.ts install --force)`,
      );
      return null;
    }
    throw err;
  }
}

function firstFreeCreate(db: Database, name: string): CreatedToken {
  try {
    return createToken(db, { name });
  } catch (err) {
    if (!(err instanceof TokenNameTaken)) {
      throw err;
    }
  }
  for (let n = 2; n < 100; n++) {
    try {
      return createToken(db, { name: `${name}-${n}` });
    } catch (err) {
      if (!(err instanceof TokenNameTaken)) {
        throw err;
      }
    }
  }
  throw new Error(`no free token name under "${name}" (suffixes 2–99 taken)`);
}

export function runInstallCommand({
  db,
  argv,
  io,
  checkHealth = defaultCheckHealth,
  claudeOnPath = defaultClaudeOnPath,
  runClaude = defaultRunClaude,
}: InstallCommandInput): number {
  const parsed = parseInstallArgs(argv);
  if (typeof parsed === "string") {
    io.stderr(`board: ${parsed}`);
    io.stderr(INSTALL_USAGE);
    return 1;
  }
  const { agents, force } = parsed;
  if (!checkHealth()) {
    io.stderr(
      "board: warning: daemon not running — start it with `make serve` (continuing; agent configs can be written before first use)",
    );
  }
  const failed: Agent[] = [];
  for (const agent of agents) {
    io.stdout(`== ${agent} ==`);
    const token = mintToken(db, agent, force, io);
    if (token === null) {
      continue;
    }
    // Print-once discipline (invariant 8): the token is stored hashed, so
    // this is the only time the plaintext exists after the mint — if the
    // agent config is lost, the fix is a --force re-mint, not a re-show.
    io.stdout(
      `token for "${token.name}" (store it now — it is stored hashed and cannot be shown again):`,
    );
    io.stdout(token.token);
    if (!wireAgent(agent, token.token, io, claudeOnPath, runClaude)) {
      failed.push(agent);
    }
  }
  if (failed.length > 0) {
    io.stderr(
      `board: failed to wire: ${failed.join(", ")} — apply the manual steps printed above`,
    );
    return 1;
  }
  return 0;
}
