/**
 * P7/H03+H04/D-204 — natural recovery (`recovery.ts`), derived from AoN
 * Rules ID 170 (CRB p.191, "Healing"), re-verified before encoding.
 */
import { describe, expect, test } from "vitest";
import {
  abilityDamageRecovery,
  naturalHpRecovery,
} from "../../src/packages/pf1e/recovery";

describe("H03/H04 — natural recovery (CRB p.191)", () => {
  test("hit points: 1 per level per night of rest, doubled by complete bed rest", () => {
    expect(naturalHpRecovery({ level: 5 })).toBe(5);
    expect(naturalHpRecovery({ level: 5, bedRest: true })).toBe(10);
    expect(naturalHpRecovery({ level: 8, bedRest: true, longTermCare: true })).toBe(32);
    expect(naturalHpRecovery({ level: 0 })).toBe(1); // at least one, never zero
  });

  test("ability damage: 1 point per affected score per night, 2 per day of bed rest", () => {
    expect(abilityDamageRecovery({})).toEqual({
      points: 1,
      note: "a night of rest restores 1 point(s) of ability damage per affected score (CRB p.191)",
    });
    expect(abilityDamageRecovery({ bedRest: true }).points).toBe(2);
    expect(abilityDamageRecovery({ bedRest: true, longTermCare: true }).points).toBe(4);
  });
});
