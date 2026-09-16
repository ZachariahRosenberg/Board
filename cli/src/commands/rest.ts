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
  token: string;
}

// Token precedence: --token flag > BOARD_TOKEN env. No token-file plumbing —
// the existing mint path (`make token add <name>`) prints a token once and
// the caller keeps it like the dogfood token.
export function parseArgs(
  argv: string[],
  maxPositional: number,
): ParsedArgs | string {
  const positional: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token") {
      token = argv[i + 1];
      i++;
      continue;
    }
    if (arg?.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > maxPositional) {
    return `unexpected argument "${positional[maxPositional]}"`;
  }
  if (token === undefined || token.length === 0) {
    const env = process.env.BOARD_TOKEN;
    if (env !== undefined && env.trim().length > 0) {
      token = env.trim();
    }
  }
  if (token === undefined || token.length === 0) {
    return "no token: pass --token <token> or set BOARD_TOKEN (mint one with: make token add cli)";
  }
  return { positional, token };
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
