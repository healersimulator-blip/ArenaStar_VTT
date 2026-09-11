import { expect, test } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

/**
 * P5/C03 — the pre-save casting gate through the real bundled chain.
 *
 * As with C02, these assert *wiring*: the rules themselves are pinned by
 * tests/packages/pf1eConcentration.test.ts. What only the browser can prove is that
 * authored `system.pf1e` conditions reach the legality and concentration rules intact.
 *
 * Running example: a 5th-level wizard (Int 18 ⇒ +4) casting 3rd-level fireball, so the
 * concentration bonus is 5 + 4 = 9 and the cast-defensively DC is 15 + 2×3 = 21.
 */

interface AttemptResult {
  ok: boolean;
  error: string | null;
  outcome: string;
  legal: boolean;
  reasons: string[];
  conditions: string[];
  asfChance: number;
  asfFailed: boolean | null;
  deafenedFailed: boolean | null;
  concentrationDc: number | null;
  concentrationTotal: number | null;
  concentrationPassed: boolean | null;
  notes: string[];
}

const attempt = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate(
    (s) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        { pf1eCastAttempt: (x: unknown) => AttemptResult } | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eCastAttempt(s);
    },
    {
      system: { pf1e: {} },
      components: "V, S, M",
      tradition: "arcane",
      castingTime: "standard",
      spellLevel: 3,
      casterLevel: 5,
      keyAbilityMod: 4,
      ...spec,
    },
  );

test.describe("PF1e casting legality and concentration (§9/P5 C03)", () => {
  test("casts when armour failure and the defensive concentration check both pass", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await attempt(page, {
      armorChance: 10, // leather
      arcaneDie: 20, // above 10%, so it holds
      castingDefensively: true,
      concentrationDie: 12, // 12 + 9 = 21, exactly the DC
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("cast");
    expect(res.asfChance).toBe(10);
    expect(res.asfFailed).toBe(false);
    expect(res.concentrationDc).toBe(21);
    expect(res.concentrationTotal).toBe(21);
    expect(res.concentrationPassed).toBe(true);
    expect(errors).toEqual([]);
  });

  test("is ruined by an arcane spell failure roll at or below the chance", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // Chain shirt 20% + buckler 5% = 25%.
    const res = await attempt(page, {
      armorChance: 20,
      shieldChance: 5,
      arcaneDie: 25,
    });
    expect(res.asfChance).toBe(25);
    expect(res.asfFailed).toBe(true);
    expect(res.outcome).toBe("lost");
  });

  test("reads deafened from the authored actor and spoils the verbal component", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await attempt(page, {
      system: { pf1e: { conditions: ["deafened"] } },
      deafenedDie: 10, // at or below 20%
    });
    expect(res.conditions).toContain("deafened");
    expect(res.deafenedFailed).toBe(true);
    expect(res.outcome).toBe("lost");
  });

  test("blocks a pinned caster from a somatic spell before any roll", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await attempt(page, {
      system: { pf1e: { conditions: ["pinned"] } },
      arcaneDie: 1,
    });
    expect(res.outcome).toBe("blocked");
    expect(res.legal).toBe(false);
    expect(res.asfFailed).toBeNull(); // never rolled
    expect(res.reasons.join(" ")).toMatch(/pinned/);
  });

  test("limits casting while grappling to no more than a standard action", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const res = await attempt(page, {
      system: { pf1e: { conditions: ["grappled"] } },
      components: "V",
      castingTime: "full-round",
    });
    expect(res.outcome).toBe("blocked");
    expect(res.reasons.join(" ")).toMatch(/grappling/);
  });
});
