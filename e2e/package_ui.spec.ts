import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));
/** D-475: the PF1e window components live in the package artifact, not the bundle (`pnpm build:systems`). */
const uiSource = readFileSync(
  fileURLToPath(new URL("../systems/pf1e-mass-battles/ui.js", import.meta.url)),
  "utf8",
);

/**
 * D-475 — first-party component packages. The built `ui.js` is Svelte's compiled output with the
 * runtime externalised to the shell's copy; this is the only place that proves the two halves
 * meet in a real browser build: `main.ts` exposed the runtime, the artifact evaluated against it,
 * and the component mounted and styled itself inside the shell's document.
 */
test.describe("D-475 package UI (ui.js against the shell's Svelte runtime)", () => {
  test("the built battleAnalysis component imports, mounts and styles itself in the real bundle", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async (source) => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { packageUiSmoke: (input: { uiSource: string }) => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.packageUiSmoke({ uiSource: source })) as {
        ok: boolean;
        runtimeExposed: boolean;
        slots: string[];
        heading: string;
        cards: number;
        styled: boolean;
        error?: string;
      };
    }, uiSource);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.runtimeExposed).toBe(true);
    expect(result.slots).toEqual(["battleAnalysis"]);
    expect(result.heading).toContain("PF1e Battle Analysis");
    expect(result.cards).toBeGreaterThanOrEqual(8);
    expect(result.styled).toBe(true);
  });
});
