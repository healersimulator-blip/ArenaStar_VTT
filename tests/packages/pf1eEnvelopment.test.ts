import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { calculatePF1eEnvelopment, PF1E_STATUS_FLANKED } from "../../src/packages/pf1e/envelopment";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { naturalReachFt } from "../../src/packages/pf1e/geometry";

describe("PF1e Envelopment & Flanking Engine (§12 / Task 4)", () => {
  test("calculates perimeter contact and marks flanked/enveloped models", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10);

    // Unit 0 (Attacker: 4 models wide)
    allocModel(pool, { id: 1, unitIdx: 0, x: 1, y: 0 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 2, y: 0 });
    allocModel(pool, { id: 3, unitIdx: 0, x: 10, y: 0 }); // Unengaged flanker

    // Unit 1 (Defender: 2 models wide)
    allocModel(pool, { id: 4, unitIdx: 1, x: 1, y: 1 });
    allocModel(pool, { id: 5, unitIdx: 1, x: 2, y: 1 });

    grid.rebuild(pool);

    const res = calculatePF1eEnvelopment({
      pool,
      grid,
      attackerUnitIdx: 0,
      defenderUnitIdx: 1,
      reach: 5,
    });

    expect(res.contactPairs.length).toBeGreaterThan(0);
    expect(res.flankingModels.length).toBeGreaterThan(0);
  });

  test("reach is measured in feet: one square (5 ft) engages, beyond does not (D-177)", () => {
    // SRD Combat, Reach Weapons: "Most creatures of Medium or smaller size have a
    // reach of only 5 feet" — so the default reach engages a model exactly one grid
    // square away (queryPoint is inclusive) and nothing farther. The old `1.5`
    // default was a unit error against the feet-based SpatialGrid (Gap List §5).
    const grid = new SpatialGrid(5);
    const pool = createModelPool(8);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 }); // attacker
    allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0 }); // exactly 5 ft: adjacent square
    allocModel(pool, { id: 3, unitIdx: 1, x: 6, y: 0 }); // 6 ft: beyond natural reach
    grid.rebuild(pool);

    const res = calculatePF1eEnvelopment({ pool, grid, attackerUnitIdx: 0, defenderUnitIdx: 1 });

    expect(res.contactPairs).toEqual([[0, 1]]); // only the 5-ft defender engaged
    expect(res.flankingModels).toEqual([]); // an engaged attacker is not a free flanker
  });

  test("a size-derived reach engages two squares out and stops beyond them (P02/D-180)", () => {
    // `geometry.naturalReachFt("Large")` is 10 ft — Table 8-4's tall column: "Large
    // (tall) · 10 ft. · 10 ft." (AoN Rules ID 179) — and the strategic caller now passes
    // the attacking unit's own figure instead of one grid cell for everybody. queryPoint
    // is inclusive, so 10 ft engages and 11 ft does not. The same battlefield at a
    // Medium's 5 ft contacts neither defender, which is the whole difference P02 makes.
    const run = (reach: number) => {
      const grid = new SpatialGrid(5);
      const pool = createModelPool(8);
      allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 }); // attacker
      allocModel(pool, { id: 2, unitIdx: 1, x: 10, y: 0 }); // two squares out
      allocModel(pool, { id: 3, unitIdx: 1, x: 11, y: 0 }); // one foot beyond that
      grid.rebuild(pool);
      return calculatePF1eEnvelopment({ pool, grid, attackerUnitIdx: 0, defenderUnitIdx: 1, reach });
    };

    expect(naturalReachFt("Large")).toBe(10);
    const giant = run(naturalReachFt("Large"));
    expect(giant.contactPairs).toEqual([[0, 1]]);
    expect(giant.flankingModels).toEqual([]);

    const medium = run(naturalReachFt("Medium"));
    expect(medium.contactPairs).toEqual([]);
    expect(medium.flankingModels).toEqual([0]); // nothing in reach: an unengaged flanker
  });

  test("enveloped defenders carry the FLANKED bit after the engagement (D-177)", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(8);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 6, y: 0 }); // two attackers…
    allocModel(pool, { id: 3, unitIdx: 1, x: 3, y: 0 }); // …3 ft from the one defender
    grid.rebuild(pool);

    const res = calculatePF1eEnvelopment({ pool, grid, attackerUnitIdx: 0, defenderUnitIdx: 1 });

    expect(res.envelopedDefenders).toEqual([2]);
    expect((pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).not.toBe(0);
  });
});
