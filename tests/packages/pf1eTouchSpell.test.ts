import { describe, expect, test } from "vitest";
import { applyDiff } from "../../src/core/diff";
import { parsePF1eActorSystem } from "../../src/packages/pf1e/actor";
import {
  consumeHeldCharge,
  consumeHeldCharges,
  criticalDamageTotal,
  heldChargeCount,
  heldChargeDiff,
  heldChargeFromSystem,
  resolveTouchAttack,
  touchCriticalNeedsConfirmation,
  type PF1eHeldCharge,
} from "../../src/packages/pf1e/touchSpell";

describe("P5/C03 touch attacks (D-158, AoN Rules ID 133)", () => {
  test("a touch attack hits when the total meets the touch AC", () => {
    const hit = resolveTouchAttack({ die: 10, bonus: 3, touchAc: 13 });
    expect(hit.ok).toBe(true);
    expect(hit.total).toBe(13);
    expect(hit.hit).toBe(true);
    expect(hit.threat).toBe(false);
  });

  test("a total below the touch AC misses", () => {
    const miss = resolveTouchAttack({ die: 5, bonus: 3, touchAc: 13 });
    expect(miss.ok).toBe(true);
    expect(miss.hit).toBe(false);
  });

  test("a natural 20 threatens a critical (damage-dealing touch spells can crit)", () => {
    const crit = resolveTouchAttack({ die: 20, bonus: 0, touchAc: 10 });
    expect(crit.threat).toBe(true);
    expect(crit.hit).toBe(true);
  });

  test("malformed inputs are named, not guessed", () => {
    expect(resolveTouchAttack({ die: 0, bonus: 0, touchAc: 10 }).ok).toBe(
      false,
    );
    expect(resolveTouchAttack({ die: 21, bonus: 0, touchAc: 10 }).ok).toBe(
      false,
    );
    expect(resolveTouchAttack({ die: 10, bonus: 0.5, touchAc: 10 }).ok).toBe(
      false,
    );
    expect(resolveTouchAttack({ die: 10, bonus: 0, touchAc: -1 }).ok).toBe(
      false,
    );
  });
});

describe("P5/C03 held-charge persistence (D-158)", () => {
  const charge: PF1eHeldCharge = {
    name: "Shocking Grasp",
    level: 1,
    damageFormula: "1d6",
    saveType: "ref",
    severity: "none",
  };

  test("a stored charge round-trips through system read + diff", () => {
    const diff = heldChargeDiff(charge);
    const system = { pf1e: { heldCharge: diff["system.pf1e.heldCharge"] } };
    const read = heldChargeFromSystem(system);
    expect(read).toEqual(charge);
  });

  test("optional slot level and energy type ride the diff when present", () => {
    const full: PF1eHeldCharge = {
      ...charge,
      slotLevel: 2,
      energyType: "electricity",
    };
    const diff = heldChargeDiff(full);
    const system = { pf1e: { heldCharge: diff["system.pf1e.heldCharge"] } };
    expect(heldChargeFromSystem(system)).toEqual(full);
  });

  test("null deletes the charge path via the store's -= marker", () => {
    expect(heldChargeDiff(null)).toEqual({
      "-=system.pf1e.heldCharge": null,
    });
  });

  test("write-then-clear survives the store and the actor re-parse", () => {
    // A literal null left behind by the clear would fail
    // parsePF1eActorSystem and blank the caster's whole derived block —
    // this is the round-trip that pins the -= deletion marker.
    const doc = {
      _id: "w",
      type: "actor",
      name: "w",
      ownership: { default: 2 },
      flags: {},
      system: {
        pf1e: {
          abilities: { int: 16 },
          spells: { keyAbility: "int", casterLevel: 5, slotsPerDay: { 1: 4 } },
        },
      },
      items: [],
      effects: [],
    };
    let current: typeof doc = doc;
    for (const diff of [heldChargeDiff(charge), heldChargeDiff(null)]) {
      const applied = applyDiff(current, diff);
      expect(applied.ok).toBe(true);
      if (applied.ok) current = applied.value as typeof doc;
    }
    expect(
      parsePF1eActorSystem(
        (current.system as { pf1e: Record<string, unknown> }).pf1e,
      ).ok,
    ).toBe(true);
    expect(
      heldChargeFromSystem(current.system as Record<string, unknown>),
    ).toBeNull();
  });

  test("absent or malformed charges read as null — never an invented one", () => {
    expect(heldChargeFromSystem(undefined)).toBeNull();
    expect(heldChargeFromSystem({})).toBeNull();
    expect(heldChargeFromSystem({ pf1e: {} })).toBeNull();
    expect(heldChargeFromSystem({ pf1e: { heldCharge: 7 } })).toBeNull();
    expect(
      heldChargeFromSystem({ pf1e: { heldCharge: { name: "", level: 1 } } }),
    ).toBeNull();
    expect(
      heldChargeFromSystem({ pf1e: { heldCharge: { name: "X" } } }),
    ).toBeNull();
  });

  test("a malformed charge still yields its safest reading", () => {
    const read = heldChargeFromSystem({
      pf1e: {
        heldCharge: {
          name: "Flame",
          level: 2,
          saveType: "unknown",
          severity: 42,
          damageFormula: 7,
        },
      },
    });
    expect(read).toEqual({
      name: "Flame",
      level: 2,
      damageFormula: "",
      saveType: "ref",
      severity: "none",
    });
  });
});

