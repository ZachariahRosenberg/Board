// `board up / down / instances` (D20): the agent-managed session loop — spawn
// a throwaway loopback daemon, optionally publish a first board, share a
// one-time human link, tear down with keepsake zips. All spawn/readiness/
// teardown mechanics live in cli/src/instances.ts; this file is argv parsing
// and printed UX.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "../../../server/src/config.ts";
import { resolveWebDist } from "../../../server/src/daemon.ts";
import { openDb } from "../../../server/src/db.ts";
import { createExchangeToken } from "../../../server/src/sessions.ts";
import {
  BOOT_GRACE_MS,
  countBoardsOnDisk,
  humanLink,
  instancePaths,
  instancesRoot,
  listRegistryEntries,
  PidForeignError,
  pidIdentity,
  plausibleId,
  pruneStaleInstances,
  type ReadyInstanceEntry,
  readInstanceEntry,
  spawnInstance,
  teardownInstance,
} from "../instances.ts";
import { renderTable } from "../table.ts";
import { defaultOpener, type OpenUrl } from "./open.ts";
import { scan } from "./rest.ts";
import type { CommandIo } from "./token.ts";

export const INSTANCES_USAGE = `usage: board up [file] [--title T] [--format markdown|html] [--tags a,b] [--agent NAME] [--open]
       board down [<id>] [--instance <id>] [--keep-data] [--no-export]
       board instances [--all] [--prune]`;

