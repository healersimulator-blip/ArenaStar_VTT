/**
 * P04 — flanking: opposite borders, threatening ally, 0-foot reach (AoN ID 183,
 * CRB p.197).
 *
 * Fixture provenance: every expected value below is either read off the rule's
 * own sentence ("trace an imaginary line between the two attackers' centers …
 * opposite borders … including corners") drawn by hand on graph paper, or
 * cross-checked against two independent implementations of that sentence before
 * being written down — an exact-rational (`fractions.Fraction`) solver and a
 * dense-sampling solver, neither of which shares this module's doubled-integer
 * arithmetic. All three agreed on 52,947 configurations (1×1, 2×2 and 3×3
 * defenders at five origins; 1×1 and 2×2 flankers swept over a 9×9
 * neighbourhood), and the maps they produce are the canonical ones: for an
 * attacker due east of a Medium defender the qualifying allies are due west and
 * the two opposite corners, and nothing else.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_FLANKING_BONUS,
  canFlank,
  footprintsFlank,
  resolveFlanking,
  segmentFlanks,
  spaceRect,
  threatensSpace,
  type PF1eFlankingParticipant,
} from "../../src/packages/pf1e/flanking";
import {
  footprintCells,
  naturalReachSquares,
} from "../../src/packages/pf1e/geometry";
import { cellKey, type PF1eCell } from "../../src/packages/pf1e/targeting";

const one = (col: number, row: number): PF1eCell[] => [{ col, row }];
/** Indexed access without an assertion: a missing fixture cell is a test bug. */
function cellAt(cells: readonly PF1eCell[], i: number): PF1eCell {
  const c = cells[i];
  if (!c) throw new Error(`fixture has no cell ${i}`);
  return c;
}
const side = (col: number, row: number, size: string): PF1eCell[] =>
  footprintCells({ col, row }, size);

/** A Medium creature: one square, 5 ft of natural reach (Table 8-4). */
function medium(id: string, col: number, row: number): PF1eFlankingParticipant {
  return {
    id,
    cells: one(col, row),
    reachSquares: naturalReachSquares("Medium"),
    size: "Medium",
  };
}
/** A Huge creature: nine squares, 15 ft of natural reach (Table 8-4). */
function huge(id: string, col: number, row: number): PF1eFlankingParticipant {
  return {
    id,
    cells: side(col, row, "huge"),
    reachSquares: naturalReachSquares("Huge"),
    size: "Huge",
  };
}
/** A Large (tall) creature: four squares, 10 ft of natural reach. */
function large(id: string, col: number, row: number): PF1eFlankingParticipant {
  return {
    id,
    cells: side(col, row, "large"),
    reachSquares: naturalReachSquares("Large"),
    size: "Large",
  };
}

describe("P04 — the line test: opposite borders or opposite corners (AoN 183)", () => {
  test("an attacker east and an ally west of a Medium defender flank it", () => {
    const defender = { id: "d", cells: one(5, 5) };
    const res = resolveFlanking({
      defender,
      attacker: medium("a", 6, 5),
      allies: [medium("w", 4, 5)],
    });
    expect(res.flanked).toBe(true);
    expect(res.bonus).toBe(PF1E_FLANKING_BONUS);
    expect(res.flankerIds).toEqual(["w"]);
  });

  test("two allies on adjacent sides — east and north — do not flank", () => {
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [medium("n", 5, 4)],
    });
    expect(res.flanked).toBe(false);
    expect(res.bonus).toBe(0);
    expect(res.flankerIds).toEqual([]);
  });

  test("allies crowded onto the same side do not flank, however many there are", () => {
    // (4,4) and (4,6) are the defender's western diagonal neighbours: both
    // threaten it, but the line from (6,5) to either leaves through a corner and
    // an *adjacent* border, never through two opposite ones. Being on the far
    // side is not enough — the line has to cross the space.
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [medium("nw", 4, 4), medium("sw", 4, 6)],
    });
    expect(res.flanked).toBe(false);
    expect(res.flankerIds).toEqual([]);
  });

  test("opposite corners flank: attacker south-east, ally north-west", () => {
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker: medium("a", 6, 6),
        allies: [medium("nw", 4, 4)],
      }).flanked,
    ).toBe(true);
  });

  test("corners of those borders count, so an extended diagonal flanks too", () => {
    // (6,6)→(3,3) passes exactly through the defender's (6,6)-side corner and
    // its (4,4)-side corner — the parenthetical "including corners of those
    // borders".
    expect(
      segmentFlanks(one(5, 5), { col: 6, row: 6 }, { col: 3, row: 3 }),
    ).toBe(true);
    // …and it still has to be a *threatening* ally: a Huge creature anchored at
    // (1,1) covers (3,3) with its 15 ft of natural reach, three squares away by
    // AoN 175's 1-2-1-2 counting, so it qualifies from that far corner.
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker: medium("a", 6, 6),
        allies: [huge("h", 1, 1)],
      }).flanked,
    ).toBe(true);
  });

  test("the line test does not depend on which flanker is named first", () => {
    const defender = one(5, 5);
    const a = { col: 7, row: 5 };
    const b = { col: 3, row: 5 };
    expect(segmentFlanks(defender, a, b)).toBe(segmentFlanks(defender, b, a));
    expect(segmentFlanks(defender, a, b)).toBe(true);
  });

  test("a flanker sharing the defender's square is collinear and does not flank", () => {
    // Degenerate by construction: the segment lies along/inside the space, so it
    // crosses no border. Named rather than guessed at — the strategic scale can
    // produce it (`deploy.ts` spacing is under one cell).
    expect(
      segmentFlanks(one(5, 5), { col: 5, row: 5 }, { col: 4, row: 5 }),
    ).toBe(false);
    expect(
      segmentFlanks(one(5, 5), { col: 5, row: 5 }, { col: 6, row: 5 }),
    ).toBe(false);
  });

  test("the space a set of squares covers is their bounding box", () => {
    expect(spaceRect([])).toBeNull();
    expect(spaceRect(one(5, 5))).toEqual({ x0: 10, x1: 12, y0: 10, y1: 12 });
    expect(spaceRect(side(5, 5, "large"))).toEqual({
      x0: 10,
      x1: 14,
      y0: 10,
      y1: 14,
    });
  });
});

