/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: "0.0.0.0",
    // Arena's live preview uses a generated *.e2b.app host. Vite's default
    // allow-list rejects it with 403 even though the server is reachable.
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 12 * 1024,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
