/**
 * P09/D-202 — firearms misfire, explosion and clearing (`firearms.ts`),
 * derived from the verified texts (Gap List §2.9/§2.9b, UC p.135, the
 * gunslinger deeds — Quick Clear and Gunsmithing re-verified before encoding).
 */
import { describe, expect, test } from "vitest";
import {
  FIREARM_EXPLOSION_DC,
  FIREARM_EXPLOSION_RADIUS_FT,
  MISFIRE_CLEARS,
  effectiveMisfireValue,
  firearmExplosionMitigatedDamage,
  firearmExplosionReflexOutcome,
  firearmExplosionSquares,
  firearmExplosionTargetDamage,
  firearmReloadEntry,
  firearmShotAmmo,
  pf1eMisfireVerdict,
  quickClearReloadCost,
  type PF1eMisfireFacts,
} from "../../src/packages/pf1e/firearms";

const musket = (overrides: Partial<PF1eMisfireFacts> = {}): PF1eMisfireFacts => ({
  generation: "early",
  misfireMinimum: 2,
  broken: false,
  ...overrides,
});

describe("P09 — the effective misfire value (§2.9b)", () => {
  test("minimum, +4 broken, +2 with Gun Training, +4 for a nonproficient loader", () => {
    expect(effectiveMisfireValue(musket())).toBe(2);
    expect(effectiveMisfireValue(musket({ broken: true }))).toBe(6);
    expect(
      effectiveMisfireValue(musket({ broken: true, gunTraining: true })),
    ).toBe(4);
    expect(
      effectiveMisfireValue(musket({ nonproficientLoader: true })),
    ).toBe(6);
    expect(
      effectiveMisfireValue(
        musket({ broken: true, nonproficientLoader: true }),
      ),
    ).toBe(10);
    expect(effectiveMisfireValue(musket({ misfireMinimum: 0 }))).toBe(0);
  });
});

describe("P09 — the misfire verdict (§2.9b)", () => {
  test("a natural 20 never misfires, whatever the value", () => {
    const verdict = pf1eMisfireVerdict({
      facts: musket({ misfireMinimum: 20, broken: true }),
      die: 20,
    });
    expect(verdict).toEqual({ misfire: false });
  });

  test("a die at or below the value is an automatic miss that breaks the gun", () => {
    const verdict = pf1eMisfireVerdict({ facts: musket(), die: 2 });
    expect(verdict).toMatchObject({
      misfire: true,
      autoMiss: true,
      breaksWeapon: true,
      explodes: false,
      weaponDestroyed: false,
    });
    if (!verdict.misfire) throw new Error("expected a misfire");
    expect(verdict.notes.join(" ")).toContain(
      "natural 2 ≤ misfire value 2",
    );
    expect(verdict.notes.join(" ")).toContain("gains the broken condition");
    expect(verdict.notes.join(" ")).toContain("rises +4");

    // Above the value: nothing happens.
    expect(pf1eMisfireVerdict({ facts: musket(), die: 3 })).toEqual({
      misfire: false,
    });
  });

  test("Gun Training names the +2 escalation on the first misfire", () => {
    const verdict = pf1eMisfireVerdict({
      facts: musket({ gunTraining: true }),
      die: 2,
    });
    if (!verdict.misfire) throw new Error("expected a misfire");
    expect(verdict.notes.join(" ")).toContain("rises +2 (Gun Training)");
  });

  test("a second misfire of a broken early firearm explodes — DC 12 Reflex half, the gun is gone", () => {
    const mundane = pf1eMisfireVerdict({
      facts: musket({ broken: true }),
      die: 6,
    });
    expect(mundane).toMatchObject({
      misfire: true,
      explodes: true,
      save: { dc: 12, half: true },
      weaponDestroyed: true,
    });
    if (!mundane.misfire) throw new Error("expected a misfire");
    expect(mundane.notes.join(" ")).toContain("explodes");
    expect(mundane.notes.join(" ")).toContain("DC 12 Reflex half");
    expect(mundane.notes.join(" ")).toContain("destroyed by the explosion");

    const magic = pf1eMisfireVerdict({
      facts: musket({ broken: true, magical: true }),
      die: 6,
    });
    if (!magic.misfire) throw new Error("expected a misfire");
    expect(magic.notes.join(" ")).toContain(
      "magical firearm is wrecked by the explosion",
    );
  });

  test("Expert Loading spends 1 grit to avert the explosion; the gun stays broken", () => {
    const verdict = pf1eMisfireVerdict({
      facts: musket({ broken: true, expertLoading: true }),
      die: 6,
    });
    expect(verdict).toMatchObject({
      misfire: true,
      explodes: false,
      save: null,
      weaponDestroyed: false,
    });
    if (!verdict.misfire) throw new Error("expected a misfire");
    expect(verdict.notes.join(" ")).toContain(
      "Expert Loading (1 grit): the explosion is averted",
    );
  });

  test("advanced firearms never explode — the second misfire is just the auto-miss", () => {
    const verdict = pf1eMisfireVerdict({
      facts: musket({ generation: "advanced", broken: true }),
      die: 6,
    });
    expect(verdict).toMatchObject({
      misfire: true,
      explodes: false,
      save: null,
      weaponDestroyed: false,
    });
    if (!verdict.misfire) throw new Error("expected a misfire");
    expect(verdict.notes.join(" ")).toContain("advanced firearms never explode");
  });

  test("a die that is not a d20 face refuses by name", () => {
    const verdict = pf1eMisfireVerdict({ facts: musket(), die: 0 });
    expect(verdict).toMatchObject({ misfire: true, explodes: false });
    if (!verdict.misfire) throw new Error("expected a misfire");
    expect(verdict.notes[0]).toContain("must be a natural d20 face");
  });
});

