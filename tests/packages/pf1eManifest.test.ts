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

const manifestPath = fileURLToPath(new URL("../../systems/pf1e-mass-battles/manifest.json", import.meta.url));
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

  test("the manifest still declares rules.js, which the repo does not build yet (Gap List §1.1)", () => {
    // Guards against "fixing" §1.2 by quietly dropping the rules entry: packageLoader
    // rejects a `type: "system"` package whose `rules.entry` file is absent, so PF1e stays
    // unloadable as a package until the bundling step lands. Delete this test in M2.
    expect(manifest.rules?.entry).toBe("rules.js");
    expect(() => readFileSync(fileURLToPath(new URL("../../systems/pf1e-mass-battles/rules.js", import.meta.url)))).toThrow();
  });
});
