/**
 * Typings for the parts of `buildSystemPackages.mjs` that tests import directly (D-475). The
 * script itself stays plain ESM so `node scripts/buildSystemPackages.mjs` needs no build step.
 */
export const SVELTE_RUNTIME_GLOBAL: string;
export const SVELTE_RUNTIME_MODULES: readonly string[];
export const FIRST_PARTY_DIR: string;
export function toSingleDefaultExpression(code: string, fileLabel: string): string;
export function rewriteSvelteRuntimeImports(code: string, fileLabel: string): string;
export function buildSystemPackages(opts?: {
  dryRun?: boolean;
  only?: string;
  zipDir?: string;
  outDir?: string;
}): Promise<Array<{ id: string; version: string; type: string; files: string[]; zip: string }>>;
