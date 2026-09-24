/**
 * Host-tab JS macro runner. Source is compiled as the body of a classic blob
 * Worker (no eval/Function, compatible with the page CSP). It never runs in a
 * player tab or the host DOM. This is for EXPLICITLY GM-reviewed code only:
 * browser workers are not a security sandbox for hostile code (network APIs
 * and resource exhaustion vary by browser). World access is exclusively via
 * individually checked host RPCs; the host terminates the worker on timeout.
 */
import type { Json } from "../core/documents";
import { boundedJson, type ScriptArgs } from "../core/scriptMacros";

export interface ScriptContext {
  sceneId: string;
  callerId: string;
  requestId: string;
}
export type ScriptAction = (method: string, payload: unknown, isActive: () => boolean) => Promise<Json>;
export type ScriptRunner = (
  source: string, args: ScriptArgs, context: ScriptContext,
  action: ScriptAction, timeoutMs: number,
) => Promise<Json>;

/** Kept pure so a worker harness can test the actual authored JS without a browser. */
export function scriptWorkerSource(source: string): string {
  return `"use strict";
// Defence in depth, NOT an origin or capability boundary. Only reviewed code is allowed.
for (const name of ["fetch", "WebSocket", "EventSource", "importScripts", "BroadcastChannel", "indexedDB", "caches", "XMLHttpRequest", "Worker"]) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch (_) {}
}
let nextCall = 0;
const waiting = new Map();
const rpc = (method, payload) => new Promise((resolve, reject) => {
  const id = ++nextCall;
  waiting.set(id, { resolve, reject });
  try { self.postMessage({ kind: "call", id, method, payload }); }
  catch (error) { waiting.delete(id); reject(error); }
});
// Sequencer-style composition inside the *reviewed* Worker. The host remains
// the only authority for FX grants, recipients, assets and nested macro calls.
// Waiting means the host-clock cue window ended, NOT every client's decode or
// playback succeeded. Earlier actions are not rolled back if a later one fails.
const fxPlay = (macroId, sourceTokenId, targetTokenId, waitForEnd = false) =>
  rpc("fx.play", { macroId,
    ...(sourceTokenId !== undefined ? { sourceTokenId } : {}),
    ...(targetTokenId !== undefined ? { targetTokenId } : {}),
    ...(waitForEnd ? { waitForEnd: true } : {}) });
const fxWait = async (cue) => {
  if (!cue || cue.persistent !== false || !Number.isFinite(cue.endsAtHostTime))
    throw new Error("Only a finite, nonpersistent FX cue can be awaited");
  const remaining = Math.max(0, Math.ceil(cue.endsAtHostTime - Date.now()));
  if (remaining > 7000) throw new Error("FX cue cannot finish within the Worker deadline");
  if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
  return cue;
};
const fxSequence = () => {
  const steps = [];
  let started = false;
  const add = (step) => {
    if (started || steps.length >= 32) throw new Error("FX chain is already running or exceeds 32 sections");
    steps.push(step);
    return chain;
  };
  const chain = Object.freeze({
    play: (macroId, sourceTokenId, targetTokenId) =>
      add({ kind: "play", macroId, sourceTokenId, targetTokenId, awaitEnd: false }),
    playAndWait: (macroId, sourceTokenId, targetTokenId) =>
      add({ kind: "play", macroId, sourceTokenId, targetTokenId, awaitEnd: true }),
    wait: (ms) => {
      if (!Number.isInteger(ms) || ms < 0 || ms > 5000) throw new Error("FX wait must be 0–5000 ms");
      return add({ kind: "wait", ms });
    },
    call: (macroId, args = {}) => add({ kind: "macro", macroId, args }),
    thenDo: (fn) => {
      if (typeof fn !== "function") throw new Error("FX callback must be a reviewed function");
      return add({ kind: "callback", fn });
    },
    parallel: (...jobs) => {
      if (!jobs.length || jobs.length > 8 || jobs.some((job) => typeof job !== "function"))
        throw new Error("FX parallel group needs 1–8 reviewed callbacks");
      return add({ kind: "parallel", jobs });
    },
    run: async () => {
      if (started) throw new Error("FX chain cannot run twice");
      started = true;
      const timeline = [];
      let waited = 0;
      for (const step of steps) {
        let result = null;
        if (step.kind === "play") {
          const cue = await fxPlay(step.macroId, step.sourceTokenId, step.targetTokenId, step.awaitEnd);
          result = step.awaitEnd ? await fxWait(cue) : cue;
        } else if (step.kind === "wait") {
          waited += step.ms;
          if (waited > 7000) throw new Error("FX chain exceeds its wait budget");
          if (step.ms) await new Promise((resolve) => setTimeout(resolve, step.ms));
          result = step.ms;
        } else if (step.kind === "macro") result = await api.macros.call(step.macroId, step.args);
        else if (step.kind === "callback") result = await step.fn(api, timeline.at(-1)?.result);
        else if (step.kind === "parallel") result = await Promise.all(step.jobs.map((job) => job(api)));
        timeline.push({ kind: step.kind, result: result === undefined ? null : result });
      }
      return { timeline };
    },
  });
  return chain;
};
const api = Object.freeze({
  chat: Object.freeze({ say: (content, audience = "scene") => rpc("chat.say", { content, audience }) }),
  tags: Object.freeze({
    find: (query, options = {}) => rpc("tags.find", { query, options }),
    getByTag: (query, options = {}) => rpc("tags.find", { query, options }),
    getTags: (ref) => rpc("tags.get", { ref }),
    hasTags: async (ref, query, options = {}) => {
      const refScene = ref?.coll === "scenes" ? ref.id : ref?.parent?.id;
      const scoped = options.allScenes === true || options.sceneId !== undefined || typeof refScene !== "string"
        ? options : { ...options, sceneId: refScene };
      return (await rpc("tags.find", { query, options: { ...scoped,
        ...(scoped.groupByScene ? { groupByScene: false } : {}), includeRefs: [ref] } })).length > 0;
    },
    edit: (refs, edit, tags) => rpc("tags.edit", { refs, edit, tags }),
    setTags: (refs, tags) => rpc("tags.edit", { refs, edit: "replace", tags }),
    addTags: (refs, tags) => rpc("tags.edit", { refs, edit: "add", tags }),
    removeTags: (refs, tags) => rpc("tags.edit", { refs, edit: "remove", tags }),
    toggleTags: (refs, tags) => rpc("tags.edit", { refs, edit: "toggle", tags }),
    clearAllTags: (refs) => rpc("tags.edit", { refs, edit: "replace", tags: [] }),
    applyTagRules: (refs) => rpc("tags.rules", { refs }),
  }),
  fx: Object.freeze({
    play: (macroId, sourceTokenId, targetTokenId) => fxPlay(macroId, sourceTokenId, targetTokenId),
    playAndWait: async (macroId, sourceTokenId, targetTokenId) =>
      fxWait(await fxPlay(macroId, sourceTokenId, targetTokenId, true)),
    sequence: fxSequence,
    stop: (runId) => rpc("fx.stop", { runId }),
    list: (filter = {}) => rpc("fx.list", { filter }),
    stopMatching: (filter) => rpc("fx.stopMatching", { filter }),
  }),
  automation: Object.freeze({ fire: (automationId, method = "click", tokenId) =>
    rpc("automation.fire", { automationId, method,
      ...(tokenId !== undefined ? { tokenId } : {}) }) }),
  macros: Object.freeze({ call: (macroId, args = {}) => rpc("macros.call", { macroId, args }) }),
  prefabs: Object.freeze({ place: (prefabId, x, y, rotation = 0, scale = 1) =>
    rpc("prefabs.place", { prefabId, at: { x, y }, rotation, scale }) }),
  summons: Object.freeze({
    place: (presetId, x, y, summonerTokenId) => rpc("summons.place", { presetId, at: { x, y },
      ...(summonerTokenId !== undefined ? { summonerTokenId } : {}) }),
    dismiss: (tokenId) => rpc("summons.dismiss", { tokenId }),
  }),
});
self.onmessage = (message) => {
  const data = message.data;
  if (data?.kind === "response") {
    const call = waiting.get(data.id);
    if (!call) return;
    waiting.delete(data.id);
    if (data.ok) call.resolve(data.result);
    else call.reject(new Error(String(data.error)));
  } else if (data?.kind === "start") {
    (async () => {
      try {
        const result = await (async (api, args, context) => {
${source}
        })(api, data.args, data.context);
        self.postMessage({ kind: "done", result: result === undefined ? null : result });
      } catch (error) {
        self.postMessage({ kind: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }
};`;
}

