/**
 * P05/D-208 — bull rush / trip / disarm / overrun aftermaths composed over
 * the shared check layer. Each SRD sentence is a fixture, not a snapshot.
 */
import { describe, expect, test } from "vitest";
import {
  pf1eBullRush,
  pf1eDirtyTrick,
  pf1eDisarm,
  pf1eDrag,
  pf1eManeuverCheck,
  pf1eOverrun,
  pf1eReposition,
  pf1eSteal,
  pf1eTrip,
} from "../../src/packages/pf1e/maneuvers";

const base = (overrides: Record<string, unknown> = {}): import("../../src/packages/pf1e/maneuvers").PF1eManeuverCheckInput => ({
  kind: "trip" as const,
  die: 15,
  cmb: 5,
  cmd: 18,
  attacker: { size: "Medium" as const },
  defender: { size: "Medium" as const },
  ...overrides,
} as unknown as import("../../src/packages/pf1e/maneuvers").PF1eManeuverCheckInput);

describe("P05 — bull rush aftermath (AoN 189)", () => {
  test("success pushes 5 ft + 5 per 5 over CMD", () => {
    // die 15+5=20 vs 18 => margin 2 => 5 ft
    const r1 = pf1eBullRush({ check: base() });
    expect(r1.ok && r1.pushDistanceFt).toBe(5);
    // die 15+5=20 vs 15 => margin 5 => 10 ft
    const r2 = pf1eBullRush({ check: base({ cmd: 15 }) });
    expect(r2.ok && r2.pushDistanceFt).toBe(10);
    // die 15+5=20 vs 10 => margin 10 => 15 ft
    const r3 = pf1eBullRush({ check: base({ cmd: 10 }) });
    expect(r3.ok && r3.pushDistanceFt).toBe(15);
  });

  test("failure pushes 0 and ends movement in front", () => {
    const r = pf1eBullRush({ check: base({ die: 10 }) }); // 10+5=15 vs 18 fail
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("failed");
    expect(r.success).toBe(false);
    expect(r.pushDistanceFt).toBe(0);
    expect(r.notes.join(" ")).toContain("movement ends in front");
  });

  test("immobilised target auto-success still pushes at least 5 ft", () => {
    const r = pf1eBullRush({
      check: base({ defender: { size: "Medium", immobilizedOrUnconscious: true } }),
    });
    expect(r.ok && r.success).toBe(true);
    expect(r.ok && r.pushDistanceFt).toBeGreaterThanOrEqual(5);
  });

  test("size limit still enforced", () => {
    const r = pf1eBullRush({
      check: base({ attacker: { size: "Medium" }, defender: { size: "Huge" } }),
    });
    expect(r.ok).toBe(false);
  });
});

