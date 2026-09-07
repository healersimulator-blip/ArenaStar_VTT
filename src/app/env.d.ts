/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json version. */
declare const __APP_VERSION__: string;

// Allow .ts entry modules (e.g. main.ts) to import Svelte components under tsc.
// Deep .svelte typechecking is performed by the build (vite-plugin-svelte compiles
// each component with svelte 5's type-aware compiler).
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component;
  export default component;
}
