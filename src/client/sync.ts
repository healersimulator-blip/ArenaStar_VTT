/**
 * §5 ClientSync — the client-side sync endpoint.
 *
 * - tracks lastSeq; reconnects send it (hello.lastSeq, D-031) and the host
 *   answers ops-since-seq or a full snapshot;
 * - applies committed envelopes strictly in seq order, buffering gaps
 *   (late join: ops with seq > snapshot.seq apply after the snapshot, §14);
 * - optimistic UI (§5): latency-sensitive ops apply locally to an overlay
 *   echo store; commit reconciles (drop pending), rejected rolls back.
 */
import { DocumentStore, type StoreMeta } from "../core/store";
import { estimateClockOffset, type ClockSample } from "../core/audio";
import type { Op, OpEnvelope } from "../core/ops";
import type {
  AssetChunkMsg,
  AssetPriority,
  AudioCmdMsg,
  ClockMsg,
  EphemeralKind,
  EphemeralMsg,
  HelloMsg,
  PongMsg,
  RollChallengeMsg,
  OpsMsg,
  RejectedMsg,
  RollMode,
  SimControlAction,
  SimDeltaMsg,
  SimSnapshotMsg,
  SnapshotMsg,
  TurnPhaseMsg,
  TurnReportMsg,
  WelcomeMsg,
  WireMessage,
} from "../core/messages";
import type { Json } from "../core/documents";
import { randomSeedHex, sha256Hex } from "../dice/commitReveal";
import type { AssetId, TxId, UserId } from "../core/ids";
import type { Role } from "../core/documents";
import type { EventBus } from "../core";
import type { Transport } from "../core/net";
import { frameMessage, deframeMessage, channelFor } from "../net/frame";
import { createEphemeralRateLimiter, TokenBucket } from "../core/ratelimit";
import type { ModelPool } from "../core/strategic";
import type { SimDelta } from "../core/sim";
import type { DocId } from "../core/ids";
import type { SysSchema } from "../sim/pool";
import { applySimDelta, decodeSimDelta, decodeSimSnapshot, poolFromSnapshot } from "../sim/codec";

export interface ClientEvents {
  welcome: { user: { id: UserId; role: Role; name: string }; world: WelcomeMsg["world"] };
  snapshot: { seq: number };
  ops: { envelope: OpEnvelope; reconciled: TxId | null };
  rejected: { txId: TxId; reason: RejectedMsg["reason"]; detail: string };
  ephemeral: EphemeralMsg;
  kick: { reason: string };
  /** §7: one chunk of a streamed asset (AssetFetcher consumes these). */
  asset: AssetChunkMsg;
  /** §5A: strategic pool replica updated (delta applied or snapshot replaced). */
  sim: { version: number; count: number; kind: "delta" | "snapshot" };
  /** §5A phase announcements. */
  turnPhase: TurnPhaseMsg;
  /** §5A projected turn report (report field of the wire message). */
  turnReport: TurnReportMsg;
  /** §7 NTP-style probe reply (t3 is stamped by the handler). */
  pong: PongMsg;
  /** §7 host clock broadcast. */
  clock: ClockMsg;
  /** §7 scheduled playback command (host clock; play at atHostTime − offset). */
  audio: AudioCmdMsg;
}

/** Which intents are latency-sensitive enough for optimistic echo (§5 default). */
export type OptimisticPolicy = (op: Op) => boolean;

export const DEFAULT_OPTIMISTIC_POLICY: OptimisticPolicy = (op) => {
  if (op.kind === "update") {
    if (op.ref.coll === "tokens") {
      return Object.keys(op.diff).every((key) => ["x", "y", "rotation"].includes(key));
    }
    if (op.ref.coll === "drawings") return true;
    if (op.ref.coll === "actors" || op.ref.coll === "items") {
      return Object.keys(op.diff).every((key) => key === "system" || key.startsWith("system."));
    }
    return false;
  }
  return op.kind === "create" && op.coll === "drawings";
};

