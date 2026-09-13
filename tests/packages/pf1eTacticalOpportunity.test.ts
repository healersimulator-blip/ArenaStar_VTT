/**
 * P06/D-185 — the tactical AoO scene seam, derived from the rules quoted in
 * `src/packages/pf1e/interrupts.ts` (AoN 102/151/161) and from the geometry the scene
 * already owns (`tokenCells`, `threatenedCells`).
 *
 * The scene fixtures use the tactical convention: `grid.size = 100` world units per
 * square, `grid.distance = 5` ft per square, a token's `x`/`y` is its **centre**
 * (`pf1ePlaceTokens` and `dragTarget` both work in these units), and a Medium token
 * therefore sits at `(col + 0.5) * 100`.
 */
import { describe, expect, test } from "vitest";
import {
  pf1eMovementOpportunities,
  sceneFeetPerSquare,
  type PF1eMovementOpportunityInput,
} from "../../src/packages/pf1e/tacticalOpportunity";
import type { PF1eThreatToken } from "../../src/packages/pf1e/threatPreview";

const GRID = { size: 100, distance: 5, units: "ft" };

/** A Medium token centred on (col, row). */
const token = (
  id: string,
  col: number,
  row: number,
  extra: Partial<PF1eThreatToken> = {},
) =>
  ({
    _id: id,
    x: (col + 0.5) * GRID.size,
    y: (row + 0.5) * GRID.size,
    width: GRID.size,
    height: GRID.size,
    size: "Medium",
    ...extra,
  }) satisfies PF1eThreatToken;

const moveTo = (
  input: Partial<PF1eMovementOpportunityInput> & {
    moverId: string;
    toCol: number;
    toRow: number;
  },
) =>
  pf1eMovementOpportunities({
    grid: GRID,
    tokens: input.tokens ?? [],
    mover: {
      tokenId: input.moverId,
      to: {
        x: (input.toCol + 0.5) * GRID.size,
        y: (input.toRow + 0.5) * GRID.size,
      },
    },
    ...(input.withdraw !== undefined ? { withdraw: input.withdraw } : {}),
    ...(input.ledgers !== undefined ? { ledgers: input.ledgers } : {}),
    ...(input.isEnemy !== undefined ? { isEnemy: input.isEnemy } : {}),
    ...(input.coverWalls !== undefined ? { coverWalls: input.coverWalls } : {}),
  });

