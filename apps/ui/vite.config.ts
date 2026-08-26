import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { proxiedOrigin } from "./src/proxy-origin.js";

/**
 * The manager is served by `@techery/weft-daemon` — what `weft ui` starts — so it builds
 * straight into that package's `web/` directory. One artifact in one place: the daemon
 * finds it there whether it is running off this repo's source or off a published tarball,
 * and `weft ui` needs no copy step to serve it.
 */
const DAEMON_WEB = fileURLToPath(new URL("../../packages/daemon/web", import.meta.url));

/**
 * In dev the page is served by Vite, not by the daemon, so its same-origin `/api` calls
 * would land on Vite. They are proxied to a daemon you start yourself:
 *
 *   weft ui                     # a daemon on :4781, doing real work
 *   pnpm dev:ui                 # this, on :4782, hot-reloading against it
 *   WEFT_DAEMON=http://127.0.0.1:4790 pnpm dev:ui
 *
 * Proxying rather than enabling CORS on the daemon is deliberate: the daemon requires an
 * Origin that exactly matches its Host. The proxy translates a request only when its
 * incoming Origin already matches Vite's Host; foreign origins remain foreign and the
 * daemon rejects them.
 */
const DAEMON = process.env.WEFT_DAEMON ?? "http://127.0.0.1:4781";
const DAEMON_ORIGIN = new URL(DAEMON).origin;

const proxy: Record<string, ProxyOptions> = {
  // The journal arrives as Server-Sent Events, so this path has to stream rather than
  // buffer. http-proxy passes a response through as it arrives, and the daemon already
  // sends `x-accel-buffering: no`, so no special handling is needed here — but it is the
  // thing to check first if a live run stops updating in dev.
  "/api": {
    target: DAEMON,
    changeOrigin: true,
    configure(server) {
      server.on("proxyReq", (proxyReq, req) => {
        const origin = proxiedOrigin(req.headers.origin, req.headers.host, DAEMON_ORIGIN);
        if (origin !== undefined) proxyReq.setHeader("origin", origin);
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 4782, proxy },
  // `vite preview` serves the built bundle, which needs the same door to the daemon.
  preview: { port: 4783, proxy },
  build: {
    outDir: DAEMON_WEB,
    // The output lives outside this project root, so Vite wants the intent spelled out.
    emptyOutDir: true,
    // The map is 1.6 MB and would ship in the daemon's tarball; `pnpm dev:ui` has
    // sourcemaps regardless, which is where UI debugging happens.
    sourcemap: false,
  },
});
