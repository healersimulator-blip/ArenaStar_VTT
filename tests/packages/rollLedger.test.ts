import { describe, expect, test } from "vitest";
import {
  buildRollLedger,
  canPlayerReroll,
  canReroll,
  canRevert,
  captureLedgerInverses,
  delegateRerollOps,
  invertLedger,
  ledgerStaleReason,
  planDamageDeltaReroll,
  playerRerollOps,
  pruneLedgers,
  pruneOpsForWindow,
  rerollOps,
  revertOps,
  tacticalLedgerTurn,
  type RollLedger,
  type RollLedgerArea,
  type RollLedgerInitiator,
  type RollLedgerRoll,
  type RollLedgerTarget,
} from "../../src/packages/pf1e/rollLedger";
import type { Op } from "../../src/core/ops";
import type { BaseDocument, DocRef } from "../../src/core/documents";
import type { DocReader } from "../../src/core/oplog";
import type { UserId } from "../../src/core/ids";

const initiator: RollLedgerInitiator = { actorId: "a-init", tokenId: "t-init", name: "Valeros" };
const target: RollLedgerTarget = { actorId: "a-tgt", tokenId: "t-tgt", name: "Goblin" };
const area: RollLedgerArea = {
  shape: "burst",
  origin: { x: 100, y: 100 },
  radiusFt: 20,
  affectedTokenIds: ["t-tgt"],
};

const attackRoll: RollLedgerRoll = {
  kind: "attack",
  formula: "1d20+7",
  total: 18,
  terms: [],
  seedClient: null,
  seedHost: null,
  modifiers: [{ label: "flanking", value: 2, reason: "flanking" }],
};

const damageRoll: RollLedgerRoll = {
  kind: "damage",
  formula: "2d6+4",
  total: 11,
  terms: [],
  seedClient: null,
  seedHost: null,
  modifiers: [],
};

const hpWrite: Op = {
  kind: "update",
  ref: { coll: "actors", id: "a-tgt" },
  diff: { "system.pf1e.hp": 7 },
};

const hpPreImage: Op = {
  kind: "update",
  ref: { coll: "actors", id: "a-tgt" },
  diff: { "system.pf1e.hp": 12 },
};

function makeLedger(over: Partial<RollLedger> = {}): RollLedger {
  return {
    ...buildRollLedger({
      initiator,
      targets: [target],
      area: null,
      rolls: [attackRoll, damageRoll],
      ledgerOps: [hpWrite],
      ledgerInverses: [hpPreImage],
      turnNumber: 1,
    }),
    ...over,
  };
}

/** Minimal in-memory DocReader for staleness/inverse tests. */
function readerOf(docs: Record<string, BaseDocument>): DocReader {
  return {
    resolve(ref: DocRef): BaseDocument | undefined {
      return docs[`${ref.coll}:${ref.id}`];
    },
  };
}

function actorDoc(hp: number): BaseDocument {
  return {
    _id: "a-tgt",
    type: "actor",
    name: "Goblin",
    ownership: { default: 0 },
    flags: {},
    system: { pf1e: { hp } },
  } as BaseDocument;
}

describe("rollLedger: build + window", () => {
  test("build defaults v=1, turnNumber, reverted false, rerollCount 0", () => {
    const l = makeLedger({ turnNumber: 5 });
    expect(l.v).toBe(1);
    expect(l.turnNumber).toBe(5);
    expect(l.reverted).toBe(false);
    expect(l.rerollCount).toBe(0);
    expect(l.pendingReroll).toBe(null);
    expect(l.rolls).toHaveLength(2);
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
    const reverted: RollLedger = { ...l, reverted: true };
    expect(canReroll(reverted, 1)).toBe(false);
    expect(canRevert(reverted, 1)).toBe(false);
  });

  test("canPlayerReroll gates on playerId and window", () => {
    const l = makeLedger({ turnNumber: 5 });
    const delegated: RollLedger = {
      ...l,
      pendingReroll: { playerId: "u-alice" as UserId, expiresTurn: 7 },
    };
    expect(canPlayerReroll(delegated, "u-alice" as UserId, 7)).toBe(true);
    expect(canPlayerReroll(delegated, "u-alice" as UserId, 8)).toBe(false);
    expect(canPlayerReroll(delegated, "u-bob" as UserId, 7)).toBe(false);
    expect(canPlayerReroll(l, "u-alice" as UserId, 7)).toBe(false);
  });

  test("tacticalLedgerTurn: highest live round, 0 when no combat", () => {
    expect(tacticalLedgerTurn([])).toBe(0);
    expect(tacticalLedgerTurn([{ round: 3 }, { round: 7 }, { round: 2 }])).toBe(7);
    expect(tacticalLedgerTurn([{ round: 0 }, { round: undefined }, { round: "x" }])).toBe(0);
    expect(tacticalLedgerTurn([{ round: 4.9 }])).toBe(4);
    expect(tacticalLedgerTurn([{ round: Number.NaN }])).toBe(0);
  });
});

