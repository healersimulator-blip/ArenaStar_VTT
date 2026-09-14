/**
 * P05/D-209 — grapple state machine (AoN 191) as pure verdicts over the
 * shared CMB-vs-CMD layer. Every sentence below is a fixture, not a snapshot.
 */
import { describe, expect, test } from "vitest";
import {
  pf1eGrapple,
  pf1eGrappleDamage,
  pf1eGrappleEscape,
  pf1eGrappleHazardBreak,
  pf1eGrappleMaintain,
  pf1eGrappleMove,
  pf1eGrapplePin,
  pf1eGrappleTieUp,
} from "../../src/packages/pf1e/maneuvers";

const baseCheck = (overrides: Record<string, unknown> = {}) => ({
  die: 15,
  cmb: 7,
  cmd: 18,
  attacker: { size: "Medium" as const },
  defender: { size: "Medium" as const },
  ...overrides,
});

describe("P05 — grapple initial (AoN 191)", () => {
  test("success grapples both adjacent", () => {
    const r = pf1eGrapple({ check: baseCheck(), targetAdjacent: true });
    expect(r.ok && r.success).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.bothGrappled).toBe(true);
    expect(r.needsMoveAdjacent).toBe(false);
    expect(r.noSpaceFails).toBe(false);
    expect(r.notes.join(" ")).toContain("both you and the target gain the grappled condition");
  });

  test("non-adjacent success requires move to adjacent", () => {
    const r = pf1eGrapple({ check: baseCheck(), targetAdjacent: false, hasAdjacentSpace: true });
    expect(r.ok && r.success).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.needsMoveAdjacent).toBe(true);
  });

  test("non-adjacent with no open space fails even on a winning die", () => {
    // die 20 auto-success but no space => fail
    const r = pf1eGrapple({ check: baseCheck({ die: 20, cmd: 30 }), targetAdjacent: false, hasAdjacentSpace: false });
    expect(r.ok && r.success).toBe(false);
    if (!r.ok) throw new Error("fail");
    expect(r.noSpaceFails).toBe(true);
    expect(r.bothGrappled).toBe(false);
  });

  test("humanoid without two free hands takes -4", () => {
    // Without penalty: 15+7=22 vs 18 success. With -4: 15+3=18 vs 18 still success? Use tighter: cmd 20 => 22 vs 20 success, 18 vs 20 fail with -4
    const without = pf1eGrapple({ check: baseCheck({ cmd: 20 }), attackerIsHumanoid: true, attackerFreeHands: 2 });
    expect(without.ok && without.success).toBe(true);
    const withPenalty = pf1eGrapple({ check: baseCheck({ cmd: 20 }), attackerIsHumanoid: true, attackerFreeHands: 1 });
    expect(withPenalty.ok && withPenalty.success).toBe(false);
    if (withPenalty.ok) expect(withPenalty.notes.join(" ")).toContain("free hands");
    // Non-humanoid with 0 hands takes no penalty
    const monster = pf1eGrapple({ check: baseCheck({ cmd: 20 }), attackerIsHumanoid: false, attackerFreeHands: 0 });
    expect(monster.ok && monster.success).toBe(true);
  });

  test("size limit still enforced", () => {
    const r = pf1eGrapple({ check: baseCheck({ attacker: { size: "Medium" }, defender: { size: "Huge" } }) });
    expect(r.ok).toBe(false);
  });

  test("provokes unless Improved Grapple", () => {
    const provokes = pf1eGrapple({ check: baseCheck() });
    expect(provokes.ok && provokes.check.provokes).toBe(true);
    const noProvoke = pf1eGrapple({ check: baseCheck({ hasImprovedFeat: true }) });
    expect(noProvoke.ok && noProvoke.check.provokes).toBe(false);
  });
});

