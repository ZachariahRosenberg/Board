import { useEffect, useState } from "react";
import { listSessions, revokeSession, type SessionInfo } from "../api.ts";
import { formatDate } from "../format.ts";

export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-step revoke: the first click arms the confirm for exactly one row —
  // one click is too destructive for a credential.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setSessions(await listSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load sessions");
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load; refresh is a render-scoped closure whose identity would refetch every render
  useEffect(() => {
    void refresh();
  }, []);

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await revokeSession(id);
      setConfirming(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "revoke failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="audit-panel" aria-label="Sessions">
      <header className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <span className="sidebar-count">
          {sessions === null ? "" : `${sessions.length} total`}
        </span>
      </header>
      {error !== null && <div className="error">{error}</div>}
      {sessions === null ? (
        <div className="status small">loading…</div>
      ) : sessions.length === 0 ? (
        <div className="empty small">No sessions.</div>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>session</th>
              <th>kind</th>
              <th>created</th>
              <th>last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td className="session-id">{session.id}</td>
                <td>
                  {/* The chip IS the leak-remediation signal: an unexchanged
                      exchange row means a one-time ?token= URL was minted but
                      never swapped — the credential is still out there, and
                      revoking it is exactly what the button is for
                      (routes/session.ts, docs/security.md "Audit view"). */}
                  {session.kind === "session" ? (
                    <span className="badge active">live</span>
                  ) : (
                    <span className="badge unexchanged">unexchanged</span>
                  )}
                </td>
                <td>{formatDate(session.created_at)}</td>
                <td>
                  {session.used_at === null ? "—" : formatDate(session.used_at)}
                </td>
                <td>
                  {confirming === session.id ? (
                    <span className="revoke-confirm">
                      {/* Generic confirm for every row, deliberately: the SPA
                          holds only the bearer token, never its own session
                          row id (the server stores it hashed; the exchange
                          response is {token} alone), and guessing by
                          timestamps is not acceptable. A self-revocation
                          therefore lands in the existing 401 → gate flow
                          (api.ts onUnauthorized), which is the graceful
                          path the task allows for. */}
                      Revoke? Any browser using it is signed out.
                      <button
                        type="button"
                        className="pill"
                        disabled={busy}
                        onClick={() => {
                          void revoke(session.id);
                        }}
                      >
                        confirm revoke
                      </button>
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => {
                        setConfirming(session.id);
                      }}
                    >
                      revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
