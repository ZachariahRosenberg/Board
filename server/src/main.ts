import { loadConfig } from "./config.ts";
import { startDaemon } from "./daemon.ts";

// The daemon lifecycle — config load, start, signal handling — defined once
// here and reused by the CLI's `board serve` (cli/src/commands/serve.ts),
// which was previously a byte-for-byte copy of this file.
export async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const daemon = startDaemon(config);

  console.log(`board: host app listening on ${daemon.hostUrl}`);

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void daemon.stop().then(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The daemon runs until a signal handler exits the process — park forever.
  await new Promise<never>(() => undefined);
}

if (import.meta.main) {
  await runDaemon();
}