describe("P09 — the named clears and the ammo gate", () => {
  test("clearing is Quick Clear (the deed) or Gunsmithing (the feat) — no generic DC-10 clear exists", () => {
    expect(MISFIRE_CLEARS.map((c) => c.id)).toEqual([
      "quick-clear",
      "gunsmithing",
    ]);
    expect(MISFIRE_CLEARS[0]?.cost).toContain("standard action");
    expect(MISFIRE_CLEARS[0]?.cost).toContain("1 grit makes it a move action");
    expect(MISFIRE_CLEARS[1]?.cost).toBe("1 hour");
  });

  test("a firearm without a loaded shot cannot be fired at all", () => {
    expect(firearmShotAmmo({ shotsAvailable: 0 })).toEqual({
      canShoot: false,
      remaining: 0,
      refusal:
        "the firearm has no shot loaded — a weapon without ammunition is impossible to attack with (§2.9)",
    });
    expect(firearmShotAmmo({ shotsAvailable: 1 })).toEqual({
      canShoot: true,
      remaining: 0,
      refusal: null,
    });
    expect(firearmShotAmmo({ shotsAvailable: 3 })).toMatchObject({
      canShoot: true,
      remaining: 2,
    });
  });
});

describe("P09/D-218 — Quick Clear cost and reload provoke (UC p.135)", () => {
  test("Quick Clear requires at least 1 grit, standard without spend, move with 1 grit", () => {
    expect(quickClearReloadCost({ gritAvailable: 0 })).toMatchObject({
      action: "standard",
      gritSpent: 0,
      refusal: "Quick Clear requires at least 1 grit",
    });
    expect(quickClearReloadCost({ gritAvailable: 1 })).toMatchObject({
      action: "standard",
      gritSpent: 0,
      refusal: null,
    });
    expect(quickClearReloadCost({ gritAvailable: 1, spendGrit: true })).toMatchObject({
      action: "move",
      gritSpent: 1,
      refusal: null,
    });
    expect(quickClearReloadCost({ gritAvailable: 2, spendGrit: true }).cost).toContain("move action");
  });

  test("load-firearm provokes — the entry exists and is the UC p.135 §2.9 row", () => {
    const entry = firearmReloadEntry();
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("load-firearm");
    expect(entry?.provokes).toBe("yes");
    expect(entry?.category).toMatch(/move|standard|full-round/);
  });
});

