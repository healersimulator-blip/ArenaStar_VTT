import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import { AIS_CAPABILITIES } from "../../src/core/automationInterconnect";
import type { ActorDocument, SceneDocument } from "../../src/core/documents";
import {
  AIS_MAX_RPC_BYTES, AIS_MODULE_METHODS, createAisModuleDispatcher,
  type AisModuleHandlers, type AisModuleRequestContext, type AisModuleResponse,
} from "../../src/packages/aisModuleIframe";
import {
  createAisModuleHandlers, createAisMutationQueue, type AisModuleHandlerContext,
} from "../../src/packages/aisModuleHandlers";
import { openVttDb, getAllSettings, type WorldsRecord } from "../../src/storage/idb";
import { assertAisModuleConsent } from "../../src/app/aisRuntime";
import type { HostAutomationModuleBoot } from "../../src/app/hostBoot";

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("missing test fixture");
  return value;
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const request = (id: number, method = "scene.read.visible", args: unknown = {}) =>
  ({ vttAisRpc: 1, kind: "request", id, method, args });
const handlers = (): AisModuleHandlers => Object.fromEntries(
  AIS_MODULE_METHODS.map((method) => [method, vi.fn(async () => ({ ok: true }))]),
) as unknown as AisModuleHandlers;

describe("AIS RPC admission and lifecycle", () => {
  test("failed dynamic subscription approval never registers an observer", async () => {
    const calls = handlers();
    calls["events.subscribe"] = async () => { throw new Error("approval revoked"); };
    const subscribe = vi.fn();
    const post = vi.fn();
    createAisModuleDispatcher(calls, new Set(["action.observe"]), subscribe)
      .onFrame(request(1, "events.subscribe", { event: "world.snapshot" }), post);
    await tick();
    expect(subscribe).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "approval revoked" }));
  });

  test("duplicate and replayed IDs cannot repeat a mutating request", async () => {
    const calls = handlers();
    const dispatcher = createAisModuleDispatcher(calls, new Set(["chat.post"]), vi.fn());
    const post = vi.fn();
    dispatcher.onFrame(request(1, "chat.post", { content: "once" }), post);
    dispatcher.onFrame(request(1, "chat.post", { content: "twice" }), post);
    await tick();
    dispatcher.onFrame(request(1, "chat.post", { content: "replay" }), post);
    await tick();
    expect(calls["chat.post"]).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test.each([[], "text", { value: Infinity }, { value: new Date(0) }, JSON.parse('{"constructor":1}')].map((args) => ({ args })))(
    "non-JSON or non-record arguments never reach a handler: %j", async ({ args }) => {
      const calls = handlers();
      const post = vi.fn();
      createAisModuleDispatcher(calls, new Set(["scene.read.visible"]), vi.fn()).onFrame(request(1, "scene.read.visible", args), post);
      await tick();
      expect(calls["scene.read.visible"]).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  test("a result that overflows the RESPONSE envelope returns an error rather than disappearing", async () => {
    const calls = handlers();
    calls["scene.read.visible"] = () => "x".repeat(AIS_MAX_RPC_BYTES - 5);
    const post = vi.fn();
    createAisModuleDispatcher(calls, new Set(["scene.read.visible"]), vi.fn()).onFrame(request(1), post);
    await tick();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ok: false, error: expect.stringContaining("size limit") }));
  });

  test("32 concurrent requests are admitted, the next is refused, and completed slots recover", async () => {
    const calls = handlers();
    const releases: Array<() => void> = [];
    calls["scene.read.visible"] = () => new Promise((resolve) => releases.push(() => resolve(null)));
    const dispatcher = createAisModuleDispatcher(calls, new Set(["scene.read.visible"]), vi.fn());
    const posted: AisModuleResponse[] = [];
    for (let id = 1; id <= 33; id++) dispatcher.onFrame(request(id), (response) => posted.push(response));
    expect(releases).toHaveLength(32);
    expect(posted).toMatchObject([{ id: 33, ok: false, error: "AIS RPC concurrency limit exceeded" }]);
    releases.forEach((release) => release());
    await tick();
    dispatcher.onFrame(request(34), (response) => posted.push(response));
    expect(releases).toHaveLength(33);
    releases[32]?.();
    await tick();
    expect(posted.at(-1)).toMatchObject({ id: 34, ok: true });
  });

  test("the per-second budget refuses floods and resets without relaxing grants", async () => {
    const calls = handlers();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const dispatcher = createAisModuleDispatcher(calls, new Set(), vi.fn());
      const posted: AisModuleResponse[] = [];
      for (let id = 1; id <= 121; id++) dispatcher.onFrame(request(id), (response) => posted.push(response));
      expect(posted.at(-1)?.error).toBe("AIS RPC rate limit exceeded");
      clock.mockReturnValue(2001);
      dispatcher.onFrame(request(122), (response) => posted.push(response));
      expect(posted.at(-1)?.error).toBe("Capability not granted: scene.read.visible");
      expect(calls["scene.read.visible"]).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  test("stopping an instance closes admission and drops already-pending replies", async () => {
    const calls = handlers();
    let running = true;
    let release!: () => void;
    calls["scene.read.visible"] = () => new Promise((resolve) => { release = () => resolve({ private: true }); });
    const lifetime: AisModuleRequestContext = {
      isActive: () => running,
      assertActive: () => { if (!running) throw new Error("stopped"); },
    };
    const dispatcher = createAisModuleDispatcher(calls, new Set(["scene.read.visible"]), vi.fn(), lifetime);
    const post = vi.fn();
    dispatcher.onFrame(request(1), post);
    running = false;
    release();
    dispatcher.onFrame(request(2), post);
    await tick();
    expect(post).not.toHaveBeenCalled();
  });
});

async function fixture() {
  const db = await openVttDb();
  const actor = { _id: "actor-1", name: "Bearer", items: [
    { _id: "torch-1", name: "Torch", system: { quantity: 2 } },
  ] } as unknown as ActorDocument;
  const scene = { _id: "scene-1", name: "Hall", grid: { size: 100, distance: 5, units: "ft" }, tokens: [
    { _id: "token-1", name: "Bearer", actorId: actor._id, hidden: false, flags: { other: { keep: true } },
      light: { radius: 0, color: "#ffffff", alpha: 0.8 } },
  ] } as unknown as SceneDocument;
  const context: AisModuleHandlerContext = {
    db, worldId: `ais-test-${crypto.randomUUID()}`, packageId: "probe", emittedEvents: [],
    user: () => ({ id: "gm", name: "GM" }), activeScene: () => scene,
    actorById: (id) => id === actor._id ? actor : undefined, select: async () => null,
    submit: vi.fn(async () => "tx-accepted"), notify: vi.fn(), emitModuleEvent: vi.fn(),
    newId: () => "message-1", assertCapability: async () => {},
  };
  return { db, actor, scene, context };
}
const lightRequest = {
  sceneId: "scene-1", tokenId: "token-1", sourceId: "torch", sourceName: "Torch",
  sourceItemId: "torch-1", consumeItemId: "torch-1", stateIndex: 1, active: true,
  light: { radius: 800, bright: 400, color: "#ffaa88", alpha: 0.8, angle: 360 },
};

describe("AIS authoritative writes", () => {
  test("host rejection is an RPC rejection, not a success-shaped transaction ID", async () => {
    const { db, context } = await fixture();
    context.submit = vi.fn(async () => { throw new Error("host refused the write"); });
    try {
      const api = createAisModuleHandlers(context);
      await expect(api["scene.token.light.apply"](lightRequest)).rejects.toThrow("host refused");
      await expect(api["chat.post"]({ content: "hello" })).rejects.toThrow("host refused");
    } finally { db.close(); }
  });

  test("concurrent consumption across two modules uses current inventory and preserves unrelated flags", async () => {
    const { db, actor, context } = await fixture();
    context.mutate = createAisMutationQueue();
    const quantities: unknown[] = [];
    const diffs: unknown[] = [];
    context.submit = async (ops) => {
      await tick(); // real submission waits for its acknowledgement
      for (const op of ops) if (op.kind === "update") {
        if (op.ref.coll === "items") {
          required(actor.items[0]).system.quantity = required(op.diff["system.quantity"]);
          quantities.push(required(actor.items[0]).system.quantity);
        } else diffs.push(op.diff);
      }
      return "tx-accepted";
    };
    try {
      const one = createAisModuleHandlers(context);
      const two = createAisModuleHandlers({ ...context, packageId: "other-probe" });
      const results = await Promise.allSettled([
        one["scene.token.light.apply"](lightRequest), two["scene.token.light.apply"](lightRequest),
        one["scene.token.light.apply"](lightRequest),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
      expect(quantities).toEqual([1, 0]);
      // The fixture token has no `flags.ais` yet: the namespace is created whole, never `flags`.
      expect(diffs[0]).toHaveProperty(["flags.ais", "probe"]);
      expect(diffs[0]).not.toHaveProperty("flags");
      expect(diffs[0]).not.toHaveProperty(["flags.ais", "other"]);
    } finally { db.close(); }
  });

  test("a token hidden during the extra consume-grant await is not written", async () => {
    const { db, scene, context } = await fixture();
    context.assertCapability = async (capability) => {
      if (capability === "actor.inventory.consume") required(scene.tokens[0]).hidden = true;
    };
    try {
      await expect(createAisModuleHandlers(context)["scene.token.light.apply"](lightRequest)).rejects.toThrow("not visible");
      expect(context.submit).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  test("bounded inventory reads cannot probe actors without a visible linked token", async () => {
    const { db, scene, context } = await fixture();
    try {
      const api = createAisModuleHandlers(context);
      expect(await api["actor.inventory.read"]({ actorId: "actor-1" })).toHaveProperty("items");
      required(scene.tokens[0]).hidden = true;
      await expect(api["actor.inventory.read"]({ actorId: "actor-1" })).rejects.toThrow("not linked");
    } finally { db.close(); }
  });

  test("queued writes cannot outlive the instance that requested them", async () => {
    const { db, context } = await fixture();
    let running = true;
    let release!: () => void;
    context.mutate = createAisMutationQueue();
    const blocked = context.mutate(() => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    const lifetime = { isActive: () => running, assertActive: () => { if (!running) throw new Error("stopped"); } };
    const pending = createAisModuleHandlers(context)["scene.token.light.apply"](lightRequest, lifetime);
    const expectation = expect(pending).rejects.toThrow("stopped");
    running = false;
    release();
    try { await blocked; await expectation; expect(context.submit).not.toHaveBeenCalled(); }
    finally { db.close(); }
  });

  test("concurrent storage writes cannot race past the 128 KiB module quota", async () => {
    const { db, context } = await fixture();
    try {
      const api = createAisModuleHandlers(context);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
        api["module.storage.set"]({ key: `key-${i}`, value: "x".repeat(16 * 1024 - 2) }),
      ));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
      expect(await getAllSettings(db, `ais:${context.worldId}:probe`)).toHaveLength(8);
      // An error does not poison the serial queue.
      await expect(api["module.storage.set"]({ key: "key-0", value: null })).resolves.toEqual({ ok: true });
    } finally { db.close(); }
  });

  test("a choice cannot return authorized data after revocation or instance disposal", async () => {
    const { db, context } = await fixture();
    let allowed = true;
    context.assertCapability = async () => { if (!allowed) throw new Error("revoked"); };
    context.select = async () => { allowed = false; return "yes"; };
    try {
      await expect(createAisModuleHandlers(context)["ui.select"]({ title: "Choose", options: [{ value: "yes", label: "Yes" }] }))
        .rejects.toThrow("revoked");
    } finally { db.close(); }
  });
});

describe("AIS exact boot identity and local consent", () => {
  const module: HostAutomationModuleBoot = {
    packageId: "probe", name: "Probe", version: "1.0.0", hash: "abc", sharedWithPlayers: true, source: "", capabilities: [...AIS_CAPABILITIES], commands: [], emittedEvents: [],
  };
  const world = (): WorldsRecord => ({
    worldId: "world-probe" as WorldsRecord["worldId"], name: "Probe", system: "test", version: "1.0.0",
    lastOpened: 0, flushedSeq: 0, oplogBase: 0,
    automationProfile: {
    api: "arena.ais/1", modules: [{ id: "probe", version: "1.0.0", hash: "abc" }], providers: {},
  }, automationGrants: { probe: { hash: "abc", capabilities: [...AIS_CAPABILITIES] } } });

  test("successful assertions return void and do not require a truthy sentinel", () => {
    expect(assertAisModuleConsent(world(), module, "ui.notify")).toBeUndefined();
  });
  test("profile presence, exact version/hash, grant hash and live capabilities are independent gates", () => {
    for (const changed of [undefined, {}, { ...world(), automationProfile: { ...required(world().automationProfile), modules: [] } },
      { ...world(), automationGrants: {} },
      { ...world(), automationGrants: { probe: { hash: "changed", capabilities: [...AIS_CAPABILITIES] } } }]) {
      expect(() => assertAisModuleConsent(changed as WorldsRecord | undefined, module)).toThrow("approval");
    }
    expect(() => assertAisModuleConsent(world(), { ...module, version: "2.0.0" })).toThrow("approval");
    expect(() => assertAisModuleConsent(world(), { ...module, hash: "changed" })).toThrow("approval");
    const revoked = world(); required(required(revoked.automationGrants).probe).capabilities = [];
    expect(() => assertAisModuleConsent(revoked, module, "ui.notify")).toThrow("capability");
    expect(() => assertAisModuleConsent(world(), { ...module, capabilities: [] }, "ui.notify")).toThrow("capability");
  });
});
