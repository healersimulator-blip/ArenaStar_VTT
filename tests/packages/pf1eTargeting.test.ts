/**
 * P5/C01 — grid targeting fixtures.
 *
 * Every expectation below is **derived from the transcribed rule text**, never
 * captured from a previous run of the code (V01). The source is Archives of
 * Nethys Rules ID 212 "Aiming a Spell" (CRB pp.214–216), quoted inline in
 * `src/packages/pf1e/targeting.ts`. Worked examples are hand-computed in the
 * comments so a reviewer can re-derive them without executing anything.
 */
import { describe, expect, it } from "vitest";
import {
  PF1E_AREA_DIAGONALS,
  PF1E_AREA_KINDS,
  affectedTokens,
  areaCellDistance,
  areaPreviewRects,
  cellRect,
  cellsByRow,
  centeredOnYouRadiusBonusFt,
  describeArea,
  feetToCells,
  hasLineOfEffectToOrigin,
  pf1eAreaGridFromScene,
  radiusCells,
  resolveAreaCells,
  spreadCells,
  tokenCells,
  worldToCell,
  type PF1eAreaGrid,
  type PF1eCell,
} from "../../src/packages/pf1e/targeting";
import type { Segment } from "../../src/canvas/vision/polygon";

/** 5-ft. squares, 100 world units each, SRD 5-10-5 diagonals. */
const GRID: PF1eAreaGrid = { cellSize: 100, feetPerCell: 5, diagonals: "5105" };
const ORIGIN: PF1eCell = { col: 0, row: 0 };

/** Sorted "col,row" list, for exact whole-shape assertions. */
function shape(cells: readonly PF1eCell[]): string[] {
  return cells.map((c) => `${c.col},${c.row}`).sort();
}

describe("supported shapes", () => {
  it("publishes exactly the four shapes whose grid templates are unambiguous", () => {
    // Cone and line are deliberately absent until C01b transcribes a canonical
    // template; if either is added, its fixtures must land in the same change.
    expect(PF1E_AREA_KINDS).toEqual([
      "burst",
      "emanation",
      "cylinder",
      "spread",
    ]);
  });
});

describe("AoN 212 — the point of origin of a spell is always a grid intersection", () => {
  it("refuses a non-intersection origin with a named issue instead of guessing", () => {
    const res = resolveAreaCells(
      { kind: "burst", origin: { col: 0.5, row: 0 }, radiusFt: 20 },
      GRID,
    );
    expect(res.cells).toEqual([]);
    expect(res.issues.map((i) => i.field)).toContain("origin");
  });

  it("accepts an integer intersection", () => {
    const res = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 5 },
      GRID,
    );
    expect(res.issues).toEqual([]);
    expect(res.cells.length).toBeGreaterThan(0);
  });
});

describe("AoN 212 — count intersection to intersection, every second diagonal is 2 squares", () => {
  it("counts the first diagonal as 1 and the second as 2", () => {
    // Far corner of cell (0,0) from intersection (0,0) is (1,1): one diagonal = 1.
    expect(areaCellDistance({ col: 0, row: 0 }, ORIGIN, GRID)).toBe(1);
    // Cell (1,1)'s far corner is (2,2): diagonal 5' + diagonal 10' = 3 squares.
    expect(areaCellDistance({ col: 1, row: 1 }, ORIGIN, GRID)).toBe(3);
    // Cell (2,2)'s far corner is (3,3): 5+10+5 = 4 squares.
    expect(areaCellDistance({ col: 2, row: 2 }, ORIGIN, GRID)).toBe(4);
  });

  it("counts straight lines one square per cell", () => {
    expect(areaCellDistance({ col: 1, row: 0 }, ORIGIN, GRID)).toBe(2);
    expect(areaCellDistance({ col: 2, row: 0 }, ORIGIN, GRID)).toBe(3);
    expect(areaCellDistance({ col: 3, row: 0 }, ORIGIN, GRID)).toBe(4);
  });

  it("is symmetric in all four quadrants (the intersection, not a cell, is the centre)", () => {
    const q1 = areaCellDistance({ col: 2, row: 1 }, ORIGIN, GRID);
    expect(areaCellDistance({ col: -3, row: 1 }, ORIGIN, GRID)).toBe(q1);
    expect(areaCellDistance({ col: 2, row: -2 }, ORIGIN, GRID)).toBe(q1);
    expect(areaCellDistance({ col: -3, row: -2 }, ORIGIN, GRID)).toBe(q1);
  });
});

