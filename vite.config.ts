/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json";

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
