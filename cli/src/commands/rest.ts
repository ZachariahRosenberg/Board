// Shared plumbing for the daemon-facing REST commands (boards.ts, status.ts):
// one copy of token loading and error extraction, so `board status` keeps the
// exact boards.ts UX instead of drifting (P3-3 consolidation).

// The commands only ever call fetch with (url, init) — the seam's fakes don't
// implement the platform fetch surface (preconnect), so the field type is the
// narrow shape the commands use.
export type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

export interface ParsedArgs {
  positional: string[];
  // --token flag only; env/env-file fallbacks are the resolver's job
  // (resolve.ts owns the full credential precedence, D20 wave 2).
  token?: string;
  // --instance flag; BOARD_INSTANCE env fallback happens in resolve.ts.
  instance?: string;
}

// Generic argv scanner (no arg-parsing dependency, the token.ts spirit):
// flags and positionals commute; value flags take `--flag v` or `--flag=v`.
// Shared by the hand-rolled parsers (instances.ts, open.ts, token.ts).
export function scan(
  argv: string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[],
):
  | { values: Map<string, string>; bools: Set<string>; positional: string[] }
  | string {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const bare = eq === -1 ? arg : arg.slice(0, eq);
    if (valueFlags.includes(bare)) {
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (value === undefined || value.length === 0) {
        return `flag ${bare} needs a value`;
      }
      values.set(bare.slice(2), value);
      if (eq === -1) {
        i++;
      }
      continue;
    }
    if (boolFlags.includes(arg)) {
      bools.add(arg.slice(2));
      continue;
    }
    if (arg.startsWith("-")) {
      return `unknown flag "${arg}"`;
    }
    positional.push(arg);
  }
  return { values, bools, positional };
}

// Token precedence NOTE: only the flags are parsed here. The full credential
// precedence (--token > BOARD_TOKEN env > instance env file, D20 wave 2)
// lives in resolve.ts, which knows whether an instance was selected.
export function parseArgs(
  argv: string[],
  maxPositional: number,
): ParsedArgs | string {
  const scanned = scan(argv, ["--token", "--instance"], []);
  if (typeof scanned === "string") {
    return scanned;
  }
  const { values, positional } = scanned;
  if (positional.length > maxPositional) {
    return `unexpected argument "${positional[maxPositional]}"`;
  }
  return {
    positional,
    token: values.get("token"),
    instance: values.get("instance"),
  };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
