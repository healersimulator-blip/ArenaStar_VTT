/**
 * P06/D-190 — the tactical action-trigger seam, derived from the rules quoted in
 * `src/packages/pf1e/interrupts.ts` (AoN 102/133/147) and from the scene facts the movement
 * seam already owns (`tokenCells`, `threatenedCells`, Table 7-2 out of `actions.ts`).
 *
 * The fixtures use the same tactical convention as `pf1eTacticalOpportunity.test.ts`:
 * `grid.size = 100` world units per square, `grid.distance = 5` ft per square, a token's
 * `x`/`y` is its **centre**, and a Medium token sits at `(col + 0.5) * 100`. The provoker
 * is attacked in the square it occupies when it acts, never in a square it walks out of.
 */
import { describe, expect, test } from "vitest";
import {
  actionProvokeLines,
  pf1eActionOpportunities,
  type PF1eActionOpportunityInput,
} from "../../src/packages/pf1e/actionOpportunity";
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

const act = (
  input: Partial<PF1eActionOpportunityInput> & { provokerId: string },
) =>
  pf1eActionOpportunities({
    grid: GRID,
    tokens: input.tokens ?? [],
    provoker: { tokenId: input.provokerId },
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.ledgers !== undefined ? { ledgers: input.ledgers } : {}),
    ...(input.isEnemy !== undefined ? { isEnemy: input.isEnemy } : {}),
    ...(input.coverWalls !== undefined ? { coverWalls: input.coverWalls } : {}),
  });

