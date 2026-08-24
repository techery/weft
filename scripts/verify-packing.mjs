#!/usr/bin/env node
/**
 * Pack every publishable package and check the tarball is actually installable.
 *
 * The failure modes this catches are all silent ones: `exports` still pointing at
 * TypeScript source because publishConfig did not apply, a `workspace:*` specifier that
 * never got rewritten, a bin that is not in `files`, a package with no build output.
 * Run it after `pnpm build`, before publishing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "weft-pack-"));
const problems = [];
let packed = 0;

try {
  for (const dir of readdirSync("packages")) {
    const src = JSON.parse(readFileSync(join("packages", dir, "package.json"), "utf8"));
    if (src.private) continue;

    execFileSync("pnpm", ["pack", "--pack-destination", out], {
      cwd: join("packages", dir),
      stdio: ["ignore", "ignore", "pipe"],
    });
    packed++;

    const tarball = join(
      out,
      readdirSync(out).find((f) => f.endsWith(".tgz")),
    );
    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^package\//, ""));
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    rmSync(tarball);

    const fail = (msg) => problems.push(`${src.name}: ${msg}`);
    const has = (file) => entries.includes(file.replace(/^\.\//, ""));

    // publishConfig has to have replaced the source-pointing exports.
    const main = manifest.exports?.["."];
    const target = typeof main === "string" ? main : main?.default;
    const types = typeof main === "string" ? undefined : main?.types;
    if (!target?.startsWith("./dist/")) fail(`exports resolve to ${target}, not ./dist/`);
    else if (!has(target)) fail(`exports point at ${target}, which is not in the tarball`);
    if (types && !has(types)) fail(`types point at ${types}, which is not in the tarball`);

    for (const [name, file] of Object.entries(manifest.bin ?? {})) {
      if (!has(file)) fail(`bin "${name}" points at ${file}, which is not in the tarball`);
    }

    // A `workspace:` range that survives into the tarball breaks `npm i` for everyone.
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith("workspace:")) fail(`${field}.${dep} is still "${range}"`);
      }
    }

    for (const file of ["README.md", "LICENSE"]) if (!has(file)) fail(`${file} is missing`);
    if (!entries.some((f) => f.startsWith("dist/"))) fail("tarball has no dist/ — was it built?");
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`packing check failed for ${problems.length} of ${packed} packages:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`packing check passed for ${packed} packages`);
