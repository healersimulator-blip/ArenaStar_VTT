/**
 * D-475: the shell publishes its own Svelte runtime for package components.
 *
 * A system package's `ui.js` is compiled with every `svelte*` import externalised
 * (`scripts/buildSystemPackages.mjs` → `rewriteSvelteRuntimeImports`) and reads them back from
 * `globalThis.__ARENASTAR_SVELTE__` at evaluation time. Sharing the runtime — rather than
 * bundling a second copy into the package — is what makes a package component a real citizen
 * of the shell's tree: same signals and scheduler, same `getContext`, same stores. It also means
 * a package is only ever built against the shell it ships with (first-party, hash-pinned by
 * D-473); a third-party `ui.js` compiled by another Svelte version may not evaluate, and the
 * loader reports that as the package's error, not the shell's.
 *
 * Exposed once, before any package UI can load (`main.ts`). Idempotent.
 */
import * as svelte from "svelte";
// The compiler's own output imports `svelte/internal/client`; a package component is compiled
// output, so this is the one place the shell has to name it. Pinned to the shell's Svelte version
// by the build (`pnpm-lock.yaml`), re-checked whenever Svelte is bumped.
// eslint-disable-next-line svelte/no-svelte-internal
import * as svelteInternalClient from "svelte/internal/client";
import * as svelteStore from "svelte/store";

export const SVELTE_RUNTIME_GLOBAL = "__ARENASTAR_SVELTE__";

/** The specifiers a package component may import; the build refuses anything else. */
export const SVELTE_RUNTIME_MODULES = ["svelte", "svelte/internal/client", "svelte/store"] as const;

export function exposeSvelteRuntime(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  if (target[SVELTE_RUNTIME_GLOBAL] !== undefined) return;
  target[SVELTE_RUNTIME_GLOBAL] = Object.freeze({
    svelte,
    "svelte/internal/client": svelteInternalClient,
    "svelte/store": svelteStore,
  });
}

export function svelteRuntimeExposed(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): boolean {
  return target[SVELTE_RUNTIME_GLOBAL] !== undefined;
}
