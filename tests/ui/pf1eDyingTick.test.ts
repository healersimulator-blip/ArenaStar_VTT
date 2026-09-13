/**
 * P7/H01/D-205 — the dying round's stabilization write plan
 * (`ui/combat/pf1eDyingTick.ts`): the Stable-condition write on a success,
 * the lost hit point on a failure, and the death annotation when the loss
 * crosses negative Constitution.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planDyingTick } from "../../src/ui/combat/pf1eDyingTick";
import { stabilizationCheck } from "../../src/packages/pf1e/injury";

const actor = (pf1e: Record<string, unknown> = {}): ActorDocument => ({
  _id: "hero",
  type: "actor",
  name: "Hero",
  ownership: { default: 3 },
  flags: {},
  items: [],
  effects: [],
  system: { pf1e: { abilities: { con: 14 }, hp: -3, ...pf1e } },
});

describe("D-205 — the stabilization write plan", () => {
  test("a success writes the Stable condition (idempotently, preserving authored ones)", () => {
    const verdict = stabilizationCheck({ die: 14, conMod: 2, hp: -3 });
    expect(verdict.success).toBe(true);
    const plan = planDyingTick({ actor: actor(), verdict, conScore: 14 });
    expect(plan.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { "system.pf1e.conditions": ["Stable"] },
      },
    ]);
    expect(plan.note).toContain("Hero — Constitution check");
    expect(plan.state).toBe("dying");

    // Already stable (or with other authored conditions): no duplicate write.
    const already = planDyingTick({
      actor: actor({ conditions: ["Shaken", "stable"] }),
      verdict,
      conScore: 14,
    });
    expect(already.ops).toEqual([]);

    const preserving = planDyingTick({
      actor: actor({ conditions: ["Shaken"] }),
      verdict,
      conScore: 14,
    });
    expect(preserving.ops[0]).toMatchObject({
      diff: { "system.pf1e.conditions": ["Shaken", "Stable"] },
    });
  });

  test("a failure writes the lost hit point, with the death annotation past negative Con", () => {
    const verdict = stabilizationCheck({ die: 2, conMod: 2, hp: -3 });
    expect(verdict).toMatchObject({ success: false, hpAfter: -4 });
    const plan = planDyingTick({ actor: actor(), verdict, conScore: 14 });
    expect(plan.ops[0]).toMatchObject({
      diff: { "system.pf1e.hp": -4 },
    });
    expect(plan.state).toBe("dying");
    expect(plan.note).not.toContain("dead");

    const dyingDeeper = stabilizationCheck({ die: 2, conMod: 0, hp: -13 });
    expect(dyingDeeper.hpAfter).toBe(-14);
    const dead = planDyingTick({
      actor: actor({ hp: -13 }),
      verdict: dyingDeeper,
      conScore: 14,
    });
    expect(dead.state).toBe("dead");
    expect(dead.note).toContain("dead — negative HP (-14)");
    expect(dead.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": -14 } });
  });
});
