import { describe, expect, test } from "vitest";
import {
  buildPendingRoll,
  canGMRoll,
  canPlayerRoll,
  isPendingExpired,
  isPlayerOwned,
  pendingPruneOps,
  pendingRollsOfSystem,
  resolvePendingRoll,
  shouldDeferToPlayer,
  validatePendingRoll,
  type PendingRollInitiator,
  type PendingRollTarget,
} from "../../src/packages/pf1e/pendingRoll";
import {
  playerPendingRollModeOf,
  validateWorldSettingsPatch,
  worldSettingsOps,
  worldSettingsFrom,
  type CoreWorldSettings,
} from "../../src/core/worldSettings";
import type { UserId } from "../../src/core/ids";
import type { ActionCard } from "../../src/core/action";

const init: PendingRollInitiator = {
  actorId: "a-init",
  tokenId: "t-init",
  name: "Goblin",
  actionLabel: "Fireball (DC 17)",
};
const target: PendingRollTarget = { actorId: "a-tgt", tokenId: "t-tgt", name: "Valeros" };

const u1 = "u1" as UserId;
const u2 = "u2" as UserId;

describe("pendingRoll: build + window", () => {
  test("expiresTurn is turnNumber + 2 and v=1", () => {
    const p = buildPendingRoll({
      kind: "save",
      initiator: init,
      target,
      formula: "1d20+5",
      dc: 17,
      modifiers: [{ label: "Reflex", value: 5, reason: "save" }],
      turnNumber: 10,
    });
    expect(p.v).toBe(1);
    expect(p.turnNumber).toBe(10);
    expect(p.expiresTurn).toBe(12);
    expect(p.resolved).toBe(false);
    expect(p.total).toBe(null);
  });

  test("untrusted pending JSON is exact-key/cardinality checked before readers expose it", () => {
    const valid = buildPendingRoll({ id: "roll-1", actionId: "card-1", targetKey: "target-1",
      kind: "save", initiator: init, target, formula: "1d20+5", dc: 17,
      modifiers: [{ label: "Reflex", value: 5, reason: "save" }], turnNumber: 1 });
    expect(validatePendingRoll(valid)).toMatchObject({ ok: true });
    const extra = { ...valid, executable: "never" };
    expect(validatePendingRoll(extra)).toMatchObject({ ok: false });
    expect(pendingRollsOfSystem({ pendingRoll: extra })).toEqual([]);
    expect(validatePendingRoll({ ...valid, modifiers: Array.from({ length: 33 }, () =>
      ({ label: "x", value: 1, reason: "x" })) })).toMatchObject({ ok: false });
    expect(validatePendingRoll({ ...valid, area: { shape: "burst", origin: { x: 1_000_001, y: 0 },
      radius: 30, units: "ft" } })).toMatchObject({ ok: false });
  });

  test("expired window: T+2 allowed, T+3 refused", () => {
    const p = buildPendingRoll({
      kind: "attack",
      initiator: init,
      target,
      formula: "1d20+7",
      dc: null,
      modifiers: [],
      turnNumber: 5,
    });
    expect(isPendingExpired(p, 7)).toBe(false);
    expect(isPendingExpired(p, 8)).toBe(true);
    expect(canGMRoll(p, 7)).toBe(true);
    expect(canGMRoll(p, 8)).toBe(false);
    expect(canPlayerRoll(p, 7, u1)).toBe(true);
    expect(canPlayerRoll(p, 8, u1)).toBe(false);
  });

  test("resolved never rollable", () => {
    const p = buildPendingRoll({
      kind: "save",
      initiator: init,
      target,
      formula: "1d20+5",
      dc: 17,
      modifiers: [],
      turnNumber: 1,
    });
    const r = resolvePendingRoll(p, { total: 18, seedClient: "c", seedHost: "h" });
    expect(r.resolved).toBe(true);
    expect(r.total).toBe(18);
    expect(canGMRoll(r, 1)).toBe(false);
    expect(canPlayerRoll(r, 1, u1)).toBe(false);
  });

  test("player owner gating", () => {
    const p = buildPendingRoll({
      kind: "attack",
      initiator: init,
      target,
      formula: "1d20+7",
      dc: null,
      modifiers: [],
      turnNumber: 3,
    });
    expect(canPlayerRoll(p, 3, u1, [u1])).toBe(true);
    expect(canPlayerRoll(p, 3, u2, [u1])).toBe(false);
    expect(canPlayerRoll(p, 3, u1, [])).toBe(false);
  });

  test("isPlayerOwned helper", () => {
    expect(isPlayerOwned({ default: 1, "u-player": 3 })).toBe(true);
    expect(isPlayerOwned({ default: 1 })).toBe(false);
    expect(isPlayerOwned({ default: 0, "u-player": 0 })).toBe(false);
    expect(isPlayerOwned(null)).toBe(false);
  });

  test("pendingPruneOps generates ops for expired pending only", () => {
    const a = buildPendingRoll({
      kind: "save",
      initiator: init,
      target,
      formula: "1d20+5",
      dc: 17,
      modifiers: [],
      turnNumber: 1,
    });
    const b = buildPendingRoll({
      kind: "attack",
      initiator: init,
      target,
      formula: "1d20+7",
      dc: null,
      modifiers: [],
      turnNumber: 10,
    });
    const ops = pendingPruneOps(
      [
        { _id: "m1", system: { pendingRoll: a } },
        { _id: "m2", system: { pendingRoll: b } },
        { _id: "m3", system: {} },
      ],
      5,
    );
    // a turn 1 expires 3 -> expired at 5, b turn 10 expires 12 -> not
    expect(ops.length).toBe(1);
    const only = ops[0];
    if (only?.kind !== "update") throw new Error("expected update op");
    expect(only.ref.id).toBe("m1");
  });

  test("pruning an action-linked pending save expires the same target atomically", () => {
    const pending = buildPendingRoll({ id: "roll-target", actionId: "card-1", targetKey: "target",
      kind: "save", saveType: "ref", initiator: init, target, formula: "1d20+5", dc: 17,
      modifiers: [], turnNumber: 1 });
    const action: ActionCard = {
      v: 1, id: "card-1", revision: 0, kind: "cast", label: "Entangle", state: "pending",
      source: { name: "Goblin", actorId: "a-init" },
      targets: [{ key: "target", name: "Valeros", actorId: "a-tgt", state: "pending", outcome: "pending",
        check: { kind: "save", status: "pending", formula: "1d20+5", dc: 17, total: null,
          saveType: "ref", pendingRollId: "roll-target" } }],
      notes: [], createdAt: 10, updatedAt: 10,
    };
    const [op] = pendingPruneOps(
      [{ _id: "card-1", system: { pendingRoll: pending, action } }], 4, 42_000,
    );
    expect(op?.kind).toBe("update");
    if (op?.kind !== "update") return;
    expect(op.diff).toMatchObject({
      "system.pendingRoll": null,
      "system.action": { revision: 1, state: "expired", updatedAt: 42_000, targets: [
        { key: "target", state: "expired", outcome: "expired", check: { status: "expired" } },
      ] },
    });
  });
});

