/// <reference types="vite/client" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import pkg from "../../package.json" with { type: "json" };

/**
 * Bundle-attribution build: the same inputs as `vite.config.ts`, minus the single-file
 * inliner, plus a source map, so `tools/analysis/bundleAttribution.mjs` can attribute
 * every byte of the production JS chunk to the source module that produced it.
 *
 *   corepack pnpm exec vite build --config tools/analysis/vite.attribution.config.ts
 *   node tools/analysis/bundleAttribution.mjs
 *
 * Output goes to `dist/analyze/` (git-ignored with the rest of `dist/`). The chunk it
 * produces is within 0.1 % of the `<script>` payload of `dist/index.html` — the single-file
 * build inlines the same chunk and adds the base64 fonts and the stylesheet.
 */
export default defineConfig({
  plugins: [svelte()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "es2022",
    outDir: "dist/analyze",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 12 * 1024,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
