/**
 * P03/D-198 — movement legality and cost (`movement.ts`), derived from Gap
 * List A.7's transcription and the CRB pages it cites: 5-10-5 diagonals,
 * difficult terrain ×2 (double-doubled ×4), squeeze ×2, the minimum-movement
 * full-round 5 ft, the 5-foot step's exclusivity, charge's ≥10 ft and no
 * difficult terrain, run/withdraw multipliers, occupied ending squares,
 * through-ally pass-through, and the straight-walk wall refusal.
 *
 * Fixtures use the tactical convention: `grid.size = 100` world units per
 * square, `distance = 5`, a token's x/y is its centre.
 */
import { describe, expect, test } from "vitest";
import {
  MOVE_MODES,
  moveBlocked,
  moveModeSpeedFactor,
  pf1eMovePlan,
  type PF1eMoveMode,
} from "../../src/packages/pf1e/movement";
import type { PF1eThreatToken } from "../../src/packages/pf1e/threatPreview";
import type { PF1eCell } from "../../src/packages/pf1e/targeting";

const GRID = { size: 100, distance: 5, units: "ft" };

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

/** A Large (2×2) token whose centre sits on the shared corner of four cells. */
const largeToken = (id: string, col: number, row: number): PF1eThreatToken => {
  const anchor = token(id, col, row);
  return {
    ...anchor,
    x: (col + 1) * GRID.size,
    y: (row + 1) * GRID.size,
    width: 2 * GRID.size,
    height: 2 * GRID.size,
    size: "Large",
  };
};

const cell = (col: number, row: number): PF1eCell => ({ col, row });

const walk = (
  overrides: Partial<Parameters<typeof pf1eMovePlan>[0]> & {
    moverId: string;
    toCol: number;
    toRow: number;
    mode?: PF1eMoveMode;
    speedFt?: number;
    movedThisTurn?: boolean;
    squeezing?: boolean;
  },
) =>
  pf1eMovePlan({
    grid: GRID,
    tokens: overrides.tokens ?? [],
    mover: {
      tokenId: overrides.moverId,
      to: {
        x: (overrides.toCol + 0.5) * GRID.size,
        y: (overrides.toRow + 0.5) * GRID.size,
      },
      ...(overrides.speedFt !== undefined ? { speedFt: overrides.speedFt } : {}),
      ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
      ...(overrides.movedThisTurn !== undefined
        ? { movedThisTurn: overrides.movedThisTurn }
        : {}),
      ...(overrides.squeezing !== undefined
        ? { squeezing: overrides.squeezing }
        : {}),
    },
    ...(overrides.walls !== undefined ? { walls: overrides.walls } : {}),
    ...(overrides.difficultCells !== undefined
      ? { difficultCells: overrides.difficultCells }
      : {}),
    ...(overrides.isAlly !== undefined ? { isAlly: overrides.isAlly } : {}),
  });

describe("P03 — the mode table", () => {
  test("the five modes and their speed multipliers", () => {
    expect([...MOVE_MODES]).toEqual([
      "walk",
      "run",
      "withdraw",
      "charge",
      "five-foot-step",
    ]);
    expect(moveModeSpeedFactor("walk")).toBe(1);
    expect(moveModeSpeedFactor("run")).toBe(4);
    expect(moveModeSpeedFactor("withdraw")).toBe(2);
    expect(moveModeSpeedFactor("charge")).toBe(2);
    expect(moveModeSpeedFactor("five-foot-step")).toBe(1);
  });

  test("moveBlocked is the §9 move axis, doors conditionally", () => {
    expect(moveBlocked({ move: 0, door: 0 })).toBe(true);
    expect(moveBlocked({ move: 0, door: 1 })).toBe(true); // 0 blocks, door irrelevant
    expect(moveBlocked({ move: 2, door: 0 })).toBe(false); // permits
    expect(moveBlocked({ move: 1, door: 0 })).toBe(true); // conditional, closed
    expect(moveBlocked({ move: 1, door: 2 })).toBe(true); // conditional, locked
    expect(moveBlocked({ move: 1, door: 1 })).toBe(false); // conditional, open
  });
});

