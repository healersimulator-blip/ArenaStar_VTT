import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      // §12 generated package artifacts (build step: pnpm build:systems)
      "systems/**/rules.js",
      // Pinned Foundry checkouts for the content converter (gitignored; they carry
      // their own eslint config, which must never be linted or even discovered)
      "tools/content/vendor/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      globals: { ...globals.browser, __APP_VERSION__: "readonly" },
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ["scripts/**/*.mjs", "tools/**/*.mjs", "vite.config.ts", "playwright.config.ts", "e2e/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
  ...svelte.configs["flat/prettier"],
);
