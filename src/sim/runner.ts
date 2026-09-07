/**
 * §5A/§12 simulation runner — the logic that lives inside the SimWorker,
 * factored so the exact same code runs in Node tests (InlineSimRunner) and in
 * the browser worker (sim.worker.ts). Executes a RulesModule against the
 * authoritative ModelPool, compacts at turn end, and produces the wire
 * artifacts: SimDelta, compressed pool snapshot (Checkpoint), unit stat
 * diffs, modelRange remaps and the ordered TurnReport.
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { OrderQueue, ModelPool } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import type { DocId, UnitId } from "../core/ids";
import type { SimEvent, TurnReport } from "../core/sim";
import { createMassBattleBasic } from "../packages/massBattleBasic";
import { BulkDice } from "../dice/bulk";
import { distributionsToJson, summarizeDistributions } from "../core/reportSummary";
import { canonicalPoolHash } from "./codec";
import { clonePool, compactPool, createModelPool, type SysSchema } from "./pool";
import {
  decodeSimSnapshot,
  diffPools,
  encodeSimDelta,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "./codec";

export interface SimLoadRequest {
  sceneId: DocId;
  /** RulesModule-declared sys columns (must match the pool snapshot). */
  sys: SysSchema;
  /** §12 package source — blob-URL-imported + validated inside the worker. */
  rulesSource?: string | undefined;
  /** Resume state; omitted → fresh empty pool (version 0). */
  snapshot?: { bytes: Uint8Array; maxHpMax: number; version: number } | undefined;
  ctx: RulesContext;
  units: UnitView[];
}

export interface SimResolveRequest {
  orders: Array<[UnitId, OrderQueue]>;
  seed: number;
  turnNumber: number;
}

/** §5A realtime: per-tick event cap (dropped beyond). */
const MAX_TICK_EVENTS = 32;

export interface SimTickRequest {
  orders: Array<[UnitId, OrderQueue]>;
  seed: number;
  tick: number;
  dtSeconds: number;
}

export interface SimResolveResult {
  fromVersion: number;
  toVersion: number;
  deltaBytes: Uint8Array;
  deltaMaxHpMax: number;
  /** Compressed snapshot of the PRE-turn pool — Checkpoint N (freeze, §5A step 2). */
  freezeBytes: Uint8Array;
  freezeMaxHpMax: number;
  freezeHash: string;
  /** Compressed full-pool snapshot AFTER compaction (state N+1). */
  checkpointBytes: Uint8Array;
  checkpointMaxHpMax: number;
  poolHash: string;
  unitStatDiffs: Record<string, Record<string, number>>;
  /** modelRange updates for Units after compaction (host emits Ops). */
  rangeDiffs: Array<[UnitId, [number, number] | null]>;
  report: TurnReport;
}

export interface SimTickResult {
  fromVersion: number;
  toVersion: number;
  deltaBytes: Uint8Array;
  deltaMaxHpMax: number;
  /** §5A realtime: events emitted by this tick (bounded). */
  events: SimEvent[];
}

const maxHpMaxOf = (pool: ModelPool): number => {
  let m = 1;
  for (let i = 0; i < pool.count; i++) {
    const v = pool.hpMax[i] ?? 0;
    if (v > m) m = v;
  }
  return m;
};

const liveOf = (pool: ModelPool, unit: UnitView): number => {
  const [s, e] = unit.modelRange ?? [0, 0];
  let n = 0;
  for (let i = s; i < e && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) n++;
  }
  return n;
};

/**
 * Shared runner state machine. ONE instance per scene. The owner (worker or
 * inline runner) drives it with load/resolve/tick; it never touches I/O.
 */
export class SimRunnerCore {
  private pool: ModelPool;
  private version = 0;
  private readonly sys: SysSchema;
  private rules: RulesModule;
  private ctx: RulesContext;
  private units: UnitView[];