describe('AoN 212 — "if the far edge of a square is within the spell\'s area"', () => {
  it("covers exactly the four cells sharing the corner at a 5-ft. radius (a 10-ft. square)", () => {
    // The canonical 5-ft.-radius burst. Measuring to the near corner would add
    // (1,0)/(0,1)/(-2,0)/(0,-2); measuring to the cell centre would keep only
    // one cell. Only the far-corner reading yields the published 2x2.
    expect(shape(radiusCells(ORIGIN, 5, GRID))).toEqual(
      shape([
        { col: -1, row: -1 },
        { col: -1, row: 0 },
        { col: 0, row: -1 },
        { col: 0, row: 0 },
      ]),
    );
  });

  it("excludes a square whose near edge is only touched", () => {
    // At 15 ft (3 squares) cell (2,0)'s far corner (3,1) is at 3 — included.
    // Cell (3,0)'s near corner (3,0) sits exactly on the 3-square boundary but
    // its far corner (4,1) is at 4, so only the near edge is touched: excluded.
    const cells = radiusCells(ORIGIN, 15, GRID);
    const keys = new Set(shape(cells));
    expect(keys.has("2,0")).toBe(true);
    expect(keys.has("3,0")).toBe(false);
  });

  it("reproduces the canonical 15-ft.-radius burst template (24 cells, 2/4/6/6/4/2)", () => {
    // Hand-derived: quadrant cells (col>=0,row>=0) with far-corner distance <= 3
    // are (0,0),(1,0),(2,0),(0,1),(1,1),(0,2). Mirroring into the other three
    // quadrants gives rows of 2,4,6,6,4,2 cells.
    const rows = cellsByRow(radiusCells(ORIGIN, 15, GRID));
    expect(rows.get(2)).toEqual([-1, 0]);
    expect(rows.get(1)).toEqual([-2, -1, 0, 1]);
    expect(rows.get(0)).toEqual([-3, -2, -1, 0, 1, 2]);
    expect(rows.get(-1)).toEqual([-3, -2, -1, 0, 1, 2]);
    expect(rows.get(-2)).toEqual([-2, -1, 0, 1]);
    expect(rows.get(-3)).toEqual([-1, 0]);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([
      -3, -2, -1, 0, 1, 2,
    ]);
    expect(rows.size).toBe(6);
    let total = 0;
    for (const cols of rows.values()) total += cols.length;
    expect(total).toBe(24);
  });
});

describe("AoN 212 — burst, emanation and cylinder share one circular shape", () => {
  it("gives an emanation the same area as a burst (it only differs by persisting)", () => {
    const burst = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 15 },
      GRID,
    );
    const emanation = resolveAreaCells(
      { kind: "emanation", origin: ORIGIN, radiusFt: 15 },
      GRID,
    );
    expect(shape(emanation.cells)).toEqual(shape(burst.cells));
  });

  it("makes a cylinder's point of origin the centre of the same horizontal circle", () => {
    const burst = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 15 },
      GRID,
    );
    const cylinder = resolveAreaCells(
      { kind: "cylinder", origin: ORIGIN, radiusFt: 15 },
      GRID,
    );
    expect(shape(cylinder.cells)).toEqual(shape(burst.cells));
  });
});

describe("AoN 212 — line of effect from the origin (bursts do not extend around corners)", () => {
  // Solid barrier on the grid line x = 250 (between cols 2 and 3), tall enough
  // that nothing can reach around either end.
  const wall: Segment[] = [{ x1: 250, y1: -5000, x2: 250, y2: 5000 }];

  it("drops burst cells the origin has total cover to", () => {
    const open = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 20 },
      GRID,
    );
    const blocked = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 20 },
      GRID,
      {
        segments: wall,
      },
    );
    expect(blocked.cells.length).toBeLessThan(open.cells.length);
    const keys = new Set(shape(blocked.cells));
    // (2,0) straddles the wall but its near edge is reachable from the origin.
    expect(keys.has("2,0")).toBe(true);
    // Everything wholly beyond the barrier has total cover.
    expect(keys.has("3,0")).toBe(false);
    expect(keys.has("3,1")).toBe(false);
    for (const c of blocked.cells) expect(c.col).toBeLessThanOrEqual(2);
  });

  it("ignores obstructions inside a cylinder's area, per the cylinder sentence", () => {
    const open = resolveAreaCells(
      { kind: "cylinder", origin: ORIGIN, radiusFt: 20 },
      GRID,
    );
    const obstructed = resolveAreaCells(
      { kind: "cylinder", origin: ORIGIN, radiusFt: 20 },
      GRID,
      {
        segments: wall,
      },
    );
    // "A cylinder-shaped spell ignores any obstructions within its area."
    expect(shape(obstructed.cells)).toEqual(shape(open.cells));
    expect(shape(obstructed.cells)).toContain("3,0");
  });

  it("requires line of effect to the point of origin before the spell may be placed", () => {
    const caster = { x: 50, y: 50 }; // inside cell (0,0)
    expect(hasLineOfEffectToOrigin(caster, { col: 5, row: 0 }, GRID, [])).toBe(
      true,
    );
    expect(
      hasLineOfEffectToOrigin(caster, { col: 5, row: 0 }, GRID, wall),
    ).toBe(false);
    // An origin on the caster's own side of the barrier is still placeable.
    expect(
      hasLineOfEffectToOrigin(caster, { col: 1, row: 0 }, GRID, wall),
    ).toBe(true);
  });
});

