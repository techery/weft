import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The manager is served by `@techery/weft-daemon` — what `weft ui` starts — so it builds
 * straight into that package's `web/` directory. One artifact in one place: the daemon
 * finds it there whether it is running off this repo's source or off a published tarball,
 * and `weft ui` needs no copy step to serve it.
 */
const DAEMON_WEB = fileURLToPath(new URL("../../packages/daemon/web", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 4782 },
  build: {
    outDir: DAEMON_WEB,
    // The output lives outside this project root, so Vite wants the intent spelled out.
    emptyOutDir: true,
    // The map is 1.6 MB and would ship in the daemon's tarball; `pnpm dev:ui` has
    // sourcemaps regardless, which is where UI debugging happens.
    sourcemap: false,
  },
});
