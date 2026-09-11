import { expect, test } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

/**
 * P5/C04 — the summary tab's level 0–9 spell slot readout through the real bundled
 * chain.
 *
 * As with C02 and C03, these assert *wiring*: Table 1-3, the `10 + spell level`
 * minimum and the over-budget warnings are pinned by
 * tests/packages/pf1eSpellSlots.test.ts, and the derived-actor mapping by
 * tests/ui/pf1eSheetModel.test.ts. What only the browser can prove is that the sheet's
 * own `pf1eSpellSlotReadout` adapter is reachable from the bundle and that authored
 * `system.pf1e` slots, drain and damage reach it intact.
 *
 * Running example: a 5th-level wizard (Intelligence 18, +4) with the Core Rulebook's
 * 4 cantrips / 4 / 3 / 2 / 1 budget, prepared. Table 1-3 grants 1/1/1/1 at 1st–4th and
 * nothing at 0th, so the readout is 4 / 5 / 4 / 3 / 2.
 */

interface SlotRow {
  level: number;
  label: string;
  text: string;
  over: boolean;
  total: number | null;
  spent: number;
}

interface SlotsResult {
  summary: string;
  grantedLevels: number[];
  rows: SlotRow[];
  warnings: string[];
  mode: "prepared" | "spontaneous";
  keyAbility: string;
  keyAbilityScore: number | null;
  ok: boolean;
  issues: string[];
}

const slots = (
  page: import("@playwright/test").Page,
  system: Record<string, unknown>,
) =>
  page.evaluate(
    (sys) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        { pf1eSpellSlots: (x: unknown) => SlotsResult } | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eSpellSlots({ system: sys });
    },
    { pf1e: system },
  );

/** A 5th-level wizard: CRB slots 4 cantrips / 4 / 3 / 2 / 1, Intelligence 18. */
const wizard = (pf1e: Record<string, unknown> = {}) => ({
  abilities: { int: 18 },
  spells: {
    keyAbility: "int",
    mode: "prepared",
    casterLevel: 5,
    slotsPerDay: { 0: 4, 1: 4, 2: 3, 3: 2, 4: 1 },
  },
  ...pf1e,
});

test.describe("PF1e spell slot readout (§9/P5 C04)", () => {
  test("adds the Table 1-3 bonuses to the authored budget for levels 0–9", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(page, wizard());
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.keyAbility).toBe("int");
    expect(res.keyAbilityScore).toBe(18);
    expect(res.mode).toBe("prepared");
    // 0th never receives a bonus spell, at any ability score.
    expect(res.summary).toBe("0th 0/4 · 1st 0/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2");
    expect(res.grantedLevels).toEqual([4, 3, 2, 1, 0]);
    expect(res.rows).toHaveLength(10);
    expect(res.warnings).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("covers 0–9 only, so a 10th-level slot is not widened into the readout", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(
      page,
      wizard({ spells: { keyAbility: "int", slotsPerDay: { 0: 4, 10: 2 } } }),
    );
    expect(res.rows.map((r) => r.level)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(res.grantedLevels).toEqual([0]);
    expect(res.summary).toBe("0th 0/4");
  });

  test("reports a bonus spell at a level with no slots as a warning, not as a slot", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    // A 1st-level wizard with Intelligence 18: the CRB's own gloss is that the bonus
    // is usable only where the class already grants the slot.
    const res = await slots(
      page,
      wizard({
        spells: {
          keyAbility: "int",
          mode: "prepared",
          casterLevel: 1,
          slotsPerDay: { 0: 3, 1: 1 },
        },
      }),
    );
    expect(res.grantedLevels).toEqual([1, 0]);
    expect(res.warnings).toHaveLength(3);
    expect(res.warnings.join(" | ")).toMatch(
      /no 2-level slots.*no 3-level slots.*no 4-level slots/s,
    );
  });

  test("ability drain costs bonus spells; ability damage does not", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    // CRB p.555: drain reduces the score, damage only penalises the modifier.
    // Table 1-3 is a score table, so only drain can cost castability.
    const drained = await slots(page, wizard({ abilitiesDrain: { int: 6 } }));
    expect(drained.keyAbilityScore).toBe(12);
    expect(drained.warnings.join(" | ")).toMatch(
      /below the required 13.*below the required 14/s,
    );

    const damaged = await slots(page, wizard({ abilitiesDamage: { int: 6 } }));
    expect(damaged.keyAbilityScore).toBe(18);
    expect(damaged.summary).toBe(
      "0th 0/4 · 1st 0/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2",
    );
    expect(damaged.warnings).toEqual([]);
  });

  test("a key ability that cannot cast at all still shows the granted slots", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(page, wizard({ abilities: { int: 8 } }));
    expect(res.keyAbilityScore).toBe(8);
    expect(res.grantedLevels).toEqual([4, 3, 2, 1, 0]);
    expect(res.warnings.at(-1)).toMatch(
      /too low to cast spells tied to that ability at all/,
    );
  });

  test("a non-caster reads as None rather than as a broken budget", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(page, { abilities: { str: 16 } });
    expect(res.ok).toBe(true);
    expect(res.grantedLevels).toEqual([]);
    expect(res.summary).toBe("None");
    expect(res.rows.every((r) => r.total === null && !r.over)).toBe(true);
  });

  test("the readout spends nothing: every level reports zero spent", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    // C04 is a readout; the ledger that tracks spending is not wired to a sheet yet.
    const res = await slots(page, wizard());
    expect(res.rows.every((r) => r.spent === 0)).toBe(true);
    expect(res.rows.every((r) => !r.over)).toBe(true);
  });
});
