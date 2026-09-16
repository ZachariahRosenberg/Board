// Agent-managed session instances (D20): the ONE implementation of the
// registry, daemon spawn/readiness, pid identity, and teardown mechanics —
// shared by the `board up/down/instances` commands, the CLI tests, and (in a
// later wave) the smoke refactor. Every instance is a throwaway loopback
// daemon on an OS-temp data dir; the shared daemon and `~/.board` stay
// human-managed (D20 safety boundary).
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "../../server/src/bundle.ts";
import { openDb } from "../../server/src/db.ts";
import { shortId } from "../../server/src/ids.ts";
import { LISTEN_LINE } from "../../server/src/main.ts";
import { createToken } from "../../server/src/tokens.ts";

const POLL_MS = 100;
const READY_TIMEOUT_MS = 10_000;
// D20 teardown contract: SIGTERM, then ≤8s of liveness polling, then SIGKILL.
const TERM_GRACE_MS = 8_000;
const KILL_GRACE_MS = 2_000;

export interface InstanceEntry {
  id: string;
  pid: number;
  port: number;
  url: string;
  dataDir: string;
  agentTokenName: string;
  createdAt: string;
  closedAt?: string;
  // board ids kept as zips under <registry>/boards/ — stamped at teardown
  boards?: string[];
}

export interface InstancePaths {
  dir: string;
  json: string;
  env: string;
  log: string;
  boards: string;
}

// Liveness is DERIVED at read time (D20): no persisted status field — a
// persisted one is a lie the moment the daemon is killed out-of-band.
export type PidIdentity = "gone" | "ours" | "foreign";

export class PidForeignError extends Error {
  constructor(readonly pid: number) {
    super(
      `pid ${pid} is not a board daemon for this instance — refusing to signal it (pid-reuse defense, D20)`,
    );
    this.name = "PidForeignError";
  }
}

export class InstanceSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceSpawnError";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The registry is the discovery substrate under the RESOLVED BOARD_DATA_DIR —
// no new env var (D20); tests point BOARD_DATA_DIR at a temp dir.
export function instancesRoot(dataDir: string): string {
  return join(dataDir, "instances");
}

export function instancePaths(dataDir: string, id: string): InstancePaths {
  const dir = join(instancesRoot(dataDir), id);
  return {
    dir,
    json: join(dir, "instance.json"),
    env: join(dir, "env"),
    log: join(dir, "daemon.log"),
    boards: join(dir, "boards"),
  };
}

// Instance id: `s-` + the shared short-id generator (same shape discipline as
// boards/assets), retried on the astronomically-unlikely registry collision.
function createRegistryDir(dataDir: string): {
  id: string;
  paths: InstancePaths;
} {
  const root = instancesRoot(dataDir);
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `s-${shortId()}`;
    const paths = instancePaths(dataDir, id);
    if (existsSync(paths.dir)) {
      continue;
    }
    mkdirSync(paths.dir, { recursive: true });
    mkdirSync(paths.boards, { recursive: true });
    return { id, paths };
  }
  throw new Error(`could not mint a unique instance id under ${root}`);
}

// Only ids `up` could have minted are ever listed/pruned — a stray directory
// under instances/ is reported, never recursed into or deleted.
function plausibleId(id: string): boolean {
  return /^s-[0-9A-Za-z]{10}$/.test(id);
}

export interface RegistryEntry {
  paths: InstancePaths;
  entry: InstanceEntry | null;
}

// Sorted for stable output; entry === null marks an unreadable/missing
// instance.json (reported as such, never auto-removed).
export function listRegistryEntries(dataDir: string): RegistryEntry[] {
  const root = instancesRoot(dataDir);
  if (!existsSync(root)) {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const id of readdirSync(root).sort()) {
    if (!plausibleId(id)) {
      continue;
    }
    const paths = instancePaths(dataDir, id);
    out.push({ paths, entry: readInstanceEntry(paths) });
  }
  return out;
}

