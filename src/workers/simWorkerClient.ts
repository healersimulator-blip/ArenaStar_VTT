/**
 * SimWorker clients (§5A): `WorkerSimRunner` drives the real sandboxed
 * sim.worker.ts (inlined into the single-file bundle) with a per-turn CPU
 * limit enforced by host-side termination + checkpoint restore;
 * `InlineSimRunner` runs the same SimRunnerCore in-context for Node tests
 * and as a same-thread fallback (trusted built-in rules only).
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { UnitId } from "../core/ids";
import {
  SimRunnerCore,
  type SimLoadRequest,
  type SimResolveRequest,
  type SimResolveResult,
  type SimTickRequest,
  type SimTickResult,
} from "../sim/runner";
import { importRulesModule, RulesModuleRegistry, type RulesPackageInfo } from "../sim/rulesLoader";

export interface SimRunner {
  load(load: SimLoadRequest): Promise<number>;
  refresh(ctx: RulesContext, units: UnitView[]): void;
  resolve(req: SimResolveRequest, cpuLimitMs?: number): Promise<SimResolveResult>;
  tick(req: SimTickRequest): Promise<SimTickResult>;
  hash(): Promise<string>;
  /** Mean live-model position per unit (DetectionGrid seeding). */
  unitAnchors(): Promise<Array<[UnitId, number, number]>>;
  /** RulesModule.detection radius per unit. */
  detections(): Promise<Array<[UnitId, number]>>;
  /** Wire-format snapshot of the current pool. */
  snapshotBytes(): Promise<{ bytes: Uint8Array; maxHpMax: number; version: number }>;
  /**
   * §12: import + validate a rules package source (blob URL in the worker;
   * data: URL inline). Optional — runners without package support skip it.
   */
  loadRules?(source: string, cpuLimitMs?: number): Promise<RulesPackageInfo>;
  terminate(): void;
}

export const DEFAULT_RULES_LOAD_CPU_LIMIT_MS = 5_000;

export const DEFAULT_SIM_CPU_LIMIT_MS = 30_000;

/** In-context runner — identical logic, no sandbox boundary (tests / Node host). */
export class InlineSimRunner implements SimRunner {
  private core: SimRunnerCore | null = null;
  private readonly packages = new RulesModuleRegistry();

  constructor(private readonly rules?: RulesModule) {}

  load(load: SimLoadRequest): Promise<number> {
    if (load.rulesSource !== undefined) {
      // §12 package path: import + validate, then run exactly like the worker
      return (async () => {
        let loaded = this.packages.get(load.rulesSource as string);
        if (!loaded) {
          const res = await importRulesModule(load.rulesSource as string);
          if (!res.ok) throw new Error(res.error);
          loaded = res.value;
          this.packages.set(load.rulesSource as string, loaded);
        }
        this.core = new SimRunnerCore(load, loaded.module);
        return this.core.poolVersion;
      })();
    }
    this.core = new SimRunnerCore(load, this.rules);
    return Promise.resolve(this.core.poolVersion);
  }

  loadRules(source: string): Promise<RulesPackageInfo> {
    return (async () => {
      let loaded = this.packages.get(source);
      if (!loaded) {
        const res = await importRulesModule(source);
        if (!res.ok) throw new Error(res.error);
        loaded = res.value;
        this.packages.set(source, loaded);
      }
      return loaded.info;
    })();
  }

  refresh(ctx: RulesContext, units: UnitView[]): void {
    this.core?.refresh(ctx, units);
  }

  resolve(req: SimResolveRequest): Promise<SimResolveResult> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.resolve(req));
  }

  tick(req: SimTickRequest): Promise<SimTickResult> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.tick(req));
  }

  hash(): Promise<string> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.hash());
  }

  unitAnchors(): Promise<Array<[UnitId, number, number]>> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.unitAnchors());
  }

  detections(): Promise<Array<[UnitId, number]>> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.detections());
  }

  snapshotBytes(): Promise<{ bytes: Uint8Array; maxHpMax: number; version: number }> {
    if (!this.core) return Promise.reject(new Error("sim: not loaded"));
    return Promise.resolve(this.core.snapshotBytes());
  }

  terminate(): void {
    this.core = null;
  }
}

type WorkerResponse = import("./sim.worker").SimWorkerResponse;

