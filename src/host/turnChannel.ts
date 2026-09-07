/**
 * §5A turn/sim channel (host): drives the TurnEngine state machine and the
 * SimBridge, commits strategic document changes as Ops (through HostSync's
 * single commit path), and broadcasts per-faction-projected sim.delta /
 * sim.snapshot / turn.phase / turn.report frames. HostSync remains the only
 * component that talks to peers (§2) — the channel sends through it.
 */
import type { DocumentStore } from "../core/store";
import type { SessionUser, HostSync } from "./sync";
import type {
  ReportDetailMsg,
  SimControlMsg,
  SimSnapshotGetMsg,
  TurnReadyMsg,
} from "../core/messages";
import { OWNERSHIP_LEVELS } from "../core/documents";
import type {
  ArmyDocument,
  FactionDocument,
  TurnDocument,
  TurnPhase,
} from "../core/strategic";
import type { Op } from "../core/ops";
import type { DocId, UnitId } from "../core/ids";
import type { OrderQueue } from "../core/strategic";
import type { RulesContext, RulesWallsContext, UnitView } from "../core/rules";
import type {
  RealtimeClockConfig,
  SimEvent,
  TurnEngineState,
  TurnReport,
} from "../core/sim";
import { DEFAULT_REALTIME_CONFIG } from "../core/sim";
import { worldSettingsFrom } from "../core/worldSettings";
import type { SimResolveResult } from "../sim/runner";
import type { SysSchema } from "../sim/pool";
import {
  decodeSimDelta,
  decodeSimSnapshot,
  encodeSimDelta,
  encodeSimSnapshot,
  poolFromSnapshot,
  projectSimDelta,
  projectSimSnapshot,
  mergeSimDeltas,
} from "../sim/codec";
import type { ModelPool } from "../core/strategic";
import { deploySnapshot } from "../sim/deploy";
import type { SimBridge } from "./simBridge";
import { DetectionGrid, type DetectionSource } from "../core/detection";
import { projectReportForFaction, userFactions } from "./simProjection";
import { getReport } from "../storage/strategicStore";
import {
  currentTurnNumber,
  tickSeed,
  turnEngineReduce,
  turnSeed,
  type TurnEngineEffect,
} from "./turnEngine";

export interface TurnChannelOptions {
  host: HostSync;
  store: DocumentStore;
  bridge: SimBridge;
  sceneId: DocId;
  sys: SysSchema;
  /** Campaign seed; per-turn seeds derive from it (§5A). */
  seed: number;
  now?: () => number;
  /** §5A realtime pump driver (tests inject a manual clock). */
  rtDriver?: RealtimeDriver;
}

/** Injectable realtime driver; the default is a 50 ms interval. */
export interface RealtimeDriver {
  every(ms: number, cb: () => void): unknown;
  stop(handle: unknown): void;
}

const defaultRtDriver: RealtimeDriver = {
  every: (ms, cb) => globalThis.setInterval(cb, ms),
  stop: (h) => globalThis.clearInterval(h as number),
};

const REPORT_PAGE_SIZE = 50;
const RT_DRIVER_MS = 50;
const RT_MAX_CATCHUP_TICKS = 8;
const RT_EVENT_KEEP = 128;

export interface RealtimeStats {
  running: boolean;
  phase: TurnEngineState["phase"];
  simHz: number;
  flushHz: number;
  reportHz: number;
  tick: number;
  ticksTotal: number;
  deltaFrames: number;
  coalescedMax: number;
  reports: number;
  checkpoints: number;
  version: number;
}

export class TurnChannel {
  private readonly host: HostSync;
  private readonly store: DocumentStore;
  private readonly bridge: SimBridge;
  private readonly sceneId: DocId;
  private readonly sys: SysSchema;
  private readonly seed: number;
  private readonly now: () => number;

  private engine: TurnEngineState;
  private lastTurnDocId: DocId | null = null;
  // ── §5A realtime clock state ──
  private readonly rtDriver: RealtimeDriver;
  private rtTimer: unknown | null = null;
  private rtPumpAt = 0;
  private rtDueMs = 0;
  private rtTick = 0;
  private rtPending: import("../core/sim").SimDelta[] = [];
  private rtPendingMaxHpMax = 1;
  private rtLastFlushAt = 0;
  private rtLastReportAt = 0;
  private rtEvents: SimEvent[] = [];
  private rtVis: {
    userBitmap: (userId: string) => Uint8Array | null;
    at: number;
  } | null = null;
  private rtPumping = false;
  private rtStats = {
    ticksTotal: 0,
    deltaFrames: 0,
    coalescedMax: 0,
    reports: 0,
    checkpoints: 0,
  };
  /** Inverse of the last resolve's unit stat/range envelope (turn undo). */
  private lastInverse: Op[] = [];
  private resolving = false;
  /** Last resolution error, surfaced for the GM UI (§16 diagnostics). */
  lastError: string | null = null;