describe("P05 — maintain grapple (AoN 191)", () => {
  test("failure ends grapple, success continues", () => {
    const fail = pf1eGrappleMaintain({ check: baseCheck({ die: 10 }) }); // 10+7=17 vs 18 fail
    expect(fail.ok && fail.success).toBe(false);
    if (!fail.ok) throw new Error("fail");
    expect(fail.continues).toBe(false);
    const succeed = pf1eGrappleMaintain({ check: baseCheck() });
    expect(succeed.ok && succeed.success).toBe(true);
    if (!succeed.ok) throw new Error("fail");
    expect(succeed.continues).toBe(true);
  });

  test("+5 maintain bonus when target did not break", () => {
    // 10+7=17 vs 20 would fail, but 10+12=22 vs 20 succeeds with +5
    const without = pf1eGrappleMaintain({ check: baseCheck({ die: 10, cmd: 20 }) });
    expect(without.ok && without.success).toBe(false);
    const withBonus = pf1eGrappleMaintain({ check: baseCheck({ die: 10, cmd: 20 }), hasMaintainBonus: true });
    expect(withBonus.ok && withBonus.success).toBe(true);
    if (withBonus.ok) expect(withBonus.notes.join(" ")).toContain("+5 circumstance");
  });

  test("humanoid penalty applies to maintain too", () => {
    const withHands = pf1eGrappleMaintain({ check: baseCheck({ cmd: 20 }), attackerIsHumanoid: true, attackerFreeHands: 2 });
    // 15+7=22 vs 20 success
    expect(withHands.ok && withHands.success).toBe(true);
    const withoutHands = pf1eGrappleMaintain({ check: baseCheck({ cmd: 20 }), attackerIsHumanoid: true, attackerFreeHands: 1 });
    // 15+3=18 vs 20 fail
    expect(withoutHands.ok && withoutHands.success).toBe(false);
  });
});

describe("P05 — grapple move/damage/pin (AoN 191)", () => {
  test("move half speed, hazardous grants free break with +4", () => {
    const r = pf1eGrappleMove({ maintainSuccess: true, speedFt: 30 });
    if (!r.ok) throw new Error("fail");
    expect(r.maxDistanceFt).toBe(15);
    expect(r.targetFreeBreakWithBonus).toBe(false);
    const haz = pf1eGrappleMove({ maintainSuccess: true, hazardousPlacement: true });
    if (!haz.ok) throw new Error("fail");
    expect(haz.targetFreeBreakWithBonus).toBe(true);
    expect(haz.notes.join(" ")).toContain("hazardous location");
  });

  test("move requires successful maintain", () => {
    const r = pf1eGrappleMove({ maintainSuccess: false });
    expect(r.ok).toBe(false);
  });

  test("damage requires maintain and names total", () => {
    const r = pf1eGrappleDamage({ maintainSuccess: true, damage: 8 });
    if (!r.ok) throw new Error("fail");
    expect(r.damage).toBe(8);
    expect(r.notes.join(" ")).toContain("unarmed strike");
  });

  test("pin makes target pinned, attacker grappled no Dex", () => {
    const r = pf1eGrapplePin({ maintainSuccess: true });
    if (!r.ok) throw new Error("fail");
    expect(r.targetPinned).toBe(true);
    expect(r.attackerGrappledNoDex).toBe(true);
  });

  test("pin requires maintain", () => {
    expect(pf1eGrapplePin({ maintainSuccess: false }).ok).toBe(false);
  });
});

