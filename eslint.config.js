import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
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
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", fetch: "readonly", process: "readonly", setTimeout: "readonly" },
    },
  },
);