describe("P5/C03 critical confirmation — pure layer (D-159)", () => {
  test("confirmation is needed only for threats by damage-dealing spells", () => {
    expect(touchCriticalNeedsConfirmation(true, true)).toBe(true);
    expect(touchCriticalNeedsConfirmation(true, false)).toBe(false);
    expect(touchCriticalNeedsConfirmation(false, true)).toBe(false);
    expect(touchCriticalNeedsConfirmation(false, false)).toBe(false);
  });

  test("the confirmed touch critical's multiplier is x2", () => {
    expect(criticalDamageTotal(7)).toBe(14);
    expect(criticalDamageTotal(1)).toBe(2);
    expect(criticalDamageTotal(0)).toBe(0);
  });
});

describe("P5/C03 multi-charge held spells — pure layer (D-162)", () => {
  const chill: PF1eHeldCharge = {
    name: "Chill Touch",
    level: 1,
    damageFormula: "1d6",
    saveType: "fort",
    severity: "partial",
    charges: 5,
  };

  test("a stored multi-charge round-trips through system read + diff", () => {
    const diff = heldChargeDiff(chill);
    const system = { pf1e: { heldCharge: diff["system.pf1e.heldCharge"] } };
    expect(heldChargeFromSystem(system)).toEqual(chill);
  });

  test("absent or malformed charge counts read as the single-charge default", () => {
    const { charges: _ignored, ...single } = chill;
    void _ignored;
    const cases = [
      single,
      { ...single, charges: "many" },
      { ...single, charges: 0 },
      { ...single, charges: 51 },
    ];
    for (const held of cases) {
      const read = heldChargeFromSystem({ pf1e: { heldCharge: held } });
      expect(read).not.toBeNull();
      if (read !== null) expect(heldChargeCount(read)).toBe(1);
    }
  });

  test("one delivery decrements a multi-charge; the last one clears", () => {
    const after = consumeHeldCharge(chill);
    expect(after).not.toBeNull();
    expect(after?.charges).toBe(4);
    const last: PF1eHeldCharge = { ...chill, charges: 1 };
    expect(consumeHeldCharge(last)).toBeNull();
    const implicit: PF1eHeldCharge = { ...chill };
    delete implicit.charges;
    expect(consumeHeldCharge(implicit)).toBeNull();
  });

  test("the full-round ally touch consumes one charge per touched friend", () => {
    const after = consumeHeldCharges(chill, 3);
    expect(after?.charges).toBe(2);
    expect(consumeHeldCharges(chill, 5)).toBeNull();
    expect(consumeHeldCharges(chill, 6)).toBeNull();
  });

  test("the schema accepts 1–50 charges and names everything else", () => {
    const base = {
      abilities: { int: 16 },
      spells: { keyAbility: "int", casterLevel: 5, slotsPerDay: { 1: 4 } },
      heldCharge: {
        name: "Chill Touch",
        level: 1,
        damageFormula: "1d6",
        saveType: "fort",
        severity: "partial",
      },
    };
    const ok = parsePF1eActorSystem({
      ...base,
      heldCharge: { ...base.heldCharge, charges: 5 },
    });
    expect(ok.ok).toBe(true);
    const single = parsePF1eActorSystem(base);
    expect(single.ok).toBe(true);
    const zero = parsePF1eActorSystem({
      ...base,
      heldCharge: { ...base.heldCharge, charges: 0 },
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toContain("charges");
    const big = parsePF1eActorSystem({
      ...base,
      heldCharge: { ...base.heldCharge, charges: 51 },
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toContain("charges");
    const frac = parsePF1eActorSystem({
      ...base,
      heldCharge: { ...base.heldCharge, charges: 2.5 },
    });
    expect(frac.ok).toBe(false);
  });

  test("write-multi-charge-then-clear survives the store and the re-parse", () => {
    const doc = {
      _id: "w",
      type: "actor",
      name: "w",
      ownership: { default: 2 },
      flags: {},
      system: {
        pf1e: {
          abilities: { int: 16 },
          spells: { keyAbility: "int", casterLevel: 5, slotsPerDay: { 1: 4 } },
        },
      },
      items: [],
      effects: [],
    };
    let current: typeof doc = doc;
    for (const diff of [heldChargeDiff(chill), heldChargeDiff(null)]) {
      const applied = applyDiff(current, diff);
      expect(applied.ok).toBe(true);
      if (applied.ok) current = applied.value as typeof doc;
    }
    expect(
      parsePF1eActorSystem(
        (current.system as { pf1e: Record<string, unknown> }).pf1e,
      ).ok,
    ).toBe(true);
    expect(
      heldChargeFromSystem(current.system as Record<string, unknown>),
    ).toBeNull();
  });
});