  constructor(options: TurnChannelOptions) {
    this.host = options.host;
    this.store = options.store;
    this.bridge = options.bridge;
    this.sceneId = options.sceneId;
    this.sys = options.sys;
    this.seed = options.seed;
    this.now = options.now ?? (() => Date.now());
    this.rtDriver = options.rtDriver ?? defaultRtDriver;
    this.engine = { phase: "idle", sceneId: options.sceneId };
    this.host.attachSim(this);
  }

  // ─── document helpers ───────────────────────────────────────────────────────

  private armies(): ArmyDocument[] {
    const out = [...this.store.getAll("armies")] as ArmyDocument[];
    return out.sort((a, b) => (a._id < b._id ? -1 : 1));
  }

  private factions(): FactionDocument[] {
    return [...this.store.getAll("factions")] as FactionDocument[];
  }

  /** Stable UnitView list (unitIdx in the runner = position here). */
  unitViews(): UnitView[] {
    const out: UnitView[] = [];
    for (const army of this.armies()) {
      for (const unit of army.units) {
        out.push({
          id: unit._id,
          armyId: army._id,
          factionId: army.factionId,
          type: unit.type,
          name: unit.name,
          profile: unit.profile,
          stats: { ...unit.stats },
          orders: unit.orders,
          formation: unit.formation,
          sceneId: unit.sceneId ?? null,
          modelRange: unit.modelRange,
          leaderTokenId: unit.leaderTokenId ?? null,
        });
      }
    }
    return out;
  }

  /** §12 RulesContext from the current store (scene grid + walls + docs). */
  rulesCtx(): RulesContext {
    const scene = this.store.get("scenes", this.sceneId);
    const gridDoc = scene?.grid;
    const wallDocs = scene?.walls ?? [];
    const n = wallDocs.length;
    const wallsCtx: RulesWallsContext = {
      x1: new Float32Array(n),
      y1: new Float32Array(n),
      x2: new Float32Array(n),
      y2: new Float32Array(n),
      restriction: new Uint8Array(n),
    };
    wallDocs.forEach((wall, i) => {
      const c = wall?.c ?? [0, 0, 0, 0];
      wallsCtx.x1[i] = c[0] ?? 0;
      wallsCtx.y1[i] = c[1] ?? 0;
      wallsCtx.x2[i] = c[2] ?? 0;
      wallsCtx.y2[i] = c[3] ?? 0;
      // §0 convention: bit0 move, bit1 sight, bit2 sound, bit3 light
      wallsCtx.restriction[i] =
        ((wall?.move ?? 0) > 0 ? 1 : 0) |
        ((wall?.sight ?? 0) > 0 ? 2 : 0) |
        ((wall?.sound ?? 0) > 0 ? 4 : 0) |
        ((wall?.light ?? 0) > 0 ? 8 : 0);
    });
    return {
      sceneId: this.sceneId,
      grid: {
        type: gridDoc?.type ?? "square",
        size: gridDoc?.size ?? 100,
        distance: gridDoc?.distance ?? 5,
        units: gridDoc?.units ?? "ft",
        diagonals: gridDoc?.diagonals ?? "555",
      },
      walls: wallsCtx,
      factions: this.factions(),
      armies: this.armies(),
      leaderActors: {},
      worldSettings: worldSettingsFrom(this.store.getAll("settings")),
    };
  }

  // ─── campaign lifecycle ─────────────────────────────────────────────────────

  /** Start the campaign (GM): loads the SimBridge, creates Turn 1 (§8A resume). */
  async start(
    mode: "stepwise" | "realtime",
    initial?: { bytes: Uint8Array; maxHpMax: number },
  ): Promise<number> {
    const units = this.unitViews();
    // §8A deploy (D-081): fresh campaign + no injected snapshot → materialize
    // the units' strength into pool models deterministically.
    let init = initial;
    let deployRanges: Array<[string, [number, number] | null]> | null = null;
    if (!init) {
      const deployed = deploySnapshot(units, this.factions(), this.sys);
      if (deployed.ranges.some(([, r]) => r !== null)) {
        init = { bytes: deployed.bytes, maxHpMax: deployed.maxHpMax };
        deployRanges = deployed.ranges;
      }
    }
    const resumed = await this.bridge.start(this.rulesCtx(), units, init);
    if (deployRanges && resumed === 0) {
      // fresh deployment (a stored checkpoint would have won inside the bridge)
      const armies = this.armies();
      const ops: Op[] = [];
      for (const [unitId, range] of deployRanges) {
        if (!range) continue;
        const army = armies.find((a) => a.units.some((u) => u._id === unitId));
        if (!army) continue;
        ops.push({
          kind: "update",
          ref: {
            coll: "units",
            id: unitId,
            parent: { coll: "armies", id: army._id },
          },
          diff: { modelRange: range as unknown as number[] },
        });
      }
      if (ops.length > 0) this.host.commitSystem(ops);
      await this.broadcastSnapshots();
    }
    const step = turnEngineReduce(this.engine, {
      type: "turn.start",
      sceneId: this.sceneId,
      mode,
      seed: this.seed,
    });
    if (step.effects.some((e) => e.type === "reject")) return resumed;
    this.engine = step.state;
    for (const eff of step.effects) this.applyEffect(eff);
    this.syncRealtimeClock();
    this.broadcastPhase();
    return resumed;
  }

