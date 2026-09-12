/**
 * P02 — space, natural reach and threatened-square geometry.
 *
 * Every expected value here is either transcribed from Table 8-4: Creature Size
 * and Scale (AoN Rules ID 179, CRB p.194) or counted by hand from AoN 175's
 * diagonal sentence ("the first diagonal counts as 1 square, the second counts
 * as 2 squares, the third counts as 1, the fourth as 2, and so on"). The larger
 * threat counts were cross-checked against an independent path-walking
 * implementation of that same sentence before being written down, so a fixture
 * is never merely this module's own output: the four cases derived entirely by
 * hand (Medium 8, Medium-with-reach-weapon 12, Large long 12, Large tall 28)
 * pin the method the rest are counted with.
 */
import { describe, expect, test } from "vitest";
import {
  FEET_PER_SQUARE,
  cellAt,
  cellsAlongSegment,
  footprintCells,
  footprintDistance,
  footprintDistanceFt,
  footprintSide,
  naturalReachFt,
  naturalReachSquares,
  normalizeReachShape,
  occupancy,
  reachWeaponBand,
  squareDistance,
  squareDistanceFt,
  threatenedCells,
} from "../../src/packages/pf1e/geometry";
import { cellKey } from "../../src/packages/pf1e/targeting";

const keys = (cells: readonly { col: number; row: number }[]): string[] =>
  cells.map(cellKey);

describe("P02 — Table 8-4 natural reach, tall and long (AoN 179, CRB p.194)", () => {
  test("Fine through Medium print one figure each: 0, 0, 0, 5 ft, 5 ft", () => {
    expect(naturalReachFt("Fine")).toBe(0);
    expect(naturalReachFt("Diminutive")).toBe(0);
    expect(naturalReachFt("Tiny")).toBe(0);
    expect(naturalReachFt("Small")).toBe(5);
    expect(naturalReachFt("Medium")).toBe(5);
  });

  test("the four multi-square sizes print two columns: Large 10/5, Huge 15/10, Gargantuan 20/15, Colossal 30/20", () => {
    expect(naturalReachFt("Large")).toBe(10);
    expect(naturalReachFt("Large", "long")).toBe(5);
    expect(naturalReachFt("Huge")).toBe(15);
    expect(naturalReachFt("Huge", "long")).toBe(10);
    expect(naturalReachFt("Gargantuan")).toBe(20);
    expect(naturalReachFt("Gargantuan", "long")).toBe(15);
    expect(naturalReachFt("Colossal")).toBe(30);
    expect(naturalReachFt("Colossal", "long")).toBe(20);
  });

  test("body shape is only a question for Large and larger — a long Medium is still 5 ft", () => {
    // The table prints "Small · 5 ft. · 5 ft." and "Medium · 5 ft. · 5 ft." with
    // no tall/long rows, so an authored shape for them names no second number.
    expect(naturalReachFt("Medium", "long")).toBe(5);
    expect(naturalReachFt("Small", "long")).toBe(5);
    expect(naturalReachFt("Tiny", "long")).toBe(0);
    expect(naturalReachFt("Fine", "long")).toBe(0);
  });

  test("reach in squares is the same table in the rule's own unit (AoN 175: 1 square = 5 feet)", () => {
    expect(FEET_PER_SQUARE).toBe(5);
    expect(naturalReachSquares("Medium")).toBe(1);
    expect(naturalReachSquares("Large")).toBe(2);
    expect(naturalReachSquares("Large", "long")).toBe(1);
    expect(naturalReachSquares("Colossal")).toBe(6);
    expect(naturalReachSquares("Colossal", "long")).toBe(4);
    expect(naturalReachSquares("Tiny")).toBe(0);
  });

  test("an authored shape is normalized, and a value naming neither column stays null", () => {
    expect(normalizeReachShape("long")).toBe("long");
    expect(normalizeReachShape(" Long ")).toBe("long");
    expect(normalizeReachShape("TALL")).toBe("tall");
    expect(normalizeReachShape("wide")).toBeNull();
    expect(normalizeReachShape(undefined)).toBeNull();
    expect(normalizeReachShape(2)).toBeNull();
  });

  test("a missing or unrecognized size is Medium, never an invented reach", () => {
    expect(naturalReachFt(undefined)).toBe(5);
    expect(naturalReachFt("Huge!")).toBe(5);
    expect(naturalReachSquares(null)).toBe(1);
  });
});

