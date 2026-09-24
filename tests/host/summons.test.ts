import { describe, expect, test, vi } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import type { ActorDocument, AssetManifest, AutomationDocument, Json, MacroDocument, SceneDocument,
  TileDocument, TokenDocument, UserDocument } from "../../src/core/documents";
import { createEventBus } from "../../src/core/events";
import type { SummonDefinition, SummonSource } from "../../src/core/summons";
import { summonMarker } from "../../src/core/summons";
import { scriptApprovalHash, type ScriptPolicy } from "../../src/core/scriptMacros";
import type { ScriptRunner } from "../../src/host/scriptWorker";
import { DocumentStore } from "../../src/core/store";
import { OpLog } from "../../src/core/oplog";
import { UndoStack } from "../../src/core/undo";
import type { OpEnvelope } from "../../src/core/ops";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { frameMessage } from "../../src/net/frame";

const meta = { worldId: "summon-world", name: "Summon table", system: "pf1e", systemVersion: "1.0" };
const art = "b".repeat(64);
const actor: ActorDocument = { _id: "hidden-actor", type: "actor", name: "Dire Wolf",
  ownership: { default: 0 }, flags: { private: { source: "not for the player" } },
  system: { hp: 18 }, items: [], effects: [], img: art } as ActorDocument;
const definition: SummonDefinition = { version: 1, sceneId: "s1", source: { kind: "world", actorId: actor._id },
  playerCallable: true, maxDistance: 30, durationMs: 2000 };
const preset: MacroDocument = { _id: "approved", type: "macro", kind: "summon", name: "Summon a wolf",
  command: "private GM command", ownership: { default: 1 }, flags: { core: { note: "secret preset" } },
  system: { description: "secret system" }, summon: definition };
function token(id: string, owner: string, x: number): TokenDocument {
  return { _id: id, type: "token", name: id, ownership: { default: 0, [owner]: 3 }, flags: {}, system: {},
    x, y: 150, width: 100, height: 100, rotation: 0, img: "", hidden: false, disposition: "friendly",
    vision: true, light: { radius: 0, alpha: 0, color: "#ffffff" } };
}
function user(id: string, role: UserDocument["role"]): UserDocument {
  return { _id: id, type: "user", name: id, ownership: { default: 0 }, flags: {}, system: {},
    role, character: null, color: "#eeeeee" };
}
function scene(): SceneDocument {
  return { _id: "s1", type: "scene", name: "Field", ownership: { default: 2 }, flags: {}, system: {},
    active: true, img: null, width: 1000, height: 1000, darkness: 0, grid: { type: "square", size: 100,
      distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("rex-token", "rex", 150), token("ivy-token", "ivy", 650)], walls: [], lights: [], sounds: [],
    tiles: [], drawings: [], templates: [], notes: [] };
}