describe("P09/D-219 — burst geometry and Reflex saves (UC p.135, 5-ft burst DC 12)", () => {
  test("a burst from a chosen corner covers the 4 squares sharing it", () => {
    expect(FIREARM_EXPLOSION_RADIUS_FT).toBe(5);
    expect(FIREARM_EXPLOSION_DC).toBe(12);
    const squares = firearmExplosionSquares({ col: 3, row: 7 });
    expect(squares).toHaveLength(4);
    expect(squares).toEqual(
      expect.arrayContaining([
        { col: 2, row: 6 },
        { col: 3, row: 6 },
        { col: 2, row: 7 },
        { col: 3, row: 7 },
      ]),
    );
    // Origin corner (0,0) yields negative coords for the northwest squares — caller clips.
    expect(firearmExplosionSquares({ col: 0, row: 0 })).toEqual([
      { col: -1, row: -1 },
      { col: 0, row: -1 },
      { col: -1, row: 0 },
      { col: 0, row: 0 },
    ]);
  });

  test("DC 12 Reflex — success is total ≥ DC, single die+mod", () => {
    expect(firearmExplosionReflexOutcome({ die: 10, reflexMod: 2 })).toEqual({
      total: 12,
      success: true,
    });
    expect(firearmExplosionReflexOutcome({ die: 9, reflexMod: 2 })).toEqual({
      total: 11,
      success: false,
    });
    expect(firearmExplosionReflexOutcome({ die: 12, reflexMod: 5, dc: 15 })).toEqual({
      total: 17,
      success: true,
    });
  });

  test("mitigated damage halves on success, floor, full on fail — one target helper", () => {
    expect(firearmExplosionMitigatedDamage({ damageTotal: 11, success: true })).toBe(5);
    expect(firearmExplosionMitigatedDamage({ damageTotal: 12, success: true })).toBe(6);
    expect(firearmExplosionMitigatedDamage({ damageTotal: 11, success: false })).toBe(11);
    const hit = firearmExplosionTargetDamage({ damageTotal: 9, die: 8, reflexMod: 4 });
    expect(hit).toMatchObject({ total: 12, success: true, dealt: 4 });
    const miss = firearmExplosionTargetDamage({ damageTotal: 9, die: 7, reflexMod: 4 });
    expect(miss).toMatchObject({ total: 11, success: false, dealt: 9 });
  });

  test("ammo gate and misfire are discriminating: empty can't shoot, natural 20 never misfires, broken+4, expert averts, advanced never explodes", () => {
    // Empty ⇒ refusal (already covered but re-assert as a bundle)
    expect(firearmShotAmmo({ shotsAvailable: 0 }).canShoot).toBe(false);
    expect(firearmShotAmmo({ shotsAvailable: 1 }).canShoot).toBe(true);
    // Natural 20 gate
    const nat20 = pf1eMisfireVerdict({ facts: musket({ misfireMinimum: 20, broken: true }), die: 20 });
    expect(nat20).toEqual({ misfire: false });
    // Broken escalation +4
    expect(effectiveMisfireValue(musket({ broken: true }))).toBe(6);
    // Expert averts
    const averted = pf1eMisfireVerdict({ facts: musket({ broken: true, expertLoading: true }), die: 6 });
    expect(averted).toMatchObject({ misfire: true, explodes: false });
    // Advanced never explodes
    const advanced = pf1eMisfireVerdict({ facts: musket({ generation: "advanced", broken: true }), die: 6 });
    expect(advanced).toMatchObject({ misfire: true, explodes: false });
  });
});
