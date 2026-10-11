import { expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { DRAFT_LEVELS_FEATURE, SUPPORTED_WIRE_FEATURES, featureListError, opsNeedLevelDrafts } from "../../src/core/capabilities";
import { createEventBus } from "../../src/core/events";
import type { HelloMsg, WelcomeMsg, WireMessage } from "../../src/core/messages";
import type { Op } from "../../src/core/ops";
import { draftLevel } from "../../src/core/levels";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { channelFor, deframeMessage, frameMessage } from "../../src/net/frame";
const meta = { worldId: "w", name: "World", system: "s", systemVersion: "1" };
const hello: HelloMsg = { kind: "hello", pubkey: "gm", displayName: "GM", ts: 1, sig: "valid" };
const welcome: WelcomeMsg = { kind: "welcome", user: { id: "gm", role: "GM", name: "GM" }, world: { id: "w", name: "World", system: "s", version: "1" }, snapshotSeq: 0 };
const levelOp: Op = { kind: "create", coll: "levels", parent: { coll: "scenes", id: "s" }, data: draftLevel("l", "L") };
function fixture() {
  const pair = createTransportPair(), bus = createEventBus<ClientEvents>(), frames: WireMessage[] = [], kicks: string[] = [];
  const client = new ClientSync({ transport: pair.b, bus, meta });
  pair.a.onMessage = (_channel, data) => { const m = deframeMessage(data); if (m.ok) frames.push(m.value); };
  bus.on("kick", ({ reason }) => kicks.push(reason));
  const send = async (m: WireMessage) => { pair.a.send(channelFor(m.kind), frameMessage(m)); await flushMicrotasks(); };
  return { client, pair, frames, kicks, send };
}

test("bounded capabilities accept legacy absence and future optional feature names, reject malformed lists", () => {
  expect(featureListError(undefined)).toBeNull(); expect(featureListError([])).toBeNull();
  expect(featureListError(["future.optional-v1"])).toBeNull();
  for (const input of [null, "levels", [1], ["a", "a"], new Array(1), ["a".repeat(65)], Array.from({ length: 33 }, (_, i) => `f${i}`)])
    expect(featureListError(input)).not.toBeNull();
});
test("draft ops are recognized across embedded and whole/dotted scene writes", () => {
  expect(opsNeedLevelDrafts([levelOp])).toBe(true);
  for (const key of ["levels", "levels.0.name", "-=levels"]) expect(opsNeedLevelDrafts([{ kind: "update", ref: { coll: "scenes", id: "s" }, diff: { [key]: [] } }])).toBe(true);
  expect(opsNeedLevelDrafts([{ kind: "create", coll: "scenes", data: { _id: "s", levels: [] } as never }])).toBe(true);
  expect(opsNeedLevelDrafts([{ kind: "update", ref: { coll: "scenes", id: "s" }, diff: { name: "New" } }])).toBe(false);
});
test("client advertises its build, accepts negotiated support, clears it before reconnect", async () => {
  const h = fixture(); h.client.connect(hello); await flushMicrotasks();
  expect(h.frames[0]).toMatchObject({ kind: "hello", features: [...SUPPORTED_WIRE_FEATURES] });
  await h.send({ ...welcome, features: [DRAFT_LEVELS_FEATURE], requiredFeatures: [DRAFT_LEVELS_FEATURE] });
  expect(h.client.supportsFeature(DRAFT_LEVELS_FEATURE)).toBe(true);
  h.client.submit([levelOp]); await flushMicrotasks();
  expect(h.frames.at(-1)?.kind).toBe("intent");
  const next = createTransportPair(); h.client.reattach(next.b);
  expect(h.client.supportsFeature(DRAFT_LEVELS_FEATURE)).toBe(false);
  await expect(h.client.submitAndWait([levelOp])).rejects.toThrow("Upgrade required");
  h.client.close(); h.pair.a.close();
});
test("legacy host still permits ordinary edits but draft sends fail before any optimistic write", async () => {
  const h = fixture(); h.client.connect(hello); await flushMicrotasks(); await h.send(welcome);
  expect(h.client.supportsFeature(DRAFT_LEVELS_FEATURE)).toBe(false);
  await expect(h.client.submitAndWait([levelOp])).rejects.toThrow("compatible host");
  expect(h.frames.filter((m) => m.kind === "intent")).toHaveLength(0);
  expect(h.client.echo.seq).toBe(0);
  h.client.submit([{ kind: "update", ref: { coll: "scenes", id: "s" }, diff: { name: "Normal" } }]); await flushMicrotasks();
  expect(h.frames.at(-1)?.kind).toBe("intent"); h.client.close();
});
test.each(["unknown", "malformed", "unadvertised"])("%s required capabilities close before replica hydration", async (variant) => {
  const h = fixture(); h.client.connect(hello); await flushMicrotasks();
  const required = variant === "unknown" ? ["future-sealed-world-v1"] : variant === "malformed" ? [3] as never : [DRAFT_LEVELS_FEATURE];
  await h.send({ ...welcome, features: variant === "unadvertised" ? [] : [DRAFT_LEVELS_FEATURE], requiredFeatures: required });
  expect(h.kicks).toHaveLength(1); expect(h.client.user).toBeNull(); expect(h.pair.b.stats.connected).toBe(false);
});
test("unnegotiated draft operations are rejected instead of silently applied", async () => {
  const h = fixture(); await h.send(welcome);
  await h.send({ kind: "ops", envelope: { seq: 1, ts: 0, txId: "unsafe", by: "gm", ops: [levelOp] } });
  expect(h.kicks[0]).toContain("unnegotiated"); expect(h.client.store.seq).toBe(0);
});
test("an unknown optional host feature does not block a legacy flat world", async () => {
  const h = fixture(); await h.send({ ...welcome, features: ["future-optional-v1"], requiredFeatures: [] });
  expect(h.client.user?.role).toBe("GM"); expect(h.kicks).toEqual([]); h.client.close();
});


test("late old-transport callbacks cannot restore negotiated features after reconnect or close", async () => {
  const h = fixture(); h.client.connect(hello); await flushMicrotasks();
  await h.send({ ...welcome, features: [DRAFT_LEVELS_FEATURE] });
  const oldCallback = h.pair.b.onMessage;
  if (!oldCallback) throw new Error("missing callback");
  const next = createTransportPair(); h.client.reattach(next.b);
  oldCallback("ops", frameMessage({ ...welcome, features: [DRAFT_LEVELS_FEATURE] }));
  expect(h.client.supportsFeature(DRAFT_LEVELS_FEATURE)).toBe(false);
  const currentCallback = next.b.onMessage;
  if (!currentCallback) throw new Error("missing new callback");
  h.client.close();
  currentCallback("ops", frameMessage({ ...welcome, features: [DRAFT_LEVELS_FEATURE] }));
  expect(h.client.supportsFeature(DRAFT_LEVELS_FEATURE)).toBe(false); h.pair.a.close();
});

test("unnegotiated draft snapshots cannot hydrate a replica", async () => {
  const h = fixture(); await h.send(welcome);
  await h.send({ kind: "snapshot", seq: 1, manifest: {}, world: { seq: 1, collections: { scenes: [{ _id: "s", levels: [draftLevel("secret", "Secret")] } as never] } } });
  expect(h.kicks[0]).toContain("unnegotiated"); expect(h.client.store.seq).toBe(0);
  expect(h.client.store.get("scenes", "s")).toBeUndefined();
});

test("ambient capability covers level create/update/removal and scene replacements, not scene darkness", async () => {
  const { LEVEL_AMBIENT_FEATURE, requiredOpFeatures, requiredWorldFeatures } = await import("../../src/core/capabilities");
  const l = { ...draftLevel("a", "A"), darkness: 0 };
  const parent = { coll: "scenes" as const, id: "s" }, ref = { coll: "levels" as const, id: "a", parent };
  const ops: Op[] = [
    { kind: "create", coll: "levels", parent, data: l },
    { kind: "create", coll: "scenes", data: { _id: "s", levels: [l] } as never },
    ...["darkness", "-=darkness"].map((key): Op => ({ kind: "update", ref, diff: { [key]: key.startsWith("-=") ? null : 1 } })),
    ...[{ levels: [l] }, { "levels.0": l }, { "levels.0.darkness": 0 }, { "-=levels.0.darkness": null }].map((diff): Op => ({ kind: "update", ref: parent, diff: diff as never })),
  ];
  for (const op of ops) expect(requiredOpFeatures([op])).toEqual([DRAFT_LEVELS_FEATURE, LEVEL_AMBIENT_FEATURE]);
  expect(requiredOpFeatures([{ kind: "update", ref: parent, diff: { darkness: 1 } }])).toEqual([]);
  expect(requiredWorldFeatures([{ levels: [l] } as never], "GM")).toEqual([DRAFT_LEVELS_FEATURE, LEVEL_AMBIENT_FEATURE]);
  expect(requiredWorldFeatures([{ levels: [l] } as never], "PLAYER")).toEqual([]);
  const h = fixture(); await h.send({ ...welcome, features: [DRAFT_LEVELS_FEATURE] });
  await expect(h.client.submitAndWait([ops[0] as Op])).rejects.toThrow("Upgrade required");
  expect(h.frames.some((m) => m.kind === "intent")).toBe(false);
  h.client.close();
});

test("floor focus accepts only latest request/revision and clears on reconnect", async () => {
  const { LEVEL_NAVIGATION_FEATURE } = await import("../../src/core/levelNavigation");
  const h = fixture(); h.client.connect(hello); await flushMicrotasks();
  await h.send(welcome); expect(() => h.client.requestLevelFocus("s", null)).toThrow("Upgrade");
  await h.send({ ...welcome, features: [LEVEL_NAVIGATION_FEATURE] });
  h.client.requestLevelFocus("s", "a"); await flushMicrotasks();
  const first = h.frames.at(-1); if (first?.kind !== "level.focus") throw new Error("request missing");
  h.client.requestLevelFocus("s", "b"); await flushMicrotasks();
  const second = h.frames.at(-1); if (second?.kind !== "level.focus") throw new Error("request missing");
  await h.send({ kind: "level.focus.state", requestId: first.requestId, sceneId: "s", revision: 1, levels: [{ id: "a", name: "A" }], levelId: "a", tokenIds: ["ta"] });
  expect(h.client.levelFocus).toBeNull();
  const state = { kind: "level.focus.state" as const, requestId: second.requestId, sceneId: "s", revision: 2, levels: [{ id: "b", name: "B" }], levelId: "b", tokenIds: ["tb"] };
  await h.send(state); expect(h.client.levelFocus?.levelId).toBe("b");
  await h.send({ ...state, revision: 1, levelId: null, tokenIds: null }); expect(h.client.levelFocus?.levelId).toBe("b");
  h.client.reattach(createTransportPair().b); expect(h.client.levelFocus).toBeNull(); h.client.close();
});
