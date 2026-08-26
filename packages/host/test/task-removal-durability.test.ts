import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRoots, tempRoot } from "./helpers.ts";

const events = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags: string | number, ...rest: unknown[]) => {
      const handle = await Reflect.apply(actual.open, actual, [path, flags, ...rest]);
      if (flags !== "r") return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              events.push(`sync-directory:${path}`);
              return target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    unlink: async (path: string) => {
      if (path.endsWith(".json")) events.push(`unlink-task:${path}`);
      return actual.unlink(path);
    },
  };
});

const { TaskStore } = await import("../src/tasks.ts");

afterAll(cleanupRoots);
beforeEach(() => events.splice(0));

describe("TaskStore removal durability", () => {
  it("syncs the workflow directory after unlinking a task", async () => {
    const root = await tempRoot();
    const taskRoot = join(root, ".weft", "tasks");
    const workflowDir = join(taskRoot, "review");
    const store = new TaskStore(taskRoot);
    const task = await store.create("review", {
      title: "Remove me",
      description: "The deletion must survive a crash after remove returns",
    });

    events.splice(0);
    await store.remove("review", task.id);

    expect(events).toEqual([
      `unlink-task:${join(workflowDir, `${task.id}.json`)}`,
      `sync-directory:${workflowDir}`,
    ]);
    await expect(readFile(join(workflowDir, `${task.id}.json`), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
