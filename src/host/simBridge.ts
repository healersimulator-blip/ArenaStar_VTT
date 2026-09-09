/**
 * §5A/§8A HostSync ⇄ SimWorker bridge: one per strategic scene. Drives the
 * SimRunner (worker or inline), persists Checkpoints / TurnReports /
 * SimDeltas, enforces the CPU limit (terminate + restore from checkpoint),
 * and implements host-restart resume (§8A: load latest checkpoint, re-run a
 * turn that was mid-resolution — determinism makes the re-run identical).
 */
import type { IDBPDatabase } from "idb";
import type { RulesContext, UnitView } from "../core/rules";
import type { OrderQueue } from "../core/strategic";
import type { DocId, UnitId, WorldId } from "../core/ids";
import type { SimResolveResult, SimTickRequest, SimTickResult } from "../sim/runner";
import type { SysSchema } from "../sim/pool";
import type { SimRunner } from "../workers/simWorkerClient";
import { DEFAULT_SIM_CPU_LIMIT_MS } from "../workers/simWorkerClient";
import {
  applyCheckpointRetention,
  latestCheckpoint,
  listCheckpoints,
  putCheckpoint,
  putDelta,
  putReport,
  type CheckpointRecord,
} from "../storage/strategicStore";
import { canonicalPoolHash, decodeSimSnapshot, poolFromSnapshot } from "../sim/codec";

export interface SimBridgeOptions {
  db: IDBPDatabase;
  worldId: WorldId;
  runner: SimRunner;
  sys: SysSchema;
  cpuLimitMs?: number;
  now?: () => number;
  /** §12 rules package source — imported from a blob URL inside the worker. */
  rulesSource?: string;
}

export interface ResolveTurnArgs {
  orders: Array<[UnitId, OrderQueue]>;
  seed: number;
  turnNumber: number;
}

export class SimBridge {
  readonly sceneId: DocId;
  /** Storage accessors for the turn channel (§8A report pages). */
  readonly db: import("idb").IDBPDatabase;
  readonly worldId: WorldId;
  private version = 0;
  private loaded = false;
  private readonly opts: Required<Pick<SimBridgeOptions, "cpuLimitMs">> & SimBridgeOptions;

  constructor(sceneId: DocId, options: SimBridgeOptions) {
    this.sceneId = sceneId;
    this.db = options.db;
    this.worldId = options.worldId;
    this.opts = { ...options, cpuLimitMs: options.cpuLimitMs ?? DEFAULT_SIM_CPU_LIMIT_MS };
  }

  /**
   * N01: whether `start()` has loaded a pool. Snapshot requests that arrive
   * before the campaign starts (a joiner adopting the announced battle) are
   * dropped — the runner has no pool yet, and `start()` broadcasts the initial
   * snapshot to every session anyway.
   */
  get started(): boolean {
    return this.loaded;
  }

  /**
   * Start the scene: resume from the latest stored checkpoint when present
   * (§8A); else a fresh pool, optionally seeded with an initial snapshot
   * (GM mass-spawn builds one before turn 1). Returns the resumed turn or 0.
   */
  async start(
    ctx: RulesContext,
    units: UnitView[],
    initial?: { bytes: Uint8Array; maxHpMax: number },
  ): Promise<number> {
    const cp = await latestCheckpoint(this.opts.db, this.opts.worldId, this.sceneId);
    const snapshot = cp
      ? { bytes: cp.pool, maxHpMax: cp.maxHpMax, version: cp.version }
      : initial
        ? { bytes: initial.bytes, maxHpMax: initial.maxHpMax, version: 0 }
        : undefined;
    const version = await this.opts.runner.load({
      sceneId: this.sceneId,
      sys: this.opts.sys,
      ...(snapshot ? { snapshot } : { snapshot: undefined }),
      ...(this.opts.rulesSource !== undefined
        ? { rulesSource: this.opts.rulesSource }
        : { rulesSource: undefined }),
      ctx,
      units,
    });
    this.version = version;
    this.loaded = true;
    return cp?.turnNumber ?? 0;
  }

  refresh(ctx: RulesContext, units: UnitView[]): void {
    this.opts.runner.refresh(ctx, units);
  }