type SimWorkerRequestWithoutId =
  | { type: "load"; load: SimLoadRequest }
  | { type: "loadRules"; source: string }
  | { type: "refresh"; ctx: RulesContext; units: UnitView[] }
  | { type: "resolve"; req: SimResolveRequest }
  | { type: "tick"; req: SimTickRequest }
  | { type: "hash" }
  | { type: "anchors" }
  | { type: "detections" }
  | { type: "snapshot" };

/** Real worker transport with CPU-limit termination (§12). */
export class WorkerSimRunner implements SimRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
  >();
  private cpuTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly workerCtor: new () => Worker) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new this.workerCtor();
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const waiter = this.pending.get(ev.data.id);
      if (!waiter) return;
      this.pending.delete(ev.data.id);
      if (this.cpuTimer !== null) {
        clearTimeout(this.cpuTimer);
        this.cpuTimer = null;
      }
      if (ev.data.ok) waiter.resolve(ev.data);
      else waiter.reject(new Error(ev.data.error));
    };
    worker.onerror = () => {
      for (const w of this.pending.values()) w.reject(new Error("sim worker crashed"));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private call<T>(msg: SimWorkerRequestWithoutId, cpuLimitMs?: number): Promise<T> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as unknown as T),
        reject,
      });
      if (cpuLimitMs !== undefined && cpuLimitMs > 0) {
        this.cpuTimer = setTimeout(() => {
          // §12: CPU limit per turn via termination; host restores from checkpoint.
          this.terminate();
          for (const w of this.pending.values())
            w.reject(new Error(`sim: CPU limit exceeded (${cpuLimitMs} ms)`));
          this.pending.clear();
        }, cpuLimitMs);
      }
      worker.postMessage({ ...msg, id });
    });
  }

  load(load: SimLoadRequest): Promise<number> {
    return this.call<{ kind: "loaded"; version: number }>({ type: "load", load }).then(
      (r) => r.version,
    );
  }

  /** §12: package import inside the sandboxed worker; CPU-capped (termination). */
  loadRules(
    source: string,
    cpuLimitMs = DEFAULT_RULES_LOAD_CPU_LIMIT_MS,
  ): Promise<RulesPackageInfo> {
    return this.call<{ kind: "rulesLoaded"; info: RulesPackageInfo }>(
      { type: "loadRules", source },
      cpuLimitMs,
    ).then((r) => r.info);
  }

  refresh(ctx: RulesContext, units: UnitView[]): void {
    void this.call({ type: "refresh", ctx, units }).catch(() => {});
  }

  resolve(
    req: SimResolveRequest,
    cpuLimitMs = DEFAULT_SIM_CPU_LIMIT_MS,
  ): Promise<SimResolveResult> {
    return this.call<{ kind: "resolved"; result: SimResolveResult }>(
      { type: "resolve", req },
      cpuLimitMs,
    ).then((r) => r.result);
  }

  tick(req: SimTickRequest): Promise<SimTickResult> {
    return this.call<{ kind: "ticked"; result: SimTickResult }>({ type: "tick", req }).then(
      (r) => r.result,
    );
  }

  hash(): Promise<string> {
    return this.call<{ kind: "hash"; hash: string }>({ type: "hash" }).then((r) => r.hash);
  }

  unitAnchors(): Promise<Array<[UnitId, number, number]>> {
    return this.call<{ kind: "anchored"; anchors: Array<[UnitId, number, number]> }>({
      type: "anchors",
    }).then((r) => r.anchors);
  }

  detections(): Promise<Array<[UnitId, number]>> {
    return this.call<{ kind: "detected"; detections: Array<[UnitId, number]> }>({
      type: "detections",
    }).then((r) => r.detections);
  }

  snapshotBytes(): Promise<{ bytes: Uint8Array; maxHpMax: number; version: number }> {
    return this.call<{ kind: "snapshot"; bytes: Uint8Array; maxHpMax: number; version: number }>({
      type: "snapshot",
    }).then((r) => ({ bytes: r.bytes, maxHpMax: r.maxHpMax, version: r.version }));
  }

  terminate(): void {
    if (this.cpuTimer !== null) {
      clearTimeout(this.cpuTimer);
      this.cpuTimer = null;
    }
    this.worker?.terminate();
    this.worker = null;
  }
}