describe('P02 — footprints (AoN 179: "Very large creatures take up more than 1 square")', () => {
  test("one square to Medium, then 2×2, 3×3, 4×4 and 5×5", () => {
    expect(footprintSide("Fine")).toBe(1);
    expect(footprintSide("Tiny")).toBe(1);
    expect(footprintSide("Small")).toBe(1);
    expect(footprintSide("Medium")).toBe(1);
    expect(footprintSide("Large")).toBe(2);
    expect(footprintSide("Huge")).toBe(3);
    expect(footprintSide("Gargantuan")).toBe(4);
    expect(footprintSide("Colossal")).toBe(6);
  });

  test("a Large footprint is the four squares from its origin corner", () => {
    expect(footprintCells({ col: 3, row: 7 }, "Large")).toEqual([
      { col: 3, row: 7 },
      { col: 4, row: 7 },
      { col: 3, row: 8 },
      { col: 4, row: 8 },
    ]);
  });

  test("a Colossal footprint covers 36 squares — 30 ft across is 6 squares, not 5", () => {
    expect(footprintCells({ col: 0, row: 0 }, "Colossal")).toHaveLength(36);
    expect(footprintCells({ col: -2, row: 5 }, "Medium")).toEqual([
      { col: -2, row: 5 },
    ]);
  });

  test("sub-square sizes still occupy the one square they are in — a footprint of zero squares could never be located", () => {
    // Table 8-4 gives Tiny 2-1/2 ft, Diminutive 1 ft and Fine 1/2 ft of space:
    // "more than one such creature can fit into a single square". That is a
    // capacity fact (`occupancy().perSquare`), not a footprint of no cells.
    expect(footprintCells({ col: 1, row: 1 }, "Tiny")).toHaveLength(1);
    expect(footprintCells({ col: 1, row: 1 }, "Fine")).toHaveLength(1);
  });
});

describe('P02 — diagonals (AoN 175: "the first diagonal counts as 1 square, the second counts as 2")', () => {
  test("1, 2, 1, 2 down a diagonal run", () => {
    const at = (d: number) =>
      squareDistance({ col: 0, row: 0 }, { col: d, row: d });
    expect(at(1)).toBe(1);
    expect(at(2)).toBe(3);
    expect(at(3)).toBe(4);
    expect(at(4)).toBe(6);
  });

  test("straight lines count a square each, and a mixed path takes the shorter shape", () => {
    expect(squareDistance({ col: 0, row: 0 }, { col: 2, row: 0 })).toBe(2);
    expect(squareDistance({ col: 0, row: 0 }, { col: 2, row: 1 })).toBe(2);
    expect(squareDistance({ col: 0, row: 0 }, { col: 3, row: 1 })).toBe(3);
  });

  test("adjacent means adjacent including diagonally — one square, 5 feet (AoN 102)", () => {
    expect(squareDistanceFt({ col: 0, row: 0 }, { col: 1, row: 1 })).toBe(5);
    expect(squareDistanceFt({ col: 0, row: 0 }, { col: 1, row: 0 })).toBe(5);
    expect(squareDistanceFt({ col: 0, row: 0 }, { col: 0, row: 0 })).toBe(0);
  });

  test("distance is symmetric and negative offsets count the same", () => {
    const a = { col: 4, row: 9 };
    const b = { col: 1, row: 7 };
    expect(squareDistance(a, b)).toBe(squareDistance(b, a));
    // three across and two down: one straight square plus two diagonals (1 + 2).
    expect(squareDistance(a, b)).toBe(4);
  });
});