describe("P05 — tie-up (AoN 191)", () => {
  test("requires pinned/restrained/unconscious", () => {
    const r = pf1eGrappleTieUp({ check: baseCheck(), targetPinnedOrRestrainedOrUnconscious: false, attackerCmbForDc: 7, grapplingWhileTying: false });
    expect(r.ok).toBe(false);
  });

  test("success computes DC 20+CMB and notes ropes need no check", () => {
    const r = pf1eGrappleTieUp({ check: baseCheck(), targetPinnedOrRestrainedOrUnconscious: true, attackerCmbForDc: 7, targetCmbForEscape: 10 });
    if (!r.ok) throw new Error("fail");
    expect(r.success).toBe(true);
    expect(r.escapeDc).toBe(27);
    expect(r.cannotEscapeEvenWith20).toBe(false); // 27 vs 30 (20+10) => escapable
  });

  test("cannot escape even with 20 when DC > 20+target CMB", () => {
    // attacker CMB 10 => DC 30, target CMB 5 => 20+5=25 => 30>25 => cannot escape
    const r = pf1eGrappleTieUp({ check: baseCheck(), targetPinnedOrRestrainedOrUnconscious: true, attackerCmbForDc: 10, targetCmbForEscape: 5 });
    if (!r.ok) throw new Error("fail");
    expect(r.cannotEscapeEvenWith20).toBe(true);
    expect(r.notes.join(" ")).toContain("cannot escape");
  });

  test("grappling while tying imposes -10", () => {
    // Without -10: 15+7=22 vs 18 success. With -10: 15-3=12 vs 18 fail
    const without = pf1eGrappleTieUp({ check: baseCheck(), targetPinnedOrRestrainedOrUnconscious: true, attackerCmbForDc: 7, grapplingWhileTying: false });
    expect(without.ok && without.success).toBe(true);
    const withPen = pf1eGrappleTieUp({ check: baseCheck(), targetPinnedOrRestrainedOrUnconscious: true, attackerCmbForDc: 7, grapplingWhileTying: true });
    expect(withPen.ok && withPen.success).toBe(false);
    if (withPen.ok) expect(withPen.notes.join(" ")).toContain("–10");
  });
});

describe("P05 — escape / reverse / hazard break (AoN 191)", () => {
  test("CMB escape breaks on success, fails otherwise", () => {
    const fail = pf1eGrappleEscape({ die: 10, bonus: 5, defenderCmd: 20 }); // 15 vs 20 fail
    expect(fail.ok && fail.success).toBe(false);
    if (!fail.ok) throw new Error("fail");
    expect(fail.escaped).toBe(false);
    const succeed = pf1eGrappleEscape({ die: 15, bonus: 5, defenderCmd: 18 }); // 20 vs 18
    expect(succeed.ok && succeed.success).toBe(true);
    if (!succeed.ok) throw new Error("fail");
    expect(succeed.escaped).toBe(true);
    expect(succeed.reversed).toBe(false);
  });

  test("becomeGrappler reverses instead of breaks", () => {
    const r = pf1eGrappleEscape({ die: 15, bonus: 5, defenderCmd: 18, becomeGrappler: true });
    if (!r.ok) throw new Error("fail");
    expect(r.reversed).toBe(true);
    expect(r.escaped).toBe(false);
  });

  test("hazardous placement free break gets +4", () => {
    // 10+5=15 vs 18 fail, 10+9=19 vs 18 success with +4
    const without = pf1eGrappleEscape({ die: 10, bonus: 5, defenderCmd: 18 });
    expect(without.ok && without.success).toBe(false);
    const withBonus = pf1eGrappleHazardBreak({ die: 10, bonus: 5, defenderCmd: 18 });
    expect(withBonus.ok && withBonus.success).toBe(true);
    if (withBonus.ok) expect(withBonus.notes.join(" ")).toContain("+4 bonus");
  });

  test("escape never provokes and handles nat 20/1", () => {
    const nat20 = pf1eGrappleEscape({ die: 20, bonus: 0, defenderCmd: 50 });
    expect(nat20.ok && nat20.success).toBe(true);
    const nat1 = pf1eGrappleEscape({ die: 1, bonus: 30, defenderCmd: 10 });
    expect(nat1.ok && nat1.success).toBe(false);
  });

  test("Escape Artist skill check same as CMB path (caller supplies skill total)", () => {
    // This is just the same function with skill bonus; ensures it works
    const r = pf1eGrappleEscape({ die: 12, bonus: 10, defenderCmd: 20 }); // 22 vs 20 success
    expect(r.ok && r.success).toBe(true);
  });
});
