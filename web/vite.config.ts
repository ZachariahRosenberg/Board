import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies /api and board assets to the daemon; production is
// served by boardd itself (same origin, no proxy involved).
const apiPort = process.env.BOARD_PORT ?? "7800";
const daemon = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": daemon,
      // Board assets (/assets/<10-char-id>) live in the daemon. Without this
      // rule the dev server's SPA fallback answered the editor's/board's image
      // requests with index.html — the <img> decode failed and every overlay
      // editor rendered blank (dogfooded, M5+M6 acceptance round). The
      // 10-char shape is the same disambiguator the daemon uses to keep vite's
      // hashed /assets/* bundles out (server/src/routes/assets.ts); vite treats
      // "^" keys as RegExp.
      "^/assets/[0-9A-Za-z]{10}$": daemon,
      // Same gap, same fix: vendored board libs (/libs/*) are daemon-served
      // (D18) — without this rule html-board scripts 404 under `make dev`
      // while working on :7800.
      "^/libs/": daemon,
    },
  },
  build: {
    outDir: "dist",
  },
});