describe("P02 — footprint distance (nearest occupied square)", () => {
  test("a Large creature reaches from any square it occupies", () => {
    const large = footprintCells({ col: 0, row: 0 }, "Large"); // (0,0)-(1,1)
    // Straight out from the near edge: two squares = 10 ft, not four from the origin corner.
    expect(footprintDistance(large, [{ col: 3, row: 0 }])).toBe(2);
    expect(footprintDistanceFt(large, [{ col: 3, row: 0 }])).toBe(10);
    // Diagonally off the near corner: 5-10-5 makes this 3 squares (15 ft).
    expect(footprintDistance(large, [{ col: -2, row: -2 }])).toBe(3);
  });

  test("sharing a square is distance 0 — a Tiny creature inside its target's square (AoN 179)", () => {
    const large = footprintCells({ col: 0, row: 0 }, "Large");
    expect(footprintDistance(large, [{ col: 1, row: 1 }])).toBe(0);
    expect(footprintDistanceFt(large, [{ col: 1, row: 1 }])).toBe(0);
  });

  test("an empty footprint has nothing to measure from, so the distance is not a number the rules print", () => {
    expect(footprintDistance([], [{ col: 0, row: 0 }])).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(footprintDistanceFt([{ col: 0, row: 0 }], [])).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('P02 — threatened squares (AoN 102: "all squares adjacent to your space (including diagonally)")', () => {
  test("a Medium creature threatens exactly the eight surrounding squares, never its own", () => {
    const threat = threatenedCells({
      footprint: [{ col: 0, row: 0 }],
      reachSquares: 1,
    });
    expect(threat).toHaveLength(8);
    expect(keys(threat).sort()).toEqual(
      ["-1,-1", "-1,0", "-1,1", "0,-1", "0,1", "1,-1", "1,0", "1,1"].sort(),
    );
  });

  test("a reach weapon threatens twelve squares: the 10-ft ring, and never the adjacent dead zone (AoN 131)", () => {
    // "With a typical reach weapon, you can strike opponents 10 feet away, but
    // you can't strike adjacent foes (those within 5 feet)."
    const threat = threatenedCells({
      footprint: [{ col: 0, row: 0 }],
      reachSquares: 1,
      reachWeapon: true,
    });
    expect(threat).toHaveLength(12);
    const set = new Set(keys(threat));
    // the four squares 10 ft straight out
    for (const k of ["2,0", "-2,0", "0,2", "0,-2"])
      expect(set.has(k), k).toBe(true);
    // the eight knight's-move squares (one straight + one diagonal = 10 ft)
    for (const k of [
      "2,1",
      "2,-1",
      "-2,1",
      "-2,-1",
      "1,2",
      "1,-2",
      "-1,2",
      "-1,-2",
    ]) {
      expect(set.has(k), k).toBe(true);
    }
    // the four diagonal corners are 15 ft under 5-10-5, so a 10-ft reach misses them
    for (const k of ["2,2", "2,-2", "-2,2", "-2,-2"])
      expect(set.has(k), k).toBe(false);
    // the adjacent ring is the dead zone
    for (const k of ["1,0", "0,1", "-1,0", "0,-1", "1,1"])
      expect(set.has(k), k).toBe(false);
  });

  test("tall and long Large creatures threaten different ground — this is the whole point of Table 8-4's two columns", () => {
    const fp = footprintCells({ col: 0, row: 0 }, "Large");
    const tall = threatenedCells({
      footprint: fp,
      reachSquares: naturalReachSquares("Large"),
    });
    const long = threatenedCells({
      footprint: fp,
      reachSquares: naturalReachSquares("Large", "long"),
    });
    expect(tall).toHaveLength(28);
    expect(long).toHaveLength(12);
    // 10 ft straight out from the space: the tall form reaches it, the long one does not.
    expect(keys(tall)).toContain("3,0");
    expect(keys(long)).not.toContain("3,0");
    // both still threaten the adjacent squares — "a creature with greater than
    // normal natural reach (more than 5 feet) still threatens squares adjacent
    // to it" (AoN 179), unlike a reach weapon.
    expect(keys(tall)).toContain("2,0");
    expect(keys(long)).toContain("2,0");
    // the diagonal two squares off the footprint's corner is 15 ft under 5-10-5,
    // beyond even the tall form's 10-ft reach.
    expect(keys(tall)).not.toContain("-2,-2");
  });

  test("the bigger sizes, counted from Table 8-4's reach column", () => {
    const count = (size: "Huge" | "Gargantuan" | "Colossal", long?: boolean) =>
      threatenedCells({
        footprint: footprintCells({ col: 0, row: 0 }, size),
        reachSquares: naturalReachSquares(size, long === true ? "long" : null),
      }).length;
    expect(count("Huge")).toBe(60);
    expect(count("Huge", true)).toBe(36);
    expect(count("Gargantuan")).toBe(108);
    expect(count("Gargantuan", true)).toBe(72);
    expect(count("Colossal")).toBe(240);
    expect(count("Colossal", true)).toBe(140);
  });

  test("a Huge (tall) creature threatens 15 ft straight out but not the 20-ft diagonal corner", () => {
    const threat = new Set(
      keys(
        threatenedCells({
          footprint: footprintCells({ col: 0, row: 0 }, "Huge"),
          reachSquares: naturalReachSquares("Huge"),
        }),
      ),
    );
    expect(threat.has("0,-3")).toBe(true); // three squares straight out = 15 ft
    expect(threat.has("-3,-3")).toBe(false); // 1+2+1 squares = 20 ft by 5-10-5
    expect(threat.has("1,1")).toBe(false); // its own space is never a threatened square
  });

  test("a Large (tall) creature with a reach weapon strikes 15–20 ft out, and cannot strike within 10 ft (AoN 179)", () => {
    const threat = threatenedCells({
      footprint: footprintCells({ col: 0, row: 0 }, "Large"),
      reachSquares: naturalReachSquares("Large"),
      reachWeapon: true,
    });
    expect(threat).toHaveLength(48);
    const set = new Set(keys(threat));
    // Distances run from the near edge of the 2×2 space (col 1), not its origin.
    expect(set.has("2,0")).toBe(false); // 5 ft: inside the space's own adjacent ring
    expect(set.has("3,0")).toBe(false); // 10 ft = its natural reach — "can't strike at
    // their natural reach or less" (AoN 179), which is the reach weapon's dead zone
    expect(set.has("4,0")).toBe(true); // 15 ft
    expect(set.has("5,0")).toBe(true); // 20 ft = double natural reach
    expect(set.has("6,0")).toBe(false); // 25 ft: beyond double
  });

  test('zero reach threatens nothing: "they do not threaten the squares around them" (AoN 179)', () => {
    for (const size of ["Tiny", "Diminutive", "Fine"] as const) {
      expect(
        threatenedCells({
          footprint: footprintCells({ col: 0, row: 0 }, size),
          reachSquares: naturalReachSquares(size),
        }),
      ).toEqual([]);
      // …and a reach weapon has no band to double, so it threatens nothing either.
      expect(
        threatenedCells({
          footprint: footprintCells({ col: 0, row: 0 }, size),
          reachSquares: naturalReachSquares(size),
          reachWeapon: true,
        }),
      ).toEqual([]);
    }
  });

  test("a reach no rule prints threatens nothing rather than something guessed", () => {
    expect(
      threatenedCells({ footprint: [{ col: 0, row: 0 }], reachSquares: -1 }),
    ).toEqual([]);
    expect(
      threatenedCells({
        footprint: [{ col: 0, row: 0 }],
        reachSquares: Number.NaN,
      }),
    ).toEqual([]);
    expect(threatenedCells({ footprint: [], reachSquares: 1 })).toEqual([]);
  });

  test("the threat set is ordered row-then-column, so a draw list is stable", () => {
    const threat = threatenedCells({
      footprint: [{ col: 0, row: 0 }],
      reachSquares: 1,
    });
    expect(keys(threat)).toEqual([
      "-1,-1",
      "0,-1",
      "1,-1",
      "-1,0",
      "1,0",
      "-1,1",
      "0,1",
      "1,1",
    ]);
    // recomputing gives the identical list — no Set iteration order leaking through
    expect(
      keys(
        threatenedCells({ footprint: [{ col: 0, row: 0 }], reachSquares: 1 }),
      ),
    ).toEqual(keys(threat));
  });
});

describe("P02 — the reach-weapon band (AoN 131 + AoN 179)", () => {
  test("Small and Medium: beyond 5 ft, up to 10 ft", () => {
    expect(reachWeaponBand("Medium")).toEqual({
      minSquares: 1,
      maxSquares: 2,
      minFt: 5,
      maxFt: 10,
    });
    expect(reachWeaponBand("Small")).toEqual(reachWeaponBand("Medium"));
  });

  test("Large and larger: beyond natural reach, up to double it — tall and long differ", () => {
    expect(reachWeaponBand("Large")).toEqual({
      minSquares: 2,
      maxSquares: 4,
      minFt: 10,
      maxFt: 20,
    });
    expect(reachWeaponBand("Large", "long")).toEqual({
      minSquares: 1,
      maxSquares: 2,
      minFt: 5,
      maxFt: 10,
    });
    expect(reachWeaponBand("Colossal")).toEqual({
      minSquares: 6,
      maxSquares: 12,
      minFt: 30,
      maxFt: 60,
    });
  });

  test("zero natural reach has no band to double", () => {
    expect(reachWeaponBand("Tiny")).toBeNull();
    expect(reachWeaponBand("Diminutive")).toBeNull();
    expect(reachWeaponBand("Fine")).toBeNull();
  });
});

describe("P02 — occupancy of sub-square creatures (AoN 179 and AoN 176)", () => {
  test("four Tiny, 25 Diminutive or 100 Fine fit in one square", () => {
    expect(occupancy("Tiny").perSquare).toBe(4);
    expect(occupancy("Diminutive").perSquare).toBe(25);
    expect(occupancy("Fine").perSquare).toBe(100);
  });

  test("they must enter an opponent's square to attack, it provokes, they threaten nothing and they cannot flank", () => {
    for (const size of ["Tiny", "Diminutive", "Fine"] as const) {
      const o = occupancy(size);
      expect(o.takesLessThanOneSquare, size).toBe(true);
      expect(o.canEnterOccupiedSquare, size).toBe(true);
      expect(o.mustEnterOpponentSquareToAttack, size).toBe(true);
      expect(o.enteringProvokes, size).toBe(true);
      expect(o.threatensNothing, size).toBe(true);
      expect(o.cannotFlank, size).toBe(true);
    }
  });

  test("Small and larger carry none of those exceptions", () => {
    for (const size of ["Small", "Medium", "Large", "Colossal"] as const) {
      const o = occupancy(size);
      expect(o.perSquare, size).toBe(1);
      expect(o.takesLessThanOneSquare, size).toBe(false);
      expect(o.canEnterOccupiedSquare, size).toBe(false);
      expect(o.mustEnterOpponentSquareToAttack, size).toBe(false);
      expect(o.enteringProvokes, size).toBe(false);
      expect(o.threatensNothing, size).toBe(false);
      expect(o.cannotFlank, size).toBe(false);
    }
  });
});

describe("cellAt — the strategic layer's point → square conversion (P01)", () => {
  test("feet are bucketed by the scene's own cell size", () => {
    // Model positions are points in feet; the square-based rules (threat, AoN 183's
    // line test) only apply once a point is resolved to the square it stands in.
    expect(cellAt(0, 0, 5)).toEqual({ col: 0, row: 0 });
    expect(cellAt(2, 2, 5)).toEqual({ col: 0, row: 0 }); // cell centres are not required
    expect(cellAt(5, 5, 5)).toEqual({ col: 1, row: 1 });
    expect(cellAt(9.999, 9.999, 5)).toEqual({ col: 1, row: 1 });
    expect(cellAt(25, 25, 5)).toEqual({ col: 5, row: 5 });
  });

  test("negative coordinates floor, so squares west/north of the origin are real squares", () => {
    // Math.floor, not truncation: a model at −1 ft is inside cell −1, not cell 0 —
    // truncation would put it in the same square as a model 4 ft away on the other
    // side of the origin, which is the "two models, one square" degeneracy the
    // deploy-spacing change (D-182) removes.
    expect(cellAt(-1, -1, 5)).toEqual({ col: -1, row: -1 });
    expect(cellAt(-5, -5, 5)).toEqual({ col: -1, row: -1 });
    expect(cellAt(-0.1, 4.9, 5)).toEqual({ col: -1, row: 0 });
  });

  test("a scene with a different cell size re-buckets the same points", () => {
    // The 10-ft scene: the same coordinates are half as many squares, which is
    // exactly what P01's "one scale per scene" is meant to make explicit.
    expect(cellAt(9, 9, 10)).toEqual({ col: 0, row: 0 });
    expect(cellAt(10, 10, 10)).toEqual({ col: 1, row: 1 });
    expect(cellAt(25, 25, 10)).toEqual({ col: 2, row: 2 });
  });
});

describe("cellsAlongSegment — the squares a straight move walks through (P06)", () => {
  test("a straight run and a straight march list every square stepped through, in order", () => {
    // 5-ft squares: (0,0) → (20,0) walks columns 1..4 along row 0.
    expect(cellsAlongSegment({ x: 0, y: 0 }, { x: 20, y: 0 }, 5)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
      { col: 4, row: 0 },
    ]);
    expect(cellsAlongSegment({ x: 2, y: 2 }, { x: 2, y: 12 }, 5)).toEqual([
      { col: 0, row: 0 },
      { col: 0, row: 1 },
      { col: 0, row: 2 },
    ]);
  });

  test("a diagonal move is a diagonal step — never through the squares it merely grazes", () => {
    // (2,2) → (12,12) is two 45° diagonal steps on the grid. The geometric line runs
    // exactly through the corners (5,5) and (10,10), and a sweep would report the two
    // squares beside each corner; a creature moving diagonally is in neither of them,
    // so neither can be a threatened square it "left".
    expect(cellsAlongSegment({ x: 2, y: 2 }, { x: 12, y: 12 }, 5)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 1 },
      { col: 2, row: 2 },
    ]);
    // A knight's move (2 across, 1 down) has exactly one intermediate square, and it is
    // the one the grid line names.
    expect(cellsAlongSegment({ x: 2, y: 2 }, { x: 12, y: 7 }, 5)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 1 },
    ]);
    // The mirror image picks the other intermediate square, symmetrically.
    expect(cellsAlongSegment({ x: 2, y: 7 }, { x: 12, y: 2 }, 5)).toEqual([
      { col: 0, row: 1 },
      { col: 1, row: 1 },
      { col: 2, row: 0 },
    ]);
  });

  test("direction, scale and degenerate input", () => {
    // Reversing the endpoints reverses the walk.
    expect(
      cellsAlongSegment({ x: 12, y: 12 }, { x: 2, y: 2 }, 5).map((c) => `${c.col},${c.row}`),
    ).toEqual(["2,2", "1,1", "0,0"]);
    // A 10-ft scene halves the number of squares for the same distance.
    expect(cellsAlongSegment({ x: 0, y: 0 }, { x: 20, y: 0 }, 10)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
    // Moves that stay inside one square, and moves that are not moves at all.
    expect(cellsAlongSegment({ x: 1, y: 1 }, { x: 3, y: 4 }, 5)).toEqual([{ col: 0, row: 0 }]);
    expect(cellsAlongSegment({ x: 1, y: 1 }, { x: 1, y: 1 }, 5)).toEqual([{ col: 0, row: 0 }]);
    // West and north of the origin floor, exactly as `cellAt` does.
    expect(cellsAlongSegment({ x: -1, y: -1 }, { x: -12, y: -1 }, 5)).toEqual([
      { col: -1, row: -1 },
      { col: -2, row: -1 },
      { col: -3, row: -1 },
    ]);
    // Degenerate scales and coordinates answer with nothing, never a guessed path.
    expect(cellsAlongSegment({ x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toEqual([]);
    expect(cellsAlongSegment({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, 5)).toEqual([]);
  });

  test("a long march lists each square once, however far it goes", () => {
    const cells = cellsAlongSegment({ x: 0, y: 0 }, { x: 300, y: 0 }, 5);
    expect(cells).toHaveLength(61); // 300 ft / 5 ft + the start square
    expect(cells[60]).toEqual({ col: 60, row: 0 });
    expect(new Set(cells.map((c) => `${c.col},${c.row}`)).size).toBe(cells.length);
  });
});