  get phase(): TurnEngineState["phase"] {
    return this.engine.phase;
  }

  // ─── client inputs (via HostSync dispatch) ──────────────────────────────────

  handleTurnReady(user: SessionUser, msg: TurnReadyMsg): void {
    const step = turnEngineReduce(this.engine, {
      type: "turn.ready",
      user: user.id,
      ready: msg.ready,
    });
    if (step.effects.some((e) => e.type === "reject")) return;
    this.engine = step.state;
    this.broadcastPhase();
  }

  handleSimControl(user: SessionUser, msg: SimControlMsg): void {
    if (user.role !== "GM") return; // §16: silently dropped
    if (this.resolving) return;
    switch (msg.action) {
      case "start":
        if (this.engine.phase === "idle")
          void this.start(msg.mode ?? "stepwise");
        return;
      case "advance":
        void this.advance();
        return;
      case "next":
        this.nextTurn();
        return;
      case "undoTurn":
        void this.undoTurn();
        return;
      case "pause":
        this.reduce({ type: "sim.pause" });
        return;
      case "resume":
        this.reduce({ type: "sim.resume" });
        return;
      case "rate":
        this.reduce({ type: "sim.rate", hz: msg.rateHz ?? 5 });
        return;
      case "mode":
        return; // mode is fixed at turn.start (§5A); mid-campaign switch §16-dropped
    }
  }

  handleSimSnapshotGet(user: SessionUser, msg: SimSnapshotGetMsg): void {
    if (msg.sceneId !== this.sceneId) return;
    void this.sendSnapshotTo(user);
  }

  handleReportDetail(user: SessionUser, msg: ReportDetailMsg): void {
    void this.reportDetailTo(user, msg);
  }

  private reduce(input: Parameters<typeof turnEngineReduce>[1]): void {
    const step = turnEngineReduce(this.engine, input, this.now(), this.rtTick);
    if (step.effects.some((e) => e.type === "reject")) return;
    this.engine = step.state;
    for (const eff of step.effects) this.applyEffect(eff);
    this.syncRealtimeClock();
    this.broadcastPhase();
  }

  private applyEffect(eff: TurnEngineEffect): void {
    if (eff.type === "realtimeCheckpoint") {
      // §5A: checkpoint the post-tick pool on pause / scene change
      void this.realtimeCheckpoint("pause");
      return;
    }
    if (eff.type === "newTurn") this.rtTick = 0; // tick counter is turn-scoped
    if (eff.type !== "newTurn") return; // others are consumed by advance/undo
    const mode = this.engine.phase === "orders" ? this.engine.mode : "stepwise";
    const doc: TurnDocument = {
      _id: this.currentTurnId(eff.turnNumber),
      type: "turn",
      name: `Turn ${eff.turnNumber}`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: {},
      system: {},
      sceneId: this.sceneId,
      number: eff.turnNumber,
      phase: "orders",
      mode,
      seed: eff.seed,
      readyUsers: [],
      startedAt: this.now(),
      checkpointRef: null,
      reportRef: null,
    };
    this.host.commitSystem([{ kind: "create", coll: "turns", data: doc }]);
  }

  private currentTurnId(turnNumber: number): DocId {
    return `turn:${this.sceneId}:${turnNumber}`;
  }

  // ─── advance (§5A steps 2–4) ────────────────────────────────────────────────

