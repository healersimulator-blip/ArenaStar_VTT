/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D-473: ArenaStar's own packages ship inside the shell. `pnpm build:systems` writes
 * `systems/.first-party/index.json` + zips; they are inlined here (zip as base64, plus the
 * sha256 of each system package's `rules.js`) so a fresh world can activate the PF1e package
 * with no file on disk and a player shell can recognise a first-party rules artifact. A tree
 * without the build step (plain `vite dev`, a bare checkout) gets an empty list and the shell
 * falls back to the built-in rules — nothing fails, the wizard just offers less.
 */
function firstPartyPackages(): Array<Record<string, unknown>> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "systems", ".first-party");
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) {
    // D-481: a shell built without the embed set is a different product (the default world cannot
    // activate the first-party PF1e package and players are prompted for the GM's rules), so say
    // so where a build log is read. `systems/.first-party/` is gitignored: a fresh checkout or a
    // restored sandbox needs `node scripts/buildSystemPackages.mjs` *before* `vite build`.
    if (process.env.NODE_ENV === "production" || process.argv.includes("build"))
      console.warn("[vite.config] systems/.first-party/index.json is missing — building a shell with no first-party packages (run `pnpm build:systems` first)");
    return [];
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{
    id: string; name: string; version: string; type: string; dependencies: string[]; zip: string; rulesSha256: string | null; uiSha256?: string | null;
  }>;
  return index.map((entry) => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    type: entry.type,
    dependencies: entry.dependencies,
    rulesSha256: entry.rulesSha256,
    uiSha256: entry.uiSha256 ?? null,
    zipBase64: readFileSync(join(dir, entry.zip)).toString("base64"),
  }));
}

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FIRST_PARTY_PACKAGES__: JSON.stringify(firstPartyPackages()),
  },
  server: {
    host: "0.0.0.0",
    // Arena's live preview uses a generated *.e2b.app host. Vite's default
    // allow-list rejects it with 403 even though the server is reachable.
    allowedHosts: true,
    // Optional same-origin companion for development; browser URLs stay relative.
    ...(process.env.CLOUD_DEV_PROXY
      ? {
          proxy: {
            "/api/cloud": {
              target: process.env.CLOUD_DEV_PROXY,
              changeOrigin: false,
            },
          },
        }
      : {}),
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