describe("P03 — 5-10-5 pricing (A.7)", () => {
  test("orthogonal, diagonal and mixed walks", () => {
    // 4 orthogonal squares = 20 ft.
    const straight = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
    });
    expect(straight.ok).toBe(true);
    expect(straight.costFt).toBe(20);
    expect(straight.path).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0"]);

    // Two diagonals: 1 + 2 = 3 squares = 15 ft (the 5-10-5 alternation).
    const diagonal = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 2,
    });
    expect(diagonal.ok).toBe(true);
    expect(diagonal.costFt).toBe(15);
    expect(diagonal.path).toEqual(["0,0", "1,1", "2,2"]);

    // One diagonal then one orthogonal: 1 + 1 = 2 squares = 10 ft.
    const mixed = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 1,
    });
    expect(mixed.costFt).toBe(10);

    // Staying put costs nothing and is legal.
    const stay = walk({
      tokens: [token("m", 3, 3)],
      moverId: "m",
      toCol: 3,
      toRow: 3,
    });
    expect(stay.ok).toBe(true);
    expect(stay.costFt).toBe(0);
    expect(stay.refusal).toBeNull();
  });

  test("difficult terrain doubles the entered square (×4 double-doubled)", () => {
    // (1,0) difficult: 1 + 2 = 3 squares = 15 ft.
    const once = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      difficultCells: [cell(1, 0)],
    });
    expect(once.costFt).toBe(15);

    // Two difficult squares double-doubled: 2 + 2 = 4 squares = 20 ft.
    const twice = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      difficultCells: [cell(1, 0), cell(2, 0)],
    });
    expect(twice.costFt).toBe(20);
    expect(
      twice.defaults.find((d) => d.field === "difficultCells"),
    ).toBeUndefined();
  });

  test("a declared squeeze doubles every entered square (A.7)", () => {
    const squeezed = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      squeezing: true,
    });
    expect(squeezed.costFt).toBe(20); // 4 squares of movement for 2 squares entered
  });

  test("a Large mover walks between footprints at anchor step cost", () => {
    // The 2×2 space (centre on the four-cell corner, cols 0–1) shifts two
    // columns right (cols 2–3): 2 anchor steps = 10 ft, and the destination
    // footprint is the mover's own cells at the new centre.
    const res = pf1eMovePlan({
      grid: GRID,
      tokens: [largeToken("ogre", 0, 0)],
      mover: {
        tokenId: "ogre",
        to: { x: 3 * GRID.size, y: 1 * GRID.size },
      },
    });
    expect(res.ok).toBe(true);
    expect(res.costFt).toBe(10);
    expect(res.destination).toEqual(["2,0", "3,0", "2,1", "3,1"]);
  });
});

describe("P03 — the budget and the modes", () => {
  test("a walk beyond speed refuses by name", () => {
    const res = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
      speedFt: 15,
    });
    expect(res.ok).toBe(true); // a decision, not a scene failure
    expect(res.refusal).toBe(
      "the walk costs 20 ft but a move action moves 15 ft",
    );
    expect(res.budgetFt).toBe(15);
  });

  test("run ×4, withdraw ×2, charge ×2 budgets", () => {
    const base = { tokens: [token("m", 0, 0)], moverId: "m", toCol: 4, toRow: 0, speedFt: 15 } as const;
    const run = walk({ ...base, mode: "run" });
    expect(run.refusal).toBeNull();
    expect(run.budgetFt).toBe(60);
    const withdraw = walk({ ...base, mode: "withdraw" });
    expect(withdraw.refusal).toBeNull();
    expect(withdraw.budgetFt).toBe(30);
    const charge = walk({ ...base, mode: "charge" });
    expect(charge.refusal).toBeNull();
    expect(charge.budgetFt).toBe(30);
  });

  test("a charge needs at least 10 ft and no difficult terrain (CRB p.188)", () => {
    const short = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
      mode: "charge",
    });
    expect(short.refusal).toBe(
      "a charge must move at least 10 ft (2 squares) toward the designated opponent (CRB p.188)",
    );

    const rough = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
      mode: "charge",
      difficultCells: [cell(2, 0)],
    });
    expect(rough.refusal).toBe(
      "you can't charge through difficult terrain (CRB p.188) — the straight walk crosses it",
    );
  });

  test("A.7's minimum movement: a full-round 5 ft when speed bars all movement", () => {
    // Speed reduced to 0: the budget is gone, but the 5-ft walk is the
    // minimum-movement full-round action — allowed, flagged, provoking.
    const min = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
      speedFt: 0,
    });
    expect(min.ok).toBe(true);
    expect(min.refusal).toBeNull();
    expect(min.minimumMovement).toBe(true);

    // It lifts the budget for that first 5 ft only.
    const beyond = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      speedFt: 0,
    });
    expect(beyond.minimumMovement).toBe(false);
    expect(beyond.refusal).toBe(
      "the walk costs 10 ft but a move action moves 0 ft",
    );
  });
});

describe("P03 — the 5-foot step (CRB p.189)", () => {
  test("one square, any direction, when otherwise unmoved", () => {
    const orthogonal = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
      mode: "five-foot-step",
    });
    expect(orthogonal.refusal).toBeNull();
    expect(orthogonal.costFt).toBe(5);

    const diagonal = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 1,
      mode: "five-foot-step",
    });
    expect(diagonal.refusal).toBeNull(); // the first diagonal is 1 square
    expect(diagonal.costFt).toBe(5);
  });

  test("exactly one square — a longer walk refuses by name", () => {
    const res = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      mode: "five-foot-step",
    });
    expect(res.refusal).toBe(
      "a 5-foot step moves 1 square — this walk costs 10 ft (CRB p.189)",
    );
  });

  test("no 5-foot step after other movement, or into difficult terrain", () => {
    const moved = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
      mode: "five-foot-step",
      movedThisTurn: true,
    });
    expect(moved.refusal).toBe(
      "a 5-foot step is legal only when you have not moved at all this turn (CRB p.189)",
    );

    const rough = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
      mode: "five-foot-step",
      difficultCells: [cell(1, 0)],
    });
    expect(rough.refusal).toBe(
      "you can't take a 5-foot step when difficult terrain slows your movement (CRB p.189)",
    );
  });
});