type Harness = Awaited<ReturnType<typeof setup>>;
async function setup(options: { now?: () => number; manifest?: AssetManifest; runner?: ScriptRunner;
  resolver?: (ref: Extract<SummonSource, { kind: "compendium" }>) => Promise<ActorDocument | undefined> } = {}) {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const seed: OpEnvelope = { seq: 1, by: "gm", txId: "seed", ts: 0, ops: [
    { kind: "create", coll: "users", data: user("gm", "GM") },
    { kind: "create", coll: "users", data: user("rex", "PLAYER") },
    { kind: "create", coll: "users", data: user("ivy", "PLAYER") },
    { kind: "create", coll: "scenes", data: scene() },
    { kind: "create", coll: "actors", data: actor },
  ] };
  const applied = store.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  const logged = log.append(seed, applied.value.inverses);
  if (!logged.ok) throw new Error(logged.error);
  store.replaceAssetManifest(options.manifest ?? { [art]: { name: "private.png", mime: "image/png", size: 1,
    chunks: 1, visibility: "gm" } });
  const host = new HostSync({ store, log, undo: new UndoStack(), bus: createEventBus<HostEvents>(),
    roomId: "room", systemUserId: "gm", now: options.now ?? (() => 1000),
    ...(options.resolver ? { resolveSummonSource: options.resolver } : {}),
    ...(options.runner ? { scriptRunner: options.runner } : {}) });
  function connect(id: "gm" | "rex" | "ivy") {
    const pair = createTransportPair();
    host.addSession(id, pair.a, id === "gm" ? gmSessionUser("gm") :
      { id, role: "PLAYER", name: id });
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    return { client, bus, pair };
  }
  const gm = connect("gm");
  await flushMicrotasks();
  return { host, store, log, gm, connect };
}
async function publish(h: Harness, template = preset): Promise<void> {
  h.gm.client.submit([{ kind: "create", coll: "macros", data: template }]);
  await flushMicrotasks();
  expect(h.store.get("macros", template._id)).toBeDefined();
}
function created(h: Harness) {
  const scene = h.store.get("scenes", "s1") as SceneDocument;
  return scene.tokens.filter((t) => summonMarker(t));
}
function waitForZone(bus: ReturnType<typeof createEventBus<ClientEvents>>, detail: string):
  Promise<ClientEvents["automationTrace"]> {
  return new Promise((resolve, reject) => {
    const seen: ClientEvents["automationTrace"][] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`zone trace timed out: ${detail}; received ${JSON.stringify(seen)}`)); }, 3000);
    const off = bus.on("automationTrace", (msg) => {
      seen.push(msg);
      if (!msg.detail.includes(detail)) return;
      clearTimeout(timer); off(); resolve(msg);
    });
  });
}
function waitForMacro(bus: ReturnType<typeof createEventBus<ClientEvents>>, requestId: string):
  Promise<ClientEvents["macroResult"]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("macro result timed out")); }, 3000);
    const off = bus.on("macroResult", (result) => {
      if (result.requestId !== requestId) return;
      clearTimeout(timer); off(); resolve(result);
    });
  });
}
const zoneTile: TileDocument = { _id: "zone-tile", type: "tile", name: "Conjuring circle",
  ownership: { default: 1 }, flags: {}, system: {}, x: 300, y: 200, width: 200, height: 200,
  img: "", above: false, occlusion: { mode: "roof", alpha: 0.5 } };
function summonZone(presetId: string): AutomationDocument {
  return { _id: "conjure-zone", type: "automation", name: "Conjure", ownership: { default: 0 },
    flags: {}, system: {}, definition: { version: 1, sceneId: "s1", tileId: zoneTile._id,
      methods: ["click"], gates: { playerRunnable: true }, steps: [
        { id: "call", kind: "summon", presetId, anchor: "tile" },
      ] } };
}
async function reviewedSummonScript(allowlist: string[], runAs: "caller" | "gm" = "gm",
  presetId = "private-wolf") {
  const command = `// GM PRIVATE\nreturn await api.summons.place('${presetId}', 350, 250, args.caster);`;
  const policy: Omit<ScriptPolicy, "approvedHash"> = { version: 1, sceneId: "s1", runAs,
    playerCallable: true, grants: ["summons"], inputs: [{ name: "caster", type: "token" },
      { name: "target", type: "token" }], ...(allowlist.length ? { summonIds: allowlist } : {}) };
  const script: MacroDocument = { _id: "summon-script", type: "macro", kind: "script",
    name: "Reviewed summoning", ownership: { default: 1 }, flags: {}, system: {}, command,
    script: { ...policy, approvedHash: await scriptApprovalHash(command, policy) } };
  return script;
}

