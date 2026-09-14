/**
 * M07 (D-229) — hero-authored stats are the authoritative strategic combat inputs:
 * the leader ActorDocument's tactical derivation feeds the sim's `unit.stats` on
 * advance, and the resolve envelope persists the same keys back into the Unit
 * document as part of the atomic turn commit (G §4.12).
 */
import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/core/store";
import type { HostSync } from "../../src/host/sync";
import { TurnChannel } from "../../src/host/turnChannel";
import type { SimBridge } from "../../src/host/simBridge";
import type { ArmyDocument, UnitDocument } from "../../src/core/strategic";
import {
  combatStatsFromLeaderActor,
  LEADER_STAT_OVERLAY_KEYS,
} from "../../src/packages/massBattlePf1e";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";

const heroSystem: Record<string, unknown> = {
  pf1e: {
    size: "Medium",
    baseAttack: 6,
    abilities: { str: 18, dex: 16, con: 16, int: 10, wis: 12, cha: 10 },
    armorClass: { armor: 5, shield: 2, natural: 1, dodge: 0, misc: 0 },
    saves: { fort: 5, ref: 2, will: 2 },
    initiative: 0,
    hpMax: 58,
    hp: 58,
    dr: 5,
    spellResistance: 21,
    landSpeedFt: 30,
    attacks: [{ name: "longsword", damageDice: "1d8", twoHanded: false }],
  },
};

describe("combatStatsFromLeaderActor (M07/D-229)", () => {
  it("maps every strategic stat key from one tactical derivation", () => {
    const d = deriveFromDocuments({ actor: { system: heroSystem } });
    const extracted = combatStatsFromLeaderActor({ system: heroSystem });
    if (extracted === null) throw new Error("overlay unexpectedly null");
    const overlay = extracted;
    expect(overlay.hp).toBe(d.hpMax);
    expect(overlay.move).toBe(d.speedFt);
    expect(overlay.touchAc).toBe(d.ac.touch);
    expect(overlay.drVal).toBe(d.dr);
    expect(overlay.sr).toBe(d.spellResistance);
    expect(overlay.fort).toBe(d.saves.fort);
    expect(overlay.ref).toBe(d.saves.ref);
    expect(overlay.will).toBe(d.saves.will);
    expect(overlay.bab).toBe(d.baseAttack);
    expect(overlay.strMod).toBe(d.abilityMods.str);
    expect(overlay.dexMod).toBe(d.abilityMods.dex);
    // The work plan's derive table: BAB 6 + Str 18 ⇒ melee attack bonus 10/5.
    expect((d.iterativeAttacks[0] ?? 0) + d.abilityMods.str).toBe(overlay.bab + overlay.strMod);
    // Every exported write key is a number the unit stats accept.
    for (const k of LEADER_STAT_OVERLAY_KEYS) {
      expect(Number.isFinite(overlay[k])).toBe(true);
    }
  });

  it("returns null for missing or unparseable documents (caller keeps unit stats)", () => {
    expect(combatStatsFromLeaderActor(null)).toBeNull();
    expect(combatStatsFromLeaderActor("")).toBeNull();
    expect(combatStatsFromLeaderActor({ system: 42 })).toBeNull();
  });
});

