import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Workspace packages are consumed from source in tests, not from their dist builds.
const resolve = {
  alias: [{ find: /^@policy\/([a-z]+)\/(.*)$/, replacement: `${root}packages/$1/src/$2.ts` }],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          include: ["packages/*/test/unit/**/*.test.ts"],
        },
      },
      {
        resolve,
        test: {
          name: "handbuilt",
          include: ["packages/handbuilt/test/integration/**/*.test.ts", "packages/handbuilt/test/parity/**/*.test.ts"],
          // Integration files share one Postgres database, so run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