describe("rollLedger: inversion + inverse capture (no fake fallback)", () => {
  test("invertLedger returns stored pre-images, null when none captured", () => {
    const l = makeLedger();
    const inv = invertLedger(l);
    expect(inv).not.toBe(null);
    expect(inv).toEqual(l.ledgerInverses);
    const noImages = makeLedger({ ledgerInverses: [] });
    expect(invertLedger(noImages)).toBe(null);
  });

  test("captureLedgerInverses reads pre-values from the store before submit", () => {
    const reader = readerOf({ "actors:a-tgt": actorDoc(12) });
    const inverses = captureLedgerInverses(reader, [hpWrite]);
    expect(inverses).toHaveLength(1);
    expect(inverses[0]).toEqual(hpPreImage);
  });

  test("captureLedgerInverses: create inverts to delete, missing docs yield no inverse", () => {
    const reader = readerOf({});
    const create: Op = {
      kind: "create",
      coll: "actors",
      data: actorDoc(9),
    };
    const inverses = captureLedgerInverses(reader, [create, hpWrite]);
    expect(inverses).toHaveLength(1);
    expect(inverses[0]).toEqual({ kind: "delete", ref: { coll: "actors", id: "a-tgt" } });
  });

  test("rerollOps/revertOps refuse to revert a ledger without pre-images", () => {
    const noImages = makeLedger({ ledgerInverses: [] });
    expect(revertOps({ messageId: "m1", ledger: noImages, currentTurn: 2 })).toBe(null);
    expect(
      rerollOps({
        messageId: "m1",
        ledger: noImages,
        currentTurn: 2,
        newLedgerOps: [hpWrite],
        newRolls: noImages.rolls,
      }),
    ).toBe(null);
    // An effect-free card (a miss) CAN reroll/revert — nothing to restore.
    const empty = makeLedger({ ledgerOps: [], ledgerInverses: [] });
    expect(revertOps({ messageId: "m1", ledger: empty, currentTurn: 2 })).not.toBe(null);
    expect(
      rerollOps({
        messageId: "m1",
        ledger: empty,
        currentTurn: 2,
        newLedgerOps: [],
        newRolls: empty.rolls,
      }),
    ).not.toBe(null);
  });
});

describe("rollLedger: staleness gate", () => {
  test("fresh ledger passes: stored post-value equals current value", () => {
    const reader = readerOf({ "actors:a-tgt": actorDoc(7) });
    expect(ledgerStaleReason(makeLedger(), reader)).toBe(null);
  });

  test("a later unrelated write makes the ledger stale with the named reason", () => {
    const reader = readerOf({ "actors:a-tgt": actorDoc(3) }); // someone healed after the card
    const l = makeLedger();
    expect(ledgerStaleReason(l, reader)).toBe("ledger stale — effects changed since");
  });

  test("deleted target document is a stale refusal", () => {
    const reader = readerOf({});
    expect(ledgerStaleReason(makeLedger(), reader)).toBe(
      "ledger stale — a target document was deleted",
    );
  });

  test("missing pre-images refuse by name even when current values match", () => {
    const reader = readerOf({ "actors:a-tgt": actorDoc(7) });
    const l = makeLedger({ ledgerInverses: [] });
    expect(ledgerStaleReason(l, reader)).toContain("no pre-images");
  });

  test("effect-free ledger (miss card) is never stale", () => {
    const reader = readerOf({});
    const l = makeLedger({ ledgerOps: [], ledgerInverses: [] });
    expect(ledgerStaleReason(l, reader)).toBe(null);
  });
});

