import { expect, test, vi } from "vitest";
import { DocumentStore } from "../../src/core/store";
import {
  battleOf,
  battleBlocks,
  sceneDeployment,
  type BattleBinding,
} from "../../src/core/strategicRoom/campaignScene";
import { deploy } from "../../services/strategic-room/src/scenario";
import type { ActorDocument, Json, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { ArmyDocument, FactionDocument, UnitDocument } from "../../src/core/strategic";
import { HostedRoomClient } from "../../src/client/hostedRoom";
import { generateIdentity } from "../../src/net/identity";
import { MAX_FRAME, type Command } from "../../src/core/strategicRoom/protocol";

test("selected scene dimensions and scale gate a real 500-seat / 50k-model deployment", () => {
  const store = new DocumentStore({
    meta: {
      worldId: "w",
      name: "Campaign",
      system: "pf1e",
      systemVersion: "1",
    },
  });
  const scene = {
    _id: "other",
    type: "scene",
    active: true,
    img: null,
    darkness: 0,
    ownership: { default: 1 },
    system: {},
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    name: "Other",
    flags: { core: { scale: "strategic" } },
    width: 5000,
    height: 5000,
    grid: {
      type: "square",
      size: 20,
      units: "ft",
      distance: 5,
      diagonals: "555",
      hexLayout: "oddQ",
    },
  } satisfies SceneDocument;
  const deployment = sceneDeployment(store, scene, 4242, 500, 100);
  expect(deployment.name).toBe("Other");
  expect(deployment.commanders).toHaveLength(500);
  expect(deploy(deployment).units).toHaveLength(500);
  expect(() =>
    sceneDeployment(store, { ...scene, width: 100, height: 100 }, 1, 500, 100),
  ).toThrow(/fit/);
  expect(() =>
    sceneDeployment(
      store,
      { ...scene, grid: { ...scene.grid, units: "m" } },
      1,
      2,
    ),
  ).toThrow(/5-ft/);
});

test("visible friendly and hostile scene tokens become authored hosted companies at their map positions", () => {
  const store = new DocumentStore({ meta: { worldId: "w", name: "Campaign", system: "pf1e", systemVersion: "1" } });
  const token = (id: string, disposition: "friendly" | "hostile" | "neutral", x: number, y: number, hidden = false) => ({
    _id: id, type: "token" as const, name: id, ownership: { default: 0 as const }, flags: {}, system: {},
    x, y, width: 100, height: 100, rotation: 0, img: "", hidden, disposition, vision: false,
    light: { radius: 0, dim: 0, color: "#ffffff", alpha: 0 },
  });
  const scene = {
    _id: "field", type: "scene", name: "Authored Field", active: true, img: null, darkness: 0,
    ownership: { default: 1 }, system: {}, flags: { core: { scale: "strategic" },
      pf1e: { difficultCells: [{ col: 3, row: 4 }] } },
    width: 2000, height: 1000,
    grid: { type: "square", size: 100, units: "ft", distance: 5, diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("blue", "friendly", 300, 400), token("red", "hostile", 1500, 600),
      token("hidden", "hostile", 500, 500, true), token("neutral", "neutral", 700, 500)],
    walls: [{ _id: "wall", type: "wall", name: "Wall", ownership: { default: 0 }, flags: {},
      system: {}, c: [500, 0, 500, 1000], door: 0, oneWay: false,
      move: 1, sight: 1, sound: 0, light: 0 }],
    lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  } satisfies SceneDocument;
  const scenario = sceneDeployment(store, scene, 7, 2, 8);
  expect(scenario.commanders).toHaveLength(2);
  expect(scenario.commanders.map((c) => c.factionId)).toEqual(["friendly", "hostile"]);
  // Token x/y is the CENTER (tokenRect), so the anchor is the token center in ft: 300px/100px*5 = 15 ft.
  expect(scenario.commanders.map((c) => c.units[0]?.anchor)).toEqual([{ x: 15, y: 20 }, { x: 75, y: 30 }]);
  expect(scenario.commanders.every((c) => c.units[0]?.strength === 8)).toBe(true);
  expect(scenario.projection).toMatchObject({ format: "arenastar-battle-projection-v1",
    worldId: "w", sceneId: "field", sourceSeq: 0, systemId: "pf1e", systemVersion: "1" });
  expect(scenario.projection?.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(scenario.actionCards).toEqual({ playerCharacters: true, units: true, models: false });
  expect(scenario.walls).toEqual([{ x1: 25, y1: 0, x2: 25, y2: 50, restriction: 3 }]);
  expect(scenario.terrain).toEqual({ difficultCells: [{ col: 3, row: 4 }] });
  expect(deploy(scenario).units).toHaveLength(2);
});

test("Army leaders project ordinary prepared and spontaneous PF1e Entangle resources with provenance", () => {
  const store = new DocumentStore({ meta: { worldId: "w", name: "Campaign", system: "pf1e", systemVersion: "1" } });
  const actor = (id: string, spells: Record<string, Json>, ability: "wis" | "cha", score: number): ActorDocument => ({
    _id: id, type: "actor", name: id, ownership: { default: 3 }, flags: {}, items: [], effects: [],
    system: { pf1e: { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: ability === "wis" ? score : 10,
      cha: ability === "cha" ? score : 10 }, hp: 20, hpMax: 20, saves: { fort: 0, ref: 0, will: 0 }, spells } },
  });
  const unit = (id: string, leaderTokenId: string, x: number): UnitDocument => ({
    _id: id, type: "infantry", name: id, ownership: { default: 3 }, flags: {}, system: {}, leaderTokenId,
    profile: { anchor: { x, y: 20 } }, formation: "line", sceneId: "field", modelRange: null,
    stats: { strength: 20, morale: 10, supply: 10, fatigue: 0, weaponIsRanged: 0, ac: 14, attackBonus: 3,
      damageDice: 6, damageDiceCount: 1, damageBonus: 1, speed: 30, saveBonus: 2 },
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
  });
  const faction = (id: string): FactionDocument => ({ _id: id, type: "faction", name: id,
    ownership: { default: 3 }, flags: {}, system: {}, color: id === "green" ? "#008800" : "#880088", allies: [] });
  const army = (id: string, factionId: string, member: UnitDocument): ArmyDocument => ({
    _id: id, type: "army", name: id, ownership: { default: 3 }, flags: {}, system: {}, factionId,
    commander: [`commander-${id === "prepared-army" ? 1 : 2}`], supply: {}, units: [member],
  });
  const token = (id: string, actorId: string, x: number): TokenDocument => ({
    _id: id, type: "token", name: id, ownership: { default: 3 }, flags: {}, system: {}, actorId,
    x, y: 100, width: 100, height: 100, rotation: 0, img: "", hidden: false, disposition: "friendly",
    vision: true, light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  });
  const prepared = actor("prepared-actor", { keyAbility: "wis", mode: "prepared", casterLevel: 5,
    casterLevelBonus: 1, prepared: [
      { name: "Entangle", level: 1, slotLevel: 1 },
      { name: "ENTANGLE", level: 1, slotLevel: 1, expended: true },
    ] }, "wis", 18);
  const spontaneous = actor("spontaneous-actor", { keyAbility: "cha", mode: "spontaneous", casterLevel: 7,
    slotsPerDay: { 1: 4 }, slotsUsed: { 1: 1 }, known: [{ name: "Entangle", level: 1 }] }, "cha", 16);
  const preparedUnit = unit("prepared-unit", "prepared-token", 20);
  const spontaneousUnit = unit("spontaneous-unit", "spontaneous-token", 80);
  const result = store.applyEnvelope({ seq: 1, ts: 0, by: "gm", txId: "authored-casters", ops: [
    { kind: "create", coll: "actors", data: prepared },
    { kind: "create", coll: "actors", data: spontaneous },
    { kind: "create", coll: "factions", data: faction("green") },
    { kind: "create", coll: "factions", data: faction("purple") },
    { kind: "create", coll: "armies", data: army("prepared-army", "green", preparedUnit) },
    { kind: "create", coll: "armies", data: army("spontaneous-army", "purple", spontaneousUnit) },
  ] });
  expect(result.ok).toBe(true);
  const scene = {
    _id: "field", type: "scene", name: "Caster Field", ownership: { default: 3 }, flags: { core: { scale: "strategic" } },
    system: {}, active: true, img: null, width: 2400, height: 1200, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("prepared-token", prepared._id, 300), token("spontaneous-token", spontaneous._id, 1500)],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  } satisfies SceneDocument;
  const scenario = sceneDeployment(store, scene, 99, 2);
  const projected = Object.fromEntries(scenario.commanders.flatMap((commander) =>
    commander.units.map((entry) => [entry.id, entry.spellcasting])));
  expect(projected).toEqual({
    "prepared-unit": { actorId: "prepared-actor", itemId: "pf1e-core-spells-entangle", casterLevel: 6,
      castingAbilityMod: 4, entangleSlots: 1 },
    "spontaneous-unit": { actorId: "spontaneous-actor", itemId: "pf1e-core-spells-entangle", casterLevel: 7,
      castingAbilityMod: 3, entangleSlots: 3 },
  });
  expect(scenario.projection).toMatchObject({ sourceSeq: 1, worldId: "w", sceneId: "field",
    systemId: "pf1e", systemVersion: "1" });
  expect(scenario.projection?.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("scene binding cannot be inherited by a copied world or scene; fenced roots still allow navigation", () => {
  const b: BattleBinding = {
    id: crypto.randomUUID(),
    scene: "other",
    world: "world",
    armies: ["army"],
    factions: ["red"],
    seats: 2,
    strength: 1,
    seed: 1,
  };
  const scene = {
    _id: "other",
    flags: { core: { campaignBattle: b } },
  } as unknown as SceneDocument;
  expect(battleOf(scene, "world")).toEqual(b);
  expect(battleOf(scene, "copy")).toBeNull();
  expect(battleOf({ ...scene, _id: "copy" }, "world")).toBeNull();
  expect(
    battleBlocks(b, {
      kind: "update",
      ref: { coll: "units", id: "u", parent: { coll: "armies", id: "army" } },
      diff: { "stats.strength": 2 },
    }),
  ).toBe(true);
  expect(
    battleBlocks(b, { kind: "delete", ref: { coll: "scenes", id: "other" } }),
  ).toBe(true);
  expect(
    battleBlocks(b, {
      kind: "update",
      ref: { coll: "scenes", id: "other" },
      diff: { active: false },
    }),
  ).toBe(false);
  expect(
    battleBlocks(b, {
      kind: "delete",
      ref: { coll: "armies", id: "unrelated" },
    }),
  ).toBe(false);
});

test("open socket backpressure does not reserve an unsent request; a sent request remains reserved", async () => {
  const send = vi.fn(),
    change = vi.fn();
  const client = new HostedRoomClient(await generateIdentity(), change);
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: MAX_FRAME + 1,
    send,
  };
  Object.assign(client, { bearer: "test", socket });
  const order: Command = {
    kind: "orders.submit",
    requestId: crypto.randomUUID(),
    turnId: 1,
    expectedRevision: 0,
    unitEdits: [{ unitId: "u", order: { kind: "hold", stance: "hold" } }],
  };
  expect(client.submit(order)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(change.mock.lastCall?.[0].notice).toMatch(/not sent/);
  socket.bufferedAmount = 0;
  expect(client.submit(order)).toBe(true);
  expect(client.submit(order)).toBe(false);
  expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(order));
});
