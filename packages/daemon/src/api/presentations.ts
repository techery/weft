import { createHash } from "node:crypto";
import type { UiPresentation, Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";
import { stateOf } from "../state.ts";

const PRESENTATION_ID = /^[a-z][a-z0-9-]{0,63}$/i;
const MAX_BUNDLE_BYTES = 1_000_000;

/** Serve only bundle refs sealed into this run's journal; generic blobs never become executable. */
export function registerPresentationRoutes(app: Hono, weft: Weft): void {
  app.get("/api/runs/:id/presentations/:presentationId/frame", async (c) => {
    try {
      const runId = c.req.param("id");
      const presentationId = c.req.param("presentationId");
      if (!PRESENTATION_ID.test(presentationId)) throw new Error("invalid presentation id");
      const state = await stateOf(weft, runId);
      const presentation = findPresentation(state, presentationId);
      if (!presentation) throw new Error(`presentation ${presentationId} not found in run ${runId}`);
      if (presentation.asset.protocol !== 1) {
        throw new Error(`unsupported UI protocol ${presentation.asset.protocol}`);
      }
      if (presentation.asset.bundleRef.size > MAX_BUNDLE_BYTES) throw new Error("UI bundle is oversized");
      const code = await weft.engine.blobs.getText(presentation.asset.bundleRef.$blob);
      if (Buffer.byteLength(code) !== presentation.asset.bundleRef.size) {
        throw new Error("UI bundle size does not match its journaled descriptor");
      }
      // Prevent an authored string literal from terminating the server-owned script element.
      const inlineCode = code.replaceAll("</script", "<\\/script");
      const scriptHash = createHash("sha256").update(inlineCode).digest("base64");
      const html = frameHtml(inlineCode);
      const csp = [
        "default-src 'none'",
        `script-src 'sha256-${scriptHash}'`,
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "connect-src 'none'",
        "font-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "sandbox allow-scripts",
        "frame-ancestors 'self'",
      ].join("; ");
      return c.body(html, 200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy":
          "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
        "cache-control": "no-store",
      });
    } catch (err) {
      return fail(c, err);
    }
  });
}

function findPresentation(
  state: Awaited<ReturnType<typeof stateOf>>,
  id: string,
): UiPresentation | undefined {
  for (let index = state.steps.length - 1; index >= 0; index--) {
    const presentation = state.steps[index]?.presentation;
    if (presentation?.id === id) return presentation;
  }
  for (let index = state.humans.length - 1; index >= 0; index--) {
    const presentation = state.humans[index]?.ui;
    if (presentation?.id === id) return presentation;
  }
  return undefined;
}

function frameHtml(code: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body,#root{margin:0;min-height:1px}body{font:14px system-ui,sans-serif;color:#161616;background:transparent}</style>
</head>
<body><div id="root"></div><script>${code}</script></body>
</html>`;
}
