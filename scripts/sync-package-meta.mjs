#!/usr/bin/env node
/**
 * Every published package needs a LICENSE and a README beside it — npm renders the README
 * on the package page and shows "no license" without the file, and neither is worth keeping
 * in sync by hand across sixteen directories.
 *
 *   node scripts/sync-package-meta.mjs           # write them
 *   node scripts/sync-package-meta.mjs --check   # fail if what is on disk has drifted (CI)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/techery/weft";
const check = process.argv.includes("--check");
const license = readFileSync("LICENSE", "utf8");

/** The install line a reader of this package's npm page needs first. */
function install(pkg) {
  return pkg.bin ? `npm i -g ${pkg.name}` : `npm i ${pkg.name}`;
}

function readme(pkg, dir) {
  return `# ${pkg.name}

${pkg.description}

Part of [Weft](${REPO}) — durable, journaled, schema-validated multi-agent coding workflows
in TypeScript. This package is not usually installed on its own; see the
[project README](${REPO}#readme) for what Weft is and how the pieces fit together.

\`\`\`bash
${install(pkg)}
\`\`\`

- Source: [\`packages/${dir}\`](${REPO}/tree/main/packages/${dir})
- Issues: ${REPO}/issues
- License: MIT
`;
}

const drift = [];
const compare = (file, want) => {
  let have;
  try {
    have = readFileSync(file, "utf8");
  } catch {
    have = null;
  }
  if (have === want) return;
  if (check) {
    drift.push(`${file} ${have === null ? "is missing" : "is out of date"}`);
    return;
  }
  writeFileSync(file, want);
  console.log(`wrote ${file}`);
};

for (const dir of readdirSync("packages")) {
  const pkg = JSON.parse(readFileSync(join("packages", dir, "package.json"), "utf8"));
  compare(join("packages", dir, "LICENSE"), license);
  compare(join("packages", dir, "README.md"), readme(pkg, dir));
}

if (drift.length) {
  console.error("package metadata is out of sync:");
  for (const line of drift) console.error(`  ${line}`);
  console.error("\nrun `pnpm sync:meta` and commit the result");
  process.exit(1);
}
