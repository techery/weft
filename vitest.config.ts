import { defineConfig } from "vitest/config";

/**
 * Two projects in one run: the engine's node suites, and the workflow manager's jsdom
 * suite. Chaining them as separate commands meant a failure in the first hid the second;
 * as projects, `pnpm test` reports both.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/*/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      "./apps/ui/vitest.config.ts",
    ],
  },
});
