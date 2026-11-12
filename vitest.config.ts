import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Workspace packages are consumed from source in tests, not from their dist builds.
const resolve = {
  alias: [{ find: /^@policy\/([a-z]+)\/(.*)$/, replacement: `${root}packages/$1/src/$2.ts` }],
};

// Hard ceilings on every test, hook and teardown, so nothing can hang silently.
const limits = { testTimeout: 30_000, hookTimeout: 60_000, teardownTimeout: 30_000 };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: { ...limits, name: "unit", include: ["packages/*/test/unit/**/*.test.ts"], testTimeout: 10_000 },
      },
      {
        resolve,
        test: {
          ...limits,
          name: "handbuilt",
          include: ["packages/handbuilt/test/integration/**/*.test.ts", "packages/handbuilt/test/parity/**/*.test.ts"],
          // Integration files share one Postgres database, so run them one at a time.
          fileParallelism: false,
        },
      },
      {
        resolve,
        test: {
          ...limits,
          name: "temporal",
          include: ["packages/temporal/test/**/*.test.ts"],
          // Each file starts its own Temporal test server; keep them sequential for predictable timing.
          fileParallelism: false,
          testTimeout: 45_000,
          // Includes starting (and on first use downloading) the test server, itself capped at 90s.
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
