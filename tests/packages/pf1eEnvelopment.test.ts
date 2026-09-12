import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { markPF1eFlanking, PF1E_STATUS_FLANKED } from "../../src/packages/pf1e/envelopment";
import { allocModel, createModelPool } from "../../src/sim/pool";
import type { ModelPool } from "../../src/core/strategic";

/**
 * M04/D-182 — the strategic FLANKED bit is AoN 183's rule, not the old
 * "≥2 attackers in contact" heuristic (Gap List §5).
 *
 * Cells at the default 5-ft scene scale: model x,y are feet, so `cellAt` maps
 * 0→cell 0, 5→cell 1, −5→cell −1. Every fixture below therefore places models on
 * square centres, which is what P01's deploy-spacing change guarantees in
 * production (`deploy.ts` spacing = the scene grid distance).
 */
const CELL = 5;

/** One unit per faction; the pass's default enemy relation is "different faction". */
function battlefield(
  count: number,
  placements: Array<{ unitIdx: number; x: number; y: number }>,
): { pool: ModelPool; grid: SpatialGrid } {
  const pool = createModelPool(Math.max(8, count));
  placements.forEach((p, i) =>
    allocModel(pool, { id: i + 1, unitIdx: p.unitIdx, x: p.x, y: p.y, hp: 5, hpMax: 5 }),
  );
  const grid = new SpatialGrid(CELL);
  grid.rebuild(pool);
  return { pool, grid };
}

function run(
  pool: ModelPool,
  grid: SpatialGrid,
  opts: { reach?: number[]; size?: Array<string | null | undefined> } = {},
) {
  const units = new Set<number>();
  for (let i = 0; i < pool.count; i++) units.add(pool.unitIdx[i] ?? 0);
  const maxUnit = Math.max(...units);
  const reach = opts.reach ?? Array.from({ length: maxUnit + 1 }, () => 1);
  const faction = Array.from({ length: maxUnit + 1 }, (_, u) => `f${u}`);
  return markPF1eFlanking({
    pool,
    grid,
    cellFeet: CELL,
    factionByUnitIdx: faction,
    reachSquaresByUnitIdx: reach,
    ...(opts.size !== undefined ? { sizeByUnitIdx: opts.size } : {}),
  });
}