describe("authoritative summons: publication, isolation, cleanup and privacy", () => {
  test("players see safe catalog, place independent actors in one envelope, edit only their own and dismiss", async () => {
    const h = await setup();
    await publish(h);
    const rex = h.connect("rex"), ivy = h.connect("ivy");
    await flushMicrotasks();
    const publicPreset = rex.client.store.get("macros", preset._id) as MacroDocument;
    expect(publicPreset.summon).toMatchObject({ version: 1, sceneId: "s1", playerCallable: true, maxDistance: 30 });
    expect(rex.client.store.get("actors", actor._id)).toBeUndefined();
    expect(rex.client.store.world.assetManifest[art]).toBeUndefined();
    const results: ClientEvents["summonResult"][] = [];
    rex.bus.on("summonResult", (m) => results.push(m));
    const before = h.store.seq;
    rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    expect(results.at(-1)?.ok).toBe(true);
    expect(h.store.seq).toBe(before + 1);
    const first = created(h)[0];
    expect(first).toBeDefined();
    const instanceActor = h.store.get("actors", first?.actorId ?? "") as ActorDocument;
    expect(instanceActor.system.hp).toBe(18);
    expect((h.store.get("actors", actor._id) as ActorDocument).system.hp).toBe(18);
    expect(first?.img).toBe(""); // GM-only media does not become a player entitlement
    const playerScene = rex.client.store.get("scenes", "s1") as SceneDocument;
    expect(playerScene.tokens.find((t) => t._id === first?._id)?.flags.summon).toBeUndefined();
    expect(playerScene.tokens.find((t) => t._id === first?._id)?.flags.summonStatus).toMatchObject({ ownerId: "rex" });
    expect(rex.client.store.get("actors", instanceActor._id)?.flags.summon).toBeUndefined();
    expect(ivy.client.store.get("actors", instanceActor._id)).toBeUndefined();
    expect(JSON.stringify(rex.client.store.world)).not.toContain("hidden-actor");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("secret preset");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("not for the player");

    ivy.client.requestSummonPlace(preset._id, "s1", { x: 450, y: 250 }, "ivy-token");
    await flushMicrotasks();
    expect(created(h)).toHaveLength(2);
    expect(created(h)[1]?.actorId).not.toBe(instanceActor._id);
    const second = created(h)[1];
    const rejected: ClientEvents["rejected"][] = [];
    ivy.bus.on("rejected", (v) => rejected.push(v));
    ivy.client.submit([{ kind: "update", ref: { coll: "actors", id: instanceActor._id },
      diff: { "system.hp": 0 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    rex.client.submit([{ kind: "update", ref: { coll: "actors", id: instanceActor._id },
      diff: { "system.hp": 6 } }]);
    await flushMicrotasks();
    expect((h.store.get("actors", instanceActor._id) as ActorDocument).system.hp).toBe(6);
    expect((h.store.get("actors", actor._id) as ActorDocument).system.hp).toBe(18);
    const denied: ClientEvents["summonResult"][] = [];
    ivy.bus.on("summonResult", (v) => denied.push(v));
    ivy.client.requestSummonDismiss("s1", first?._id ?? "");
    await flushMicrotasks();
    expect(denied.at(-1)).toMatchObject({ ok: false, detail: "Summon unavailable" });
    rex.client.requestSummonDismiss("s1", first?._id ?? "");
    await flushMicrotasks();
    expect(created(h).map((t) => t._id)).toEqual([second?._id]);
    expect(h.store.get("actors", instanceActor._id)).toBeUndefined();
    expect(h.store.get("actors", actor._id)).toBeDefined();
    h.host.dispose();
  });

  test("forged markers/ownership and private preset edits are rejected, range and bogus actor IDs fail", async () => {
    const h = await setup();
    await publish(h);
    const rex = h.connect("rex");
    await flushMicrotasks();
    const failed: ClientEvents["summonResult"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    rex.bus.on("summonResult", (v) => failed.push(v));
    rex.bus.on("rejected", (v) => rejected.push(v));
    rex.client.requestSummonPlace("hidden-actor", "s1", { x: 250, y: 250 }, "rex-token");
    rex.client.requestSummonPlace(preset._id, "s1", { x: 900, y: 900 }, "rex-token");
    rex.client.requestSummonPlace(preset._id, "s1", { x: 250, y: 250 }, "ivy-token");
    await flushMicrotasks();
    expect(failed).toHaveLength(3);
    expect(failed.every((r) => !r.ok && !r.detail.includes("actor"))).toBe(true);
    expect(created(h)).toHaveLength(0);
    rex.client.submit([{ kind: "update", ref: { coll: "macros", id: preset._id },
      diff: { "summon.source.actorId": "some-other-actor" } }]);
    rex.client.submit([{ kind: "update", ref: { coll: "tokens", id: "rex-token", parent: { coll: "scenes", id: "s1" } },
      diff: { "flags.summon.ownerId": "rex" } }]);
    rex.client.submit([{ kind: "create", coll: "actors", data: { ...actor, _id: "fake-instance",
      flags: { summon: { ownerId: "rex" } } } }]);
    await flushMicrotasks();
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reason === "forbidden")).toBe(true);
    expect(h.store.get("actors", "fake-instance")).toBeUndefined();
    h.host.dispose();
  });

  test("GM unpublication immediately revokes catalog; undo restores it; late join sees no source or marker", async () => {
    const h = await setup();
    await publish(h);
    const rex = h.connect("rex");
    await flushMicrotasks();
    h.gm.client.submit([{ kind: "update", ref: { coll: "macros", id: preset._id },
      diff: { summon: { ...definition, playerCallable: false }, ownership: { default: 0 } } }]);
    await flushMicrotasks();
    expect(rex.client.store.get("macros", preset._id)).toBeUndefined();
    rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    expect(created(h)).toHaveLength(0);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((rex.client.store.get("macros", preset._id) as MacroDocument).summon)
      .toMatchObject({ version: 1, sceneId: "s1", playerCallable: true, maxDistance: 30 });
    rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    expect(created(h)).toHaveLength(1);
    // Player reconnects receive a new recipient-projected snapshot, not a raw
    // authority log with the private actor source or summon instance marker.
    h.host.removeSession("rex");
    const late = h.connect("rex");
    await flushMicrotasks();
    const view = late.client.store.get("scenes", "s1") as SceneDocument;
    expect(view.tokens.find((t) => summonMarker(t))).toBeUndefined();
    expect(view.tokens.some((t) => t.flags.summonStatus !== undefined)).toBe(true);
    expect(JSON.stringify(late.client.store.world)).not.toContain("hidden-actor");
    expect(JSON.stringify(late.client.store.world)).not.toContain("secret preset");
    h.host.dispose();
  });

  test("compendium source resolves without permanent import; in-flight unpublication cancels", async () => {
    let release: ((actor?: ActorDocument) => void) | undefined;
    const sourcePromise = () => new Promise<ActorDocument | undefined>((resolve) => { release = resolve; });
    const h = await setup({ resolver: async () => sourcePromise() });
    const packPreset: MacroDocument = { ...preset, _id: "pack-wolf", summon: { ...definition,
      source: { kind: "compendium", packageId: "bestiary", packFile: "packs/wolves.json", entryId: "wolf" } } };
    await publish(h, packPreset);
    const rex = h.connect("rex");
    await flushMicrotasks();
    const results: ClientEvents["summonResult"][] = [];
    rex.bus.on("summonResult", (v) => results.push(v));
    rex.client.requestSummonPlace(packPreset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    expect(release).toBeDefined();
    h.gm.client.submit([{ kind: "update", ref: { coll: "macros", id: packPreset._id },
      diff: { summon: { ...definition, source: (packPreset.summon as SummonDefinition).source,
        playerCallable: false }, ownership: { default: 0 } } }]);
    await flushMicrotasks();
    release?.({ ...actor, _id: "wolf", name: "Package Wolf" });
    await flushMicrotasks();
    expect(results.at(-1)?.ok).toBe(false);
    expect(created(h)).toHaveLength(0);
    h.gm.client.submit([{ kind: "update", ref: { coll: "macros", id: packPreset._id },
      diff: { summon: packPreset.summon as unknown as Json, ownership: { default: 1 } } }]);
    await flushMicrotasks();
    rex.client.requestSummonPlace(packPreset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    release?.({ ...actor, _id: "wolf", name: "Package Wolf" });
    await flushMicrotasks();
    expect(results.at(-1)?.ok).toBe(true);
    expect(created(h)).toHaveLength(1);
    // A replayed requestId must not allocate a second actor even if hand-framed.
    const successId = results.at(-1)?.requestId ?? "";
    rex.pair.b.send("ops", frameMessage({ kind: "summon.place", requestId: successId,
      presetId: packPreset._id, sceneId: "s1", at: { x: 450, y: 250 }, summonerTokenId: "rex-token" }));
    await flushMicrotasks();
    expect(created(h)).toHaveLength(1);
    expect(h.store.get("actors", "wolf")).toBeUndefined();
    expect(h.store.get("actors", actor._id)).toBeDefined();
    h.host.dispose();
  });

  test("expiry after host clock advance cleans actor/token in one envelope; actor delete/undo and scene delete cascade", async () => {
    let clock = 1000;
    const h = await setup({ now: () => clock });
    await publish(h);
    const rex = h.connect("rex");
    await flushMicrotasks();
    rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    const first = created(h)[0];
    expect(first).toBeDefined();
    const active = h.store.get("actors", first?.actorId ?? "");
    expect(active).toBeDefined();
    h.gm.client.submit([{ kind: "delete", ref: { coll: "actors", id: active?._id ?? "" } }]);
    await flushMicrotasks();
    expect(created(h)).toHaveLength(0);
    expect(h.store.get("actors", active?._id ?? "")).toBeUndefined();
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(created(h)).toHaveLength(1);
    clock = 4000;
    // Session join sweeps deadlines even if a background tab's timer slept.
    h.host.removeSession("rex");
    const late = h.connect("rex");
    await flushMicrotasks();
    expect(created(h)).toHaveLength(0);
    expect(h.store.get("actors", active?._id ?? "")).toBeUndefined();
    expect((late.client.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === first?._id)).toBe(false);
    clock = 5000;
    late.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
    await flushMicrotasks();
    const second = created(h)[0];
    h.gm.client.submit([{ kind: "delete", ref: { coll: "scenes", id: "s1" } }]);
    await flushMicrotasks();
    expect(h.store.get("scenes", "s1")).toBeUndefined();
    expect(h.store.get("actors", second?.actorId ?? "")).toBeUndefined();
    expect(h.store.get("actors", actor._id)).toBeDefined();
    h.host.dispose();
  });
  test("player runs a reviewed script to place one private allowlisted summon; ownership, dismissal and projection stay scoped", async () => {
    const runner: ScriptRunner = async (_source, args, _context, action) => {
      if (args.target) return action("summons.dismiss", { tokenId: args.target }, () => true);
      await expect(action("summons.place", { presetId: "unlisted", at: { x: 350, y: 250 },
        summonerTokenId: args.caster }, () => true)).rejects.toThrow(/not approved/);
      await expect(action("summons.place", { presetId: "private-wolf", at: { x: 350, y: 250 },
        summonerTokenId: "ivy-token" }, () => true)).rejects.toThrow(/owned summoner/);
      return action("summons.place", { presetId: "private-wolf", at: { x: 350, y: 250 },
        summonerTokenId: args.caster }, () => true);
    };
    const h = await setup({ runner });
    const secret: MacroDocument = { ...preset, _id: "private-wolf", ownership: { default: 0 },
      summon: { ...definition, playerCallable: false } };
    const script = await reviewedSummonScript([secret._id]);
    h.gm.client.submit([{ kind: "create", coll: "macros", data: secret },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const rex = h.connect("rex"), ivy = h.connect("ivy");
    await flushMicrotasks();
    expect(rex.client.store.get("macros", secret._id)).toBeUndefined();
    expect(rex.client.store.get("actors", actor._id)).toBeUndefined();
    expect(rex.client.store.get("macros", script._id)?.command).toBe("");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("private-wolf");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("hidden-actor");
    const results: ClientEvents["macroResult"][] = [];
    rex.bus.on("macroResult", (m) => results.push(m));
    ivy.bus.on("macroResult", (m) => results.push(m));
    const before = h.store.seq;
    const placeId = rex.client.requestMacro(script._id, { caster: "rex-token" });
    await waitForMacro(rex.bus, placeId);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: true, detail: "Script completed" });
    expect(results.at(-1)?.result).toBeUndefined();
    expect(h.store.seq).toBe(before + 3); // marker, actor+token with receipt, finalized receipt
    const first = created(h)[0];
    if (!first) throw new Error("expected a summoned token");
    expect(summonMarker(first)?.ownerId).toBe("rex");
    const newActor = h.store.get("actors", first.actorId ?? "") as ActorDocument & { img?: string };
    expect(newActor._id).not.toBe(actor._id);
    expect(newActor.system.hp).toBe(18);
    expect(newActor.img).toBe("");
    expect(ivy.client.store.get("actors", newActor._id)).toBeUndefined();
    expect(rex.client.store.get("actors", newActor._id)).toBeDefined();
    expect(JSON.stringify(rex.client.store.world)).not.toContain("hidden-actor");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("private-wolf");

    const deniedId = ivy.client.requestMacro(script._id, { target: first._id });
    await waitForMacro(ivy.bus, deniedId);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: false, detail: "Script failed" });
    expect(created(h)).toHaveLength(1);
    const dismissId = rex.client.requestMacro(script._id, { target: first._id });
    await waitForMacro(rex.bus, dismissId);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: true, detail: "Script completed" });
    expect(created(h)).toHaveLength(0);
    expect(h.store.get("actors", newActor._id)).toBeUndefined();
    h.host.dispose();
  });

  test("a published tile click invokes a GM-authored private summon step with a real isolated actor", async () => {
    const h = await setup();
    const secret: MacroDocument = { ...preset, _id: "private-wolf", ownership: { default: 0 },
      summon: { ...definition, playerCallable: false } };
    const zone = summonZone(secret._id);
    h.gm.client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile }]);
    await flushMicrotasks();
    h.gm.client.submit([{ kind: "create", coll: "macros", data: secret },
      { kind: "create", coll: "automations", data: zone }]);
    await flushMicrotasks();
    expect(h.store.get("automations", zone._id)).toBeDefined();
    expect((h.store.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(1);
    const rex = h.connect("rex");
    await flushMicrotasks();
    expect(rex.client.store.get("macros", secret._id)).toBeUndefined();
    expect(rex.client.store.get("automations", zone._id)).toBeUndefined();
    const privateTraces: ClientEvents["automationTrace"][] = [];
    rex.bus.on("automationTrace", (msg) => privateTraces.push(msg));
    const before = h.store.seq;
    const done = waitForZone(h.gm.bus, "post-commit actions completed");
    rex.client.requestAutomationClick("s1", zoneTile._id, { x: 400, y: 300 }, "rex-token");
    expect((await done).result).toBe("committed");
    await flushMicrotasks();
    expect(h.store.seq).toBe(before + 3); // graph history, actor+token, finalized receipt
    expect(privateTraces).toEqual([]);
    const instance = created(h)[0];
    if (!instance) throw new Error("the zone must create a linked summon");
    expect(summonMarker(instance)?.ownerId).toBe("rex");
    const summonActor = h.store.get("actors", instance.actorId ?? "") as ActorDocument;
    expect(summonActor.system.hp).toBe(18);
    expect(summonActor._id).not.toBe(actor._id);
    expect(rex.client.store.get("actors", summonActor._id)).toBeDefined();
    expect(rex.client.store.get("actors", actor._id)).toBeUndefined();
    expect(JSON.stringify(rex.client.store.world)).not.toContain("private-wolf");
    expect(JSON.stringify(rex.client.store.world)).not.toContain("hidden-actor");
    h.host.removeSession("rex");
    const rejoined = h.connect("rex");
    await flushMicrotasks();
    expect(rejoined.client.store.get("actors", summonActor._id)).toBeDefined();
    expect(rejoined.client.store.get("actors", actor._id)).toBeUndefined();
    expect(JSON.stringify(rejoined.client.store.world)).not.toContain("private-wolf");
    h.host.dispose();
  });

  test("tile summon preflight fails before history on missing caster or preset; delayed source revocation stays private", async () => {
    let release: ((actor?: ActorDocument) => void) | undefined;
    const h = await setup({ resolver: () => new Promise((resolve) => { release = resolve; }) });
    const secret: MacroDocument = { ...preset, _id: "pack-wolf", ownership: { default: 0 },
      summon: { ...definition, playerCallable: false, source: { kind: "compendium",
        packageId: "bestiary", packFile: "packs/wolves.json", entryId: "wolf" } } };
    const zone = summonZone(secret._id);
    h.gm.client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile }]);
    await flushMicrotasks();
    h.gm.client.submit([{ kind: "create", coll: "macros", data: secret },
      { kind: "create", coll: "automations", data: zone }]);
    await flushMicrotasks();
    const rex = h.connect("rex");
    await flushMicrotasks();
    const playerTraces: ClientEvents["automationTrace"][] = [];
    rex.bus.on("automationTrace", (msg) => playerTraces.push(msg));
    const first = h.store.seq;
    const noCaster = waitForZone(h.gm.bus, "summon call needs an owned triggering caster");
    rex.client.requestAutomationClick("s1", zoneTile._id, { x: 400, y: 300 });
    expect((await noCaster).result).toBe("rejected");
    expect(h.store.seq).toBe(first);
    expect((h.store.get("automations", zone._id) as AutomationDocument).state).toBeUndefined();
    expect(playerTraces).toEqual([]);
    h.gm.client.submit([{ kind: "update", ref: { coll: "automations", id: zone._id },
      diff: { definition: { ...zone.definition, steps: [
        { id: "call", kind: "summon", presetId: "missing-preset", anchor: "tile" },
      ] } as unknown as Json } }]);
    await flushMicrotasks();
    const afterEdit = h.store.seq;
    const missing = waitForZone(h.gm.bus, "preset, caster or placement unavailable");
    rex.client.requestAutomationClick("s1", zoneTile._id, { x: 400, y: 300 }, "rex-token");
    expect((await missing).result).toBe("rejected");
    expect(h.store.seq).toBe(afterEdit);
    h.gm.client.submit([{ kind: "update", ref: { coll: "automations", id: zone._id },
      diff: { definition: zone.definition as unknown as Json } }]);
    await flushMicrotasks();
    const accepted = waitForZone(h.gm.bus, "post-commit actions queued");
    rex.client.requestAutomationClick("s1", zoneTile._id, { x: 400, y: 300 }, "rex-token");
    expect((await accepted).result).toBe("committed");
    await vi.waitFor(() => expect(release).toBeDefined());
    h.gm.client.submit([{ kind: "update", ref: { coll: "automations", id: zone._id },
      diff: { definition: { ...zone.definition, steps: [
        { id: "call", kind: "summon", presetId: secret._id, anchor: "trigger" },
      ] } as unknown as Json } }]);
    await flushMicrotasks();
    const cancelled = waitForZone(h.gm.bus, "Summon failed after the graph committed");
    release?.({ ...actor, _id: "pack-source" });
    expect((await cancelled).trace.at(-1)).toContain("POST-COMMIT SUMMON FAILED");
    expect(created(h)).toHaveLength(0);
    expect(playerTraces).toEqual([]);
    expect(JSON.stringify(rex.client.store.world)).not.toContain("pack-wolf");
    h.host.dispose();
  });

  test("private summon script revalidates its reviewed revision after async compendium lookup", async () => {
    let release: ((actor?: ActorDocument) => void) | undefined;
    const runner: ScriptRunner = async (_source, args, _context, action) =>
      action("summons.place", { presetId: "pack-wolf", at: { x: 350, y: 250 },
        summonerTokenId: args.caster }, () => true);
    const h = await setup({ runner, resolver: () => new Promise((resolve) => { release = resolve; }) });
    const secret: MacroDocument = { ...preset, _id: "pack-wolf", ownership: { default: 0 },
      summon: { ...definition, playerCallable: false, source: { kind: "compendium",
        packageId: "bestiary", packFile: "packs/wolves.json", entryId: "wolf" } } };
    const script = await reviewedSummonScript([secret._id], "gm", secret._id);
    h.gm.client.submit([{ kind: "create", coll: "macros", data: secret },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const rex = h.connect("rex");
    await flushMicrotasks();
    const results: ClientEvents["macroResult"][] = [];
    rex.bus.on("macroResult", (m) => results.push(m));
    const requestId = rex.client.requestMacro(script._id, { caster: "rex-token" });
    const finished = waitForMacro(rex.bus, requestId);
    await vi.waitFor(() => expect(release).toBeDefined());
    h.gm.client.submit([{ kind: "update", ref: { coll: "macros", id: script._id },
      diff: { command: "return 'revoked'" } }]);
    await flushMicrotasks();
    release?.({ ...actor, _id: "pack-source" });
    await finished;
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: false, detail: "Script failed" });
    expect(created(h)).toEqual([]);
    expect(h.store.get("actors", "pack-source")).toBeUndefined();
    h.host.dispose();
  });
});

