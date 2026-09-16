import { EventLogPanel } from "./EventLogPanel.tsx";
import { SessionsPanel } from "./SessionsPanel.tsx";
import { TokensPanel } from "./TokensPanel.tsx";

// Third top-level surface (M7): the operator's view over the append-only
// event log plus the credential inventories (sessions, tokens). Shares the
// board view's two-column grid; the side panels stack like the comment
// sidebar does.
export function AuditView() {
  return (
    <div className="audit-view">
      <header className="board-header">
        <a className="back" href="#/">
          ← boards
        </a>
        <h1>Audit</h1>
      </header>
      <div className="board-layout">
        <EventLogPanel />
        <div className="audit-side">
          <SessionsPanel />
          <TokensPanel />
        </div>
      </div>
    </div>
  );
}