describe("pendingRoll: shouldDeferToPlayer", () => {
  test("strategic never pending", () => {
    expect(
      shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: {}, isStrategic: true }),
    ).toBe(false);
    expect(
      shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: {}, turnMode: "simultaneous" }),
    ).toBe(false);
  });
  test("non-player target never pending", () => {
    expect(
      shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: false, worldSettings: { playerPendingRollMode: "manual" } }),
    ).toBe(false);
  });
  test("auto never pending even for player", () => {
    expect(
      shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: { playerPendingRollMode: "auto" } }),
    ).toBe(false);
    expect(
      shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: { playerPendingRollMode: "auto" } }),
    ).toBe(false);
  });
  test("savesChecksAuto: only attack pending", () => {
    const ws: CoreWorldSettings = { playerPendingRollMode: "savesChecksAuto" };
    expect(shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: ws })).toBe(true);
    expect(shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
    expect(shouldDeferToPlayer({ kind: "concentration", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
    expect(shouldDeferToPlayer({ kind: "check", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
  });
  test("manual: all kinds pending for player", () => {
    const ws: CoreWorldSettings = { playerPendingRollMode: "manual" };
    for (const kind of ["attack", "save", "check", "concentration"] as const) {
      expect(shouldDeferToPlayer({ kind, targetIsPlayerOwned: true, worldSettings: ws })).toBe(true);
    }
  });
  test("default is savesChecksAuto", () => {
    expect(playerPendingRollModeOf({})).toBe("savesChecksAuto");
    expect(shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: {} })).toBe(true);
    expect(shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: {} })).toBe(false);
  });
});

describe("worldSettings: playerPendingRollMode validation", () => {
  test("accepts three strings", () => {
    for (const v of ["auto", "savesChecksAuto", "manual"] as const) {
      const r = validateWorldSettingsPatch({ playerPendingRollMode: v });
      expect(r.ok).toBe(true);
    }
  });
  test("rejects unknown", () => {
    const r = validateWorldSettingsPatch({ playerPendingRollMode: "sometimes" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/playerPendingRollMode/);
  });
  test("worldSettingsOps round-trip", () => {
    const ops = worldSettingsOps([], { playerPendingRollMode: "manual" });
    const first = ops[0];
    expect(first?.kind).toBe("create");
    if (first?.kind !== "create") throw new Error("expected create op");
    const doc = first.data as unknown as { system: CoreWorldSettings & Record<string, unknown> };
    expect(doc.system.playerPendingRollMode).toBe("manual");
    const merged = worldSettingsFrom([doc] as unknown as Parameters<typeof worldSettingsFrom>[0]);
    expect(playerPendingRollModeOf(merged)).toBe("manual");
  });
});