describe("P05 — trip aftermath (AoN 194)", () => {
  test("success knocks prone", () => {
    const r = pf1eTrip({ check: base() }); // 20 vs 18 success
    expect(r.ok && r.success).toBe(true);
    if (!r.ok) throw new Error("fail");
    expect(r.targetProne).toBe(true);
    expect(r.attackerProne).toBe(false);
  });

  test("fail by 10+ knocks attacker prone", () => {
    // die 10 +5=15 vs 25 => fail by 10
    const r = pf1eTrip({ check: base({ die: 10, cmd: 25 }) });
    expect(r.ok && r.success).toBe(false);
    if (!r.ok) throw new Error("fail");
    expect(r.attackerProne).toBe(true);
    expect(r.targetProne).toBe(false);
  });

  test("fail by 9 leaves everyone standing", () => {
    // 11+5=16 vs 25 => fail by 9
    const r = pf1eTrip({ check: base({ die: 11, cmd: 25 }) });
    if (!r.ok) throw new Error("fail");
    expect(r.attackerProne).toBe(false);
  });

  test("creature that cannot be tripped refuses by name", () => {
    const r = pf1eTrip({
      check: base({ defender: { size: "Medium", cannotBeTripped: true } }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot be tripped");
  });

  test("multi-legged target adds +2 CMD per extra leg", () => {
    // 6 legs => +8 CMD ( (6-2)*2 )
    // Without legs, 15+5=20 vs 18 success. With 6 legs, CMD 26 => fail
    const without = pf1eManeuverCheck(base({ kind: "trip", defender: { size: "Medium", legs: 2 } }));
    const withLegs = pf1eManeuverCheck(base({ kind: "trip", defender: { size: "Medium", legs: 6 } }));
    expect(without.ok && without.success).toBe(true);
    expect(withLegs.ok && withLegs.success).toBe(false);
    if (withLegs.ok) expect(withLegs.notes.join(" ")).toContain("6 legs");
  });
});

describe("P05 — disarm aftermath (AoN 190)", () => {
  test("success drops one item, by 10+ drops two", () => {
    const one = pf1eDisarm({ check: base() }); // 20 vs 18 margin 2 => 1
    if (!one.ok) throw new Error("fail");
    expect(one.targetDrops).toBe(1);
    const two = pf1eDisarm({ check: base({ cmd: 10 }) }); // margin 10 => 2
    if (!two.ok) throw new Error("fail");
    expect(two.targetDrops).toBe(2);
  });

  test("fail by 10+ drops your own weapon", () => {
    const r = pf1eDisarm({ check: base({ die: 10, cmd: 25 }) }); // 15 vs 25 fail by 10
    if (!r.ok) throw new Error("fail");
    expect(r.attackerDrops).toBe(true);
    expect(r.targetDrops).toBe(0);
  });

  test("disarm without weapon can pick up", () => {
    const r = pf1eDisarm({ check: base(), disarmedWithoutWeapon: true });
    if (!r.ok) throw new Error("fail");
    expect(r.canPickUp).toBe(true);
  });

  test("unarmed note", () => {
    const r = pf1eDisarm({ check: base(), attackerUnarmed: true });
    if (!r.ok) throw new Error("fail");
    expect(r.notes.join(" ")).toContain("unarmed imposes a –4");
  });
});

describe("P05 — overrun aftermath (AoN 192)", () => {
  test("target avoids => pass through without check", () => {
    const r = pf1eOverrun({ targetAvoids: true });
    if (!r.ok) throw new Error("fail");
    expect(r.moveThrough).toBe(true);
    expect(r.check).toBeNull();
  });

  test("success moves through, by 5+ knocks prone", () => {
    const success = pf1eOverrun({ check: base() }); // 20 vs 18 success margin 2 => not prone
    if (!success.ok) throw new Error("fail");
    expect(success.moveThrough).toBe(true);
    expect(success.targetProne).toBe(false);
    const prone = pf1eOverrun({ check: base({ cmd: 12 }) }); // margin 8 => prone
    if (!prone.ok) throw new Error("fail");
    expect(prone.targetProne).toBe(true);
  });

  test("failure stops in front", () => {
    const r = pf1eOverrun({ check: base({ die: 10 }) });
    if (!r.ok) throw new Error("fail");
    expect(r.moveThrough).toBe(false);
    expect(r.stoppedInFront).toBe(true);
  });

  test("multi-legged bonus applies to overrun too", () => {
    const r = pf1eOverrun({ check: base({ defender: { size: "Medium", legs: 4 } }) }); // +4 CMD => 22 => 20 vs 22 fail
    if (!r.ok) throw new Error("fail");
    expect(r.success).toBe(false);
    if (r.check) expect(r.check.notes.join(" ")).toContain("4 legs");
  });

  test("missing check when not avoided refuses", () => {
    const r = pf1eOverrun({});
    expect(r.ok).toBe(false);
  });
});

describe("P05 — dirty trick aftermath (APG p.321)", () => {
  test("success imposes condition for 1 + floor(margin/5) rounds", () => {
    const r = pf1eDirtyTrick({ check: { die: 15, cmb: 5, cmd: 18, attacker: { size: "Medium" }, defender: { size: "Medium" } }, condition: "blinded" });
    if (!r.ok) throw new Error("fail");
    expect(r.success).toBe(true);
    expect(r.condition).toBe("blinded");
    expect(r.durationRounds).toBe(1); // margin 2 => 1
    const r2 = pf1eDirtyTrick({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } }, condition: "shaken" });
    if (!r2.ok) throw new Error("fail");
    expect(r2.durationRounds).toBe(3); // margin 10 => 1+2
  });

  test("Greater Dirty Trick uses 1d4 + floor(margin/5)", () => {
    const r = pf1eDirtyTrick({ check: { die: 15, cmb: 5, cmd: 18, attacker: { size: "Medium" }, defender: { size: "Medium" } }, condition: "entangled", hasGreaterDirtyTrick: true, greaterDie: 3 });
    if (!r.ok) throw new Error("fail");
    expect(r.durationRounds).toBe(3); // 3 + 0
    expect(r.notes.join(" ")).toContain("standard action");
  });

  test("invalid condition and missing greater die refuse", () => {
    const bad = pf1eDirtyTrick({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } }, condition: "stunned" });
    expect(bad.ok).toBe(false);
    const missing = pf1eDirtyTrick({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } }, hasGreaterDirtyTrick: true });
    expect(missing.ok).toBe(false);
  });
});

describe("P05 — drag aftermath (APG p.321)", () => {
  test("success drags 5 + 5 per 5 over CMD", () => {
    const r = pf1eDrag({ check: { die: 15, cmb: 5, cmd: 18, attacker: { size: "Medium" }, defender: { size: "Medium" } } });
    if (!r.ok) throw new Error("fail");
    expect(r.dragDistanceFt).toBe(5);
    const r2 = pf1eDrag({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } } });
    if (!r2.ok) throw new Error("fail");
    expect(r2.dragDistanceFt).toBe(15);
  });

  test("failure drags 0", () => {
    const r = pf1eDrag({ check: { die: 10, cmb: 5, cmd: 20, attacker: { size: "Medium" }, defender: { size: "Medium" } } });
    if (!r.ok) throw new Error("fail");
    expect(r.dragDistanceFt).toBe(0);
  });
});

describe("P05 — reposition aftermath (APG p.322)", () => {
  test("success moves 5 + 5 per 5 over CMD", () => {
    const r = pf1eReposition({ check: { die: 15, cmb: 5, cmd: 18, attacker: { size: "Medium" }, defender: { size: "Medium" } } });
    if (!r.ok) throw new Error("fail");
    expect(r.repositionDistanceFt).toBe(5);
  });
});

describe("P05 — steal aftermath (APG p.322)", () => {
  test("success steals with free hand", () => {
    const r = pf1eSteal({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } }, attackerFreeHand: true });
    if (!r.ok) throw new Error("fail");
    expect(r.stolen).toBe(true);
  });

  test("no free hand refuses", () => {
    const r = pf1eSteal({ check: { die: 15, cmb: 5, cmd: 10, attacker: { size: "Medium" }, defender: { size: "Medium" } }, attackerFreeHand: false });
    expect(r.ok).toBe(false);
  });
});