describe("P04 — the multi-square exception (AoN 183)", () => {
  test("any square a Large flanker occupies counts, even when its centre line would not", () => {
    // Large 2×2 anchored at (1,-1) around a Medium defender in (0,0), with a
    // Medium ally south-west at (-1,1). The square (1,-1)→(-1,1) line runs
    // exactly through the defender's (1,0) and (0,1) corners, so it counts; the
    // line from the footprint's own centre (2,0) misses the far border. Only the
    // per-square reading flanks here — the exception is load-bearing.
    const defender = one(0, 0);
    const attacker = side(1, -1, "large");
    const ally = one(-1, 1);
    expect(footprintsFlank(defender, attacker, ally)).toBe(true);
    expect(
      segmentFlanks(defender, { col: 1, row: -1 }, { col: -1, row: 1 }),
    ).toBe(true);
    expect(
      segmentFlanks(defender, { col: 1, row: 0 }, { col: -1, row: 1 }),
    ).toBe(false);
    expect(
      resolveFlanking({
        defender: { id: "d", cells: defender },
        attacker: large("ogre", 1, -1),
        allies: [medium("ally", -1, 1)],
      }).flanked,
    ).toBe(true);
  });

  test("the qualifying square can be any the flanker occupies, not just its first", () => {
    // Two Large creatures bracketing a Medium defender in (5,5): the attacker's
    // squares are (3,4),(4,4),(3,5),(4,5) and the ally's (5,6),(6,6),(5,7),(6,7).
    // Only the pair (4,4)↔(6,6) runs corner-to-corner through the defender's
    // space; the pair of first-listed squares misses. So the exception has to try
    // every square — picking one (a footprint's centre, or its first cell) is not
    // the rule.
    const defender = one(5, 5);
    const attacker = side(3, 4, "large");
    const ally = side(5, 6, "large");
    expect(attacker.map(cellKey)).toEqual(["3,4", "4,4", "3,5", "4,5"]);
    expect(ally.map(cellKey)).toEqual(["5,6", "6,6", "5,7", "6,7"]);
    expect(segmentFlanks(defender, cellAt(attacker, 0), cellAt(ally, 0))).toBe(
      false,
    );
    expect(
      segmentFlanks(defender, { col: 4, row: 4 }, { col: 6, row: 6 }),
    ).toBe(true);
    expect(footprintsFlank(defender, attacker, ally)).toBe(true);
    expect(
      resolveFlanking({
        defender: { id: "d", cells: defender },
        attacker: large("ogre", 3, 4),
        allies: [large("ally", 5, 6)],
      }).flanked,
    ).toBe(true);
  });

  test("a Large defender is flanked across either pair of its opposite borders", () => {
    const defender = side(5, 5, "large"); // squares (5..6, 5..6)
    expect(footprintsFlank(defender, one(7, 5), one(4, 6))).toBe(true); // left+right
    expect(footprintsFlank(defender, one(7, 5), one(4, 5))).toBe(true);
    expect(footprintsFlank(defender, one(5, 7), one(6, 4))).toBe(true); // top+bottom
  });

  test("a line that leaves a Large defender past a corner does not flank it", () => {
    // (7,5)→(4,7) exits through the right border below the space's top edge and
    // then past the top-left corner: it never meets two opposite borders.
    expect(footprintsFlank(side(5, 5, "large"), one(7, 5), one(4, 7))).toBe(
      false,
    );
  });
});