  private async advance(): Promise<void> {
    if (this.resolving) return;
    const step = turnEngineReduce(
      this.engine,
      { type: "turn.advance" },
      this.now(),
    );
    if (step.effects.some((e) => e.type === "reject")) return;
    this.engine = step.state; // "resolution": order ops now rejected phase_locked
    this.broadcastPhase();
    this.resolving = true;
    try {
      const units = this.unitViews();
      const ctx = this.rulesCtx();
      this.bridge.refresh(ctx, units);
      const orders: Array<[UnitId, OrderQueue]> = units
        .filter(
          (u) => u.orders && (u.orders.pending.length > 0 || u.orders.active),
        )
        .map((u) => [u.id, u.orders as OrderQueue]);
      const turnNumber =
        this.engine.phase === "resolution" ? this.engine.turnNumber : 0;
      const result = await this.bridge.resolveTurn(
        { orders, seed: turnSeed(this.seed, turnNumber), turnNumber },
        ctx,
        units,
      );
      this.commitResolveEnvelope(units, result, turnNumber);
      await this.syncHeroTokens();
      this.engine = turnEngineReduce(
        this.engine,
        { type: "sim.resolved" },
        this.now(),
      ).state;
      await this.broadcastSimTurn(result, units);
    } catch (e) {
      // §5A/§12: resolution failed (e.g. CPU limit) — the bridge already
      // restored its checkpoint; reopen orders with the same turn so the GM
      // can retry. Determinism makes the retry identical-input safe.
      if (this.engine.phase === "resolution") {
        this.engine = {
          phase: "orders",
          turnId: this.engine.turnId,
          turnNumber: this.engine.turnNumber,
          mode: this.engine.mode,
          deadline: null,
          readyUsers: new Set(),
          seed: this.engine.seed,
        };
      }
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.resolving = false;
    }
    this.broadcastPhase(); // "report" (or "orders" again after a failure)
  }

