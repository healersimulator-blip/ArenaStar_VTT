/**
 * §5/§6.4 HostSync — the authoritative sync endpoint (host side).
 *
 *   intent → validate (rate limit → permissions → schema-lite → invariants)
 *          → apply to DocumentStore (seq++) → append to OpLog (pre-images)
 *          → project per user → broadcast commit{ops} or rejected{txId}.
 *
 * Also: hello join flow (verify signature → ban check → approval event →
 * welcome + snapshot / ops-since-seq catch-up, D-031), host-executed rolls
 * (§11), ephemeral relay (never touches store/OpLog, §5), kick/ban, undo/redo
 * envelopes (§8). Only HostSync mutates authoritative state; sessions are
 * transports + identity + per-peer rate limiters (§16).
 */
import {
  OWNERSHIP_LEVELS,
  type BaseDocument,
  type CollectionName,
  type MessageDocument,
  type Role,
  type UserDocument,
  type Ownership,
} from "../core/documents";
import type { DocRef, Json } from "../core/documents";
import type { Op, OpEnvelope } from "../core/ops";
import type {
  AudioCmdMsg,
  EphemeralMsg,
  HelloMsg,
  PingMsg,
  ReportDetailMsg,
  RollMsg,
  RollRevealMsg,
  SimControlMsg,
  SimSnapshotGetMsg,
  TurnReadyMsg,
  WireMessage,
} from "../core/messages";
import { evaluateCommitRoll, randomSeedHex, sha256Hex } from "../dice/commitReveal";
import type { AssetId, PeerId, TxId, UserId } from "../core/ids";
import { DocumentStore } from "../core/store";
import { OpLog } from "../core/oplog";
import { UndoStack } from "../core/undo";
import { can, getEffectiveOwnership } from "../core/permissions";
import { projectEnvelope, projectWorld } from "../core/projection";
import { applyDiff } from "../core/diff";
import {
  TokenBucket,
  createAssetRateLimiter,
  createEphemeralRateLimiter,
  createIntentRateLimiter,
} from "../core/ratelimit";
import type { AssetGetMsg } from "../core/messages";
import type { AssetServer } from "./assets";
import { AssetTransfer } from "../net/transfer";
import type { EventBus, PermissionUser } from "../core";
import type { Transport } from "../core/net";
import { frameMessage, deframeMessage, channelFor } from "../net/frame";
import { verifyHello } from "../net/identity";
import { evaluateFormula, validateFormula } from "../dice";
import type { RngFn } from "../dice";

export interface SessionUser extends PermissionUser {
  name: string;
}

export interface HostEvents {
  "join:request": {
    peerId: PeerId;
    hello: HelloMsg;
    approve: (role?: Role) => void;
    deny: (reason?: string) => void;
  };
  "join:approved": { peerId: PeerId; userId: UserId; known: boolean };
  "join:denied": { peerId: PeerId; reason: string };
  "peer:closed": { peerId: PeerId; reason: string };
}

/** §5A sim/turn handlers (TurnChannel); wired via `attachSim` (unit: sim channel). */
export interface SimChannelHooks {
  handleTurnReady(user: SessionUser, msg: TurnReadyMsg): void;
  handleSimControl(user: SessionUser, msg: SimControlMsg): void;
  handleReportDetail(user: SessionUser, msg: ReportDetailMsg): void;
  handleSimSnapshotGet(user: SessionUser, msg: SimSnapshotGetMsg): void;
}

export interface HostSyncOptions {
  store: DocumentStore;
  log: OpLog;
  undo: UndoStack;
  bus: EventBus<HostEvents>;
  /** The host GM's userId — internal commits (rolls, user docs) are `by` them. */
  systemUserId: UserId;
  /** Room id for hello signature verification (§6.2 invite link). */
  roomId: string;
  /** Injectable verifier (tests); default verifies via WebCrypto (§6.4). */
  verifyHelloSig?: (hello: HelloMsg, roomId: string) => Promise<boolean>;
  /** Asset manifest source for snapshots (AssetServer wiring; default: store's). */
  manifest?: () => Record<AssetId, { name: string; mime: string; size: number; chunks: number }>;
  /**
   * §7: when present, asset.get requests are served from this server via an
   * AssetTransfer (priority queue + per-peer bandwidth cap).
   */
  assets?: AssetServer;
  /** Transfer overrides (tests): chunk size, bandwidth cap, clock. */
  assetTransfer?: { chunkSize?: number; bytesPerSecond?: number; now?: () => number };
  rng?: RngFn;
  now?: () => number;
}

