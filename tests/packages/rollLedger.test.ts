import { describe, expect, test } from "vitest";
import {
  buildRollLedger,
  canPlayerReroll,
  canReroll,
  canRevert,
  delegateRerollOps,
  invertLedger,
  playerRerollOps,
  pruneLedgers,
  pruneOpsForWindow,
  rerollOps,
  revertOps,
  type RollLedger,
} from "../../src/packages/pf1e/rollLedger";
import type { Op } from "../../src/core/ops";

const initiator = { actorId: "a-init" as const, tokenId: "t-init" as const, name: "Valeros" };
const target = { actorId: "a-tgt" as const, tokenId: "t-tgt" as const, name: "Goblin" };
const area = { shape: "burst" as const, origin: { x: 100, y: 100 }, radiusFt: 20, affectedTokenIds: ["t-tgt"] as unknown as string[] };

const fakeRoll = {
  kind: "attack" as const,
  formula: "1d20+7",
  total: 18,
  terms: [],
  seedClient: null,
  seedHost: null,
  modifiers: [{ label: "flanking", value: 2, reason: "flanking" }],
};

function makeLedger(over: Partial<RollLedger> = {}): RollLedger {
  return buildRollLedger({
    initiator: initiator as any,
    targets: [target] as any,
    area: null,
    rolls: [fakeRoll as any],
    ledgerOps: [{ kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.attributes.hp.value": 7 } } as unknown as Op],
    ledgerInverses: [{ kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.attributes.hp.value": 12 } } as unknown as Op],
    turnNumber: 1,
    ...over,
  } as any);
}

describe("rollLedger: build + window", () => {
  test("build defaults v=1, turnNumber, reverted false, rerollCount 0", () => {
    const l = makeLedger({ turnNumber: 5 });
    expect(l.v).toBe(1);
    expect(l.turnNumber).toBe(5);
    expect(l.reverted).toBe(false);
    expect(l.rerollCount).toBe(0);
    expect(l.pendingReroll).toBe(null);
    expect(l.rolls).toHaveLength(1);
  });

  test("2-round window: T, T+1, T+2 allowed, T+3 refused", () => {
    const l = makeLedger({ turnNumber: 10 });
    expect(canReroll(l, 10)).toBe(true);
    expect(canReroll(l, 11)).toBe(true);
    expect(canReroll(l, 12)).toBe(true);
    expect(canReroll(l, 13)).toBe(false);
    expect(canReroll(l, 9)).toBe(false); // before
    expect(canRevert(l, 12)).toBe(true);
    expect(canRevert(l, 13)).toBe(false);
  });

  test("reverted never rerollable", () => {
    const l = makeLedger({ turnNumber: 1 });
    const reverted = { ...l, reverted: true } as RollLedger;
    expect(canReroll(reverted, 1)).toBe(false);
    expect(canRevert(reverted, 1)).toBe(false);
  });

  test("canPlayerReroll gates on playerId and window", () => {
    const l = makeLedger({ turnNumber: 5 });
    const delegated = { ...l, pendingReroll: { playerId: "u-alice" as any, expiresTurn: 7 } } as RollLedger;
    expect(canPlayerReroll(delegated, "u-alice" as any, 7)).toBe(true);
    expect(canPlayerReroll(delegated, "u-alice" as any, 8)).toBe(false);
    expect(canPlayerReroll(delegated, "u-bob" as any, 7)).toBe(false);
    expect(canPlayerReroll(l, "u-alice" as any, 7)).toBe(false);
  });

  test("invertLedger prefers ledgerInverses", () => {
    const l = makeLedger();
    const inv = invertLedger(l);
    expect(inv).toEqual(l.ledgerInverses);
    const l2 = buildRollLedger({
      initiator: initiator as any,
      targets: null,
      area: area as any,
      rolls: [fakeRoll as any],
      ledgerOps: [{ kind: "update", ref: { coll: "actors", id: "x" }, diff: { a: 1 } } as any],
      turnNumber: 1,
    } as any);
    const inv2 = invertLedger(l2);
    expect(inv2).toHaveLength(1);
  });
});

describe("rollLedger: ops", () => {
  test("rerollOps: inverse + new + ledger update, gated by window", () => {
    const l = makeLedger({ turnNumber: 1, rerollCount: 0 });
    const newRolls = [{ ...fakeRoll, total: 19 }] as any;
    const newOps: Op[] = [{ kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.attributes.hp.value": 6 } } as any];
    const ops = rerollOps({ messageId: "m1" as any, ledger: l, currentTurn: 2, newLedgerOps: newOps, newRolls });
    expect(ops).not.toBe(null);
    expect(ops!.length).toBe(1 + 1 + 1); // inverse + new + ledger update
    const last = ops![ops!.length - 1] as any;
    expect(last.diff["system.rollLedger"].rerollCount).toBe(1);
    expect(last.diff["system.rollLedger"].rolls[0].total).toBe(19);
    // outside window
    expect(rerollOps({ messageId: "m1" as any, ledger: l, currentTurn: 5, newLedgerOps: newOps, newRolls })).toBe(null);
  });

  test("revertOps: inverse + mark reverted", () => {
    const l = makeLedger({ turnNumber: 1 });
    const ops = revertOps({ messageId: "m1" as any, ledger: l, currentTurn: 2 });
    expect(ops).not.toBe(null);
    expect(ops!.length).toBe(2);
    const last = ops![ops!.length - 1] as any;
    expect(last.diff["system.rollLedger"].reverted).toBe(true);
    expect(revertOps({ messageId: "m1" as any, ledger: l, currentTurn: 10 })).toBe(null);
  });

  test("delegateRerollOps: pendingReroll with expiresTurn +2", () => {
    const l = makeLedger({ turnNumber: 1 });
    const ops = delegateRerollOps({ messageId: "m1" as any, ledger: l, currentTurn: 1, playerId: "u-bob" as any });
    expect(ops).not.toBe(null);
    const diff = (ops![0] as any).diff["system.rollLedger"];
    expect(diff.pendingReroll.playerId).toBe("u-bob");
    expect(diff.pendingReroll.expiresTurn).toBe(3);
    expect(delegateRerollOps({ messageId: "m1" as any, ledger: l, currentTurn: 10, playerId: "u-bob" as any })).toBe(null);
  });

  test("playerRerollOps gated by canPlayerReroll", () => {
    const l = makeLedger({ turnNumber: 5 });
    const delegated = { ...l, pendingReroll: { playerId: "u-alice" as any, expiresTurn: 7 } } as RollLedger;
    const newRolls = [{ ...fakeRoll, total: 20 }] as any;
    const ops = playerRerollOps({ messageId: "m1" as any, ledger: delegated, currentTurn: 7, playerId: "u-alice" as any, newLedgerOps: [], newRolls });
    expect(ops).not.toBe(null);
    expect(playerRerollOps({ messageId: "m1" as any, ledger: delegated, currentTurn: 7, playerId: "u-bob" as any, newLedgerOps: [], newRolls })).toBe(null);
    expect(playerRerollOps({ messageId: "m1" as any, ledger: delegated, currentTurn: 8, playerId: "u-alice" as any, newLedgerOps: [], newRolls })).toBe(null);
  });
});

describe("rollLedger: pruning", () => {
  test("pruneLedgers keeps non-ledger and inside-window", () => {
    const a = makeLedger({ turnNumber: 1 });
    const b = makeLedger({ turnNumber: 2 });
    const kept = pruneLedgers(
      [
        { system: { rollLedger: a } } as any,
        { system: { rollLedger: b } } as any,
        { system: {} } as any,
        { system: undefined } as any,
      ],
      3,
    );
    // both a and b are inside window at 3 (1+2, 2+1), plus two non-ledger
    expect(kept.length).toBe(4);
    const pruned = pruneLedgers([{ system: { rollLedger: a } } as any], 4);
    expect(pruned.length).toBe(0);
  });

  test("pruneOpsForWindow generates updates for expired", () => {
    const a = makeLedger({ turnNumber: 1 });
    const b = makeLedger({ turnNumber: 10 });
    const ops = pruneOpsForWindow(
      [
        { _id: "m1" as any, system: { rollLedger: a } },
        { _id: "m2" as any, system: { rollLedger: b } },
        { _id: "m3" as any, system: {} },
      ],
      4,
    );
    expect(ops.length).toBe(1);
    expect((ops[0] as any).ref.id).toBe("m1");
    expect((ops[0] as any).diff["system.rollLedger"]).toBe(null);
  });

  test("stale-target refusal: ledgerInverses missing still inverts best-effort", () => {
    const l = buildRollLedger({
      initiator: initiator as any,
      targets: [target] as any,
      area: null,
      rolls: [fakeRoll as any],
      ledgerOps: [{ kind: "update", ref: { coll: "actors", id: "gone" }, diff: { hp: 0 } } as any],
      turnNumber: 1,
    } as any);
    const inv = invertLedger(l);
    expect(inv.length).toBe(1);
  });

  test("permission: ledger with no inverses still rerolls (host will validate ownership separately)", () => {
    const l = buildRollLedger({
      initiator: initiator as any,
      targets: [target] as any,
      area: null,
      rolls: [fakeRoll as any],
      ledgerOps: [],
      turnNumber: 1,
    } as any);
    expect(canReroll(l, 1)).toBe(true);
    expect(canRevert(l, 1)).toBe(true);
  });

  test("area ledger retains shape and radius", () => {
    const l = buildRollLedger({
      initiator: initiator as any,
      targets: null,
      area: area as any,
      rolls: [fakeRoll as any],
      ledgerOps: [],
      turnNumber: 2,
    } as any);
    expect(l.area?.shape).toBe("burst");
    expect(l.area?.radiusFt).toBe(20);
    expect(l.targets).toBe(null);
  });
});