export const runScriptWorker: ScriptRunner = (source, args, context, action, timeoutMs) => {
  if (typeof Worker === "undefined") return Promise.reject(new Error("Script worker unavailable in this browser"));
  let url: string | null = null;
  let worker: Worker;
  try {
    url = URL.createObjectURL(new Blob([scriptWorkerSource(source)], { type: "text/javascript" }));
    worker = new Worker(url, { name: "arenastar-reviewed-macro" });
  } catch (cause) {
    if (url) URL.revokeObjectURL(url);
    return Promise.reject(cause);
  }
  return new Promise<Json>((resolve, reject) => {
    let settled = false;
    let calls = 0;
    let pending = 0;
    let completed: Json | undefined;
    let pendingError: Error | null = null;
    const callIds = new Set<number>();
    const finish = (result: { ok: true; value: Json } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (url) URL.revokeObjectURL(url);
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({ ok: false, error: new Error("Script execution timed out") }), timeoutMs);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ ok: false, error: new Error(event.message || "Script worker error") });
    };
    worker.onmessageerror = () => finish({ ok: false, error: new Error("Invalid script worker message") });
    worker.onmessage = (event: MessageEvent) => {
      if (settled || !event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      if (data.kind === "done") {
        if (!boundedJson(data.result)) finish({ ok: false, error: new Error("Script result exceeds 16 KiB or is not JSON") });
        else {
          completed = data.result;
          if (pending === 0) finish({ ok: true, value: completed });
        }
      } else if (data.kind === "error") {
        finish({ ok: false, error: new Error(String(data.error).slice(0, 500)) });
      } else if (data.kind === "call") {
        const id = data.id;
        if (completed !== undefined) { finish({ ok: false, error: new Error("Script RPC after completion") }); return; }
        if (!Number.isSafeInteger(id) || callIds.has(id as number) || typeof data.method !== "string" || !boundedJson(data.payload)) {
          finish({ ok: false, error: new Error("Invalid script RPC") });
          return;
        }
        if (++calls > 256) { finish({ ok: false, error: new Error("Script action budget exceeded") }); return; }
        callIds.add(id as number);
        pending++;
        // An un-awaited nested action must not commit after this worker times out
        // or completes. The host checks this liveness before every delayed commit.
        void action(data.method, data.payload, () => !settled && completed === undefined).then(
          (value) => {
            if (settled) return;
            if (!boundedJson(value)) {
              const failure = new Error("Script action result exceeds 16 KiB or is not JSON");
              if (completed !== undefined) pendingError = failure;
              worker.postMessage({ kind: "response", id, ok: false, error: failure.message });
            } else worker.postMessage({ kind: "response", id, ok: true, result: value });
          },
          (error: unknown) => {
            const failure = error instanceof Error ? error : new Error("Action rejected");
            if (completed !== undefined) pendingError = failure; // un-awaited failure
            if (!settled) worker.postMessage({ kind: "response", id, ok: false,
              error: failure.message.slice(0, 500) });
          },
        ).finally(() => {
          pending--;
          if (!settled && pending === 0 && completed !== undefined) {
            if (pendingError) finish({ ok: false, error: pendingError });
            else finish({ ok: true, value: completed });
          }
        });
      }
    };
    worker.postMessage({ kind: "start", args, context });
  });
};