  /**
   * §5A step 4: unitStatDiffs + modelRange updates + turn doc phase as ONE
   * OpEnvelope; retains the inverse for turn undo.
   */
  private commitResolveEnvelope(
    units: UnitView[],
    result: SimResolveResult,
    turnNumber: number,
  ): void {
    const forward: Op[] = [];
    const inverse: Op[] = [];
    const byId = new Map(units.map((u) => [u.id, u]));
    const armies = this.armies();
    const armyOf = (unitId: UnitId): ArmyDocument | undefined =>
      armies.find((a) => a.units.some((u) => u._id === unitId));
    for (const [unitId, diffs] of Object.entries(result.unitStatDiffs)) {
      const army = armyOf(unitId);
      const unit = byId.get(unitId);
      if (!army || !unit) continue;
      const ref = {
        coll: "units" as const,
        id: unitId,
        parent: { coll: "armies" as const, id: army._id },
      };
      const diff: Record<string, number | null> = {};
      const inv: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(diffs)) {
        diff[`stats.${k}`] = v;
        inv[`stats.${k}`] = unit.stats[k] ?? 0;
      }
      forward.push({ kind: "update", ref, diff });
      inverse.unshift({ kind: "update", ref, diff: inv });
    }
    for (const [unitId, range] of result.rangeDiffs) {
      const army = armyOf(unitId);
      const unit = byId.get(unitId);
      if (!army || !unit) continue;
      const ref = {
        coll: "units" as const,
        id: unitId,
        parent: { coll: "armies" as const, id: army._id },
      };
      forward.push({
        kind: "update",
        ref,
        diff: { modelRange: (range ?? null) as unknown as number[] | null },
      });
      inverse.unshift({
        kind: "update",
        ref,
        diff: {
          modelRange: (unit.modelRange ?? null) as unknown as number[] | null,
        },
      });
    }
    const turnId = this.currentTurnId(turnNumber);
    forward.push({
      kind: "update",
      ref: { coll: "turns", id: turnId },
      diff: { phase: "report", reportRef: `${this.sceneId}:${turnNumber}` },
    });
    this.lastTurnDocId = turnId;
    const committed = this.host.commitSystem(forward);
    if (!committed.ok)
      console.error(
        "RESOLVE-ENVELOPE-FAIL",
        committed.error,
        JSON.stringify(forward).slice(0, 400),
      );
    if (committed.ok) this.lastInverse = inverse;
  }

  // ─── §5A realtime clock ──────────────────────────────────────────────────────

  /** Engine config for the current realtime state. */
  private rtConfig(): RealtimeClockConfig {
    if (this.engine.phase === "paused") return this.engine.config;
    if (this.engine.phase === "orders" && this.engine.mode === "realtime") {
      return this.engine.realtime ?? DEFAULT_REALTIME_CONFIG;
    }
    return DEFAULT_REALTIME_CONFIG;
  }

  private rtRunning(): boolean {
    return this.engine.phase === "orders" && this.engine.mode === "realtime";
  }

  /** Start/stop the pump driver on every engine transition. */
  private syncRealtimeClock(): void {
    if (this.rtRunning()) {
      if (this.rtTimer === null) {
        this.rtPumpAt = this.now();
        this.rtDueMs = 0;
        this.rtLastFlushAt = this.rtPumpAt;
        this.rtLastReportAt = this.rtPumpAt;
        this.rtTimer = this.rtDriver.every(RT_DRIVER_MS, () => {
          void this.pumpRealtime();
        });
      }
      return;
    }
    if (this.rtTimer !== null) {
      this.rtDriver.stop(this.rtTimer);
      this.rtTimer = null;
    }
  }

  /** Live realtime telemetry (GM panel + e2e readback). */
  realtimeStats(): RealtimeStats {
    return {
      running: this.rtRunning(),
      phase: this.engine.phase,
      simHz: this.rtConfig().simHz,
      flushHz: this.rtConfig().flushHz,
      reportHz: this.rtConfig().reportHz,
      tick: this.rtTick,
      ticksTotal: this.rtStats.ticksTotal,
      deltaFrames: this.rtStats.deltaFrames,
      coalescedMax: this.rtStats.coalescedMax,
      reports: this.rtStats.reports,
      checkpoints: this.rtStats.checkpoints,
      version: this.bridge.poolVersion,
    };
  }

  /**
   * §5A realtime pump: run the sim ticks that came due, coalesce their deltas
   * into one frame per flush interval, emit a 1 Hz report, and checkpoint
   * every K ticks. Tests drive this directly with synthetic `nowMs`.
   */
  async pumpRealtime(nowMs?: number): Promise<void> {
    const eng = this.engine;
    if (eng.phase !== "orders" || eng.mode !== "realtime" || this.rtPumping)
      return;
    this.rtPumping = true;
    try {
      const now = nowMs ?? this.now();
      const cfg = this.rtConfig();
      const tickMs = 1000 / Math.max(0.1, cfg.simHz);
      this.rtDueMs = Math.min(
        this.rtDueMs + (now - this.rtPumpAt),
        RT_MAX_CATCHUP_TICKS * tickMs,
      );
      this.rtPumpAt = now;
      let due = Math.floor(this.rtDueMs / tickMs);
      this.rtDueMs -= due * tickMs;
      due = Math.min(due, RT_MAX_CATCHUP_TICKS);
      if (due > 0) {
        const turnNumber = eng.turnNumber;
        const units = this.unitViews();
        this.bridge.refresh(this.rulesCtx(), units);
        const orders = units
          .filter(
            (u) => u.orders && (u.orders.pending.length > 0 || u.orders.active),
          )
          .map((u) => [u.id, u.orders as OrderQueue] as [UnitId, OrderQueue]);
        for (let i = 0; i < due; i++) {
          const res = await this.bridge.tickOnce({
            orders,
            seed: tickSeed(this.seed, turnNumber, this.rtTick),
            tick: this.rtTick,
            dtSeconds: 1 / Math.max(0.1, cfg.simHz),
          });
          this.rtTick += 1;
          this.rtStats.ticksTotal += 1;
          this.rtPending.push(decodeSimDelta(res.deltaBytes).delta);
          this.rtPendingMaxHpMax = res.deltaMaxHpMax;
          for (const ev of res.events) {
            this.rtEvents.push(ev);
            if (this.rtEvents.length > RT_EVENT_KEEP) this.rtEvents.shift();
          }
          if (this.rtTick % cfg.checkpointEveryTicks === 0) {
            await this.realtimeCheckpoint("interval");
          }
        }
      }
      if (
        this.rtPending.length > 0 &&
        (now - this.rtLastFlushAt) * Math.max(0.1, cfg.flushHz) >= 1000 - 1
      ) {
        await this.rtFlush(now);
        await this.syncHeroTokens();
      }
      if (
        (now - this.rtLastReportAt) * Math.max(0.1, cfg.reportHz) >=
        1000 - 1
      ) {
        await this.rtReport(now);
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.rtPumping = false;
    }
  }

  /** One coalesced sim.delta to every session user (projected per faction). */
  private async rtFlush(now: number): Promise<void> {
    const merged = mergeSimDeltas(this.rtPending, this.sys);
    if (!merged) return;
    const bytes = encodeSimDelta(merged, this.rtPendingMaxHpMax);
    if (!this.rtVis || now - this.rtVis.at > 1000) {
      const maps = await this.visibilityMaps(this.unitViews());
      this.rtVis = { userBitmap: maps.userBitmap, at: now };
    }
    const vis = this.rtVis;
    const factions = this.factions();
    const armies = this.armies();
    const projected = new Map<string, Uint8Array>();
    for (const user of this.host.sessionUsers()) {
      if (user.role === "GM") {
        this.host.broadcastSim(
          {
            kind: "sim.delta",
            sceneId: this.sceneId,
            from: merged.fromVersion,
            to: merged.toVersion,
            bytes,
          },
          (u) => u.id === user.id,
        );
        continue;
      }
      const bitmap = vis.userBitmap(user.id);
      if (!bitmap) continue;
      const key = factionKey(user.id, factions, armies);
      let p = projected.get(key);
      if (!p) {
        p = encodeSimDelta(
          projectSimDelta(merged, (i) => (bitmap[i] ?? 0) !== 0, this.sys),
          this.rtPendingMaxHpMax,
        );
        projected.set(key, p);
      }
      this.host.broadcastSim(
        {
          kind: "sim.delta",
          sceneId: this.sceneId,
          from: merged.fromVersion,
          to: merged.toVersion,
          bytes: p,
        },
        (u) => u.id === user.id,
      );
    }
    await this.bridge.storeFlushDelta({
      fromVersion: merged.fromVersion,
      toVersion: merged.toVersion,
      deltaBytes: bytes,
      deltaMaxHpMax: this.rtPendingMaxHpMax,
      events: [],
    });
    this.rtStats.deltaFrames += 1;
    this.rtStats.coalescedMax = Math.max(
      this.rtStats.coalescedMax,
      merged.toVersion - merged.fromVersion,
    );
    this.rtLastFlushAt = now;
    this.rtPending = [];
  }

  /** 1 Hz realtime TurnReport (bounded events; projected per faction). */
  private async rtReport(now: number): Promise<void> {
    if (this.engine.phase !== "orders" && this.engine.phase !== "paused")
      return;
    const turnNumber = currentTurnNumber(this.engine);
    const subPhases = [...new Set(this.rtEvents.map((e) => e.subPhase))];
    const report: TurnReport = {
      turn: turnNumber,
      sceneId: this.sceneId,
      subPhases,
      events: this.rtEvents.slice(-100),
      summary: { realtime: 1, tick: this.rtTick, events: this.rtEvents.length },
      rulesVersion: "realtime",
    };
    if (!this.rtVis || now - this.rtVis.at > 1000) {
      const maps = await this.visibilityMaps(this.unitViews());
      this.rtVis = { userBitmap: maps.userBitmap, at: now };
    }
    const vis = this.rtVis;
    const factions = this.factions();
    const armies = this.armies();
    const ranges = new Map(this.unitViews().map((u) => [u.id, u.modelRange]));
    const projected = new Map<string, TurnReport>();
    for (const user of this.host.sessionUsers()) {
      if (user.role === "GM") {
        this.host.broadcastSim(
          { kind: "turn.report", turnId: this.turnIdOf(), report },
          (u) => u.id === user.id,
        );
        continue;
      }
      const bitmap = vis.userBitmap(user.id);
      if (!bitmap) continue;
      const key = factionKey(user.id, factions, armies);
      let r = projected.get(key);
      if (!r) {
        const unitVisible = (unitId: DocId): boolean => {
          const range = ranges.get(unitId);
          if (!range) return false;
          for (let i = range[0]; i < range[1]; i++) {
            if ((bitmap[i] ?? 0) !== 0) return true;
          }
          return false;
        };
        r = projectReportForFaction(report, unitVisible);
        projected.set(key, r);
      }
      this.host.broadcastSim(
        { kind: "turn.report", turnId: this.turnIdOf(), report: r },
        (u) => u.id === user.id,
      );
    }
    this.rtEvents = [];
    this.rtLastReportAt = now;
    this.rtStats.reports += 1;
  }

  /** §5A tick checkpoint (K-tick interval + pause/scene change). */
  private async realtimeCheckpoint(
    reason: "interval" | "pause",
  ): Promise<void> {
    const turnNumber =
      this.engine.phase === "idle" ? 0 : this.engine.turnNumber;
    try {
      await this.bridge.tickCheckpoint(
        turnNumber,
        this.rtTick,
        tickSeed(this.seed, turnNumber, this.rtTick),
        `realtime:${reason}`,
      );
      this.rtStats.checkpoints += 1;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── per-faction broadcast (§5A projection) ─────────────────────────────────

  /** Pool replica + per-faction bitmaps + per-user merged bitmap. */
  private async visibilityMaps(units: UnitView[]): Promise<{
    pool: ModelPool;
    userBitmap: (userId: string) => Uint8Array | null;
  }> {
    const factions = this.factions();
    const armies = this.armies();
    const snap = await this.bridge.snapshotBytes();
    const pool = poolFromSnapshot(
      decodeSimSnapshot(snap.bytes).snapshot,
      snap.maxHpMax,
      this.sys,
      Math.max(snap.bytes.length, 64),
    );
    const anchors = new Map(
      (await this.bridge.unitAnchors()).map(
        ([id, x, y]) => [id, { x, y }] as const,
      ),
    );
    const radii = new Map(await this.bridge.detections());
    const sources: DetectionSource[] = [];
    for (const unit of units) {
      const anchor = anchors.get(unit.id);
      const radius = radii.get(unit.id);
      if (anchor && radius !== undefined) {
        sources.push({
          anchor: { x: anchor.x, y: anchor.y },
          factionId: unit.factionId,
          radius,
        });
      }
    }
    const grid = new DetectionGrid(5);
    grid.reseed(
      sources,
      this.poolBoundsOf(pool),
      this.rulesCtx().walls,
      this.store.seq,
    );
    const perFaction = new Map<string, Uint8Array>();
    for (const f of factions) {
      perFaction.set(f._id, grid.visibleModels(pool, f._id, f.allies));
    }
    return {
      pool,
      userBitmap: (userId: string): Uint8Array | null => {
        const mine = userFactions(userId, factions, armies);
        if (mine.length === 0) return null;
        const merged = new Uint8Array(pool.count);
        let any = false;
        for (const fid of mine) {
          const bm = perFaction.get(fid);
          if (!bm) continue;
          for (let i = 0; i < merged.length; i++) {
            if ((bm[i] ?? 0) !== 0) {
              merged[i] = 1;
              any = true;
            }
          }
        }
        return any ? merged : merged; // empty bitmap = sees nothing (§5A)
      },
    };
  }

  private poolBoundsOf(pool: ModelPool): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pool.count; i++) {
      const x = pool.x[i] ?? 0;
      const y = pool.y[i] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX))
      return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }

  private async broadcastSimTurn(
    result: SimResolveResult,
    units: UnitView[],
  ): Promise<void> {
    const { userBitmap } = await this.visibilityMaps(units);
    const factions = this.factions();
    const armies = this.armies();
    const { delta } = decodeSimDelta(result.deltaBytes);
    const encoded = new Map<string, Uint8Array>();
    const projectedReports = new Map<string, TurnReport>();
    // post-compaction ranges (doc ranges are pre-turn until the ops commit lands)
    const ranges = new Map(units.map((u) => [u.id, u.modelRange]));
    for (const [id, range] of result.rangeDiffs) ranges.set(id, range);

    for (const user of this.host.sessionUsers()) {
      if (user.role === "GM") {
        this.host.broadcastSim(
          {
            kind: "sim.delta",
            sceneId: this.sceneId,
            from: result.fromVersion,
            to: result.toVersion,
            bytes: result.deltaBytes,
          },
          (u) => u.id === user.id,
        );
        this.host.broadcastSim(
          {
            kind: "turn.report",
            turnId: this.turnIdOf(),
            report: result.report,
          },
          (u) => u.id === user.id,
        );
        continue;
      }
      const vis = userBitmap(user.id);
      if (!vis) continue; // no faction: no strategic traffic (§5A)
      const key = factionKey(user.id, factions, armies);
      let bytes = encoded.get(key);
      if (!bytes) {
        bytes = encodeSimDelta(
          projectSimDelta(delta, (i) => (vis[i] ?? 0) !== 0, this.sys),
          result.deltaMaxHpMax,
        );
        encoded.set(key, bytes);
      }
      this.host.broadcastSim(
        {
          kind: "sim.delta",
          sceneId: this.sceneId,
          from: result.fromVersion,
          to: result.toVersion,
          bytes,
        },
        (u) => u.id === user.id,
      );
      let report = projectedReports.get(key);
      if (!report) {
        const unitVisible = (unitId: DocId): boolean => {
          const range = ranges.get(unitId);
          if (!range) return false;
          for (let i = range[0]; i < range[1]; i++) {
            if ((vis[i] ?? 0) !== 0) return true;
          }
          return false;
        };
        report = projectReportForFaction(result.report, unitVisible);
        projectedReports.set(key, report);
      }
      this.host.broadcastSim(
        { kind: "turn.report", turnId: this.turnIdOf(), report },
        (u) => u.id === user.id,
      );
    }
  }

  private turnIdOf(): DocId {
    return this.engine.phase === "idle"
      ? (this.lastTurnDocId ?? "")
      : this.engine.turnId;
  }

  // ─── next / undo (§5A step 5) ───────────────────────────────────────────────

  private nextTurn(): void {
    this.reduce({ type: "turn.next" });
  }

  private async undoTurn(): Promise<void> {
    const step = turnEngineReduce(
      this.engine,
      { type: "turn.undo" },
      this.now(),
    );
    if (step.effects.some((e) => e.type === "reject")) return;
    const turnNumber =
      this.engine.phase === "idle" ? 0 : this.engine.turnNumber;
    this.engine = step.state;
    const units = this.unitViews();
    await this.bridge.reloadFromFreeze(turnNumber, this.rulesCtx(), units);
    if (this.lastInverse.length > 0)
      this.host.commitSystem([...this.lastInverse]);
    if (this.lastTurnDocId) {
      this.host.commitSystem([
        {
          kind: "update",
          ref: { coll: "turns", id: this.lastTurnDocId },
          diff: { phase: "orders", reportRef: null },
        },
      ]);
    }
    this.lastInverse = [];
    // clients are ahead of the restored state → per-faction snapshot resync
    const freeze = await this.bridge.freezeBytes(turnNumber);
    if (freeze) await this.broadcastSnapshots();
    this.broadcastPhase();
  }

  /** §5A hero attachment: move leaderTokens to their owning units' anchors via Ops. */
  async syncHeroTokens(): Promise<void> {
    const units = this.unitViews();
    const heroesToSync = units.filter((u) => Boolean(u.leaderTokenId));
    if (heroesToSync.length === 0) return;
    const rawAnchors = await this.bridge.unitAnchors();
    const anchors = new Map(rawAnchors.map(([id, x, y]) => [id, { x, y }]));
    const scene = this.store.get("scenes", this.sceneId) as
      { tokens?: Array<{ _id: string; x: number; y: number }> } | undefined;
    if (!scene || !scene.tokens) return;
    const ops: Op[] = [];
    for (const u of heroesToSync) {
      if (!u.leaderTokenId) continue;
      const anchor = anchors.get(u.id);
      if (!anchor) continue;
      const { x, y } = anchor;
      const existingToken = scene.tokens.find((t) => t._id === u.leaderTokenId);
      if (
        existingToken &&
        (Math.abs(existingToken.x - x) > 0.01 ||
          Math.abs(existingToken.y - y) > 0.01)
      ) {
        ops.push({
          kind: "update",
          ref: {
            coll: "tokens",
            id: u.leaderTokenId,
            parent: { coll: "scenes", id: this.sceneId },
          },
          diff: { x, y },
        });
      }
    }
    if (ops.length > 0) {
      this.host.commitSystem(ops);
    }
  }

  // ─── snapshots & report pages ───────────────────────────────────────────────

  /** Current pool snapshot, per-faction projected for every session user. */
  private async broadcastSnapshots(): Promise<void> {
    for (const user of this.host.sessionUsers()) {
      await this.sendSnapshotTo(user);
    }
  }

  private async sendSnapshotTo(user: SessionUser): Promise<void> {
    const snap = await this.bridge.snapshotBytes();
    if (user.role === "GM") {
      this.host.broadcastSim(
        {
          kind: "sim.snapshot",
          sceneId: this.sceneId,
          version: snap.version,
          bytes: snap.bytes,
        },
        (u) => u.id === user.id,
      );
      return;
    }
    const { userBitmap } = await this.visibilityMaps(this.unitViews());
    const vis = userBitmap(user.id);
    const decoded = decodeSimSnapshot(snap.bytes).snapshot;
    const projected = vis
      ? projectSimSnapshot(decoded, (i) => (vis[i] ?? 0) !== 0, this.sys)
      : projectSimSnapshot(decoded, () => false, this.sys);
    this.host.broadcastSim(
      {
        kind: "sim.snapshot",
        sceneId: this.sceneId,
        version: snap.version,
        bytes: encodeSimSnapshot(projected, snap.maxHpMax),
      },
      (u) => u.id === user.id,
    );
  }

  private async reportDetailTo(
    user: SessionUser,
    msg: ReportDetailMsg,
  ): Promise<void> {
    const report = await getReport(
      this.bridge.db,
      this.bridge.worldId,
      this.sceneId,
      turnNumberOf(msg.turnId),
    );
    if (!report) return;
    const events = report.events.filter(
      (e) => !msg.unitId || e.unitId === msg.unitId,
    );
    const totalPages = Math.max(1, Math.ceil(events.length / REPORT_PAGE_SIZE));
    const page = events.slice(
      msg.page * REPORT_PAGE_SIZE,
      (msg.page + 1) * REPORT_PAGE_SIZE,
    );
    this.host.broadcastSim(
      {
        kind: "report.detail.page",
        turnId: msg.turnId,
        page: msg.page,
        totalPages,
        events: page,
      },
      (u) => u.id === user.id,
    );
  }

  private broadcastPhase(): void {
    if (this.engine.phase === "idle") return;
    if (this.engine.phase === "orders") this.lastTurnDocId = this.engine.turnId;
    const paused = this.engine.phase === "paused";
    const realtime =
      paused ||
      (this.engine.phase === "orders" && this.engine.mode === "realtime");
    const phase: TurnPhase =
      this.engine.phase === "paused" ? "orders" : this.engine.phase;
    this.host.broadcastSim({
      kind: "turn.phase",
      turnId: this.engine.turnId,
      phase,
      deadlineMs: this.engine.phase === "orders" ? this.engine.deadline : null,
      readyUsers:
        this.engine.phase === "orders" ? [...this.engine.readyUsers] : [],
      ...(realtime
        ? { mode: "realtime" as const, paused, simHz: this.rtConfig().simHz }
        : {}),
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function factionKey(
  userId: string,
  factions: readonly FactionDocument[],
  armies: ReadonlyArray<{ factionId: DocId; commander: readonly string[] }>,
): string {
  return userFactions(userId, factions, armies).sort().join("+");
}

function turnNumberOf(turnId: DocId): number {
  const parts = turnId.split(":");
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : 0;
}