describe("AoN 212 — a spread turns corners and counts the distance actually travelled", () => {
  it("covers the same 2x2 as a 5-ft. burst (the effect starts at the intersection)", () => {
    expect(shape(spreadCells(ORIGIN, 5, GRID))).toEqual(
      shape([
        { col: -1, row: -1 },
        { col: -1, row: 0 },
        { col: 0, row: -1 },
        { col: 0, row: 0 },
      ]),
    );
  });

  it("reaches diagonally further than a burst of the same radius (path length, not far corner)", () => {
    // Cheapest path to (n,n) is n diagonal steps out of the seeded cell, so its
    // spread cost is 1 + n + floor(n/2): (2,2)=4, (3,3)=5, (4,4)=7. A burst
    // instead needs the far corner (n+1,n+1), i.e. (n+1) + floor((n+1)/2):
    // (2,2)=4, (3,3)=6. At 25 ft (budget 5) the two readings finally part:
    // (3,3) is inside the spread but outside the burst.
    const spread = new Set(shape(spreadCells(ORIGIN, 25, GRID)));
    const burst = new Set(shape(radiusCells(ORIGIN, 25, GRID)));
    expect(spread.has("2,2")).toBe(true);
    expect(spread.has("3,3")).toBe(true);
    expect(burst.has("2,2")).toBe(true);
    expect(burst.has("3,3")).toBe(false);
    // A fourth diagonal would cost 7, so (4,4) is outside even the spread.
    expect(spread.has("4,4")).toBe(false);
  });

  it("counts around a wall rather than through it", () => {
    // Barrier: the whole of column 1 for rows -3..3. The only way past is over
    // the top (row 4) or under the bottom (row -4).
    const blocked = (c: PF1eCell): boolean =>
      c.col === 1 && c.row >= -3 && c.row <= 3;
    const near = new Set(shape(spreadCells(ORIGIN, 25, GRID, blocked))); // budget 5
    const far = new Set(shape(spreadCells(ORIGIN, 60, GRID, blocked))); // budget 12

    // Nothing in column 1 may be entered inside the barrier rows, at any budget.
    for (const key of far) {
      const [col, row] = key.split(",").map(Number) as [number, number];
      if (col === 1) expect(Math.abs(row)).toBeGreaterThan(3);
    }

    // 25 ft does reach around the bottom corner — the path is (0,-1)=1,
    // (0,-2)=2, (0,-3)=3, diagonal (1,-4)=4, (2,-4)=5 — which is the whole
    // point: a burst could not bend around this wall at all.
    expect(near.has("1,-4")).toBe(true);
    expect(near.has("2,-4")).toBe(true);

    // But it is not enough to come back behind the barrier: (2,0) needs a
    // cheapest path of 9 (… (1,-4)=4, (2,-4)=5, (2,-3)=6, (2,-2)=7, (2,-1)=8,
    // (2,0)=9), so 25 ft misses it and 60 ft makes it.
    expect(near.has("2,0")).toBe(false);
    expect(far.has("2,0")).toBe(true);
  });

  it("does not trace diagonals across corners", () => {
    // Block the two orthogonal neighbours of the origin's north-east diagonal.
    const blocked = (c: PF1eCell): boolean =>
      (c.col === 1 && c.row === 0) || (c.col === 0 && c.row === 1);
    const keys = new Set(shape(spreadCells(ORIGIN, 10, GRID, blocked)));
    // The (1,1) diagonal is cut off by the blocked corner at budget 2...
    expect(keys.has("1,1")).toBe(false);
    // ...while the three diagonals with an open orthogonal neighbour are fine.
    expect(keys.has("-1,-1")).toBe(true);
    expect(keys.has("-1,1")).toBe(true);
    expect(keys.has("1,-1")).toBe(true);
  });
});

