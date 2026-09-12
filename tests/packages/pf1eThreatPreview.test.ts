/**
 * P04 — the scene seam: tokens → threatened squares → AoN 183's flanking facts.
 *
 * The fixtures are the same hand-drawn ones `pf1eFlanking.test.ts` pins, lifted
 * into world coordinates through `tokenCells` (a token's centre plus its world
 * size), so this suite proves the composition rather than the rule: the threat
 * counts are P02's pinned figures (Medium 8, Large tall 28), the rects are
 * `cellRect`'s world squares, and the flanking pairs are the ones the pure
 * module already decided. The point of the "same side" cases is the regression
 * Gap List §5 names — being in contact with two attackers is not flanking.
 */
import { describe, expect, test } from "vitest";
import {
  pf1eThreatModel,
  type PF1eThreatToken,
} from "../../src/packages/pf1e/threatPreview";
import { PF1E_FLANKING_BONUS } from "../../src/packages/pf1e/flanking";

const GRID = { size: 5, distance: 5, units: "ft" };

/** A Medium token centred on cell (col,row) — `tokenCells`' contract. */
function tok(
  _id: string,
  col: number,
  row: number,
  extra: Partial<PF1eThreatToken> = {},
): PF1eThreatToken {
  return {
    _id,
    x: (col + 0.5) * GRID.size,
    y: (row + 0.5) * GRID.size,
    width: GRID.size,
    height: GRID.size,
    size: "Medium",
    ...extra,
  };
}

/** A Large (tall) token whose footprint starts at cell (col,row). */
function largeTok(_id: string, col: number, row: number): PF1eThreatToken {
  return {
    _id,
    x: (col + 1) * GRID.size,
    y: (row + 1) * GRID.size,
    width: 2 * GRID.size,
    height: 2 * GRID.size,
    size: "Large",
  };
}

function entryOf(model: ReturnType<typeof pf1eThreatModel>, id: string) {
  const found = model.entries.find((e) => e.tokenId === id);
  if (!found) throw new Error(`no threat entry for ${id}`);
  return found;
}

function noteOf(model: ReturnType<typeof pf1eThreatModel>, field: string) {
  const found = model.defaults.find((d) => d.field === field);
  if (!found) throw new Error(`no default noted for ${field}`);
  return found;
}

