import { expect, test, vi } from "vitest";
import { DocumentStore } from "../../src/core/store";
import {
  battleOf,
  battleBlocks,
  sceneDeployment,
  type BattleBinding,
} from "../../src/core/strategicRoom/campaignScene";
import { deploy } from "../../services/strategic-room/src/scenario";
import type { SceneDocument } from "../../src/core/documents";
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
