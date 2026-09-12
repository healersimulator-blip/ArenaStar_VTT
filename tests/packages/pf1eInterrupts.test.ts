/**
 * P06 — the interrupt queue.
 *
 * Every fixture here is derived from the rule text quoted at the head of
 * `src/packages/pf1e/interrupts.ts` (fetched from Archives of Nethys 2026-09-12), never
 * from the module's own output: the one-opportunity-per-opponent sentence decides the
 * dedupe cases, AoN 151's "other than the one you started in" decides the withdraw cases,
 * and AoN 135/147 decide the exclusions.
 */
import { describe, expect, test } from "vitest";
import {
  actionProvokes,
  actionTrigger,
  aooRefusal,
  clearInterrupts,
  createInterruptQueue,
  nextInterrupt,
  orderInterrupts,
  queueAoOs,
  queueMovementAoOs,
  rangedTouchTrigger,
  resolveNextInterrupt,
  squaresLeft,
  type PF1eAoOState,
  type PF1eInterruptQueue,
} from "../../src/packages/pf1e/interrupts";
import { cellsAlongSegment } from "../../src/packages/pf1e/geometry";
import type { PF1eCell } from "../../src/packages/pf1e/targeting";

const key = (c: PF1eCell): string => `${c.col},${c.row}`;

/** A reactor that threatens exactly the listed squares (cell coordinates). */
const threatens = (...cells: string[]) => {
  const set = new Set(cells);
  return (cell: PF1eCell) => set.has(key(cell));
};

describe("interrupt queue — one opportunity per (reactor, action) (AoN 102)", () => {
  test("a move out of three threatened squares provokes once from that opponent", () => {
    // "Moving out of more than one square threatened by the same opponent in the same round
    // doesn't count as more than one opportunity for that opponent."
    const path = cellsAlongSegment({ x: 0, y: 0 }, { x: 15, y: 0 }, 5); // cells 0,0 → 3,0
    const res = queueMovementAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      moverId: "goblin",
      actionId: "move-1",
      path,
      cellFeet: 5,
      reactors: [{ id: "fighter", threatens: threatens("0,0", "1,0", "2,0") }],
    });
    expect(res.queued).toHaveLength(1);
    expect(res.queued[0]?.reactorId).toBe("fighter");
    expect(res.queued[0]?.trigger.kind).toBe("move-out");
    // The reported square is the first the walk left that this reactor threatens.
    expect(res.queued[0]?.trigger.left).toEqual({ x: 0, y: 0 });
    expect(res.squaresLeft.map((p) => `${p.x / 5},${p.y / 5}`)).toEqual([
      "0,0",
      "1,0",
      "2,0",
    ]);
  });

  test("two reactors that threaten it each get one; a reactor that threatens nothing gets none", () => {
    const path = cellsAlongSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 5); // leaves cells 0,0 and 1,0
    const res = queueMovementAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      moverId: "goblin",
      actionId: "move-1",
      path,
      cellFeet: 5,
      reactors: [
        { id: "fighter", threatens: threatens("0,0") },
        { id: "rogue", threatens: threatens("1,0", "1,0") },
        { id: "wizard", threatens: threatens("9,9") },
      ],
    });
    expect(res.queued.map((i) => i.reactorId)).toEqual(["fighter", "rogue"]);
    expect(res.refused).toEqual([
      {
        reactorId: "wizard",
        reason: "does not threaten a square the mover left",
      },
    ]);
    // The rogue's square is the one *it* threatens — the log names where the attack happens.
    expect(res.queued[1]?.trigger.left).toEqual({ x: 5, y: 0 });
  });

  test("two different provoking actions are two opportunities for the same reactor", () => {
    // "If the same opponent provokes two attacks of opportunity from you, you could make two
    // separate attacks of opportunity (since each one represents a different opportunity)."
    const first = queueAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      provokerId: "goblin",
      actionId: "move-1",
      trigger: { kind: "move-out", left: { x: 0, y: 0 } },
      reactors: [{ id: "fighter" }],
    });
    const second = queueAoOs(first.queue, {
      turn: 1,
      substep: "move",
      provokerId: "goblin",
      actionId: "ranged-1",
      trigger: rangedTouchTrigger(),
      reactors: [{ id: "fighter" }],
    });
    expect(first.queued).toHaveLength(1);
    expect(second.queued).toHaveLength(1);
    expect(second.queue.interrupts).toHaveLength(2);
    // ...but the same action cannot provoke twice from the same reactor.
    const again = queueAoOs(second.queue, {
      turn: 1,
      substep: "move",
      provokerId: "goblin",
      actionId: "move-1",
      trigger: { kind: "move-out", left: { x: 0, y: 0 } },
      reactors: [{ id: "fighter" }],
    });
    expect(again.queued).toEqual([]);
    expect(again.refused[0]?.reason).toBe("already provoked by this action");
  });

  test("a move that leaves no square (a shuffle inside one square) provokes nothing", () => {
    const res = queueMovementAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      moverId: "goblin",
      actionId: "move-1",
      path: cellsAlongSegment({ x: 1, y: 1 }, { x: 3, y: 2 }, 5),
      cellFeet: 5,
      reactors: [{ id: "fighter", threatens: threatens("0,0") }],
    });
    expect(res.queued).toEqual([]);
    expect(res.refused).toEqual([]); // nobody was even asked: there is no square left
  });
});