describe("P01 — scene grid metadata drives the area, not hardcoded constants", () => {
  it("recomputes the same 20-ft. radius against a 10-ft. grid", () => {
    const coarse: PF1eAreaGrid = {
      cellSize: 200,
      feetPerCell: 10,
      diagonals: "5105",
    };
    // 20 ft on a 10-ft. grid is 2 cells: 3 cells per quadrant => 12 total.
    expect(feetToCells(20, coarse)).toBe(2);
    expect(radiusCells(ORIGIN, 20, coarse)).toHaveLength(12);
    // The same 20 ft on the 5-ft. grid is 4 cells and a much larger area.
    expect(feetToCells(20, GRID)).toBe(4);
    expect(radiusCells(ORIGIN, 20, GRID).length).toBeGreaterThan(12);
  });

  it("rounds a partial cell up", () => {
    expect(feetToCells(12, GRID)).toBe(3);
    expect(feetToCells(10, GRID)).toBe(2);
    expect(feetToCells(1, GRID)).toBe(1);
  });

  it("keeps the pure math general across counting rules", () => {
    const euclid: PF1eAreaGrid = {
      cellSize: 100,
      feetPerCell: 5,
      diagonals: "euclidean",
    };
    // Far corner (2,2) is sqrt(8) ~ 2.83 rather than 3 under 5-10-5.
    expect(areaCellDistance({ col: 1, row: 1 }, ORIGIN, euclid)).toBeCloseTo(
      Math.SQRT2 * 2,
      6,
    );
    expect(areaCellDistance({ col: 1, row: 1 }, ORIGIN, GRID)).toBe(3);
  });
});

describe("the scene bridge — area counting is a rule, not the ruler's setting", () => {
  it("takes size and scale from the scene but pins the diagonal rule to 5-10-5", () => {
    // This repository's default scene ships diagonals "555" (hostBoot.ts); a GM
    // retuning the ruler must not change which squares a fireball covers.
    const { grid, issues } = pf1eAreaGridFromScene({
      size: 100,
      distance: 5,
      units: "ft",
    });
    expect(issues).toEqual([]);
    expect(grid.cellSize).toBe(100);
    expect(grid.feetPerCell).toBe(5);
    expect(grid.diagonals).toBe(PF1E_AREA_DIAGONALS);
    expect(grid.diagonals).toBe("5105");
  });

  it("refuses a metric scene with a named issue rather than inventing a conversion", () => {
    const { grid, issues } = pf1eAreaGridFromScene({
      size: 100,
      distance: 1.5,
      units: "m",
    });
    expect(issues.map((i) => i.field)).toContain("grid.units");
    expect(grid.feetPerCell).toBe(0);
  });

  it("names a broken scene grid", () => {
    const noSize = pf1eAreaGridFromScene({ size: 0, distance: 5, units: "ft" });
    expect(noSize.issues.map((i) => i.field)).toContain("grid.size");
    const noDist = pf1eAreaGridFromScene({
      size: 100,
      distance: 0,
      units: "ft",
    });
    expect(noDist.issues.map((i) => i.field)).toContain("grid.distance");
  });

  it("resolves the canonical 15-ft. burst from scene metadata end to end", () => {
    const { grid } = pf1eAreaGridFromScene({
      size: 100,
      distance: 5,
      units: "ft",
    });
    expect(radiusCells(ORIGIN, 15, grid)).toHaveLength(24);
  });
});

