/**
 * Gap List §1.2 — the packaged system's declared model columns must be exactly the columns
 * the rules module uses. The host builds the deploy schema from `manifest.rules.modelColumns`
 * (`src/app/hostBoot.ts`), NOT from `PF1E_MODEL_SCHEMA`, so a column that exists only in the
 * latter is never allocated: reads return `undefined`, writes are dropped, and the column
 * disappears from diffs, hashes and joiner replicas.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";

const manifestPath = fileURLToPath(
  new URL("../../systems/pf1e-mass-battles/manifest.json", import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  id: string;
  type: string;
  rules?: { entry?: string; modelColumns?: Record<string, string> };
};

describe("systems/pf1e-mass-battles manifest (§12 / Gap List §1.2)", () => {
  test("rules.modelColumns matches PF1E_MODEL_SCHEMA exactly", () => {
    expect(manifest.rules?.modelColumns).toEqual({ ...PF1E_MODEL_SCHEMA });
  });

  test("every PF1e column the combat engine writes is declared, including the derived ACs", () => {
    const columns = Object.keys(manifest.rules?.modelColumns ?? {});
    for (const column of ["ac", "touchAc", "flatFootedAc", "nonlethal", "lethalDmg", "aooUsed", "profileIdx"]) {
      expect(columns, `manifest is missing the "${column}" column`).toContain(column);
    }
  });

  test("rules.entry names the generated bundle, and the builder knows how to make it (§1.1)", () => {
    // `systems/pf1e-mass-battles/rules.js` is a build product (git-ignored), emitted by
    // `pnpm build:systems` from `src/packages/pf1e/rulesEntry.ts`. The manifest must keep naming
    // exactly that file and the builder must keep the mapping — if either drifts, the package
    // installs with a missing rules entry and hostBoot silently degrades to the built-in rules.
    // The artifact itself (self-containment, schema echo, a real deployed turn) is covered by
    // `tests/packages/pf1ePackage.test.ts`, which runs the build.
    expect(manifest.rules?.entry).toBe("rules.js");
    const builder = readFileSync(
      fileURLToPath(new URL("../../scripts/buildSystemPackages.mjs", import.meta.url)),
      "utf8",
    );
    expect(builder).toContain('"pf1e-mass-battles": "src/packages/pf1e/rulesEntry.ts"');
  });
});
