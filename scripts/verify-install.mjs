#!/usr/bin/env node
/**
 * Install the packed tarballs the way a user would, then run the CLI and the MCP server out
 * of that install. This is the check that catches what static inspection cannot: a package
 * that resolves to TypeScript under plain node, a missing runtime dependency, a bin that
 * imports something `files` left out.
 *
 * Needs the registry (for third-party dependencies) and a prior `pnpm build`.
 *
 *   pnpm build && pnpm verify:install
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "weft-install-"));
const tarballs = join(dir, "tarballs");
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

try {
  // Pack every workspace package, and pin each name to its tarball. Without the overrides
  // npm would go looking for these versions on the registry, where they do not exist yet.
  const external = {};
  const overrides = {};
  for (const pkgDir of readdirSync(join(root, "packages"))) {
    const cwd = join(root, "packages", pkgDir);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (pkg.private) continue;
    run("pnpm", ["pack", "--pack-destination", tarballs], { cwd });
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!range.startsWith("workspace:")) external[dep] = range;
    }
  }
  for (const file of readdirSync(tarballs)) {
    const name = JSON.parse(run("tar", ["-xzOf", join(tarballs, file), "package/package.json"])).name;
    overrides[name] = `file:${resolve(tarballs, file)}`;
  }

  // The two entry points are direct dependencies; npm refuses an override that restates a
  // direct dependency, so the rest of the workspace is pinned through `overrides` alone.
  const entries = ["@techery/weft", "@techery/weft-mcp"];
  const direct = Object.fromEntries(entries.map((name) => [name, overrides[name]]));
  for (const name of entries) delete overrides[name];

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "weft-install-check",
        private: true,
        type: "module",
        dependencies: { ...external, ...direct },
        overrides,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`installing ${Object.keys(overrides).length + entries.length} packed packages into ${dir}`);
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: dir });

  // tsx is a devDependency of the CLI, so it is absent here on purpose: whatever runs below
  // is running as compiled ESM under plain node, with no loader in the way.
  const cli = join(dir, "node_modules", ".bin", "weft");
  const checks = [
    ["weft --help", () => run(cli, ["--help"], { cwd: dir }), (out) => out.includes("Commands:")],
    ["weft doctor", () => run(cli, ["doctor"], { cwd: dir }), (out) => out.includes("node")],
    [
      "weft new + check",
      () => {
        run("git", ["init", "-q", "."], { cwd: dir });
        run(cli, ["new", "probe"], { cwd: dir });
        return run(cli, ["check"], { cwd: dir });
      },
      (out) => out.includes("probe/main.ts"),
    ],
    [
      "weft-mcp initialize",
      () =>
        run(join(dir, "node_modules", ".bin", "weft-mcp"), [], {
          cwd: dir,
          input: `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "verify", version: "0" },
            },
          })}\n`,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      (out) => out.includes('"serverInfo"'),
    ],
    // `weft ui` serves the workflow manager out of the daemon's own `web/`, found by a
    // path relative to the module. That lookup runs from `dist/` in a real install and
    // from `src/` in the repo, so it is worth proving out of the install rather than only
    // where the source tree happens to sit.
    [
      "daemon finds the bundled workflow manager",
      () =>
        run(
          "node",
          [
            "--input-type=module",
            "-e",
            [
              'import { BUNDLED_WEB_ROOT, openWebBundle } from "@techery/weft-daemon";',
              "const web = openWebBundle(BUNDLED_WEB_ROOT);",
              'if (!web) throw new Error("no bundle at " + BUNDLED_WEB_ROOT);',
              'if (!web.index.includes("<div id=\\"root\\">")) throw new Error("not the manager document");',
              'const asset = await web.read((web.index.match(/src="(\\/assets\\/[^"]+)"/) ?? [])[1] ?? "");',
              'if (!asset) throw new Error("the document asks for an asset the bundle does not have");',
              'console.log("manager ok");',
            ].join(""),
          ],
          { cwd: dir },
        ),
      (out) => out.includes("manager ok"),
    ],
  ];

  let failed = 0;
  for (const [label, exec, ok] of checks) {
    try {
      const out = exec();
      if (ok(out)) {
        console.log(`  ok   ${label}`);
      } else {
        failed++;
        console.error(`  FAIL ${label}: unexpected output\n${out.slice(0, 600)}`);
      }
    } catch (err) {
      failed++;
      const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").slice(0, 900);
      console.error(`  FAIL ${label}\n${detail || err.message}`);
    }
  }

  if (failed) {
    console.error(`\ninstall check failed: ${failed} of ${checks.length}`);
    process.exit(1);
  }
  console.log(`\ninstall check passed: ${checks.length} of ${checks.length}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
