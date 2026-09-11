import { expect, test } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

/**
 * P5/C02 — tactical casting through the real bundled chain.
 *
 * These assertions are deliberately about *wiring*, not about the rules: the
 * rules are pinned by tests/packages/pf1eCasting.test.ts. What only a browser
 * can prove is that authored `system.pf1e` → `deriveFromDocuments` → save total
 * → `spellSaveDc` → `resolveSpellTarget` → `applyEnergyMitigation` all arrive in
 * the shipped bundle intact and in that order. The die faces are supplied by the
 * spec because the resolver is diceless by design (D-119).
 *
 * The DC 17 below is the SRD's own worked example (Int 18 ⇒ +4, 3rd-level
 * fireball). The save bonus of 4 is what `deriveFromDocuments` returns for an
 * authored `saves: { ref: 4 }` block — authored saves are totals, not bases.
 */

interface CastResult {
  ok: boolean;
  error: string | null;
  dc: number;
  saveBonus: number;
  resisted: boolean;
  passed: boolean;
  automatic: string | null;
  dealt: number;
  notes: string[];
}

const cast = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate(
    (s) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        { pf1eCastResolve: (x: unknown) => CastResult } | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eCastResolve(s);
    },
    {
      // Fireball: 28 fire damage, Reflex half, DC 17.
      system: { pf1e: { saves: { ref: 4 } } },
      damage: 28,
      energyType: "fire",
      severity: "half",
      saveType: "ref",
      spellLevel: 3,
      keyAbilityMod: 4,
      saveDie: 15,
      ...spec,
    },
  );

test.describe("PF1e tactical casting (§9/P5 C02)", () => {
  test("derives the save bonus from authored actor data and the DC from the spell", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await cast(page, {});
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    // The save bonus came from the actor document, not from the spec.
    expect(res.saveBonus).toBe(4);
    // 10 + spell level 3 + ability modifier 4.
    expect(res.dc).toBe(17);
    // 15 + 4 = 19 ≥ 17 passes, so 28 halves to 14.
    expect(res.passed).toBe(true);
    expect(res.dealt).toBe(14);
    expect(errors).toEqual([]);
  });

  test("applies energy resistance to what the save actually leaves", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await cast(page, { energyResistance: { fire: 10 } });
    expect(res.passed).toBe(true);
    // Halving happens first (14), then fire resistance absorbs 10.
    expect(res.dealt).toBe(4);
  });

  test("a natural 1 fails the save however large the authored bonus", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await cast(page, {
      saveDie: 1,
      system: { pf1e: { saves: { ref: 40 } } },
    });
    expect(res.saveBonus).toBe(40);
    expect(res.passed).toBe(false);
    expect(res.automatic).toBe("failure");
    expect(res.dealt).toBe(28);
  });

  test("spell resistance with no natural-20 special case blocks the save entirely", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // The strategic engine's `srRoll !== 20` house rule (DEVIATIONS D-1, A.16)
    // is deliberately not reproduced here: 3 + 2 = 5 does not reach SR 20.
    const res = await cast(page, {
      spellResistance: 20,
      casterLevel: 3,
      srDie: 2,
      saveDie: 20, // would have saved anyway
    });
    expect(res.resisted).toBe(true);
    expect(res.dealt).toBe(0);
  });

  test("refuses a spell level outside 0–9 instead of emitting a DC", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await cast(page, { spellLevel: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/spellLevel/);
    expect(res.dc).toBe(0);
  });
});