interface Session {
  peerId: PeerId;
  transport: Transport;
  user: SessionUser | null;
  pendingHello: HelloMsg | null;
  intentBucket: TokenBucket;
  ephemeralBucket: TokenBucket;
  assetBucket: TokenBucket;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function cryptoRng(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] as number) / 2 ** 32;
}

/** §10/§11: rewrite `[[formula]]` → `[[total|formula]]` with host rng.
 * Invalid formulas stay literal text (explicit, never silently dropped). */
const INLINE_ROLL = /\[\[([^[\]]{1,120})\]\]/g;

function resolveInlineRolls(content: string, rng: RngFn): string {
  return content.replace(INLINE_ROLL, (whole, formula: string) => {
    const trimmed = formula.trim();
    if (trimmed.length === 0) return whole;
    const evaluation = evaluateFormula(trimmed, undefined, rng);
    return evaluation.ok ? `[[${evaluation.value.total}|${trimmed}]]` : whole;
  });
}

/** Top-level docs whose ownership field this envelope replaces. */
interface OwnershipCrossing {
  key: string;
  doc: BaseDocument;
  prev: Ownership;
}

function ownershipCrossings(
  envelope: OpEnvelope,
  inverses: readonly Op[],
  resolveTop: (ref: DocRef) => BaseDocument | undefined,
): OwnershipCrossing[] {
  const out: OwnershipCrossing[] = [];
  for (let i = 0; i < envelope.ops.length; i += 1) {
    const op: Op | undefined = envelope.ops[i];
    const inverse: Op | undefined = inverses[i];
    if (!op || !inverse) continue;
    if (op.kind !== "update" || inverse.kind !== "update") continue;
    if (!("ownership" in op.diff) || !("ownership" in inverse.diff)) continue;
    const doc = resolveTop(op.ref);
    if (!doc) continue;
    out.push({
      key: `${op.ref.coll}/${op.ref.id}`,
      doc,
      prev: inverse.diff.ownership as Ownership,
    });
  }
  return out;
}

/**
 * Per-op projection merged with boundary rewrites: a grant to a session that
 * never saw the create becomes a full-doc create; a revoke becomes a delete
 * (the plain projection would DROP the update for the newly-blind session,
 * leaving a stale doc in the replica). Same seq, no protocol additions.
 */
function projectWithCrossings(
  envelope: OpEnvelope,
  user: PermissionUser,
  crossings: OwnershipCrossing[],
  resolver: { resolve: (ref: DocRef) => BaseDocument | undefined },
): OpEnvelope | null {
  let modified = false;
  const ops: Op[] = [];
  for (const rawOp of envelope.ops) {
    const op = rawOp as Extract<Op, { kind: "update" }>;
    const crossing =
      rawOp.kind === "update"
        ? crossings.find((c) => c.key === `${rawOp.ref.coll}/${rawOp.ref.id}`)
        : undefined;
    if (crossing) {
      const nowVisible = getEffectiveOwnership(user, crossing.doc) >= OWNERSHIP_LEVELS.LIMITED;
      const wasVisible =
        getEffectiveOwnership(user, { ...crossing.doc, ownership: crossing.prev }) >=
        OWNERSHIP_LEVELS.LIMITED;
      if (nowVisible && !wasVisible) {
        ops.push({ kind: "create", coll: op.ref.coll, data: structuredClone(crossing.doc) });
        modified = true;
        continue;
      }
      if (!nowVisible && wasVisible) {
        ops.push({ kind: "delete", ref: op.ref });
        modified = true;
        continue;
      }
    }
    const single = projectEnvelope({ ...envelope, ops: [rawOp] }, user, resolver);
    if (single) {
      if (single.ops.length !== 1 || single.ops[0] !== rawOp) modified = true;
      ops.push(...single.ops);
    } else {
      modified = true; // op projected away for this session
    }
  }
  if (ops.length === 0) return null;
  return modified || ops.length !== envelope.ops.length ? { ...envelope, ops } : envelope;
}