  constructor(load: SimLoadRequest, rules?: RulesModule) {
    this.sys = load.sys;
    this.ctx = load.ctx;
    this.units = load.units;
    this.rules = rules ?? createMassBattleBasic();
    if (load.snapshot) {
      const { snapshot } = decodeSimSnapshot(load.snapshot.bytes);
      this.pool = poolFromSnapshot(snapshot, load.snapshot.maxHpMax, this.sys);
      this.version = load.snapshot.version;
    } else {
      this.pool = createModelPool(1024, this.sys);
      this.version = 0;
    }
  }

  /** Replace world context / unit views between turns (host doc changes). */
  refresh(ctx: RulesContext, units: UnitView[]): void {
    this.ctx = ctx;
    this.units = units;
  }

  get poolVersion(): number {
    return this.version;
  }

  /** Mean live-model position per unit (DetectionGrid seeding, §5A). */
  unitAnchors(): Array<[UnitId, number, number]> {
    const sums = new Map<number, [number, number, number]>();
    for (let i = 0; i < this.pool.count; i++) {
      if ((this.pool.status[i] ?? 0) & ModelStatus.dead) continue;
      const u = this.pool.unitIdx[i] ?? 0;
      const acc = sums.get(u) ?? [0, 0, 0];
      acc[0] += this.pool.x[i] ?? 0;
      acc[1] += this.pool.y[i] ?? 0;
      acc[2] += 1;
      sums.set(u, acc);
    }
    const out: Array<[UnitId, number, number]> = [];
    for (const [idx, unit] of this.units.entries()) {
      const acc = sums.get(idx);
      if (acc && acc[2] > 0) out.push([unit.id, acc[0] / acc[2], acc[1] / acc[2]]);
    }
    return out;
  }

  /** RulesModule.detection radius per unit (grid units). */
  detections(): Array<[UnitId, number]> {
    return this.units.map((u) => [u.id, this.rules.detection(this.ctx, u)] as [UnitId, number]);
  }

  /** Wire-format snapshot of the CURRENT pool (sim.snapshot.get replies). */
  snapshotBytes(): { bytes: Uint8Array; maxHpMax: number; version: number } {
    const maxHpMax = maxHpMaxOf(this.pool);
    return {
      bytes: encodeSimSnapshot(snapshotFromPool(this.pool, "", this.version, this.sys), maxHpMax),
      maxHpMax,
      version: this.version,
    };
  }

  hash(): string {
    return canonicalPoolHash(this.pool, this.sys);
  }

  /** Contiguous live modelRanges per unit slot, recomputed after compaction. */
  private recomputeRanges(): Array<[UnitId, [number, number] | null]> {
    const byUnit = new Map<number, number[]>();
    for (let i = 0; i < this.pool.count; i++) {
      const u = this.pool.unitIdx[i] ?? 0;
      const list = byUnit.get(u);
      if (list) list.push(i);
      else byUnit.set(u, [i]);
    }
    const out: Array<[UnitId, [number, number] | null]> = [];
    for (const [idx, unit] of this.units.entries()) {
      const slots = byUnit.get(idx);
      if (slots && slots.length > 0) {
        const start = slots[0] ?? 0;
        const end = (slots[slots.length - 1] ?? start) + 1;
        const current = `${unit.modelRange?.[0] ?? -1}:${unit.modelRange?.[1] ?? -1}`;
        if (current !== `${start}:${end}`) out.push([unit.id, [start, end]]);
      } else if (unit.modelRange) {
        out.push([unit.id, null]);
      }
    }
    return out;
  }

  private statSnapshots(
    ranges?: Map<string, [number, number] | null>,
  ): Map<string, Record<string, number>> {
    const out = new Map<string, Record<string, number>>();
    for (const unit of this.units) {
      const range = ranges?.has(unit.id) ? (ranges.get(unit.id) ?? null) : unit.modelRange;
      // recomputed strength wins over the (stale) document value
      out.set(unit.id, {
        ...unit.stats,
        strength: liveOf(this.pool, { ...unit, modelRange: range }),
      });
    }
    return out;
  }