export function readInstanceEntry(paths: InstancePaths): InstanceEntry | null {
  try {
    return JSON.parse(readFileSync(paths.json, "utf8")) as InstanceEntry;
  } catch {
    return null;
  }
}

// Atomic write (tmp + rename) so a crash mid-write never leaves a torn entry.
export function writeInstanceEntry(
  paths: InstancePaths,
  entry: InstanceEntry,
): void {
  const tmp = `${paths.json}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, paths.json);
}

// The credential env file is the session-credential delivery artifact (D20,
// owner-accepted): the ONLY plaintext surfaces are this file and up's
// print-once line. mode 0600, deleted by down/prune. instance.json and
// daemon.log never see the token.
export function writeEnvFile(
  paths: InstancePaths,
  creds: { id: string; port: number; token: string },
): void {
  const fd = openSync(paths.env, "w", 0o600);
  try {
    writeSync(
      fd,
      `# board session ${creds.id} — source me; purged by board down\n` +
        `export BOARD_INSTANCE=${creds.id}\n` +
        `export BOARD_PORT=${creds.port}\n` +
        `export BOARD_TOKEN=${creds.token}\n`,
    );
  } finally {
    closeSync(fd);
  }
  // umask can only strip bits, but the 0600 contract is pinned, not hoped for.
  chmodSync(paths.env, 0o600);
}

export function readEnvToken(paths: InstancePaths): string | null {
  try {
    const text = readFileSync(paths.env, "utf8");
    return /^export BOARD_TOKEN=(\S+)$/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function deleteEnvFile(paths: InstancePaths): void {
  rmSync(paths.env, { force: true });
}

export function serverEntryPath(): string {
  // cli/src/instances.ts → repo root is two levels up.
  return join(import.meta.dir, "..", "..", "server", "src", "main.ts");
}

const SERVER_ENTRY = "server/src/main.ts";

// D20 pid-reuse defense, runs BEFORE any signal: the process must be a board
// daemon (server entry on the cmdline) and — when its environment is readable,
// i.e. same uid — must carry THIS instance's BOARD_DATA_DIR. A recycled pid
// fails one of the two and is never signalled.
export function pidIdentity(pid: number, expectedDataDir: string): PidIdentity {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "gone";
  }
  const args = cmdline.split("\0");
  const isDaemon = args.some(
    (arg) => arg === SERVER_ENTRY || arg.endsWith(`/${SERVER_ENTRY}`),
  );
  if (!isDaemon) {
    return "foreign";
  }
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!environ.split("\0").includes(`BOARD_DATA_DIR=${expectedDataDir}`)) {
      return "foreign";
    }
  } catch {
    // environ unreadable (other uid) — the cmdline match stands alone
  }
  return "ours";
}

// Narrow structural view of the spawned child: Bun's Subprocess generic
// surface is version-sensitive, and readiness only needs pid + exited.
interface DaemonProcess {
  pid: number;
  exited: Promise<number>;
  unref(): void;
}

