import { describe, expect, test } from "vitest";
import { applyDiff } from "../../src/core/diff";
import { parsePF1eActorSystem } from "../../src/packages/pf1e/actor";
import {
  pendingCastDiff,
  pendingCastFromSystem,
  type PF1ePendingCast,
} from "../../src/packages/pf1e/pendingCast";

const pending: PF1ePendingCast = {
  name: "Summon Monster I",
  level: 1,
  damageFormula: "",
  saveType: "will",
  severity: "none",
  targetId: "ogre",
};

describe("P5/C03 pending cast — pure layer (D-161)", () => {
  test("reads an authored pending cast", () => {
    expect(pendingCastFromSystem({ pf1e: { pendingCast: pending } })).toEqual(
      pending,
    );
  });

  test("absent, null and malformed blocks read as null", () => {
    expect(pendingCastFromSystem(null)).toBeNull();
    expect(pendingCastFromSystem({})).toBeNull();
    expect(pendingCastFromSystem({ pf1e: {} })).toBeNull();
    expect(pendingCastFromSystem({ pf1e: { pendingCast: null } })).toBeNull();
    expect(
      pendingCastFromSystem({ pf1e: { pendingCast: { name: "" } } }),
    ).toBeNull();
    expect(
      pendingCastFromSystem({
        pf1e: { pendingCast: { name: "X", level: 1.5, targetId: "t" } },
      }),
    ).toBeNull();
    expect(
      pendingCastFromSystem({
        pf1e: { pendingCast: { name: "X", level: 1, targetId: "" } },
      }),
    ).toBeNull();
  });

  test("malformed fields fall back to safe defaults", () => {
    expect(
      pendingCastFromSystem({
        pf1e: {
          pendingCast: {
            name: "Flame",
            level: 2,
            saveType: "unknown",
            severity: 42,
            damageFormula: 7,
            targetId: "ogre",
          },
        },
      }),
    ).toEqual({
      name: "Flame",
      level: 2,
      damageFormula: "",
      saveType: "ref",
      severity: "none",
      targetId: "ogre",
    });
  });

  test("the diff writes the charge shape", () => {
    expect(pendingCastDiff(pending)).toEqual({
      "system.pf1e.pendingCast": pending,
    });
  });

  test("null deletes the path via the store's -= marker", () => {
    expect(pendingCastDiff(null)).toEqual({
      "-=system.pf1e.pendingCast": null,
    });
  });

  test("write-then-clear survives the store and the actor re-parse", () => {
    // The D-158 round-trip lesson: a literal null left behind by the clear
    // would fail parsePF1eActorSystem and blank the derived block.
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
    for (const diff of [pendingCastDiff(pending), pendingCastDiff(null)]) {
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
      pendingCastFromSystem(current.system as Record<string, unknown>),
    ).toBeNull();
  });

  test("the schema accepts a stored pending cast and rejects junk", () => {
    expect(parsePF1eActorSystem({ pendingCast: pending }).ok).toBe(true);
    // A literal null is treated as absent, not an error.
    expect(parsePF1eActorSystem({ pendingCast: null }).ok).toBe(true);
    expect(parsePF1eActorSystem({ pendingCast: 7 }).ok).toBe(false);
    expect(
      parsePF1eActorSystem({ pendingCast: { name: "X", level: 12 } }).ok,
    ).toBe(false);
    expect(
      parsePF1eActorSystem({
        pendingCast: { name: "X", level: 1, targetId: 3 },
      }).ok,
    ).toBe(false);
  });
});
