import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "**/cdk.out/**", "infra/.state/**", ".tools/**", "infra/.build/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // Fastify route handlers are idiomatically async even when they do not await.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Temporal workflow code is replayed from history and must be deterministic:
    // no wall clock, no randomness, no I/O. Side effects belong in activities.
    files: ["packages/temporal/src/workflows.ts", "packages/temporal/src/definitions.ts", "packages/temporal/test/fixtures/*Workflow.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Workflow code must be deterministic; use workflowInfo() or a timer." },
        { object: "Math", property: "random", message: "Workflow code must be deterministic; pass randomness in as input or use uuid4() from @temporalio/workflow." },
        { object: "performance", property: "now", message: "Workflow code must be deterministic." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "Workflow code must be deterministic; no new Date()." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "No I/O in workflow code; call an activity." },
        { name: "setTimeout", message: "Use sleep() or condition() from @temporalio/workflow." },
        { name: "setInterval", message: "Use sleep() or condition() from @temporalio/workflow." },
        { name: "process", message: "No process state in workflow code." },
        { name: "crypto", message: "No randomness in workflow code." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*", "fs", "http", "https", "net", "crypto", "child_process"], message: "No Node APIs in workflow code." },
            { group: ["@temporalio/activity", "@temporalio/client", "@temporalio/worker", "fastify", "pg"], message: "Workflow code may only import @temporalio/workflow and deterministic modules." },
            { group: ["@policy/domain/*", "!@policy/domain/stateMachine", "!@policy/domain/steps", "!@policy/domain/pricing"], message: "Only pure @policy/domain modules may be imported into workflow code." },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.mjs", "infra/bootstrap/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs", "infra/bootstrap/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", fetch: "readonly", process: "readonly", setTimeout: "readonly" },
    },
  },
);
