/**
 * P04 — positional defenses (cover, concealment). Every fixture below was
 * worked out on paper from AoN 181/182's text before being written down; the
 * grid is the default scene's (100 world units per 5-ft square), so cell
 * (col,row) spans [col·100, (col+1)·100] × [row·100, (row+1)·100].
 */
import { describe, expect, test } from "vitest";
import {
  CONCEALMENT_MISS_CHANCE,
  concealmentGrade,
  concealmentOutcome,
  coverBetween,
  LOW_OBSTACLE_RANGE_FT,
  TOTAL_CONCEALMENT_MISS_CHANCE,
  type PF1eWorldSegment,
} from "../../src/packages/pf1e/positional";
import type { PF1eAreaGrid, PF1eCell } from "../../src/packages/pf1e/targeting";

const grid: PF1eAreaGrid = {
  cellSize: 100,
  feetPerCell: 5,
  diagonals: "5105",
};
const cell = (col: number, row: number): PF1eCell => ({ col, row });
const seg = (x1: number, y1: number, x2: number, y2: number): PF1eWorldSegment => ({
  x1,
  y1,
  x2,
  y2,
});

describe("coverBetween — AoN 181 ranged rules", () => {
  test("open field: no cover at any range", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [],
      ranged: true,
    });
    expect(r.kind).toBe("none");
    expect(r.acBonus).toBe(0);
    expect(r.blockedLines).toBe(0);
  });

  test("a wall fully between attacker and target is total cover — no attack", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [seg(200, 0, 200, 100)], // the border between cells (1,0) and (2,0)
      ranged: true,
    });
    expect(r.kind).toBe("total");
    expect(r.clearLines).toBe(0);
  });

  test("a half-height wall grants cover, not total cover (choose-a-corner)", () => {
    // Wall x=200 covering y in [50,100] (the south half of the border).
    // Hand-counted: corner (100,0) still sees (300,0) and (400,0) clean, but
    // every corner has at least one blocked line, so the ranged attacker —
    // who may choose a corner, not a line — takes +4 cover.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [seg(200, 50, 200, 100)],
      ranged: true,
    });
    expect(r.kind).toBe("standard");
    expect(r.acBonus).toBe(4);
    expect(r.reflexBonus).toBe(2);
    expect(r.clearLines).toBeGreaterThan(0);
    expect(r.blockedLines).toBeGreaterThan(0);
  });

  test("a wall that does not reach the corner-to-corner corridor is no cover", () => {
    // Wall on the far side of the defender, touching its border: lines end
    // ON the wall (their own endpoint), which is not crossing.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(1, 0)],
      grid,
      walls: [seg(200, 0, 200, 100)],
      ranged: true,
    });
    expect(r.kind).toBe("none");
  });

  test("soft cover: an intervening creature grants +4 AC, never total cover", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [],
      creatureCells: [cell(2, 0)],
      ranged: true,
    });
    expect(r.kind).toBe("soft");
    expect(r.acBonus).toBe(4);
    expect(r.reflexBonus).toBe(0);
    expect(r.softOnly).toBe(true);
    expect(r.notes.join(" ")).toContain("soft cover");
  });

  test("creatures never grant cover against an adjacent melee attack", () => {
    // Soft cover is "against ranged attacks" (AoN 181) — and even under the
    // ranged rules an adjacent target's own square is not an intervening one.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(1, 0)],
      grid,
      walls: [],
      creatureCells: [cell(1, 1), cell(0, 1)],
      ranged: false,
    });
    expect(r.kind).toBe("none");
  });

  test("walls plus a creature is standard cover, not soft", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [seg(200, 50, 200, 100)],
      creatureCells: [cell(2, 0)],
      ranged: true,
    });
    expect(r.kind).toBe("standard");
    expect(r.reflexBonus).toBe(2);
  });

  test("the attacker's and defender's own squares never grant cover", () => {
    // A creature standing in the defender's square (Tiny swarm) or the
    // attacker's square is not intervening.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [],
      creatureCells: [cell(0, 0), cell(3, 0)],
      ranged: true,
    });
    expect(r.kind).toBe("none");
  });
});

describe("coverBetween — AoN 181 melee rules", () => {
  test("adjacent melee: any blocked line from any corner grants cover", () => {
    // A wall stub jutting into the defender's square: hand-counted, the
    // line (0,0)→(200,0) passes through the stub's endpoint (150,0).
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(1, 0)],
      grid,
      walls: [seg(150, 0, 150, 50)],
      ranged: false,
    });
    expect(r.kind).toBe("standard");
    expect(r.acBonus).toBe(4);
  });

  test("a non-adjacent melee attack (reach weapon) uses the ranged rules", () => {
    // Soft cover applies at reach: the creature between a longspear wielder
    // and a target two squares out blocks the strike line.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(2, 0)],
      grid,
      walls: [],
      creatureCells: [cell(1, 0)],
      ranged: false, // 2 squares apart — the ranged rules kick in by distance
    });
    expect(r.kind).toBe("soft");
  });
});