export interface ClientSyncOptions {
  transport: Transport;
  bus: EventBus<ClientEvents>;
  meta: StoreMeta;
  optimistic?: OptimisticPolicy;
  now?: () => number;
  /** §5A: sys column schema for the strategic pool replica (from the system). */
  simSys?: SysSchema;
  /** §5A: the strategic scene whose pool this client tracks. */
  simSceneId?: DocId;
}

export class ClientSync {
  /** §11 pending client seeds, keyed by committed rollId. */
  private readonly committedRolls = new Map<string, string>();
  readonly store: DocumentStore;
  private echoImpl: DocumentStore;
  private transport: Transport;
  private readonly bus: EventBus<ClientEvents>;
  private readonly policy: OptimisticPolicy;
  private readonly now: () => number;
  private readonly ephemeralBucket: TokenBucket;
  private readonly simSys: SysSchema | null;
  private readonly simSceneId: DocId | null;

  /** txId → optimistic ops (echo overlay only). */
  private pending = new Map<TxId, Op[]>();
  /** txId → all in-flight submissions (for reconciliation bookkeeping). */
  private inFlight = new Set<TxId>();
  private buffer: OpEnvelope[] = [];

  user: { id: UserId; role: Role; name: string } | null = null;
  world: WelcomeMsg["world"] | null = null;

  // ─── §5A strategic replica ────────────────────────────────────────────────
  private simPool: ModelPool | null = null;
  private simVersion = -1;
  private snapshotInFlight = false;
  private pendingDeltas: SimDelta[] = [];

  constructor(options: ClientSyncOptions) {
    this.transport = options.transport;
    this.bus = options.bus;
    this.policy = options.optimistic ?? DEFAULT_OPTIMISTIC_POLICY;
    this.now = options.now ?? (() => Date.now());
    this.store = new DocumentStore({ meta: options.meta });
    this.echoImpl = new DocumentStore({ meta: options.meta });
    this.ephemeralBucket = createEphemeralRateLimiter(this.now);
    this.simSys = options.simSys ?? null;
    this.simSceneId = options.simSceneId ?? null;
    this.transport.onMessage = (_channel, bytes) => this.onFrame(bytes);
  }

  /** The optimistic overlay the UI renders (§5 optimistic UI). */
  get echo(): DocumentStore {
    return this.echoImpl;
  }

  private hello: HelloMsg | null = null;
  /** Snapshot applied at least once (gates §14 buffering vs D-065 gap-skipping). */
  private hasSnapshot = false;

  get lastSeq(): number {
    return this.store.seq;
  }

  // ─── Outgoing ───────────────────────────────────────────────────────────────

  connect(hello: HelloMsg): void {
    const withSeq: HelloMsg = this.store.seq > 0 ? { ...hello, lastSeq: this.store.seq } : hello;
    this.hello = withSeq;
    this.send(withSeq);
  }

  /**
   * Reconnect the (stateful) client to a fresh transport, keeping the replica
   * and pending intents. The new hello carries lastSeq so the host can answer
   * with ops-since-seq instead of a full snapshot (§5, D-031).
   */
  reattach(transport: Transport): void {
    if (!this.hello) throw new Error("reattach: client was never connected");
    this.transport = transport;
    this.transport.onMessage = (_channel, bytes) => this.onFrame(bytes);
    // re-stamp lastSeq from the CURRENT replica seq (connect() stored the
    // original, possibly from seq 0)
    const withSeq: HelloMsg =
      this.store.seq > 0 ? { ...this.hello, lastSeq: this.store.seq } : this.hello;
    this.hello = withSeq;
    this.send(withSeq);
  }

  /** Submit an intent; optimistic ops are echoed locally (§5). */
  submit(ops: Op[]): TxId {
    const txId = globalThis.crypto.randomUUID();
    this.inFlight.add(txId);
    const optimistic = ops.filter((op) => this.policy(op));
    if (optimistic.length > 0) {
      this.pending.set(txId, optimistic);
      this.rebuildEcho();
    }
    this.send({ kind: "intent", txId, ops });
    return txId;
  }

  // ─── §7 audio + clock sync ──────────────────────────────────────────────────

  /** NTP-style samples (last 8); best-RTT estimate wins. */
  private readonly clockSamples: ClockSample[] = [];

