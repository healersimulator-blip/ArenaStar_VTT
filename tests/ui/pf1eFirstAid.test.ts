/**
 * P7/H01/D-206 — first aid plan (Heal DC15, standard action that provokes).
 * The verdict is healFirstAid; the plan is the Stable write.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planFirstAid } from "../../src/ui/combat/pf1eFirstAid";
import { healFirstAid } from "../../src/packages/pf1e/injury";

const actor = (pf1e: Record<string, unknown> = {}): ActorDocument => ({
  _id: "dying",
  type: "actor",
  name: "Dying",
  ownership: { default: 3 },
  flags: {},
  items: [],
  effects: [],
  system: { pf1e: { hp: -4, abilities: { con: 14 }, ...pf1e } },
});

describe("D-206 — first aid plan", () => {
  test("failure writes nothing, success writes Stable preserving others", () => {
    const fail = healFirstAid({ die: 5, healMod: 2 });
    expect(fail.stabilized).toBe(false);
    const planFail = planFirstAid({ actor: actor(), verdict: fail });
    expect(planFail.ops).toEqual([]);
    expect(planFail.note).toContain("first aid fails");

    const success = healFirstAid({ die: 14, healMod: 4 });
    expect(success.stabilized).toBe(true);
    const plan = planFirstAid({ actor: actor(), verdict: success });
    expect(plan.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "dying" },
        diff: { "system.pf1e.conditions": ["Stable"] },
      },
    ]);
    expect(plan.note).toContain("first aid stabilizes");
  });

  test("already stable is idempotent, other conditions preserved", () => {
    const success = healFirstAid({ die: 19, healMod: 2 });
    const already = planFirstAid({
      actor: actor({ conditions: ["Stable"] }),
      verdict: success,
    });
    expect(already.ops).toEqual([]);
    const lower = planFirstAid({
      actor: actor({ conditions: ["stable"] }),
      verdict: success,
    });
    expect(lower.ops).toEqual([]);

    const withOther = planFirstAid({
      actor: actor({ conditions: ["Shaken"] }),
      verdict: success,
    });
    expect(withOther.ops[0]).toMatchObject({
      diff: { "system.pf1e.conditions": ["Shaken", "Stable"] },
    });
  });
});
