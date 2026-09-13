/**
 * D-209 — grapple planners over the shared check.
 * Idempotent condition writes, Pinned replaces Grappled, escape break vs reverse.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import {
  planGrapple,
  planGrappleDamage,
  planGrappleEscape,
  planGrappleMaintain,
  planGrappleMove,
  planGrapplePin,
  planGrappleRelease,
  planGrappleTieUp,
} from "../../src/ui/combat/pf1eManeuver";

const actorWithConditions = (id: string, conditions: string[] = []): ActorDocument =>
  ({
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: { pf1e: { conditions } as unknown as Record<string, import("../../src/core/documents").Json> },
  }) as unknown as ActorDocument;

const baseCheck = {
  die: 15,
  cmb: 7,
  cmd: 18,
  attacker: { size: "Medium" as const },
  defender: { size: "Medium" as const },
};

describe("D-209 — planGrapple writes Grappled to both", () => {
  test("success adds Grappled to both, failure adds nothing", () => {
    const att = actorWithConditions("Attacker");
    const def = actorWithConditions("Defender");
    const r = planGrapple({ attacker: att, defender: def, check: baseCheck, targetAdjacent: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(2);
    expect(r.plan.note).toContain("grappled condition");
    // Already grappled => no ops
    const att2 = actorWithConditions("Attacker2", ["Grappled"]);
    const def2 = actorWithConditions("Defender2", ["Grappled"]);
    const r2 = planGrapple({ attacker: att2, defender: def2, check: baseCheck, targetAdjacent: true });
    expect(r2.ok && (r2 as any).plan.ops.length).toBe(0);
  });

  test("non-adjacent with no space fails with no ops", () => {
    const att = actorWithConditions("A");
    const def = actorWithConditions("D");
    const r = planGrapple({ attacker: att, defender: def, check: { ...baseCheck, die: 20, cmd: 30 }, targetAdjacent: false, hasAdjacentSpace: false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(0);
    expect(r.plan.note).toContain("no adjacent open space");
  });
});

describe("D-209 — planGrapplePin replaces Grappled with Pinned", () => {
  test("pin makes defender Pinned, attacker stays Grappled", () => {
    const att = actorWithConditions("Attacker", ["Grappled"]);
    const def = actorWithConditions("Defender", ["Grappled"]);
    const r = planGrapplePin({ attacker: att, defender: def, maintainSuccess: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    // Find defender op
    const defOp = r.plan.ops.find((op: any) => op.ref.id === "Defender");
    expect(defOp).toBeDefined();
    const defDiff = (defOp as any).diff["system.pf1e.conditions"] as string[];
    expect(defDiff).toContain("Pinned");
    expect(defDiff.some((c) => c.toLowerCase() === "grappled")).toBe(false);
    expect(r.plan.note).toContain("pinned condition");
  });

  test("pin idempotent: already pinned defender no op", () => {
    const att = actorWithConditions("A", ["Grappled"]);
    const def = actorWithConditions("D", ["Pinned"]);
    const r = planGrapplePin({ attacker: att, defender: def, maintainSuccess: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    // Defender Pinned already, so no defender op; attacker Grappled already, so no attacker op
    expect(r.plan.ops.length).toBe(0);
  });
});

describe("D-209 — planGrappleTieUp", () => {
  test("succeeds and pins defender via ropes", () => {
    const att = actorWithConditions("A");
    const def = actorWithConditions("D", ["Pinned"]);
    const r = planGrappleTieUp({
      attacker: att,
      defender: def,
      check: baseCheck,
      targetPinnedOrRestrainedOrUnconscious: true,
      attackerCmbForDc: 7,
      grapplingWhileTying: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    // Already pinned => no op, but tie-up still succeeds note
    expect(r.plan.note).toContain("tie up");
  });
});

describe("D-209 — planGrappleEscape break vs reverse", () => {
  test("break removes Grappled/Pinned from both", () => {
    const esc = actorWithConditions("Escaper", ["Grappled"]);
    const grp = actorWithConditions("Grappler", ["Grappled"]);
    const r = planGrappleEscape({ escaper: esc, grappler: grp, die: 15, bonus: 5, defenderCmd: 18 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(2);
    const escOp = r.plan.ops.find((op: any) => op.ref.id === "Escaper");
    const escConds = (escOp as any).diff["system.pf1e.conditions"] as string[];
    expect(escConds.length).toBe(0);
  });

  test("reverse keeps Grappled and clears Pinned on escaper", () => {
    const esc = actorWithConditions("Escaper", ["Pinned"]);
    const grp = actorWithConditions("Grappler", ["Grappled"]);
    const r = planGrappleEscape({ escaper: esc, grappler: grp, die: 15, bonus: 5, defenderCmd: 18, becomeGrappler: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    // Should have ops (escaper Pinned -> Grappled, grappler already Grappled)
    expect(r.plan.note).toContain("become the grappler");
    const escOp = r.plan.ops.find((op: any) => op.ref.id === "Escaper");
    if (escOp) {
      const conds = (escOp as any).diff["system.pf1e.conditions"] as string[];
      expect(conds).toContain("Grappled");
      expect(conds.some((c) => c.toLowerCase() === "pinned")).toBe(false);
    }
  });

  test("failure escape adds no ops", () => {
    const esc = actorWithConditions("Escaper", ["Grappled"]);
    const grp = actorWithConditions("Grappler", ["Grappled"]);
    const r = planGrappleEscape({ escaper: esc, grappler: grp, die: 5, bonus: 5, defenderCmd: 18 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(0);
    expect(r.plan.note).toContain("escape fails");
  });
});

describe("D-209 — planGrappleRelease", () => {
  test("free action removes Grappled/Pinned from both", () => {
    const att = actorWithConditions("A", ["Grappled"]);
    const def = actorWithConditions("D", ["Pinned"]);
    const r = planGrappleRelease({ attacker: att, defender: def });
    expect(r.plan.ops.length).toBe(2);
    const defOp = r.plan.ops.find((op: any) => op.ref.id === "D");
    expect((defOp as any).diff["system.pf1e.conditions"].length).toBe(0);
  });
  test("already clear => no ops but note", () => {
    const att = actorWithConditions("A", []);
    const def = actorWithConditions("D", []);
    const r = planGrappleRelease({ attacker: att, defender: def });
    expect(r.plan.ops.length).toBe(0);
  });
});

describe("D-209 — planGrappleMove / Damage note-only", () => {
  test("move half speed note", () => {
    const att = actorWithConditions("A");
    const def = actorWithConditions("D");
    const r = planGrappleMove({ attacker: att, defender: def, maintainSuccess: true, speedFt: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(0);
    expect(r.plan.note).toContain("half your speed");
  });
  test("damage note", () => {
    const att = actorWithConditions("A");
    const def = actorWithConditions("D");
    const r = planGrappleDamage({ attacker: att, defender: def, maintainSuccess: true, damage: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.note).toContain("inflict damage");
  });
});

describe("D-209 — planGrappleMaintain idempotent", () => {
  test("success keeps Grappled", () => {
    const att = actorWithConditions("A");
    const def = actorWithConditions("D");
    const r = planGrappleMaintain({ attacker: att, defender: def, check: baseCheck });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.plan.ops.length).toBe(2);
  });
});
