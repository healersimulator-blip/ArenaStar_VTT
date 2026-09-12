import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/core/store";
import type { HostSync } from "../../src/host/sync";
import { TurnChannel } from "../../src/host/turnChannel";
import type { SimBridge } from "../../src/host/simBridge";
import type { ArmyDocument, UnitDocument } from "../../src/core/strategic";

describe("Hero Attachment (§5A)", () => {
  it("syncs leaderToken position to unit anchor position via Ops", async () => {
    const store = new DocumentStore({
      meta: {
        worldId: "world-1",
        name: "World One",
        system: "mass-battle-basic",
        systemVersion: "1.0.0",
      },
    });
    const sceneId = "scene-1";
    const tokenId = "token-hero-1";
    const unitId = "unit-1";
    const armyId = "army-1";

    const sceneRef = { coll: "scenes" as const, id: sceneId };

    // Setup scene with a token
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
            tokens: [],
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
          coll: "tokens",
          parent: sceneRef,
          data: {
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

    // Mock bridge with unit anchor returning (150, 250)
    const mockBridge = {
      worldId: "w1",
      db: {} as unknown,
      start: async () => 0,
      refresh: () => {},
      unitAnchors: async () => [[unitId, 150, 250]],
    } as unknown as SimBridge;

    const mockHost = {
      attachSim: () => {},
      commitSystem: (ops: import("../../src/core/ops").Op[]) => {
        store.applyEnvelope({ txId: "sys-tx", seq: store.seq + 1, by: "sys", ts: 0, ops });
        return { ok: true, seq: store.seq, inverse: [] };
      },
      sessionUsers: () => [],
    } as unknown as HostSync;

    const channel = new TurnChannel({
      host: mockHost,
      store,
      bridge: mockBridge,
      sceneId,
      sys: {},
      seed: 12345,
    });

    await channel.syncHeroTokens();

    interface SceneWithTokens {
      _id: string;
      tokens?: Array<{ _id: string; x: number; y: number }>;
    }

    // Verify token was moved to (150, 250)
    const scene = store.get("scenes", sceneId) as unknown as SceneWithTokens;
    const token = scene.tokens?.find((t) => t._id === tokenId);
    expect(token?.x).toBe(150);
    expect(token?.y).toBe(250);
  });

  it("rulesCtx exposes the leader actor keyed by unit id (M07/D-168)", async () => {
    const store = new DocumentStore({
      meta: { worldId: "world-2", name: "World Two", system: "mass-battle-basic", systemVersion: "1.0.0" },
    });
    const sceneId = "scene-1";
    const tokenId = "token-hero-1";
    const actorId = "actor-hero-1";
    const unitId = "unit-1";
    const plainUnitId = "unit-2";
    const armyId = "army-1";
    const sceneRef = { coll: "scenes" as const, id: sceneId };

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
            tokens: [],
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
          coll: "tokens",
          parent: sceneRef,
          data: {
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
            actorId, // the token is bound to an actor — this is what M07 plumbs through
            hidden: false,
            disposition: "neutral",
            vision: true,
            light: { radius: 0, color: "#ffffff", alpha: 0.5 },
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
        {
          kind: "create",
          coll: "actors",
          data: {
            _id: actorId,
            type: "actor",
            name: "Wizard Hero",
            ownership: { default: 3 },
            flags: {},
            system: { pf1e: { abilities: { int: 20 }, spells: { keyAbility: "int", casterLevel: 9 } } },
            items: [],
            effects: [],
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

    const heroUnit: UnitDocument = {
      _id: unitId,
      type: "hero",
      name: "Hero Band",
      ownership: { default: 3 },
      flags: {},
      system: {},
      profile: {},
      formation: "line",
      sceneId,
      modelRange: [0, 1],
      orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
      stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
      leaderTokenId: tokenId,
    };
    const plainUnit: UnitDocument = { ...heroUnit, _id: plainUnitId, name: "Infantry" };
    delete plainUnit.leaderTokenId;

    store.applyEnvelope({
      txId: "tx2",
      seq: 2,
      by: "gm",
      ts: 0,
      ops: [
        {
          kind: "create",
          coll: "armies",
          data: {
            _id: armyId,
            type: "army",
            name: "Army 1",
            ownership: { default: 3 },
            flags: {},
            system: {},
            factionId: "f1",
            commander: [],
            supply: {},
            units: [heroUnit, plainUnit],
          } as unknown as import("../../src/core/documents").BaseDocument,
        },
      ],
    });

    const mockBridge = { worldId: "w2", db: {}, start: async () => 0, refresh: () => {}, unitAnchors: async () => [] } as unknown as SimBridge;
    const mockHost = { attachSim: () => {}, commitSystem: () => ({ ok: true, seq: 0, inverse: [] }), sessionUsers: () => [] } as unknown as HostSync;
    const channel = new TurnChannel({ host: mockHost, store, bridge: mockBridge, sceneId, sys: {}, seed: 1 });

    const leaderActors = channel.rulesCtx().leaderActors;
    // The hero-led unit resolves token → actorId → actor document…
    const actor = leaderActors[unitId] as Record<string, unknown> | undefined;
    expect(actor).toBeDefined();
    expect(actor?._id).toBe(actorId);
    expect((actor?.system as Record<string, unknown> | undefined)?.pf1e).toMatchObject({
      spells: { keyAbility: "int", casterLevel: 9 },
    });
    // …and the unit without a leader token gets no entry at all.
    expect(plainUnitId in leaderActors).toBe(false);
  });
});