describe("P04 — flanking facts from real token positions", () => {
  test("two enemies on opposite borders of a defender are reported, both ways round", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5), tok("a", 6, 5), tok("w", 4, 5)],
    });
    expect(model.ok).toBe(true);
    expect(model.issues).toEqual([]);
    expect(model.flanking).toEqual([
      {
        attackerId: "a",
        defenderId: "d",
        helperIds: ["w"],
        bonus: PF1E_FLANKING_BONUS,
      },
      {
        attackerId: "w",
        defenderId: "d",
        helperIds: ["a"],
        bonus: PF1E_FLANKING_BONUS,
      },
    ]);
    expect(model.flankedTokenIds).toEqual(["d"]);
  });

  test("three attackers crowded on the same side are in contact and flanking nobody", () => {
    // The strategic rule Gap List §5 replaces counted attackers; the tactical one
    // has to be right about exactly this shape — contact is not a border. All
    // three stand east/north-east of the defender, all three threaten it or its
    // neighbours, and no line between any two of them crosses a space twice.
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [
        tok("d", 5, 5),
        tok("e1", 6, 5),
        tok("e2", 7, 6),
        tok("e3", 6, 4),
      ],
    });
    expect(model.entries).toHaveLength(4);
    expect(entryOf(model, "e1").threatKeys).toContain("5,5");
    expect(model.flanking).toEqual([]);
    expect(model.flankedTokenIds).toEqual([]);
  });

  test("a column of attackers brackets the one in the middle, and the model says so", () => {
    // The same three-token cluster, stacked north-south instead: e2 and e3 now
    // sit on opposite borders of *e1*, so the honest answer is a flanking fact
    // about e1 — not about the defender they came for. Enmity is the caller's
    // fact, which is what `isEnemy` is for.
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [
        tok("d", 5, 5),
        tok("e1", 6, 5),
        tok("e2", 6, 4),
        tok("e3", 6, 6),
      ],
    });
    expect(model.flanking).toEqual([
      {
        attackerId: "e2",
        defenderId: "e1",
        helperIds: ["e3"],
        bonus: PF1E_FLANKING_BONUS,
      },
      {
        attackerId: "e3",
        defenderId: "e1",
        helperIds: ["e2"],
        bonus: PF1E_FLANKING_BONUS,
      },
    ]);
  });

  test("hostility narrows the report to enemies of the defender", () => {
    const tokens = [tok("d", 5, 5), tok("foe", 6, 5), tok("friend", 4, 5)];
    const anyone = pf1eThreatModel({ grid: GRID, tokens });
    expect(anyone.flanking.map((f) => f.attackerId)).toEqual(["foe", "friend"]);
    expect(anyone.defaults.map((d) => d.field)).toContain("isEnemy");

    const enemiesOnly = pf1eThreatModel({
      grid: GRID,
      tokens,
      // Only "foe" is hostile to the defender; the friend on the far border is
      // not "another enemy character or creature", so it cannot help.
      isEnemy: (a, b) => (b === "d" ? a === "foe" : false),
    });
    expect(enemiesOnly.flanking).toEqual([]);
    expect(enemiesOnly.defaults).toEqual([]);
    expect(enemiesOnly.ok).toBe(true);
  });

  test("an opposite-corner pair flanks, and an adjacent-side pair does not", () => {
    const corners = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5), tok("se", 6, 6), tok("nw", 4, 4)],
    });
    expect(corners.flanking.map((f) => f.attackerId).sort()).toEqual([
      "nw",
      "se",
    ]);

    const sides = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5), tok("e", 6, 5), tok("n", 5, 4)],
    });
    expect(sides.flanking).toEqual([]);
  });

  test("a Large defender is flanked across its whole space", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [largeTok("ogre", 5, 5), tok("e", 7, 5), tok("w", 4, 6)],
    });
    expect(entryOf(model, "ogre").cells).toEqual(["5,5", "6,5", "5,6", "6,6"]);
    expect(model.flanking).toEqual([
      {
        attackerId: "e",
        defenderId: "ogre",
        helperIds: ["w"],
        bonus: PF1E_FLANKING_BONUS,
      },
      {
        attackerId: "w",
        defenderId: "ogre",
        helperIds: ["e"],
        bonus: PF1E_FLANKING_BONUS,
      },
    ]);
  });

  test("a helper that cannot reach the defender confers nothing", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5), tok("a", 6, 5), tok("far", 3, 5)],
    });
    expect(model.flanking).toEqual([]);
  });

  test("a Tiny token threatens nothing, cannot flank, and is never a helper", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [
        tok("d", 5, 5),
        tok("a", 6, 5),
        tok("t", 4, 5, { size: "Tiny", width: 2.5, height: 2.5 }),
      ],
    });
    const tiny = entryOf(model, "t");
    expect(tiny.threatensNothing).toBe(true);
    expect(tiny.cannotFlank).toBe(true);
    expect(tiny.reachSquares).toBe(0);
    expect(tiny.threatKeys).toEqual([]);
    expect(model.flanking).toEqual([]);
  });

  test("a reach weapon flanks from 10 ft, and its dead zone leaves an adjacent attacker threatening nothing", () => {
    const banded = pf1eThreatModel({
      grid: GRID,
      tokens: [
        tok("d", 5, 5),
        tok("a", 7, 5, { reachWeapon: true }),
        tok("w", 4, 5),
      ],
    });
    expect(entryOf(banded, "a").threatKeys).toContain("5,5");
    // Both directions: the polearm attacker from 10 ft with the adjacent ally as
    // its helper, and the adjacent attacker with the polearm as *its* helper.
    expect(banded.flanking.map((f) => f.attackerId)).toEqual(["a", "w"]);

    const deadZone = pf1eThreatModel({
      grid: GRID,
      tokens: [
        tok("d", 5, 5),
        tok("a", 6, 5, { reachWeapon: true }),
        tok("w", 4, 5),
      ],
    });
    expect(entryOf(deadZone, "a").threatKeys).not.toContain("5,5");
    // The west token still flanks *with* the east one as its helper? No: the east
    // token threatens nothing, so it cannot help either.
    expect(deadZone.flanking).toEqual([]);
  });
});

