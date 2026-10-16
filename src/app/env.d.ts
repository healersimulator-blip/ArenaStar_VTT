/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json version. */
declare const __APP_VERSION__: string;

/**
 * D-473: injected by vite.config.ts `define` from `systems/.first-party/` (written by
 * `pnpm build:systems`). Absent (undefined) in a tree without that build step; read it only
 * through `src/app/firstPartyPackages.ts`, which tolerates both.
 */
declare const __FIRST_PARTY_PACKAGES__:
  | ReadonlyArray<{
      id: string;
      name: string;
      version: string;
      type: string;
      dependencies: readonly string[];
      rulesSha256: string | null;
      uiSha256?: string | null;
      zipBase64: string;
    }>
  | undefined;

/** D-475: the Svelte internals a package `ui.js` is compiled against; no typings ship for the path. */
declare module "svelte/internal/client";

// Allow .ts entry modules (e.g. main.ts) to import Svelte components under tsc.
// Deep .svelte typechecking is performed by the build (vite-plugin-svelte compiles
// each component with svelte 5's type-aware compiler).
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component;
  export default component;
}
