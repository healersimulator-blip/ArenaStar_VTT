import { runInNewContext } from "node:vm";
import { resolveObjectURL } from "node:buffer";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runScriptWorker, scriptWorkerSource } from "../../src/host/scriptWorker";

interface WorkerMessage { kind: string; id?: number; method?: string; payload?: unknown; result?: unknown; error?: string }

/** Execute the same Worker source against a minimal postMessage harness (no browser download). */
function harness(source: string) {
  const messages: WorkerMessage[] = [];
  const scope: {
    postMessage: (value: WorkerMessage) => void;
    onmessage?: (event: { data: unknown }) => void;
    fetch?: unknown;
  } = { postMessage: (value) => messages.push(value), fetch: () => "network" };
  runInNewContext(scriptWorkerSource(source), { self: scope, Map, Error, Promise, setTimeout });
  const send = (data: unknown) => scope.onmessage?.({ data });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { messages, scope, send, flush };
}

describe("GM script Worker source (classic blob, CSP-compatible compilation)", () => {
  test("executes async conditionals/loops and awaits tag RPC before returning JSON", async () => {
    const h = harness(`const hits = await api.tags.find(args.query, { pattern: 'wildcard' });
for (const hit of hits) await api.tags.edit([hit.ref], 'add', ['opened']);
return { found: hits.length, by: context.callerId };`);
    expect(h.scope.fetch).toBeUndefined(); // best-effort network defence, NOT a hostile-code sandbox
    h.send({ kind: "start", args: { query: "door-*" }, context: { callerId: "gm" } });
    await h.flush();
    expect(h.messages.map((m) => m.method)).toEqual(["tags.find"]);
    expect(h.messages[0]?.payload).toEqual({ query: "door-*", options: { pattern: "wildcard" } });
    h.send({ kind: "response", id: h.messages[0]?.id, ok: true, result: [
      { ref: { coll: "tokens", id: "t1" } }, { ref: { coll: "tokens", id: "t2" } },
    ] });
    await h.flush();
    expect(h.messages[1]?.method).toBe("tags.edit");
    h.send({ kind: "response", id: h.messages[1]?.id, ok: true, result: { changed: 1 } });
    await h.flush();
    expect(h.messages[2]?.method).toBe("tags.edit");
    h.send({ kind: "response", id: h.messages[2]?.id, ok: true, result: { changed: 1 } });
    await h.flush();
    expect(h.messages.at(-1)).toMatchObject({ kind: "done", result: { found: 2, by: "gm" } });
  });

  test("an exception is an explicit error, not a silent successful macro", async () => {
    const h = harness("throw new Error('No target found');");
    h.send({ kind: "start", args: {}, context: {} });
    await h.flush();
    expect(h.messages).toEqual([{ kind: "error", error: "No target found" }]);
  });
});

/** Tests the real main-thread runner against a VM-backed Worker shim (no browser binary). */
class WorkerShim {
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private stopped = false;
  private readonly ready: Promise<{ onmessage?: (event: { data: unknown }) => void }>;
  constructor(url: string) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error("Missing worker Blob");
    this.ready = blob.text().then((code) => {
      const scope: {
        postMessage: (value: WorkerMessage) => void;
        onmessage?: (event: { data: unknown }) => void;
      } = { postMessage: (value) => queueMicrotask(() => {
        if (!this.stopped) this.onmessage?.({ data: structuredClone(value) });
      }) };
      try { runInNewContext(code, { self: scope, Map, Error, Promise, setTimeout }); }
      catch (error) { this.onerror?.({ message: String(error), preventDefault() {} }); }
      return scope;
    });
  }
  postMessage(data: unknown): void {
    void this.ready.then((scope) => queueMicrotask(() => {
      if (!this.stopped) scope.onmessage?.({ data: structuredClone(data) });
    }));
  }
  terminate(): void { this.stopped = true; }
}

afterEach(() => vi.unstubAllGlobals());

