import type { Board, Version, VersionMeta } from "../../server/src/domain.ts";
import { clearSessionToken, getSessionToken } from "./token.ts";

export interface BoardWithVersions {
  board: Board;
  versions: VersionMeta[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    unauthorizedHandler = null;
  };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const headers = new Headers(init?.headers);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    // the session died — drop it and let the app show the gate (run make open)
    clearSessionToken();
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized", "session expired — run make open");
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `request failed: ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body — keep the fallback code/message
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

// Bootstrap: swap a one-time exchange token for the session bearer. Uses raw
// fetch — a 401 here IS the handshake failing, not a dead session.
export async function exchange(oneTimeToken: string): Promise<string> {
  const res = await fetch("/api/session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: oneTimeToken }),
  });
  if (!res.ok) {
    throw new ApiError(
      401,
      "unauthorized",
      "exchange token invalid or expired — run make open",
    );
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

export function listBoards(): Promise<Board[]> {
  return apiFetch<Board[]>("/api/boards");
}

export function getBoard(id: string): Promise<BoardWithVersions> {
  return apiFetch<BoardWithVersions>(`/api/boards/${id}`);
}

export function getVersion(id: string, n: number): Promise<Version> {
  return apiFetch<Version>(`/api/boards/${id}/versions/${n}`);
}
