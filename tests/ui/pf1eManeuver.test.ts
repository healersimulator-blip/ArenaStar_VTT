/**
 * P05/D-208 — maneuver planners that turn verdicts into ops.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import {
  planBullRush,
  planDirtyTrick,
  planOverrun,
  planTrip,
} from "../../src/ui/combat/pf1eManeuver";

const actor = (id: string, pf1e: Record<string, unknown> = {}): ActorDocument =>
  ({
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: { pf1e: pf1e as unknown as Record<string, import("../../src/core/documents").Json> },
  }) as unknown as ActorDocument;

describe("D-208 — planTrip writes Prone on success", () => {
  test("success adds Prone to defender, failure by 10+ adds to attacker", () => {
    const attacker = actor("hero");
    const defender = actor("goblin");
    const ok = planTrip({
      attacker,
      defender,
      check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("fail");
    expect(ok.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.conditions": ["Prone"] } });

    const fail = planTrip({
      attacker,
      defender,
      check: { die: 5, cmb: 5, cmd: 25, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!fail.ok) throw new Error("fail");
    expect(fail.plan.ops[0]).toMatchObject({ ref: { id: "hero" } });
  });

  test("already prone defender produces no op (idempotent)", () => {
    const attacker = actor("hero");
    const defender = actor("goblin", { conditions: ["Prone"] });
    const res = planTrip({
      attacker,
      defender,
      check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!res.ok) throw new Error("fail");
    expect(res.plan.ops.length).toBe(0);
  });
});

describe("D-208 — planBullRush is note-only (movement is map)", () => {
  test("success note carries distance, no ops", () => {
    const res = planBullRush({
      attacker: actor("hero"),
      defender: actor("goblin"),
      check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!res.ok) throw new Error("fail");
    expect(res.plan.ops.length).toBe(0);
    expect(res.plan.note).toContain("pushes the target");
  });
});

describe("D-208 — planDirtyTrick", () => {
  test("success adds the condition", () => {
    const res = planDirtyTrick({
      attacker: actor("hero"),
      defender: actor("goblin"),
      check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } },
      condition: "blinded",
    });
    if (!res.ok) throw new Error("fail");
    expect(res.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.conditions": ["Blinded"] } });
  });
});

describe("D-208 — planOverrun", () => {
  test("target avoids => no check, no prone", () => {
    const res = planOverrun({ attacker: actor("hero"), defender: actor("goblin"), targetAvoids: true });
    if (!res.ok) throw new Error("fail");
    expect(res.plan.ops.length).toBe(0);
    expect(res.plan.note).toContain("avoid");
  });

  test("success by 5+ adds prone", () => {
    const res = planOverrun({
      attacker: actor("hero"),
      defender: actor("goblin"),
      check: { die: 15, cmb: 10, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!res.ok) throw new Error("fail");
    expect(res.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.conditions": ["Prone"] } });
  });
});