  /** §7 send a clock probe; the pong handler stamps t3 and records the sample. */
  sendPing(): void {
    this.send({ kind: "ping", t0: Date.now() });
  }

  /** Best-effort host-clock offset estimate (null before the first pong). */
  clockOffset(): { offsetMs: number; rttMs: number } | null {
    return estimateClockOffset(this.clockSamples);
  }

  /** §7 playback request (host stamps + rebroadcasts; GM/ASSISTANT only). */
  sendAudioCmd(cmd: {
    playlistId: string;
    soundId: string;
    action: AudioCmdMsg["action"];
    offset: number;
  }): void {
    this.send({ kind: "audio.cmd", ...cmd });
  }

  roll(formula: string, mode: RollMode = "roll", to?: UserId[]): string {
    const rollId = globalThis.crypto.randomUUID();
    this.send({ kind: "roll", rollId, formula, mode, ...(to ? { to } : {}) });
    return rollId;
  }

  /**
   * §11 commit-reveal roll: commits H(seed_c), auto-answers the host
   * challenge with the reveal. Falls back to a plain roll when crypto is
   * unavailable — chat never blocks.
   */
  async rollVerified(formula: string, mode: RollMode = "roll", to?: UserId[]): Promise<string> {
    let seedClient: string;
    let commit: string;
    try {
      seedClient = randomSeedHex();
      commit = await sha256Hex(seedClient);
    } catch {
      return this.roll(formula, mode, to);
    }
    const rollId = globalThis.crypto.randomUUID();
    this.committedRolls.set(rollId, seedClient);
    if (this.committedRolls.size > 32) {
      // drop the oldest entries (abandoned challenges)
      const first = this.committedRolls.keys().next().value;
      if (typeof first === "string") this.committedRolls.delete(first);
    }
    this.send({ kind: "roll", rollId, formula, mode, commit, ...(to ? { to } : {}) });
    return rollId;
  }

  /** §7: lazy asset fetch with resume; answered by asset.chunk frames. */
  requestAsset(assetId: AssetId, priority: AssetPriority = "scene", offset = 0): void {
    this.send({ kind: "asset.get", assetId, offset, priority });
  }

  sendEphemeral(t: EphemeralKind, data: Record<string, Json>): void {
    if (!this.ephemeralBucket.tryRemove()) return; // client-side pre-limit (§5)
    const msg: EphemeralMsg = { kind: "ephemeral", from: this.user?.id ?? "anonymous", t, data };
    this.send(msg);
  }

  close(): void {
    this.transport.close();
  }

  private send(msg: WireMessage): void {
    this.transport.send(channelFor(msg.kind), frameMessage(msg));
  }

  // ─── Incoming ───────────────────────────────────────────────────────────────

  private onFrame(bytes: Uint8Array): void {
    const decoded = deframeMessage(bytes);
    if (!decoded.ok) return;
    this.dispatch(decoded.value);
  }