describe("withdraw's start square (AoN 151)", () => {
  test("the square the withdrawer started in is exempt, and only that square", () => {
    // "The square you start out in is not considered threatened … If, during the process of
    // withdrawing, you move out of a threatened square (other than the one you started in),
    // enemies get attacks of opportunity as normal."
    const path = cellsAlongSegment({ x: 0, y: 0 }, { x: 15, y: 0 }, 5); // leaves 0,0 1,0 2,0
    expect(key(path[0] as PF1eCell)).toBe("0,0");
    expect(squaresLeft(path).map(key)).toEqual(["0,0", "1,0", "2,0"]);
    expect(squaresLeft(path, { withdraw: true }).map(key)).toEqual([
      "1,0",
      "2,0",
    ]);

    const startOnly = queueMovementAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      moverId: "wizard",
      actionId: "retreat-1",
      path,
      withdraw: true,
      cellFeet: 5,
      reactors: [{ id: "goblin", threatens: threatens("0,0") }],
    });
    expect(startOnly.queued).toEqual([]);
    expect(startOnly.refused[0]?.reason).toBe(
      "does not threaten a square the mover left",
    );

    const secondSquare = queueMovementAoOs(createInterruptQueue(1, "move"), {
      turn: 1,
      substep: "move",
      moverId: "wizard",
      actionId: "retreat-1",
      path,
      withdraw: true,
      cellFeet: 5,
      reactors: [{ id: "ogre", threatens: threatens("2,0") }],
    });
    expect(secondSquare.queued).toHaveLength(1);
    expect(secondSquare.queued[0]?.trigger.left).toEqual({ x: 10, y: 0 });
  });
});

describe("who may take an opportunity (AoN 102/135/147)", () => {
  test("each denial names itself", () => {
    expect(aooRefusal({})).toBeNull();
    expect(aooRefusal({ threatensSquares: false })).toBe(
      "threatens no squares",
    );
    expect(aooRefusal({ casting: true })).toBe(
      "casting a spell — does not threaten",
    );
    expect(aooRefusal({ totalDefense: true })).toBe("using total defense");
    expect(aooRefusal({ incapacitated: true })).toBe("cannot act");
    expect(aooRefusal({ flatFooted: true })).toBe(
      "flat-footed (no Combat Reflexes)",
    );
    // "With this feat, you may also make attacks of opportunity while flat-footed."
    expect(aooRefusal({ flatFooted: true, combatReflexes: true })).toBeNull();
    expect(aooRefusal({ used: 1, budgetMax: 1 })).toBe(
      "no opportunities left (1/1)",
    );
    expect(aooRefusal({ used: 3, budgetMax: 4 })).toBeNull();
    // Total defense outranks the budget question, so the log names the real reason.
    const both: PF1eAoOState = { totalDefense: true, used: 9, budgetMax: 1 };
    expect(aooRefusal(both)).toBe("using total defense");
  });
});

