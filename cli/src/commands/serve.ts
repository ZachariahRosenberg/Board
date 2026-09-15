import { loadConfig } from "../../../server/src/config.ts";
import { startDaemon } from "../../../server/src/daemon.ts";

export function runServe(): void {
  const config = loadConfig();
  const daemon = startDaemon(config);

  console.log(`board: host app listening on ${daemon.hostUrl}`);
  console.log(`board: board origin listening on ${daemon.originUrl}`);

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
}
