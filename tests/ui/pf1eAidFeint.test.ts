import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planAidAnother, planFeint } from "../../src/ui/combat/pf1eAidFeint";

function actor(id: string, name: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name,
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e: {} },
    items: [],
    effects: [],
  };
}

describe("planAidAnother", () => {
  test("successful aid is note-only (the +2 lives in the card until the resolver consumes it)", () => {
    const aider = actor("aider", "Aider");
    const aided = actor("aided", "Aided");
    const opponent = actor("opp", "Ogre");
    const res = planAidAnother({ aider, aided, opponent, die: 15, attackBonus: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("not ok");
    expect(res.plan.note).toContain("Aider → Aided vs Ogre");
    expect(res.plan.note).toContain("+2 bonus");
    expect(res.plan.ops).toEqual([]);
  });

  test("failed aid still note-only, no ops", () => {
    const aider = actor("aider", "Aider");
    const aided = actor("aided", "Aided");
    const opponent = actor("opp", "Ogre");
    const res = planAidAnother({ aider, aided, opponent, die: 2, attackBonus: 0 });
    if (!res.ok) throw new Error("not ok");
    expect(res.plan.ops).toEqual([]);
    expect(res.plan.note).toContain("aid fails");
  });
});

describe("planFeint", () => {
  test("successful feint notes the denied Dex (note-only until the resolver gains a feint-scoped flag)", () => {
    const feinter = actor("rogue", "Rogue");
    const target = actor("guard", "Guard");
    const res = planFeint({ feinter, target, die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1 });
    if (!res.ok) throw new Error("not ok");
    expect(res.plan.note).toContain("Rogue → Guard");
    expect(res.plan.note).toContain("does not allow him to use his Dexterity bonus");
    expect(res.plan.ops).toEqual([]);
  });

  test("impossible feint refuses by name (mindless)", () => {
    const feinter = actor("rogue", "Rogue");
    const target = actor("ooze", "Ooze");
    const res = planFeint({ feinter, target, die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1, defenderIntScore: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("lacking an Intelligence score");
  });

  test("Greater Feint note mentions until next turn", () => {
    const feinter = actor("rogue", "Rogue");
    const target = actor("guard", "Guard");
    const res = planFeint({ feinter, target, die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1, hasGreaterFeint: true });
    if (!res.ok) throw new Error("not ok");
    expect(res.plan.note).toContain("Greater Feint");
  });
});