describe("coverBetween — Big Creatures and Cover (AoN 181)", () => {
  test("a Large attacker picks the occupied square with the cleanest lines", () => {
    // Large attacker at (0,0)+(0,1); wall blocks the south lane only. The
    // north square (0,1) sees the defender cleanly — no cover from there.
    const r = coverBetween({
      attackerCells: [cell(0, 0), cell(0, 1)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [seg(150, 0, 150, 100)], // fully between the south square and target
      ranged: true,
    });
    expect(r.kind).toBe("none");
  });

  test("a Large defender's far square does not save it when every square is walled", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0), cell(3, 1)],
      grid,
      walls: [
        seg(200, 0, 200, 100),
        seg(200, 100, 200, 200),
      ],
      ranged: true,
    });
    expect(r.kind).toBe("total");
  });
});

describe("coverBetween — low obstacles (AoN 181)", () => {
  const fence = seg(200, 0, 200, 100);

  test("a low obstacle between closer parties grants cover within 30 ft", () => {
    // Attacker 7.5 ft from the fence, defender 2.5 ft — the attacker is not
    // closer to the obstacle than the target, and both are within 30 ft.
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(3, 0)],
      grid,
      walls: [],
      lowObstacles: [fence],
      ranged: true,
    });
    expect(r.kind).toBe("standard");
    expect(r.acBonus).toBe(4);
  });

  test("a low obstacle beyond 30 ft of the defender is ignored", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(12, 0)], // 60 ft from the fence
      grid,
      walls: [],
      lowObstacles: [fence],
      ranged: true,
    });
    expect(r.kind).toBe("none");
    expect(r.notes.join(" ")).toContain("ignored");
  });

  test("the attacker closer to the obstacle than the target ignores it", () => {
    const r = coverBetween({
      attackerCells: [cell(3, 0)], // 2.5 ft from the fence
      defenderCells: [cell(12, 0)], // 52.5 ft from the fence
      grid,
      walls: [],
      lowObstacles: [fence],
      ranged: true,
    });
    expect(r.kind).toBe("none");
  });

  test("LOW_OBSTACLE_RANGE_FT is the printed 30 ft", () => {
    expect(LOW_OBSTACLE_RANGE_FT).toBe(30);
  });
});

describe("coverBetween — degenerate inputs are named, never guessed", () => {
  test("a side with no square reports undecidable cover as none", () => {
    const r = coverBetween({
      attackerCells: [],
      defenderCells: [cell(0, 0)],
      grid,
      walls: [],
      ranged: true,
    });
    expect(r.kind).toBe("none");
    expect(r.notes.join(" ")).toContain("undecidable");
  });

  test("a grid without a usable scale reports undecidable cover", () => {
    const r = coverBetween({
      attackerCells: [cell(0, 0)],
      defenderCells: [cell(1, 0)],
      grid: { cellSize: 0, feetPerCell: 0, diagonals: "5105" },
      walls: [],
      ranged: true,
    });
    expect(r.kind).toBe("none");
    expect(r.notes.join(" ")).toContain("undecidable");
  });
});

describe("concealment (AoN 182)", () => {
  test("the printed miss chances are 20% and 50%", () => {
    expect(CONCEALMENT_MISS_CHANCE).toBe(20);
    expect(TOTAL_CONCEALMENT_MISS_CHANCE).toBe(50);
  });

  test("multiple concealment conditions do not stack — the worst wins", () => {
    const g = concealmentGrade([
      { percent: 20, label: "foliage" },
      { percent: 50, label: "invisible" },
    ]);
    expect(g.percent).toBe(50);
    expect(g.label).toBe("invisible");
    expect(g.note).toContain("did not stack");
  });

  test("a single source has no stacking note", () => {
    const g = concealmentGrade([{ percent: 20, label: "twilight" }]);
    expect(g.percent).toBe(20);
    expect(g.note).toBeNull();
  });

  test("no sources is no miss chance", () => {
    expect(concealmentGrade([]).percent).toBe(0);
  });

  test("a d% roll at or below the miss chance misses", () => {
    expect(concealmentOutcome({ percent: 20, die: 20 }).miss).toBe(true);
    expect(concealmentOutcome({ percent: 20, die: 21 }).miss).toBe(false);
    expect(concealmentOutcome({ percent: 50, die: 50 }).miss).toBe(true);
    expect(concealmentOutcome({ percent: 50, die: 100 }).miss).toBe(false);
    expect(concealmentOutcome({ percent: 0, die: 1 }).miss).toBe(false);
  });
});