describe("affected tokens and preview geometry", () => {
  it("maps a centred token to the cells its footprint covers", () => {
    expect(
      shape(tokenCells({ x: 50, y: 50, width: 100, height: 100 }, GRID)),
    ).toEqual(["0,0"]);
    // Straddling a grid line occupies both cells...
    expect(
      shape(tokenCells({ x: 100, y: 50, width: 100, height: 100 }, GRID)),
    ).toEqual(["0,0", "1,0"]);
    // ...but an edge landing exactly on a line does not spill past it: this
    // token spans [0,200] on both axes, so exactly 2x2 cells.
    expect(
      shape(tokenCells({ x: 100, y: 100, width: 200, height: 200 }, GRID)),
    ).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    // A 200-ft. token centred on a cell centre does cross two lines per axis.
    expect(
      shape(tokenCells({ x: 50, y: 50, width: 200, height: 200 }, GRID)),
    ).toHaveLength(9);
  });

  it("selects every token any of whose cells is in the area", () => {
    const cells = radiusCells(ORIGIN, 5, GRID);
    const inside = { x: 50, y: 50, width: 100, height: 100 };
    const outside = { x: 350, y: 350, width: 100, height: 100 };
    const straddling = { x: -50, y: 250, width: 100, height: 100 }; // cell (-1,2), outside
    expect(affectedTokens(cells, [inside, outside, straddling], GRID)).toEqual([
      inside,
    ]);
  });

  it("counts a Large token touched on a single cell", () => {
    const cells = radiusCells(ORIGIN, 5, GRID);
    const large = { x: 200, y: 200, width: 200, height: 200 }; // cells (1,1)..(2,2)
    expect(affectedTokens(cells, [large], GRID)).toEqual([]);
    const touching = { x: 100, y: 100, width: 200, height: 200 }; // cells (0,0)..(1,1)
    expect(affectedTokens(cells, [touching], GRID)).toEqual([touching]);
  });

  it("emits one world rect per cell for the canvas preview", () => {
    const rects = areaPreviewRects([{ col: 2, row: -1 }], GRID);
    expect(rects).toEqual([{ x: 200, y: -100, size: 100 }]);
    expect(cellRect({ col: -1, row: 3 }, GRID)).toEqual({
      x: -100,
      y: 300,
      size: 100,
    });
    expect(worldToCell(GRID, 250, -50)).toEqual({ col: 2, row: -1 });
  });
});

describe("AoN 212 — bursts and emanations and larger creatures", () => {
  it("measures a 2x2 caster's centered-on-you effect from the edge of its space", () => {
    expect(centeredOnYouRadiusBonusFt({ width: 200, height: 200 }, GRID)).toBe(
      5,
    );
    expect(centeredOnYouRadiusBonusFt({ width: 300, height: 300 }, GRID)).toBe(
      7.5,
    );
  });

  it("gives no bonus to a one-cell space or a non-square one", () => {
    expect(centeredOnYouRadiusBonusFt({ width: 100, height: 100 }, GRID)).toBe(
      0,
    );
    expect(centeredOnYouRadiusBonusFt({ width: 200, height: 300 }, GRID)).toBe(
      0,
    );
  });
});

describe("garbage in, named issues out (never a silent empty area)", () => {
  it("names a missing or non-positive radius", () => {
    for (const radiusFt of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = resolveAreaCells(
        { kind: "burst", origin: ORIGIN, radiusFt },
        GRID,
      );
      expect(res.cells).toEqual([]);
      expect(res.issues.map((i) => i.field)).toContain("radiusFt");
    }
  });

  it("names an unsupported shape and points at C01b", () => {
    const res = resolveAreaCells(
      { kind: "cone" as never, origin: ORIGIN, radiusFt: 15 },
      GRID,
    );
    expect(res.cells).toEqual([]);
    const kind = res.issues.find((i) => i.field === "kind");
    expect(kind?.message).toMatch(/C01b/);
  });

  it("names a broken grid", () => {
    const res = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 15 },
      { cellSize: 0, feetPerCell: 5, diagonals: "5105" },
    );
    expect(res.issues.map((i) => i.field)).toContain("grid.cellSize");
  });

  it("caps a runaway area and says so", () => {
    const res = resolveAreaCells(
      { kind: "burst", origin: ORIGIN, radiusFt: 500 },
      GRID,
      {
        maxCells: 10,
      },
    );
    expect(res.cells).toHaveLength(10);
    expect(res.issues.map((i) => i.field)).toContain("area");
  });
});

describe("UI labels", () => {
  it("describes each shape with its size", () => {
    expect(describeArea({ kind: "burst", radiusFt: 20 })).toBe(
      "20-ft. radius burst",
    );
    expect(describeArea({ kind: "emanation", radiusFt: 10 })).toBe(
      "10-ft. radius emanation",
    );
    expect(describeArea({ kind: "cylinder", radiusFt: 10 })).toBe(
      "10-ft. radius cylinder",
    );
    expect(describeArea({ kind: "spread", radiusFt: 20 })).toBe(
      "20-ft. radius spread",
    );
    expect(describeArea({ kind: "burst", radiusFt: Number.NaN })).toBe(
      "?-ft. radius burst",
    );
  });
});
