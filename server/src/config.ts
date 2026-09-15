import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  bind: string[];
}

type Env = Record<string, string | undefined>;

const DEFAULT_DATA_DIR = "~/.board";
// Loopback-only bind is invariant 1 (docs/security.md); BOARD_HOST/BOARD_BIND are the explicit, documented opt-outs.
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7800;
const DEFAULT_BIND = ["127.0.0.1"];
const MAX_PORT = 65535;
const HOSTNAME_FORBIDDEN = /[\s/]/;

function readString(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new ConfigError(`${name} must not be empty`);
  }
  return value;
}

function parsePort(env: Env, name: string, fallback: number): number {
  const raw = readString(env, name, String(fallback));
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) > MAX_PORT) {
    throw new ConfigError(
      `${name} must be an integer between 0 and ${MAX_PORT}, got "${raw}"`,
    );
  }
  return Number.parseInt(raw, 10);
}

function parseHostname(env: Env, name: string, fallback: string): string {
  const value = readString(env, name, fallback).toLowerCase();
  if (HOSTNAME_FORBIDDEN.test(value)) {
    throw new ConfigError(
      `${name} must be a hostname or IP address, got "${value}"`,
    );
  }
  return value;
}

function parseBindList(env: Env): string[] {
  const raw = env.BOARD_BIND;
  if (raw === undefined || raw.trim().length === 0) {
    return [...DEFAULT_BIND];
  }
  const entries: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry.length === 0) {
      throw new ConfigError(
        `BOARD_BIND must be comma-separated hostnames, found an empty entry in "${raw}"`,
      );
    }
    if (HOSTNAME_FORBIDDEN.test(entry)) {
      throw new ConfigError(
        `BOARD_BIND entries must be hostname or IP addresses, got "${entry}"`,
      );
    }
    if (!entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries;
}

function expandDataDir(raw: string): string {
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function makeConfig(env: Env): Config {
  const port = parsePort(env, "BOARD_PORT", DEFAULT_PORT);
  return {
    dataDir: expandDataDir(readString(env, "BOARD_DATA_DIR", DEFAULT_DATA_DIR)),
    host: parseHostname(env, "BOARD_HOST", DEFAULT_HOST),
    port,
    bind: parseBindList(env),
  };
}

export function loadConfig(): Config {
  return makeConfig(process.env);
}
