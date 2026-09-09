import { describe, expect, test } from "vitest";
import {
  EMPTY_ACTION_LEDGER,
  NON_SPLITTABLE_FULL_ROUND,
  PF1E_ACTIONS,
  actionRefusal,
  pf1eActionById,
  readActionLedger,
  spendAction,
  startOfTurnLedger,
  type PF1eActionLedger,
} from "../../src/packages/pf1e/actions";

/**
 * The action economy per CRB p.181 (Action Types) and Table 7-2 (CRB p.182, verified
 * against AoN Rules ID 128 for D-131): a normal round = standard + move OR one
 * full-round action, plus one swift and free actions; a move may always substitute for
 * the standard; restricted activity (surprise/staggered/slowed) = a single standard OR
 * move, plus free and swift actions, no full-round, but start/complete with a standard
 * action is allowed (CRB p.185); an off-turn immediate action consumes the next turn's
 * swift action; any movement blocks the 5-foot step and vice versa (CRB p.189).
 */
/** Narrow a successful spend; a refused one fails the test with its reason. */
function spent<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("action budget (CRB p.181, T05)", () => {
  test("a normal round is standard + move, or full-round, plus one swift", () => {
    let ledger = { ...EMPTY_ACTION_LEDGER };
    ledger = spent(spendAction(ledger, { kind: "standard" }));
    const move = spent(spendAction(ledger, { kind: "move" }));
    expect(actionRefusal(move, { kind: "standard" })).toContain(
      "standard action already spent",
    );
    expect(actionRefusal(move, { kind: "full-round" })).toContain(
      "needs both the standard and the move action",
    );
    expect(actionRefusal(move, { kind: "swift" })).toBeNull(); // swift is separate
    expect(move.swiftUsed).toBe(false);
  });

  test("a move may substitute for the standard (two moves), but never two standards", () => {
    const twoMoves = spent(
      spendAction(
        spent(spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "move" })),
        { kind: "move", asStandard: true },
      ),
    );
    expect(twoMoves.moveUsed && twoMoves.standardUsed).toBe(true);
    const refused = actionRefusal(twoMoves, { kind: "move" });
    expect(refused).toContain("move action already spent");
    const twoStandards = actionRefusal(
      spent(spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "standard" })),
      { kind: "standard" },
    );
    expect(twoStandards).toContain("standard action already spent");
  });

  test("a full-round action consumes both slots and cannot be taken while one is spent", () => {
    const full = spent(
      spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "full-round" }),
    );
    expect(full.standardUsed && full.moveUsed).toBe(true);
    const afterStd = spent(
      spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "standard" }),
    );
    expect(actionRefusal(afterStd, { kind: "full-round" })).toContain(
      "needs both the standard and the move action",
    );
  });

  test("restricted activity: a single standard OR move, swift still legal, no full-round", () => {
    const restricted: PF1eActionLedger = {
      ...EMPTY_ACTION_LEDGER,
      restriction: "single-standard-or-move",
    };
    const std = spent(spendAction(restricted, { kind: "standard" }));
    expect(std.moveUsed).toBe(true); // the restriction allows exactly one of the two
    expect(actionRefusal(std, { kind: "move" })).toContain(
      "restricted activity",
    );
    expect(actionRefusal(std, { kind: "swift" })).toBeNull();
    expect(actionRefusal(restricted, { kind: "full-round" })).toContain(
      "restricted activity: no full-round action",
    );
    const moveFirst = spent(spendAction(restricted, { kind: "move" }));
    expect(actionRefusal(moveFirst, { kind: "standard" })).toContain(
      "restricted activity",
    );
  });

  test("one swift per turn; an immediate action on your turn is that swift", () => {
    const swift = spent(
      spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "swift" }),
    );
    expect(actionRefusal(swift, { kind: "swift" })).toContain(
      "swift action already used",
    );
    const viaImmediate = spent(
      spendAction(
        { ...EMPTY_ACTION_LEDGER },
        { kind: "immediate", onTurn: true },
      ),
    );
    expect(viaImmediate.swiftUsed).toBe(true);
    expect(actionRefusal(viaImmediate, { kind: "swift" })).toContain(
      "swift action already used",
    );
  });

  test("an off-turn immediate action consumes the NEXT turn's swift action (CRB p.183)", () => {
    const offTurn = spent(
      spendAction(
        { ...EMPTY_ACTION_LEDGER },
        { kind: "immediate", onTurn: false },
      ),
    );
    expect(offTurn.swiftReserved).toBe(true);
    expect(
      actionRefusal(offTurn, { kind: "immediate", onTurn: false }),
    ).toContain("another immediate action is already pending");
    // The next turn starts: the reservation converts into "swift already used" and
    // clears, so the turn after that gets a fresh swift.
    const nextTurn = startOfTurnLedger(offTurn);
    expect(nextTurn.swiftUsed).toBe(true);
    expect(nextTurn.swiftReserved).toBe(false);
    expect(actionRefusal(nextTurn, { kind: "swift" })).toContain(
      "swift action already used this turn",
    );
    expect(
      actionRefusal(startOfTurnLedger(nextTurn), { kind: "swift" }),
    ).toBeNull();
  });

  test("the 5-foot step and movement lock each other out (CRB p.189)", () => {
    const stepped = spent(
      spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "five-foot-step" }),
    );
    expect(actionRefusal(stepped, { kind: "five-foot-step" })).toContain(
      "5-foot step already taken",
    );
    expect(actionRefusal(stepped, { kind: "movement", feet: 30 })).toContain(
      "you already took a 5-foot step",
    );
    const moved = spent(
      spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "movement", feet: 30 }),
    );
    expect(actionRefusal(moved, { kind: "five-foot-step" })).toContain(
      "any other movement this round blocks the 5-foot step",
    );
    expect(actionRefusal(moved, { kind: "movement", feet: 0 })).toContain(
      "must be a positive number",
    );
  });

  test("start/complete full-round action (CRB p.185), with the non-splittable list", () => {
    expect(NON_SPLITTABLE_FULL_ROUND).toEqual([
      "full-attack",
      "charge",
      "run",
      "withdraw",
    ]);
    expect(
      actionRefusal(
        { ...EMPTY_ACTION_LEDGER },
        { kind: "start-full-round", action: "charge" },
      ),
    ).toContain("charge cannot be split across two rounds");
    const started = spent(
      spendAction(
        { ...EMPTY_ACTION_LEDGER },
        { kind: "start-full-round", action: "cast-spell" },
      ),
    );
    expect(started.fullRoundPending).toBe("cast-spell");
    expect(started.standardUsed).toBe(true);
    expect(actionRefusal(started, { kind: "full-round" })).toContain(
      "already started — complete it",
    );
    // The starting standard is spent: completion happens NEXT round (CRB p.185).
    expect(actionRefusal(started, { kind: "complete-full-round" })).toContain(
      "standard action already spent",
    );
    const nextRound = startOfTurnLedger(started);
    expect(nextRound.fullRoundPending).toBe("cast-spell"); // survives to be completed
    const completed = spent(
      spendAction(nextRound, { kind: "complete-full-round" }),
    );
    expect(completed.fullRoundPending).toBeNull();
    expect(completed.standardUsed).toBe(true);
    expect(
      actionRefusal(
        { ...EMPTY_ACTION_LEDGER },
        { kind: "complete-full-round" },
      ),
    ).toContain("no full-round action is pending");
    // CRB p.181: restricted activity may still start or complete a full-round action.
    const restrictedStart = spent(
      spendAction(
        { ...EMPTY_ACTION_LEDGER, restriction: "single-standard-or-move" },
        { kind: "start-full-round", action: "cast-spell" },
      ),
    );
    // One standard per turn even while restricted: completing waits for next round.
    expect(
      actionRefusal(restrictedStart, { kind: "complete-full-round" }),
    ).toContain("restricted activity");
    // A pending full-round action CAN be completed while restricted (CRB p.181).
    expect(
      actionRefusal(
        {
          ...EMPTY_ACTION_LEDGER,
          restriction: "single-standard-or-move",
          fullRoundPending: "cast-spell",
        },
        { kind: "complete-full-round" },
      ),
    ).toBeNull();
  });

  test("free actions are unlimited and garbage flags degrade per field", () => {
    for (let i = 0; i < 3; i++) {
      const next = spendAction({ ...EMPTY_ACTION_LEDGER }, { kind: "free" });
      expect(next.ok).toBe(true);
    }
    expect(readActionLedger(null)).toEqual(EMPTY_ACTION_LEDGER);
    expect(readActionLedger("nope")).toEqual(EMPTY_ACTION_LEDGER);
    expect(
      readActionLedger({
        standardUsed: "yes",
        movementFt: -5,
        fullRoundPending: 7,
        restriction: "staggered",
        swiftReserved: true,
      }),
    ).toEqual({ ...EMPTY_ACTION_LEDGER, swiftReserved: true });
  });
});