  private dispatch(msg: WireMessage): void {
    switch (msg.kind) {
      case "welcome":
        this.user = msg.user;
        this.world = msg.world;
        this.bus.emit("welcome", { user: msg.user, world: msg.world });
        return;
      case "snapshot":
        this.applySnapshot(msg);
        return;
      case "ops":
        this.applyCommitted(msg);
        return;
      case "rejected":
        this.pending.delete(msg.txId);
        this.inFlight.delete(msg.txId);
        this.rebuildEcho();
        this.bus.emit("rejected", { txId: msg.txId, reason: msg.reason, detail: msg.detail });
        return;
      case "ephemeral":
        this.bus.emit("ephemeral", msg);
        return;
      case "kick":
        this.bus.emit("kick", { reason: msg.reason });
        this.close();
        return;
      case "roll.challenge": {
        const m = msg as RollChallengeMsg;
        const seed = this.committedRolls.get(m.rollId);
        if (seed !== undefined) {
          this.committedRolls.delete(m.rollId);
          this.send({ kind: "roll.reveal", rollId: m.rollId, seedClient: seed });
        }
        return;
      }
      // Client→host kinds and later-milestone kinds are never received here:
      case "hello":
      case "intent":
      case "roll":
      case "roll.reveal":
      case "asset.get":
      case "fog.put":
      case "relay.offer":
      case "turn.ready":
      case "sim.control":
      case "report.detail":
      case "sim.snapshot.get":
        return; // client→host kinds and later-milestone kinds are never received here
      case "asset.chunk":
        this.bus.emit("asset", msg);
        return;
      case "sim.delta":
        this.applySimDelta(msg);
        return;
      case "sim.snapshot":
        this.applySimSnapshot(msg);
        return;
      case "turn.phase":
        this.bus.emit("turnPhase", msg);
        return;
      case "turn.report":
        this.bus.emit("turnReport", msg);
        return;
      case "pong": {
        const pong = msg as PongMsg;
        const t3 = Date.now();
        this.clockSamples.push({ t0: pong.t0, t1: pong.t1, t2: pong.t2, t3 });
        if (this.clockSamples.length > 8) this.clockSamples.shift();
        this.bus.emit("pong", pong);
        return;
      }
      case "clock":
        this.bus.emit("clock", msg as ClockMsg);
        return;
      case "audio.cmd":
        this.bus.emit("audio", msg as AudioCmdMsg);
        return;
      case "ban":
      case "report.detail.page":
      case "heartbeat":
      case "ping":
      case "relay.frame":
        return; // wired in their units (relay)
    }
  }

  // ─── §5A strategic replica ─────────────────────────────────────────────────

  /** The local ModelPool replica (rendering reads this; null before sync). */
  get simReplica(): ModelPool | null {
    return this.simPool;
  }

  get simReplicaVersion(): number {
    return this.simVersion;
  }

  private applySimDelta(msg: SimDeltaMsg): void {
    if (!this.simSys || (this.simSceneId && msg.sceneId !== this.simSceneId)) return;
    const { delta, maxHpMax } = decodeSimDelta(msg.bytes);
    if (delta.fromVersion === this.simVersion && this.simPool) {
      applySimDelta(this.simPool, delta, maxHpMax, this.simSys);
      this.simVersion = delta.toVersion;
      this.bus.emit("sim", { version: this.simVersion, count: this.simPool.count, kind: "delta" });
      return;
    }
    if (delta.toVersion <= this.simVersion) return; // stale (e.g. post-undo replay)
    // gap → request a full snapshot once; queue for sequential replay (§5A)
    this.pendingDeltas.push(delta);
    if (!this.snapshotInFlight && this.simSceneId) {
      this.snapshotInFlight = true;
      this.send({ kind: "sim.snapshot.get", sceneId: this.simSceneId });
    }
  }

  private applySimSnapshot(msg: SimSnapshotMsg): void {
    if (!this.simSys || (this.simSceneId && msg.sceneId !== this.simSceneId)) return;
    const { snapshot, maxHpMax } = decodeSimSnapshot(msg.bytes);
    this.simPool = poolFromSnapshot(snapshot, maxHpMax, this.simSys);
    this.simVersion = snapshot.version;
    this.snapshotInFlight = false;
    this.bus.emit("sim", {
      version: this.simVersion,
      count: this.simPool.count,
      kind: "snapshot",
    });
    // replay queued deltas sequentially (§5A strictly-sequential application)
    const queued = this.pendingDeltas;
    this.pendingDeltas = [];
    for (const delta of queued.sort((a, b) => a.fromVersion - b.fromVersion)) {
      if (delta.fromVersion === this.simVersion && this.simPool) {
        applySimDelta(this.simPool, delta, maxHpMax, this.simSys);
        this.simVersion = delta.toVersion;
        this.bus.emit("sim", {
          version: this.simVersion,
          count: this.simPool.count,
          kind: "delta",
        });
      }
    }
  }

  /** Explicitly ask the host for a full pool snapshot (§5A gap recovery). */
  requestSimSnapshot(): void {
    if (this.simSceneId) this.send({ kind: "sim.snapshot.get", sceneId: this.simSceneId });
  }

  /** Player toggles turn readiness (§5A step 1). */
  setTurnReady(turnId: DocId, ready: boolean): void {
    this.send({ kind: "turn.ready", turnId, ready });
  }