interface InstancesCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a recorder; the default spawns xdg-open (open.ts).
  openUrl?: OpenUrl;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function argError(io: CommandIo, message: string): number {
  io.stderr(`board: ${message}`);
  io.stderr(INSTANCES_USAGE);
  return 1;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

type Format = "markdown" | "html";

async function restJson<T>(
  method: "GET" | "POST",
  url: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${method} ${url}: ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as T;
}

interface UpArgs {
  file?: string;
  title?: string;
  format?: string;
  tags: string[];
  agent: string;
  open: boolean;
}

function parseUpArgs(argv: string[]): UpArgs | string {
  const scanned = scan(
    argv,
    ["--title", "--format", "--tags", "--agent"],
    ["--open"],
  );
  if (typeof scanned === "string") {
    return scanned;
  }
  if (scanned.positional.length > 1) {
    return "up takes at most one file";
  }
  return {
    file: scanned.positional[0],
    title: scanned.values.get("title"),
    format: scanned.values.get("format"),
    tags: scanned.values.has("tags")
      ? parseTags(scanned.values.get("tags") ?? "")
      : [],
    agent: scanned.values.get("agent") ?? "session",
    open: scanned.bools.has("open"),
  };
}

interface PublishInput {
  content: string;
  title: string;
  format: Format;
  tags: string[];
}

async function runUp(input: InstancesCommandInput): Promise<number> {
  const { io, config } = input;
  const parsed = parseUpArgs(input.argv);
  if (typeof parsed === "string") {
    return argError(io, parsed);
  }
  // Validate BEFORE spawning: a bad file or flag must never leave a running
  // daemon behind.
  let publish: PublishInput | undefined;
  if (parsed.file !== undefined) {
    let format: Format;
    if (parsed.format !== undefined) {
      // explicit flag wins over the extension
      if (parsed.format !== "markdown" && parsed.format !== "html") {
        return argError(
          io,
          `--format must be markdown or html, got "${parsed.format}"`,
        );
      }
      format = parsed.format;
    } else if (parsed.file.endsWith(".md")) {
      format = "markdown";
    } else if (parsed.file.endsWith(".html")) {
      format = "html";
    } else {
      return argError(
        io,
        `cannot infer --format from "${basename(parsed.file)}" — pass --format markdown|html`,
      );
    }
    let content: string;
    try {
      content = await Bun.file(parsed.file).text();
    } catch (err) {
      return argError(io, `cannot read ${parsed.file}: ${errText(err)}`);
    }
    publish = {
      content,
      title: parsed.title ?? basename(parsed.file),
      format,
      tags: parsed.tags,
    };
  } else if (
    parsed.format !== undefined ||
    parsed.title !== undefined ||
    parsed.tags.length > 0
  ) {
    io.stderr(
      "board: --title/--format/--tags only apply when a file is given (ignored)",
    );
  }

  // `up` self-heals the registry (D20): stale (dead-pid) entries get the
  // down-on-dead cleanup — keepsakes included — and the run reports them.
  // N4 (audit): a broken registry must never crash the spawn — the prune is
  // housekeeping, so its failure is a `board: …` warning and the spawn goes
  // ahead.
  try {
    for (const id of await pruneStaleInstances(config.dataDir, (m) =>
      io.stderr(`board: ${m}`),
    )) {
      io.stdout(`pruned stale instance ${id} (pid gone)`);
    }
  } catch (err) {
    io.stderr(
      `board: stale-instance prune failed (${errText(err)}) — continuing with the spawn`,
    );
  }

  let spawned: { entry: ReadyInstanceEntry; token: string };
  try {
    spawned = await spawnInstance({
      registryDataDir: config.dataDir,
      agentTokenName: parsed.agent,
    });
  } catch (err) {
    io.stderr(`board: ${errText(err)}`);
    return 1;
  }
  const { entry, token } = spawned;
  const paths = instancePaths(config.dataDir, entry.id);

  try {
    let human: string | undefined;
    if (publish !== undefined) {
      const created = await restJson<{ id: string }>(
        "POST",
        `${entry.url}/api/boards`,
        token,
        {
          title: publish.title,
          format: publish.format,
          ...(publish.tags.length > 0 ? { tags: publish.tags } : {}),
        },
      );
      await restJson(
        "POST",
        `${entry.url}/api/boards/${created.id}/publish`,
        token,
        {
          format: publish.format,
          content: publish.content,
          expected_version: 0,
        },
      );
      // Sanctioned local-db exception (invariant 3), same as `open`/`token`:
      // no API route mints exchange tokens by design (docs/api.md), so the
      // one-time link token is minted directly on the instance's temp db.
      const db = openDb(entry.dataDir);
      try {
        human = humanLink(
          entry.url,
          createExchangeToken(db, created.id),
          created.id,
        );
      } finally {
        db.close();
      }
    }

    io.stdout(`instance ${entry.id} listening on ${entry.url}`);
    // The one sanctioned printed plaintext (invariant 7's exception, D20) —
    // everything else holds the token only hashed (db) or not at all.
    io.stdout(`agent token (print once — it is not recoverable): ${token}`);
    io.stdout(`credentials env file (agent shells: source it): ${paths.env}`);
    if (human !== undefined) {
      io.stdout(`human link: ${human}`);
      // Loud warning, not a failure: the API half works without the SPA; the
      // human link would 404 the UI until someone runs `make web`.
      if (!existsSync(resolveWebDist())) {
        io.stderr(
          "board: warning: web/dist is missing — the human link will 404 the UI (build it: make web)",
        );
      }
    }
    io.stdout(`tear down with: board down ${entry.id}`);
    if (parsed.open && human !== undefined) {
      (input.openUrl ?? defaultOpener)(human, io);
    }
    return 0;
  } catch (err) {
    io.stderr(`board: ${errText(err)}`);
    // A failure after spawn must not leak a running daemon whose credentials
    // were never printed — tear it down (keepsakes kept) and fail. [D20]
    try {
      await teardownInstance(entry, paths, {
        notice: (m) => io.stderr(`board: ${m}`),
      });
      io.stderr(`board: tore down instance ${entry.id} after the failure`);
    } catch (cleanupErr) {
      io.stderr(
        `board: teardown after failure also failed: ${errText(cleanupErr)}`,
      );
    }
    return 1;
  }
}

async function runDown(input: InstancesCommandInput): Promise<number> {
  const { io, config } = input;
  // N6 (audit ergonomics): down gains --instance like every other
  // instance-aware command. Precedence: --instance flag > positional id >
  // BOARD_INSTANCE env (flag and positional are equivalent; flag wins).
  const scanned = scan(
    input.argv,
    ["--instance"],
    ["--keep-data", "--no-export"],
  );
  if (typeof scanned === "string") {
    return argError(io, scanned);
  }
  if (scanned.positional.length > 1) {
    return argError(io, "down takes at most one instance id");
  }
  const target =
    scanned.values.get("instance") ??
    scanned.positional[0] ??
    process.env.BOARD_INSTANCE;
  if (target === undefined || target.length === 0) {
    io.stderr(
      "board: down needs an instance id (pass <id> or --instance <id>, or set BOARD_INSTANCE — see: board instances)",
    );
    for (const { entry } of listRegistryEntries(config.dataDir)) {
      if (entry !== null && entry.closedAt === undefined) {
        io.stderr(`  ${entry.id}  ${entry.url ?? "(booting)"}`);
      }
    }
    return 1;
  }
  // F1 guard 2 (audit): the id became a path above — only ids `up` could have
  // minted may address the registry, so a `../`-style id can never reach
  // files outside it.
  if (!plausibleId(target)) {
    io.stderr(
      `board: "${target}" is not an instance id — ids look like s-<10 alphanumerics> (minted by board up)`,
    );
    return 1;
  }
  const paths = instancePaths(config.dataDir, target);
  const entry = readInstanceEntry(paths);
  if (entry === null) {
    io.stderr(
      `board: no instance "${target}" in the registry (${instancesRoot(config.dataDir)})`,
    );
    return 1;
  }
  if (entry.closedAt !== undefined) {
    io.stdout(
      `instance ${entry.id} is already closed (closed ${entry.closedAt}) — nothing to do`,
    );
    return 0;
  }
  try {
    const result = await teardownInstance(entry, paths, {
      keepData: scanned.bools.has("keep-data"),
      exportKeepsakes: !scanned.bools.has("no-export"),
      notice: (m) => io.stderr(`board: ${m}`),
    });
    io.stdout(
      `closed ${entry.id}${result.wasAlive ? "" : " (daemon was already dead)"} — ` +
        `${result.boards.length} board(s) kept as zips in ${paths.boards}`,
    );
    if (result.keptData) {
      io.stdout(`temp data dir kept: ${entry.dataDir}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof PidForeignError) {
      // D20: a registry pid that is not our daemon is NEVER signalled —
      // error out loudly with the next step instead.
      io.stderr(
        `board: ${err.message} — inspect \`board instances --all\` or the registry at ${paths.dir}`,
      );
      return 1;
    }
    io.stderr(`board: ${errText(err)}`);
    return 1;
  }
}

function formatAge(iso: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return `${Math.floor(ms / 1000)}s`;
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

async function runList(input: InstancesCommandInput): Promise<number> {
  const { io, config } = input;
  const scanned = scan(input.argv, [], ["--all", "--prune"]);
  if (typeof scanned === "string") {
    return argError(io, scanned);
  }
  if (scanned.bools.has("prune")) {
    for (const id of await pruneStaleInstances(config.dataDir, (m) =>
      io.stderr(`board: ${m}`),
    )) {
      io.stdout(`pruned stale instance ${id}`);
    }
  }
  const rows: string[][] = [];
  const hints: string[] = [];
  for (const { paths, entry } of listRegistryEntries(config.dataDir)) {
    if (entry === null) {
      rows.push([basename(paths.dir), "unreadable", "—", "—", "—", paths.dir]);
      continue;
    }
    if (entry.closedAt !== undefined) {
      if (!scanned.bools.has("all")) {
        continue;
      }
      rows.push([
        entry.id,
        "closed",
        entry.url ?? "—",
        formatAge(entry.createdAt),
        String(entry.boards?.length ?? 0),
        entry.dataDir,
      ]);
      continue;
    }
    // F3: a booting entry has no url — young ones are mid-boot (another
    // shell's up; prune spares them), old ones are SIGKILL orphans that down
    // or --prune will reap.
    if (entry.booting === true) {
      const young = Date.now() - Date.parse(entry.createdAt) < BOOT_GRACE_MS;
      rows.push([
        entry.id,
        young ? "booting" : "boot-orphan",
        "—",
        formatAge(entry.createdAt),
        String(countBoardsOnDisk(entry.dataDir)),
        entry.dataDir,
      ]);
      if (!young) {
        hints.push(
          `instance ${entry.id} never finished booting — \`board down ${entry.id}\` (or \`board instances --prune\`) cleans it`,
        );
      }
      continue;
    }
    // Status is DERIVED (D20): pid identity at read time, never a stored flag.
    const identity = pidIdentity(entry.pid, entry.dataDir);
    const boards = String(countBoardsOnDisk(entry.dataDir));
    if (identity === "gone") {
      rows.push([
        entry.id,
        "stale",
        entry.url ?? "—",
        formatAge(entry.createdAt),
        boards,
        entry.dataDir,
      ]);
      hints.push(
        `instance ${entry.id} is stale (pid ${entry.pid} gone) — \`board instances --prune\` cleans it`,
      );
    } else if (identity === "foreign") {
      rows.push([
        entry.id,
        "mismatch",
        entry.url ?? "—",
        formatAge(entry.createdAt),
        "—",
        entry.dataDir,
      ]);
      hints.push(
        `instance ${entry.id}: pid ${entry.pid} is alive but not this daemon — left untouched`,
      );
    } else {
      rows.push([
        entry.id,
        "live",
        entry.url ?? "—",
        formatAge(entry.createdAt),
        boards,
        entry.dataDir,
      ]);
    }
  }
  if (rows.length === 0) {
    io.stdout("no instances yet; start one with: board up [file]");
    return 0;
  }
  for (const line of renderTable(
    ["ID", "STATUS", "URL", "AGE", "BOARDS", "DATA DIR"],
    rows,
  )) {
    io.stdout(line);
  }
  for (const hint of hints) {
    io.stderr(`board: ${hint}`);
  }
  return 0;
}

export async function runInstancesCommand(
  command: string,
  input: InstancesCommandInput,
): Promise<number> {
  switch (command) {
    case "up":
      return runUp(input);
    case "down":
      return runDown(input);
    case "instances":
      return runList(input);
    default:
      input.io.stderr(INSTANCES_USAGE);
      return 1;
  }
}
