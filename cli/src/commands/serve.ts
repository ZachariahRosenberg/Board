import { runDaemon } from "../../../server/src/main.ts";

// Thin passthrough: the daemon lifecycle lives in server/src/main.ts so
// `make serve` and `board serve` are one implementation, not two copies.
export function runServe(): void {
  void runDaemon();
}