export class HostSync {
  private readonly store: DocumentStore;
  private readonly log: OpLog;
  private readonly undoStack: UndoStack;
  readonly bus: EventBus<HostEvents>;
  private readonly systemUserId: UserId;
  private readonly roomId: string;
  private readonly verifySig: (hello: HelloMsg, roomId: string) => Promise<boolean>;
  private readonly manifestSource: NonNullable<HostSyncOptions["manifest"]>;
  private readonly transfer: AssetTransfer | null;
  private readonly rng: RngFn;
  private readonly now: () => number;
  /** §8/§9 fog readbacks: `${sceneId}:${userId}` → latest PNG bytes. */
  readonly fogPngs = new Map<string, Uint8Array>();

  private sessions = new Map<PeerId, Session>();
  private banned = new Set<UserId>();
  private sim: SimChannelHooks | null = null;

  /** Wire the §5A turn/sim channel (HostSync remains the only talker, §2). */
  attachSim(hooks: SimChannelHooks): void {
    this.sim = hooks;
  }

  /**
   * System commit path for host machinery (turn docs, unit stat envelopes).
   * Same single-commit invariants as user intents; undo recording optional.
   */
  commitSystem(
    ops: Op[],
    recordUndo = false,
  ): { ok: true; seq: number } | { ok: false; error: string } {
    return this.commitOps(ops, this.systemUserId, `sys-${randomId()}`, recordUndo);
  }

  /** Send a sim/turn wire message to authenticated sessions (GM always). */
  broadcastSim(msg: WireMessage, include?: (user: SessionUser) => boolean): void {
    for (const session of this.sessions.values()) {
      if (!session.user) continue;
      if (include && !include(session.user)) continue;
      this.send(session, msg);
    }
  }

  constructor(options: HostSyncOptions) {
    this.store = options.store;
    this.log = options.log;
    this.undoStack = options.undo;
    this.bus = options.bus;
    this.systemUserId = options.systemUserId;
    this.roomId = options.roomId;
    this.verifySig = options.verifyHelloSig ?? verifyHello;
    this.manifestSource = options.manifest ?? (() => this.store.world.assetManifest);
    this.transfer = options.assets
      ? new AssetTransfer(
          options.assets.read,
          {
            send: (peerId, chunk) => {
              const session = this.sessions.get(peerId);
              if (session?.user) this.send(session, chunk);
            },
          },
          options.assetTransfer ?? {},
        )
      : null;
    this.rng = options.rng ?? cryptoRng;
    this.now = options.now ?? (() => Date.now());
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  /** Attach a peer transport.GM loopback sessions may pass their user directly. */
  addSession(peerId: PeerId, transport: Transport, user?: SessionUser): void {
    const session: Session = {
      peerId,
      transport,
      user: user ?? null,
      pendingHello: null,
      intentBucket: createIntentRateLimiter(this.now),
      ephemeralBucket: createEphemeralRateLimiter(this.now),
      assetBucket: createAssetRateLimiter(this.now),
    };
    this.sessions.set(peerId, session);
    transport.onMessage = (_channel, bytes) => this.onFrame(session, bytes);
    if (user) this.welcomeSession(session, user, undefined);
  }

  removeSession(peerId: PeerId, reason = "closed"): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    try {
      session.transport.close();
    } catch {
      // already closed
    }
    this.bus.emit("peer:closed", { peerId, reason });
  }