describe("the trigger table is Table 7-2 (never a second copy)", () => {
  test("rows that provoke 'yes' trigger; rows that do not are refused with the row's name", () => {
    expect(actionProvokes("attack-ranged")).toBe("yes");
    expect(actionProvokes("cast-spell")).toBe("yes");
    expect(actionTrigger("attack-ranged")).toEqual({
      ok: true,
      trigger: { kind: "provoking-action", actionId: "attack-ranged" },
    });
    expect(actionTrigger("total-defense")).toEqual({
      ok: false,
      reason: "Total defense does not provoke an attack of opportunity",
    });
    expect(actionTrigger("no-such-action")).toEqual({
      ok: false,
      reason: 'unknown action "no-such-action"',
    });
  });

  test("a 'usually'/'maybe' row is refused rather than guessed", () => {
    // Footnote 2 of Table 7-2: "If you aid someone performing an action that would normally
    // provoke an attack of opportunity, then the act of aiding another provokes … as well."
    // — a judgement the table itself declines to make for you.
    const aid = actionTrigger("aid-another");
    expect(aid.ok).toBe(false);
    if (!aid.ok) {
      expect(aid.reason).toContain('provokes "maybe"');
      expect(aid.reason).toContain("the caller decides");
    }
  });
});

describe("resolution order and draining", () => {
  const queued = (ids: string[]): PF1eInterruptQueue => {
    let queue = createInterruptQueue(1, "move");
    for (const id of ids) {
      queue = queueAoOs(queue, {
        turn: 1,
        substep: "move",
        provokerId: "goblin",
        actionId: `a-${id}`,
        trigger: { kind: "move-out", left: { x: 0, y: 0 } },
        reactors: [{ id }],
      }).queue;
    }
    return queue;
  };

  test("without initiative the caller's own order stands", () => {
    const queue = queued(["fighter", "rogue", "wizard"]);
    expect(orderInterrupts(queue.interrupts).map((i) => i.reactorId)).toEqual([
      "fighter",
      "rogue",
      "wizard",
    ]);
  });

  test("with initiative, higher initiative first and ties in insertion order", () => {
    const queue = queued(["fighter", "rogue", "wizard"]);
    const initiative: Record<string, number> = {
      fighter: 12,
      rogue: 20,
      wizard: 20,
    };
    expect(
      orderInterrupts(queue.interrupts, {
        initiativeOf: (id) => initiative[id] ?? 0,
      }).map((i) => i.reactorId),
    ).toEqual(["rogue", "wizard", "fighter"]);
  });

  test("resolving pops exactly the returned interrupt, and clearing drops a finished turn", () => {
    const queue = queued(["fighter", "rogue"]);
    const first = resolveNextInterrupt(queue);
    expect(first.interrupt?.reactorId).toBe("fighter");
    expect(first.queue.interrupts.map((i) => i.reactorId)).toEqual(["rogue"]);
    expect(nextInterrupt(first.queue)?.reactorId).toBe("rogue");
    const drained = resolveNextInterrupt(first.queue).queue;
    expect(nextInterrupt(drained)).toBeNull();
    expect(resolveNextInterrupt(drained).interrupt).toBeNull();

    const queue2 = queued(["fighter", "rogue"]);
    expect(clearInterrupts(queue2, 1).interrupts).toEqual([]); // the finished turn is dropped
    expect(clearInterrupts(queue2, 2).interrupts).toHaveLength(2); // another turn's are kept
  });
});

describe("the action trigger carries the square the provoker occupied (D-190)", () => {
  test("a provoking-action interrupt keeps its `at` square, and a ranged-touch states its own kind", () => {
    let queue = createInterruptQueue(1, "action");
    const cast = queueAoOs(queue, {
      turn: 1,
      substep: "action",
      provokerId: "wizard",
      actionId: "cast-spell:1:wizard",
      trigger: { kind: "provoking-action", actionId: "cast-spell", at: { x: 0, y: 0 } },
      reactors: [{ id: "fighter" }],
    });
    queue = cast.queue;
    const touch = queueAoOs(queue, {
      turn: 1,
      substep: "action",
      provokerId: "wizard",
      actionId: "action:1:wizard:ranged-touch",
      trigger: { kind: "ranged-touch", at: { x: 0, y: 0 } },
      reactors: [{ id: "fighter" }],
    });
    // Two distinct actions, so the same reactor appears twice (Combat Reflexes).
    expect(touch.queued).toHaveLength(1);
    expect(touch.queue.interrupts).toHaveLength(2);
    expect(touch.queue.interrupts[0]?.trigger.at).toEqual({ x: 0, y: 0 });
    expect(touch.queue.interrupts[1]?.trigger.kind).toBe("ranged-touch");
    expect(rangedTouchTrigger()).toEqual({ kind: "ranged-touch" });
  });
});
