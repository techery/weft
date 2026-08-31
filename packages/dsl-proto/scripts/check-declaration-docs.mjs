import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceDir = new URL("../src/core", import.meta.url).pathname;
const publicBarrel = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const declaration =
  /^export\s+(?:declare\s+)?(?:interface|type|function|const|namespace)\s+([A-Za-z_$][\w$]*)/;
const missing = [];

for (const file of readdirSync(sourceDir).filter((name) => name.endsWith(".ts") && name !== "index.ts")) {
  const lines = readFileSync(join(sourceDir, file), "utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    const match = line.match(declaration);
    if (!match) continue;
    if (!new RegExp(`\\b${match[1]}\\b`).test(publicBarrel)) continue;

    let end = index - 1;
    while (end >= 0 && lines[end]?.trim() === "") end -= 1;
    const inlineDoc = lines[end]?.trim();
    if (inlineDoc?.startsWith("/**") && inlineDoc.endsWith("*/")) {
      if (inlineDoc.replace(/[/*\s]/g, "").length === 0) {
        missing.push(`${file}:${index + 1} ${match[1]} has empty JSDoc`);
      }
      continue;
    }
    if (end < 0 || lines[end]?.trim() !== "*/") {
      missing.push(`${file}:${index + 1} ${match[1]} has no JSDoc`);
      continue;
    }

    let start = end;
    while (start >= 0 && lines[start]?.trim() !== "/**") start -= 1;
    if (start < 0) {
      missing.push(`${file}:${index + 1} ${match[1]} has an incomplete JSDoc block`);
      continue;
    }

    const docs = lines.slice(start, end + 1).join("\n");
    if (docs.replace(/[/*\s]/g, "").length === 0) {
      missing.push(`${file}:${index + 1} ${match[1]} has empty JSDoc`);
    }
  }
}

if (missing.length > 0) {
  console.error("Declaration surface check failed:\n");
  for (const problem of missing) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("Public declaration documentation check passed");
