#!/usr/bin/env node
/**
 * Set one version across the workspace. Weft's packages are released together, so their
 * versions move together and the git tag names the release:
 *
 *   node scripts/set-version.mjs 0.2.0
 *   git commit -am "release: v0.2.0" && git tag v0.2.0 && git push --follow-tags
 *
 * Cross-package dependencies stay `workspace:*`; pnpm rewrites them to the real version
 * when it packs.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <version>   (e.g. 0.2.0, 0.2.0-rc.1)");
  process.exit(1);
}

const bump = (file) => {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} -> ${version}`);
};

bump("package.json");
for (const dir of readdirSync("packages")) bump(join("packages", dir, "package.json"));