describe("P06 — the tactical scene decides action AoOs from the queue", () => {
  test("casting within a threatened square queues the reactor, in the square the caster occupies", () => {
    // The wizard at (0,0) casts; the fighter at (0,1) threatens all eight of its
    // neighbours, (0,0) among them — AoN 102's \"performing certain actions within a
    // threatened square\".
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.refusal).toBeNull();
    expect(res.trigger).toEqual({
      kind: "provoking-action",
      actionId: "cast-spell",
    });
    expect(res.squares).toEqual(["0,0"]);
    expect(res.queued).toHaveLength(1);
    expect(res.queued[0]?.reactorId).toBe("fighter");
    expect(res.queued[0]?.provokerId).toBe("wizard");
    expect(res.queued[0]?.trigger.kind).toBe("provoking-action");
    // The interrupt records where the provoker stood, so a resolver needs no geometry.
    expect(res.queued[0]?.trigger.at).toEqual({ x: 0, y: 0 });
    expect(res.reactors[0]?.cell).toBe("0,0");
    expect(res.reactors[0]?.line).toBe(
      "fighter may strike wizard as it acts (0,0)",
    );
    // The highlight draw list is world rects, one per occupied square.
    expect(res.rects).toEqual([{ x: 0, y: 0, size: 100 }]);
  });

  test("AoN 181 — cover between the reactor and the provoker refuses the strike", () => {
    // The wizard casts at (0,0); the fighter at (1,0) threatens it. A wall
    // along their shared edge (y 20–80 on x=100) crosses the diagonal corner
    // lines, so the provoker has standard cover and the opportunity is
    // refused — cover blocks the attack of opportunity (AoN 181).
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 1, 0)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
      coverWalls: [{ x1: 100, y1: 20, x2: 100, y2: 80 }],
    });
    expect(res.queued).toEqual([]);
    expect(res.refused).toEqual([
      {
        tokenId: "fighter",
        reason:
          "the provoker has cover — you can't execute an attack of opportunity against an opponent with cover (AoN 181)",
      },
    ]);
    expect(res.reactors[0]?.line).toBe(
      "fighter forgoes the attack of opportunity — the provoker has cover — you can't execute an attack of opportunity against an opponent with cover (AoN 181)",
    );
  });

  test("AoN 181 — a clear lane still queues when cover facts are supplied; absent facts are a named default", () => {
    const clear = act({
      tokens: [token("wizard", 0, 0), token("fighter", 1, 0)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
      coverWalls: [],
    });
    expect(clear.queued).toHaveLength(1);
    expect(clear.refused).toEqual([]);
    expect(clear.defaults.map((d) => d.field).includes("coverWalls")).toBe(
      false,
    );

    const noFacts = act({
      tokens: [token("wizard", 0, 0), token("fighter", 1, 0)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
    });
    expect(noFacts.queued).toHaveLength(1);
    expect(
      noFacts.defaults.find((d) => d.field === "coverWalls")?.message,
    ).toBe(
      "cover facts not supplied — reactors were queued without AoN 181's cover exclusion",
    );
  });

  test("a Table 7-2 `no` row refuses by name and queues nothing", () => {
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "total-defense",
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true); // a decision, not a scene failure
    expect(res.trigger).toBeNull();
    expect(res.refusal).toBe(
      "Total defense does not provoke an attack of opportunity",
    );
    expect(res.queued).toEqual([]);
    expect(res.reactors).toEqual([]);
  });

  test("an unknown action refuses by name, and a `maybe` row is left to the caller", () => {
    const noSuch = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "no-such-action",
    });
    expect(noSuch.refusal).toBe('unknown action "no-such-action"');

    const aid = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "aid-another",
    });
    expect(aid.refusal).toContain('provokes "maybe"');
    expect(aid.refusal).toContain("the caller decides");
    expect(aid.queued).toEqual([]);
  });

  test("the ranged-touch trigger is its own kind, stated by the caller (AoN 133)", () => {
    // A ranged touch provokes even from a defensively cast spell — the seam does not
    // care about defensiveness, so the caller states the trigger outright.
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      trigger: { kind: "ranged-touch" },
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.trigger).toEqual({ kind: "ranged-touch" });
    expect(res.queued).toHaveLength(1);
    expect(res.queued[0]?.trigger.kind).toBe("ranged-touch");
    expect(res.queued[0]?.trigger.at).toEqual({ x: 0, y: 0 });
  });

  test("a creature that does not threaten the caster's square never reacts", () => {
    const res = act({
      tokens: [token("wizard", 0, 0), token("guard", 0, 8)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.queued).toEqual([]);
    expect(res.reactors).toEqual([]);
  });

  test("a spent ledger refuses the reaction by name, not a silent drop", () => {
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "cast-spell",
      ledgers: { fighter: { used: 1, max: 1 } },
      isEnemy: () => true,
    });
    expect(res.queued).toEqual([]);
    expect(res.refused).toEqual([
      { tokenId: "fighter", reason: "no opportunities left (1/1)" },
    ]);
    expect(res.reactors[0]?.line).toBe(
      "fighter forgoes the attack of opportunity — no opportunities left (1/1)",
    );
  });

  test("a non-enemy does not react, and the absent-hostility default is named", () => {
    const friendly = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => false,
    });
    expect(friendly.queued).toEqual([]);

    const assumed = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "cast-spell",
    });
    expect(assumed.queued).toHaveLength(1);
    expect(assumed.defaults[0]?.field).toBe("isEnemy");
  });

  test("a missing provoker refuses by name rather than queueing nothing silently", () => {
    const res = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "ghost",
      actionId: "cast-spell",
    });
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('no token "ghost" on this scene');
    expect(res.queued).toEqual([]);
  });

  test("a cast and its ranged touch are two opportunities, so one reactor may take both", () => {
    // The dedupe unit is the actionId: `cast-spell:1:wizard` and `action:1:wizard:ranged-touch`
    // differ, so a Combat Reflexes reactor queued by both is offered twice — the two
    // distinct opportunities AoN 102 names.
    const cast = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      actionId: "cast-spell",
      isEnemy: () => true,
    });
    const touch = act({
      tokens: [token("wizard", 0, 0), token("fighter", 0, 1)],
      provokerId: "wizard",
      trigger: { kind: "ranged-touch" },
      isEnemy: () => true,
    });
    expect(cast.queued[0]?.actionId).toBe("cast-spell:1:wizard");
    expect(touch.queued[0]?.actionId).toBe("action:1:wizard:ranged-touch");
    expect(cast.queued[0]?.actionId).not.toBe(touch.queued[0]?.actionId);
  });

  test("actionProvokeLines reads reactors and refusals, and names the assumption", () => {
    const res = act({
      tokens: [
        token("wizard", 0, 0),
        token("fighter", 0, 1),
        token("rogue", 1, 0),
      ],
      provokerId: "wizard",
      actionId: "cast-spell",
      ledgers: { rogue: { used: 1, max: 1 } },
    });
    const lines = actionProvokeLines(res, { hostilityAssumed: true });
    expect(lines).toEqual([
      "fighter may strike wizard as it acts (0,0)",
      "rogue forgoes the attack of opportunity — no opportunities left (1/1)",
      "(hostility assumed — tokens without a disposition)",
    ]);
  });
});