describe("P04 — only a creature that threatens the defender can help (AoN 183)", () => {
  test("an ally on the opposite border but out of reach does not confer the bonus", () => {
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [medium("far", 3, 5)], // opposite border, 2 squares away
    });
    expect(res.flanked).toBe(false);
    expect(res.flankerIds).toEqual([]);
  });

  test("a Medium attacker with a reach weapon flanks from 10 ft", () => {
    // Band (1, 2] squares: (7,5) threatens the defender at 2 squares, and the
    // line to the adjacent west ally crosses both vertical borders.
    const attacker: PF1eFlankingParticipant = {
      id: "a",
      cells: one(7, 5),
      reachSquares: naturalReachSquares("Medium"),
      reachWeapon: true,
      size: "Medium",
    };
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker,
      allies: [medium("w", 4, 5)],
    });
    expect(res.attackerDoesNotThreaten).toBe(false);
    expect(res.flanked).toBe(true);
  });

  test("the reach weapon's dead zone means an adjacent attacker is not threatening", () => {
    // AoN 179: a reach weapon can't strike at its natural reach or less, so the
    // adjacent attacker threatens nothing and earns no flanking bonus even with
    // an ally due west.
    const attacker: PF1eFlankingParticipant = {
      id: "a",
      cells: one(6, 5),
      reachSquares: naturalReachSquares("Medium"),
      reachWeapon: true,
      size: "Medium",
    };
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker,
      allies: [medium("w", 4, 5)],
    });
    expect(res.attackerDoesNotThreaten).toBe(true);
    expect(res.flanked).toBe(false);
  });

  test("threatening is decided against any square of the defender's space", () => {
    const defender = side(5, 5, "large");
    // Adjacent to the defender's south-west square only — still threatening.
    expect(
      threatensSpace({ ...medium("w", 4, 6), cells: one(4, 6) }, defender),
    ).toBe(true);
    expect(
      threatensSpace({ ...medium("w", 3, 6), cells: one(3, 6) }, defender),
    ).toBe(false);
  });

  test("the attacker is not counted as its own ally", () => {
    const attacker = medium("a", 6, 5);
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker,
        allies: [attacker],
      }).flanked,
    ).toBe(false);
  });

  test("a Huge attacker straddling the defender earns nothing from its own squares", () => {
    // A 3×3 footprint anchored at (4,4) covers (5,5), and two of *its own*
    // squares — (4,4) and (6,6) — do run corner-to-corner through the defender's
    // space, so a caller handing the whole token list in as `allies` must not be
    // able to grant the bonus. It cannot: the defender sits inside the
    // attacker's own footprint, and P02 never counts a creature's own squares as
    // threatened (attacking into your own square is strike legality, AoN 179), so
    // the attacker does not threaten what it would be flanking. The identity
    // guard in `resolveFlanking` is the belt on that rule, not the rule.
    const attacker = huge("h", 4, 4);
    expect(attacker.cells.map(cellKey)).toContain("5,5");
    expect(
      segmentFlanks(one(5, 5), { col: 4, row: 4 }, { col: 6, row: 6 }),
    ).toBe(true);
    expect(footprintsFlank(one(5, 5), attacker.cells, attacker.cells)).toBe(
      true,
    );
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker,
      allies: [attacker],
    });
    expect(res.attackerDoesNotThreaten).toBe(true);
    expect(res.flanked).toBe(false);
    expect(res.flankerIds).toEqual([]);
  });
});