describe("P06 — the tactical scene decides movement AoOs from the queue", () => {
  test("a walked-out threatened square queues one opportunity, in the square it left", () => {
    // Goblin (0,0) → (4,0): it leaves (0,0), (1,0), (2,0), (3,0). The fighter at (3,1)
    // threatens all eight squares around its own, (3,0) and (2,0) among them.
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 3, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.path).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0"]);
    expect(res.squaresLeft).toEqual(["0,0", "1,0", "2,0", "3,0"]);
    expect(res.queued).toHaveLength(1);
    // The *first* square of the walk the fighter threatens — where the attack happens.
    expect(res.queued[0]?.reactorId).toBe("fighter");
    expect(res.queued[0]?.provokerId).toBe("goblin");
    expect(res.queued[0]?.trigger.kind).toBe("move-out");
    expect(res.queued[0]?.trigger.left).toEqual({ x: 200, y: 0 });
    expect(res.reactors[0]?.cell).toBe("2,0");
    expect(res.reactors[0]?.line).toBe(
      "fighter may strike goblin as it leaves (2,0)",
    );
    // The highlight draw list is world rects, one per left square.
    expect(res.leftRects).toHaveLength(4);
    expect(res.leftRects[0]).toEqual({ x: 0, y: 0, size: 100 });
  });

  test("a creature that does not threaten any left square never reacts", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("wizard", 0, 8)],
      moverId: "goblin",
      toCol: 2,
      toRow: 0,
      isEnemy: () => true,
    });
    expect(res.queued).toEqual([]);
    expect(res.reactors).toEqual([]);
  });

  test("the same opponent reacts once however many of its squares are left", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 2, 1)],
      moverId: "goblin",
      toCol: 5,
      toRow: 0,
      isEnemy: () => true,
    });
    // (1,0), (2,0) and (3,0) are all threatened by the fighter (a 1-square reach from
    // (2,1) covers its eight neighbours) — AoN 102's one-opportunity sentence.
    expect(res.squaresLeft).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0"]);
    expect(res.queued).toHaveLength(1);
    expect(res.queued[0]?.trigger.left).toEqual({ x: 100, y: 0 });
  });

  test("AoN 181 — cover between the reactor and the left square refuses the strike", () => {
    // The goblin walks out of (0,0); the fighter below it reacts there. A wall
    // along their shared edge (x 20–80 on y=100) crosses the diagonal corner
    // lines, so the provoker has standard cover and the opportunity is refused
    // — "you can't execute an attack of opportunity against an opponent with
    // cover" (AoN 181).
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 0, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
      coverWalls: [{ x1: 20, y1: 100, x2: 80, y2: 100 }],
    });
    expect(res.queued).toEqual([]);
    expect(res.refused).toEqual([
      {
        tokenId: "fighter",
        reason:
          "the provoker has cover — you can't execute an attack of opportunity against an opponent with cover (AoN 181)",
      },
    ]);
    // Refused, not dropped: the reactor row still reports the line.
    expect(res.reactors[0]?.line).toBe(
      "fighter forgoes the attack of opportunity — the provoker has cover — you can't execute an attack of opportunity against an opponent with cover (AoN 181)",
    );
  });

  test("AoN 181 — a clear lane still queues the opportunity when cover facts are supplied", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 0, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
      coverWalls: [],
    });
    expect(res.queued).toHaveLength(1);
    expect(res.queued[0]?.reactorId).toBe("fighter");
    // Cover facts supplied → no coverWalls default is reported.
    expect(
      res.defaults.map((d) => d.field).includes("coverWalls"),
    ).toBe(false);
  });

  test("absent cover facts are a named default, not a silent queue-through", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 0, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
    });
    // Every pre-existing test exercises this path; pin the name once.
    expect(res.queued).toHaveLength(1);
    expect(
      res.defaults.find((d) => d.field === "coverWalls")?.message,
    ).toBe(
      "cover facts not supplied — reactors were queued without AoN 181's cover exclusion",
    );
  });

  test("a spent ledger refuses the reaction by name, and the refusal is not a silent drop", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 3, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
      ledgers: { fighter: { used: 1, max: 1 } },
    });
    expect(res.queued).toEqual([]);
    expect(res.refused).toEqual([
      { tokenId: "fighter", reason: "no opportunities left (1/1)" },
    ]);
    // Still reported as a reactor, with the line the log should carry.
    expect(res.reactors[0]?.used).toBe(1);
    expect(res.reactors[0]?.max).toBe(1);
    expect(res.reactors[0]?.line).toBe(
      "fighter forgoes the attack of opportunity — no opportunities left (1/1)",
    );
  });

  test("a ledger with budget left reacts, and reports its own numbers", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 3, 1)],
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: () => true,
      ledgers: { fighter: { used: 2, max: 4 } }, // Dex 16 + Combat Reflexes
    });
    expect(res.queued).toHaveLength(1);
    expect(res.refused).toEqual([]);
    expect(res.reactors[0]?.used).toBe(2);
    expect(res.reactors[0]?.max).toBe(4);
  });

  test("a diagonal step leaves one square, and the grazed corner never provokes", () => {
    // (0,0) → (1,1): the walk is the direct diagonal (D-182), so the two orthogonal
    // neighbours of the corner are not squares the mover left. Both creatures below have a
    // one-square reach: `startAdjacent` at (1,-1) threatens (0,0) — the square actually
    // left — and `corner` at (2,-1) threatens only (1,0), the grazed corner.
    const grazed = moveTo({
      tokens: [token("goblin", 0, 0), token("corner", 2, -1)],
      moverId: "goblin",
      toCol: 1,
      toRow: 1,
      isEnemy: () => true,
    });
    expect(grazed.path).toEqual(["0,0", "1,1"]);
    expect(grazed.squaresLeft).toEqual(["0,0"]);
    expect(grazed.queued).toEqual([]);
    expect(grazed.reactors).toEqual([]);

    const left = moveTo({
      tokens: [token("goblin", 0, 0), token("startAdjacent", 1, -1)],
      moverId: "goblin",
      toCol: 1,
      toRow: 1,
      isEnemy: () => true,
    });
    expect(left.queued.map((q) => q.reactorId)).toEqual(["startAdjacent"]);
  });

  test("a withdraw exempts the start square, and only it (AoN 151)", () => {
    // "west" at (-1,0) threatens exactly one of the squares this walk leaves: (0,0), the
    // start square. "further" at (2,1) threatens (1,0) and (2,0) — squares after it.
    const tokens = [
      token("wizard", 0, 0),
      token("west", -1, 0),
      token("further", 2, 1),
    ];
    const normal = moveTo({
      tokens,
      moverId: "wizard",
      toCol: 3,
      toRow: 0,
      isEnemy: () => true,
    });
    expect(normal.squaresLeft).toEqual(["0,0", "1,0", "2,0"]);
    expect(normal.queued.map((q) => q.reactorId).sort()).toEqual([
      "further",
      "west",
    ]);

    const withdrawing = moveTo({
      tokens,
      moverId: "wizard",
      toCol: 3,
      toRow: 0,
      withdraw: true,
      isEnemy: () => true,
    });
    expect(withdrawing.squaresLeft).toEqual(["1,0", "2,0"]);
    // The start-square reactor loses its opportunity; the one threatening a later square
    // keeps it — "other than the one you started in … enemies get attacks of opportunity
    // as normal".
    expect(withdrawing.queued.map((q) => q.reactorId)).toEqual(["further"]);
    expect(withdrawing.reactors.map((r) => r.tokenId)).toEqual(["further"]);
  });

  test("a neutral token is not a reactor when the caller states hostility", () => {
    const tokens = [token("goblin", 0, 0), token("ally", 3, 1)];
    const hostile = moveTo({
      tokens,
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      isEnemy: (a, b) => a !== "ally" || b !== "goblin",
    });
    expect(hostile.queued).toEqual([]);
    expect(hostile.reactors).toEqual([]);
    // Without the predicate every other token is treated as an enemy — and the model says so.
    const unstated = moveTo({ tokens, moverId: "goblin", toCol: 4, toRow: 0 });
    expect(unstated.queued).toHaveLength(1);
    expect(unstated.defaults.map((d) => d.field)).toContain("isEnemy");
  });

  test("a move inside one square provokes nothing, and names no reactor", () => {
    const res = moveTo({
      tokens: [token("goblin", 0, 0), token("fighter", 1, 0)],
      moverId: "goblin",
      toCol: 0,
      toRow: 0,
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.path).toEqual(["0,0"]);
    expect(res.squaresLeft).toEqual([]);
    expect(res.queued).toEqual([]);
    expect(res.refusal).toBeNull();
  });

  test("a multi-square mover reports the centre-walk assumption instead of guessing", () => {
    // A Large token (2×2) centred on (1,1) covers (0,0),(1,0),(0,1),(1,1).
    const large = token("ogre", 1, 1, {
      size: "Large",
      width: 200,
      height: 200,
    });
    const res = moveTo({
      tokens: [large, token("fighter", 2, 3)],
      moverId: "ogre",
      toCol: 3,
      toRow: 1,
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.defaults.map((d) => d.field)).toContain("token:ogre");
    expect(
      res.defaults.some((d) => d.message.includes("multi-square mover")),
    ).toBe(true);
  });

  test("a missing mover and an unreadable grid refuse by name", () => {
    const missing = moveTo({
      tokens: [token("goblin", 0, 0)],
      moverId: "ghost",
      toCol: 1,
      toRow: 0,
    });
    expect(missing.ok).toBe(false);
    expect(missing.refusal).toBe('no token "ghost" on this scene');

    const badGrid = pf1eMovementOpportunities({
      grid: { size: 0, distance: 5, units: "ft" },
      tokens: [token("goblin", 0, 0)],
      mover: { tokenId: "goblin", to: { x: 150, y: 50 } },
    });
    expect(badGrid.ok).toBe(false);
    expect(badGrid.issues.map((i) => i.field)).toContain("grid.size");
  });
});

describe("sceneFeetPerSquare", () => {
  test("the scene's own distance, with the standard square as the fallback", () => {
    expect(sceneFeetPerSquare({ distance: 5 })).toBe(5);
    expect(sceneFeetPerSquare({ distance: 10 })).toBe(10);
    expect(sceneFeetPerSquare({ distance: 0 })).toBe(5);
    expect(sceneFeetPerSquare({ distance: Number.NaN })).toBe(5);
  });
});