  kick(peerId: PeerId, reason: string): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    if (session.user) {
      this.send(session, { kind: "kick", reason });
    }
    this.removeSession(peerId, `kick: ${reason}`);
  }

  ban(userId: UserId, reason = "banned"): void {
    this.banned.add(userId);
    for (const session of this.sessions.values()) {
      if (session.user?.id === userId) this.kick(session.peerId, reason);
    }
  }

  isBanned(userId: UserId): boolean {
    return this.banned.has(userId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Authenticated session users (turn channel fan-out). */
  sessionUsers(): SessionUser[] {
    const out: SessionUser[] = [];
    for (const session of this.sessions.values()) {
      if (session.user) out.push(session.user);
    }
    return out;
  }

  // ─── Frames ─────────────────────────────────────────────────────────────────

  private send(session: Session, msg: WireMessage): void {
    try {
      session.transport.send(channelFor(msg.kind), frameMessage(msg));
    } catch {
      this.removeSession(session.peerId, "send failed (transport closed)");
    }
  }

  private onFrame(session: Session, bytes: Uint8Array): void {
    const decoded = deframeMessage(bytes);
    if (!decoded.ok) return; // malformed frame: drop silently (§16)
    this.dispatch(session, decoded.value);
  }

  private dispatch(session: Session, msg: WireMessage): void {
    switch (msg.kind) {
      case "hello":
        void this.handleHello(session, msg);
        return;
      case "intent":
        this.handleIntent(session, msg.txId, msg.ops);
        return;
      case "roll":
        this.handleRoll(session, msg);
        return;
      case "roll.reveal":
        this.handleRollReveal(session, msg as RollRevealMsg);
        return;
      case "ephemeral":
        this.handleEphemeral(session, msg);
        return;
      // Host→client kinds and later-milestone kinds are never accepted here:
      case "welcome":
      case "snapshot":
      case "ops":
      case "rejected":
      case "asset.chunk":
      case "ping":
        this.handlePing(session, msg as PingMsg);
        return;
      case "audio.cmd":
        this.handleAudioCmd(session, msg as AudioCmdMsg);
        return;
      case "clock":
      case "kick":
      case "ban":
      case "sim.delta":
      case "sim.snapshot":
      case "turn.phase":
      case "turn.report":
      case "report.detail.page":
      case "heartbeat":
      case "pong":
      case "relay.offer":
      case "relay.frame":
        return; // wired in their units (sim/turn/clock), or host-only
      case "asset.get":
        this.handleAssetGet(session, msg);
        return;
      case "fog.put":
        // §8/§9: keep the latest explored-texture readback per user+scene
        // (reconnect + future world export; D-075).
        if (session.user) {
          this.fogPngs.set(`${msg.sceneId}:${session.user.id}`, msg.png);
        }
        return;
      case "turn.ready":
        if (session.user && this.sim) this.sim.handleTurnReady(session.user, msg);
        return;
      case "sim.control":
        if (session.user && this.sim) this.sim.handleSimControl(session.user, msg);
        return;
      case "report.detail":
        if (session.user && this.sim) this.sim.handleReportDetail(session.user, msg);
        return;
      case "sim.snapshot.get":
        if (session.user && this.sim) this.sim.handleSimSnapshotGet(session.user, msg);
        return;
    }
  }

  // ─── Join flow (§6.4) ───────────────────────────────────────────────────────

  private async handleHello(session: Session, hello: HelloMsg): Promise<void> {
    if (session.user) return; // already authed
    if (this.banned.has(hello.pubkey)) {
      this.send(session, { kind: "kick", reason: "banned" });
      this.removeSession(session.peerId, "banned pubkey");
      return;
    }
    const valid = await this.verifySig(hello, this.roomId);
    if (!valid) {
      this.send(session, { kind: "kick", reason: "invalid hello signature" });
      this.removeSession(session.peerId, "invalid signature");
      return;
    }
    session.pendingHello = hello;
    const known = this.store.get("users", hello.pubkey) !== undefined;
    // §6.4: auto-approve known pubkeys; unknown pubkeys raise a join:request.
    if (known) {
      this.approveSession(session, hello, true);
      return;
    }
    let settled = false;
    this.bus.emit("join:request", {
      peerId: session.peerId,
      hello,
      approve: (role?: Role) => {
        if (settled) return;
        settled = true;
        this.approveSession(session, hello, false, role ?? "PLAYER");
      },
      deny: (reason?: string) => {
        if (settled) return;
        settled = true;
        const why = reason ?? "denied by GM";
        this.send(session, { kind: "kick", reason: why });
        this.removeSession(session.peerId, why);
        this.bus.emit("join:denied", { peerId: session.peerId, reason: why });
      },
    });
  }

  private approveSession(
    session: Session,
    hello: HelloMsg,
    known: boolean,
    role: Role = "PLAYER",
  ): void {
    let user = this.store.get("users", hello.pubkey) as UserDocument | undefined;
    if (!user) {
      user = {
        _id: hello.pubkey,
        type: "user",
        name: hello.displayName,
        ownership: { default: OWNERSHIP_LEVELS.NONE },
        flags: {},
        system: {},
        role,
        character: null,
        color: "#9a9ab0",
      };
      const committed = this.commitOps(
        [{ kind: "create", coll: "users", data: user }],
        this.systemUserId,
        `join-${randomId()}`,
        false,
      );
      if (!committed.ok) {
        this.send(session, { kind: "kick", reason: "join failed" });
        this.removeSession(session.peerId, "join commit failed");
        return;
      }
    }
    session.user = { id: user._id, role: user.role, name: user.name };
    session.pendingHello = null;
    this.bus.emit("join:approved", { peerId: session.peerId, userId: user._id, known });
    this.welcomeSession(session, session.user, hello);
  }

  /** welcome + (snapshot | ops-since-seq) for an authenticated session. */
  private welcomeSession(session: Session, user: SessionUser, hello: HelloMsg | undefined): void {
    this.send(session, {
      kind: "welcome",
      user: { id: user.id, role: user.role, name: user.name },
      world: {
        id: this.store.meta.worldId,
        name: this.store.meta.name,
        system: this.store.meta.system,
        version: this.store.meta.systemVersion,
      },
      snapshotSeq: this.catchUpSeq(session, hello),
    });
  }

  /**
   * §5/D-031: with a valid lastSeq inside the retained log, send ops-since
   * instead of a full snapshot. Returns the seq the client is current to.
   */
  private catchUpSeq(session: Session, hello: HelloMsg | undefined): number {
    const lastSeq = hello?.lastSeq;
    if (
      typeof lastSeq === "number" &&
      Number.isInteger(lastSeq) &&
      lastSeq >= 0 &&
      lastSeq <= this.store.seq &&
      lastSeq >= this.log.baseSeq
    ) {
      for (const env of this.log.since(lastSeq)) {
        this.send(session, { kind: "ops", envelope: env });
      }
      return lastSeq;
    }
    // Full projected snapshot (§5: manifest only — assets stream lazily, §7).
    this.send(session, {
      kind: "snapshot",
      seq: this.store.seq,
      world: projectWorld(this.store.world, this.store.seq, session.user as SessionUser),
      manifest: this.manifestSource(),
    });
    return this.store.seq;
  }

  // ─── Intents (§5) ───────────────────────────────────────────────────────────

  private reject(session: Session, txId: TxId, reason: string, detail: string): void {
    this.send(session, { kind: "rejected", txId, reason: reason as never, detail });
  }

  private handleIntent(session: Session, txId: TxId, ops: Op[]): void {
    if (!session.user) {
      this.reject(session, txId, "forbidden", "not authenticated");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, txId, "rate_limited", "intent rate exceeded");
      return;
    }
    const normalized = this.normalizeOps(session.user.id, ops);
    if (!normalized.ok) {
      this.reject(session, txId, "invalid_schema", normalized.error);
      return;
    }
    const validation = this.validateOps(session.user, normalized.ops);
    if (!validation.ok) {
      this.reject(session, txId, validation.reason, validation.error);
      return;
    }
    const committed = this.commitOps(normalized.ops, session.user.id, txId);
    if (!committed.ok) {
      this.reject(session, txId, "invariant", committed.error);
    }
  }

  /** Host-side normalization: chat messages carry the caller's identity (§4);
   * inline `[[formula]]` rolls are resolved HERE (§11: rolls execute on the
   * host) and embedded as `[[total|formula]]` chips in the committed content. */
  private normalizeOps(
    by: UserId,
    ops: Op[],
  ): { ok: true; ops: Op[] } | { ok: false; error: string } {
    const out: Op[] = [];
    for (const op of ops) {
      if (op.kind === "create" && op.coll === "messages") {
        const data = structuredClone(op.data) as MessageDocument;
        data.author = by;
        if (data.whisper === undefined) data.whisper = [];
        data.content = resolveInlineRolls(data.content, this.rng);
        if (
          data.ownership.default < OWNERSHIP_LEVELS.LIMITED &&
          Object.keys(data.ownership).length <= 1
        ) {
          data.ownership = { ...data.ownership, default: OWNERSHIP_LEVELS.LIMITED };
        }
        out.push({ ...op, data });
        continue;
      }
      out.push(op);
    }
    return { ok: true, ops: out };
  }

  /** §5 validation: permissions per op (+ cascade parents), schema-lite diffs. */
  private validateOps(
    user: SessionUser,
    ops: Op[],
  ): { ok: true } | { ok: false; reason: "forbidden" | "invalid_schema"; error: string } {
    for (const op of ops) {
      switch (op.kind) {
        case "create": {
          const parent = op.parent !== undefined ? this.store.resolve(op.parent) : undefined;
          const canOpts = parent ? { parent } : {};
          if (op.parent !== undefined && !parent) {
            return { ok: false, reason: "invalid_schema", error: `create: parent not found` };
          }
          const collName = (op.parent ? op.coll : op.coll) as CollectionName;
          if (!can(user, "create", op.data, collName, canOpts)) {
            return { ok: false, reason: "forbidden", error: `create ${op.coll}` };
          }
          if (op.coll === "users") {
            return { ok: false, reason: "forbidden", error: "users are assigned by the host only" };
          }
          continue;
        }
        case "update": {
          const doc = this.store.resolve(op.ref);
          if (!doc)
            return { ok: false, reason: "invalid_schema", error: `update: target not found` };
          const parent =
            op.ref.parent !== undefined ? this.store.resolve(op.ref.parent) : undefined;
          const canOpts = parent ? { parent } : {};
          if (!can(user, "update", doc, this.embeddedCollName(op.ref), canOpts)) {
            return { ok: false, reason: "forbidden", error: `update ${op.ref.coll}/${op.ref.id}` };
          }
          const dry = applyDiff(doc, op.diff);
          if (!dry.ok) return { ok: false, reason: "invalid_schema", error: dry.error };
          continue;
        }
        case "delete": {
          const doc = this.store.resolve(op.ref);
          if (!doc)
            return { ok: false, reason: "invalid_schema", error: `delete: target not found` };
          const parent =
            op.ref.parent !== undefined ? this.store.resolve(op.ref.parent) : undefined;
          const canOpts = parent ? { parent } : {};
          if (!can(user, "delete", doc, this.embeddedCollName(op.ref), canOpts)) {
            return { ok: false, reason: "forbidden", error: `delete ${op.ref.coll}/${op.ref.id}` };
          }
          continue;
        }
      }
    }
    return { ok: true };
  }

  private embeddedCollName(ref: DocRef): CollectionName {
    return (ref.parent ? ref.coll : ref.coll) as CollectionName;
  }

  /**
   * The single commit path (invariant: only HostSync mutates authoritative
   * state, always as an OpEnvelope with monotonic seq). Broadcasts the
   * projected envelope to every authenticated session.
   */
  private commitOps(
    ops: Op[],
    by: UserId,
    txId: TxId,
    recordUndo = true,
  ): { ok: true; seq: number } | { ok: false; error: string } {
    const envelope: OpEnvelope = { seq: this.store.seq + 1, ts: this.now(), by, ops, txId };
    const applied = this.store.applyEnvelope(envelope);
    if (!applied.ok) return { ok: false, error: applied.error };
    const appended = this.log.append(envelope, applied.value.inverses);
    if (!appended.ok) return { ok: false, error: appended.error };
    if (recordUndo) this.undoStack.push(envelope, applied.value.inverses);
    this.broadcastEnvelope(envelope, applied.value.inverses);
    return { ok: true, seq: envelope.seq };
  }

  private broadcastEnvelope(envelope: OpEnvelope, inverses: readonly Op[] = []): void {
    // §5 visibility crossings: updates whose diff replaces `ownership` may
    // cross a session's read boundary. New viewers never received the create
    // (it was projected away) — rewrite as a full-doc create; revoked viewers
    // get a delete. Same seq, no protocol additions (D-064).
    const crossings = ownershipCrossings(envelope, inverses, (ref) =>
      ref.parent === undefined ? this.store.get(ref.coll as CollectionName, ref.id) : undefined,
    );
    for (const session of this.sessions.values()) {
      if (!session.user) continue;
      const resolver = { resolve: (ref: DocRef) => this.store.resolve(ref) };
      const projected =
        crossings.length > 0
          ? projectWithCrossings(envelope, session.user, crossings, resolver)
          : projectEnvelope(envelope, session.user, resolver);
      if (projected) this.send(session, { kind: "ops", envelope: projected });
    }
  }

  // ─── Assets (§7) ─────────────────────────────────────────────────────────────

  private handleAssetGet(session: Session, msg: AssetGetMsg): void {
    if (!session.user) return; // requires an approved session (§16)
    if (!session.assetBucket.tryRemove()) return; // §16: silently dropped
    if (!this.transfer) return; // no asset server wired (unit: assets)
    this.transfer.request(session.peerId, msg.assetId, msg.offset, msg.priority);
  }

  // ─── §7 audio + clock ───────────────────────────────────────────────────────

  /** Lead time stamped on rebroadcast so clients can schedule ahead (§7). */
  static readonly AUDIO_LEAD_MS = 120;

  /** §7 NTP-style probe: reply {t0, t1 recv, t2 send} on the host clock. */
  private handlePing(session: Session, msg: PingMsg): void {
    const t1 = this.now();
    const t2 = this.now();
    this.send(session, { kind: "pong", t0: msg.t0, t1, t2 });
  }

  /**
   * §7 playback command: GM/ASSISTANT requests are stamped on the host clock
   * (now + lead) and rebroadcast to every authenticated session — including
   * the GM loopback (the GM UI only ever speaks ClientSync, §2).
   */
  private handleAudioCmd(session: Session, msg: AudioCmdMsg): void {
    const user = session.user;
    if (!user || (user.role !== "GM" && user.role !== "ASSISTANT")) {
      this.send(session, {
        kind: "rejected",
        txId: "audio",
        reason: "forbidden",
        detail: "audio.cmd requires GM or ASSISTANT",
      });
      return;
    }
    const out: AudioCmdMsg = {
      kind: "audio.cmd",
      playlistId: msg.playlistId,
      soundId: msg.soundId,
      action: msg.action,
      atHostTime: this.now() + HostSync.AUDIO_LEAD_MS,
      offset: msg.offset,
    };
    this.broadcastSim(out);
  }

  // ─── Rolls (§11) ────────────────────────────────────────────────────────────

  private handleRoll(session: Session, msg: RollMsg): void {
    if (!session.user) {
      this.reject(session, msg.rollId, "forbidden", "not authenticated");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, msg.rollId, "rate_limited", "roll rate exceeded");
      return;
    }
    if (!validateFormula(msg.formula).ok) {
      this.reject(session, msg.rollId, "invalid_schema", `bad formula: ${msg.formula}`);
      return;
    }
    if (msg.commit !== undefined) {
      // §11 commit-reveal step 2: answer with the host seed BEFORE the
      // client's seed is known; the roll resolves on reveal
      this.sweepPendingRolls();
      const seedHost = randomSeedHex();
      this.pendingRolls.set(msg.rollId, {
        session,
        formula: msg.formula,
        rollData: msg.rollData,
        mode: msg.mode,
        to: msg.to,
        commit: msg.commit,
        seedHost,
        ts: this.now(),
      });
      this.send(session, { kind: "roll.challenge", rollId: msg.rollId, seedHost });
      return;
    }
    const evaluation = evaluateFormula(msg.formula, msg.rollData, this.rng);
    if (!evaluation.ok) {
      this.reject(session, msg.rollId, "invalid_schema", evaluation.error);
      return;
    }
    const message: MessageDocument = {
      _id: randomId(),
      type: "message",
      name: msg.formula,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { rollId: msg.rollId } },
      system: {},
      author: session.user.id,
      content: msg.formula,
      whisper: msg.mode === "gmroll" || msg.mode === "blindroll" ? [] : (msg.to ?? []),
      roll: {
        formula: msg.formula,
        total: evaluation.value.total,
        terms: evaluation.value.terms,
        seedClient: null,
        seedHost: null,
      },
      rollMode: msg.mode,
      flavor: "",
    };
    this.commitOps(
      [{ kind: "create", coll: "messages", data: message }],
      session.user.id,
      `roll-${msg.rollId}`,
      false,
    );
  }

  // ─── §11 commit-reveal rolls ────────────────────────────────────────────────

  private readonly pendingRolls = new Map<
    string,
    {
      session: Session;
      formula: string;
      rollData: Record<string, Json> | undefined;
      mode: RollMsg["mode"];
      to: UserId[] | undefined;
      commit: string;
      seedHost: string;
      ts: number;
    }
  >();

  /** Drop abandoned commitments after 60 s (client never revealed). */
  private sweepPendingRolls(): void {
    const cutoff = this.now() - 60_000;
    for (const [id, p] of this.pendingRolls) {
      if (p.ts < cutoff) this.pendingRolls.delete(id);
    }
  }

  private handleRollReveal(session: Session, msg: RollRevealMsg): void {
    const pending = this.pendingRolls.get(msg.rollId);
    if (!pending || pending.session !== session) {
      this.reject(session, msg.rollId, "invalid_schema", "no pending committed roll");
      return;
    }
    this.pendingRolls.delete(msg.rollId);
    void (async () => {
      if ((await sha256Hex(msg.seedClient)) !== pending.commit) {
        this.reject(session, msg.rollId, "invalid_schema", "commit-reveal: commitment mismatch");
        return;
      }
      const evaluation = await evaluateCommitRoll(
        pending.formula,
        msg.seedClient,
        pending.seedHost,
        pending.rollData,
      );
      if (!evaluation.ok) {
        this.reject(session, msg.rollId, "invalid_schema", evaluation.error);
        return;
      }
      const message: MessageDocument = {
        _id: randomId(),
        type: "message",
        name: pending.formula,
        ownership: { default: OWNERSHIP_LEVELS.LIMITED },
        flags: { core: { rollId: msg.rollId } },
        system: {},
        author: session.user?.id ?? this.systemUserId,
        content: pending.formula,
        whisper: pending.mode === "gmroll" || pending.mode === "blindroll" ? [] : (pending.to ?? []),
        roll: {
          formula: pending.formula,
          total: evaluation.value.total,
          terms: evaluation.value.terms,
          seedClient: msg.seedClient,
          seedHost: pending.seedHost,
          commit: pending.commit,
        },
        rollMode: pending.mode,
        flavor: "",
      };
      this.commitOps(
        [{ kind: "create", coll: "messages", data: message }],
        session.user?.id ?? this.systemUserId,
        `roll-${msg.rollId}`,
        false,
      );
    })();
  }

  // ─── Ephemeral relay (§5) ───────────────────────────────────────────────────

  private handleEphemeral(session: Session, msg: EphemeralMsg): void {
    if (!session.user) return;
    if (!session.ephemeralBucket.tryRemove()) return; // silently drop (§5 rate limit)
    // Invariant: ephemeral traffic never touches the DocumentStore or OpLog.
    const relay: EphemeralMsg = { ...msg, from: session.user.id };
    for (const other of this.sessions.values()) {
      if (other.peerId === session.peerId || !other.user) continue;
      this.send(other, relay);
    }
  }

  // ─── Undo / redo (§8) ───────────────────────────────────────────────────────

  /** GM-only by caller (UI gates on role); applies the undo envelope. */
  undo(): { ok: boolean; error?: string } {
    const item = this.undoStackApply("undo");
    if (!item.ok) return item;
    const committed = this.commitOps(item.ops, this.systemUserId, `undo-${randomId()}`, false);
    return committed.ok ? { ok: true } : { ok: false, error: committed.error };
  }

  redo(): { ok: boolean; error?: string } {
    const item = this.undoStackApply("redo");
    if (!item.ok) return item;
    const committed = this.commitOps(item.ops, this.systemUserId, `redo-${randomId()}`, false);
    return committed.ok ? { ok: true } : { ok: false, error: committed.error };
  }

  private undoStackApply(
    which: "undo" | "redo",
  ): { ok: true; ops: Op[] } | { ok: false; error: string } {
    const item = which === "undo" ? this.undoStack.applyUndo() : this.undoStack.applyRedo();
    if (!item) return { ok: false, error: `nothing to ${which}` };
    return { ok: true, ops: item.ops };
  }

  /** World info for welcome messages (exposed for tests/UI). */
  get worldInfo(): { id: string; name: string; system: string; version: string } {
    return {
      id: this.store.meta.worldId,
      name: this.store.meta.name,
      system: this.store.meta.system,
      version: this.store.meta.systemVersion,
    };
  }
}

/** Convenience: build a SessionUser for the GM loopback (host's own tab). */
export function gmSessionUser(id: UserId, name = "GM"): SessionUser {
  return { id, role: "GM", name };
}

export type { Json, BaseDocument };