describe("rollLedger: damage-delta reroll recompute", () => {
  test("HP write shifts by the damage delta, clamped at 0", () => {
    const l = makeLedger();
    const up = planDamageDeltaReroll({
      ledger: l,
      newRolls: [attackRoll, { ...damageRoll, total: 14 }],
    });
    expect(up.ok).toBe(true);
    if (up.ok)
      expect(up.ops).toEqual([
        { kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.pf1e.hp": 10 } },
      ]);
    const down = planDamageDeltaReroll({
      ledger: l,
      newRolls: [attackRoll, { ...damageRoll, total: 1 }],
    });
    expect(down.ok).toBe(true);
    if (down.ok)
      expect(down.ops).toEqual([
        { kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.pf1e.hp": 0 } },
      ]);
  });

  test("non-HP ledger is refused by name — reroll never fabricates effects", () => {
    const conditionOp: Op = {
      kind: "update",
      ref: { coll: "actors", id: "a-tgt" },
      diff: { "system.pf1e.conditions": ["prone"] },
    };
    const l = makeLedger({ ledgerOps: [conditionOp], ledgerInverses: [] });
    const plan = planDamageDeltaReroll({
      ledger: l,
      newRolls: [attackRoll, { ...damageRoll, total: 9 }],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("more than HP");
  });

  test("ammo-style attacker write is a named refusal too", () => {
    const ammoOp: Op = {
      kind: "update",
      ref: { coll: "actors", id: "a-init" },
      diff: { "system.pf1e.attacks.0.firearm.loaded": 4 },
    };
    const l = makeLedger({ ledgerOps: [ammoOp], ledgerInverses: [] });
    expect(planDamageDeltaReroll({ ledger: l, newRolls: l.rolls }).ok).toBe(false);
  });

  test("effect-free card reroll recomputes nothing and is allowed", () => {
    const l = makeLedger({ ledgerOps: [], ledgerInverses: [] });
    const plan = planDamageDeltaReroll({
      ledger: l,
      newRolls: [{ ...attackRoll, total: 9 }, damageRoll],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.ops).toEqual([]);
  });

  test("non-numeric HP post-value refuses", () => {
    const badOp: Op = {
      kind: "update",
      ref: { coll: "actors", id: "a-tgt" },
      diff: { "system.pf1e.hp": "dead" },
    };
    const l = makeLedger({ ledgerOps: [badOp], ledgerInverses: [] });
    const plan = planDamageDeltaReroll({ ledger: l, newRolls: l.rolls });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("ledger HP write is not numeric");
  });
});

describe("rollLedger: ops", () => {
  test("rerollOps: inverse + new + ledger update, gated by window", () => {
    const l = makeLedger({ turnNumber: 1, rerollCount: 0 });
    const newRolls: RollLedgerRoll[] = [attackRoll, { ...damageRoll, total: 13 }];
    const newOps: Op[] = [
      { kind: "update", ref: { coll: "actors", id: "a-tgt" }, diff: { "system.pf1e.hp": 9 } },
    ];
    const ops = rerollOps({
      messageId: "m1",
      ledger: l,
      currentTurn: 2,
      newLedgerOps: newOps,
      newRolls,
    });
    expect(ops).not.toBe(null);
    expect(ops).not.toBe(null);
    if (ops === null) return;
    expect(ops.length).toBe(1 + 1 + 1); // inverse + new + ledger update
    const last = ops[ops.length - 1];
    if (last?.kind !== "update") throw new Error("ledger update op expected last");
    const updated = last.diff["system.rollLedger"] as unknown as RollLedger;
    expect(updated.rerollCount).toBe(1);
    expect(updated.rolls[1]?.total).toBe(13);
    expect(updated.pendingReroll).toBe(null);
    // outside window
    expect(
      rerollOps({ messageId: "m1", ledger: l, currentTurn: 5, newLedgerOps: newOps, newRolls }),
    ).toBe(null);
  });

  test("revertOps: inverse + mark reverted", () => {
    const l = makeLedger({ turnNumber: 1 });
    const ops = revertOps({ messageId: "m1", ledger: l, currentTurn: 2 });
    expect(ops).not.toBe(null);
    if (ops === null) return;
    expect(ops.length).toBe(2);
    const last = ops[ops.length - 1];
    if (last?.kind !== "update") throw new Error("ledger update op expected last");
    const updated = last.diff["system.rollLedger"] as unknown as RollLedger;
    expect(updated.reverted).toBe(true);
    expect(revertOps({ messageId: "m1", ledger: l, currentTurn: 10 })).toBe(null);
  });

  test("delegateRerollOps: pendingReroll with expiresTurn +2", () => {
    const l = makeLedger({ turnNumber: 1 });
    const ops = delegateRerollOps({
      messageId: "m1",
      ledger: l,
      currentTurn: 1,
      playerId: "u-bob" as UserId,
    });
    expect(ops).not.toBe(null);
    if (ops === null) return;
    const first = ops[0];
    if (first?.kind !== "update") throw new Error("expected update op");
    const updated = first.diff["system.rollLedger"] as unknown as RollLedger;
    expect(updated.pendingReroll?.playerId).toBe("u-bob");
    expect(updated.pendingReroll?.expiresTurn).toBe(3);
    expect(
      delegateRerollOps({ messageId: "m1", ledger: l, currentTurn: 10, playerId: "u-bob" as UserId }),
    ).toBe(null);
  });

  test("playerRerollOps gated by canPlayerReroll", () => {
    const l = makeLedger({ turnNumber: 5 });
    const delegated: RollLedger = {
      ...l,
      pendingReroll: { playerId: "u-alice" as UserId, expiresTurn: 7 },
    };
    const newRolls: RollLedgerRoll[] = [attackRoll, { ...damageRoll, total: 12 }];
    const ops = playerRerollOps({
      messageId: "m1",
      ledger: delegated,
      currentTurn: 7,
      playerId: "u-alice" as UserId,
      newLedgerOps: [],
      newRolls,
    });
    expect(ops).not.toBe(null);
    expect(
      playerRerollOps({
        messageId: "m1",
        ledger: delegated,
        currentTurn: 7,
        playerId: "u-bob" as UserId,
        newLedgerOps: [],
        newRolls,
      }),
    ).toBe(null);
    expect(
      playerRerollOps({
        messageId: "m1",
        ledger: delegated,
        currentTurn: 8,
        playerId: "u-alice" as UserId,
        newLedgerOps: [],
        newRolls,
      }),
    ).toBe(null);
  });
});

describe("rollLedger: pruning", () => {
  test("pruneLedgers keeps non-ledger and inside-window", () => {
    const a = makeLedger({ turnNumber: 1 });
    const b = makeLedger({ turnNumber: 2 });
    const kept = pruneLedgers(
      [
        { system: { rollLedger: a } },
        { system: { rollLedger: b } },
        { system: {} },
        {},
      ],
      3,
    );
    // both a and b are inside window at 3 (1+2, 2+1), plus two non-ledger
    expect(kept.length).toBe(4);
    const pruned = pruneLedgers([{ system: { rollLedger: a } }], 4);
    expect(pruned.length).toBe(0);
  });

  test("pruneOpsForWindow generates updates for expired", () => {
    const a = makeLedger({ turnNumber: 1 });
    const b = makeLedger({ turnNumber: 10 });
    const ops = pruneOpsForWindow(
      [
        { _id: "m1", system: { rollLedger: a } },
        { _id: "m2", system: { rollLedger: b } },
        { _id: "m3", system: {} },
      ],
      4,
    );
    expect(ops.length).toBe(1);
    const only = ops[0];
    if (only?.kind !== "update") throw new Error("expected update op");
    expect(only.ref.id).toBe("m1");
    expect(only.diff["system.rollLedger"]).toBe(null);
  });

  test("area ledger retains shape and radius", () => {
    const l = buildRollLedger({
      initiator,
      targets: null,
      area,
      rolls: [attackRoll],
      ledgerOps: [],
      turnNumber: 2,
    });
    expect(l.area?.shape).toBe("burst");
    expect(l.area?.radiusFt).toBe(20);
    expect(l.targets).toBe(null);
  });
});
