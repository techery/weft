import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    name: "example-effects",
    description: "Minimal filesystem, process, HTTP, environment, secret, and check effects.",
    input: z.object({ path: z.string().default("package.json"), url: z.string().url() }),
    output: z.object({ bytes: z.number(), files: z.number(), status: z.number() }),
  },
  async (ctx, input) => {
    const stat = await ctx.fs.stat(input.path);
    const read = await ctx.fs.read(input.path);
    const { paths } = await ctx.fs.glob(["packages/*/package.json"]);
    await ctx.env.get("CI");
    const token = ctx.secret("EXAMPLE_TOKEN");
    await ctx.exec("node", ["-e", "console.log('ok')"], { key: "exec", env: { EXAMPLE_TOKEN: token } });
    await ctx.bash("node -e 'console.log(JSON.stringify({ok:true}))'", {
      key: "bash",
      schema: z.object({ ok: z.boolean() }),
    });
    const response = await ctx.fetch(input.url, { key: "fetch", headers: { authorization: token } });
    await ctx.check.exec("command", ["node", "--version"], { required: true });
    await ctx.check.fn("function", () => true);
    await ctx.check.trust("trusted", { run: "documented-run", reason: "example only" });
    await ctx.check.skip("platform-only", "not available in this portable example");
    return { bytes: stat.size ?? read.size, files: paths.length, status: response.status };
  },
);