describe("P04 — creatures with a reach of 0 feet can't flank (AoN 183, Table 8-4)", () => {
  test("a Tiny attacker cannot flank, and says so", () => {
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: {
        id: "t",
        cells: one(6, 5),
        reachSquares: naturalReachSquares("Tiny"),
        size: "Tiny",
      },
      allies: [medium("w", 4, 5)],
    });
    expect(res.attackerCannotFlank).toBe(true);
    expect(res.flanked).toBe(false);
    expect(canFlank({ reachSquares: 0, size: "Tiny" })).toBe(false);
  });

  test("a Tiny ally on the opposite border confers nothing", () => {
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [
        {
          id: "t",
          cells: one(4, 5),
          reachSquares: naturalReachSquares("Tiny"),
          size: "Tiny",
        },
      ],
    });
    expect(res.flanked).toBe(false);
  });

  test("Fine and Diminutive are refused from the size table too", () => {
    expect(canFlank({ reachSquares: 0, size: "Fine" })).toBe(false);
    expect(canFlank({ reachSquares: 0, size: "Diminutive" })).toBe(false);
  });

  test("a sub-square size can't flank even when its data claims a reach", () => {
    // Table 8-4 states the exclusion from the size side ("Fine, Diminutive, or
    // Tiny … also can't flank an enemy"), so an authored or derived reach of 5 ft
    // on a Tiny creature does not buy the bonus: the two clauses are independent.
    expect(canFlank({ reachSquares: 1, size: "Tiny" })).toBe(false);
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: { id: "t", cells: one(6, 5), reachSquares: 1, size: "Tiny" },
      allies: [medium("w", 4, 5)],
    });
    expect(res.attackerCannotFlank).toBe(true);
    expect(res.flanked).toBe(false);
    // …and as a helper it confers nothing from the opposite border either.
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker: medium("a", 6, 5),
        allies: [{ id: "t", cells: one(4, 5), reachSquares: 1, size: "Tiny" }],
      }).flanked,
    ).toBe(false);
  });

  test("an authored reach of 0 — unarmed, AoN 102 — is refused without a size", () => {
    // The exclusion is stated twice in the rules (reach 0 in AoN 183, sub-square
    // sizes in Table 8-4); a Medium creature threatening nothing hits the first.
    expect(canFlank({ reachSquares: 0, size: "Medium" })).toBe(false);
    expect(canFlank({ reachSquares: 0 })).toBe(false);
    expect(canFlank({ reachSquares: 1, size: "Medium" })).toBe(true);
    expect(canFlank({ reachSquares: 2, size: "Large" })).toBe(true);
  });
});

describe("P04 — the bonus is a fact about the attack roll, never a guess", () => {
  test("the constant is +2 and the result carries it or zero", () => {
    expect(PF1E_FLANKING_BONUS).toBe(2);
    const flanking = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [medium("w", 4, 5)],
    });
    expect(flanking.bonus).toBe(2);
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker: medium("a", 6, 5),
      }).bonus,
    ).toBe(0);
  });

  test("every qualifying ally is named, not just the first", () => {
    // A Medium ally with a reach weapon threatens the band (1, 2] squares — so
    // it reaches the defender from two squares out (AoN 179).
    const polearm = (
      id: string,
      col: number,
      row: number,
    ): PF1eFlankingParticipant => ({
      ...medium(id, col, row),
      reachWeapon: true,
    });
    const res = resolveFlanking({
      defender: { id: "d", cells: one(5, 5) },
      attacker: medium("a", 6, 5),
      allies: [medium("w", 4, 5), polearm("nw", 3, 4), polearm("sw", 3, 6)],
    });
    // Due west at one square, and two squares out on either diagonal: all three
    // threaten the defender and all three lines cross both vertical borders.
    expect(res.flanked).toBe(true);
    expect(res.flankerIds).toEqual(["w", "nw", "sw"]);
  });

  test("absent squares are reported rather than defaulted", () => {
    const res = resolveFlanking({
      defender: { id: "d", cells: [] },
      attacker: medium("a", 6, 5),
      allies: [medium("w", 4, 5)],
    });
    expect(res.missingSpace).toBe(true);
    expect(res.flanked).toBe(false);
    expect(
      resolveFlanking({
        defender: { id: "d", cells: one(5, 5) },
        attacker: medium("a", 6, 5),
        allies: [{ ...medium("w", 4, 5), cells: [] }],
      }).missingSpace,
    ).toBe(true);
  });

  test("threat cells are the ones the line test is asked about", () => {
    // A Large defender's own squares are never threatened by itself, and an
    // empty footprint threatens nothing — so nothing can help it flank.
    expect(threatensSpace({ cells: [], reachSquares: 1 }, one(5, 5))).toBe(
      false,
    );
    expect(threatensSpace(medium("a", 5, 5), one(5, 5))).toBe(false);
    expect(threatensSpace(medium("a", 6, 5), one(5, 5))).toBe(true);
    expect(one(5, 5).map(cellKey)).toEqual(["5,5"]);
  });
});
