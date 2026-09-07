/**
 * §2/§12 SimWorker — owns the authoritative ModelPool and executes the
 * RulesModule. Sandboxed: fetch / XMLHttpRequest / WebSocket / importScripts
 * / indexedDB are deleted from the worker global BEFORE any rules code is
 * loaded; the worker itself is the sandbox. Speaks the SimWorkerProtocol.
 */
import {
  SimRunnerCore,
  type SimLoadRequest,
  type SimResolveRequest,
  type SimTickRequest,
} from "../sim/runner";
import { importRulesModule, RulesModuleRegistry, type RulesPackageInfo } from "../sim/rulesLoader";
import type { RulesModule } from "../core/rules";

// ─── sandbox hardening (§12: no network, no storage in the worker) ───────────
const SANDBOX_REMOVALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
  "indexedDB",
  "webkitIndexedDB",
] as const;

function hardenSandbox(): void {
  const g = self as unknown as Record<string, unknown>;
  for (const name of SANDBOX_REMOVALS) {
    try {
      Reflect.deleteProperty(g, name);
    } catch {
      // non-configurable own prop in some engines — fall through to shadow
    }
    // fetch/importScripts/indexedDB are PROTOTYPE members in Chromium: the
    // delete above never touches them, so shadow with a non-configurable
    // undefined own property (assignment/redefinition/delete all fail).
    if (typeof g[name] !== "undefined") {
      try {
        Object.defineProperty(g, name, {
          value: undefined,
          writable: false,
          enumerable: true,
          configurable: false,
        });
      } catch {
        // already non-configurable — nothing more we can do in-engine
      }
    }
  }
}
hardenSandbox();

export type SimWorkerRequest =
  | { id: number; type: "load"; load: SimLoadRequest }
  | { id: number; type: "loadRules"; source: string }
  | { id: number; type: "refresh"; ctx: SimLoadRequest["ctx"]; units: SimLoadRequest["units"] }
  | { id: number; type: "resolve"; req: SimResolveRequest }
  | { id: number; type: "tick"; req: SimTickRequest }
  | { id: number; type: "hash" }
  | { id: number; type: "anchors" }
  | { id: number; type: "detections" }
  | { id: number; type: "snapshot" };

export type SimWorkerResponse =
  | { id: number; ok: true; kind: "loaded"; version: number }
  | { id: number; ok: true; kind: "rulesLoaded"; info: RulesPackageInfo }
  | { id: number; ok: true; kind: "resolved"; result: import("../sim/runner").SimResolveResult }
  | { id: number; ok: true; kind: "ticked"; result: import("../sim/runner").SimTickResult }
  | { id: number; ok: true; kind: "hash"; hash: string }
  | { id: number; ok: true; kind: "anchored"; anchors: Array<[string, number, number]> }
  | { id: number; ok: true; kind: "detected"; detections: Array<[string, number]> }
  | {
      id: number;
      ok: true;
      kind: "snapshotted";
      bytes: Uint8Array;
      maxHpMax: number;
      version: number;
    }
  | { id: number; ok: false; error: string };

let core: SimRunnerCore | null = null;
/** §12 imported packages, keyed by exact source text (one import per package). */
const rulesRegistry = new RulesModuleRegistry();

const post = (msg: SimWorkerResponse): void => {
  self.postMessage(msg);
};

/** Resolve the package for a load/refresh — imported+validated once, cached. */
async function rulesFor(source: string): Promise<RulesModule> {
  const cached = rulesRegistry.get(source);
  if (cached) return cached.module;
  const loaded = await importRulesModule(source);
  if (!loaded.ok) throw new Error(loaded.error);
  rulesRegistry.set(source, loaded.value);
  return loaded.value.module;
}

self.onmessage = (ev: MessageEvent<SimWorkerRequest>): void => {
  void handleRequest(ev.data);
};

async function handleRequest(msg: SimWorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case "loadRules": {
        // §12: validate + cache a package without starting a scene; the
        // host-side CPU limit covers hostile top-level code via termination.
        let loaded = rulesRegistry.get(msg.source);
        if (!loaded) {
          const res = await importRulesModule(msg.source);
          if (!res.ok) throw new Error(res.error);
          loaded = res.value;
          rulesRegistry.set(msg.source, loaded);
        }
        post({ id: msg.id, ok: true, kind: "rulesLoaded", info: loaded.info });
        break;
      }
      case "load": {
        const rules =
          msg.load.rulesSource !== undefined ? await rulesFor(msg.load.rulesSource) : undefined;
        core = new SimRunnerCore(msg.load, rules);
        post({ id: msg.id, ok: true, kind: "loaded", version: core.poolVersion });
        break;
      }
      case "refresh":
        core?.refresh(msg.ctx, msg.units);
        post({ id: msg.id, ok: true, kind: "loaded", version: core?.poolVersion ?? 0 });
        break;
      case "resolve":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "resolved", result: core.resolve(msg.req) });
        break;
      case "tick":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "ticked", result: core.tick(msg.req) });
        break;
      case "hash":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "hash", hash: core.hash() });
        break;
      case "anchors":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "anchored", anchors: core.unitAnchors() });
        break;
      case "detections":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "detected", detections: core.detections() });
        break;
      case "snapshot":
        if (!core) throw new Error("sim: not loaded");
        post({ id: msg.id, ok: true, kind: "snapshotted", ...core.snapshotBytes() });
        break;
    }
  } catch (e) {
    post({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
