import { describe, expect, test } from "vitest";
import {
  buildPendingRoll,
  canGMRoll,
  canPlayerRoll,
  isPendingExpired,
  isPlayerOwned,
  pendingPruneOps,
  resolvePendingRoll,
  shouldDeferToPlayer,
} from "../../src/packages/pf1e/pendingRoll";
import {
  playerPendingRollModeOf,
  validateWorldSettingsPatch,
  worldSettingsOps,
  worldSettingsFrom,
} from "../../src/core/worldSettings";

const init = { actorId: "a-init" as const, tokenId: "t-init" as const, name: "Goblin", actionLabel: "Fireball (DC 17)" };
const target = { actorId: "a-tgt" as const, tokenId: "t-tgt" as const, name: "Valeros" };

describe("pendingRoll: build + window", () => {
  test("expiresTurn is turnNumber + 2 and v=1", () => {
    const p = buildPendingRoll({
      kind: "save",
      initiator: init as any,
      target: target as any,
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

  test("expired window: T+2 allowed, T+3 refused", () => {
    const p = buildPendingRoll({ kind: "attack", initiator: init as any, target: target as any, formula: "1d20+7", dc: null, modifiers: [], turnNumber: 5 } as any);
    expect(isPendingExpired(p, 7)).toBe(false);
    expect(isPendingExpired(p, 8)).toBe(true);
    expect(canGMRoll(p, 7)).toBe(true);
    expect(canGMRoll(p, 8)).toBe(false);
    expect(canPlayerRoll(p, 7, "u1" as any)).toBe(true);
    expect(canPlayerRoll(p, 8, "u1" as any)).toBe(false);
  });

  test("resolved never rollable", () => {
    const p = buildPendingRoll({ kind: "save", initiator: init as any, target: target as any, formula: "1d20+5", dc: 17, modifiers: [], turnNumber: 1 } as any);
    const r = resolvePendingRoll(p, { total: 18, seedClient: "c", seedHost: "h" });
    expect(r.resolved).toBe(true);
    expect(r.total).toBe(18);
    expect(canGMRoll(r, 1)).toBe(false);
    expect(canPlayerRoll(r, 1, "u1" as any)).toBe(false);
  });

  test("player owner gating", () => {
    const p = buildPendingRoll({ kind: "attack", initiator: init as any, target: target as any, formula: "1d20+7", dc: null, modifiers: [], turnNumber: 3 } as any);
    expect(canPlayerRoll(p, 3, "u1" as any, ["u1" as any])).toBe(true);
    expect(canPlayerRoll(p, 3, "u2" as any, ["u1" as any])).toBe(false);
    expect(canPlayerRoll(p, 3, "u1" as any, [] as any)).toBe(false);
  });

  test("isPlayerOwned helper", () => {
    expect(isPlayerOwned({ default: 1, "u-player": 3 })).toBe(true);
    expect(isPlayerOwned({ default: 1 })).toBe(false);
    expect(isPlayerOwned({ default: 0, "u-player": 0 })).toBe(false);
    expect(isPlayerOwned(null)).toBe(false);
  });

  test("pendingPruneOps generates ops for expired pending only", () => {
    const a = buildPendingRoll({ kind: "save", initiator: init as any, target: target as any, formula: "1d20+5", dc: 17, modifiers: [], turnNumber: 1 } as any);
    const b = buildPendingRoll({ kind: "attack", initiator: init as any, target: target as any, formula: "1d20+7", dc: null, modifiers: [], turnNumber: 10 } as any);
    const ops = pendingPruneOps(
      [
        { _id: "m1" as any, system: { pendingRoll: a } },
        { _id: "m2" as any, system: { pendingRoll: b } },
        { _id: "m3" as any, system: {} },
      ],
      5,
    );
    // a turn 1 expires 3 -> expired at 5, b turn 10 expires 12 -> not
    expect(ops.length).toBe(1);
    expect((ops[0] as any).ref.id).toBe("m1");
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
    const ws = { playerPendingRollMode: "savesChecksAuto" } as any;
    expect(shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: ws })).toBe(true);
    expect(shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
    expect(shouldDeferToPlayer({ kind: "concentration", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
    expect(shouldDeferToPlayer({ kind: "check", targetIsPlayerOwned: true, worldSettings: ws })).toBe(false);
  });
  test("manual: all kinds pending for player", () => {
    const ws = { playerPendingRollMode: "manual" } as any;
    for (const kind of ["attack", "save", "check", "concentration"] as const) {
      expect(shouldDeferToPlayer({ kind, targetIsPlayerOwned: true, worldSettings: ws })).toBe(true);
    }
  });
  test("default is savesChecksAuto", () => {
    expect(playerPendingRollModeOf({} as any)).toBe("savesChecksAuto");
    expect(shouldDeferToPlayer({ kind: "attack", targetIsPlayerOwned: true, worldSettings: {} })).toBe(true);
    expect(shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: true, worldSettings: {} })).toBe(false);
  });
});

describe("worldSettings: playerPendingRollMode validation", () => {
  test("accepts three strings", () => {
    for (const v of ["auto", "savesChecksAuto", "manual"]) {
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
    expect(ops[0]?.kind).toBe("create");
    const doc = (ops[0] as any).data;
    expect(doc.system.playerPendingRollMode).toBe("manual");
    const merged = worldSettingsFrom([doc]);
    expect(playerPendingRollModeOf(merged)).toBe("manual");
  });
});