  /**
   * §5A step 3–4: resolve in the SimWorker, persist Checkpoint N+1, the
   * TurnReport and the SimDelta, apply retention, and return the artifacts
   * for HostSync to broadcast. CPU-limit failures restore the last
   * checkpoint into a fresh runner before rethrowing (§12).
   */
  async resolveTurn(
    args: ResolveTurnArgs,
    ctx: RulesContext,
    units: UnitView[],
  ): Promise<SimResolveResult> {
    if (!this.loaded) throw new Error("sim bridge: not started");
    let result: SimResolveResult;
    try {
      result = await this.opts.runner.resolve(
        { orders: args.orders, seed: args.seed, turnNumber: args.turnNumber },
        this.opts.cpuLimitMs,
      );
    } catch (e) {
      // restore-from-checkpoint best effort: the runner may be terminated
      try {
        await this.start(ctx, units);
      } catch {
        // storage gone too — surface the original error
      }
      throw e;
    }
    this.version = result.toVersion;

    // §8A: store the FREEZE (Checkpoint N, pre-turn state) so a mid-resolution
    // crash re-runs deterministically from it; slot = turnNumber.
    const rec: CheckpointRecord = {
      worldId: this.opts.worldId,
      sceneId: this.sceneId,
      slot: args.turnNumber,
      turnNumber: args.turnNumber,
      tick: null,
      pool: result.freezeBytes,
      maxHpMax: result.freezeMaxHpMax,
      version: result.fromVersion,
      unitStats: {},
      seed: args.seed,
      rulesVersion: result.report.rulesVersion,
      hash: result.freezeHash,
    };
    await putCheckpoint(this.opts.db, rec);
    await putReport(this.opts.db, this.opts.worldId, this.sceneId, result.report);
    await putDelta(this.opts.db, {
      worldId: this.opts.worldId,
      sceneId: this.sceneId,
      version: result.toVersion,
      bytes: result.deltaBytes,
      maxHpMax: result.deltaMaxHpMax,
      at: (this.opts.now ?? Date.now)(),
    });
    await applyCheckpointRetention(this.opts.db, this.opts.worldId, this.sceneId, args.turnNumber);
    return result;
  }

  /** Latest stored checkpoint (resume inspection, §8A). */
  async latestCheckpoint(): Promise<CheckpointRecord | null> {
    return latestCheckpoint(this.opts.db, this.opts.worldId, this.sceneId);
  }

  /**
   * §5A realtime: one sim tick in the runner (no storage — the channel
   * persists the COALESCED flush delta). Orders are the live Unit order
   * queues; the seed must be the deterministic tick seed (replayable).
   */
  async tickOnce(req: SimTickRequest): Promise<SimTickResult> {
    if (!this.loaded) throw new Error("sim bridge: not started");
    const result = await this.opts.runner.tick(req);
    this.version = result.toVersion;
    return result;
  }

  /** §5A realtime: persist one coalesced flush delta. */
  async storeFlushDelta(delta: SimTickResult): Promise<void> {
    await putDelta(this.opts.db, {
      worldId: this.worldId,
      sceneId: this.sceneId,
      version: delta.toVersion,
      bytes: delta.deltaBytes,
      maxHpMax: delta.deltaMaxHpMax,
      at: (this.opts.now ?? Date.now)(),
    });
  }

  /**
   * §5A realtime checkpoint (every K ticks + on pause / scene change): the
   * post-tick pool, slot = tick. `tick !== null` distinguishes these from
   * stepwise freeze checkpoints (slot = turnNumber, tick === null).
   */
  async tickCheckpoint(
    turnNumber: number,
    tick: number,
    seed: number,
    rulesVersion: string,
  ): Promise<void> {
    const snap = await this.opts.runner.snapshotBytes();
    const hash = canonicalPoolHash(
      poolFromSnapshot(decodeSimSnapshot(snap.bytes).snapshot, snap.maxHpMax, this.opts.sys, 4096),
      this.opts.sys,
    );
    await putCheckpoint(this.opts.db, {
      worldId: this.worldId,
      sceneId: this.sceneId,
      slot: tick,
      turnNumber,
      tick,
      pool: snap.bytes,
      maxHpMax: snap.maxHpMax,
      version: snap.version,
      unitStats: {},
      seed,
      rulesVersion,
      hash,
    });
  }

  /**
   * §5A turn undo: reload the runner from the stored FREEZE checkpoint of
   * `turnNumber` (pre-turn state) and reset the version accordingly.
   */
  async reloadFromFreeze(turnNumber: number, ctx: RulesContext, units: UnitView[]): Promise<void> {
    const cps = await listCheckpoints(this.opts.db, this.opts.worldId, this.sceneId);
    // freeze checkpoints carry tick === null; realtime tick checkpoints of the
    // same turn must never satisfy an undo (§5A: undo restores the pre-turn state)
    const cp = cps.find((c) => c.turnNumber === turnNumber && c.tick === null);
    if (!cp) throw new Error(`sim bridge: no checkpoint for turn ${turnNumber}`);
    this.version = await this.opts.runner.load({
      sceneId: this.sceneId,
      sys: this.opts.sys,
      snapshot: { bytes: cp.pool, maxHpMax: cp.maxHpMax, version: cp.version },
      ctx,
      units,
    });
    this.loaded = true;
  }

  /** Freeze checkpoint bytes of a turn (undo rebroadcast source). */
  async freezeBytes(
    turnNumber: number,
  ): Promise<{ bytes: Uint8Array; maxHpMax: number; version: number } | null> {
    const cps = await listCheckpoints(this.opts.db, this.opts.worldId, this.sceneId);
    const cp = cps.find((c) => c.turnNumber === turnNumber && c.tick === null);
    return cp ? { bytes: cp.pool, maxHpMax: cp.maxHpMax, version: cp.version } : null;
  }

  unitAnchors(): Promise<Array<[UnitId, number, number]>> {
    return this.opts.runner.unitAnchors();
  }

  detections(): Promise<Array<[UnitId, number]>> {
    return this.opts.runner.detections();
  }

  snapshotBytes(): Promise<{ bytes: Uint8Array; maxHpMax: number; version: number }> {
    return this.opts.runner.snapshotBytes();
  }

  get poolVersion(): number {
    return this.version;
  }
}
