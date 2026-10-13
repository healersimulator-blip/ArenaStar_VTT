/**
 * Every Chromium spec belongs to exactly one bounded batch (`E2E_BATCHES.md`).
 *
 * The suite has 138 spec files and 429 tests. `pnpm test:e2e` runs all of them and is documented
 * as the one command that does *not* respect the 25-minute rule (`README.md`), so in practice the
 * batches are how the suite gets run — and a spec that belongs to no batch is a spec that stops
 * being run. That is not hypothetical: 89 of the 138 files were outside every batch when this file
 * was written, and two of them had rotted (a canvas-rail tool count and a renamed hotbar selector,
 * D-457). The coverage rule below is the thing that keeps them from rotting again, so it is a test
 * rather than a paragraph in a document.
 *
 * What is asserted, and why each one:
 *
 * - **Coverage.** Every `e2e/*.spec.ts` is named by at least one `test*` script. Adding a spec
 *   without a batch fails here, at unit-test speed, instead of silently leaving the suite.
 * - **Once.** No spec is named by two *different* batches. Duplicates are not failures in
 *   Playwright, they are wasted minutes in a 2-CPU sandbox — and worse, they hide a spec that was
 *   copied into a new batch instead of being moved out of the old one.
 * - **Bounded.** Every script that names specs declares a `--global-timeout` of at most
 *   `MAX_BATCH_MS`. The cap is what makes one batch a unit of work a person can start and finish.
 * - **Repeatable.** Every such script names its project explicitly, so a batch never silently
 *   becomes a Chromium + Firefox + WebKit run (D-082 keeps those separate, deliberate runs).
 * - **Real files.** Every named path exists. A typo would otherwise shrink a batch in silence.
 *
 * The exhaustive `test:e2e` script is exempt: it names no specs on purpose (Playwright's default
 * `testDir` is the whole suite) and is allowed to be the long one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** The repository's own budget (`README.md`): no test command takes more than 25 minutes. */
const MAX_BATCH_MS = 25 * 60 * 1000;

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const specFiles = readdirSync(join(repoRoot, "e2e"))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();

/** `e2e/<name>.spec.ts` mentions in one command line, in the order they appear. */
function specNames(command: string): string[] {
  return [...command.matchAll(/e2e\/([\w-]+\.spec\.ts)/g)].map((match) => match[1] as string);
}

/** Scripts that name at least one spec, keyed by script name. `test:e2e` is the exemption. */
const batches: Array<{ name: string; command: string; specs: string[] }> = Object.entries(
  packageJson.scripts,
)
  .filter(([name]) => name.startsWith("test") && name !== "test:e2e")
  .map(([name, command]) => ({ name, command, specs: specNames(command) }))
  .filter((batch) => batch.specs.length > 0);

describe("e2e batch coverage", () => {
  test("the batch table is not empty (the guard would pass vacuously otherwise)", () => {
    expect(batches.length).toBeGreaterThanOrEqual(5);
    expect(specFiles.length).toBeGreaterThanOrEqual(100);
  });

  test("every spec belongs to a batch", () => {
    const covered = new Set(batches.flatMap((batch) => batch.specs));
    const missing = specFiles.filter((name) => !covered.has(name));
    expect(
      missing,
      "no test* script names these files — add each one to a batch in package.json (see E2E_BATCHES.md)",
    ).toEqual([]);
  });

  test("no spec belongs to two batches", () => {
    const owners = new Map<string, string[]>();
    for (const batch of batches) {
      for (const spec of new Set(batch.specs)) {
        owners.set(spec, [...(owners.get(spec) ?? []), batch.name]);
      }
    }
    const duplicated = [...owners].filter(([, names]) => names.length > 1);
    expect(
      duplicated,
      "a spec in two batches runs twice; move it out of the old batch instead of copying it",
    ).toEqual([]);
  });

  test("every named spec file exists", () => {
    const known = new Set(specFiles);
    const unknown = batches
      .flatMap((batch) => batch.specs.map((spec) => ({ batch: batch.name, spec })))
      .filter(({ spec }) => !known.has(spec))
      .map(({ batch, spec }) => `${batch} → e2e/${spec}`);
    expect(unknown, "a batch names a file that does not exist — a typo silently shrinks a batch").toEqual([]);
  });

  test("every batch is bounded and repeatable", () => {
    for (const batch of batches) {
      const timeout = /--global-timeout=(\d+)/.exec(batch.command)?.[1];
      expect(timeout, `${batch.name} declares no --global-timeout`).toBeDefined();
      expect(
        Number(timeout),
        `${batch.name} exceeds the ${MAX_BATCH_MS} ms budget one batch is allowed to take`,
      ).toBeLessThanOrEqual(MAX_BATCH_MS);
      expect(batch.command, `${batch.name} must name its Playwright project explicitly`).toMatch(
        /--project=\S+/,
      );
    }
  });
});
