import type { BoardEvent } from "../../server/src/domain.ts";

// EventSource reconnects natively and replays Last-Event-ID on reconnect —
// the server closes the gap (docs/plan.md "GET /stream").
export class BoardStream {
  private source: EventSource | null = null;

  constructor(url: string, onEvent: (ev: BoardEvent) => void) {
    this.source = new EventSource(url);
    this.source.addEventListener("board", (message) => {
      try {
        onEvent(
          JSON.parse((message as MessageEvent<string>).data) as BoardEvent,
        );
      } catch {
        // a malformed frame must never kill the stream
      }
    });
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}