async function waitForListenLine(
  logPath: string,
  proc: DaemonProcess,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  for (;;) {
    const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const match = LISTEN_LINE.exec(text);
    if (match !== null) {
      return match[1] ?? "";
    }
    const tail = text.length > 2000 ? text.slice(-2000) : text;
    if (exited) {
      throw new InstanceSpawnError(
        `daemon exited before becoming ready; daemon.log tail:\n${tail}`,
      );
    }
    if (Date.now() > deadline) {
      throw new InstanceSpawnError(
        `daemon not ready after ${timeoutMs}ms; daemon.log tail:\n${tail}`,
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // not accepting connections yet
    }
    if (Date.now() > deadline) {
      throw new InstanceSpawnError(
        `daemon at ${url} never answered /api/health within ${timeoutMs}ms`,
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

export interface SpawnedInstance {
  entry: InstanceEntry;
  token: string;
  // Plaintexts for extraAgentTokenNames, positionally aligned. Same one-print
  // discipline as token: the caller surfaces them once, nothing but the env
  // file and the db hash ever holds them.
  extraTokens: string[];
}

export interface SpawnOptions {
  registryDataDir: string;
  agentTokenName: string;
  // Extra agent credentials minted in the SAME pre-spawn db session — one
  // open/close window keeps the no-boot-WAL-race guarantee uniform no matter
  // how many agent tokens a caller needs (scripts/smoke.ts needs two).
  extraAgentTokenNames?: string[];
  readyTimeoutMs?: number;
}

// Spawn one session daemon: OS-temp data dir, kernel-assigned port, loopback
// bind + Host allowlist pinned. Throws (after cleaning up everything it
// created) if the daemon never becomes ready.
export async function spawnInstance(
  opts: SpawnOptions,
): Promise<SpawnedInstance> {
  const { id, paths } = createRegistryDir(opts.registryDataDir);
  // The daemon's data dir is ALWAYS OS-tmp (D20 safety boundary) — never
  // under ~/.board, never derived from the environment.
  const dataDir = mkdtempSync(join(tmpdir(), "board-instance-"));
  const readyMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let proc:
    | (DaemonProcess & { kill(signal?: number | NodeJS.Signals): void })
    | undefined;
  // Parent-side copies of the log fds: the daemon dups them across spawn;
  // this process closes them again in the finally below.
  const logFds = [openSync(paths.log, "a"), openSync(paths.log, "a")];
  try {
    // Mint-before-spawn (the scripts/smoke.ts pattern): the temp db is
    // opened, migrated, seeded, and CLOSED in this process before the daemon
    // ever opens it — no boot-time WAL race between two writers. The
    // plaintext exists only in memory and, below, the env file; at rest in
    // the db it is SHA-256 (invariant 8). [D20]
    const db = openDb(dataDir);
    const { token } = createToken(db, { name: opts.agentTokenName });
    const extraTokens = (opts.extraAgentTokenNames ?? []).map(
      (name) => createToken(db, { name }).token,
    );
    db.close();

    // Env is PINNED over the inherited environ: a hostile BOARD_HOST=0.0.0.0
    // or a widened BOARD_BIND from the agent's shell must never widen a
    // session instance (invariant 1; D20 safety boundary). BOARD_PORT=0
    // kernel-assigns the port so instances never collide on :7800.
    proc = Bun.spawn([process.execPath, serverEntryPath()], {
      env: {
        ...process.env,
        BOARD_DATA_DIR: dataDir,
        BOARD_PORT: "0",
        BOARD_HOST: "127.0.0.1",
        BOARD_BIND: "127.0.0.1",
      },
      stdin: "ignore",
      // Both streams land in daemon.log for post-mortem — the repo's
      // everything-gets-recorded ethos. A file fd (not a pipe): the daemon
      // outlives this process, and a pipe would EPIPE once its reader dies.
      stdout: logFds[0],
      stderr: logFds[1],
    });
    // Detached: `board up` exits as soon as it has printed — the daemon must
    // outlive it (the agent's shell is ephemeral). Bun waits for all
    // subprocesses by default; unref() is what makes the CLI exit.
    proc.unref();

    const url = await waitForListenLine(paths.log, proc, readyMs);
    await waitForHealth(url, readyMs);
    const entry: InstanceEntry = {
      id,
      pid: proc.pid,
      port: Number(new URL(url).port),
      url,
      dataDir,
      agentTokenName: opts.agentTokenName,
      createdAt: new Date().toISOString(),
    };
    writeInstanceEntry(paths, entry);
    writeEnvFile(paths, { id, port: entry.port, token });
    return { entry, token, extraTokens };
  } catch (err) {
    // Boot failed: never leak a half-registered instance. The Subprocess
    // handle is authoritative here (our own child — no identity question),
    // then the temp dir and the registry dir go too.
    if (proc !== undefined) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
      await proc.exited;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(paths.dir, { recursive: true, force: true });
    throw err;
  } finally {
    closeSync(logFds[0]);
    closeSync(logFds[1]);
  }
}

export interface TeardownOptions {
  keepData?: boolean;
  exportKeepsakes?: boolean;
  notice?: (message: string) => void;
}

export interface TeardownResult {
  wasAlive: boolean;
  boards: string[];
  keptData: boolean;
}

// Teardown per the D20 contract: REST end + export when the daemon is alive,
// disk-bundle keepsakes when it is not, the TERM→8s→KILL signal ladder, then
// temp purge (unless keepData), env purge, and the closedAt/boards stamp.
export async function teardownInstance(
  entry: InstanceEntry,
  paths: InstancePaths,
  opts: TeardownOptions = {},
): Promise<TeardownResult> {
  const notice = opts.notice ?? (() => {});
  const identity = pidIdentity(entry.pid, entry.dataDir);
  if (identity === "foreign") {
    throw new PidForeignError(entry.pid);
  }
  const wasAlive = identity === "ours";
  const wantExport = opts.exportKeepsakes !== false;
  const kept: string[] = [];

  let restExported: string[] = [];
  if (wasAlive) {
    const token = readEnvToken(paths);
    if (token === null) {
      // The env file is the only credential source down has; without it the
      // REST path is impossible and the disk bundles take over.
      notice(
        `no env file for ${entry.id} — boards cannot be ended via REST; keepsakes come from the on-disk bundles`,
      );
    } else {
      await endOpenBoards(entry.url, token, notice);
      if (wantExport) {
        restExported = await exportBoardsViaRest(
          entry.url,
          token,
          paths.boards,
          notice,
        );
      }
    }
  }
  if (wantExport) {
    const fromDisk = exportBoardsFromDisk(
      entry,
      paths,
      notice,
      new Set(restExported),
    );
    kept.push(...restExported, ...fromDisk);
  }
  if (wasAlive) {
    await signalDaemon(entry.pid, entry.dataDir);
  }

  if (!opts.keepData) {
    rmSync(entry.dataDir, { recursive: true, force: true });
  }
  // The env file is purged even with --keep-data: the credential dies with
  // the session; only the data is kept.
  deleteEnvFile(paths);
  writeInstanceEntry(paths, {
    ...entry,
    closedAt: new Date().toISOString(),
    boards: kept,
  });
  return { wasAlive, boards: kept, keptData: opts.keepData === true };
}

async function endOpenBoards(
  baseUrl: string,
  token: string,
  notice: (message: string) => void,
): Promise<void> {
  let boards: Array<{ id: string }>;
  try {
    const res = await fetch(`${baseUrl}/api/boards?status=open`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      notice(`listing open boards failed (HTTP ${res.status})`);
      return;
    }
    boards = (await res.json()) as Array<{ id: string }>;
  } catch (err) {
    notice(`daemon unreachable over REST: ${errText(err)}`);
    return;
  }
  for (const board of boards) {
    try {
      const res = await fetch(`${baseUrl}/api/boards/${board.id}/end`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      // 409 board_ended = already ended — the teardown goal holds either way.
      if (!res.ok && res.status !== 409) {
        notice(`ending board "${board.id}" failed (HTTP ${res.status})`);
      }
    } catch (err) {
      notice(`ending board "${board.id}" failed: ${errText(err)}`);
    }
  }
}

async function exportBoardsViaRest(
  baseUrl: string,
  token: string,
  outDir: string,
  notice: (message: string) => void,
): Promise<string[]> {
  let boards: Array<{ id: string }>;
  try {
    const res = await fetch(`${baseUrl}/api/boards`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      notice(`listing boards failed (HTTP ${res.status})`);
      return [];
    }
    boards = (await res.json()) as Array<{ id: string }>;
  } catch (err) {
    notice(`daemon unreachable over REST: ${errText(err)}`);
    return [];
  }
  const kept: string[] = [];
  for (const board of boards) {
    try {
      const res = await fetch(`${baseUrl}/api/boards/${board.id}/export`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        notice(`exporting board "${board.id}" failed (HTTP ${res.status})`);
        continue;
      }
      writeFileSync(
        join(outDir, `${board.id}.zip`),
        Buffer.from(await res.arrayBuffer()),
      );
      kept.push(board.id);
    } catch (err) {
      notice(`exporting board "${board.id}" failed: ${errText(err)}`);
    }
  }
  return kept;
}

// Dead-instance keepsakes: the daemon cannot serve exports, so the bundles
// are zipped from the temp data dir directly. openDb replays the WAL of the
// dead daemon (a single dead writer — safe) and buildBundle is the export
// route's own pure function, unchanged. [D20]
export function exportBoardsFromDisk(
  entry: InstanceEntry,
  paths: InstancePaths,
  notice: (message: string) => void,
  skip: ReadonlySet<string> = new Set<string>(),
): string[] {
  const boardsDir = join(entry.dataDir, "boards");
  if (!existsSync(join(entry.dataDir, "board.db"))) {
    return [];
  }
  let db: Database | null = null;
  const kept: string[] = [];
  try {
    for (const name of readdirSync(boardsDir)) {
      if (skip.has(name)) {
        continue;
      }
      try {
        if (!statSync(join(boardsDir, name)).isDirectory()) {
          continue;
        }
        db ??= openDb(entry.dataDir);
        const zip = buildBundle(db, entry.dataDir, name);
        writeFileSync(join(paths.boards, `${name}.zip`), zip);
        kept.push(name);
      } catch (err) {
        notice(`keeping board "${name}" failed: ${errText(err)}`);
      }
    }
  } catch {
    // no boards/ dir — the daemon never created a board
  } finally {
    db?.close();
  }
  return kept;
}

// The daemon is NOT this process's child (`down` is a different process from
// the `up` that spawned it) — waitpid/SIGCHLD cannot observe it, so /proc
// identity polling is the only liveness mechanism. [D20]
export async function signalDaemon(
  pid: number,
  dataDir: string,
): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // ESRCH — already gone
  }
  const termDeadline = Date.now() + TERM_GRACE_MS;
  for (;;) {
    // Re-verified every poll: if the pid dies AND is recycled mid-wait, the
    // new owner is "foreign" — and is never signalled.
    if (pidIdentity(pid, dataDir) !== "ours") {
      return;
    }
    if (Date.now() > termDeadline) {
      break;
    }
    await Bun.sleep(POLL_MS);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const killDeadline = Date.now() + KILL_GRACE_MS;
  for (;;) {
    if (pidIdentity(pid, dataDir) !== "ours") {
      return;
    }
    if (Date.now() > killDeadline) {
      throw new Error(
        `instance pid ${pid} survived SIGKILL — manual cleanup required`,
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

export function countBoardsOnDisk(dataDir: string): number {
  try {
    return readdirSync(join(dataDir, "boards")).filter((name) =>
      statSync(join(dataDir, "boards", name)).isDirectory(),
    ).length;
  } catch {
    return 0;
  }
}

// `up` self-heals and `instances --prune` cleans: a stale entry (dead pid)
// gets the exact down-on-dead treatment — keepsakes from disk, temp purge,
// env purge, closedAt stamp. Foreign-pid entries are left untouched.
export async function pruneStaleInstances(
  dataDir: string,
  notice: (message: string) => void = () => {},
): Promise<string[]> {
  const pruned: string[] = [];
  for (const { paths, entry } of listRegistryEntries(dataDir)) {
    if (entry === null || entry.closedAt !== undefined) {
      continue;
    }
    if (pidIdentity(entry.pid, entry.dataDir) !== "gone") {
      continue;
    }
    await teardownInstance(entry, paths, { notice });
    pruned.push(entry.id);
  }
  return pruned;
}

// Same shape `board open` builds: the one-time exchange token rides the URL;
// the SPA swaps it for a session bearer (docs/api.md "Sessions").
export function humanLink(
  baseUrl: string,
  exchangeToken: string,
  boardId: string,
): string {
  return `${baseUrl}/?token=${exchangeToken}#/boards/${boardId}`;
}
