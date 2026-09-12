import { describe, expect, test } from "vitest";
import type {
  PF1eInterrupt,
  PF1eInterruptQueue,
} from "../../src/packages/pf1e/interrupts";
import type {
  PF1eMovementOpportunityResult,
  PF1eOpportunityReactor,
} from "../../src/packages/pf1e/tacticalOpportunity";
import {
  decideReactor,
  forgoLines,
  forgoReaction,
  isSettled,
  openReaction,
  opportunityForReactor,
  pendingReactionKey,
  pendingRows,
} from "../../src/ui/combat/pf1eReactionPrompt";

function interrupt(
  sequence: number,
  reactorId: string,
  provokerId = "goblin",
): PF1eInterrupt {
  return {
    id: `1:move:${reactorId}:${provokerId}:move-out:${sequence}`,
    kind: "attack-of-opportunity",
    reactorId,
    provokerId,
    actionId: "move-out",
    trigger: { kind: "move-out", left: { x: 200, y: 0 } },
    turn: 1,
    substep: "move",
    sequence,
  };
}

function reactor(
  tokenId: string,
  cell: string,
  line: string,
  used: number | null = 1,
  max: number | null = 1,
): PF1eOpportunityReactor {
  return {
    tokenId,
    cell,
    rect: { x: 0, y: 0, size: 100 },
    used,
    max,
    line,
  };
}

function opportunity(
  queued: PF1eInterrupt[],
  reactors: PF1eOpportunityReactor[],
): PF1eMovementOpportunityResult {
  const queue: PF1eInterruptQueue = {
    turn: 1,
    substep: "move",
    interrupts: [...queued],
  };
  return {
    ok: true,
    issues: [],
    defaults: [],
    grid: null,
    refusal: null,
    path: ["0,0", "1,0", "2,0", "3,0"],
    squaresLeft: ["0,0", "1,0", "2,0"],
    leftRects: [],
    reactors,
    refused: [],
    queue,
    queued,
  };
}

/** Two reactors: a fighter in (2,0) and an ogre in (3,0), the fighter first. */
function twoReactorOpportunity(): PF1eMovementOpportunityResult {
  return opportunity(
    [interrupt(0, "fighter"), interrupt(1, "ogre")],
    [
      reactor("fighter", "2,0", "fighter may strike goblin as it leaves (2,0)"),
      reactor("ogre", "3,0", "ogre may strike goblin as it leaves (3,0)"),
    ],
  );
}

describe("the reaction prompt (D-187)", () => {
  test("opens undecided, and its rows are the seam's reactors in the seam's order", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: twoReactorOpportunity(),
      combatId: "combat-1",
      hostilityAssumed: true,
    });
    expect(pending.decided).toEqual([]);
    expect(pending.hostilityAssumed).toBe(true);
    expect(isSettled(pending)).toBe(false);
    expect(pendingRows(pending)).toEqual([
      {
        reactorId: "fighter",
        cell: "2,0",
        line: "fighter may strike goblin as it leaves (2,0)",
        used: 1,
        max: 1,
        queued: 1,
      },
      {
        reactorId: "ogre",
        cell: "3,0",
        line: "ogre may strike goblin as it leaves (3,0)",
        used: 1,
        max: 1,
        queued: 1,
      },
    ]);
    expect(pendingReactionKey(pending)).toBe(
      "scene-1:0,0>1,0>2,0>3,0:1:move:fighter:goblin:move-out:0,1:move:ogre:goblin:move-out:1",
    );
  });

  test("deciding one reactor leaves the others pending, and settling drops the rows", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: twoReactorOpportunity(),
      combatId: "combat-1",
    });
    const afterFirst = decideReactor(pending, "fighter");
    expect(afterFirst.decided).toEqual(["fighter"]);
    expect(isSettled(afterFirst)).toBe(false);
    expect(pendingRows(afterFirst).map((r) => r.reactorId)).toEqual(["ogre"]);

    // Idempotent: a double click never double-counts a reactor.
    expect(decideReactor(afterFirst, "fighter").decided).toEqual(["fighter"]);

    const afterSecond = decideReactor(afterFirst, "ogre");
    expect(isSettled(afterSecond)).toBe(true);
    expect(pendingRows(afterSecond)).toEqual([]);
  });

  test("every row covers only its own reactor's interrupts", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: opportunity(
        [
          interrupt(0, "fighter"),
          interrupt(1, "fighter", "goblin"),
          interrupt(2, "ogre"),
        ],
        [
          reactor(
            "fighter",
            "2,0",
            "fighter may strike goblin as it leaves (2,0)",
          ),
          reactor("ogre", "3,0", "ogre may strike goblin as it leaves (3,0)"),
        ],
      ),
      combatId: "combat-1",
    });
    // The queue itself dedupes per (reactor, action) — but a reactor can hold more than one
    // interrupt for one move when a caller queues several, and the prompt's row covers all
    // of that reactor's, without touching another's.
    const fighter = opportunityForReactor(pending, "fighter");
    expect(fighter.queued.map((q) => q.id)).toEqual([
      "1:move:fighter:goblin:move-out:0",
      "1:move:fighter:goblin:move-out:1",
    ]);
    expect(
      pendingRows(pending).find((r) => r.reactorId === "fighter")?.queued,
    ).toBe(2);
    expect(opportunityForReactor(pending, "ogre").queued).toHaveLength(1);
    // The scene's own facts travel with the narrowed verdict.
    expect(fighter.path).toEqual(pending.opportunity.path);
    expect(fighter.reactors).toBe(pending.opportunity.reactors);
  });

  test("a reactor the queue deduped away is never asked about", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: opportunity(
        [interrupt(0, "fighter")],
        [
          reactor(
            "fighter",
            "2,0",
            "fighter may strike goblin as it leaves (2,0)",
          ),
          // Reported as a reactor (it threatened a left square) but with nothing queued:
          // spending on it would be an attack the queue refused.
          reactor("late", "2,0", "late may strike goblin as it leaves (2,0)"),
        ],
      ),
      combatId: "combat-1",
    });
    expect(pendingRows(pending).map((r) => r.reactorId)).toEqual(["fighter"]);
    // The queue, not the reactor list, decides when the prompt is settled.
    expect(isSettled(decideReactor(pending, "fighter"))).toBe(true);
  });

  test("forgo answers for everyone at once and reports each in the seam's wording", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: twoReactorOpportunity(),
      combatId: "combat-1",
    });
    expect(forgoLines(pending)).toEqual([
      "fighter forgoes the attack of opportunity in (2,0) (the table passed)",
      "ogre forgoes the attack of opportunity in (3,0) (the table passed)",
    ]);
    const forgone = forgoReaction(pending);
    expect(forgone.decided).toEqual(["fighter", "ogre"]);
    expect(isSettled(forgone)).toBe(true);
    expect(pendingRows(forgone)).toEqual([]);
    // Already-answered reactors are not answered twice.
    expect(forgoReaction(decideReactor(pending, "fighter")).decided).toEqual([
      "fighter",
      "ogre",
    ]);
  });

  test("an opportunity with nothing queued is settled from the start", () => {
    const pending = openReaction({
      sceneId: "scene-1",
      opportunity: opportunity([], []),
      combatId: null,
    });
    expect(isSettled(pending)).toBe(true);
    expect(pendingRows(pending)).toEqual([]);
    expect(forgoLines(pending)).toEqual([]);
  });
});
