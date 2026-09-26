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
  type AssetManifest,
  type AutomationDocument,
  type ActionReceiptDocument,
  type BaseDocument,
  type CollectionName,
  type MessageDocument,
  type MacroDocument,
  type PrefabDocument,
  type FxInstanceDocument,
  type Role,
  type UserDocument,
} from "../core/documents";
import type {
  ActorDocument,
  DocRef,
  Json,
  SceneDocument,
  TileDocument,
  TokenDocument,
} from "../core/documents";
import type { Op, OpEnvelope } from "../core/ops";
import type {
  AudioCmdMsg,
  EphemeralMsg,
  AutomationRequestMsg,
  AutomationClickMsg,
  AutomationTraceMsg,
  TaggerRulesMsg,
  TaggerRulesResultMsg,
  PrefabPlaceMsg,
  SummonPlaceMsg,
  SummonDismissMsg,
  SummonResultMsg,
  MacroRequestMsg,
  MacroResultMsg,
  FxRequestMsg,
  FxStartMsg,
  FxStopMsg,
  FxStopMatchingMsg,
  HelloMsg,
  PingMsg,
  ReportDetailMsg,
  RollMsg,
  RollRevealMsg,
  SimControlMsg,
  SimSnapshotGetMsg,
  TurnReadyMsg,
  WelcomeMsg,
  WelcomeSimInfo,
  WireMessage,
} from "../core/messages";
import {
  evaluateCommitRoll,
  randomSeedHex,
  sha256Hex,
} from "../dice/commitReveal";
import { worldSettingsFrom } from "../core/worldSettings";
import {
  isPendingExpired,
  pendingPruneOps,
  shouldDeferToPlayer,
  resolvePendingRoll as resolvePendingRollDoc,
} from "../packages/pf1e/pendingRoll";
import type { PendingRoll } from "../packages/pf1e/pendingRoll";
import {
  canPlayerReroll as canLedgerPlayerReroll,
  canReroll as canLedgerReroll,
  canRevert as canLedgerRevert,
  delegateRerollOps,
  ledgerStaleReason,
  planDamageDeltaReroll,
  pruneOpsForWindow as rollLedgerPruneOps,
  rerollOps as ledgerRerollOps,
  revertOps as ledgerRevertOps,
  tacticalLedgerTurn,
} from "../packages/pf1e/rollLedger";
import type { RollLedger, RollLedgerRoll } from "../packages/pf1e/rollLedger";
import { deriveFromActorDocument } from "../packages/pf1e/actor";
import { planAutomationHealth } from "../packages/pf1e/automationHealth";
import {
  appliedWith,
  planRollApply,
  readRollApplications,
} from "../packages/pf1e/rollApply";
import type { DocId, PeerId, TxId, UserId } from "../core/ids";
import { DocumentStore } from "../core/store";
import { actionOpRef, actionStaleReason, extendActionReceipt, missingActionMessageDeletes,
  type ActionAudit } from "../core/actionRevert";
import { OpLog } from "../core/oplog";
import { UndoStack } from "../core/undo";
import { can } from "../core/permissions";
import { canFetchAsset, projectAssetManifest } from "../core/assetAccess";
import { fxAudienceAllows, fxSectionsForViewer, resolveFxSequence, validateFxSequence,
  type FxAudience } from "../core/fx";
import type { ResolvedFxSection } from "../core/fx";
import { planAutomation, sweptTileEvents, tileContainsPoint, validateAutomation, validateAutomationState,
  type AutomationEvent, type AutomationMethod } from "../core/automation";
import { attachedDeletionOps, attachedMovementOps, planPrefabPlacement, PREFAB_COLLECTIONS, validatePrefab } from "../core/prefabs";
import { boundFxDeletionOps, fxInstanceMatches, validateFxInstance, validateFxInstanceFilter } from "../core/fxInstances";
import { fxPresetDocumentError, macroStrayPresetError } from "../core/fxPresets";
import { fxBindingDeletionOps, fxBindingEvents, fxItemBindingError } from "../core/fxBinding";
import { planSummon, summonDeletionOps, summonMarker, summonPlacementError, validateSummon,
  type SummonSource } from "../core/summons";
import { getByTag, isWorldTagRef, listTaggable, tagEditOps, tagRuleOps, tagsOf, TAGGABLE_COLLECTIONS, validSceneTagRefs,
  validWorldTagRefs,
  type TagEdit, type TagMatchMode, type TagPattern } from "../core/tags";
import { boundedJson, scriptApprovalHash, scriptApprovalHashSync, validateScriptArgs, validateScriptMacro,
  type ScriptGrant, type ScriptPolicy } from "../core/scriptMacros";
import { runScriptWorker, type ScriptRunner } from "./scriptWorker";
import {
  docVisibleTo,
  projectEnvelope,
  projectWorld,
  visibilityFields,
} from "../core/projection";
import {
  cellVisibilityChanges,
  openCellKeys,
  projectCellForViewer,
} from "../core/hexcrawl/visibility";
import { applyDiff } from "../core/diff";
import {
  TokenBucket,
  createAssetRateLimiter,
  createEphemeralRateLimiter,
  createIntentRateLimiter,
} from "../core/ratelimit";
import type { AssetGetMsg, FogGetMsg, FogPutMsg, FxDeliverySkips, FxMediaAckMsg, FxMediaAckState } from "../core/messages";
import { fxMediaReport } from "../core/fxDelivery";
import { soundSegments } from "../canvas/vision/wallSight";
import { segmentsCross } from "../canvas/vision/polygon";
import { MAX_FOG_PNG_BYTES } from "../core/fogExploration";
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
  manifest?: () => AssetManifest;
  /**
   * §7: when present, asset.get requests are served from this server via an
   * AssetTransfer (priority queue + per-peer bandwidth cap).
   */
  assets?: AssetServer;
  /** Transfer overrides (tests): chunk size, bandwidth cap, clock. */
  assetTransfer?: {
    chunkSize?: number;
    bytesPerSecond?: number;
    now?: () => number;
  };
  /**
   * D-250: where explored-fog maps live between sessions (hostBoot wires the IDB `fog`
   * store). Absent → fog.put is kept in memory only and fog.get answers from that.
   */
  fogStore?: FogStore;
  /** Browser Worker by default; injected for deterministic host authorization tests. */
  scriptRunner?: ScriptRunner;
  rng?: RngFn;
  now?: () => number;
  /** Host-only pack lookup; absent means compendium summoning is unavailable. */
  resolveSummonSource?: (source: Extract<SummonSource, { kind: "compendium" }>) => Promise<ActorDocument | undefined>;
}

/** Persistence for §9 explored fog, keyed per user + scene (the world is implied). */
export interface FogStore {
  put(userId: UserId, sceneId: DocId, png: Uint8Array): Promise<void>;
  get(userId: UserId, sceneId: DocId): Promise<Uint8Array | null>;
}

interface PreparedFx {
  cue: FxStartMsg;
  recipients: Session[];
  /** Preflight drop counts (SQ-13), reported to a GM requester via `fx.delivery`. */
  skipped: FxDeliverySkips;
  /** D-303: how many recipients got a reduced payload (D-300 targeting), and how many
   * were left with nothing at all — counted separately from `skipped`, because these
   * viewers were entitled to the run. */
  targeting: { targeted: number; empty: number };
  callerId: string;
  /** The run's effective audience: the narrowing if one was asked for, else the macro's. */
  audience: FxAudience;
  checkedAtSeq: number;
  sourceTokenId?: string;
  targetTokenId?: string;
}

/**
 * D-308 (SQ-13): what the host expects and hears back about one cue's media.
 *
 * The preflight report says who was *entitled*; this is the answer to "did they
 * actually get it". Kept per run, bounded (oldest evicted), and named by the
 * requester's own section index in the report — no asset or session identifier leaves
 * the host, so a viewer's answer cannot become a membership oracle either.
 */
interface FxMediaReceipt {
  runId: string;
  requestId: string;
  macroId: DocId;
  sceneId: DocId;
  /** The session that asked to run this and will read the report (GM/assistant only). */
  requesterPeerId: PeerId;
  /** Distinct assets the run uses, with the index of the first section that needs one. */
  assets: Array<{ assetId: string; index: number; kind: "image" | "sound"; mime: string }>;
  /** Sessions the cue actually went to (a viewer that never got it has nothing to say). */
  recipients: Set<PeerId>;
  /** peerId → (assetId → the state it most recently reported). */
  acks: Map<PeerId, Map<string, FxMediaAckState>>;
  /** peerId → (assetId → the fetch time it reported), folded into `slowestReadyMs`. */
  fetchMs: Map<PeerId, Map<string, number>>;
  /** Host clock ms: when the wait for answers ends (extended for one correction). */
  deadline: number;
  reported: boolean;
  corrected: boolean;
  /** Every (viewer, asset) state as of the first line — including silence, so a viewer
   * that reports *late* corrects the "have not reported yet" the GM was told. */
  warnKey: string;
}

interface Session {
  peerId: PeerId;
  transport: Transport;
  user: SessionUser | null;
  pendingHello: HelloMsg | null;
  intentBucket: TokenBucket;
  ephemeralBucket: TokenBucket;
  assetBucket: TokenBucket;
  /** Last projected metadata sent to this peer (not asset bytes). */
  manifestFingerprint: string | null;
}

/**
 * D-316: a delivered cue carries no audience. The host has already decided who gets
 * what; repeating the audience in the payload would let a recipient read a
 * chosen-players list — including users they cannot otherwise see — straight out of
 * their own socket traffic, and SQ-18 keeps membership out of payloads. Returns the
 * input array unchanged when there is nothing to remove, so an untargeted cue is still
 * the very same object for every recipient.
 */
function hostWithoutAudience(
  sections: readonly ResolvedFxSection[],
): readonly ResolvedFxSection[] {
  // Only a camera section carries one, so the kind check is the type's own rule, not a guess.
  const strip = (section: ResolvedFxSection): ResolvedFxSection => {
    if (section.kind !== "camera") return section;
    const { audience: _audience, ...rest } = section;
    void _audience;
    return rest as ResolvedFxSection;
  };
  return sections.some((section) => section.kind === "camera" && section.audience !== undefined)
    ? sections.map(strip) : sections;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function cryptoRng(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] as number) / 2 ** 32;
}

/** Dry-run graphs must not advance the host's mechanical RNG or change later rolls. */
function automationPreviewRng(seed: string): () => number {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  if (!value) value = 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 2 ** 32;
  };
}