describe("script runner RPC and termination", () => {
  test("real runner forwards valid async RPCs, including optional IDs, and returns a bounded JSON result", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const actions: string[] = [];
    const result = await runScriptWorker(`const hits = await api.tags.find('door-*', { pattern: 'wildcard' });
await api.fx.play('fx-1');
await api.automation.fire('zone-1');
return { count: hits.length, caller: context.callerId };`, {},
    { sceneId: "s1", callerId: "gm", requestId: "run1" }, async (method, payload, active) => {
      expect(active()).toBe(true);
      actions.push(method);
      if (method === "fx.play") expect(payload).toEqual({ macroId: "fx-1" });
      if (method === "automation.fire") expect(payload).toEqual({ automationId: "zone-1", method: "click" });
      return method === "tags.find" ? [{ ref: { coll: "tokens", id: "t1" } }] : null;
    }, 500);
    expect(result).toEqual({ count: 1, caller: "gm" });
    expect(actions).toEqual(["tags.find", "fx.play", "automation.fire"]);
  });

  test("Tagger-style script helpers route projected reads and authorized bulk writes through host RPCs", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const ref = { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } };
    const calls: Array<{ method: string; payload: unknown }> = [];
    const result = await runScriptWorker(`const ref = args.ref;
const untagged = await api.tags.getTags(ref);
const absent = await api.tags.hasTags(ref, 'trap');
await api.tags.addTags([ref], ['trap']);
const present = await api.tags.hasTags(ref, 'trap');
const hits = await api.tags.getByTag('trap', { collections: ['tiles'] });
await api.tags.toggleTags([ref], ['trap']);
await api.tags.setTags([ref], ['door']);
await api.tags.removeTags([ref], ['door']);
await api.tags.clearAllTags([ref]);
return { untagged, absent, present, hits: hits.length };`, { ref },
    { sceneId: "s1", callerId: "gm", requestId: "tagger-api" }, async (method, payload) => {
      calls.push({ method, payload });
      if (method === "tags.get") return [];
      if (method === "tags.find") return calls.filter((call) => call.method === "tags.edit").length === 1
        ? [{ ref }] : [];
      return { changed: 1 };
    }, 1000);
    expect(result).toEqual({ untagged: [], absent: false, present: true, hits: 1 });
    expect(calls.map(({ method }) => method)).toEqual(["tags.get", "tags.find", "tags.edit", "tags.find",
      "tags.find", "tags.edit", "tags.edit", "tags.edit", "tags.edit"]);
    expect(calls[1]?.payload).toEqual({ query: "trap", options: { sceneId: "s1", includeRefs: [ref] } });
    expect(calls[3]?.payload).toEqual({ query: "trap", options: { sceneId: "s1", includeRefs: [ref] } });
    expect(calls[4]?.payload).toEqual({ query: "trap", options: { collections: ["tiles"] } });
    expect(calls.filter(({ method }) => method === "tags.edit").map(({ payload }) => payload))
      .toEqual([
        { refs: [ref], edit: "add", tags: ["trap"] },
        { refs: [ref], edit: "toggle", tags: ["trap"] },
        { refs: [ref], edit: "replace", tags: ["door"] },
        { refs: [ref], edit: "remove", tags: ["door"] },
        { refs: [ref], edit: "replace", tags: [] },
      ]);
  });

  test("the reviewed Worker exposes awaited, explicit-ref Tagger rule application", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const ref = { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } };
    const seen: Array<{ method: string; payload: unknown }> = [];
    const result = await runScriptWorker(`return await api.tags.applyTagRules([args.ref]);`, { ref },
      { sceneId: "s1", callerId: "player", requestId: "tag-rules" }, async (method, payload) => {
        seen.push({ method, payload });
        return { changed: 1, seq: 4 };
      }, 500);
    expect(seen).toEqual([{ method: "tags.rules", payload: { refs: [ref] } }]);
    expect(result).toEqual({ changed: 1, seq: 4 });
  });

  test("Tagger all-scene and explicit-ref helpers scope a remote scene without widening caller entitlement", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const ref = { coll: "tiles", id: "gate", parent: { coll: "scenes", id: "s2" } };
    const calls: Array<{ method: string; payload: unknown }> = [];
    const result = await runScriptWorker(`const distant = args.ref;
const tags = await api.tags.getTags(distant);
const matched = await api.tags.hasTags(distant, 'door', { groupByScene: true });
const groups = await api.tags.getByTag('door', { allScenes: true, groupByScene: true });
return { tags, matched, scenes: Object.keys(groups) };`, { ref },
    { sceneId: "s1", callerId: "player", requestId: "cross-scene" }, async (method, payload) => {
      calls.push({ method, payload });
      if (method === "tags.get") return ["door"];
      if (calls.length === 2) return [{ ref }];
      return { s2: [{ ref }] };
    }, 1000);
    expect(result).toEqual({ tags: ["door"], matched: true, scenes: ["s2"] });
    expect(calls.map(({ method }) => method)).toEqual(["tags.get", "tags.find", "tags.find"]);
    expect(calls[1]?.payload).toEqual({ query: "door", options: { sceneId: "s2",
      groupByScene: false, includeRefs: [ref] } });
    expect(calls[2]?.payload).toEqual({ query: "door", options: { allScenes: true, groupByScene: true } });
  });

  test("a reviewed script lists and atomically ends matching named FX through granted host RPCs", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const actions: string[] = [];
    const result = await runScriptWorker(`const owned = await api.fx.list({ name: 'ward*', macroId: 'ward-fx' });
const ended = await api.fx.stopMatching({ name: 'ward*', macroId: 'ward-fx' });
return { names: owned.map(row => row.name), stopped: ended.stopped };`, {},
    { sceneId: "s1", callerId: "player", requestId: "run-fx-filter" }, async (method, payload) => {
      actions.push(method);
      expect(payload).toEqual({ filter: { name: "ward*", macroId: "ward-fx" } });
      return method === "fx.list" ? [{ runId: "fx-1", name: "Ward A" }] : { stopped: 1 };
    }, 500);
    expect(actions).toEqual(["fx.list", "fx.stopMatching"]);
    expect(result).toEqual({ names: ["Ward A"], stopped: 1 });
  });

  test("a reviewed FX chain awaits a host-clock cue, overlaps a parallel lane, calls a macro and returns ordered results", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const actions: Array<{ method: string; payload: unknown }> = [];
    const result = await runScriptWorker(`return await api.fx.sequence()
  .parallel((api) => api.fx.play('left'), (api) => api.fx.play('right'))
  .wait(2).playAndWait('short')
  .thenDo(async (api, last) => (await api.chat.say('after ' + last.runId, 'gm')).messageId)
  .call('next-script', { choice: true }).run();`, {},
    { sceneId: "s1", callerId: "gm", requestId: "fx-chain" }, async (method, payload) => {
      actions.push({ method, payload });
      if (method === "fx.play") {
        const call = payload as { macroId: string };
        return { runId: call.macroId, atHostTime: Date.now(), endsAtHostTime: Date.now() + 3,
          persistent: false };
      }
      if (method === "chat.say") return { messageId: "message-after" };
      return { choice: "passed" };
    }, 1000);
    expect(actions.map((call) => call.method))
      .toEqual(["fx.play", "fx.play", "fx.play", "chat.say", "macros.call"]);
    expect(actions[2]?.payload).toEqual({ macroId: "short", waitForEnd: true });
    expect(actions[3]?.payload).toEqual({ content: "after short", audience: "gm" });
    expect(result).toMatchObject({ timeline: [
      { kind: "parallel", result: [{ runId: "left" }, { runId: "right" }] },
      { kind: "wait", result: 2 },
      { kind: "play", result: { runId: "short" } },
      { kind: "callback", result: "message-after" },
      { kind: "macro", result: { choice: "passed" } },
    ] });
    const invalid = await runScriptWorker(`const chain = api.fx.sequence();
for (let i = 0; i < 33; i++) chain.wait(0);
return chain.run();`, {},
    { sceneId: "s1", callerId: "gm", requestId: "bad-chain" }, async () => {
      throw new Error("Unexpected RPC from invalid FX chain");
    }, 500).catch((err: unknown) => err);
    expect(invalid).toBeInstanceOf(Error);
    expect(String(invalid)).toMatch(/32 sections/);
  });

  test("a reviewed script can stop an FX instance using the run ID returned by play", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const actions: string[] = [];
    const result = await runScriptWorker(`const instance = await api.fx.play('caller-aura');
const end = await api.fx.stop(instance.runId);
return { runId: instance.runId, stopped: end.stopped };`, {},
    { sceneId: "s1", callerId: "player", requestId: "run-stop" }, async (method, payload) => {
      actions.push(method);
      if (method === "fx.play") {
        expect(payload).toEqual({ macroId: "caller-aura" });
        return { runId: "live-123" };
      }
      expect(payload).toEqual({ runId: "live-123" });
      return { stopped: true };
    }, 500);
    expect(actions).toEqual(["fx.play", "fx.stop"]);
    expect(result).toEqual({ runId: "live-123", stopped: true });
  });

  test("Worker exposes awaitable summon placement and dismissal without forwarding arbitrary actor data", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    const actions: string[] = [];
    const result = await runScriptWorker(`const summon = await api.summons.place('approved-wolf', 350, 250, args.caster);
return await api.summons.dismiss(summon.tokenId);`, { caster: "t-owner" },
    { sceneId: "s1", callerId: "player", requestId: "run-summon" }, async (method, payload, active) => {
      expect(active()).toBe(true);
      actions.push(method);
      if (method === "summons.place") {
        expect(payload).toEqual({ presetId: "approved-wolf", at: { x: 350, y: 250 },
          summonerTokenId: "t-owner" });
        return { tokenId: "instance-1", seq: 4 };
      }
      expect(payload).toEqual({ tokenId: "instance-1" });
      return { dismissed: true, seq: 5 };
    }, 500);
    expect(actions).toEqual(["summons.place", "summons.dismiss"]);
    expect(result).toEqual({ dismissed: true, seq: 5 });
  });

  test("after completion a non-awaited delayed action loses liveness and cannot commit", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    let lateCommits = 0;
    const result = await runScriptWorker("api.macros.call('child'); return { ok: true };", {},
      { sceneId: "s1", callerId: "gm", requestId: "run2" }, async (_method, _payload, active) => {
        await new Promise((r) => setTimeout(r, 15));
        if (active()) lateCommits++;
        return null;
      }, 500);
    expect(result).toEqual({ ok: true });
    expect(lateCommits).toBe(0);
  });

  test("a large host action result fails explicitly instead of flooding the Worker", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    await expect(runScriptWorker("await api.tags.find('too-broad'); return 1;", {},
      { sceneId: "s1", callerId: "gm", requestId: "run-large" },
      async () => "x".repeat(20_000), 500)).rejects.toThrow(/result exceeds 16 KiB/);
  });

  test("a stalled worker is terminated at deadline, not mistaken for success", async () => {
    vi.stubGlobal("Worker", WorkerShim);
    await expect(runScriptWorker("await new Promise(() => {});", {},
      { sceneId: "s1", callerId: "gm", requestId: "run3" }, async () => null, 20))
      .rejects.toThrow(/timed out/);
  });
});
