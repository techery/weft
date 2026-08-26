import { defineWorkflow, z } from "@techery/weft-sdk";

const Operation = z.enum([
  "status",
  "head",
  "branches",
  "merge-base",
  "changed",
  "diff",
  "log",
  "show",
  "blame",
  "file-at",
  "snapshot",
  "add",
  "commit",
  "checkout",
  "fetch",
  "pull",
  "push",
  "reset",
  "apply",
  "tag",
  "branch-create",
  "branch-delete",
  "stash-push",
  "stash-pop",
  "stash-drop",
  "clean",
]);

export default defineWorkflow(
  {
    name: "example-git",
    description:
      "One minimal switch covering every journaled git operation; use mutations only in a throwaway repo.",
    input: z.object({ operation: Operation.default("status"), path: z.string().default("README.md") }),
    output: z.object({ operation: Operation }),
  },
  async (ctx, { operation, path }) => {
    switch (operation) {
      case "status":
        await ctx.git.status();
        break;
      case "head":
        await ctx.git.head();
        break;
      case "branches":
        await ctx.git.branches();
        break;
      case "merge-base":
        await ctx.git.mergeBase("HEAD", "HEAD");
        break;
      case "changed":
        await ctx.git.changedSince("HEAD~1");
        break;
      case "diff":
        await ctx.git.diff({ paths: [path] });
        break;
      case "log":
        await ctx.git.log({ max: 5 });
        break;
      case "show":
        await ctx.git.show("HEAD");
        break;
      case "blame":
        await ctx.git.blame(path, { lines: [1, 5] });
        break;
      case "file-at":
        await ctx.git.fileAt("HEAD", path);
        break;
      case "snapshot":
        await ctx.git.snapshot();
        break;
      case "add":
        await ctx.git.add({ paths: [path] });
        break;
      case "commit":
        await ctx.git.commit({ message: "example", paths: [path] });
        break;
      case "checkout":
        await ctx.git.checkout("HEAD", { discard: false });
        break;
      case "fetch":
        await ctx.git.fetch({ remote: "origin" });
        break;
      case "pull":
        await ctx.git.pull({ remote: "origin" });
        break;
      case "push":
        await ctx.git.push({ remote: "origin" });
        break;
      case "reset":
        await ctx.git.reset({ to: "HEAD", mode: "soft" });
        break;
      case "apply":
        await ctx.git.apply({ patch: "" });
        break;
      case "tag":
        await ctx.git.tag("example-tag", { ref: "HEAD" });
        break;
      case "branch-create":
        await ctx.git.branch.create("example-branch", { from: "HEAD" });
        break;
      case "branch-delete":
        await ctx.git.branch.delete("example-branch");
        break;
      case "stash-push":
        await ctx.git.stash.push({ message: "example" });
        break;
      case "stash-pop":
        await ctx.git.stash.pop();
        break;
      case "stash-drop":
        await ctx.git.stash.drop();
        break;
      case "clean":
        await ctx.git.clean({ force: false });
        break;
    }
    return { operation };
  },
);