describe("P04 — the model carries P02's geometry, not a second copy of it", () => {
  test("a Medium token threatens eight squares and a Large (tall) one twenty-eight", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("m", 5, 5), largeTok("l", 10, 10)],
    });
    const medium = entryOf(model, "m");
    expect(medium.threatKeys).toHaveLength(8);
    expect(medium.reachFt).toBe(5);
    expect(medium.threatensNothing).toBe(false);
    expect(medium.cannotFlank).toBe(false);

    const large = entryOf(model, "l");
    expect(large.reachSquares).toBe(2);
    expect(large.reachFt).toBe(10);
    expect(large.threatKeys).toHaveLength(28);
  });

  test("threat rects are the world squares the overlay draws", () => {
    const model = pf1eThreatModel({ grid: GRID, tokens: [tok("m", 5, 5)] });
    const entry = entryOf(model, "m");
    expect(entry.cellRects).toEqual([{ x: 25, y: 25, size: 5 }]);
    expect(entry.threatRects).toHaveLength(8);
    expect(entry.threatRects[0]).toEqual({ x: 20, y: 20, size: 5 });
    expect(entry.threatRects.every((r) => r.size === GRID.size)).toBe(true);
  });

  test("an authored reach overrides the size's natural one", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("m", 5, 5, { reachSquares: 3 })],
    });
    const entry = entryOf(model, "m");
    expect(entry.reachSquares).toBe(3);
    expect(entry.reachFt).toBe(15);
    expect(entry.threatKeys).toContain("5,2"); // three squares north
    expect(entry.threatKeys).not.toContain("5,1");
  });
});

describe("P04 — refusals are named, defaults are announced", () => {
  test("a metric or zero-sized scene grid is fatal, with the issue that says why", () => {
    const metric = pf1eThreatModel({
      grid: { size: 5, distance: 1.5, units: "m" },
      tokens: [tok("d", 5, 5)],
    });
    expect(metric.ok).toBe(false);
    expect(metric.entries).toEqual([]);
    expect(metric.issues.map((i) => i.field)).toContain("grid.units");

    const zero = pf1eThreatModel({
      grid: { size: 0, distance: 5, units: "ft" },
      tokens: [],
    });
    expect(zero.ok).toBe(false);
    expect(zero.issues.map((i) => i.field)).toContain("grid.size");
  });

  test("a token covering no square is an issue, not a guessed position", () => {
    // Zero-sized and centred exactly on a grid intersection: `tokenCells` finds
    // no square for it, and the model refuses rather than rounding it into one.
    const ghost: PF1eThreatToken = {
      _id: "ghost",
      x: 25,
      y: 30,
      width: 0,
      height: 0,
    };
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5), ghost],
    });
    expect(model.ok).toBe(false);
    expect(model.entries).toEqual([]);
    expect(model.issues).toEqual([
      {
        field: "token:ghost",
        message:
          "token covers no grid square — it has no space to threaten from or be flanked in",
      },
    ]);
  });

  test("an unresolved size is announced and resolved as Medium", () => {
    const bare: PF1eThreatToken = {
      _id: "d",
      x: 27.5,
      y: 27.5,
      width: 5,
      height: 5,
    };
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [bare, tok("a", 6, 5), tok("w", 4, 5)],
    });
    expect(model.ok).toBe(true);
    expect(model.defaults).toEqual([
      {
        field: "isEnemy",
        message:
          "hostility not supplied — reporting every flanking pair regardless of side (AoN 183 asks for an enemy)",
      },
      {
        field: "token:d",
        message: "size not resolved from its actor — using Medium",
      },
    ]);
    expect(entryOf(model, "d").size).toBe("Medium");
    expect(model.flanking).toHaveLength(2);
  });

  test("a size that is not a size category is announced too", () => {
    const model = pf1eThreatModel({
      grid: GRID,
      tokens: [tok("d", 5, 5, { size: "Huger" })],
    });
    expect(model.ok).toBe(true);
    expect(noteOf(model, "token:d").message).toContain(
      'size "Huger" is not a PF1e size category',
    );
  });
});
