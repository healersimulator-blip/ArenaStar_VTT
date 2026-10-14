/**
 * D-475 — the package-UI build step. A system package's `ui.js` is Svelte's compiled output with
 * every `svelte*` import turned into a read from the shell's runtime global, so the file is
 * self-contained apart from that one contract. The real bundle is exercised end to end by
 * `tests/packages/pf1ePackage.test.ts`; this pins the rewrite rules themselves.
 */
import { describe, expect, test } from "vitest";
import {
  rewriteSvelteRuntimeImports,
  SVELTE_RUNTIME_GLOBAL,
  SVELTE_RUNTIME_MODULES,
} from "../../scripts/buildSystemPackages.mjs";
import {
  SVELTE_RUNTIME_GLOBAL as SHELL_GLOBAL,
  SVELTE_RUNTIME_MODULES as SHELL_MODULES,
} from "../../src/app/svelteRuntime";

describe("rewriteSvelteRuntimeImports", () => {
  test("the build and the shell agree on the global and the module list", () => {
    expect(SVELTE_RUNTIME_GLOBAL).toBe(SHELL_GLOBAL);
    expect([...SVELTE_RUNTIME_MODULES]).toEqual([...SHELL_MODULES]);
  });

  test("namespace, named (with aliases) and default imports become reads from the global behind one guard", () => {
    const out = rewriteSvelteRuntimeImports(
      [
        'import "svelte/internal/disclose-version";',
        'import * as $ from "svelte/internal/client";',
        'import { onMount, getContext as ctx } from "svelte";',
        'import writable from "svelte/store";',
        "const x = $.template;",
      ].join("\n"),
      "probe",
    );
    expect(out.startsWith(`const __arenaSvelte = globalThis[${JSON.stringify(SVELTE_RUNTIME_GLOBAL)}];`)).toBe(true);
    expect(out).toContain("arena.ui/1: the shell has not exposed its Svelte runtime");
    expect(out).not.toContain("disclose-version");
    expect(out).toContain('const $ = __arenaSvelte["svelte/internal/client"];');
    expect(out).toContain('const { onMount, getContext: ctx } = __arenaSvelte["svelte"];');
    expect(out).toContain('const writable = __arenaSvelte["svelte/store"].default;');
    expect(out.match(/^\s*import\b/m)).toBeNull();
  });

  test("a file that imports no svelte module is returned untouched, without the guard", () => {
    const source = "const a = 1;\nexport default a;\n";
    expect(rewriteSvelteRuntimeImports(source, "probe")).toBe(source);
  });

  test("a svelte module the shell does not expose, or a side-effect import, fails the build by name", () => {
    expect(() => rewriteSvelteRuntimeImports('import { tick } from "svelte/legacy";', "probe")).toThrow(/svelte\/legacy/);
    expect(() => rewriteSvelteRuntimeImports('import "svelte/internal/flags/legacy";', "probe")).toThrow(/side-effect import/);
  });

  test("non-svelte imports are left for the self-containment guard to reject", () => {
    const out = rewriteSvelteRuntimeImports('import { x } from "left-over";\nimport * as $ from "svelte/internal/client";', "probe");
    expect(out).toContain('import { x } from "left-over";');
  });
});