  /**
   * §8/§9 fog explored-texture upload (periodic downscaled PNG readback).
   * The host stores it per user+scene for reconnect/world export.
   */
  sendFogPng(sceneId: DocId, png: Uint8Array): void {
    this.send({ kind: "fog.put", sceneId, png });
  }

  /** GM sim controls (§5A); non-GM sends are dropped by the host (§16). */
  simControl(
    action: SimControlAction,
    extra: { rateHz?: number; mode?: "stepwise" | "realtime"; deadlineMs?: number } = {},
  ): void {
    this.send({
      kind: "sim.control",
      action,
      ...(extra.rateHz !== undefined ? { rateHz: extra.rateHz } : {}),
      ...(extra.mode !== undefined ? { mode: extra.mode } : {}),
      ...(extra.deadlineMs !== undefined ? { deadlineMs: extra.deadlineMs } : {}),
    });
  }

  private applySnapshot(msg: SnapshotMsg): void {
    this.store.hydrate(msg.world.collections, msg.seq);
    // Late join (§14): buffered ops with seq > snapshot.seq apply now, in order.
    const buffered = this.buffer.filter((env) => env.seq > msg.seq).sort((a, b) => a.seq - b.seq);
    this.buffer = [];
    for (const env of buffered) this.applyEnvelopeInOrder(env);
    this.rebuildEcho();
    this.hasSnapshot = true;
    this.bus.emit("snapshot", { seq: msg.seq });
  }

  private applyCommitted(msg: OpsMsg): void {
    const env = msg.envelope;
    if (env.seq <= this.store.seq) return; // duplicate / stale (reconnect overlap)
    if (env.seq !== this.store.seq + 1) {
      if (!this.hasSnapshot) {
        // Late-join race (§14): ops may outrun the snapshot — buffer until it
        // lands, then apply in order. (Gap-skipping would build a partial
        // replica the snapshot could no longer reconcile.)
        this.buffer.push(env);
        return;
      }
      // §6.1 ops channel is reliable+ordered: a missing seq was OMITTED by
      // this user's projection (§5 hidden docs/whispers) — advance the
      // replica with empty gap envelopes (no mutations; D-065).
      let gapped = false;
      for (let seq = this.store.seq + 1; seq < env.seq; seq += 1) {
        const gap: OpEnvelope = { seq, ts: env.ts, by: env.by, txId: "projected-gap", ops: [] };
        if (!this.store.applyEnvelope(gap).ok) {
          gapped = true;
          break;
        }
      }
      if (gapped || env.seq !== this.store.seq + 1) {
        this.buffer.push(env); // genuinely out of order (defensive)
        return;
      }
    }
    this.applyEnvelopeInOrder(env);
  }

  private applyEnvelopeInOrder(env: OpEnvelope): void {
    const applied = this.store.applyEnvelope(env);
    if (!applied.ok) return; // hostile/foreign envelope dropped
    // drain buffered continuations
    for (;;) {
      const next = this.buffer.find((e) => e.seq === this.store.seq + 1);
      if (!next) break;
      this.buffer = this.buffer.filter((e) => e !== next);
      if (!this.store.applyEnvelope(next).ok) break;
    }
    const reconciled = this.inFlight.has(env.txId) ? env.txId : null;
    if (reconciled) {
      this.inFlight.delete(reconciled);
      this.pending.delete(reconciled);
      this.rebuildEcho();
    }
    this.bus.emit("ops", { envelope: env, reconciled });
  }

  /** Rebuild the optimistic echo = committed replica + pending envelopes. */
  private rebuildEcho(): void {
    const snapshot = this.store.serialize();
    const echo = DocumentStore.load(snapshot);
    for (const [txId, ops] of this.pending) {
      const tentative: OpEnvelope = {
        seq: echo.seq + 1,
        ts: this.now(),
        by: this.user?.id ?? "pending",
        ops,
        txId,
      };
      if (!echo.applyEnvelope(tentative).ok) {
        this.pending.delete(txId); // locally invalid: no echo, await host verdict
      }
    }
    this.echoImpl = echo;
  }
}
