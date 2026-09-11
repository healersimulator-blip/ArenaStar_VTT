import { describe, expect, test } from "vitest";
import { applyDiff } from "../../src/core/diff";
import { parsePF1eActorSystem } from "../../src/packages/pf1e/actor";
import {
  criticalDamageTotal,
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
