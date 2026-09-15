const SESSION_KEY = "board.session";

export function getSessionToken(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function setSessionToken(token: string): void {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_KEY);
}

// `board open` hands over a one-time token as ?token=; claim it from the URL
// exactly once so it never lingers in history (docs/security.md session model).
export function extractOneTimeToken(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token === null) {
    return null;
  }
  url.searchParams.delete("token");
  history.replaceState(null, "", url.toString());
  return token;
}