describe("the verified action/provoke table (Table 7-2, CRB p.182)", () => {
  test("the rows the R02/T05 repairs hinged on read exactly as the source table", () => {
    expect(pf1eActionById("run")?.provokes).toBe("yes"); // was transcribed "no"
    expect(pf1eActionById("mount-dismount")?.provokes).toBe("no"); // was transcribed "yes"
    expect(pf1eActionById("attack-melee")?.provokes).toBe("no");
    expect(pf1eActionById("attack-ranged")?.provokes).toBe("yes");
    expect(pf1eActionById("attack-unarmed")?.provokes).toBe("yes");
    expect(pf1eActionById("charge")?.category).toBe("full-round");
    expect(pf1eActionById("charge")?.provokes).toBe("no");
    expect(pf1eActionById("charge")?.note).toContain("standard action");
    expect(pf1eActionById("withdraw")?.note).toContain(
      "first 5 ft never provoke",
    );
    expect(pf1eActionById("five-foot-step")?.category).toBe("no-action");
    expect(pf1eActionById("cast-spell")?.provokes).toBe("yes");
    expect(pf1eActionById("drink-potion")?.provokes).toBe("yes");
    expect(pf1eActionById("total-defense")?.provokes).toBe("no");
    expect(pf1eActionById("combat-maneuver")?.provokes).toBe("yes");
    expect(pf1eActionById("combat-maneuver")?.category).toBe("varies");
    expect(pf1eActionById("use-feat")?.provokes).toBe("varies");
    expect(pf1eActionById("cast-quickened")?.category).toBe("swift");
    expect(pf1eActionById("cast-quickened")?.provokes).toBe("no");
    expect(pf1eActionById("delay")?.category).toBe("no-action");
  });

  test("every id is unique and unknown ids miss", () => {
    const ids = PF1E_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pf1eActionById("nonexistent")).toBeNull();
    // invented rows from the old transcription must not have leaked back in
    for (const gone of ["snipe", "remove-curse", "draw-weapon-and-move"])
      expect(ids).not.toContain(gone);
  });
});
