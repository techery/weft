import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];

/** A throwaway repo root; every test that writes `.weft/**` gets its own. */
export async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "weft-host-"));
  roots.push(dir);
  return dir;
}

export async function write(dir: string, file: string, content: string): Promise<string> {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  const workflowMain = file.match(/^(.*\/workflows\/[^/]+)\/main\.ts$/);
  if (workflowMain?.[1]) {
    const packageDir = path.join(dir, workflowMain[1]);
    await Promise.all([
      mkdir(path.join(packageDir, "lib"), { recursive: true }),
      mkdir(path.join(packageDir, "tests"), { recursive: true }),
      writeFile(path.join(packageDir, "CHANGELOG.md"), "# Test workflow changelog\n", "utf8"),
    ]);
  }
  await writeFile(target, content, "utf8");
  return target;
}

export async function cleanupRoots(): Promise<void> {
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
  roots.length = 0;
}

/** A workflow that touches nothing but `ctx.now` and `ctx.log` — no provider, no fs. */
export const HELLO_WORKFLOW = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    description: "greets, and stamps the greeting with journaled time",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string(), at: z.number() }),
  },
  async (ctx, input) => {
    ctx.log(\`greeting \${input.name}\`);
    return { greeting: \`hello \${input.name}\`, at: await ctx.now() };
  },
);
`;