test("GM Revert reverses a player summon creation and restores a later dismissed actor and token together", async () => {
  const h = await setup();
  await publish(h);
  const rex = h.connect("rex");
  await flushMicrotasks();
  rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
  await flushMicrotasks();
  const first = created(h)[0];
  if (!first?.actorId) throw new Error("summon actor/token missing");
  const createdReceipt = h.store.getAll("actionReceipts")[0];
  if (!createdReceipt) throw new Error("placement receipt missing");
  expect(createdReceipt).toMatchObject({ status: "ready", commits: 1 });
  expect(rex.client.store.getAll("actionReceipts")).toEqual([]);
  h.gm.client.actionRevert(createdReceipt._id);
  await flushMicrotasks();
  expect(created(h)).toEqual([]);
  expect(h.store.get("actors", first.actorId)).toBeUndefined();
  expect(h.store.getAll("actionReceipts")[0]?.status).toBe("reverted");

  rex.client.requestSummonPlace(preset._id, "s1", { x: 350, y: 250 }, "rex-token");
  await flushMicrotasks();
  const second = created(h)[0];
  if (!second?.actorId) throw new Error("second summon missing");
  const savedActor = h.store.get("actors", second.actorId);
  rex.client.requestSummonDismiss("s1", second._id);
  await flushMicrotasks();
  expect(created(h)).toEqual([]);
  expect(h.store.get("actors", second.actorId)).toBeUndefined();
  const dismissal = h.store.getAll("actionReceipts").find((receipt) => receipt.name.startsWith("Dismiss summon"));
  if (!dismissal) throw new Error("dismissal receipt missing");
  expect(dismissal.inverses).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "create", coll: "actors" }),
    expect.objectContaining({ kind: "create", coll: "tokens" }),
  ]));
  h.gm.client.actionRevert(dismissal._id);
  await flushMicrotasks();
  expect(created(h)).toEqual([second]);
  expect(h.store.get("actors", second.actorId)).toEqual(savedActor);
  expect(h.store.getAll("actionReceipts").find((receipt) => receipt._id === dismissal._id)?.status)
    .toBe("reverted");
  h.host.dispose();
});