  resolve(req: SimResolveRequest): SimResolveResult {
    const before = this.statSnapshots();
    const events: SimEvent[] = [];
    const orders = new Map<string, OrderQueue>(req.orders);
    const prevPool = clonePool(this.pool);
    // Checkpoint N is written at advance (freeze) — the §8A resume/replay base
    const freezeBytes = encodeSimSnapshot(
      snapshotFromPool(prevPool, "", this.version, this.sys),
      maxHpMaxOf(prevPool),
    );
    const freezeHash = canonicalPoolHash(prevPool, this.sys);

    // §11: BulkDice keeps the §5A PRNG contract (raw draws identical to the
    // previous XoshiroPRNG) and adds the compile-cached formula evaluator.
    const rng = new BulkDice(req.seed);
    this.rules.resolveTurn(this.ctx, this.pool, this.units, orders, rng, (e: SimEvent) =>
      events.push(e),
    );

    // Turn-end compaction (§4A) then range/stat reconciliation.
    compactPool(this.pool);
    const rangeDiffs = this.recomputeRanges();
    // stats AFTER must use the post-compaction ranges (D-069 fix)
    const after = this.statSnapshots(new Map(rangeDiffs));
    const unitStatDiffs: Record<string, Record<string, number>> = {};
    for (const [unitId, stats] of after) {
      const was = before.get(unitId);
      const diff: Record<string, number> = {};
      for (const [k, v] of Object.entries(stats)) {
        if ((was?.[k] ?? 0) !== v) diff[k] = v;
      }
      if (Object.keys(diff).length > 0) unitStatDiffs[unitId] = diff;
    }

    const fromVersion = this.version;
    this.version += 1;
    const delta = diffPools(prevPool, this.pool, "", this.sys);
    delta.sceneId = "";
    delta.fromVersion = fromVersion;
    delta.toVersion = this.version;
    const deltaMaxHpMax = maxHpMaxOf(this.pool);
    const checkpointMaxHpMax = deltaMaxHpMax;
    const poolHash = canonicalPoolHash(this.pool, this.sys);

    const report: TurnReport = {
      turn: req.turnNumber,
      sceneId: this.ctx.sceneId,
      subPhases: [...this.rules.schema.subPhases],
      events,
      summary: {
        events: events.length,
        // spread across declared sub-phases for the timeline UI
        ...Object.fromEntries(
          this.rules.schema.subPhases.map((p) => [
            p,
            events.filter((e) => e.subPhase === p).length,
          ]),
        ),
        // §11 distributions (by type / per-unit damage / break-test rolls)
        distributions: distributionsToJson(summarizeDistributions(events)),
      },
      rulesVersion: this.rules.schema.version,
    };

    void prevPool; // diff base consumed above
    return {
      fromVersion,
      toVersion: this.version,
      deltaBytes: encodeSimDelta(delta, deltaMaxHpMax),
      deltaMaxHpMax,
      freezeBytes,
      freezeMaxHpMax: maxHpMaxOf(prevPool),
      freezeHash,
      checkpointBytes: encodeSimSnapshot(
        snapshotFromPool(this.pool, "", this.version, this.sys),
        checkpointMaxHpMax,
      ),
      checkpointMaxHpMax,
      poolHash,
      unitStatDiffs,
      rangeDiffs,
      report,
    };
  }

  tick(req: SimTickRequest): SimTickResult {
    const prevPool = clonePool(this.pool);
    const orders = new Map<string, OrderQueue>(req.orders);
    const events: SimEvent[] = [];
    const tickFn = this.rules.tick;
    if (tickFn) {
      tickFn(
        this.ctx,
        this.pool,
        this.units,
        orders,
        new BulkDice(req.seed),
        (e) => {
          if (events.length < MAX_TICK_EVENTS) events.push(e);
        },
        req.dtSeconds,
      );
    }
    const fromVersion = this.version;
    this.version += 1;
    const delta = diffPools(prevPool, this.pool, "", this.sys);
    delta.sceneId = "";
    delta.fromVersion = fromVersion;
    delta.toVersion = this.version;
    return {
      fromVersion,
      toVersion: this.version,
      deltaBytes: encodeSimDelta(delta, maxHpMaxOf(this.pool)),
      deltaMaxHpMax: maxHpMaxOf(this.pool),
      events,
    };
  }
}