describe("advance/write-back (M07/D-229)", () => {
  it("feeds hero stats into the sim and persists them in the resolve envelope", async () => {
    const store = new DocumentStore({
      meta: {
        worldId: "world-hero",
        name: "Hero World",
        system: "pf1e",
        systemVersion: "1.0.0",
      },
    });
    const sceneId = "scene-1";
    const tokenId = "token-hero-1";
    const actorId = "actor-hero-1";
    const ledUnit = "unit-led";
    const plainUnit = "unit-plain";
    const armyId = "army-1";

    store.applyEnvelope({
      txId: "tx1",
      seq: 1,
      by: "gm",
      ts: 0,
      ops: [
        {
          kind: "create",
          coll: "scenes",
          data: {
            _id: sceneId,
            type: "scene",
            name: "Main Scene",
            ownership: { default: 3 },
            flags: {},
            system: {},
            active: true,
            img: null,
            width: 2000,
            height: 2000,
            darkness: 0,
            grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
            tokens: [
              {
                _id: tokenId,
                type: "token",
                name: "Sera Half-Blood, VC",
                ownership: { default: 3 },
                flags: {},
                system: {},
                x: 0,
                y: 0,
                rotation: 0,
                width: 100,
                height: 100,
                img: "",
                hidden: false,
                disposition: "neutral",
                vision: true,
                light: { radius: 0, color: "#ffffff", alpha: 0.5 },
                actorId,
              },
            ],
            walls: [],
            lights: [],
            sounds: [],
            tiles: [],
            drawings: [],
            templates: [],
            notes: [],
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
        {
          kind: "create",
          coll: "actors",
          data: {
            _id: actorId,
            type: "character",
            name: "Sera Half-Blood, VC",
            ownership: { default: 3 },
            flags: {},
            system: heroSystem,
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
        {
          kind: "create",
          coll: "factions",
          data: {
            _id: "f1",
            name: "Red",
            ownership: { default: 3 },
            flags: {},
            system: {},
            type: "faction",
            color: "#ff0000",
            allies: [],
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
      ],
    });

    const mkUnit = (_id: string, leaderTokenId: string | null): UnitDocument => ({
      _id,
      type: "infantry",
      name: _id,
      ownership: { default: 3 },
      flags: {},
      system: {},
      profile: {},
      formation: "line",
      sceneId,
      modelRange: [0, 10],
      orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
      stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
      ...(leaderTokenId !== null ? { leaderTokenId } : {}),
    });
    const army: ArmyDocument = {
      _id: armyId,
      type: "army",
      name: "Army 1",
      ownership: { default: 3 },
      flags: {},
      system: {},
      factionId: "f1",
      commander: [],
      supply: {},
      units: [mkUnit(ledUnit, tokenId), mkUnit(plainUnit, null)],
    };
    store.applyEnvelope({
      txId: "tx2",
      seq: 2,
      by: "gm",
      ts: 0,
      ops: [{ kind: "create", coll: "armies", data: army }],
    });

    let refreshedUnits: Array<{ id: string; stats: Record<string, number> }> = [];
    const mockBridge = {
      worldId: "w1",
      db: {} as unknown,
      started: true,
      start: async () => 0,
      refresh: (_ctx: unknown, units: Array<{ id: string; stats: Record<string, number> }>) => {
        refreshedUnits = units;
      },
      resolveTurn: async () => ({
        toVersion: 1,
        fromVersion: 0,
        freezeBytes: new Uint8Array([1]),
        freezeMaxHpMax: 1,
        freezeHash: "h",
        deltaBytes: new Uint8Array([1]),
        deltaMaxHpMax: 1,
        report: { rulesVersion: "t", subPhases: [], events: [] },
        unitStatDiffs: {},
        rangeDiffs: [],
      }),
      snapshotBytes: async () => ({ bytes: new Uint8Array([1]), maxHpMax: 1, version: 1 }),
      unitAnchors: async () => [] as Array<[string, number, number]>,
      detections: async () => new Map<string, number>(),
      poolVersion: 1,
      freezeBytes: async () => null,
    } as unknown as SimBridge;

    const mockHost = {
      attachSim: () => {},
      commitSystem: (ops: import("../../src/core/ops").Op[]) => {
        store.applyEnvelope({ txId: "sys-tx", seq: store.seq + 1, by: "sys", ts: 0, ops });
        return { ok: true, seq: store.seq, inverse: [] };
      },
      sessionUsers: () => [],
      broadcastSim: () => {},
    } as unknown as HostSync;

    const channel = new TurnChannel({
      host: mockHost,
      store,
      bridge: mockBridge,
      sceneId,
      sys: {},
      seed: 12345,
    });

    await channel.start("stepwise");
    const gm = { id: "gm", role: "GM", name: "GM" } as unknown as import("../../src/host/sync").SessionUser;
    channel.handleSimControl(gm, { kind: "sim.control", action: "advance" } as unknown as import("../../src/core/messages").SimControlMsg);
    // advance() is fire-and-forget; the mock bridge resolves immediately.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const expectedExtract = combatStatsFromLeaderActor({ system: heroSystem });
    if (expectedExtract === null) throw new Error("overlay unexpectedly null");
    const expected = expectedExtract;

    // 1. The sim feed carried the hero-authored inputs on the leader-bound unit…
    if (refreshedUnits.length === 0) throw new Error("bridge.refresh never ran");
    const feedUnits = refreshedUnits;
    const ledFeedFound = feedUnits.find((u) => u.id === ledUnit);
    if (!ledFeedFound) throw new Error("led unit missing from refresh");
    const ledFeed = ledFeedFound;
    expect(ledFeed.stats.hp).toBe(expected.hp);
    expect(ledFeed.stats.touchAc).toBe(expected.touchAc);
    expect(ledFeed.stats.sr).toBe(expected.sr);
    expect(ledFeed.stats.drVal).toBe(expected.drVal);
    expect(ledFeed.stats.fort).toBe(expected.fort);
    expect(ledFeed.stats.ref).toBe(expected.ref);
    expect(ledFeed.stats.will).toBe(expected.will);
    expect(ledFeed.stats.bab).toBe(expected.bab);
    expect(ledFeed.stats.strMod).toBe(expected.strMod);
    expect(ledFeed.stats.dexMod).toBe(expected.dexMod);
    expect(ledFeed.stats.move).toBe(expected.move);
    // …which remain inclusive with the persistent strategic counters.
    expect(ledFeed.stats.strength).toBe(10);

    // 2. An unbound unit rides its document stats untouched.
    const plainFeedFound = feedUnits.find((u) => u.id === plainUnit);
    if (!plainFeedFound) throw new Error("plain unit missing from refresh");
    const plainFeed = plainFeedFound;
    expect(plainFeed.stats.hp).toBeUndefined();

    // 3. The resolve envelope persisted the overlay into the Unit document.
    const armyAfter = store.get("armies", armyId) as unknown as ArmyDocument;
    const ledDocFound = armyAfter.units.find((u) => u._id === ledUnit);
    if (!ledDocFound) throw new Error("led unit missing from doc");
    const ledDoc = ledDocFound;
    for (const k of LEADER_STAT_OVERLAY_KEYS) {
      expect(ledDoc.stats[k], `doc stats.${k}`).toBe(expected[k]);
    }
    const plainDocFound = armyAfter.units.find((u) => u._id === plainUnit);
    if (!plainDocFound) throw new Error("plain unit missing from doc");
    const plainDoc = plainDocFound;
    expect(plainDoc.stats.hp).toBeUndefined();
  });
});

describe("movement-during-turn reconciliation (M08/D-229)", () => {
  it("a token move landing mid-resolution deterministically loses to the unit anchor", async () => {
    const store = new DocumentStore({
      meta: {
        worldId: "world-race",
        name: "Race World",
        system: "pf1e",
        systemVersion: "1.0.0",
      },
    });
    const sceneId = "scene-1";
    const tokenId = "token-hero-1";
    const unitId = "unit-1";
    const armyId = "army-1";

    store.applyEnvelope({
      txId: "tx1",
      seq: 1,
      by: "gm",
      ts: 0,
      ops: [
        {
          kind: "create",
          coll: "scenes",
          data: {
            _id: sceneId,
            type: "scene",
            name: "Main Scene",
            ownership: { default: 3 },
            flags: {},
            system: {},
            active: true,
            img: null,
            width: 2000,
            height: 2000,
            darkness: 0,
            grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
            tokens: [
              {
                _id: tokenId,
                type: "token",
                name: "Hero Leader",
                ownership: { default: 3 },
                flags: {},
                system: {},
                x: 0,
                y: 0,
                rotation: 0,
                width: 100,
                height: 100,
                img: "",
                hidden: false,
                disposition: "neutral",
                vision: true,
                light: { radius: 0, color: "#ffffff", alpha: 0.5 },
              },
            ],
            walls: [],
            lights: [],
            sounds: [],
            tiles: [],
            drawings: [],
            templates: [],
            notes: [],
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
        {
          kind: "create",
          coll: "factions",
          data: {
            _id: "f1",
            name: "Red",
            ownership: { default: 3 },
            flags: {},
            system: {},
            type: "faction",
            color: "#ff0000",
            allies: [],
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
      ],
    });
    const unit: UnitDocument = {
      _id: unitId,
      type: "infantry",
      name: "Vanguard",
      ownership: { default: 3 },
      flags: {},
      system: {},
      profile: {},
      formation: "line",
      sceneId,
      modelRange: [0, 10],
      orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
      stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
      leaderTokenId: tokenId,
    };
    const army: ArmyDocument = {
      _id: armyId,
      type: "army",
      name: "Army 1",
      ownership: { default: 3 },
      flags: {},
      system: {},
      factionId: "f1",
      commander: [],
      supply: {},
      units: [unit],
    };
    store.applyEnvelope({
      txId: "tx2",
      seq: 2,
      by: "gm",
      ts: 0,
      ops: [{ kind: "create", coll: "armies", data: army }],
    });

    let resolveGate: (() => void) | null = null;
    const mockBridge = {
      worldId: "w1",
      db: {} as unknown,
      started: true,
      start: async () => 0,
      refresh: () => {},
      resolveTurn: () =>
        new Promise((resolve) => {
          resolveGate = () =>
            resolve({
              toVersion: 1,
              fromVersion: 0,
              freezeBytes: new Uint8Array([1]),
              freezeMaxHpMax: 1,
              freezeHash: "h",
              deltaBytes: new Uint8Array([1]),
              deltaMaxHpMax: 1,
              report: { rulesVersion: "t", subPhases: [], events: [] },
              unitStatDiffs: {},
              rangeDiffs: [],
            });
        }),
      snapshotBytes: async () => ({ bytes: new Uint8Array([1]), maxHpMax: 1, version: 1 }),
      unitAnchors: async () => [[unitId, 150, 250]] as Array<[string, number, number]>,
      detections: async () => new Map<string, number>(),
      poolVersion: 1,
      freezeBytes: async () => null,
    } as unknown as SimBridge;
    const mockHost = {
      attachSim: () => {},
      commitSystem: (ops: import("../../src/core/ops").Op[]) => {
        store.applyEnvelope({ txId: "sys-tx", seq: store.seq + 1, by: "sys", ts: 0, ops });
        return { ok: true, seq: store.seq, inverse: [] };
      },
      sessionUsers: () => [],
      broadcastSim: () => {},
    } as unknown as HostSync;

    const channel = new TurnChannel({
      host: mockHost,
      store,
      bridge: mockBridge,
      sceneId,
      sys: {},
      seed: 12345,
    });
    await channel.start("stepwise");
    const gm = {
      id: "gm",
      role: "GM",
      name: "GM",
    } as unknown as import("../../src/host/sync").SessionUser;
    channel.handleSimControl(gm, {
      kind: "sim.control",
      action: "advance",
    } as unknown as import("../../src/core/messages").SimControlMsg);
    await Promise.resolve();

    // The player moves the hero token DURING resolution (allowed: the lock binds
    // unit orders only).
    store.applyEnvelope({
      txId: "tx-player-move",
      seq: store.seq + 1,
      by: "player",
      ts: 0,
      ops: [
        {
          kind: "update",
          ref: { coll: "tokens", id: tokenId, parent: { coll: "scenes", id: sceneId } },
          diff: { x: 900, y: 900 },
        },
      ],
    });

    if (resolveGate === null) throw new Error("resolve never called");
    (resolveGate as unknown as () => void)();
    for (let i = 0; i < 30; i++) await Promise.resolve();

    const scene = store.get("scenes", sceneId) as unknown as {
      tokens?: Array<{ _id: string; x: number; y: number }>;
    };
    const token = scene.tokens?.find((t) => t._id === tokenId);
    // sim-wins policy: the mid-turn move is overwritten by the unit anchor.
    expect(token?.x).toBe(150);
    expect(token?.y).toBe(250);
  });
});
