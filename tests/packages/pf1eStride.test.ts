import { describe, expect, test } from "vitest";
import {
  planPF1eStride,
  stridePaceFactor,
  PF1E_CHARGE_MIN_FEET,
} from "../../src/packages/pf1e/stride";

/**
 * M05 — the movement pricing both strategic turn modes share.
 *
 * These tests are the contract the module's two march paths depend on, and one of them is a
 * parity test on purpose: with no difficult squares authored, the stride must reproduce the
 * plain Euclidean walk the sim has always run, to the foot. Seeded-replay goldens (the 10k
 * scale gate's "same seed replays to the same wire bytes") rest on that.
 */

const OPEN = new Set<string>();

function stride(
  input: Parameters<typeof planPF1eStride>[0],
): ReturnType<typeof planPF1eStride> {
  return planPF1eStride(input);
}

describe("PF1e stride pricing (M05, CRB p.188)", () => {
  test("the pace factors are the SRD's: walk 1×, charge and withdraw 2×, run 4×", () => {
    expect(stridePaceFactor("march")).toBe(1);
    expect(stridePaceFactor("charge")).toBe(2);
    expect(stridePaceFactor("withdraw")).toBe(2);
    expect(stridePaceFactor("run")).toBe(4);
  });

  test("open ground walks the straight line the order drew, capped by the budget", () => {
    // 4 move points × 5 ft × march = 20 ft, against a 50-ft leg.
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 50, y: 0 }],
      pace: "march",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toBeNull();
    expect(r.traveled).toBeCloseTo(20, 6);
    expect(r.to.x).toBeCloseTo(20, 6);
    expect(r.to.y).toBeCloseTo(0, 6);
    expect(r.terrainSquares).toBe(0);
    expect(r.terrainExtra).toBe(0);
  });

  test("a double-pace march reaches the same distance a run does at four times", () => {
    const charge = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 100, y: 0 }],
      pace: "charge",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
    });
    const run = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 100, y: 0 }],
      pace: "run",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(charge.traveled).toBeCloseTo(40, 6);
    expect(run.traveled).toBeCloseTo(80, 6);
  });

  test("a run is a straight line: a second waypoint is refused, not truncated", () => {
    const r = stride({
      from: { x: 0, y: 0 },
      path: [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      pace: "run",
      movePoints: 8,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toContain("straight line");
    expect(r.refusal).toContain("CRB p.188");
    // Refused means nobody moved — the first leg is not walked "partway" as if it were legal.
    expect(r.to).toEqual({ x: 0, y: 0 });
    expect(r.traveled).toBe(0);
    expect(r.legs).toBe(2);
  });

  test("a charge is a straight line too", () => {
    const r = stride({
      from: { x: 0, y: 0 },
      path: [
        { x: 15, y: 0 },
        { x: 15, y: 15 },
      ],
      pace: "charge",
      movePoints: 8,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toContain("charge must be a straight line");
  });

  test("a charge under 10 feet is not a charge", () => {
    expect(PF1E_CHARGE_MIN_FEET).toBe(10);
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 5, y: 0 }],
      pace: "charge",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toContain("at least 10 ft");
    expect(r.to).toEqual({ x: 0, y: 0 });
  });

  test("a formation that cannot afford the double speed does not get to call it a charge", () => {
    // 1 move point at 5 ft, doubled by the charge = 10 ft of budget against a 60-ft leg — it
    // covers exactly 10 ft, so this one *is* legal; 9 ft is not, and the refusal is the point.
    const enough = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 60, y: 0 }],
      pace: "charge",
      movePoints: 1,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(enough.refusal).toBeNull();
    expect(enough.traveled).toBeCloseTo(10, 6);

    const short = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 60, y: 0 }],
      pace: "charge",
      movePoints: 0.9,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(short.refusal).toContain("covers 9 ft");
  });

  test("a charge cannot cross difficult terrain (CRB p.188)", () => {
    // The leg enters cols 3 and 4 (x = 15 and x = 20), both authored rough.
    const difficult = new Set(["3,0", "4,0"]);
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 20, y: 0 }],
      pace: "charge",
      movePoints: 8,
      cellFeet: 5,
      difficult,
    });
    expect(r.refusal).toContain("cannot cross difficult terrain");
    expect(r.refusal).toContain("2 rough square(s)");
    expect(r.to).toEqual({ x: 0, y: 0 });
  });

  test("difficult terrain doubles what a square costs, so the march stops short", () => {
    // 4 move points × 5 ft = 20 ft of budget across a 20-ft leg whose last two squares are
    // rough: the open half costs 10, each rough square costs 10, so the walk buys 15 ft of
    // ground and stops at the edge of the second rough square.
    const difficult = new Set(["3,0", "4,0"]);
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 20, y: 0 }],
      pace: "march",
      movePoints: 4,
      cellFeet: 5,
      difficult,
    });
    expect(r.refusal).toBeNull();
    expect(r.traveled).toBeCloseTo(15, 6);
    expect(r.to.x).toBeCloseTo(15, 6);
    expect(r.terrainSquares).toBe(1);
    expect(r.terrainExtra).toBeCloseTo(5, 6);
  });

  test("standing in bad ground costs nothing; moving through it does", () => {
    // The origin square is rough and nothing else is: CRB p.188 prices the squares you *enter*.
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 10, y: 0 }],
      pace: "march",
      movePoints: 2,
      cellFeet: 5,
      difficult: new Set(["0,0"]),
    });
    expect(r.terrainSquares).toBe(0);
    expect(r.traveled).toBeCloseTo(10, 6);
  });

  test("a wall clips the leg before the terrain is priced, and stops the march there", () => {
    // Half of a 40-ft leg is behind the wall; the budget (4×5×2 = 40 at march… here 20 ft)
    // is irrelevant — what matters is that the walk never crosses to the far side.
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 40, y: 0 }],
      pace: "march",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
      blockAt: () => 0.25,
    });
    expect(r.hitWall).toBe(true);
    // The walk keeps its epsilon short of the wall, so it reports 9.999 ft, not a rounded 10.
    expect(r.to.x).toBeCloseTo(9.999, 4);
    expect(r.traveled).toBeCloseTo(9.999, 4);

    // A wall with nothing beyond it: the budget runs out first, so this is not a blocked march.
    const short = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 50, y: 0 }],
      pace: "march",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
      blockAt: () => 0.9,
    });
    expect(short.hitWall).toBe(false);
    expect(short.traveled).toBeCloseTo(20, 6);
  });

  test("a unit with no movement is refused by name rather than issued a zero-distance march", () => {
    const r = stride({
      from: { x: 0, y: 0 },
      path: [{ x: 20, y: 0 }],
      pace: "march",
      movePoints: 0,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toContain("no movement to spend");
  });

  test("zero-length waypoints are walked through, and a degenerate path is a no-op, not a refusal", () => {
    const r = stride({
      from: { x: 0, y: 0 },
      path: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      pace: "march",
      movePoints: 4,
      cellFeet: 5,
      difficult: OPEN,
    });
    expect(r.refusal).toBeNull();
    expect(r.legs).toBe(1);
    expect(r.traveled).toBeCloseTo(10, 6);
  });
});
