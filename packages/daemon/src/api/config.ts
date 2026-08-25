/**
 * `GET /api/config` and `PUT /api/config` — `.weft/config.json`, read and written.
 *
 * Approval tiers, the pool size, provider prices and the fetch allow-list are all real
 * settings that only ever had one editor: a text editor. A settings screen needs both
 * halves, and the write half is the one that has to be careful — a config the daemon
 * cannot parse takes down every host in the repo on its next start.
 *
 * So the candidate is validated with the same parser {@link loadConfig} uses BEFORE
 * anything is written, and the write itself is a temp file plus a rename, which is atomic
 * on every filesystem weft supports. A reader never sees half a config.
 *
 * The temp name is per-request and created exclusively. A name derived from the process
 * id alone is the SAME name for every concurrent PUT in one daemon, and two overlapping
 * writes to it interleave into invalid JSON — which every host in the repo then refuses to
 * load, so the next `weft` command of any kind fails until someone edits the file by hand.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Weft } from "@techery/weft-host";
import { CONFIG_FILE, configPath, parseConfig } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail, jsonBody } from "../http.ts";

export function registerConfigRoutes(app: Hono, weft: Weft): void {
  app.get("/api/config", async (c) => {
    const file = configPath(weft.cwd);
    try {
      let raw: unknown = {};
      let exists = true;
      try {
        raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      } catch (err) {
        if (!isAbsent(err)) throw err;
        exists = false;
      }
      return c.json({
        file: CONFIG_FILE,
        path: file,
        exists,
        // What is on disk, and what the running engine resolved it to. They differ by
        // every default, which is exactly what a settings screen needs to show.
        config: raw,
        effective: {
          defaults: weft.engine.config.defaults,
          limits: weft.engine.config.limits,
          approvalPolicy: weft.engine.config.approvalPolicy,
          fetchAllow: weft.engine.config.fetchAllow ?? null,
          providers: weft.engine.config.providers,
        },
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.put("/api/config", async (c) => {
    const file = configPath(weft.cwd);
    try {
      const body = await jsonBody(c);
      // The body IS the file: a settings screen holds the whole object, and a partial
      // merge here would make "remove this setting" impossible to express.
      const validated = parseConfig(body, CONFIG_FILE);

      const text = `${JSON.stringify(body, null, 2)}\n`;
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        // "wx" fails rather than truncating: this path is ours alone, and if it somehow
        // is not, refusing beats writing over whatever is there.
        await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
        await rename(temp, file);
      } catch (err) {
        await unlink(temp).catch(() => undefined);
        throw err;
      }

      return c.json({
        ok: true,
        path: file,
        config: validated,
        // This process resolved its engine config at startup. Saying so is honest;
        // silently serving a stale `effective` afterwards would not be.
        restartRequired: true,
      });
    } catch (err) {
      return fail(c, err);
    }
  });
}

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
