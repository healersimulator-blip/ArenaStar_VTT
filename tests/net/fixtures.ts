import type { WireMessage } from "../../src/core/messages";
import type { Op } from "../../src/core/ops";
import type { BaseDocument, WorldCollections } from "../../src/core/documents";
import type { ProjectedWorld } from "../../src/core/projection";

/** One valid sample per §13 message kind (reused by frame + sync-layer tests). */
export function sampleMessage(kind: WireMessage["kind"]): WireMessage {
  const updateOp: Op = {
    kind: "update",
    ref: { coll: "scenes", id: "s1" },
    diff: { name: "x" },
  };
  switch (kind) {
    case "audio.cmd":
      return {
        kind: "audio.cmd",
        playlistId: "pl-1",
        soundId: "snd-1",
        action: "play",
        atHostTime: 1000,
        offset: 0,
      };
    case "roll.challenge":
      return { kind: "roll.challenge", rollId: "r1", seedHost: "a".repeat(32) };
    case "roll.reveal":
      return { kind: "roll.reveal", rollId: "r1", seedClient: "b".repeat(32) };
    case "hello":
      return {
        kind: "hello",
        pubkey: "a".repeat(64),
        displayName: "Rex",
        ts: 123,
        sig: "b".repeat(128),
      };
    case "intent":
      return { kind: "intent", txId: "tx-1", ops: [updateOp] };
    case "roll":
      return { kind: "roll", rollId: "r-1", formula: "1d20+5", mode: "roll" };
    case "ephemeral":
      return { kind: "ephemeral", from: "u1", t: "cursor", data: { x: 1, y: 2 } };
    case "asset.get":
      return { kind: "asset.get", assetId: "f".repeat(64), offset: 0, priority: "scene" };
    case "fog.put":
      return { kind: "fog.put", sceneId: "s1", png: new Uint8Array([1, 2, 3]) };
    case "relay.offer":
      return { kind: "relay.offer", from: "peer-1", sdp: "v=0..." };
    case "turn.ready":
      return { kind: "turn.ready", turnId: "t1", ready: true };
    case "sim.control":
      return { kind: "sim.control", action: "advance" };
    case "report.detail":
      return { kind: "report.detail", turnId: "t1", page: 2 };
    case "sim.snapshot.get":
      return { kind: "sim.snapshot.get", sceneId: "s1" };
    case "welcome":
      return {
        kind: "welcome",
        user: { id: "u1", role: "PLAYER", name: "Rex" },
        world: { id: "w1", name: "World", system: "mass-battle-basic", version: "1.0.0" },
        snapshotSeq: 7,
      };
    case "snapshot":
      return {
        kind: "snapshot",
        seq: 7,
        world: { seq: 7, collections: { users: [] } } satisfies ProjectedWorld,
        manifest: {},
      };
    case "ops":
      return {
        kind: "ops",
        envelope: { seq: 8, ts: 1000, by: "u1", ops: [updateOp], txId: "tx-1" },
      };
    case "rejected":
      return { kind: "rejected", txId: "tx-1", reason: "forbidden", detail: "nope" };
    case "asset.chunk":
      return {
        kind: "asset.chunk",
        assetId: "f".repeat(64),
        offset: 0,
        total: 3,
        bytes: new Uint8Array([9, 9]),
        done: false,
      };
    case "clock":
      return { kind: "clock", hostTime: 42_000 };
    case "kick":
      return { kind: "kick", reason: "bye" };
    case "ban":
      return { kind: "ban", reason: "spam" };
    case "sim.delta":
      return {
        kind: "sim.delta",
        sceneId: "s1",
        from: 3,
        to: 4,
        bytes: new Uint8Array([1, 2, 3, 4]),
      };
    case "sim.snapshot":
      return { kind: "sim.snapshot", sceneId: "s1", version: 4, bytes: new Uint8Array([5, 6]) };
    case "turn.phase":
      return {
        kind: "turn.phase",
        turnId: "t1",
        phase: "orders",
        deadlineMs: null,
        readyUsers: [],
      };
    case "turn.report":
      return {
        kind: "turn.report",
        turnId: "t1",
        report: {
          turn: 1,
          sceneId: "s1",
          subPhases: ["move"],
          events: [],
          summary: {},
          rulesVersion: "1.0.0",
        },
      };
    case "report.detail.page":
      return { kind: "report.detail.page", turnId: "t1", page: 1, totalPages: 3, events: [] };
    case "heartbeat":
      return { kind: "heartbeat", t: 1 };
    case "ping":
      return { kind: "ping", t0: 1 };
    case "pong":
      return { kind: "pong", t0: 1, t1: 2, t2: 2 };
    case "relay.frame":
      return { kind: "relay.frame", from: "p1", to: "host", bytes: new Uint8Array([7]) };
  }
}

/** All 28 kinds, for exhaustive iteration. */
export const ALL_KINDS: WireMessage["kind"][] = [
  "hello",
  "intent",
  "roll",
  "ephemeral",
  "asset.get",
  "fog.put",
  "relay.offer",
  "turn.ready",
  "sim.control",
  "report.detail",
  "sim.snapshot.get",
  "welcome",
  "snapshot",
  "ops",
  "rejected",
  "asset.chunk",
  "clock",
  "kick",
  "ban",
  "sim.delta",
  "sim.snapshot",
  "turn.phase",
  "turn.report",
  "report.detail.page",
  "heartbeat",
  "ping",
  "pong",
  "relay.frame",
];

/** Minimal empty world for store/projection fixtures. */
export function emptyWorld(): WorldCollections {
  return {
    users: [],
    folders: [],
    scenes: [],
    actors: [],
    items: [],
    journals: [],
    rollTables: [],
    playlists: [],
    macros: [],
    cards: [],
    combats: [],
    messages: [],
    settings: [],
    compendia: [],
    factions: [],
    armies: [],
    turns: [],
    depots: [],
    routes: [],
    reinforcements: [],
    assetManifest: {},
  };
}

export function baseDoc(
  _coll: string,
  id: string,
  over: Record<string, unknown> = {},
): BaseDocument {
  return {
    _id: id,
    type: "x",
    name: `Doc ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    ...over,
  } as BaseDocument;
}
