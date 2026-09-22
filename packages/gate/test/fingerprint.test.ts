import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { bundleWorkflow, fingerprintBundle, loadWorkflow } from "../src/index.ts";

const workflowSource = (module: string) => `import { defineWorkflow, z } from "@techery/weft-sdk";
import { value } from ${JSON.stringify(module)};
export default defineWorkflow({name:"fingerprint",description:"fixture",input:z.object({}),output:z.number()},async()=>value);`;

async function packageFixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "weft-external-fingerprint-"));
  await mkdir(path.join(cwd, "lib"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fingerprint-fixture", version: "1.0.0", type: "module" }),
  );
  await writeFile(path.join(cwd, "entry.js"), 'export { value } from "./lib/value.js";\n');
  await writeFile(path.join(cwd, "lib/value.js"), "export const value = 1;\n");
  const module = pathToFileURL(path.join(cwd, "entry.js")).href;
  return {
    cwd,
    module,
    code: `const external = require(${JSON.stringify(module)});`,
    options: { allowBare: [module] },
  };
}

test("external helper edits change executable identity without a package-version or workflow-source edit", async () => {
  const fixture = await packageFixture();
  try {
    const source = `import { defineWorkflow, z } from "@techery/weft-sdk"; import { value } from ${JSON.stringify(fixture.module)};
      export default defineWorkflow({name:"fingerprint",description:"fixture",input:z.object({}),output:z.number()},async()=>value);`;
    const first = await bundleWorkflow({ source, cwd: fixture.cwd, ...fixture.options });
    await writeFile(path.join(fixture.cwd, "lib/value.js"), "export const value = 2;\n");
    const changed = await bundleWorkflow({ source, cwd: fixture.cwd, ...fixture.options });
    expect(changed.code).toBe(first.code);
    expect(changed.hash).not.toBe(first.hash);
    expect(await fingerprintBundle(changed.code, fixture.options)).toBe(changed.hash);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("unimported docs and tests do not change the bounded executable graph", async () => {
  const fixture = await packageFixture();
  try {
    const first = await fingerprintBundle(fixture.code, fixture.options);
    await writeFile(path.join(fixture.cwd, "README.md"), "Changed documentation\n");
    await writeFile(path.join(fixture.cwd, "lib/value.test.js"), "throw new Error('never imported');\n");
    expect(await fingerprintBundle(fixture.code, fixture.options)).toBe(first);
    await writeFile(
      path.join(fixture.cwd, "package.json"),
      JSON.stringify({ name: "fingerprint-fixture", version: "1.0.1", type: "module" }),
    );
    expect(await fingerprintBundle(fixture.code, fixture.options)).not.toBe(first);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("nested package manifests that affect module interpretation participate in the fingerprint", async () => {
  const fixture = await packageFixture();
  try {
    await writeFile(path.join(fixture.cwd, "lib/package.json"), JSON.stringify({ type: "module" }));
    const first = await fingerprintBundle(fixture.code, fixture.options);
    await writeFile(
      path.join(fixture.cwd, "lib/package.json"),
      JSON.stringify({ type: "module", sideEffects: false }),
    );
    expect(await fingerprintBundle(fixture.code, fixture.options)).not.toBe(first);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("missing and dynamic external dependencies refuse an incomplete fingerprint", async () => {
  await expect(
    fingerprintBundle('require("weft-fingerprint-missing-package");', {
      allowBare: ["weft-fingerprint-missing-package"],
    }),
  ).rejects.toThrow(/Cannot fingerprint/);
  const fixture = await packageFixture();
  try {
    await writeFile(
      path.join(fixture.cwd, "entry.js"),
      "export async function value(name) { return import(name); }\n",
    );
    await expect(fingerprintBundle(fixture.code, fixture.options)).rejects.toThrow(
      /unresolved dynamic module/,
    );
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("conditional exports follow each nested import or require edge", async () => {
  const fixture = await packageFixture();
  try {
    const dual = path.join(fixture.cwd, "node_modules/dual");
    await mkdir(dual, { recursive: true });
    await writeFile(
      path.join(dual, "package.json"),
      JSON.stringify({
        name: "dual",
        version: "1.0.0",
        type: "module",
        exports: { import: "./import.js", require: "./require.cjs" },
      }),
    );
    await writeFile(path.join(dual, "import.js"), "export const value = 1;\n");
    await writeFile(path.join(dual, "require.cjs"), "module.exports = { value: 1 };\n");
    const entry = path.join(fixture.cwd, "entry.cjs");
    await writeFile(entry, 'module.exports = require("dual");\n');
    const module = pathToFileURL(entry).href;
    const code = `require(${JSON.stringify(module)});`;
    const options = { allowBare: [module] };
    const initial = await fingerprintBundle(code, options);
    await writeFile(path.join(dual, "import.js"), "export const value = 2;\n");
    expect(await fingerprintBundle(code, options)).toBe(initial);
    await writeFile(path.join(dual, "require.cjs"), "module.exports = { value: 3 };\n");
    expect(await fingerprintBundle(code, options)).not.toBe(initial);
    expect(createRequire(entry)("dual").value).toBe(3);

    await writeFile(path.join(fixture.cwd, "entry.js"), 'export { value } from "dual";\n');
    const imported = await fingerprintBundle(fixture.code, fixture.options);
    await writeFile(path.join(dual, "require.cjs"), "module.exports = { value: 4 };\n");
    expect(await fingerprintBundle(fixture.code, fixture.options)).toBe(imported);
    await writeFile(path.join(dual, "import.js"), "export const value = 5;\n");
    expect(await fingerprintBundle(fixture.code, fixture.options)).not.toBe(imported);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("a loaded external helper cannot acquire a new hash while Node still caches its old code", async () => {
  const fixture = await packageFixture();
  try {
    const options = { source: workflowSource(fixture.module), cwd: fixture.cwd, ...fixture.options };
    const first = await loadWorkflow(options);
    expect(await first.def.run({} as never, {})).toBe(1);
    expect((await loadWorkflow(options)).hash).toBe(first.hash);
    await writeFile(path.join(fixture.cwd, "lib/value.js"), "export const value = 2;\n");
    expect((await bundleWorkflow(options)).hash).not.toBe(first.hash);
    await expect(loadWorkflow(options)).rejects.toThrow(/changed after loading.*restart the host/);

    // A newly imported wrapper still shares the cached helper with the first one.
    const alias = pathToFileURL(path.join(fixture.cwd, "alias.js")).href;
    await writeFile(path.join(fixture.cwd, "alias.js"), 'export { value } from "./lib/value.js";\n');
    await expect(
      loadWorkflow({
        source: workflowSource(alias),
        cwd: fixture.cwd,
        allowBare: [alias],
      }),
    ).rejects.toThrow(/changed after loading.*restart the host/);

    const current = await bundleWorkflow(options);
    const restarted = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { loadWorkflow } from ${JSON.stringify(new URL("../src/load.ts", import.meta.url).href)};
       const loaded = await loadWorkflow(${JSON.stringify(options)});
       console.log(JSON.stringify({ hash: loaded.hash, value: await loaded.def.run({}, {}) }));`,
    ]);
    expect(JSON.parse(restarted.stdout)).toEqual({ hash: current.hash, value: 2 });
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("unused configured dependencies do not enter the host module cache", async () => {
  const fixture = await packageFixture();
  try {
    await loadWorkflow({
      source:
        'import { defineWorkflow, z } from "@techery/weft-sdk"; export default defineWorkflow({description:"fixture",input:z.object({}),output:z.number()}, async()=>0);',
      cwd: fixture.cwd,
      ...fixture.options,
    });
    await writeFile(path.join(fixture.cwd, "lib/value.js"), "export const value = 2;\n");
    const loaded = await loadWorkflow({
      source: workflowSource(fixture.module),
      cwd: fixture.cwd,
      ...fixture.options,
    });
    expect(await loaded.def.run({} as never, {})).toBe(2);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test.each([
  ['export async function value() { return (await import("./lib/value.js")).value; }', "entry.js"],
  ['exports.value = () => require("./lazy.cjs").value;', "entry.cjs"],
])("deferred dependencies cannot execute new bytes after fingerprinting: %s", async (source, entry) => {
  const fixture = await packageFixture();
  try {
    await writeFile(path.join(fixture.cwd, entry), source);
    await writeFile(path.join(fixture.cwd, "lazy.cjs"), "exports.value = 1;");
    const module = pathToFileURL(path.join(fixture.cwd, entry)).href;
    await expect(
      loadWorkflow({
        source: workflowSource(module),
        cwd: fixture.cwd,
        allowBare: [module],
      }),
    ).rejects.toThrow(/deferred module import/);
  } finally {
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

import { execFile } from "node:child_process";