describe("P03 — walls and occupancy", () => {
  test("a move-blocking wall on the straight walk refuses; routing around is another drag", () => {
    const res = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
      walls: [{ x1: 100, y1: 20, x2: 100, y2: 80 }],
    });
    expect(res.refusal).toBe(
      "the straight walk crosses a wall — route around it (a drag is a straight line; pathfinding is a different action)",
    );
    // The same walk without the wall facts is judged without blocking (named).
    const noFacts = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 2,
      toRow: 0,
    });
    expect(noFacts.refusal).toBeNull();
    expect(
      noFacts.defaults.find((d) => d.field === "walls")?.message,
    ).toContain("walls not supplied");
  });

  test("you can never end movement in an occupied square (A.7)", () => {
    const res = walk({
      tokens: [token("m", 0, 0), token("goblin", 3, 0)],
      moverId: "m",
      toCol: 3,
      toRow: 0,
      isAlly: () => true,
    });
    expect(res.refusal).toBe(
      "you can never end movement in an occupied square — the destination overlaps goblin's space (A.7)",
    );
    expect(res.destination).toEqual(["3,0"]);
  });

  test("an occupier at the destination is the ending rule's fact, not pass-through", () => {
    // The blocker sits exactly where the walk ends: the named refusal is the
    // ending rule (an ally would be passable-through but still not endable-in).
    const enemy = walk({
      tokens: [token("m", 0, 0), token("goblin", 3, 0)],
      moverId: "m",
      toCol: 3,
      toRow: 0,
      isAlly: () => false,
    });
    expect(enemy.refusal).toContain(
      "you can never end movement in an occupied square",
    );
    const ally = walk({
      tokens: [token("m", 0, 0), token("fighter", 3, 0)],
      moverId: "m",
      toCol: 3,
      toRow: 0,
      isAlly: () => true,
    });
    expect(ally.refusal).toContain(
      "you can never end movement in an occupied square — the destination overlaps fighter's space",
    );
  });

  test("pass-through: allies may be crossed, enemies may not, and the default blocks everyone", () => {
    const blocked = walk({
      tokens: [token("m", 0, 0), token("goblin", 2, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
    });
    expect(blocked.refusal).toBe(
      "the walk passes through goblin's square — you can only move through an ally's space (CRB p.193)",
    );
    expect(
      blocked.defaults.find((d) => d.field === "isAlly")?.message,
    ).toContain("alliance not supplied");

    const allied = walk({
      tokens: [token("m", 0, 0), token("fighter", 2, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
      isAlly: (a, b) => a !== b, // everyone is an ally in this fixture
    });
    expect(allied.refusal).toBeNull();

    const enemy = walk({
      tokens: [token("m", 0, 0), token("goblin", 2, 0)],
      moverId: "m",
      toCol: 4,
      toRow: 0,
      isAlly: () => false,
    });
    expect(enemy.refusal).toContain("passes through goblin's square");
  });
});

describe("P03 — named defaults and scene failures", () => {
  test("every unstated fact is a named default, never a silent guess", () => {
    const res = walk({
      tokens: [token("m", 0, 0)],
      moverId: "m",
      toCol: 1,
      toRow: 0,
    });
    expect(res.ok).toBe(true);
    expect(res.refusal).toBeNull();
    expect(res.defaults.map((d) => d.field)).toEqual([
      "mode",
      "speedFt",
      "walls",
      "difficultCells",
      "isAlly",
    ]);
    expect(res.defaults.find((d) => d.field === "mode")?.message).toContain(
      "judged as a move action",
    );
    expect(res.defaults.find((d) => d.field === "speedFt")?.message).toContain(
      "30-ft default",
    );
  });

  test("an unreadable grid or a missing mover refuses by name", () => {
    const badGrid = pf1eMovePlan({
      grid: { size: 0, distance: 5, units: "ft" },
      tokens: [token("m", 0, 0)],
      mover: { tokenId: "m", to: { x: 150, y: 50 } },
    });
    expect(badGrid.ok).toBe(false);
    expect(badGrid.refusal).toBe("the scene grid cannot be read");
    expect(badGrid.issues.map((i) => i.field)).toContain("grid.size");

    const missing = walk({
      tokens: [token("m", 0, 0)],
      moverId: "ghost",
      toCol: 1,
      toRow: 0,
    });
    expect(missing.ok).toBe(false);
    expect(missing.refusal).toBe('no token "ghost" on this scene');
  });
});