/** N01: column-map equality (name → wire kind), order-independent. */
function sameSchema(
  a: { readonly [name: string]: unknown },
  b: { readonly [name: string]: unknown },
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
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

/**
 * A document whose read boundary this envelope moves: the update touches a
 * visibility-bearing field (ownership, or a pin's `visible` flag), so some sessions gain or
 * lose sight of it. `before` is the document with the inverse diff applied — the state the
 * projection would have judged one envelope ago.
 */
function visibilityKey(ref: DocRef): string {
  return `${ref.parent ? `${visibilityKey(ref.parent)}/` : ""}${ref.coll}/${encodeURIComponent(ref.id)}`;
}

interface VisibilityCrossing {
  key: string;
  ref: DocRef;
  doc: BaseDocument;
  before: BaseDocument;
}

function visibilityCrossings(
  envelope: OpEnvelope,
  inverses: readonly Op[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
): VisibilityCrossing[] {
  type Diff = Extract<Op, { kind: "update" }>["diff"];
  const grouped = new Map<string, { ref: DocRef; doc: BaseDocument; inverses: Diff[]; touches: boolean }>();
  for (let i = 0; i < envelope.ops.length; i += 1) {
    const op = envelope.ops[i], inverse = inverses[i];
    if (op?.kind !== "update" || inverse?.kind !== "update" ||
        op.ref.coll === "actionReceipts") continue;
    const doc = resolve(op.ref);
    if (!doc) continue;
    const key = visibilityKey(op.ref);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { ref: op.ref, doc, inverses: [], touches: false };
      grouped.set(key, entry);
    }
    entry.inverses.push(inverse.diff);
    const fields = visibilityFields(doc);
    const touches = (diff: Diff, field: string) => field in diff || `-=${field}` in diff;
    if (fields.some((field) => touches(op.diff, field) && touches(inverse.diff, field)))
      entry.touches = true;
  }
  const out: VisibilityCrossing[] = [];
  for (const [key, entry] of grouped) {
    if (!entry.touches) continue;
    // Several actions in one graph can edit the SAME document. Invert them
    // all in reverse order to compare the final state to the PRE-ENVELOPE
    // state, never to an intermediate state between tag/visibility steps.
    let before = entry.doc;
    let valid = true;
    for (const diff of [...entry.inverses].reverse()) {
      const prior = applyDiff(before, diff);
      if (!prior.ok) { valid = false; break; }
      before = prior.value;
    }
    if (valid) out.push({ key, ref: entry.ref, doc: entry.doc, before });
  }
  return out;
}

/**
 * Per-op projection merged with boundary rewrites: a grant to a session that
 * never saw the create becomes a full-doc create; a revoke becomes a delete
 * (the plain projection would DROP the update for the newly-blind session,
 * leaving a stale doc in the replica). Same seq, no protocol additions.
 *
 * Embedded documents (D-256 map pins under a scene) cross boundaries the same way, so the
 * rewrite carries `parent` and the pre-image is compared with the shared visibility rule —
 * `docVisibleTo` — rather than ownership arithmetic, which would disagree with the
 * projection on a pin whose scene grants read access to every player.
 */
function projectWithCrossings(
  envelope: OpEnvelope,
  user: PermissionUser,
  crossings: VisibilityCrossing[],
  resolver: { resolve: (ref: DocRef) => BaseDocument | undefined },
): OpEnvelope | null {
  let modified = false;
  const ops: Op[] = [];
  const byKey = new Map(crossings.map((crossing) => [crossing.key, crossing]));
  const last = new Map<string, number>();
  envelope.ops.forEach((raw, i) => {
    if (raw.kind === "update") {
      const key = visibilityKey(raw.ref);
      if (byKey.has(key)) last.set(key, i);
    }
  });
  for (const [i, rawOp] of envelope.ops.entries()) {
    const op = rawOp as Extract<Op, { kind: "update" }>;
    const crossing = rawOp.kind === "update" ? byKey.get(visibilityKey(rawOp.ref)) : undefined;
    if (crossing) {
      const parent = crossing.ref.parent
        ? resolver.resolve(crossing.ref.parent)
        : undefined;
      const nowVisible = docVisibleTo(user, crossing.doc, parent);
      const wasVisible = docVisibleTo(user, crossing.before, parent);
      if (nowVisible !== wasVisible && i !== last.get(crossing.key)) {
        modified = true; // final create/delete already contains/suppresses every earlier edit
        continue;
      }
      if (nowVisible && !wasVisible) {
        // A visibility grant is a *new create* for this viewer, but a raw host
        // document may contain script code, journal secrets or hidden scene
        // embeds. Run it through the same projection as any ordinary create.
        const synthetic: Op = { kind: "create", coll: crossing.ref.coll,
          ...(crossing.ref.parent !== undefined ? { parent: crossing.ref.parent } : {}),
          data: structuredClone(crossing.doc) };
        const projected = projectEnvelope({ ...envelope, ops: [synthetic] }, user, resolver);
        if (projected) ops.push(...projected.ops);
        modified = true;
        continue;
      }
      if (!nowVisible && wasVisible) {
        ops.push({ kind: "delete", ref: op.ref });
        modified = true;
        continue;
      }
    }
    const single = projectEnvelope(
      { ...envelope, ops: [rawOp] },
      user,
      resolver,
    );
    if (single) {
      if (single.ops.length !== 1 || single.ops[0] !== rawOp) modified = true;
      ops.push(...single.ops);
    } else {
      modified = true; // op projected away for this session
    }
  }
  if (ops.length === 0) return null;
  return modified || ops.length !== envelope.ops.length
    ? { ...envelope, ops }
    : envelope;
}

/**
 * D-271 — the hexcrawl boundary crossing.
 *
 * Cells are not visible documents, they are visible *cells*: a closed cell is not projected to a
 * player at all (D-256's rule for a hidden pin, for the same reason — the asset manifest lists
 * every hash), so a reveal is a **create** for a session that never had the cell and a close is
 * a **delete**. The pivot is the scene's own `flags` write, because that is where the revealed
 * set lives (`core/hexcrawl/scene.ts` writes the whole `flags` object); the comparison itself is
 * pure core (`cellVisibilityChanges`), which is why this stays a twenty-line hook rather than a
 * second visibility engine.
 */
interface CellRevealCrossing {
  sceneRef: DocRef;
  /**
   * Which op in the envelope moved the boundary. Two flag writes on one scene in one envelope
   * (a fog stroke beside a reveal, say) each get their own crossing, and inserting both after
   * every scene update would send the same cell create twice — a duplicated create inside one
   * envelope, which the receiving store refuses, taking the whole envelope with it.
   */
  index: number;
  opened: string[];
  closed: string[];
  /** The scene after the write — the projection rule reads its reveal set. */
  scene: SceneDocument;
}

function cellRevealCrossings(
  envelope: OpEnvelope,
  inverses: readonly Op[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
): CellRevealCrossing[] {
  const out: CellRevealCrossing[] = [];
  for (let i = 0; i < envelope.ops.length; i += 1) {
    const op: Op | undefined = envelope.ops[i];
    const inverse: Op | undefined = inverses[i];
    if (!op || !inverse) continue;
    if (op.kind !== "update" || inverse.kind !== "update") continue;
    if (op.ref.coll !== "scenes") continue;
    const touchesFlags = Object.keys(op.diff).some(
      (key) =>
        key === "flags" ||
        key.startsWith("flags.") ||
        key.startsWith("-=flags."),
    );
    if (!touchesFlags) continue;
    const after = resolve(op.ref);
    if (!after || after.type !== "scene") continue;
    const before = { ...after, ...inverse.diff } as BaseDocument;
    if (before.type !== "scene") continue;
    const { opened, closed } = cellVisibilityChanges(
      before as SceneDocument,
      after as SceneDocument,
    );
    if (opened.length === 0 && closed.length === 0) continue;
    out.push({
      sceneRef: op.ref,
      index: i,
      opened,
      closed,
      scene: after as SceneDocument,
    });
  }
  return out;
}

/** The synthetic ops one crossing owes one viewer (empty for a GM, who holds every cell anyway). */
function cellRevealOps(
  crossing: CellRevealCrossing,
  user: PermissionUser,
): Op[] {
  if (user.role === "GM" || user.role === "ASSISTANT") return [];
  const ops: Op[] = [];
  const open = openCellKeys(crossing.scene);
  for (const cell of crossing.scene.cells ?? []) {
    if (!crossing.opened.includes(cell.key)) continue;
    const projected = projectCellForViewer(cell, open);
    if (!projected) continue;
    ops.push({
      kind: "create",
      coll: "cells",
      parent: crossing.sceneRef,
      data: projected as unknown as BaseDocument,
    });
  }
  for (const key of crossing.closed) {
    const cell = (crossing.scene.cells ?? []).find((c) => c.key === key);
    if (!cell) continue;
    ops.push({
      kind: "delete",
      ref: { coll: "cells", id: cell._id, parent: crossing.sceneRef },
    });
  }
  return ops;
}

/**
 * Insert each crossing's cell ops right after **the op that moved the boundary** — not after every
 * scene update in the envelope, which would duplicate a reveal whenever one envelope carries two
 * flag writes on the same scene.
 */
function withCellReveals(
  envelope: OpEnvelope,
  user: PermissionUser,
  crossings: readonly CellRevealCrossing[],
): OpEnvelope {
  const ops: Op[] = [];
  for (let i = 0; i < envelope.ops.length; i += 1) {
    const op = envelope.ops[i];
    if (op) ops.push(op);
    for (const crossing of crossings) {
      if (crossing.index !== i) continue;
      ops.push(...cellRevealOps(crossing, user));
    }
  }
  return { ...envelope, ops };
}

/** One top-level invocation shares a deadline and action budget with all nested scripts. */
interface ScriptInvocation {
  session: Session;
  caller: SessionUser;
  requestId: string;
  deadline: number;
  budget: { calls: number };
  trace: string[];
  /** One durable Revert control for this script and its nested direct RPCs. */
  audit: ActionAudit;
}

export class HostSync {
  private readonly store: DocumentStore;
  private readonly log: OpLog;
  private readonly undoStack: UndoStack;
  readonly bus: EventBus<HostEvents>;
  private readonly systemUserId: UserId;
  private readonly roomId: string;
  private readonly verifySig: (
    hello: HelloMsg,
    roomId: string,
  ) => Promise<boolean>;
  private readonly manifestSource: NonNullable<HostSyncOptions["manifest"]>;
  private readonly transfer: AssetTransfer | null;
  private readonly rng: RngFn;
  private readonly now: () => number;
  private readonly scriptRunner: ScriptRunner;
  private readonly resolveSummonSource: HostSyncOptions["resolveSummonSource"];
  private readonly summonRequests = new Map<string, number>();
  private summonTimer: ReturnType<typeof setTimeout> | null = null;
  /** D-308: the media-acknowledgment window (one timer for the earliest deadline). */
  private fxMediaTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fxMediaReceipts = new Map<string, FxMediaReceipt>();
  private disposed = false;
  /** §8/§9 fog readbacks: `${sceneId}:${userId}` → latest PNG bytes (write-through cache). */
  readonly fogPngs = new Map<string, Uint8Array>();
  private readonly fogStore: FogStore | null;

  private sessions = new Map<PeerId, Session>();
  private banned = new Set<UserId>();
  private sim: SimChannelHooks | null = null;
  /** §5A/N01: the active strategic battle announced in every welcome. */
  private simInfo: WelcomeSimInfo | null = null;

  /** Wire the §5A turn/sim channel (HostSync remains the only talker, §2). */
  attachSim(hooks: SimChannelHooks): void {
    this.sim = hooks;
  }

  /**
   * §5A/N01: set the active strategic battle (scene + package schema) that
   * every welcome announces, so joiners adopt it before their first sim frame
   * instead of guessing columns/scene. A *changed* announcement is re-sent to
   * already-authenticated sessions (package switch); clients answer by dropping
   * their replica and pulling a fresh snapshot. Setting the same info again is
   * a no-op. Call before addSession() so the very first welcome carries it.
   */
  setSimInfo(info: WelcomeSimInfo | null): void {
    const same =
      (info === null && this.simInfo === null) ||
      (info !== null &&
        this.simInfo !== null &&
        this.simInfo.sceneId === info.sceneId &&
        this.simInfo.packageId === info.packageId &&
        this.simInfo.version === info.version &&
        sameSchema(this.simInfo.schema, info.schema));
    if (same) return;
    this.simInfo = info;
    if (info === null) return;
    // Re-announce to live sessions (initial joins get it via welcomeSession).
    for (const session of this.sessions.values()) {
      if (!session.user) continue;
      this.send(session, {
        kind: "welcome",
        user: {
          id: session.user.id,
          role: session.user.role,
          name: session.user.name,
        },
        world: this.welcomeWorld(),
        snapshotSeq: this.store.seq,
        sim: info,
      });
    }
  }

  /** The world block every welcome carries (§6.4). */
  private welcomeWorld(): WelcomeMsg["world"] {
    return {
      id: this.store.meta.worldId,
      name: this.store.meta.name,
      system: this.store.meta.system,
      version: this.store.meta.systemVersion,
    };
  }

  /**
   * System commit path for host machinery (turn docs, unit stat envelopes).
   * Same single-commit invariants as user intents; undo recording optional.
   */
  commitSystem(
    ops: Op[],
    recordUndo = false,
  ): { ok: true; seq: number } | { ok: false; error: string } {
    return this.commitOps(
      ops,
      this.systemUserId,
      `sys-${randomId()}`,
      recordUndo,
    );
  }

  /** Send a sim/turn wire message to authenticated sessions (GM always). */
  broadcastSim(
    msg: WireMessage,
    include?: (user: SessionUser) => boolean,
  ): void {
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
    this.manifestSource =
      options.manifest ?? (() => this.store.world.assetManifest);
    this.transfer = options.assets
      ? new AssetTransfer(
          async (hash, offset, length, peerId) => {
            const user = peerId ? this.sessions.get(peerId)?.user : null;
            // Re-check on EACH chunk, not only when queued: permissions and
            // documents can change during a long premium-media transfer.
            if (!user || !canFetchAsset(this.store.world, this.manifestSource(), user, hash)) {
              return undefined; // indistinguishable from an unknown hash
            }
            return options.assets?.read(hash, offset, length);
          },
          {
            send: (peerId, chunk) => {
              const session = this.sessions.get(peerId);
              if (session?.user) this.send(session, chunk);
            },
          },
          options.assetTransfer ?? {},
        )
      : null;
    this.fogStore = options.fogStore ?? null;
    this.rng = options.rng ?? cryptoRng;
    this.now = options.now ?? (() => Date.now());
    this.scriptRunner = options.scriptRunner ?? runScriptWorker;
    this.resolveSummonSource = options.resolveSummonSource;
    this.scheduleSummonExpiry();
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  /** Attach a peer transport.GM loopback sessions may pass their user directly. */
  addSession(peerId: PeerId, transport: Transport, user?: SessionUser): void {
    this.sweepExpiredSummons(); // expiry also runs on reconnect after a sleeping tab resumes
    const session: Session = {
      peerId,
      transport,
      user: user ?? null,
      pendingHello: null,
      intentBucket: createIntentRateLimiter(this.now),
      ephemeralBucket: createEphemeralRateLimiter(this.now),
      assetBucket: createAssetRateLimiter(this.now),
      manifestFingerprint: null,
    };
    this.sessions.set(peerId, session);
    transport.onMessage = (_channel, bytes) => this.onFrame(session, bytes);
    if (user) this.welcomeSession(session, user, undefined);
  }

  removeSession(peerId: PeerId, reason = "closed"): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    for (const viewers of this.fxViewers.values()) viewers.peers.delete(peerId);
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
      case "roll.pending":
        void this.handleRollPending(
          session,
          msg as unknown as import("../core/messages").RollPendingMsg,
        );
        return;
      case "roll.reroll":
        void this.handleRollReroll(
          session,
          msg as unknown as import("../core/messages").RollRerollMsg,
        );
        return;
      case "roll.apply":
        this.handleRollApply(
          session,
          msg as unknown as import("../core/messages").RollApplyMsg,
        );
        return;
      case "roll.revert":
        void this.handleRollRevert(
          session,
          msg as unknown as import("../core/messages").RollRevertMsg,
        );
        return;
      case "action.revert":
        this.handleActionRevert(session, msg);
        return;
      case "roll.delegate":
        void this.handleRollDelegate(
          session,
          msg as unknown as import("../core/messages").RollDelegateMsg,
        );
        return;
      case "ephemeral":
        this.handleEphemeral(session, msg);
        return;
      case "fx.request":
        this.handleFxRequest(session, msg);
        break;
      case "fx.media":
        this.handleFxMedia(session, msg);
        return;
      case "fx.sync":
        this.handleFxSync(session, msg.sceneId);
        return;
      case "fx.stop":
        this.handleFxStop(session, msg);
        return;
      case "fx.stopMatching":
        this.handleFxStopMatching(session, msg);
        return;
      case "automation.request":
        this.handleAutomationRequest(session, msg);
        return;
      case "automation.click":
        this.handleAutomationClick(session, msg);
        return;
      case "tagger.rules":
        this.handleTaggerRules(session, msg);
        return;
      case "prefab.place":
        this.handlePrefabPlace(session, msg);
        return;
      case "summon.place":
        void this.handleSummonPlace(session, msg);
        return;
      case "summon.dismiss":
        this.handleSummonDismiss(session, msg);
        return;
      case "macro.request":
        void this.handleMacroRequest(session, msg);
        return;
      // Host→client kinds and later-milestone kinds are never accepted here:
      case "welcome":
      case "snapshot":
      case "ops":
      case "rejected":
      case "asset.chunk":
      case "fx.start":
      case "fx.end":
      case "asset.manifest":
      case "automation.trace":
      case "tagger.rules.result":
      case "prefab.result":
      case "summon.result":
      case "macro.result":
        return; // host-only cues/metadata are never accepted from a client
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
        this.handleFogPut(session, msg);
        return;
      case "fog.get":
        void this.handleFogGet(session, msg);
        return;
      case "fog.state":
        return; // host → client only
      case "turn.ready":
        if (session.user && this.sim)
          this.sim.handleTurnReady(session.user, msg);
        return;
      case "sim.control":
        if (session.user && this.sim)
          this.sim.handleSimControl(session.user, msg);
        return;
      case "report.detail":
        if (session.user && this.sim)
          this.sim.handleReportDetail(session.user, msg);
        return;
      case "sim.snapshot.get":
        if (session.user && this.sim)
          this.sim.handleSimSnapshotGet(session.user, msg);
        return;
    }
  }

  // ─── §9 explored fog (D-250) ────────────────────────────────────────────────

  /**
   * Keep the sender's explored map for a scene: the latest PNG per user + scene in memory
   * (write-through) and in the fog store, so it survives the session, rides the world file
   * and answers the user's next `fog.get`. A user can only ever write their own map, and an
   * oversized or empty payload is dropped (§16).
   */
  private handleFogPut(session: Session, msg: FogPutMsg): void {
    const user = session.user;
    if (!user) return;
    if (!(msg.png instanceof Uint8Array) || msg.png.length === 0) return;
    if (msg.png.length > MAX_FOG_PNG_BYTES) return;
    if (typeof msg.sceneId !== "string" || msg.sceneId.length === 0) return;
    this.fogPngs.set(`${msg.sceneId}:${user.id}`, msg.png);
    if (this.fogStore) {
      this.fogStore.put(user.id, msg.sceneId, msg.png).catch(() => undefined);
    }
  }

  /** Answer with the asker's own stored map for the scene (null when nothing is stored). */
  private async handleFogGet(session: Session, msg: FogGetMsg): Promise<void> {
    const user = session.user;
    if (!user) return;
    if (typeof msg.sceneId !== "string" || msg.sceneId.length === 0) return;
    let png: Uint8Array | null =
      this.fogPngs.get(`${msg.sceneId}:${user.id}`) ?? null;
    if (png === null && this.fogStore) {
      try {
        png = await this.fogStore.get(user.id, msg.sceneId);
      } catch {
        png = null;
      }
      if (png) this.fogPngs.set(`${msg.sceneId}:${user.id}`, png);
    }
    // the session may have gone while the store answered
    if (this.sessions.get(session.peerId) !== session) return;
    this.send(session, { kind: "fog.state", sceneId: msg.sceneId, png });
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
    let user = this.store.get("users", hello.pubkey) as
      UserDocument | undefined;
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
    this.bus.emit("join:approved", {
      peerId: session.peerId,
      userId: user._id,
      known,
    });
    this.welcomeSession(session, session.user, hello);
  }

  /** welcome + (snapshot | ops-since-seq) for an authenticated session. */
  private welcomeSession(
    session: Session,
    user: SessionUser,
    hello: HelloMsg | undefined,
  ): void {
    this.send(session, {
      kind: "welcome",
      user: { id: user.id, role: user.role, name: user.name },
      world: this.welcomeWorld(),
      snapshotSeq: this.catchUpSeq(session, hello),
      ...(this.simInfo !== null ? { sim: this.simInfo } : {}),
    });
  }

  /**
   * Reconnecting GM/assistant can consume raw ops-since. Other users must
   * receive a freshly projected snapshot: replaying the historical log against
   * today's resolver leaks once-hidden documents/visibility transitions (and
   * an unprojected envelope was sent here before the FX privacy work).
   * History-aware delta projection can restore the optimization later.
   */
  private catchUpSeq(session: Session, hello: HelloMsg | undefined): number {
    const lastSeq = hello?.lastSeq;
    if (
      (session.user?.role === "GM" || session.user?.role === "ASSISTANT") &&
      typeof lastSeq === "number" &&
      Number.isInteger(lastSeq) &&
      lastSeq >= 0 &&
      lastSeq <= this.store.seq &&
      lastSeq >= this.log.baseSeq
    ) {
      for (const env of this.log.since(lastSeq)) {
        this.send(session, { kind: "ops", envelope: env });
      }
      // Metadata is not an Op. Even a GM receiving delta catch-up needs today's manifest.
      this.sendProjectedManifest(session);
      return lastSeq;
    }
    // Full projected snapshot (§5: manifest only — assets stream lazily, §7).
    const manifest = projectAssetManifest(this.store.world, this.manifestSource(), session.user as SessionUser);
    this.send(session, {
      kind: "snapshot",
      seq: this.store.seq,
      world: projectWorld(this.store.world, this.store.seq, session.user as SessionUser),
      manifest,
    });
    session.manifestFingerprint = JSON.stringify(manifest);
    return this.store.seq;
  }

  // ─── Intents (§5) ───────────────────────────────────────────────────────────

  private reject(
    session: Session,
    txId: TxId,
    reason: string,
    detail: string,
  ): void {
    this.send(session, {
      kind: "rejected",
      txId,
      reason: reason as never,
      detail,
    });
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
    // FX instances are host-owned runtime state, not GM-authored document ops.
    if (Array.isArray(ops) && ops.some((op) => op && typeof op === "object" &&
        (op.kind === "create" ? op.coll === "fxInstances" || op.parent?.coll === "fxInstances"
          : op.ref?.coll === "fxInstances" || op.ref?.parent?.coll === "fxInstances"))) {
      this.reject(session, txId, "forbidden", "FX instances are host-owned");
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
          data.ownership = {
            ...data.ownership,
            default: OWNERSHIP_LEVELS.LIMITED,
          };
        }
        out.push({ ...op, data });
        continue;
      }
      out.push(op);
    }
    return { ok: true, ops: out };
  }

  /** A saved graph never trusts a client-supplied step, anchor or media identifier. */
  private automationDocumentError(doc: AutomationDocument): string | null {
    if (doc.type !== "automation") return "automation document type required";
    const checked = validateAutomation(doc.definition);
    if (!checked.ok) return checked.error;
    if (!validateAutomationState(doc.state)) return "invalid trigger history";
    const scene = this.store.get("scenes", checked.definition.sceneId) as SceneDocument | undefined;
    if (!scene || !scene.tiles.some((tile) => tile._id === checked.definition.tileId))
      return "automation anchor tile/scene does not exist";
    for (const step of checked.definition.steps) {
      if (step.kind !== "sequence" && step.kind !== "script") continue;
      const macro = this.store.get("macros", step.macroId) as MacroDocument | undefined;
      if (step.kind === "sequence") {
        if (!macro || macro.kind !== "sequence" || !validateFxSequence(macro.sequence).ok)
          return `missing/invalid saved sequence macro: ${step.macroId}`;
      } else {
        const approval = macro?.kind === "script" ? validateScriptMacro(macro) : null;
        if (!approval?.ok || approval.policy.sceneId !== scene._id)
          return `missing/invalid scene-local reviewed script: ${step.macroId}`;
      }
    }
    return null;
  }

  /**
   * D-311: a bound item cue is validated where it is authored. The lookup answers "does this
   * item exist, is it a *timeline* being named, and can the author read both" — the host's own
   * `can`, never a client's claim. Nothing about the caller's later rights is decided here:
   * the run itself is an ordinary `fx.request` and goes through `prepareFx` as always.
   */
  private fxBindingError(macro: MacroDocument, user: SessionUser): string | null {
    return fxItemBindingError(macro, {
      actor: (id) => this.store.get("actors", id) as ActorDocument | undefined,
      macro: (id) => this.store.get("macros", id) as MacroDocument | undefined,
      readable: (coll, doc) => can(user, "read", doc as BaseDocument, coll),
      // D-312: the conflict is per *moment*, so the lookup answers with each bound timeline's
      // events — D-311's rule, narrowed from "this item" to "this item's use"/"…'s attack".
      boundTimelines: (actorId, itemId) => (this.store.getAll("macros") as readonly MacroDocument[])
        .filter((candidate) => candidate.kind === "sequence" &&
          candidate.fxItem?.actorId === actorId && candidate.fxItem?.itemId === itemId)
        .map((candidate) => ({ id: candidate._id,
          events: candidate.fxItem ? fxBindingEvents(candidate.fxItem) : [] })),
    });
  }

  private scriptDocumentError(doc: MacroDocument): string | null {
    const checked = validateScriptMacro(doc);
    if (!checked.ok) return checked.error;
    if (!this.store.get("scenes", checked.policy.sceneId)) return "script context scene does not exist";
    return null;
  }

  /** §5 validation: permissions per op (+ cascade parents), schema-lite diffs. */
  private validateOps(
    user: SessionUser,
    ops: Op[],
  ):
    | { ok: true }
    | { ok: false; reason: "forbidden" | "invalid_schema"; error: string } {
    for (const op of ops) {
      if ((op.kind === "create" ? op.coll : op.ref.coll) === "actionReceipts")
        return { ok: false, reason: "forbidden", error: "Revert history is host-owned" };
      switch (op.kind) {
        case "create": {
          const parent =
            op.parent !== undefined ? this.store.resolve(op.parent) : undefined;
          const canOpts = parent ? { parent } : {};
          if (op.parent !== undefined && !parent) {
            return {
              ok: false,
              reason: "invalid_schema",
              error: `create: parent not found`,
            };
          }
          const collName = (op.parent ? op.coll : op.coll) as CollectionName;
          if (!can(user, "create", op.data, collName, canOpts)) {
            return {
              ok: false,
              reason: "forbidden",
              error: `create ${op.coll}`,
            };
          }
          if (op.coll === "users") {
            return {
              ok: false,
              reason: "forbidden",
              error: "users are assigned by the host only",
            };
          }
          if (op.coll === "tiles" && user.role !== "GM" && user.role !== "ASSISTANT" &&
              (op.data as TileDocument).sort !== undefined)
            return { ok: false, reason: "forbidden", error: "only GMs set tile trigger priority" };
          // Attachment metadata is host-owned on placement. A player must not
          // forge a parent/instance relationship that moves hidden GM objects.
          if (user.role !== "GM" && user.role !== "ASSISTANT" &&
              (op.data.flags?.summon !== undefined || op.data.flags?.summonStatus !== undefined))
            return { ok: false, reason: "forbidden", error: "summon markers are host-owned" };
          if (PREFAB_COLLECTIONS.includes(op.coll as (typeof PREFAB_COLLECTIONS)[number]) &&
              op.data.flags?.prefab !== undefined && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs attach prefab parts" };
          if (op.coll === "automations") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs author active zones" };
            const error = this.automationDocumentError(op.data as AutomationDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.coll === "prefabs") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs author prefabs" };
            const doc = op.data as PrefabDocument;
            const checked = validatePrefab(doc.definition);
            if (doc.type !== "prefab" || !checked.ok)
              return { ok: false, reason: "invalid_schema", error: checked.ok ? "prefab type required" : checked.error };
          }
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "sequence") {
            if (user.role !== "GM" && user.role !== "ASSISTANT") {
              return { ok: false, reason: "forbidden", error: "only GMs author FX macros" };
            }
            const stray = macroStrayPresetError(op.data as MacroDocument);
            if (stray) return { ok: false, reason: "invalid_schema", error: stray };
            const check = validateFxSequence((op.data as MacroDocument).sequence);
            if (!check.ok) return { ok: false, reason: "invalid_schema", error: check.error };
            const bound = this.fxBindingError(op.data as MacroDocument, user);
            if (bound) return { ok: false, reason: "invalid_schema", error: bound };
          }
          // D-310: a preset is an authoring aid for GMs/assistants — validated like the
          // timeline fragment it is, and never runnable, so no FX/script path can reach it.
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "fxPreset") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs save FX presets" };
            const error = fxPresetDocumentError(op.data as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "summon") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish summons" };
            const check = validateSummon((op.data as MacroDocument).summon);
            if (!check.ok) return { ok: false, reason: "invalid_schema", error: check.error };
          }
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "script") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish scripts" };
            if ((op.data as MacroDocument).scriptState !== undefined)
              return { ok: false, reason: "forbidden", error: "execution history is host-owned" };
            const error = this.scriptDocumentError(op.data as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          continue;
        }
        case "update": {
          const doc = this.store.resolve(op.ref);
          if (!doc)
            return {
              ok: false,
              reason: "invalid_schema",
              error: `update: target not found`,
            };
          const parent =
            op.ref.parent !== undefined
              ? this.store.resolve(op.ref.parent)
              : undefined;
          const canOpts = parent ? { parent } : {};
          if (
            !can(user, "update", doc, this.embeddedCollName(op.ref), canOpts)
          ) {
            return {
              ok: false,
              reason: "forbidden",
              error: `update ${op.ref.coll}/${op.ref.id}`,
            };
          }
          if (user.role !== "GM" && user.role !== "ASSISTANT" &&
              (op.ref.coll === "actors" || op.ref.coll === "tokens") &&
              Object.keys(op.diff).some((field) =>
                // The private link cannot be forged or edited, including by
                // replacing all flags or setting a dot path on an ordinary token.
                field.startsWith("flags.summon") || field.startsWith("-=flags.summon") ||
                (field === "flags" && isRecord(op.diff.flags) &&
                  (Object.hasOwn(op.diff.flags, "summon") || Object.hasOwn(op.diff.flags, "summonStatus"))) ||
                (doc.flags?.summon !== undefined &&
                  (field === "flags" || field === "ownership" || field.startsWith("ownership.") ||
                    field === "actorId"))))
            return { ok: false, reason: "forbidden", error: "summon links and ownership are host-owned" };
          if (PREFAB_COLLECTIONS.includes(op.ref.coll as (typeof PREFAB_COLLECTIONS)[number]) &&
              user.role !== "GM" && user.role !== "ASSISTANT" &&
              ((doc.flags?.prefab as { locked?: boolean } | undefined)?.locked === true ||
                Object.keys(op.diff).some((field) => field === "flags" || field.startsWith("flags.prefab") ||
                  field.startsWith("-=flags.prefab"))))
            return { ok: false, reason: "forbidden", error: "only GMs change prefab attachment metadata or locked parts" };
          if (user.role !== "GM" && user.role !== "ASSISTANT" && Object.keys(op.diff).some((field) =>
            op.ref.coll === "tiles" && (field === "sort" || field.startsWith("sort.") || field === "-=sort") ||
            op.ref.coll === "scenes" && (field === "tiles" || field.startsWith("tiles.") || field === "-=tiles")))
            return { ok: false, reason: "forbidden", error: "only GMs change tile trigger priority/scene tile lists" };
          if (op.ref.coll === "automations" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs edit active zones" };
          if (op.ref.coll === "prefabs" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs edit prefabs" };
          if (op.ref.coll === "macros" && ["sequence", "script", "summon", "fxPreset"].includes((doc as MacroDocument).kind) &&
              user.role !== "GM" && user.role !== "ASSISTANT") {
            return { ok: false, reason: "forbidden", error: "only GMs edit FX/script/summon macros" };
          }
          if (op.ref.coll === "macros" && Object.keys(op.diff).some((key) => key === "scriptState" || key.startsWith("scriptState.")))
            return { ok: false, reason: "forbidden", error: "execution history is host-owned" };
          const dry = applyDiff(doc, op.diff);
          if (!dry.ok)
            return { ok: false, reason: "invalid_schema", error: dry.error };
          if (op.ref.coll === "automations") {
            const error = this.automationDocumentError(dry.value as AutomationDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.ref.coll === "prefabs") {
            const candidate = dry.value as PrefabDocument;
            const checked = validatePrefab(candidate.definition);
            if (candidate.type !== "prefab" || !checked.ok)
              return { ok: false, reason: "invalid_schema", error: checked.ok ? "prefab type required" : checked.error };
          }
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "sequence") {
            if (user.role !== "GM" && user.role !== "ASSISTANT") {
              return { ok: false, reason: "forbidden", error: "only GMs edit FX macros" };
            }
            const stray = macroStrayPresetError(dry.value as MacroDocument);
            if (stray) return { ok: false, reason: "invalid_schema", error: stray };
            const check = validateFxSequence((dry.value as MacroDocument).sequence);
            if (!check.ok) return { ok: false, reason: "invalid_schema", error: check.error };
            const bound = this.fxBindingError(dry.value as MacroDocument, user);
            if (bound) return { ok: false, reason: "invalid_schema", error: bound };
          }
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "fxPreset") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs save FX presets" };
            const error = fxPresetDocumentError(dry.value as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "summon") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish summons" };
            const check = validateSummon((dry.value as MacroDocument).summon);
            if (!check.ok) return { ok: false, reason: "invalid_schema", error: check.error };
          }
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "script") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish scripts" };
            const error = this.scriptDocumentError(dry.value as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          continue;
        }
        case "delete": {
          const doc = this.store.resolve(op.ref);
          if (!doc)
            return {
              ok: false,
              reason: "invalid_schema",
              error: `delete: target not found`,
            };
          if (op.ref.coll === "automations" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete active zones" };
          if (op.ref.coll === "prefabs" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete prefabs" };
          if (PREFAB_COLLECTIONS.includes(op.ref.coll as (typeof PREFAB_COLLECTIONS)[number]) &&
              doc.flags?.prefab !== undefined && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete attached prefab parts" };
          if (op.ref.coll === "macros" && ["sequence", "script", "summon", "fxPreset"].includes((doc as MacroDocument).kind) &&
              user.role !== "GM" && user.role !== "ASSISTANT") {
            return { ok: false, reason: "forbidden", error: "only GMs delete FX/script/summon macros" };
          }
          const parent =
            op.ref.parent !== undefined
              ? this.store.resolve(op.ref.parent)
              : undefined;
          const canOpts = parent ? { parent } : {};
          if (
            !can(user, "delete", doc, this.embeddedCollName(op.ref), canOpts)
          ) {
            return {
              ok: false,
              reason: "forbidden",
              error: `delete ${op.ref.coll}/${op.ref.id}`,
            };
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
    audit?: ActionAudit,
  ): { ok: true; seq: number } | { ok: false; error: string } {
    // Expand parent transforms BEFORE auditing; the receipt MUST describe the
    // actual committed envelope, not the unexpanded client/script proposal.
    // Undo/redo and named Revert already contain every child pre-image.
    if (!txId.startsWith("undo-") && !txId.startsWith("redo-") &&
        !txId.startsWith("action-revert-")) {
      const attached = attachedMovementOps(this.store.world, ops);
      if (!attached.ok) return { ok: false, error: attached.error };
      const deleting = attachedDeletionOps(this.store.world, attached.ops);
      if (!deleting.ok) return { ok: false, error: deleting.error };
      // D-311: a timeline bound to a deleted item (or actor) loses its binding in the same
      // undoable envelope, so a dangling pointer can neither revive on a re-used id nor
      // linger as state a GM has to hunt down.
      ops = fxBindingDeletionOps(this.store.world,
        boundFxDeletionOps(this.store.world, summonDeletionOps(this.store.world, deleting.ops)));
    }
    if (audit) {
      if (!ops.length) return { ok: false, error: "Cannot audit an empty world action" };
      const previous = this.store.get("actionReceipts", audit.id) as ActionReceiptDocument | undefined;
      const stale = previous && actionStaleReason(previous, this.store);
      if (stale) return { ok: false, error: `Cannot extend stale action: ${stale}` };
      const shadow = this.store.forkForPreflight();
      const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by, txId, ops });
      if (!preview.ok) return { ok: false, error: preview.error };
      const candidate = extendActionReceipt(shadow, audit, ops, preview.value.inverses, previous, this.now());
      if (!candidate.ok) return { ok: false, error: candidate.error };
      ops = [...ops, previous
        ? { kind: "update", ref: { coll: "actionReceipts", id: audit.id }, diff: {
          status: candidate.receipt.status, commits: candidate.receipt.commits,
          inverses: candidate.receipt.inverses as unknown as Json,
          after: candidate.receipt.after as unknown as Json,
        } }
        : { kind: "create", coll: "actionReceipts", data: candidate.receipt }];
    }
    // Capture the START of each token path before applying any op. A multi-op transaction
    // fires once from first pre-image to final committed position, never from an optimistic drag.
    const moving = new Map<string, { sceneId: string; tokenId: string; before?: TokenDocument }>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "tokens" || ref.parent?.coll !== "scenes" ||
          (op.kind === "update" && !Object.keys(op.diff).some((key) => ["x", "y", "rotation"].includes(key))) ||
          op.kind === "delete") continue;
      const key = `${ref.parent.id}\u0000${ref.id}`;
      if (!moving.has(key)) {
        const before = op.kind === "create" ? undefined : this.store.resolve(op.ref) as TokenDocument | undefined;
        moving.set(key, { sceneId: ref.parent.id, tokenId: ref.id,
          ...(before ? { before } : {}) });
      }
    }
    const envelope: OpEnvelope = {
      seq: this.store.seq + 1,
      ts: this.now(),
      by,
      ops,
      txId,
    };
    const applied = this.store.applyEnvelope(envelope);
    if (!applied.ok) return { ok: false, error: applied.error };
    const appended = this.log.append(envelope, applied.value.inverses);
    if (!appended.ok) return { ok: false, error: appended.error };
    // Keep legacy global Undo for the newest commit. Its inverse also restores
    // the receipt version from that envelope; named Revert remains the durable,
    // multi-commit path and refuses stale/intervening edits.
    if (recordUndo) this.undoStack.push(envelope, applied.value.inverses);
    this.broadcastEnvelope(envelope, applied.value.inverses);
    this.scheduleSummonExpiry();
    // Reverting a movement must not re-trigger a trap while reversing it. A graph's
    // own committed Move/Rotation re-enters here through its commit; the depth cap
    // keeps a ping-pong graph pair from growing the host's call stack unboundedly.
    if (moving.size > 0 && !txId.startsWith("action-revert-")) {
      if (this.movementAutomationDepth < HostSync.MOVEMENT_AUTOMATION_DEPTH) {
        this.movementAutomationDepth++;
        try {
          this.fireMovementAutomations([...moving.values()], by);
        } finally {
          this.movementAutomationDepth--;
        }
      }
    }
    // F03: prune expired pending rolls (T+2 window) when a combat round/turn advanced
    try {
      let pruneTurn: number | null = null;
      for (const op of envelope.ops) {
        if (op.kind === "update" && op.ref.coll === "combats") {
          const diff = op.diff as Record<string, unknown>;
          const rd = diff["round"];
          if (typeof rd === "number" && Number.isFinite(rd as number))
            pruneTurn = Math.max(pruneTurn ?? 0, Math.trunc(rd as number));
          const td = diff["turn"];
          if (
            typeof td === "number" &&
            Number.isFinite(td as number) &&
            pruneTurn === null
          )
            pruneTurn = Math.max(pruneTurn ?? 0, Math.trunc(td as number));
        }
        if (op.kind === "create" && op.coll === "combats") {
          const data = op.data as unknown as Record<string, unknown>;
          const rd = data["round"];
          if (typeof rd === "number" && Number.isFinite(rd as number))
            pruneTurn = Math.max(pruneTurn ?? 0, Math.trunc(rd as number));
        }
      }
      if (pruneTurn !== null) {
        const msgs = [...this.store.getAll("messages")] as unknown as Array<{
          _id: string;
          system?: {
            pendingRoll?: import("../packages/pf1e/pendingRoll").PendingRoll;
          };
        }>;
        const prune = pendingPruneOps(
          msgs as unknown as Parameters<typeof pendingPruneOps>[0],
          pruneTurn,
        );
        if (prune.length > 0) this.commitSystem(prune, false);
        // F01: prune expired roll ledgers alongside pending rolls
        try {
          const msgs2 = [...this.store.getAll("messages")] as unknown as Array<{
            _id: string;
            system?: { rollLedger?: RollLedger };
          }>;
          const prune2 = rollLedgerPruneOps(
            msgs2 as unknown as Parameters<typeof rollLedgerPruneOps>[0],
            pruneTurn,
          );
          if (prune2.length > 0) this.commitSystem(prune2, false);
        } catch {
          // Pruning is best-effort: a malformed historical card never blocks the turn.
        }
      }
    } catch {
      // Turn detection/pruning must never break commit handling.
    }
    return { ok: true, seq: envelope.seq };
  }

  /** Re-project after media import/removal or document publication. The full replacement revokes stale metadata. */
  broadcastAssetManifests(): void {
    for (const session of this.sessions.values()) this.sendProjectedManifest(session);
    this.reconcileFxInstances();
  }

  private sendProjectedManifest(session: Session): void {
    if (!session.user) return;
    const manifest = projectAssetManifest(this.store.world, this.manifestSource(), session.user);
    const fingerprint = JSON.stringify(manifest);
    if (session.manifestFingerprint === fingerprint) return;
    session.manifestFingerprint = fingerprint;
    this.send(session, { kind: "asset.manifest", manifest });
  }

  private broadcastEnvelope(
    envelope: OpEnvelope,
    inverses: readonly Op[] = [],
  ): void {
    // §5 visibility crossings: updates whose diff replaces `ownership` may
    // cross a session's read boundary. New viewers never received the create
    // (it was projected away) — rewrite as a full-doc create; revoked viewers
    // get a delete. Same seq, no protocol additions (D-064).
    const crossings = visibilityCrossings(envelope, inverses, (ref) =>
      this.store.resolve(ref),
    );
    // D-271: a reveal set changes which *cells* a player may hold — the same rewrite shape, one
    // level down (cells are embedded in the scene whose flags moved).
    const cellCrossings = cellRevealCrossings(envelope, inverses, (ref) =>
      this.store.resolve(ref),
    );
    // A delete has already removed its document from the store. Projecting it
    // without its inverse pre-image used to send private message/hidden tile IDs
    // to players who never saw them; the stray delete could also invalidate an
    // entire mixed public/private undo envelope on their replica. Inverses are
    // keyed by ref rather than index because no-op updates need not have one.
    const deleted = new Map<string, BaseDocument>();
    for (const inverse of inverses) if (inverse.kind === "create")
      deleted.set(visibilityKey({ coll: inverse.coll, id: inverse.data._id,
        ...(inverse.parent ? { parent: inverse.parent } : {}) }), inverse.data);
    for (const session of this.sessions.values()) {
      if (!session.user) continue;
      const resolver = { resolve: (ref: DocRef) => this.store.resolve(ref) ?? deleted.get(visibilityKey(ref)) };
      const projected =
        crossings.length > 0
          ? projectWithCrossings(envelope, session.user, crossings, resolver)
          : projectEnvelope(envelope, session.user, resolver);
      if (projected) {
        const withCells =
          cellCrossings.length > 0
            ? withCellReveals(projected, session.user, cellCrossings)
            : projected;
        this.send(session, { kind: "ops", envelope: withCells });
      }
      // A visible document may add/remove an asset reference; even a projected-away op can
      // change the legacy "unreferenced" policy. Never leave connected clients with stale metadata.
      this.sendProjectedManifest(session);
    }
    this.reconcileFxInstances();
  }

  // ─── GM Tagger rules: live scene-wide allocation, not client-computed ops ───

  private readonly taggerRuleResults = new Map<string, TaggerRulesResultMsg>();

  private handleTaggerRules(session: Session, msg: TaggerRulesMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (caller.role !== "GM" && caller.role !== "ASSISTANT") {
      this.reject(session, String(msg.requestId), "forbidden", "Tagger rule allocation requires a GM");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "Tagger rule requests rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.requestId) ||
        !Array.isArray(msg.refs) || msg.refs.length < 1 || msg.refs.length > 32 ||
        Object.keys(msg).some((key) => !["kind", "requestId", "refs"].includes(key)) ||
        msg.refs.some((ref) => !isWorldTagRef(ref))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "Invalid Tagger rule references");
      return;
    }
    const requestKey = `${caller.id}:${msg.requestId}`;
    const previous = this.taggerRuleResults.get(requestKey);
    if (previous) { this.send(session, previous); return; } // reconnect/retry never allocates twice
    const seen = new Set<string>();
    const docs: Array<{ ref: DocRef; sceneId: string; doc: BaseDocument }> = [];
    for (const ref of msg.refs) {
      const sceneId = ref.coll === "scenes" ? ref.id : ref.parent?.id;
      const scene = sceneId ? this.store.get("scenes", sceneId) : undefined;
      const doc = this.store.resolve(ref);
      const identity = JSON.stringify([sceneId, ref.coll, ref.id]);
      if (!scene || !doc || seen.has(identity) ||
          !can(caller, "read", scene, "scenes") ||
          !can(caller, "update", doc, ref.coll,
            ref.coll === "scenes" ? {} : { parent: scene })) {
        this.reject(session, msg.requestId, "invalid_schema", "Missing, duplicate or unauthorized Tagger target");
        return;
      }
      seen.add(identity);
      docs.push({ ref, sceneId: scene._id, doc });
    }
    let ops: Op[];
    try { ops = tagRuleOps(this.store.world, docs); }
    catch (cause) {
      this.reject(session, msg.requestId, "invalid_schema",
        cause instanceof Error ? cause.message : "Invalid Tagger rule templates");
      return;
    }
    let seq = this.store.seq;
    if (ops.length) {
      const committed = this.commitOps(ops, caller.id, `tagger-rules-${msg.requestId}`, true,
        this.newActionAudit(`Tagger: apply rules (${ops.length} targets)`));
      if (!committed.ok) {
        this.reject(session, msg.requestId, "invariant", committed.error);
        return;
      }
      seq = committed.seq;
    }
    const result: TaggerRulesResultMsg = { kind: "tagger.rules.result", requestId: msg.requestId,
      changed: ops.length, seq };
    this.taggerRuleResults.set(requestKey, result);
    if (this.taggerRuleResults.size > 256) {
      const oldest = this.taggerRuleResults.keys().next().value;
      if (oldest) this.taggerRuleResults.delete(oldest);
    }
    this.send(session, result);
  }

  // ─── Reviewed JS macros: publication → durable idempotency → scoped host RPC ───

  private activeMacroRuns = 0;
  /** Only workers in this host lifetime can extend a pending receipt. */
  private readonly activeActionReceipts = new Set<string>();

  private newActionAudit(label: string, pending = false): ActionAudit {
    return { id: randomId(), label: label.slice(0, 160),
      ...(pending ? { pendingUntil: Date.now() + 35_000 } : {}) };
  }

  private finishActionAudit(audit: ActionAudit, outcome: "completed" | "partial"): void {
    this.activeActionReceipts.delete(audit.id);
    const doc = this.store.get("actionReceipts", audit.id) as ActionReceiptDocument | undefined;
    if (!doc || doc.status !== "pending") return;
    this.commitOps([{ kind: "update", ref: { coll: "actionReceipts", id: audit.id },
      diff: { status: "ready", outcome } }], this.systemUserId,
    `action-finish-${audit.id}`, false);
  }

  private handleActionRevert(session: Session, msg: import("../core/messages").ActionRevertMsg): void {
    const id = msg.receiptId;
    if (!session.user || session.user.role !== "GM") {
      this.reject(session, String(id), "forbidden", "Only a GM can Revert world actions");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(id), "rate_limited", "Revert rate exceeded");
      return;
    }
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
        Object.keys(msg).some((key) => key !== "kind" && key !== "receiptId")) {
      this.reject(session, String(id), "invalid_schema", "Invalid action receipt ID");
      return;
    }
    const receipt = this.store.get("actionReceipts", id) as ActionReceiptDocument | undefined;
    if (!receipt || receipt.type !== "actionReceipt" || receipt.status === "reverted") {
      this.reject(session, id, "invalid_schema", "Action is missing or already reverted");
      return;
    }
    if (receipt.status === "pending" &&
        (this.activeActionReceipts.has(id) || receipt.pendingUntil === undefined ||
          !Number.isFinite(receipt.pendingUntil) || Date.now() < receipt.pendingUntil)) {
      this.reject(session, id, "invalid_schema", "Action is still running; try again after it finishes");
      return;
    }
    if (receipt.status !== "ready" && receipt.status !== "pending") {
      this.reject(session, id, "invalid_schema", "Invalid action receipt");
      return;
    }
    const stale = actionStaleReason(receipt, this.store);
    if (stale) { this.reject(session, id, "invalid_schema", stale); return; }
    // The bounded chat collection may have naturally evicted this action's
    // message since it fired. Its inverse delete is already satisfied; never
    // let that housekeeping make an otherwise-unchanged HP/trap unrevertable.
    const missingChat = missingActionMessageDeletes(receipt, this.store);
    const inverses = receipt.inverses.filter((op) => !(op.kind === "delete" &&
      op.ref.coll === "messages" && missingChat.has(op.ref.id)));
    // Exact inverses must not cascade over NEW prefab/summon/FX dependents.
    // The original transaction already captured its own expanded child ops;
    // compute the live deletion closure only to detect NEW dependents, then
    // commit the recorded ops without double-expanding existing children.
    const deleting = attachedDeletionOps(this.store.world, inverses);
    if (!deleting.ok) { this.reject(session, id, "invariant", deleting.error); return; }
    const closure = boundFxDeletionOps(this.store.world,
      summonDeletionOps(this.store.world, deleting.ops));
    const recorded = new Set(inverses.filter((op) => op.kind === "delete")
      .map((op) => JSON.stringify(actionOpRef(op))));
    if (closure.some((op) => op.kind === "delete" && !recorded.has(JSON.stringify(actionOpRef(op))))) {
      this.reject(session, id, "invalid_schema", "Action has new dependent documents; Revert refused");
      return;
    }
    for (const op of inverses) {
      if (op.kind !== "update" || !op.ref.parent ||
          !Object.keys(op.diff).some((key) => ["x", "y", "rotation", "width", "height", "c", "points", "box",
            "direction", "dim", "bright", "distance", "radius"].includes(key))) continue;
      const attached = attachedMovementOps(this.store.world, [op]);
      if (!attached.ok || attached.ops.slice(1).some((extra) => extra.kind !== "update" ||
          !inverses.some((saved) => saved.kind === "update" &&
            JSON.stringify(saved.ref) === JSON.stringify(extra.ref)))) {
        this.reject(session, id, "invalid_schema", "Action has new or changed attachments; Revert refused");
        return;
      }
    }
    const ops: Op[] = [...inverses, { kind: "update", ref: { coll: "actionReceipts", id },
      diff: { status: "reverted" } }];
    // Preflight so a malformed/imported receipt or chat-cap side effect cannot
    // partially mutate the authoritative store. applyEnvelope is atomic too.
    const shadow = this.store.forkForPreflight();
    const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(),
      by: this.systemUserId, txId: `action-revert-${id}`, ops });
    if (!preview.ok) { this.reject(session, id, "invalid_schema", preview.error); return; }
    const trimmed = preview.value.changes.flatMap((change) => change.ops)
      .some((op) => op.kind === "delete" && op.ref.coll === "messages" &&
        !ops.some((saved) => saved.kind === "delete" && saved.ref.coll === "messages" &&
          saved.ref.id === op.ref.id));
    if (trimmed) { this.reject(session, id, "invalid_schema", "Revert would evict later chat; refused"); return; }
    const committed = this.commitOps(ops, this.systemUserId, `action-revert-${id}`, false);
    if (!committed.ok) this.reject(session, id, "invariant", committed.error);
  }

  private reportMacro(ctx: ScriptInvocation, macroId: string, ok: boolean, detail: string, result?: Json): void {
    const base: MacroResultMsg = { kind: "macro.result", requestId: ctx.requestId,
      macroId, callerId: ctx.caller.id, ok, detail };
    for (const session of this.sessions.values()) {
      if (!session.user) continue;
      if (session.user.role === "GM" || session.user.role === "ASSISTANT") {
        this.send(session, { ...base, trace: ctx.trace.slice(0, 256),
          ...(result !== undefined && boundedJson(result) ? { result } : {}) });
      } else if (session === ctx.session) {
        // No arbitrary script output, error details, tag results or action logs leave the GM tier.
        this.send(session, { ...base, detail: ok ? "Script completed" : "Script failed" });
      }
    }
  }

  private async handleMacroRequest(session: Session, msg: MacroRequestMsg): Promise<void> {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "macro requests rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.macroId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.macroId) ||
        !isRecord(msg.args) || !boundedJson(msg.args, 8192) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "macroId", "args"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid macro request");
      return;
    }
    if (this.activeMacroRuns >= 8) {
      this.reject(session, msg.requestId, "rate_limited", "macro execution queue is full");
      return;
    }
    const macro = this.store.get("macros", msg.macroId) as MacroDocument | undefined;
    const audit = this.newActionAudit(`Script: ${macro?.name ?? msg.macroId}`, true);
    const ctx: ScriptInvocation = { session, caller, requestId: msg.requestId,
      deadline: Date.now() + 30_000, budget: { calls: 0 }, trace: [], audit };
    this.activeMacroRuns++;
    this.activeActionReceipts.add(audit.id);
    let outcome: "completed" | "partial" = "completed";
    try {
      const result = await this.executeScript(msg.macroId, msg.args, ctx, "");
      this.reportMacro(ctx, msg.macroId, true, "Script completed", result);
    } catch (cause) {
      outcome = "partial";
      const reason = cause instanceof Error ? cause.message : "Unknown script error";
      this.reportMacro(ctx, msg.macroId, false, reason.slice(0, 500));
    } finally {
      this.finishActionAudit(audit, outcome);
      this.activeMacroRuns--;
    }
  }

  private async executeScript(
    macroId: string, rawArgs: unknown, ctx: ScriptInvocation, suffix: string,
    stack: readonly string[] = [], isActive: () => boolean = () => true,
  ): Promise<Json> {
    const { caller, session } = ctx;
    if (!isActive() || Date.now() >= ctx.deadline || stack.length >= 32 || stack.includes(macroId))
      throw new Error("Script deadline, nesting depth or recursion limit reached");
    const doc = this.store.get("macros", macroId) as MacroDocument | undefined;
    const checked = doc?.kind === "script" ? validateScriptMacro(doc) : null;
    if (!doc || !checked?.ok) throw new Error("Script is missing, unapproved or malformed");
    const policy = checked.policy;
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const scene = this.store.get("scenes", policy.sceneId) as SceneDocument | undefined;
    if (!scene || !can(caller, "read", scene, "scenes") || !can(caller, "read", doc, "macros") ||
        (!gm && !policy.playerCallable)) throw new Error("Script not published for this caller");
    const view = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
      ?.find((item) => item._id === scene._id);
    const inputs = validateScriptArgs(rawArgs, policy, (id) => !!view?.tokens.some((t) => t._id === id));
    if (!inputs.ok) throw new Error(inputs.error);
    const { approvedHash, ...reviewed } = policy;
    if (await scriptApprovalHash(doc.command, reviewed) !== approvedHash)
      throw new Error("Script source or policy changed since GM approval");
    // An await above yielded to other sessions: authorization and revision MUST still match.
    const latest = this.store.get("macros", macroId) as MacroDocument | undefined;
    if (!isActive() || !latest || latest.command !== doc.command || JSON.stringify(latest.script) !== JSON.stringify(policy) ||
        this.sessions.get(session.peerId) !== session || !can(caller, "read", latest, "macros"))
      throw new Error("Script changed, was unpublished or caller disconnected");
    const key = `${caller.id}:${ctx.requestId}${suffix}`;
    if (latest.scriptState?.recent.some((row) => row.key === key))
      throw new Error("Macro invocation already accepted (at-most-once replay guard)");
    // Record the invocation BEFORE the worker starts. This survives world save/reconnect
    // and suppresses duplicate world actions even when the caller retries after a crash.
    const recent = [...(latest.scriptState?.recent ?? []).slice(-255),
      { key, at: this.now(), revision: approvedHash }];
    const marked = this.commitOps([{ kind: "update", ref: { coll: "macros", id: macroId },
      diff: { scriptState: { recent } as unknown as Json } }],
    this.systemUserId, `macro-start-${randomId()}`, false);
    if (!marked.ok) throw new Error(`Script start failed: ${marked.error}`);
    ctx.trace.push(`start ${macroId} revision ${approvedHash.slice(0, 12)} caller ${caller.id} seq ${marked.seq}`);
    const path = [...stack, macroId];
    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) throw new Error("Script deadline reached");
    const result = await this.scriptRunner(doc.command, inputs.args,
      { sceneId: policy.sceneId, callerId: caller.id, requestId: ctx.requestId },
      (method, payload, live) => this.scriptAction(doc, policy, method, payload, ctx, path, () => isActive() && live()),
      Math.min(remaining, 10_000));
    if (!boundedJson(result)) throw new Error("Script result is not bounded JSON");
    ctx.trace.push(`return ${macroId}`);
    return result;
  }

  private async scriptAction(
    macro: MacroDocument, policy: ScriptPolicy, method: string, payload: unknown, ctx: ScriptInvocation,
    stack: readonly string[], isActive: () => boolean,
  ): Promise<Json> {
    if (!isActive() || ++ctx.budget.calls > 256 || Date.now() >= ctx.deadline)
      throw new Error("Script action/deadline budget exceeded");
    const seq = ctx.budget.calls;
    const { caller, session } = ctx;
    const current = this.store.get("macros", macro._id) as MacroDocument | undefined;
    if (!current || current.command !== macro.command ||
        JSON.stringify(current.script) !== JSON.stringify(policy) ||
        !can(caller, "read", current, "macros") ||
        ((caller.role !== "GM" && caller.role !== "ASSISTANT") && !policy.playerCallable) ||
        this.sessions.get(session.peerId) !== session) throw new Error("Script was revoked or caller disconnected");
    const scene = this.store.get("scenes", policy.sceneId) as SceneDocument | undefined;
    if (!scene || !can(caller, "read", scene, "scenes")) throw new Error("Script scene no longer accessible");
    if (!isRecord(payload) || !boundedJson(payload)) throw new Error("Invalid script action payload");
    const grant: ScriptGrant | undefined = ({
      "chat.say": "chat", "tags.find": "tags.read", "tags.get": "tags.read", "tags.edit": "tags.write",
      "tags.rules": "tags.write",
      "fx.play": "fx", "fx.stop": "fx", "fx.list": "fx", "fx.stopMatching": "fx",
      "automation.fire": "automation", "macros.call": "macros",
      "prefabs.place": "prefabs.place", "summons.place": "summons", "summons.dismiss": "summons",
    } as Record<string, ScriptGrant>)[method];
    if (!grant || !policy.grants.includes(grant)) throw new Error(`Action ${method} not granted`);
    ctx.trace.push(`${seq}: ${macro._id} ${method}`);
    if (method === "tags.get") {
      if (Object.keys(payload).length !== 1 || !isWorldTagRef(payload.ref))
        throw new Error("Invalid explicit-scene tag reference");
      const ref = payload.ref;
      const targetSceneId = ref.coll === "scenes" ? ref.id : ref.parent?.id;
      const targetScene = targetSceneId ? this.store.get("scenes", targetSceneId) : undefined;
      // The ref itself names the requested scene; neither GM-elevated code nor
      // an explicit ID may declassify an unseen placeable or private scene.
      if (!targetScene || !can(caller, "read", targetScene, "scenes"))
        throw new Error("Tag target unavailable");
      const hit = listTaggable(this.store.world, { sceneId: targetScene._id, viewer: caller,
        includeRefs: [ref] })[0];
      if (!hit) throw new Error("Tag target unavailable");
      return [...hit.tags];
    }
    if (method === "tags.find") {
      const options = payload.options ?? {};
      if (!isRecord(options) || Object.keys(options).some((k) =>
            !["mode", "pattern", "caseSensitive", "contains", "collections", "includeRefs", "excludeRefs",
              "sceneId", "allScenes", "groupByScene"].includes(k)) ||
          (options.collections !== undefined && (!Array.isArray(options.collections) || options.collections.length > 12 ||
            options.collections.some((c: unknown) => c !== "scenes" && !TAGGABLE_COLLECTIONS.includes(c as typeof TAGGABLE_COLLECTIONS[number])))) ||
          (options.mode !== undefined && !["all", "any", "exactSet"].includes(String(options.mode))) ||
          (options.pattern !== undefined && !["literal", "wildcard", "regex"].includes(String(options.pattern))) ||
          (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") ||
          (options.contains !== undefined && typeof options.contains !== "boolean") ||
          (options.allScenes !== undefined && typeof options.allScenes !== "boolean") ||
          (options.groupByScene !== undefined && typeof options.groupByScene !== "boolean") ||
          (options.sceneId !== undefined && (typeof options.sceneId !== "string" ||
            !options.sceneId || options.sceneId.length > 128 ||
            [...options.sceneId].some((char) => char.charCodeAt(0) < 32))) ||
          (options.allScenes === true && options.sceneId !== undefined))
        throw new Error("Invalid tag query options");
      const targetSceneId = options.allScenes === true ? undefined
        : options.sceneId === undefined || options.sceneId === "current" ? scene._id : options.sceneId as string;
      const targetScene = targetSceneId ? this.store.get("scenes", targetSceneId) : undefined;
      if (targetSceneId && (!targetScene || !can(caller, "read", targetScene, "scenes")))
        throw new Error("Tag scene unavailable");
      // In an all-scene query, refs must still explicitly identify their
      // parent scene. Entitlement is enforced by projection at query time.
      const validRefs = targetSceneId
        ? validSceneTagRefs(options.includeRefs, targetSceneId) &&
          validSceneTagRefs(options.excludeRefs, targetSceneId)
        : validWorldTagRefs(options.includeRefs) && validWorldTagRefs(options.excludeRefs);
      if (!validRefs) throw new Error("Invalid tag query references");
      if (!(typeof payload.query === "string" || Array.isArray(payload.query) &&
          payload.query.every((q: unknown) => typeof q === "string"))) throw new Error("Invalid tag query");
      const hits = getByTag(this.store.world, payload.query as string | string[], {
        ...(targetSceneId ? { sceneId: targetSceneId } : {}), viewer: caller,
        ...(options.mode !== undefined ? { mode: options.mode as TagMatchMode } : {}),
        ...(options.pattern !== undefined ? { pattern: options.pattern as TagPattern } : {}),
        ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive as boolean } : {}),
        ...(options.contains !== undefined ? { contains: options.contains as boolean } : {}),
        ...(options.collections !== undefined ? { collections: options.collections as typeof TAGGABLE_COLLECTIONS[number][] } : {}),
        ...(options.includeRefs !== undefined ? { includeRefs: options.includeRefs as unknown as DocRef[] } : {}),
        ...(options.excludeRefs !== undefined ? { excludeRefs: options.excludeRefs as unknown as DocRef[] } : {}),
      });
      if (hits.length > 100) throw new Error("Tag query matched over 100 documents; narrow the selector");
      // No entire documents or hidden host-only fields cross the worker
      // boundary. Grouping uses a null-prototype record for arbitrary scene IDs.
      const rows = hits.map((hit) => ({ sceneId: hit.sceneId,
        ref: { coll: hit.ref.coll, id: hit.ref.id,
          ...(hit.ref.parent ? { parent: { coll: hit.ref.parent.coll, id: hit.ref.parent.id } } : {}) },
        name: hit.doc.name, tags: [...hit.tags] }));
      const result = options.groupByScene === true ? rows.reduce<Record<string, typeof rows>>((grouped, row) => {
        (grouped[row.sceneId] ??= []).push(row);
        return grouped;
      }, Object.create(null) as Record<string, typeof rows>) : rows;
      if (!boundedJson(result)) throw new Error("Tag query result exceeds 16 KiB; narrow the selector");
      return result;
    }
    if (method === "tags.edit" || method === "tags.rules") {
      if (!Array.isArray(payload.refs) || payload.refs.length < 1 || payload.refs.length > 32 ||
          (method === "tags.rules" ? Object.keys(payload).some((key) => key !== "refs") :
            !["add", "remove", "toggle", "replace"].includes(String(payload.edit)) ||
            !Array.isArray(payload.tags) ||
            Object.keys(payload).some((key) => !["refs", "edit", "tags"].includes(key))))
        throw new Error("Invalid tag edit/rule call");
      // Build one fresh projection for the ACTUAL caller, not the GM run-as
      // principal. Even reviewed, elevated player code cannot write a secret
      // tile/scene merely by supplying its ID. Each ref names its scene; unlike
      // Tagger reads, writes always require concrete refs, never `allScenes`.
      const visible = listTaggable(this.store.world, { viewer: caller });
      const seen = new Set<string>();
      const docs: Array<{ ref: DocRef; sceneId: string; doc: BaseDocument }> = [];
      for (const input of payload.refs) {
        if (!isWorldTagRef(input)) throw new Error("Invalid explicit-scene tag target");
        const targetSceneId = input.coll === "scenes" ? input.id : input.parent?.id;
        const targetScene = targetSceneId ? this.store.get("scenes", targetSceneId) : undefined;
        if (!targetScene || !can(caller, "read", targetScene, "scenes"))
          throw new Error("Tag scene unavailable");
        const identity = JSON.stringify([targetScene._id, input.coll, input.id]);
        if (seen.has(identity)) throw new Error("Duplicate tag target");
        seen.add(identity);
        const entry = visible.find((item) => item.sceneId === targetSceneId &&
          item.ref.coll === input.coll && item.ref.id === input.id);
        if (!entry) throw new Error("Invisible or missing tag target");
        const live = this.store.resolve(entry.ref);
        if (!live || (policy.runAs === "caller" &&
            !can(caller, "update", live, input.coll,
              input.coll === "scenes" ? {} : { parent: targetScene })))
          throw new Error("Tag target not authorized");
        docs.push({ ref: entry.ref, sceneId: targetScene._id, doc: live });
      }
      // A scene-unique ordinal depends on *all* tags, including hidden ones.
      // A player could infer a secret 'trap-1' from receiving 'trap-2' even
      // after every ref was projected. GM elevation must NOT launder this read.
      if (method === "tags.rules" && caller.role !== "GM" && caller.role !== "ASSISTANT" &&
          docs.some(({ doc }) => tagsOf(doc).some((tag) => tag.includes("{#}"))))
        throw new Error("Scene-unique Tagger numbering requires a GM caller");
      const ops = method === "tags.rules" ? tagRuleOps(this.store.world, docs)
        : tagEditOps(docs, payload.edit as TagEdit, payload.tags as string[]);
      if (!ops.length) return { changed: 0 };
      const committed = this.commitOps(ops, policy.runAs === "gm" ? this.systemUserId : caller.id,
        `macro-${ctx.requestId}-${seq}`, true, ctx.audit);
      if (!committed.ok) throw new Error(`Tag commit failed: ${committed.error}`);
      ctx.trace.push(`  committed ${ops.length} ${method === "tags.rules" ? "tag rules" : "tag edits"} at seq ${committed.seq}`);
      return { changed: ops.length, seq: committed.seq };
    }
    if (method === "chat.say") {
      if (typeof payload.content !== "string" || !payload.content.trim() || payload.content.length > 1000 ||
          !["gm", "scene"].includes(String(payload.audience))) throw new Error("Invalid chat content/audience");
      const gmOnly = payload.audience === "gm";
      const message: MessageDocument = { _id: randomId(), type: "message", name: `Macro: ${macro.name}`,
        ownership: { default: gmOnly ? 0 : 1 }, flags: {}, system: {},
        // Chat projection lets an author see their own whisper. GM-only script output
        // must be host-authored or the player caller would receive the private text.
        author: gmOnly ? this.systemUserId : caller.id,
        content: payload.content, whisper: gmOnly ? [this.systemUserId] : [],
        roll: null, flavor: `Script macro: ${macro.name}` };
      const committed = this.commitOps([{ kind: "create", coll: "messages", data: message }],
        policy.runAs === "gm" ? this.systemUserId : caller.id, `macro-${ctx.requestId}-${seq}`, true, ctx.audit);
      if (!committed.ok) throw new Error(`Chat commit failed: ${committed.error}`);
      ctx.trace.push(`  chat seq ${committed.seq} audience ${payload.audience}`);
      return { messageId: message._id };
    }
    if (method === "fx.play") {
      if (typeof payload.macroId !== "string" ||
          (payload.sourceTokenId !== undefined && typeof payload.sourceTokenId !== "string") ||
          (payload.targetTokenId !== undefined && typeof payload.targetTokenId !== "string") ||
          (payload.waitForEnd !== undefined && payload.waitForEnd !== true) ||
          Object.keys(payload).some((key) => !["macroId", "sourceTokenId", "targetTokenId", "waitForEnd"].includes(key)))
        throw new Error("Invalid FX call");
      const projected = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
        ?.find((item) => item._id === scene._id);
      for (const tokenId of [payload.sourceTokenId, payload.targetTokenId]) {
        if (tokenId && !projected?.tokens.some((t) => t._id === tokenId))
          throw new Error("Invisible FX target");
      }
      const gm: SessionUser = { id: this.systemUserId, role: "GM", name: "Script" };
      const prepared = this.prepareFx(policy.runAs === "gm" ? gm : caller, {
        macroId: payload.macroId, sceneId: scene._id,
        ...(payload.sourceTokenId ? { sourceTokenId: payload.sourceTokenId } : {}),
        ...(payload.targetTokenId ? { targetTokenId: payload.targetTokenId } : {}),
      }, undefined, caller.id);
      if (!prepared.ok) throw new Error(`FX preflight failed: ${prepared.error}`);
      const durationMs = Math.max(...prepared.cue.sections.map((step) => step.startMs + step.durationMs));
      // An awaited short sequence must be safe to finish before this reviewed
      // Worker expires. Fail BEFORE emitting anything, including a persistent
      // loop or a 60-second cue that the 10-second Worker cannot await.
      if (payload.waitForEnd === true && (prepared.cue.persistent || durationMs + HostSync.FX_LEAD_MS > 7000))
        throw new Error("Awaited FX must be nonpersistent and finish within 7 seconds");
      if (!this.emitPreparedFx(prepared)) throw new Error("FX instance could not be committed");
      return { runId: prepared.cue.runId, atHostTime: prepared.cue.atHostTime,
        endsAtHostTime: prepared.cue.atHostTime + durationMs,
        persistent: prepared.cue.persistent === true };
    }
    if (method === "fx.list" || method === "fx.stopMatching") {
      if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "filter"))
        throw new Error("FX query needs one filter record");
      const checked = validateFxInstanceFilter(payload.filter, method === "fx.stopMatching");
      if (!checked.ok) throw new Error(checked.error);
      // A GM-reviewed player script still acts as its *actual caller* for FX
      // inspection/stopping. GM elevation for world ops is not a license to
      // enumerate another user's private FX or hidden media. Neither authored
      // graph IDs nor unprojected instance documents cross the worker boundary.
      const manifest = this.manifestSource();
      const privileged = caller.role === "GM" || caller.role === "ASSISTANT";
      const matches = this.store.getAll("fxInstances")
        .filter((doc) => doc.sceneId === scene._id &&
          (privileged || doc.ownerId === caller.id) &&
          fxInstanceMatches(doc, checked.filter) &&
          (privileged ? validateFxInstance(doc, scene, manifest) : this.canViewFxInstance(session, doc, manifest)))
        .sort((a, b) => a.atHostTime - b.atHostTime || a._id.localeCompare(b._id));
      if (method === "fx.list") {
        const rows = matches.map((doc) => ({ runId: doc._id, name: doc.name, macroId: doc.macroId,
          sceneId: doc.sceneId, atHostTime: doc.atHostTime,
          ...(doc.sourceTokenId ? { sourceTokenId: doc.sourceTokenId } : {}),
          ...(doc.targetTokenId ? { targetTokenId: doc.targetTokenId } : {}),
        }));
        if (!boundedJson(rows)) throw new Error("FX query result exceeds 16 KiB; narrow the selector");
        return rows;
      }
      if (matches.length > 16) throw new Error("FX stop matches over 16 instances; narrow the selector");
      if (!matches.length) return { stopped: 0 };
      const committed = this.commitOps(matches.map((doc) => ({ kind: "delete" as const,
        ref: { coll: "fxInstances" as const, id: doc._id } })), this.systemUserId,
      `macro-${ctx.requestId}-${seq}`);
      if (!committed.ok) throw new Error(`FX filtered stop failed: ${committed.error}`);
      ctx.trace.push(`  stopped ${matches.length} FX instance(s) atomically at seq ${committed.seq}`);
      return { stopped: matches.length, seq: committed.seq };
    }
    if (method === "fx.stop") {
      if (typeof payload.runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.runId) ||
          Object.keys(payload).some((key) => key !== "runId")) throw new Error("Invalid FX stop call");
      const instance = this.store.get("fxInstances", payload.runId);
      if (!instance || instance.sceneId !== scene._id ||
          (caller.role !== "GM" && caller.role !== "ASSISTANT" && instance.ownerId !== caller.id))
        throw new Error("FX instance unavailable");
      const committed = this.commitOps([{ kind: "delete", ref: { coll: "fxInstances", id: instance._id } }],
        this.systemUserId, `macro-${ctx.requestId}-${seq}`);
      if (!committed.ok) throw new Error(`FX stop failed: ${committed.error}`);
      ctx.trace.push(`  stopped FX instance at seq ${committed.seq}`);
      return { stopped: true, seq: committed.seq };
    }
    if (method === "summons.place") {
      const gm = caller.role === "GM" || caller.role === "ASSISTANT";
      const elevated = policy.runAs === "gm";
      if (typeof payload.presetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.presetId) ||
          !isRecord(payload.at) || typeof payload.at.x !== "number" || !Number.isFinite(payload.at.x) ||
          typeof payload.at.y !== "number" || !Number.isFinite(payload.at.y) ||
          Object.keys(payload.at).some((field) => !["x", "y"].includes(field)) ||
          (payload.summonerTokenId !== undefined &&
            (typeof payload.summonerTokenId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.summonerTokenId))) ||
          Object.keys(payload).some((field) => !["presetId", "at", "summonerTokenId"].includes(field)) ||
          (!gm && policy.summonIds?.length && !policy.summonIds.includes(payload.presetId)) ||
          (!gm && elevated && !policy.summonIds?.includes(payload.presetId)))
        throw new Error("Summon preset not approved for this invocation");
      const authorized = () => isActive() && (() => {
        const live = this.store.get("macros", macro._id) as MacroDocument | undefined;
        return live?.command === macro.command && JSON.stringify(live.script) === JSON.stringify(policy) &&
          can(caller, "read", live, "macros") &&
          (gm || policy.playerCallable);
      })();
      const placed = await this.commitSummonFromPreset({ session, caller, presetId: payload.presetId,
        sceneId: scene._id, at: { x: payload.at.x, y: payload.at.y },
        ...(typeof payload.summonerTokenId === "string" ? { summonerTokenId: payload.summonerTokenId } : {}),
        txId: `macro-${ctx.requestId}-${seq}`, audit: ctx.audit,
        asReviewedGM: elevated && (gm || policy.summonIds?.includes(payload.presetId) === true),
        isActive: authorized });
      if (!placed.ok) throw new Error(`Summon failed: ${placed.error}`);
      ctx.trace.push(`  summoned token ${placed.tokenId} at seq ${placed.seq}`);
      return { tokenId: placed.tokenId, seq: placed.seq };
    }
    if (method === "summons.dismiss") {
      if (typeof payload.tokenId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.tokenId) ||
          Object.keys(payload).some((field) => field !== "tokenId"))
        throw new Error("Invalid summon dismissal");
      // Even reviewed GM elevation does not let a player dismiss another
      // player's instance: the actor belongs to the actual script caller.
      const dismissed = this.commitSummonDismiss(caller, scene._id, payload.tokenId,
        `macro-${ctx.requestId}-${seq}`, ctx.audit);
      if (!dismissed.ok) throw new Error(dismissed.error);
      ctx.trace.push(`  dismissed summon at seq ${dismissed.seq}`);
      return { dismissed: true, seq: dismissed.seq };
    }
    if (method === "prefabs.place") {
      const elevated = policy.runAs === "gm";
      const gm = caller.role === "GM" || caller.role === "ASSISTANT";
      if ((!gm && (!elevated || !policy.prefabIds?.includes(String(payload.prefabId)))) ||
          typeof payload.prefabId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.prefabId) ||
          Object.keys(payload).some((key) => !["prefabId", "at", "rotation", "scale"].includes(key)))
        throw new Error("Prefab not approved for this invocation");
      const asGm: SessionUser = { id: this.systemUserId, role: "GM", name: "Reviewed prefab script" };
      const placed = this.commitPrefabPlacement(elevated ? asGm : caller, payload.prefabId,
        scene._id, { at: payload.at, ...(payload.rotation !== undefined ? { rotation: payload.rotation } : {}),
          ...(payload.scale !== undefined ? { scale: payload.scale } : {}) }, caller, ctx.audit);
      if (!placed.ok) throw new Error(`Prefab placement failed: ${placed.error}`);
      ctx.trace.push(`  placed prefab instance at seq ${placed.seq}`);
      return { instanceId: placed.instanceId, rootId: placed.rootId, seq: placed.seq };
    }
    if (method === "automation.fire") {
      if (typeof payload.automationId !== "string" || !["click", "manual", "enter", "exit", "stop", "create", "rotate"].includes(String(payload.method)) ||
          (payload.tokenId !== undefined && typeof payload.tokenId !== "string"))
        throw new Error("Invalid automation call");
      const graph = this.store.get("automations", payload.automationId) as AutomationDocument | undefined;
      const checked = graph ? validateAutomation(graph.definition) : null;
      const definition = checked?.ok ? checked.definition : null;
      const tile = scene.tiles.find((item) => item._id === definition?.tileId);
      const token = payload.tokenId ? scene.tokens.find((item) => item._id === payload.tokenId) : undefined;
      const gm = caller.role === "GM" || caller.role === "ASSISTANT";
      if (!graph || !definition || !tile || definition.sceneId !== scene._id ||
          !definition.methods.includes(payload.method as AutomationMethod) ||
          (payload.tokenId && !token) ||
          (!gm && (payload.method !== "click" || !definition.gates?.playerRunnable ||
            !can(caller, "read", tile, "tiles", { parent: scene }) ||
            !docVisibleTo(caller, tile, scene) ||
            (token && !can(caller, "update", token, "tokens", { parent: scene })))))
        throw new Error("Automation is not published for this caller");
      const fired = this.fireAutomation(graph, { scene, tile, caller,
        method: payload.method as AutomationMethod, at: this.now(), rng: this.rng,
        ...(token ? { token } : {}) });
      if (!fired.ok) throw new Error(fired.error);
      return { fired: true };
    }
    if (method === "macros.call") {
      if (typeof payload.macroId !== "string" || !isRecord(payload.args))
        throw new Error("Invalid nested macro call");
      const child = this.store.get("macros", payload.macroId) as MacroDocument | undefined;
      if (child?.kind !== "script" ||
          ((caller.role !== "GM" && caller.role !== "ASSISTANT") && child.script?.sceneId !== scene._id))
        throw new Error("Nested script not published in this scene");
      return this.executeScript(payload.macroId, payload.args, ctx, `:${seq}`, stack, isActive);
    }
    throw new Error("Unsupported script action");
  }

  // ─── GM-owned prefabs: saved templates → host-allocated atomic placement ───

  private readonly seenPrefabRequests = new Map<string, number>();

  private handlePrefabPlace(session: Session, msg: PrefabPlaceMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (caller.role !== "GM" && caller.role !== "ASSISTANT") {
      this.reject(session, String(msg.requestId), "forbidden", "prefab placement unavailable");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "prefab placement rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.prefabId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.prefabId) ||
        typeof msg.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.sceneId) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "prefabId", "sceneId", "at", "rotation", "scale"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid prefab request");
      return;
    }
    const key = `${caller.id}:${msg.requestId}`;
    if (this.seenPrefabRequests.has(key)) return;
    const placed = this.commitPrefabPlacement(caller, msg.prefabId, msg.sceneId,
      { at: msg.at, ...(msg.rotation !== undefined ? { rotation: msg.rotation } : {}),
        ...(msg.scale !== undefined ? { scale: msg.scale } : {}) });
    if (placed.ok) {
      this.seenPrefabRequests.set(key, this.now());
      if (this.seenPrefabRequests.size > 256) {
        const first = this.seenPrefabRequests.keys().next().value;
        if (first) this.seenPrefabRequests.delete(first);
      }
    }
    this.send(session, { kind: "prefab.result", requestId: msg.requestId, ok: placed.ok,
      detail: placed.ok ? `${placed.parts} prefab objects placed atomically` : placed.error,
      ...(placed.ok ? { seq: placed.seq, instanceId: placed.instanceId, rootId: placed.rootId } : {}) });
  }

  /** Common reviewed-script and GM request path: nothing is written until all
   * IDs, geometry, linked graphs, imported media and publication are checked.
   * Scripts never supply operation lists or child flags to this path. */
  private commitPrefabPlacement(caller: SessionUser, prefabId: string, sceneId: string, placement: unknown,
    requester: SessionUser = caller, audit?: ActionAudit):
    | { ok: true; seq: number; instanceId: string; rootId: string; parts: number }
    | { ok: false; error: string } {
    const prefab = this.store.get("prefabs", prefabId) as PrefabDocument | undefined;
    const scene = this.store.get("scenes", sceneId) as SceneDocument | undefined;
    if (!prefab || !scene || !can(caller, "create", prefab, "prefabs") ||
        !can(caller, "update", scene, "scenes"))
      return { ok: false, error: "prefab or destination scene unavailable" };
    const checked = validatePrefab(prefab.definition);
    if (!checked.ok) return checked;
    // Prefab placement allocates `{#}` against every scene tag. A reviewed GM
    // script may elevate world writes, but it cannot leak hidden tag occupancy
    // to its actual player caller through the generated tags on visible parts.
    if (requester.role !== "GM" && requester.role !== "ASSISTANT" &&
        checked.definition.parts.some((part) => tagsOf(part.doc).some((tag) => tag.includes("{#}"))))
      return { ok: false, error: "Scene-unique prefab numbering requires a GM caller" };
    const planned = planPrefabPlacement(this.store.world, checked.definition, sceneId, placement);
    if (!planned.ok) return planned;
    // Linked dependencies remain in the live host world. A missing/unreviewed
    // script or missing FX asset fails the WHOLE prefab, not a partial trap.
    for (const op of planned.plan.ops) {
      if (op.kind !== "create" || op.coll !== "automations") continue;
      const graph = op.data as AutomationDocument;
      for (const step of graph.definition.steps) {
        if (step.kind !== "sequence" && step.kind !== "script") continue;
        const macro = this.store.get("macros", step.macroId) as MacroDocument | undefined;
        const valid = step.kind === "sequence" ? macro?.kind === "sequence" && validateFxSequence(macro.sequence).ok
          : macro?.kind === "script" && (() => {
            const approved = validateScriptMacro(macro);
            if (!approved.ok || approved.policy.sceneId !== sceneId) return false;
            const { approvedHash, ...reviewed } = approved.policy;
            return scriptApprovalHashSync(macro.command, reviewed) === approvedHash;
          })();
        if (!valid) return { ok: false, error: `missing or unreviewed ${step.kind} dependency ${step.macroId}` };
        if (step.kind === "sequence" && macro?.sequence?.sections.some((section) =>
          (section.kind === "image" || section.kind === "sound") &&
          !this.manifestSource()[section.assetId]))
          return { ok: false, error: `prefab FX dependency ${step.macroId} has missing media` };
      }
    }
    const committed = this.commitOps(planned.plan.ops, this.systemUserId,
      `prefab-${randomId()}`, true, audit ?? this.newActionAudit(`Prefab: ${prefab.name}`));
    return committed.ok ? { ok: true, seq: committed.seq, instanceId: planned.plan.instanceId,
      rootId: planned.plan.rootId, parts: planned.plan.ops.length } : { ok: false, error: committed.error };
  }

  // ─── GM-published summons: private source → fresh actor + linked scene token ───

  private summonStatus(session: Session, requestId: string, ok: boolean, detail: string,
    seq?: number, tokenId?: string): void {
    const result: SummonResultMsg = { kind: "summon.result", requestId, ok, detail,
      ...(seq !== undefined ? { seq } : {}), ...(tokenId ? { tokenId } : {}) };
    if (this.sessions.get(session.peerId) === session) this.send(session, result);
  }

  private async handleSummonPlace(session: Session, msg: SummonPlaceMsg): Promise<void> {
    const caller = session.user;
    if (!caller) return;
    const fail = (detail: string) => this.summonStatus(session, String(msg.requestId).slice(0, 128), false,
      caller.role === "GM" || caller.role === "ASSISTANT" ? detail : "Summon unavailable or placement not allowed");
    if (!session.intentBucket.tryRemove()) { fail("Summoning rate-limited"); return; }
    const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
    if (!validId(msg.requestId) || !validId(msg.presetId) || !validId(msg.sceneId) ||
        (msg.summonerTokenId !== undefined && !validId(msg.summonerTokenId)) ||
        !isRecord(msg.at) || typeof msg.at.x !== "number" || !Number.isFinite(msg.at.x) ||
        typeof msg.at.y !== "number" || !Number.isFinite(msg.at.y) ||
        Object.keys(msg.at).some((key) => !["x", "y"].includes(key)) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "presetId", "sceneId", "at", "summonerTokenId"].includes(key))) {
      fail("Malformed summon request"); return;
    }
    const key = `${caller.id}:${msg.requestId}`;
    if (this.summonRequests.has(key)) return; // in-flight and successful retries cannot duplicate
    this.summonRequests.set(key, this.now());
    let success = false;
    try {
      const placed = await this.commitSummonFromPreset({ session, caller, presetId: msg.presetId,
        sceneId: msg.sceneId, at: msg.at,
        ...(msg.summonerTokenId ? { summonerTokenId: msg.summonerTokenId } : {}),
        txId: `summon-${msg.requestId}` });
      if (!placed.ok) { fail(placed.error); return; }
      success = true;
      this.summonStatus(session, msg.requestId, true, "Summoned", placed.seq, placed.tokenId);
    } catch {
      fail("Unable to resolve summon source");
    } finally {
      if (!success) this.summonRequests.delete(key);
      else if (this.summonRequests.size > 256) {
        const oldest = this.summonRequests.keys().next().value;
        if (oldest) this.summonRequests.delete(oldest);
      }
    }
  }

  /** One authority path for the UI and reviewed script RPCs. Both allocate a
   * new actor+token in a single envelope; private sources require explicit
   * GM authority OR a revision-pinned, allowlisted elevated script. */
  private async commitSummonFromPreset(input: {
    session: Session; caller: SessionUser; presetId: string; sceneId: string;
    at: { x: number; y: number }; summonerTokenId?: string; txId: string;
    asReviewedGM?: boolean; isActive?: () => boolean; audit?: ActionAudit;
  }): Promise<{ ok: true; seq: number; tokenId: string } | { ok: false; error: string }> {
    const fail = (error: string) => ({ ok: false as const, error });
    const { session, caller, presetId, sceneId, at, summonerTokenId, txId } = input;
    const alive = () => (input.isActive?.() ?? true) &&
      this.sessions.get(session.peerId) === session && session.user === caller;
    if (!alive()) return fail("Summon request no longer active");
    this.sweepExpiredSummons();
    const preset = this.store.get("macros", presetId) as MacroDocument | undefined;
    const checked = preset?.kind === "summon" ? validateSummon(preset.summon) : null;
    if (!preset || !checked?.ok || checked.definition.sceneId !== sceneId)
      return fail("Summon preset unavailable");
    const definition = checked.definition;
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const source = definition.source.kind === "world"
      ? this.store.get("actors", definition.source.actorId) as ActorDocument | undefined
      : await this.resolveSummonSource?.(definition.source);
    // Async pack lookup: re-read grants, source identity and caster, and check
    // worker/caller liveness AFTER yielding. Failure commits nothing.
    if (!alive()) return fail("Summon request no longer active");
    const latest = this.store.get("macros", presetId) as MacroDocument | undefined;
    const scene = this.store.get("scenes", sceneId) as SceneDocument | undefined;
    const current = latest?.kind === "summon" ? validateSummon(latest.summon) : null;
    const privateApproved = gm || input.asReviewedGM === true;
    if (!latest || !current?.ok || JSON.stringify(current.definition) !== JSON.stringify(definition) ||
        !scene || !can(caller, "read", scene, "scenes") ||
        (!privateApproved && (!can(caller, "read", latest, "macros") ||
          !definition.playerCallable || !docVisibleTo(caller, latest))) ||
        (definition.source.kind === "world" &&
          source !== this.store.get("actors", definition.source.actorId)))
      return fail("Summon is no longer published or scene is unavailable");
    const summoner = summonerTokenId ? scene.tokens.find((t) => t._id === summonerTokenId) : undefined;
    if (!gm && (!summoner || !can(caller, "update", summoner, "tokens", { parent: scene }) ||
        !docVisibleTo(caller, summoner, scene))) return fail("An owned summoner token is required");
    const active = this.store.world.scenes.reduce((count, sc) => count + sc.tokens.filter((token) =>
      summonMarker(token)?.ownerId === caller.id).length, 0);
    if (active >= 32) return fail("Summon instance limit reached");
    if (!source) return fail("Summon source missing");
    const planned = planSummon({ definition, presetId, scene, source,
      caller, ...(summoner ? { summoner } : {}), at, now: this.now(),
      instanceId: randomId(), actorId: randomId(), tokenId: randomId(), manifest: this.manifestSource() });
    if (!planned.ok) return fail(planned.error);
    if (!alive()) return fail("Summon request no longer active");
    const commit = this.commitOps(planned.ops, caller.id, txId, true,
      input.audit ?? this.newActionAudit(`Summon: ${preset.name}`));
    return commit.ok ? { ok: true, seq: commit.seq, tokenId: planned.token._id } : fail(commit.error);
  }

  private handleSummonDismiss(session: Session, msg: SummonDismissMsg): void {
    const user = session.user;
    if (!user) return;
    const fail = () => this.summonStatus(session, String(msg.requestId).slice(0, 128), false, "Summon unavailable");
    if (!session.intentBucket.tryRemove() || typeof msg.requestId !== "string" ||
        typeof msg.sceneId !== "string" || typeof msg.tokenId !== "string" ||
        [msg.requestId, msg.sceneId, msg.tokenId].some((v) => !/^[A-Za-z0-9_-]{1,128}$/.test(v)) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "sceneId", "tokenId"].includes(key))) { fail(); return; }
    const key = `${user.id}:${msg.requestId}`;
    if (this.summonRequests.has(key)) return;
    const commit = this.commitSummonDismiss(user, msg.sceneId, msg.tokenId,
      `summon-dismiss-${msg.requestId}`);
    if (!commit.ok) { fail(); return; }
    this.summonRequests.set(key, this.now());
    this.summonStatus(session, msg.requestId, true, "Dismissed", commit.seq, msg.tokenId);
  }

  private commitSummonDismiss(user: SessionUser, sceneId: string, tokenId: string, txId: string,
    audit?: ActionAudit): { ok: true; seq: number } | { ok: false; error: string } {
    const scene = this.store.get("scenes", sceneId) as SceneDocument | undefined;
    const token = scene?.tokens.find((t) => t._id === tokenId);
    const marker = token && summonMarker(token);
    if (!marker || marker.tokenId !== tokenId || marker.sceneId !== sceneId ||
        (user.role !== "GM" && user.role !== "ASSISTANT" && marker.ownerId !== user.id))
      return { ok: false, error: "Summon unavailable" };
    return this.commitOps([{ kind: "delete", ref: { coll: "tokens", id: tokenId,
      parent: { coll: "scenes", id: sceneId } } }], user.id, txId, true,
    audit ?? this.newActionAudit(`Dismiss summon: ${token.name}`));
  }

  /** Browser timers can sleep; joining or any new summon request also sweeps
   * expired instances. Recomputing from stored markers survives reload. */
  private sweepExpiredSummons(): void {
    if (this.disposed) return;
    const now = this.now();
    const ops: Op[] = [];
    for (const scene of this.store.world.scenes) for (const token of scene.tokens) {
      const marker = summonMarker(token);
      if (marker?.expiresAt !== undefined && marker.expiresAt <= now &&
          marker.sceneId === scene._id && marker.tokenId === token._id)
        ops.push({ kind: "delete", ref: { coll: "tokens", id: token._id,
          parent: { coll: "scenes", id: scene._id } } });
    }
    if (ops.length) this.commitOps(ops, this.systemUserId, `summon-expiry-${randomId()}`, false);
    else this.scheduleSummonExpiry();
  }

  private scheduleSummonExpiry(): void {
    if (this.summonTimer) clearTimeout(this.summonTimer);
    this.summonTimer = null;
    if (this.disposed) return;
    let next = Infinity;
    for (const scene of this.store.world.scenes) for (const token of scene.tokens) {
      const marker = summonMarker(token);
      if (marker?.expiresAt !== undefined && marker.sceneId === scene._id && marker.tokenId === token._id)
        next = Math.min(next, marker.expiresAt);
    }
    if (Number.isFinite(next)) {
      this.summonTimer = setTimeout(() => this.sweepExpiredSummons(),
        Math.max(0, Math.min(2_147_483_647, next - this.now())));
      (this.summonTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Tear down the expiry scheduler when the host world closes. */
  dispose(): void {
    this.disposed = true;
    if (this.summonTimer) clearTimeout(this.summonTimer);
    this.summonTimer = null;
    if (this.fxMediaTimer) clearTimeout(this.fxMediaTimer);
    this.fxMediaTimer = null;
  }

  // ─── Active-zone graphs: host events → atomic world plan → projected cues ───

  private readonly seenAutomationRequests = new Map<string, number>();
  /** Reentry depth of movement-trigger dispatch. A graph's committed Move/Rotation
   * can land a token in another tile whose graph moves it on, so the chain is
   * bounded at the host, not by each plan's own invocation budget. */
  private movementAutomationDepth = 0;
  private static readonly MOVEMENT_AUTOMATION_DEPTH = 8;

  /** Public canvas gesture resolves a tile to private graphs on the host. */
  private handleAutomationClick(session: Session, msg: AutomationClickMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "tile clicks rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.sceneId !== "string" || typeof msg.tileId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.sceneId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.tileId) ||
        (msg.tokenId !== undefined && (typeof msg.tokenId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.tokenId))) ||
        !isRecord(msg.point) || Object.keys(msg.point).some((key) => !["x", "y"].includes(key)) ||
        typeof msg.point.x !== "number" || !Number.isFinite(msg.point.x) ||
        typeof msg.point.y !== "number" || !Number.isFinite(msg.point.y) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "sceneId", "tileId", "point", "tokenId"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid tile click");
      return;
    }
    const key = `${caller.id}:${msg.requestId}`;
    if (this.seenAutomationRequests.has(key)) return;
    const scene = this.store.get("scenes", msg.sceneId) as SceneDocument | undefined;
    const tile = scene?.tiles.find((item) => item._id === msg.tileId);
    const token = msg.tokenId ? scene?.tokens.find((item) => item._id === msg.tokenId) : undefined;
    if (!scene?.active || !tile || !can(caller, "read", scene, "scenes") ||
        !can(caller, "read", tile, "tiles", { parent: scene }) ||
        !docVisibleTo(caller, tile, scene) || !tileContainsPoint(tile, msg.point) ||
        msg.point.x < 0 || msg.point.y < 0 || msg.point.x > scene.width || msg.point.y > scene.height ||
        (msg.tokenId && (!token || !docVisibleTo(caller, token, scene) ||
          !can(caller, "update", token, "tokens", { parent: scene })))) {
      this.reject(session, msg.requestId, "forbidden", "tile unavailable");
      return;
    }
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const graphs = this.store.getAll("automations").flatMap((doc) => {
      const checked = validateAutomation(doc.definition);
      return checked.ok && checked.definition.sceneId === scene._id &&
        checked.definition.tileId === tile._id && checked.definition.methods.includes("click") &&
        (gm || checked.definition.gates?.playerRunnable === true) ? [doc] : [];
    }).sort((a, b) => a._id.localeCompare(b._id));
    // Visible tiles are ordinary art too. Do not distinguish an unpublished graph
    // from a plain tile by sending a success/failure containing private metadata.
    if (!graphs.length) return;
    this.seenAutomationRequests.set(key, this.now());
    if (this.seenAutomationRequests.size > 256) {
      const first = this.seenAutomationRequests.keys().next().value;
      if (first) this.seenAutomationRequests.delete(first);
    }
    for (const graph of graphs) {
      const liveScene = this.store.get("scenes", scene._id) as SceneDocument | undefined;
      const liveTile = liveScene?.tiles.find((item) => item._id === tile._id);
      if (!liveScene || !liveTile || !docVisibleTo(caller, liveTile, liveScene)) break;
      const liveToken = token ? liveScene.tokens.find((item) => item._id === token._id) : undefined;
      if (token && (!liveToken || !docVisibleTo(caller, liveToken, liveScene))) break;
      this.fireAutomation(graph, { scene: liveScene, tile: liveTile, caller, method: "click",
        at: this.now(), rng: this.rng, ...(liveToken ? { token: liveToken } : {}) });
    }
  }

  private handleAutomationRequest(session: Session, msg: AutomationRequestMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "automation requests rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.automationId !== "string" || typeof msg.sceneId !== "string" ||
        !["enter", "exit", "stop", "create", "rotate", "click", "manual"].includes(msg.method) ||
        (msg.tokenId !== undefined && typeof msg.tokenId !== "string") ||
        (msg.dryRun !== undefined && typeof msg.dryRun !== "boolean") ||
        Object.keys(msg).some((key) => !["kind", "requestId", "automationId", "sceneId", "method", "tokenId", "dryRun"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid automation request");
      return;
    }
    const isGm = caller.role === "GM" || caller.role === "ASSISTANT";
    // This ID-bearing endpoint is an author/debug interface. Even a published
    // click must come through automation.click: it proves the visible tile and
    // rotated hit without ever giving the player an opaque private graph ID.
    // Keeping the older player click path would bypass hit testing entirely.
    if (!isGm) {
      this.reject(session, msg.requestId, "forbidden", "not published for this caller");
      return;
    }
    const requestKey = `${caller.id}:${msg.requestId}`;
    if (this.seenAutomationRequests.has(requestKey)) return;
    const doc = this.store.get("automations", msg.automationId) as AutomationDocument | undefined;
    // Imported worlds can contain definitions that predate the current schema (or are malformed).
    // Never dereference methods/gates from an unvalidated persisted document.
    const checked = doc ? validateAutomation(doc.definition) : null;
    const definition = checked?.ok ? checked.definition : null;
    const scene = this.store.get("scenes", msg.sceneId) as SceneDocument | undefined;
    const tile = scene?.tiles.find((t) => t._id === definition?.tileId);
    const token = msg.tokenId ? scene?.tokens.find((t) => t._id === msg.tokenId) : undefined;
    if (!doc || !scene || !tile || !definition || definition.sceneId !== scene._id ||
        !definition.methods.includes(msg.method) || (msg.tokenId && !token)) {
      this.reject(session, msg.requestId, "forbidden", "graph unavailable");
      return;
    }
    this.seenAutomationRequests.set(requestKey, this.now());
    if (this.seenAutomationRequests.size > 256) {
      const first = this.seenAutomationRequests.keys().next().value;
      if (first) this.seenAutomationRequests.delete(first);
    }
    const event: AutomationEvent = { method: msg.method, scene, tile, caller,
      at: this.now(), rng: msg.dryRun === true
        ? automationPreviewRng(`${doc._id}:${msg.method}:${msg.tokenId ?? ""}:${doc.state?.count ?? 0}`)
        : this.rng, ...(token ? { token } : {}) };
    const result = this.fireAutomation(doc, event, msg.dryRun === true);
    if (!result.ok) this.reject(session, msg.requestId, isGm ? "invalid_schema" : "forbidden",
      isGm ? result.error : "automation unavailable");
  }

  private fireMovementAutomations(
    sources: Array<{ sceneId: string; tokenId: string; before?: TokenDocument }>, by: UserId,
  ): void {
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    const candidates: Array<{ docId: string; sceneId: string; tokenId: string; tileId: string;
      method: AutomationMethod; fraction: number; sort: number; direction?: AutomationEvent["direction"] }> = [];
    for (const source of sources) {
      const scene = this.store.get("scenes", source.sceneId) as SceneDocument | undefined;
      const token = scene?.tokens.find((t) => t._id === source.tokenId);
      if (!scene || !token) continue;
      const dx = source.before ? token.x - source.before.x : 0;
      const dy = source.before ? token.y - source.before.y : 0;
      const direction: AutomationEvent["direction"] = {
        ...(dx < -1e-6 ? { x: "left" as const } : dx > 1e-6 ? { x: "right" as const } : {}),
        ...(dy < -1e-6 ? { y: "up" as const } : dy > 1e-6 ? { y: "down" as const } : {}),
      };
      for (const doc of this.store.getAll("automations")) {
        const checked = validateAutomation(doc.definition);
        if (!checked.ok || checked.definition.sceneId !== scene._id) continue;
        const tile = scene.tiles.find((t) => t._id === checked.definition.tileId);
        if (!tile) continue;
        for (const hit of sweptTileEvents(tile, source.before, token)) {
          if (checked.definition.methods.includes(hit.method)) candidates.push({
            docId: doc._id, sceneId: scene._id, tokenId: token._id, tileId: tile._id,
            method: hit.method, fraction: hit.fraction, direction,
            sort: typeof tile.sort === "number" && Number.isFinite(tile.sort) ? tile.sort : 0,
          });
        }
      }
    }
    // Path fraction determines first contact; for coincident tiles use method,
    // descending tile Sort (not elevation), then stable IDs. No player sets priority.
    const methodOrder: Record<AutomationMethod, number> = {
      enter: 0, exit: 1, stop: 2, create: 3, rotate: 4, click: 5, manual: 6,
    };
    candidates.sort((a, b) => a.sceneId.localeCompare(b.sceneId) ||
      a.fraction - b.fraction || a.tokenId.localeCompare(b.tokenId) ||
      methodOrder[a.method] - methodOrder[b.method] || b.sort - a.sort ||
      a.tileId.localeCompare(b.tileId) || a.docId.localeCompare(b.docId));
    const stopped = new Map<string, string>(); // scene/token -> tile that stopped additional tiles
    for (const hit of candidates) {
      const scope = `${hit.sceneId}\u0000${hit.tokenId}`;
      if (stopped.has(scope) && stopped.get(scope) !== hit.tileId) continue;
      const doc = this.store.get("automations", hit.docId) as AutomationDocument | undefined;
      const scene = this.store.get("scenes", hit.sceneId) as SceneDocument | undefined;
      const tile = scene?.tiles.find((t) => t._id === doc?.definition?.tileId);
      const token = scene?.tokens.find((t) => t._id === hit.tokenId);
      if (!doc || !scene || !tile || !token) continue;
      const result = this.fireAutomation(doc, { scene, tile, token, caller, method: hit.method,
        ...(hit.direction ? { direction: hit.direction } : {}), at: this.now(), rng: this.rng });
      if (result.ok && result.stopOthers) stopped.set(scope, hit.tileId);
    }
  }

  private reportAutomation(
    doc: AutomationDocument, method: AutomationMethod,
    result: AutomationTraceMsg["result"], detail: string, trace: string[], seq?: number,
  ): void {
    const maxTrace = 4_096;
    const shown = trace.length > maxTrace
      ? [...trace.slice(0, maxTrace - 1), `… ${trace.length - maxTrace + 1} more trace entries omitted (delivery limit)`]
      : trace;
    const msg: AutomationTraceMsg = { kind: "automation.trace", automationId: doc._id,
      method, result, detail, trace: shown, ...(seq !== undefined ? { seq } : {}) };
    for (const session of this.sessions.values()) {
      if (session.user?.role === "GM" || session.user?.role === "ASSISTANT") this.send(session, msg);
    }
  }

  private fireAutomation(
    doc: AutomationDocument, event: AutomationEvent, dryRun = false,
  ): { ok: true; stopOthers: boolean } | { ok: false; error: string } {
    const result = planAutomation(this.store.world, doc,
      { ...event, hurtHeal: planAutomationHealth }, this.systemUserId);
    if (!result.ok) {
      this.reportAutomation(doc, event.method, "rejected", result.error, result.trace);
      return { ok: false, error: result.error };
    }
    if ("skipped" in result) {
      this.reportAutomation(doc, event.method, "skipped", result.skipped, result.trace);
      return { ok: true, stopOthers: false };
    }
    const prepared: PreparedFx[] = [];
    for (const cue of result.plan.cues) {
      const gm: SessionUser = { id: this.systemUserId, name: "Automation", role: "GM" };
      const ready = this.prepareFx(gm, {
        macroId: cue.macroId, sceneId: event.scene._id,
        ...(cue.sourceTokenId ? { sourceTokenId: cue.sourceTokenId } : {}),
        ...(cue.targetTokenId ? { targetTokenId: cue.targetTokenId } : {}),
      }, cue.audience);
      if (!ready.ok) {
        const error = `FX preflight failed: ${ready.error}`;
        this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
        return { ok: false, error };
      }
      prepared.push(ready);
    }
    // Both reviewed scripts and GM-authored summon preset IDs are resolved by
    // the host, in authored order. No player request names a graph or source
    // actor. Preflight the complete list before consuming graph history.
    const postActions = result.plan.postActions;
    const actionSession = postActions.length ? [...this.sessions.values()].find((s) =>
      s.user === event.caller) : undefined;
    if (postActions.length && (this.activeMacroRuns >= 8 || !actionSession?.user)) {
      const error = "No authorized session/capacity for post-commit zone actions";
      this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
      return { ok: false, error };
    }
    const view = result.plan.scripts.length ?
      projectWorld(this.store.world, this.store.seq, event.caller).collections.scenes
        ?.find((item) => item._id === event.scene._id) : undefined;
    const approvedSummons = new Map<object, string>();
    for (const action of postActions) {
      if (action.kind === "script") {
        // A player-triggered zone cannot grant access to unpublished scripts.
        const macro = this.store.get("macros", action.macroId) as MacroDocument | undefined;
        const checked = macro?.kind === "script" ? validateScriptMacro(macro) : null;
        const validated = checked?.ok ? validateScriptArgs(action.args, checked.policy,
          (id) => !!view?.tokens.some((t) => t._id === id)) : null;
        if (!macro || !checked?.ok || checked.policy.sceneId !== event.scene._id ||
            !can(event.caller, "read", macro, "macros") ||
            ((event.caller.role !== "GM" && event.caller.role !== "ASSISTANT") && !checked.policy.playerCallable) ||
            !validated?.ok) {
          const error = `Reviewed script ${action.macroId} unavailable or inputs not authorized`;
          this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
          return { ok: false, error };
        }
        const { approvedHash, ...reviewed } = checked.policy;
        if (scriptApprovalHashSync(macro.command, reviewed) !== approvedHash) {
          const error = `Reviewed script ${action.macroId} changed since GM approval`;
          this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
          return { ok: false, error };
        }
      } else {
        // The saved graph is the GM's exact preset approval. This is NOT a
        // generic player grant to enumerate private actors or summon by ID.
        const preset = this.store.get("macros", action.presetId) as MacroDocument | undefined;
        const checked = preset?.kind === "summon" ? validateSummon(preset.summon) : null;
        const summoner = event.scene.tokens.find((t) => t._id === action.summonerTokenId);
        const gm = event.caller.role === "GM" || event.caller.role === "ASSISTANT";
        const placementError = checked?.ok ? summonPlacementError(event.scene, checked.definition,
          action.at, summoner, !gm) : "invalid summon preset";
        if (!checked?.ok || checked.definition.sceneId !== event.scene._id ||
            (checked.definition.source.kind === "world" &&
              !this.store.get("actors", checked.definition.source.actorId)) ||
            (!gm && (!summoner || !can(event.caller, "update", summoner, "tokens", { parent: event.scene }) ||
              !docVisibleTo(event.caller, summoner, event.scene))) || placementError) {
          const error = `Summon [${action.stepId}] preset, caster or placement unavailable`;
          this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
          return { ok: false, error };
        }
        approvedSummons.set(action, JSON.stringify(checked.definition));
      }
    }
    const summonsQueued = postActions.filter((a) => a.kind === "summon").length;
    if (dryRun) {
      this.reportAutomation(doc, event.method, "skipped",
        `dry-run: ${result.plan.ops.length} ops, ${prepared.length} cues, ${result.plan.scripts.length} reviewed scripts (not executed), ${summonsQueued} summons (not executed)`, result.plan.trace);
      return { ok: true, stopOthers: false };
    }
    // A graph may intentionally activate/deactivate its own gate in this
    // envelope. Post-commit reviewed actions must pin the *resulting* approved
    // definition, not treat that authored change as an external edit.
    const approvedRootDefinition = result.plan.ops.reduce((expected, op) =>
      op.kind === "update" && op.ref.coll === "automations" && op.ref.id === doc._id &&
      op.diff.definition !== undefined ? JSON.stringify(op.diff.definition) : expected,
    JSON.stringify(doc.definition));
    const audit = this.newActionAudit(`Active zone: ${doc.name} (${event.method})`, postActions.length > 0);
    const committed = this.commitOps(result.plan.ops, this.systemUserId,
      `zone-${randomId()}`, true, audit);
    if (!committed.ok) {
      this.reportAutomation(doc, event.method, "rejected", committed.error, result.plan.trace);
      return { ok: false, error: committed.error };
    }
    if (postActions.length) this.activeActionReceipts.add(audit.id);
    const fxFailed = prepared.filter((fx) => !this.emitPreparedFx(fx)).length;
    this.reportAutomation(doc, event.method, fxFailed ? "post-commit-failed" : "committed",
      fxFailed ? `${fxFailed} persistent FX could not be committed; graph state was not rolled back` :
        `${result.plan.ops.length} ops, ${prepared.length} cues, ${postActions.length} post-commit actions queued`,
      result.plan.trace, committed.seq);
    const actionCaller = actionSession?.user;
    if (actionCaller && actionSession && postActions.length) {
      this.activeMacroRuns++;
      // External source resolution and Worker RPCs cannot be folded into an
      // atomic graph transaction. Execute in graph order with one bounded
      // budget; failed actions send only GM diagnostics, not player secrets.
      void (async () => {
        const trace = [...result.plan.trace];
        let outcome: "completed" | "partial" = "completed";
        const deadline = Date.now() + 30_000;
        const budget = { calls: 0 };
        let currentKind: "script" | "summon" = "script";
        const graphLive = () => Date.now() < deadline &&
          this.store.get("actionReceipts", audit.id)?.status === "pending" &&
          this.sessions.get(actionSession.peerId) === actionSession && actionSession.user === actionCaller &&
          JSON.stringify((this.store.get("automations", doc._id) as AutomationDocument | undefined)?.definition) ===
            approvedRootDefinition;
        try {
          for (const [i, action] of postActions.entries()) {
            currentKind = action.kind;
            if (!graphLive()) throw new Error("Zone changed or caller disconnected after graph commit");
            if (action.kind === "script") {
              const ctx: ScriptInvocation = { session: actionSession, caller: actionCaller,
                requestId: `zone-${committed.seq}-${i}`, deadline, budget, trace: [], audit };
              try {
                await this.executeScript(action.macroId, action.args, ctx, "", [], graphLive);
                trace.push(`reviewed script [${action.stepId}] completed`);
              } finally { trace.push(...ctx.trace); }
              continue;
            }
            let active = true;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expired = new Promise<{ ok: false; error: string }>((resolve) => {
              timer = setTimeout(() => { active = false; resolve({ ok: false, error: "Summon source resolution timed out" }); },
                Math.max(1, Math.min(10_000, deadline - Date.now())));
            });
            const approved = approvedSummons.get(action);
            try {
              const placed = await Promise.race([this.commitSummonFromPreset({
                session: actionSession, caller: actionCaller, presetId: action.presetId,
                sceneId: event.scene._id, at: action.at,
                ...(action.summonerTokenId ? { summonerTokenId: action.summonerTokenId } : {}),
                txId: `zone-summon-${committed.seq}-${i}`, asReviewedGM: true, audit,
                isActive: () => active && graphLive() &&
                  JSON.stringify((this.store.get("macros", action.presetId) as MacroDocument | undefined)?.summon) === approved,
              }), expired]);
              if (!placed.ok) throw new Error(placed.error);
              trace.push(`summon [${action.stepId}] placed token ${placed.tokenId} at seq ${placed.seq}`);
            } finally { active = false; if (timer) clearTimeout(timer); }
          }
          this.reportAutomation(doc, event.method, "committed",
            summonsQueued ? `${postActions.length} post-commit actions completed` :
              `${postActions.length} post-commit scripts completed`, trace, committed.seq);
        } catch (cause) {
          outcome = "partial";
          trace.push(`POST-COMMIT ${currentKind.toUpperCase()} FAILED: ${cause instanceof Error ? cause.message : "unknown error"}`);
          this.reportAutomation(doc, event.method, "post-commit-failed",
            currentKind === "script" ? "Script failed after the graph committed; graph state was not rolled back" :
              "Summon failed after the graph committed; graph state was not rolled back", trace, committed.seq);
        } finally {
          this.finishActionAudit(audit, outcome);
          this.activeMacroRuns--;
        }
      })();
    } else if (postActions.length) {
      this.finishActionAudit(audit, "partial");
    }
    return { ok: true, stopOthers: result.plan.stopOthers };
  }

  // ─── Macros / FX Wizard: approved, recipient-projected timeline ─────────────

  private readonly seenFxRequests = new Map<string, number>();
  /** Per-session delivery ledger: revocation/end is sent only to past recipients. */
  private readonly fxViewers = new Map<string, { sceneId: string; peers: Set<string> }>();
  private static readonly FX_LEAD_MS = 300;
  /** How many runs' worth of media expectations the host remembers (oldest evicted). */
  private static readonly FX_MEDIA_RUNS = 32;
  /** The shortest wait for viewer answers: a cue with everything due at once still gets this. */
  private static readonly FX_MEDIA_MIN_WINDOW_MS = 4_000;
  /** The longest: beyond a minute a "report" describes a cue nobody is watching any more. */
  private static readonly FX_MEDIA_MAX_WINDOW_MS = 60_000;
  /** After the first line, how long a changed answer may still produce *one* correction. */
  private static readonly FX_MEDIA_CORRECTION_MS = 20_000;

  private handleFxRequest(session: Session, msg: FxRequestMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "FX requests rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId)) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid FX request");
      return;
    }
    const key = `${caller.id}:${msg.requestId}`;
    if (this.seenFxRequests.has(key)) return;
    const prepared = this.prepareFx(caller, msg);
    if (!prepared.ok) {
      this.reject(session, msg.requestId, prepared.reason, prepared.error);
      return;
    }
    const sentTo: Session[] = [];
    if (!this.emitPreparedFx(prepared, sentTo)) {
      this.reject(session, msg.requestId, "invariant", "FX instance could not be committed");
      return;
    }
    // D-308/SQ-13: the preflight line above says who was *entitled*. This opens the
    // second half — the viewers' own answer about the bytes — for a GM/assistant
    // requester whose cue actually used media. A player-initiated request gets no
    // report, for the same reason it gets no preflight line: the counts describe
    // other sessions.
    if (caller.role === "GM" || caller.role === "ASSISTANT")
      this.openFxMediaReceipt(session, msg.requestId, prepared, sentTo);
    // SQ-13/D-303: tell the requester when the cue reached fewer viewers than the scene
    // has — or when it reached them with a section withheld. Sent only to the caller's own
    // session, and only counts leave this method.
    const skippedTotal = Object.values(prepared.skipped).reduce((a, b) => a + b, 0);
    const { targeted, empty } = prepared.targeting;
    if ((skippedTotal > 0 || targeted > 0 || empty > 0) &&
        (caller.role === "GM" || caller.role === "ASSISTANT")) {
      this.send(session, { kind: "fx.delivery", requestId: String(msg.requestId),
        runId: prepared.cue.runId, macroId: prepared.cue.macroId,
        recipients: prepared.recipients.length, skipped: prepared.skipped,
        ...(targeted > 0 ? { targeted } : {}), ...(empty > 0 ? { empty } : {}) });
    }
    // Register after a successful host commit/fan-out; retries cannot clone cues.
    this.seenFxRequests.set(key, this.now());
    if (this.seenFxRequests.size > 256) {
      const first = this.seenFxRequests.keys().next().value;
      if (first) this.seenFxRequests.delete(first);
    }
  }

  // ─── D-309 (SQ-09): where the listener is, and what stands in the way ──────
  //
  // A positional sound's distance is a client's own arithmetic — it knows where it is
  // listening from — but the *walls* are the host's, and a client is never handed them
  // (D-301/D-307). So the host answers the occlusion question per recipient and bakes the
  // answer into that recipient's cue, exactly as it bakes a trimmed mask.

  /**
   * Where a viewer hears from: the first token on this scene they own at level 3 (their
   * own character, in the world's own ownership vocabulary). A viewer with nothing of
   * their own on the map has no listening *point* the host can honestly name — their
   * camera is client-side state the host never sees — so it says nothing and the sound
   * plays at its distance gain only.
   */
  private fxListener(scene: SceneDocument, userId: string): { x: number; y: number } | null {
    for (const token of scene.tokens) {
      if ((token.ownership?.[userId] ?? 0) >= 3) return { x: token.x, y: token.y };
    }
    return null;
  }

  /** Mark the sound sections a wall stands between this listener and. Returns the input
   * array unchanged when there is nothing to say, so the shared cue object stays shared. */
  private fxOccludedFor(scene: SceneDocument, sections: readonly ResolvedFxSection[],
    userId: string): readonly ResolvedFxSection[] {
    const positioned = sections.some((section) => section.kind === "sound" && section.muffle === true &&
      typeof section.x === "number" && typeof section.y === "number");
    if (!positioned) return sections;
    const listener = this.fxListener(scene, userId);
    if (!listener) return sections;
    const walls = soundSegments(scene.walls ?? []);
    if (walls.length === 0) return sections;
    let changed = false;
    const out = sections.map((section) => {
      if (section.kind !== "sound" || section.muffle !== true ||
          typeof section.x !== "number" || typeof section.y !== "number") return section;
      const source = { x: section.x, y: section.y };
      const blocked = walls.some((wall) => segmentsCross(listener, source,
        { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }));
      if (!blocked) return section;
      changed = true;
      return { ...section, occluded: true };
    });
    return changed ? out : sections;
  }

  // ─── D-308 (SQ-13): the media acknowledgment, host side ─────────────────────
  //
  // A cue with image/sound sections makes every entitled viewer a promise the host
  // cannot keep on their behalf: "the bytes will be there". The viewers answer through
  // `fx.media`, and this is where those answers become one line for the requester.

  /** Open the expectation for a run, or do nothing when there is nothing to wait for. */
  private openFxMediaReceipt(session: Session, requestId: string, prepared: PreparedFx,
    sentTo: readonly Session[]): void {
    const seen = new Map<string, { assetId: string; index: number; kind: "image" | "sound"; mime: string }>();
    prepared.cue.sections.forEach((section, index) => {
      if (section.kind !== "image" && section.kind !== "sound") return;
      if (seen.has(section.assetId)) return; // one answer per asset, not one per section
      seen.set(section.assetId, { assetId: section.assetId, index, kind: section.kind, mime: section.mime });
    });
    // No media, no viewers, or a persistent instance (which loops and is re-sent on
    // reconnect, so no single moment's answer would mean anything): no report.
    if (seen.size === 0 || sentTo.length === 0 || prepared.cue.persistent) return;
    const lastEnd = Math.max(...[...seen.values()].map((asset) => {
      const section = prepared.cue.sections[asset.index];
      return (section?.startMs ?? 0) + (section?.durationMs ?? 0);
    }));
    const window = Math.min(HostSync.FX_MEDIA_MAX_WINDOW_MS,
      Math.max(HostSync.FX_MEDIA_MIN_WINDOW_MS, lastEnd + 2_000));
    const receipt: FxMediaReceipt = { runId: prepared.cue.runId, requestId, macroId: prepared.cue.macroId,
      sceneId: prepared.cue.sceneId, requesterPeerId: session.peerId, assets: [...seen.values()],
      recipients: new Set(sentTo.map((recipient) => recipient.peerId)), acks: new Map(), fetchMs: new Map(),
      deadline: this.now() + window, reported: false, corrected: false, warnKey: "unreported" };
    this.fxMediaReceipts.set(receipt.runId, receipt);
    while (this.fxMediaReceipts.size > HostSync.FX_MEDIA_RUNS) {
      const oldest = this.fxMediaReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.fxMediaReceipts.delete(oldest);
    }
    this.scheduleFxMediaSweep();
  }

  /** One viewer's answer about one asset. Anything unexpected is ignored, not answered:
   * a session that guessed a run id must not even learn whether the run exists. */
  private handleFxMedia(session: Session, msg: FxMediaAckMsg): void {
    if (!session.user) return;
    if (typeof msg.runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.runId)) return;
    const receipt = this.fxMediaReceipts.get(msg.runId);
    if (!receipt || !receipt.recipients.has(session.peerId)) return;
    if (typeof msg.assetId !== "string" || msg.assetId.length === 0 || msg.assetId.length > 128) return;
    const asset = receipt.assets.find((entry) => entry.assetId === msg.assetId);
    if (!asset) return;
    if (msg.state !== "ready" && msg.state !== "late" && msg.state !== "failed" && msg.state !== "unsupported") return;
    const ms = typeof msg.ms === "number" && Number.isFinite(msg.ms)
      ? Math.max(0, Math.min(3_600_000, Math.round(msg.ms))) : undefined;
    const states = receipt.acks.get(session.peerId) ?? new Map<string, FxMediaAckState>();
    if (states.get(msg.assetId) === msg.state && ms === undefined) return; // nothing new to say
    states.set(msg.assetId, msg.state);
    receipt.acks.set(session.peerId, states);
    if (msg.state === "ready" && ms !== undefined) {
      const times = receipt.fetchMs.get(session.peerId) ?? new Map<string, number>();
      times.set(msg.assetId, ms);
      receipt.fetchMs.set(session.peerId, times);
    }
    // A viewer that cannot use the media is the emergency: the GM may still stop the
    // cue, so that line goes out at once rather than waiting for the window. Anything
    // that arrives *after* the first line takes the same door and lets `reportFxMedia`
    // decide whether it is a correction worth sending or merely a change of record.
    const urgent = msg.state === "failed" || msg.state === "unsupported";
    const answered = [...receipt.acks.values()].reduce((total, byAsset) => total + byAsset.size, 0);
    const settled = answered === receipt.recipients.size * receipt.assets.length;
    if (urgent || settled || receipt.reported) this.reportFxMedia(receipt);
  }

  /** One line to the requester — the first answer, and at most one correction after it. */
  private reportFxMedia(receipt: FxMediaReceipt): void {
    // The whole answer, not just its complaints: a viewer that was silent when the first
    // line went out and has since said "ready" makes that line's "have not reported yet"
    // false, and a report that stayed wrong would be worse than a late one.
    const pairs: string[] = [];
    for (const peerId of receipt.recipients) {
      const byAsset = receipt.acks.get(peerId);
      for (const asset of receipt.assets)
        pairs.push(`${peerId}:${asset.assetId}:${byAsset?.get(asset.assetId) ?? "silent"}`);
    }
    const lacking = pairs.sort().join(",");
    if (!receipt.reported) {
      receipt.reported = true;
      receipt.warnKey = lacking;
      // The answer can still change after the first line (a decode failure when the
      // section actually plays, or a fetch that recovered). Keep the receipt a while
      // longer so that change is a *correction* rather than silence.
      receipt.deadline = Math.max(receipt.deadline, this.now() + HostSync.FX_MEDIA_CORRECTION_MS);
      this.scheduleFxMediaSweep();
    } else if (receipt.corrected || lacking === receipt.warnKey) {
      return; // one correction per run, and only when the answer actually changed
    } else {
      receipt.corrected = true;
      receipt.warnKey = lacking;
    }
    const session = this.sessions.get(receipt.requesterPeerId);
    if (!session?.user) return; // the requester left; the record still stands
    const report = fxMediaReport(receipt.assets, receipt.recipients.size,
      { bySession: receipt.acks, fetchMs: receipt.fetchMs },
      { ...(receipt.corrected ? { corrected: true } : {}) });
    this.send(session, { kind: "fx.delivery", requestId: receipt.requestId, runId: receipt.runId,
      macroId: receipt.macroId, recipients: receipt.recipients.size,
      // The preflight line already carried the drops; a media follow-up repeats the
      // recipient count so the two lines can be read together, and says nothing else.
      skipped: { audience: 0, rights: 0, anchor: 0, media: 0 }, media: report });
  }

  /** Report every window that closed without a complete answer, then drop what is done. */
  private sweepFxMedia(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const [runId, receipt] of [...this.fxMediaReceipts]) {
      if (now < receipt.deadline) continue;
      if (!receipt.reported) this.reportFxMedia(receipt);
      else this.fxMediaReceipts.delete(runId);
    }
    this.scheduleFxMediaSweep();
  }

  /** One timer for the earliest window; browser timers can sleep, and a late sweep still
   * reports correctly because every deadline is an absolute host time. */
  private scheduleFxMediaSweep(): void {
    if (this.fxMediaTimer) clearTimeout(this.fxMediaTimer);
    this.fxMediaTimer = null;
    if (this.disposed) return;
    let next = Infinity;
    for (const receipt of this.fxMediaReceipts.values()) next = Math.min(next, receipt.deadline);
    if (!Number.isFinite(next)) return;
    this.fxMediaTimer = setTimeout(() => this.sweepFxMedia(),
      Math.max(0, Math.min(2_147_483_647, next - this.now())));
    (this.fxMediaTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Same host scheduler for editor/macros and triggered FX. Can NARROW a graph's audience,
   * never expand the saved macro's audience or a recipient's asset entitlement. */
  private prepareFx(
    caller: SessionUser,
    req: Pick<FxRequestMsg, "macroId" | "sceneId" | "sourceTokenId" | "targetTokenId">,
    narrowAudience?: "gm" | "scene",
    /** Reviewed GM-elevated scripts execute with GM rights but retain the invoking caller as owner/audience. */
    ownerId = caller.id,
  ): { ok: true } & PreparedFx |
     { ok: false; reason: "forbidden" | "invalid_schema"; error: string } {
    const invalid = (error: string) => ({ ok: false as const, reason: "invalid_schema" as const, error });
    const forbidden = (error: string) => ({ ok: false as const, reason: "forbidden" as const, error });
    if (typeof req.macroId !== "string" || !req.macroId ||
        typeof req.sceneId !== "string" || !req.sceneId ||
        (req.sourceTokenId !== undefined && typeof req.sourceTokenId !== "string") ||
        (req.targetTokenId !== undefined && typeof req.targetTokenId !== "string")) return invalid("invalid FX reference");
    const macro = this.store.get("macros", req.macroId) as MacroDocument | undefined;
    const scene = this.store.get("scenes", req.sceneId) as SceneDocument | undefined;
    if (!macro || macro.kind !== "sequence" || !scene || !macro.sequence)
      return invalid("sequence macro or scene missing");
    const isGm = caller.role === "GM" || caller.role === "ASSISTANT";
    // A player may invoke only a timeline that *includes them* (D-316): the old rule
    // refused a GM-audience cue, and a chosen-players cue the caller is not in is the
    // same refusal — publishing a cue is not a licence to fire it at other people.
    if (!can(caller, "read", macro, "macros") || !can(caller, "read", scene, "scenes") ||
        (!isGm && (macro.flags?.core?.playerCallable !== true ||
          !fxAudienceAllows(macro.sequence.audience, { id: caller.id, isGm }, ownerId))))
      return forbidden("FX macro is not published for this caller");
    const callerScene = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
      ?.find((s) => s._id === scene._id);
    const source = req.sourceTokenId ? scene.tokens.find((t) => t._id === req.sourceTokenId) : undefined;
    const target = req.targetTokenId ? scene.tokens.find((t) => t._id === req.targetTokenId) : undefined;
    if ((req.sourceTokenId && (!source || !callerScene?.tokens.some((t) => t._id === source._id))) ||
        (req.targetTokenId && (!target || !callerScene?.tokens.some((t) => t._id === target._id))))
      return forbidden("FX source/target is not visible to caller");
    const manifest = this.manifestSource();
    const resolved = resolveFxSequence(macro.sequence, scene, source, target, (id) => manifest[id]?.mime);
    if (!resolved.ok) return invalid(resolved.error);
    if (macro.sequence.persistent && (this.store.getAll("fxInstances").length >= 64 ||
        this.store.getAll("fxInstances").filter((entry) => entry.sceneId === scene._id).length >= 24))
      return invalid("persistent FX instance limit reached; stop an effect first");
    const cue: FxStartMsg = {
      kind: "fx.start", runId: randomId(), macroId: macro._id, sceneId: scene._id,
      atHostTime: this.now() + HostSync.FX_LEAD_MS, sections: resolved.sections,
      ...(macro.sequence.persistent ? { persistent: true } : {}),
    };
    const recipients: Session[] = [];
    // SQ-13 (A10): preflight says who will NOT get this cue. Counts are per reason so
    // the requester hears "two viewers are missing the media", not a silent drop.
    const skipped: FxDeliverySkips = { audience: 0, rights: 0, anchor: 0, media: 0 };
    // D-303: preflight also says who got a *reduced* payload (a targeted camera section,
    // D-300) and who was left with nothing, which is a different fact from a skip.
    const targeting = { targeted: 0, empty: 0 };
    // D-316: one rule for every audience form, evaluated per viewer. A caller-side
    // narrowing can only ever *narrow* what the saved macro already allows.
    const audience: FxAudience = narrowAudience === "gm" ? "gm" : macro.sequence.audience ?? "scene";
    for (const viewer of this.sessions.values()) {
      const user = viewer.user;
      if (!user) continue;
      const asViewer = { id: user.id, isGm: user.role === "GM" || user.role === "ASSISTANT" };
      if (!fxAudienceAllows(audience, asViewer, ownerId)) { skipped.audience++; continue; }
      if (!can(user, "read", macro, "macros") || !can(user, "read", scene, "scenes")) { skipped.rights++; continue; }
      const visibleScene = projectWorld(this.store.world, this.store.seq, user).collections.scenes
        ?.find((s) => s._id === scene._id);
      if (!visibleScene || (source && !visibleScene.tokens.some((t) => t._id === source._id)) ||
          (target && !visibleScene.tokens.some((t) => t._id === target._id))) { skipped.anchor++; continue; }
      const available = projectAssetManifest(this.store.world, manifest, user);
      if (resolved.sections.some((step) =>
        (step.kind === "image" || step.kind === "sound") && !available[step.assetId])) { skipped.media++; continue; }
      // Would this viewer receive the whole run? Targeting is decided by the author's
      // audiences, not by a document change, so it is settled here rather than later.
      const entitled = fxSectionsForViewer(resolved.sections, asViewer, ownerId);
      if (entitled.length === 0) { targeting.empty++; continue; }
      if (entitled.length < resolved.sections.length) targeting.targeted++;
      recipients.push(viewer);
    }
    return { ok: true, cue, recipients, callerId: ownerId, skipped, targeting,
      audience,
      checkedAtSeq: this.store.seq,
      ...(source ? { sourceTokenId: source._id } : {}),
      ...(target ? { targetTokenId: target._id } : {}) };
  }

  private emitPreparedFx(prepared: PreparedFx, sentTo?: Session[]): boolean {
    if (prepared.cue.persistent) {
      const macro = this.store.get("macros", prepared.cue.macroId) as MacroDocument | undefined;
      const scene = this.store.get("scenes", prepared.cue.sceneId) as SceneDocument | undefined;
      if (!macro || macro.kind !== "sequence" || !macro.sequence?.persistent || !scene ||
          this.store.getAll("fxInstances").length >= 64) return false;
      const doc: FxInstanceDocument = { _id: prepared.cue.runId, type: "fxInstance", name: macro.name,
        ownership: { default: 0 }, flags: {}, system: {}, sceneId: scene._id, macroId: macro._id,
        ownerId: prepared.callerId, audience: prepared.audience,
        atHostTime: prepared.cue.atHostTime, sections: prepared.cue.sections,
        ...(prepared.sourceTokenId ? { sourceTokenId: prepared.sourceTokenId } : {}),
        ...(prepared.targetTokenId ? { targetTokenId: prepared.targetTokenId } : {}) };
      if (!validateFxInstance(doc, scene, this.manifestSource())) return false;
      // Broadcast projects the private document to GMs, then separately sends
      // entitled viewers a resolved cue. Both happen after the durable commit.
      return this.commitSystem([{ kind: "create", coll: "fxInstances", data: doc }], true).ok;
    }
    // A graph preflights FX before the mechanical envelope, then sends it after
    // commit. That envelope can HIDE the FX's source/target or revoke its asset:
    // never deliver an old entitlement/anchor just because it was valid earlier.
    const changed = prepared.checkedAtSeq !== this.store.seq;
    const scene = changed ? this.store.get("scenes", prepared.cue.sceneId) as SceneDocument | undefined : undefined;
    // D-309: occlusion is *per recipient*, so the scene is needed even when nothing
    // changed since the preflight — a cue's walls are the host's to know, not the client's.
    const hostScene = scene ?? this.store.get("scenes", prepared.cue.sceneId) as SceneDocument | undefined;
    const macro = changed ? this.store.get("macros", prepared.cue.macroId) as MacroDocument | undefined : undefined;
    const manifest = changed ? this.manifestSource() : undefined;
    for (const recipient of prepared.recipients) {
      const user = recipient.user;
      if (this.sessions.get(recipient.peerId) !== recipient || !user) continue;
      if (changed) {
        if (!scene || !macro || macro.kind !== "sequence" || !macro.sequence || !manifest ||
            !can(user, "read", macro, "macros") || !can(user, "read", scene, "scenes")) continue;
        // The macro may have been edited between preflight and commit, so the CURRENT
        // audience decides; a forced GM narrowing survives the re-read.
        const current: FxAudience = prepared.audience === "gm" ? "gm" : macro.sequence.audience ?? "scene";
        if (!fxAudienceAllows(current, { id: user.id, isGm: user.role === "GM" || user.role === "ASSISTANT" },
          prepared.callerId)) continue;
        const view = projectWorld(this.store.world, this.store.seq, user).collections.scenes
          ?.find((s) => s._id === scene._id);
        if (!view || (prepared.sourceTokenId && !view.tokens.some((t) => t._id === prepared.sourceTokenId)) ||
            (prepared.targetTokenId && !view.tokens.some((t) => t._id === prepared.targetTokenId))) continue;
        const available = projectAssetManifest(this.store.world, manifest, user);
        if (prepared.cue.sections.some((step) =>
          (step.kind === "image" || step.kind === "sound") && !available[step.assetId])) continue;
      }
      // SQ-15/D-300: a camera section can be targeted, so the payload is built per
      // recipient. A viewer excluded from every section of a run receives nothing at
      // all rather than an empty cue they would have to reason about.
      const entitled = fxSectionsForViewer(prepared.cue.sections,
        { id: user.id, isGm: user.role === "GM" || user.role === "ASSISTANT" }, prepared.callerId);
      if (entitled.length === 0) continue;
      // D-316: the audience is the host's business and does not travel. A recipient of a
      // chosen-players section would otherwise read the whole list out of their own
      // payload — the membership query SQ-18 keeps out of socket traffic, one hop in.
      const forViewer = hostWithoutAudience(entitled);
      sentTo?.push(recipient);
      const forSound = hostScene ? this.fxOccludedFor(hostScene, forViewer, user.id) : forViewer;
      const shared = forViewer === prepared.cue.sections && forSound === forViewer;
      this.send(recipient, shared ? prepared.cue : { ...prepared.cue, sections: [...forSound] });
    }
    return true;
  }

  /** Permission and asset rights are checked against COMMITTED state every time
   * an instance is replayed or an existing viewer's entitlement may have moved. */
  private canViewFxInstance(session: Session, doc: FxInstanceDocument, manifest: AssetManifest): boolean {
    const user = session.user;
    if (!user) return false;
    const scene = this.store.get("scenes", doc.sceneId) as SceneDocument | undefined;
    const macro = this.store.get("macros", doc.macroId) as MacroDocument | undefined;
    if (!scene || !macro || macro.kind !== "sequence" || !macro.sequence ||
        !validateFxInstance(doc, scene, manifest) ||
        !can(user, "read", scene, "scenes") || !can(user, "read", macro, "macros")) return false;
    // Both the record's own audience and the timeline's must include this viewer: either
    // one narrowing is enough to keep a stored instance out of a client's reach.
    const asViewer = { id: user.id, isGm: user.role === "GM" || user.role === "ASSISTANT" };
    if (!fxAudienceAllows(doc.audience, asViewer, doc.ownerId) ||
        !fxAudienceAllows(macro.sequence.audience, asViewer, doc.ownerId)) return false;
    // `playerCallable` gates who may *request* playback, not who may see a GM's
    // scene-audience cue. Keep the same recipient policy as one-shot sequences.
    const view = projectWorld(this.store.world, this.store.seq, user).collections.scenes
      ?.find((s) => s._id === scene._id);
    if (!view || (doc.sourceTokenId && !view.tokens.some((t) => t._id === doc.sourceTokenId)) ||
        (doc.targetTokenId && !view.tokens.some((t) => t._id === doc.targetTokenId))) return false;
    const available = projectAssetManifest(this.store.world, manifest, user);
    return doc.sections.every((section) =>
      (section.kind !== "image" && section.kind !== "sound") || available[section.assetId] !== undefined);
  }

  private fxCue(doc: FxInstanceDocument, userId?: string): FxStartMsg {
    // D-309: a *loop* is where per-recipient occlusion matters most — one hum heard
    // through a door on this side of the map and muffled on the other — so a stored
    // instance's cue is built per recipient too, and recomputed on reconnect.
    const scene = userId ? this.store.get("scenes", doc.sceneId) as SceneDocument | undefined : undefined;
    const sections = scene && userId ? this.fxOccludedFor(scene, doc.sections, userId) : doc.sections;
    return { kind: "fx.start", runId: doc._id, macroId: doc.macroId,
      sceneId: doc.sceneId, atHostTime: doc.atHostTime, persistent: true,
      sections: [...sections] };
  }

  /** Reconcile past recipients after *every* committed operation: hiding a
   * source, deleting a macro, revoking a media reference or changing ownership
   * cannot leave a private aura playing in someone else's client. */
  private reconcileFxInstances(): void {
    if (!this.fxViewers.size && !this.store.getAll("fxInstances").length) return;
    const manifest = this.manifestSource();
    const instances = new Map(this.store.getAll("fxInstances").map((doc) => [doc._id, doc]));
    for (const [id, viewers] of this.fxViewers) {
      if (instances.has(id)) continue;
      for (const peerId of viewers.peers) {
        const session = this.sessions.get(peerId);
        if (session?.user) this.send(session, { kind: "fx.end", runId: id, sceneId: viewers.sceneId });
      }
      this.fxViewers.delete(id);
    }
    for (const doc of instances.values()) {
      const state = this.fxViewers.get(doc._id) ?? { sceneId: doc.sceneId, peers: new Set<string>() };
      for (const session of this.sessions.values()) {
        const eligible = this.canViewFxInstance(session, doc, manifest);
        const wasSent = state.peers.has(session.peerId);
        if (eligible && !wasSent) {
          this.send(session, this.fxCue(doc, session.user?.id));
          state.peers.add(session.peerId);
        } else if (!eligible && wasSent) {
          this.send(session, { kind: "fx.end", runId: doc._id, sceneId: doc.sceneId });
          state.peers.delete(session.peerId);
        }
      }
      if (state.peers.size) this.fxViewers.set(doc._id, state);
      else this.fxViewers.delete(doc._id);
    }
  }

  /** A client re-entering a scene (or restarting after a snapshot) explicitly
   * asks for its own live playback state. No private records or other users'
   * names/asset paths ride on the response. */
  private handleFxSync(session: Session, sceneId: string): void {
    if (!session.user || !session.intentBucket.tryRemove() || typeof sceneId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(sceneId)) return;
    const manifest = this.manifestSource();
    for (const doc of this.store.getAll("fxInstances")) {
      if (doc.sceneId !== sceneId || !this.canViewFxInstance(session, doc, manifest)) continue;
      this.send(session, this.fxCue(doc, session.user.id));
      const state = this.fxViewers.get(doc._id) ?? { sceneId, peers: new Set<string>() };
      state.peers.add(session.peerId);
      this.fxViewers.set(doc._id, state);
    }
  }

  /** The Live FX manager uses the same bounded matching semantics as reviewed
   * scripts, but a player cannot submit arbitrary search patterns to enumerate
   * or end other people's private instances. The current host scene and matches
   * are recomputed at dispatch; the browser's preview list is never authority. */
  private handleFxStopMatching(session: Session, msg: FxStopMatchingMsg): void {
    const user = session.user;
    if (!user) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "FX requests rate-limited");
      return;
    }
    if (user.role !== "GM" && user.role !== "ASSISTANT") {
      this.reject(session, String(msg.requestId), "forbidden", "FX manager unavailable");
      return;
    }
    const requestId = msg.requestId;
    const checked = validateFxInstanceFilter(msg.filter, true);
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        typeof msg.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.sceneId) ||
        Object.keys(msg).length !== 4 || !checked.ok) {
      this.reject(session, String(requestId), "invalid_schema", "invalid FX stop filter");
      return;
    }
    const scene = this.store.get("scenes", msg.sceneId);
    if (!scene) {
      this.reject(session, requestId, "forbidden", "FX scene unavailable");
      return;
    }
    const manifest = this.manifestSource();
    const matches = this.store.getAll("fxInstances").filter((doc) =>
      doc.sceneId === scene._id && fxInstanceMatches(doc, checked.filter) &&
        validateFxInstance(doc, scene, manifest));
    if (matches.length > 16) {
      this.reject(session, requestId, "invalid_schema", "FX stop matches over 16 instances; narrow the selector");
      return;
    }
    if (!matches.length) return;
    const stopped = this.commitOps(matches.map((doc) => ({ kind: "delete" as const,
      ref: { coll: "fxInstances" as const, id: doc._id } })),
    this.systemUserId, `fx-stop-matching-${requestId}`);
    if (!stopped.ok) this.reject(session, requestId, "invariant", "FX instances could not be stopped");
  }

  private handleFxStop(session: Session, msg: FxStopMsg): void {
    const user = session.user;
    if (!user) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "FX requests rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.instanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.instanceId) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "instanceId"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid FX stop request");
      return;
    }
    const doc = this.store.get("fxInstances", msg.instanceId);
    if (!doc || (user.role !== "GM" && user.role !== "ASSISTANT" && doc.ownerId !== user.id)) {
      this.reject(session, msg.requestId, "forbidden", "FX instance unavailable");
      return;
    }
    const stopped = this.commitOps([{ kind: "delete", ref: { coll: "fxInstances", id: doc._id } }],
      this.systemUserId, `fx-stop-${msg.requestId}`);
    if (!stopped.ok) this.reject(session, msg.requestId, "invariant", "FX instance could not be stopped");
  }

  // ─── Assets (§7) ─────────────────────────────────────────────────────────────

  private handleAssetGet(session: Session, msg: AssetGetMsg): void {
    if (!session.user) return; // requires an approved session (§16)
    if (!session.assetBucket.tryRemove()) return; // §16: silently dropped
    if (!this.transfer) return; // no asset server wired (unit: assets)
    if (!canFetchAsset(this.store.world, this.manifestSource(), session.user, msg.assetId)) {
      // Same miss sentinel as an unknown asset: a guessed hash gives no
      // existence oracle, and the fetcher's promise can terminate.
      this.send(session, { kind: "asset.chunk", assetId: msg.assetId,
        offset: 0, total: 0, bytes: new Uint8Array(0), done: true });
      return;
    }
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
      this.reject(
        session,
        msg.rollId,
        "invalid_schema",
        `bad formula: ${msg.formula}`,
      );
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
        flavor: msg.flavor,
        commit: msg.commit,
        seedHost,
        ts: this.now(),
      });
      this.send(session, {
        kind: "roll.challenge",
        rollId: msg.rollId,
        seedHost,
      });
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
      whisper:
        msg.mode === "gmroll" || msg.mode === "blindroll" ? [] : (msg.to ?? []),
      roll: {
        formula: msg.formula,
        total: evaluation.value.total,
        terms: evaluation.value.terms,
        seedClient: null,
        seedHost: null,
      },
      rollMode: msg.mode,
      // A06: an optional breakdown line ("+10 = BAB 6 + Str +3") rides the roll.
      flavor: typeof msg.flavor === "string" ? msg.flavor.slice(0, 300) : "",
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
      flavor: string | undefined;
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
      this.reject(
        session,
        msg.rollId,
        "invalid_schema",
        "no pending committed roll",
      );
      return;
    }
    this.pendingRolls.delete(msg.rollId);
    void (async () => {
      if ((await sha256Hex(msg.seedClient)) !== pending.commit) {
        this.reject(
          session,
          msg.rollId,
          "invalid_schema",
          "commit-reveal: commitment mismatch",
        );
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
        whisper:
          pending.mode === "gmroll" || pending.mode === "blindroll"
            ? []
            : (pending.to ?? []),
        roll: {
          formula: pending.formula,
          total: evaluation.value.total,
          terms: evaluation.value.terms,
          seedClient: msg.seedClient,
          seedHost: pending.seedHost,
          commit: pending.commit,
        },
        rollMode: pending.mode,
        flavor:
          typeof pending.flavor === "string"
            ? pending.flavor.slice(0, 300)
            : "",
      };
      this.commitOps(
        [{ kind: "create", coll: "messages", data: message }],
        session.user?.id ?? this.systemUserId,
        `roll-${msg.rollId}`,
        false,
      );
    })();
  }

  // ─── F03 pending roll (roll.pending 0x33) ───────────────────────────────────

  /**
   * The F01/F03 2-round window clock: the highest live encounter round
   * (CombatDocument.round). No combat yet → 0, so cards authored pre-combat
   * stay inside their window until the table starts advancing rounds.
   */
  private currentTurnNumber(): number {
    return tacticalLedgerTurn(
      this.store.getAll("combats") as unknown as readonly { round?: unknown }[],
    );
  }

  private async handleRollPending(
    session: Session,
    msg: import("../core/messages").RollPendingMsg,
  ): Promise<void> {
    if (!session.user) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "not authenticated",
      );
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(
        session,
        String(msg.messageId),
        "rate_limited",
        "roll rate exceeded",
      );
      return;
    }
    const doc = this.store.get("messages", String(msg.messageId)) as unknown as
      MessageDocument | undefined;
    if (!doc) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "pending card not found",
      );
      return;
    }
    const pending = (
      doc.system as unknown as { pendingRoll?: PendingRoll } | undefined
    )?.pendingRoll;
    if (!pending) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "no pendingRoll on that message",
      );
      return;
    }
    if (pending.resolved) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "pending already resolved",
      );
      return;
    }
    const currentTurn = this.currentTurnNumber();
    if (isPendingExpired(pending, currentTurn)) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "pending expired — window closed (2 rounds)",
      );
      return;
    }
    const isGM = session.user.role === "GM";
    // Roller is initiator for attacks (AoO) and target for saves/checks/concentration.
    const rollerId =
      pending.kind === "attack"
        ? pending.initiator.actorId
        : pending.target.actorId;
    const rollerActor = this.store.get("actors", rollerId) as unknown as
      { ownership?: Record<string, number> } | undefined;
    const ownership = rollerActor?.ownership ?? null;
    let isOwner = false;
    if (ownership && typeof ownership === "object") {
      const lvl = (ownership as Record<string, number>)[session.user.id];
      if (typeof lvl === "number" && lvl >= 1) isOwner = true;
    }
    if (!isOwner && !isGM) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "you do not own this pending roll",
      );
      return;
    }
    // Validate shouldDefer predicate (mode + strategic gate). The card's existence
    // already implies it was deferred, but the host re-checks so a forged
    // manual save cannot be resolved when the world is in auto mode.
    try {
      const settingsDocs = this.store.getAll("settings");
      const worldSettings = worldSettingsFrom(settingsDocs);
      const targetIsPlayerOwned = (() => {
        if (!ownership) return false;
        for (const [key, lvl] of Object.entries(
          ownership as Record<string, number>,
        )) {
          if (key === "default") continue;
          if (typeof lvl === "number" && lvl >= 1) return true;
        }
        return false;
      })();
      const isStrategic = false; // tactical only — strategic never creates pending cards (F02)
      const should = shouldDeferToPlayer({
        kind: pending.kind,
        targetIsPlayerOwned,
        worldSettings,
        isStrategic,
      });
      // If the world is auto, pending should not have existed — refuse unless GM.
      if (!should && !isGM) {
        this.reject(
          session,
          String(msg.messageId),
          "forbidden",
          "that reaction is not pending in this world's mode",
        );
        return;
      }
    } catch {
      // A malformed settings document never blocks resolution: the 2-round
      // window and the ownership check above are the real gates.
    }
    if (msg.seedClientCommit) {
      const calc = await sha256Hex(msg.seedClient);
      if (calc !== msg.seedClientCommit) {
        this.reject(
          session,
          String(msg.messageId),
          "invalid_schema",
          "commit-reveal: commitment mismatch",
        );
        return;
      }
    }
    if (!validateFormula(pending.formula).ok) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        `bad formula: ${pending.formula}`,
      );
      return;
    }
    const seedHost = randomSeedHex();
    const evaluation = await evaluateCommitRoll(
      pending.formula,
      msg.seedClient,
      seedHost,
      undefined,
    );
    if (!evaluation.ok) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        evaluation.error,
      );
      return;
    }
    const total = evaluation.value.total;
    const updated: PendingRoll = resolvePendingRollDoc(pending, {
      total,
      seedClient: msg.seedClient,
      seedHost,
    });
    // follow-up message (public narrative — same shape ChatPanel used to synthesize locally)
    const followUp: MessageDocument = {
      _id: randomId(),
      type: "message",
      name: `${pending.target.name} ${pending.kind}`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: {},
      system: {},
      author: session.user.id,
      content: `${pending.target.name} rolled ${String(total)} vs ${pending.dc !== null ? `DC ${pending.dc}` : "—"} — ${
        pending.dc !== null && total >= pending.dc
          ? "Success"
          : pending.dc !== null && total < pending.dc
            ? "Failure"
            : "rolled"
      } (${pending.formula})`,
      whisper: [],
      roll: null,
      flavor: "",
      rollMode: pending.rollMode,
    };
    // also post a rolled message for the dice log (so [[total|formula]] chips can be read)
    const rollMessage: MessageDocument = {
      _id: randomId(),
      type: "message",
      name: pending.formula,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { rollId: String(msg.messageId) } },
      system: {},
      author: session.user.id,
      content: pending.formula,
      // Roll content stays visible per rollMode projection downstream; whisper
      // redaction is handled by the existing message projection, not here.
      whisper: [],
      roll: {
        formula: pending.formula,
        total,
        terms: evaluation.value.terms,
        seedClient: msg.seedClient,
        seedHost,
        ...(msg.seedClientCommit ? { commit: msg.seedClientCommit } : {}),
      },
      rollMode: pending.rollMode,
      flavor: pending.initiator.actionLabel.slice(0, 300),
    };
    const ops: Op[] = [
      {
        kind: "update",
        ref: { coll: "messages", id: String(msg.messageId) },
        diff: { "system.pendingRoll": updated as unknown as Json } as Record<
          string,
          Json
        >,
      },
      { kind: "create", coll: "messages", data: rollMessage },
      { kind: "create", coll: "messages", data: followUp },
    ];
    const committed = this.commitOps(
      ops,
      session.user.id,
      `pending-${String(msg.messageId)}`,
      false,
    );
    if (!committed.ok) {
      this.reject(session, String(msg.messageId), "invariant", committed.error);
    }
  }

  // ─── F01 roll ledger (0x30-0x32) — host-evaluated, 2-round window, can(update) on touched docs ──

  private canUpdateAllLedgerDocs(
    user: SessionUser,
    ledger: RollLedger,
  ): boolean {
    if (user.role === "GM") return true;
    const ops = [...ledger.ledgerOps, ...ledger.ledgerInverses];
    for (const op of ops) {
      let ref: DocRef | null = null;
      if (op.kind === "update" || op.kind === "delete") ref = op.ref;
      else if (op.kind === "create") {
        const id = (op.data as { _id?: unknown })._id;
        if (typeof id === "string")
          ref = {
            coll: op.coll,
            id,
            ...(op.parent !== undefined ? { parent: op.parent } : {}),
          };
      }
      if (ref === null) continue;
      const doc = this.store.resolve(ref);
      if (!doc) continue;
      const parent =
        ref.parent !== undefined ? this.store.resolve(ref.parent) : undefined;
      if (!can(user, "update", doc, ref.coll, parent ? { parent } : {}))
        return false;
    }
    return true;
  }

  /**
   * Re-roll every formula on the card with the host's turn RNG. Seeds are
   * cleared (not commit-reveal — a GM-table reroll), so the audit trail never
   * shows a seed pair that cannot reproduce the recorded total.
   */
  private freshRollsWithRng(ledger: RollLedger): RollLedgerRoll[] {
    return ledger.rolls.map((roll) => {
      const evalResult = evaluateFormula(roll.formula, undefined, this.rng);
      if (!evalResult.ok) return { ...roll, seedClient: null, seedHost: null };
      return {
        ...roll,
        total: evalResult.value.total,
        terms: evalResult.value.terms as unknown as typeof roll.terms,
        seedClient: null,
        seedHost: null,
      };
    });
  }

  /** System-line message shared by reroll/revert follow-ups (public audit). */
  private ledgerFollowUp(
    authorId: UserId,
    name: string,
    content: string,
  ): MessageDocument {
    return {
      _id: randomId(),
      type: "message",
      name,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: {},
      system: {},
      author: authorId,
      content,
      whisper: [],
      roll: null,
      flavor: "",
    };
  }

  private async handleRollReroll(
    session: Session,
    msg: import("../core/messages").RollRerollMsg,
  ): Promise<void> {
    if (!session.user) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "not authenticated",
      );
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(
        session,
        String(msg.messageId),
        "rate_limited",
        "reroll rate exceeded",
      );
      return;
    }
    const doc = this.store.get("messages", String(msg.messageId)) as unknown as
      MessageDocument | undefined;
    if (!doc) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "ledger card not found",
      );
      return;
    }
    const ledger = (
      doc.system as unknown as { rollLedger?: RollLedger } | undefined
    )?.rollLedger;
    if (!ledger) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "no rollLedger on that message",
      );
      return;
    }
    const currentTurn = this.currentTurnNumber();
    const isGM = session.user.role === "GM";
    const viaDelegation =
      !isGM && canLedgerPlayerReroll(ledger, session.user.id, currentTurn);
    const allowed = isGM ? canLedgerReroll(ledger, currentTurn) : viaDelegation;
    if (!allowed) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "reroll window closed or already reverted",
      );
      return;
    }
    if (!this.canUpdateAllLedgerDocs(session.user, ledger)) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "you cannot update the touched documents",
      );
      return;
    }
    // F01 spec: the inverse must still apply — a later unrelated write touching a
    // ledger path makes the revert diverge, and missing pre-images can never revert.
    const stale = ledgerStaleReason(ledger, this.store);
    if (stale !== null) {
      this.reject(session, String(msg.messageId), "invalid_schema", stale);
      return;
    }
    let newRolls = this.freshRollsWithRng(ledger);
    if (msg.newModifiers && msg.newModifiers.length > 0) {
      const [first, ...rest] = newRolls;
      if (first) {
        const extra = msg.newModifiers.reduce((s, m) => s + m.value, 0);
        newRolls = [
          {
            ...first,
            modifiers: [...first.modifiers, ...msg.newModifiers],
            total: first.total + extra,
          },
          ...rest,
        ];
      }
    }
    // Honest recompute: new effect Ops come from the damage delta, never a replay
    // of the old Ops. Non-HP ledgers are refused by name, not silently skipped.
    const plan = planDamageDeltaReroll({ ledger, newRolls });
    if (!plan.ok) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        plan.reason,
      );
      return;
    }
    // After inverse(old) the world is back at the recorded pre-state, so the new
    // envelope's pre-images ARE the original pre-images.
    const newLedgerInverses: Op[] = [...ledger.ledgerInverses];
    const ops = ledgerRerollOps({
      messageId: String(
        msg.messageId,
      ) as unknown as import("../core/ids").DocId,
      ledger,
      currentTurn,
      newLedgerOps: plan.ops,
      newLedgerInverses,
      newRolls,
    });
    if (!ops) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "reroll refused by ledger window",
      );
      return;
    }
    const oldSummary = ledger.rolls
      .map((r) => `${String(r.total)} (${r.formula})`)
      .join(", ");
    const newSummary = newRolls
      .map((r) => `${String(r.total)} (${r.formula})`)
      .join(", ");
    ops.push({
      kind: "create",
      coll: "messages",
      data: this.ledgerFollowUp(
        session.user.id,
        `Rerolled: ${doc.name}`,
        `Rerolled: ${oldSummary} → ${newSummary}${viaDelegation ? ` (delegated to ${session.user.name})` : ""}`,
      ),
    });
    const committed = this.commitOps(
      ops,
      session.user.id,
      "reroll-" + String(msg.messageId),
      false,
    );
    if (!committed.ok)
      this.reject(session, String(msg.messageId), "invariant", committed.error);
  }

  /**
   * §2.2 item 3 (G-20/D-261) — apply a roll card's total to one actor, host-authoritative.
   *
   * Three things make this the host's call and not the client's: the **amount** is re-read from the
   * committed card (`message.roll.total`, evaluated by `handleRoll`), the **permission** is the
   * sheet's own `can(user, "update", actor, "actors")`, and the **record of what was applied to
   * whom** rides the card's own flags, so a second click cannot double-count a card. The intent
   * carries no number at all (`roll.apply` in `messages.ts`).
   */
  private handleRollApply(
    session: Session,
    msg: import("../core/messages").RollApplyMsg,
  ): void {
    const txId = `roll-apply-${String(msg.messageId)}`;
    if (!session.user) {
      this.reject(session, txId, "forbidden", "not authenticated");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, txId, "rate_limited", "apply rate exceeded");
      return;
    }
    const message = this.store.get(
      "messages",
      String(msg.messageId),
    ) as unknown as MessageDocument | undefined;
    if (!message) {
      this.reject(session, txId, "invalid_schema", "roll card not found");
      return;
    }
    const total =
      typeof message.roll?.total === "number" ? message.roll.total : null;
    if (total === null) {
      this.reject(
        session,
        txId,
        "invalid_schema",
        "that card carries no rolled total",
      );
      return;
    }
    const actor = this.store.get("actors", String(msg.actorId)) as unknown as
      ActorDocument | undefined;
    if (!actor) {
      this.reject(session, txId, "invalid_schema", "actor not found");
      return;
    }
    if (!can(session.user, "update", actor, "actors")) {
      this.reject(
        session,
        txId,
        "forbidden",
        `you cannot update ${actor.name}`,
      );
      return;
    }
    const applied = readRollApplications(message);
    if (applied[actor._id]?.[msg.mode] !== undefined) {
      this.reject(
        session,
        txId,
        "invalid_schema",
        `this card's ${msg.mode} was already applied to ${actor.name}`,
      );
      return;
    }
    const derived = deriveFromActorDocument(actor);
    const pf1e =
      (actor.system as unknown as { pf1e?: Record<string, unknown> }).pf1e ??
      {};
    const planned = planRollApply({
      mode: msg.mode,
      amount: total,
      hp: derived.hp,
      hpMax: derived.hpMax,
      nonlethalDamage: derived.nonlethalDamage,
      tempHpSources: derived.tempHpSources,
      legacyTempHp:
        pf1e.tempHpSources === undefined && typeof pf1e.tempHp === "number",
    });
    if (!planned.ok) {
      this.reject(session, txId, "invalid_schema", planned.error);
      return;
    }
    const ops: Op[] = [];
    if (Object.keys(planned.plan.diff).length > 0) {
      ops.push({
        kind: "update",
        ref: { coll: "actors", id: actor._id },
        diff: planned.plan.diff,
      });
    }
    // The record rides the card's own flags so the table can see that a card was already counted
    // (and the chat card can grey its verb out). Flat diffs never create intermediate objects, so
    // the whole `flags` subtree is written — other flags keep their values.
    const flags = (message.flags ?? {}) as Record<string, Json>;
    const pf1eFlags = (flags.pf1e ?? {}) as Record<string, Json>;
    ops.push({
      kind: "update",
      ref: { coll: "messages", id: message._id },
      diff: {
        flags: {
          ...flags,
          pf1e: {
            ...pf1eFlags,
            applied: appliedWith(applied, actor._id, msg.mode, total),
          },
        } as unknown as Json,
      },
    });
    const roll = message.roll as { formula?: unknown } | null | undefined;
    ops.push({
      kind: "create",
      coll: "messages",
      data: this.ledgerFollowUp(
        session.user.id,
        `${msg.mode === "damage" ? "Damage" : "Healing"} applied`,
        `${session.user.name} applied ${String(total)} ${msg.mode} from ${message.name} (${String(roll?.formula ?? "roll")}) → ${actor.name}: ${planned.plan.note}`,
      ),
    });
    // Undoable as one envelope: the HP write, the card's record and the note move together.
    const committed = this.commitOps(ops, session.user.id, txId, true,
      this.newActionAudit(`${msg.mode === "damage" ? "Damage" : "Healing"}: ${actor.name} (${total})`));
    if (!committed.ok) this.reject(session, txId, "invariant", committed.error);
  }

  private async handleRollRevert(
    session: Session,
    msg: import("../core/messages").RollRevertMsg,
  ): Promise<void> {
    if (!session.user) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "not authenticated",
      );
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(
        session,
        String(msg.messageId),
        "rate_limited",
        "revert rate exceeded",
      );
      return;
    }
    const doc = this.store.get("messages", String(msg.messageId)) as unknown as
      MessageDocument | undefined;
    if (!doc) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "ledger card not found",
      );
      return;
    }
    const ledger = (
      doc.system as unknown as { rollLedger?: RollLedger } | undefined
    )?.rollLedger;
    if (!ledger) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "no rollLedger on that message",
      );
      return;
    }
    const currentTurn = this.currentTurnNumber();
    if (!canLedgerRevert(ledger, currentTurn)) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "revert window closed or already reverted",
      );
      return;
    }
    if (session.user.role !== "GM") {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "only GM can revert",
      );
      return;
    }
    if (!this.canUpdateAllLedgerDocs(session.user, ledger)) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "you cannot update the touched documents",
      );
      return;
    }
    const stale = ledgerStaleReason(ledger, this.store);
    if (stale !== null) {
      this.reject(session, String(msg.messageId), "invalid_schema", stale);
      return;
    }
    const ops = ledgerRevertOps({
      messageId: String(
        msg.messageId,
      ) as unknown as import("../core/ids").DocId,
      ledger,
      currentTurn,
    });
    if (!ops) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "ledger has no pre-images — revert is impossible by design",
      );
      return;
    }
    ops.push({
      kind: "create",
      coll: "messages",
      data: this.ledgerFollowUp(
        session.user.id,
        `Reverted: ${doc.name}`,
        `Reverted: ${doc.name} — its effects were removed as if the roll never happened.`,
      ),
    });
    const committed = this.commitOps(
      ops,
      session.user.id,
      "revert-" + String(msg.messageId),
      false,
    );
    if (!committed.ok)
      this.reject(session, String(msg.messageId), "invariant", committed.error);
  }

  private async handleRollDelegate(
    session: Session,
    msg: import("../core/messages").RollDelegateMsg,
  ): Promise<void> {
    if (!session.user) {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "not authenticated",
      );
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      this.reject(
        session,
        String(msg.messageId),
        "rate_limited",
        "delegate rate exceeded",
      );
      return;
    }
    const doc = this.store.get("messages", String(msg.messageId)) as unknown as
      MessageDocument | undefined;
    if (!doc) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "ledger card not found",
      );
      return;
    }
    const ledger = (
      doc.system as unknown as { rollLedger?: RollLedger } | undefined
    )?.rollLedger;
    if (!ledger) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "no rollLedger on that message",
      );
      return;
    }
    const currentTurn = this.currentTurnNumber();
    if (!canLedgerReroll(ledger, currentTurn)) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "delegate window closed or reverted",
      );
      return;
    }
    if (session.user.role !== "GM") {
      this.reject(
        session,
        String(msg.messageId),
        "forbidden",
        "only GM can delegate rerolls",
      );
      return;
    }
    const ops = delegateRerollOps({
      messageId: String(
        msg.messageId,
      ) as unknown as import("../core/ids").DocId,
      ledger,
      currentTurn,
      playerId: msg.playerId,
    });
    if (!ops) {
      this.reject(
        session,
        String(msg.messageId),
        "invalid_schema",
        "delegate refused by ledger window",
      );
      return;
    }
    const committed = this.commitOps(
      ops,
      session.user.id,
      "delegate-" + String(msg.messageId),
      false,
    );
    if (!committed.ok)
      this.reject(session, String(msg.messageId), "invariant", committed.error);
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
    const committed = this.commitOps(
      item.ops,
      this.systemUserId,
      `undo-${randomId()}`,
      false,
    );
    return committed.ok ? { ok: true } : { ok: false, error: committed.error };
  }

  redo(): { ok: boolean; error?: string } {
    const item = this.undoStackApply("redo");
    if (!item.ok) return item;
    const committed = this.commitOps(
      item.ops,
      this.systemUserId,
      `redo-${randomId()}`,
      false,
    );
    return committed.ok ? { ok: true } : { ok: false, error: committed.error };
  }

  /**
   * §5.1 `undo.last` — undo, but only if **this** user authored the top of the stack.
   *
   * The stack can only pop its top, so this is not a search for the caller's last change: it is a
   * check that the last undoable thing in the world is theirs. Anything else is refused, because
   * an agent undoing the GM's move (or another player's) is worse than an agent that cannot undo
   * at all — and the inverses stored for an older envelope were computed against a world that has
   * moved on since.
   */
  undoOwn(user: SessionUser): { ok: boolean; error?: string; what?: string } {
    const top = this.undoStack.peekUndo();
    if (!top) return { ok: false, error: "nothing to undo" };
    const entry = this.log.at(top.refSeq);
    if (!entry)
      return { ok: false, error: "the change to undo is no longer in the log" };
    if (entry.env.by !== user.id) {
      return {
        ok: false,
        error: "the last undoable change was not yours — undo is the GM's call",
      };
    }
    const what = `${entry.env.ops.length} op(s) from seq ${entry.env.seq}`;
    const done = this.undo();
    return done.ok
      ? { ok: true, what }
      : { ok: false, error: done.error ?? "could not undo" };
  }

  private undoStackApply(
    which: "undo" | "redo",
  ): { ok: true; ops: Op[] } | { ok: false; error: string } {
    const item =
      which === "undo"
        ? this.undoStack.applyUndo()
        : this.undoStack.applyRedo();
    if (!item) return { ok: false, error: `nothing to ${which}` };
    return { ok: true, ops: item.ops };
  }

  /** World info for welcome messages (exposed for tests/UI). */
  get worldInfo(): {
    id: string;
    name: string;
    system: string;
    version: string;
  } {
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