describe("PF1e strategic flanking — AoN 183 at the mass-battle scale (M04/D-182)", () => {
  test("two enemies on opposite borders flank; two on the same side do not", () => {
    // Defender in cell (5,0) = feet (25,25). Attackers east and west of it are on
    // opposite borders (the line crosses left and right); attackers both to the east
    // are not, however many of them stand there — the old rule counted them.
    const opposite = battlefield(3, [
      { unitIdx: 0, x: 20, y: 25 }, // cell (4,0) — west
      { unitIdx: 0, x: 30, y: 25 }, // cell (6,0) — east
      { unitIdx: 1, x: 25, y: 25 }, // cell (5,0) — the defender
    ]);
    const oppositeRes = run(opposite.pool, opposite.grid);
    expect(oppositeRes.flankedDefenders).toEqual([2]);
    expect((opposite.pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).not.toBe(0);
    expect(oppositeRes.pairs[0]?.flankers.sort()).toEqual([0, 1]);

    const sameSide = battlefield(3, [
      { unitIdx: 0, x: 30, y: 25 }, // cell (6,0) — east
      { unitIdx: 0, x: 35, y: 25 }, // cell (7,0) — also east
      { unitIdx: 1, x: 25, y: 25 }, // the defender
    ]);
    const sameSideRes = run(sameSide.pool, sameSide.grid);
    expect(sameSideRes.flankedDefenders).toEqual([]);
    expect((sameSide.pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).toBe(0);
  });

  test("corner contact counts as opposite borders crossing (AoN 183's parenthetical)", () => {
    // Defender (5,5) = cell (1,1). Attackers at cells (0,0) and (2,2) sit on the
    // defender's opposite corners; the centre-to-centre line runs through both corner
    // border points, which the rule counts.
    const { pool, grid } = battlefield(3, [
      { unitIdx: 0, x: 2, y: 2 }, // cell (0,0)
      { unitIdx: 0, x: 12, y: 12 }, // cell (2,2)
      { unitIdx: 1, x: 7, y: 7 }, // cell (1,1)
    ]);
    const res = run(pool, grid);
    expect(res.flankedDefenders).toEqual([2]);
  });

  test("the threatening-ally requirement is read through reach: a non-threatener cannot flank", () => {
    // The east attacker is 10 ft away: with 1-square reach it does not threaten the
    // defender, so the pair does NOT flank. The same layout with 2-square reach (a
    // Large unit, Table 8-4 / D-180) turns the pair into a flank.
    const layout = [
      { unitIdx: 0, x: 20, y: 25 }, // west, adjacent
      { unitIdx: 0, x: 35, y: 25 }, // east, 10 ft — two squares out
      { unitIdx: 1, x: 25, y: 25 }, // defender
    ];
    const medium = battlefield(3, layout);
    expect(run(medium.pool, medium.grid).flankedDefenders).toEqual([]);

    const large = battlefield(3, layout);
    const res = run(large.pool, large.grid, { reach: [2, 1] });
    expect(res.flankedDefenders).toEqual([2]);
  });

  test("reach 0 and sub-square sizes cannot flank (AoN 179 exclusions)", () => {
    const zeroReach = battlefield(3, [
      { unitIdx: 0, x: 20, y: 25 },
      { unitIdx: 0, x: 30, y: 25 },
      { unitIdx: 1, x: 25, y: 25 },
    ]);
    expect(run(zeroReach.pool, zeroReach.grid, { reach: [0, 1] }).flankedDefenders).toEqual([]);

    // Tiny occupies 2½ ft: it "can't flank an enemy" (Table 8-4), so neither does the
    // pair — even though both attackers are adjacent and on opposite borders.
    const tiny = battlefield(3, [
      { unitIdx: 0, x: 20, y: 25 },
      { unitIdx: 0, x: 30, y: 25 },
      { unitIdx: 1, x: 25, y: 25 },
    ]);
    expect(
      run(tiny.pool, tiny.grid, { size: ["Tiny", "Medium"] }).flankedDefenders,
    ).toEqual([]);
  });

  test("allies of the defender's own faction never flank it", () => {
    // Both adjacent models belong to the defender's faction: different units, same
    // side. Hostility is the strategic layer's faction relation, not unit identity.
    const { pool, grid } = battlefield(3, [
      { unitIdx: 0, x: 20, y: 25 },
      { unitIdx: 0, x: 30, y: 25 },
      { unitIdx: 0, x: 25, y: 25 },
    ]);
    const res = markPF1eFlanking({
      pool,
      grid,
      cellFeet: CELL,
      factionByUnitIdx: ["red"],
      reachSquaresByUnitIdx: [1],
    });
    expect(res.flankedDefenders).toEqual([]);
  });

  test("the pass clears a bit the layout no longer supports, and dead models never carry one", () => {
    const { pool, grid } = battlefield(3, [
      { unitIdx: 0, x: 20, y: 25 },
      { unitIdx: 0, x: 30, y: 25 },
      { unitIdx: 1, x: 25, y: 25 },
    ]);
    expect(run(pool, grid).flankedDefenders).toEqual([2]);

    // The east flanker dies: the remaining attacker cannot flank alone.
    pool.status[1] = (pool.status[1] ?? 0) | (1 << 0); // ModelStatus.dead
    expect(run(pool, grid).flankedDefenders).toEqual([]);
    expect((pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).toBe(0);

    // ...and even if a bit were somehow set on a dead model, the pass clears it.
    pool.status[1] = (pool.status[1] ?? 0) | PF1E_STATUS_FLANKED;
    run(pool, grid);
    expect((pool.status[1] ?? 0) & PF1E_STATUS_FLANKED).toBe(0);
  });

  test("two models sharing one square are collinear and do not flank (the documented degenerate case)", () => {
    // The layout P01 removed: 4-ft spacing puts both attackers inside the defender's
    // 5-ft square, and the rule names no such case — so no flank is claimed.
    const { pool, grid } = battlefield(3, [
      { unitIdx: 0, x: 24, y: 25 },
      { unitIdx: 0, x: 28, y: 25 },
      { unitIdx: 1, x: 25, y: 25 },
    ]);
    expect(run(pool, grid).flankedDefenders).toEqual([]);
  });

  test("flanking is decided per model, and a defender flanked by two different units counts", () => {
    // Defender unit f2 is attacked from opposite borders by units of two different
    // factions; with the old per-engagement call this was invisible to each of them.
    const { pool, grid } = battlefield(4, [
      { unitIdx: 0, x: 20, y: 25 }, // west
      { unitIdx: 1, x: 30, y: 25 }, // east — a different enemy unit
      { unitIdx: 2, x: 25, y: 25 }, // the defender
      { unitIdx: 2, x: 25, y: 40 }, // a second defender, out of reach of anything
    ]);
    const res = markPF1eFlanking({
      pool,
      grid,
      cellFeet: CELL,
      factionByUnitIdx: ["red", "blue", "green"],
      reachSquaresByUnitIdx: [1, 1, 1],
    });
    expect(res.flankedDefenders).toEqual([2]);
    expect(res.pairs[0]?.flankers.sort()).toEqual([0, 1]);
  });

  test("scale: the whole-battlefield pass over 10k models stays cheap and deterministic", () => {
    // Two facing lines, one model per square, 100 per rank: every model in the front
    // ranks has a single enemy in front (nobody is flanked), which is the mass-battle
    // case the heuristic used to mislabel. The pass is O(n) plus small local pair tests.
    const perSide = 5000;
    const pool = createModelPool(perSide * 2);
    for (let i = 0; i < perSide; i++) {
      const col = i % 100;
      const row = Math.floor(i / 100);
      allocModel(pool, { id: i + 1, unitIdx: 0, x: col * CELL, y: row * CELL, hp: 5, hpMax: 5 });
      // The second line's front rank stands directly north of the first line's front
      // rank (row 50 against row 49): one enemy per defender, never a pair on
      // opposite borders — the shape neither line can flank out of without wrapping.
      allocModel(pool, {
        id: perSide + i + 1,
        unitIdx: 1,
        x: col * CELL,
        y: (row + 50) * CELL,
        hp: 5,
        hpMax: 5,
      });
    }
    const grid = new SpatialGrid(CELL);
    grid.rebuild(pool);
    const started = performance.now();
    const res = markPF1eFlanking({
      pool,
      grid,
      cellFeet: CELL,
      factionByUnitIdx: ["red", "blue"],
      reachSquaresByUnitIdx: [1, 1],
    });
    const elapsed = performance.now() - started;
    // A line vs line battle at 5-ft spacing: nobody is on an opposite border without
    // being wrapped, so the honest answer is zero — and it must be reached quickly.
    expect(res.flankedDefenders).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  });
});
