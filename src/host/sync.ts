import { snapshotMoveEntry } from "../core/moveDestination";
import { snapTokenCenter } from "../canvas/grid";
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
  type ItemDocument,
  type CollectionName,
  type MessageDocument,
  type MacroDocument,
  type PrefabDocument,
  type FxInstanceDocument,
  type Role,
  type UserDocument,
} from "../core/documents";
import { getEffectiveOwnership } from "../core/permissions";
import { journalLinks, visibleJournalLinks, type JournalTileLink } from "../core/journalLinks";
import type {
  ActorDocument,
  CombatDocument,
  DocRef,
  JournalDocument,
  JournalPageDocument,
  Json,
  SceneDocument,
  TileDocument,
  TokenDocument,
  WallDocument,
} from "../core/documents";
import type { Op, OpEnvelope } from "../core/ops";
import type {
  AssetShareMsg,
  AssetLibraryMsg,
  AssetCleanupMsg,
  AssetUploadChunkMsg,
  AssetUploadFinishMsg,
  AssetUploadStartMsg,
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
  JournalTriggerMsg,
  MacroInvokeMsg,
  MacroSaveMsg,
  MacroRequestMsg,
  MacroResultMsg,
  FxRequestMsg,
  FxStartMsg,
  FxRunMsg,
  FxStopMsg,
  FxStopMatchingMsg,
  HelloMsg,
  PingMsg,
  ReportDetailMsg,
  RollMsg,
  RollRevealMsg,
  SimControlMsg,
  SimSnapshotGetMsg,
  PF1eConditionActionMsg,
  CodexClaimMsg,
  CodexPurchaseMsg,
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
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encumbranceOptionsOf, worldSettingsFrom } from "../core/worldSettings";
import { sceneDifficultCells } from "../core/rules";
import { tileTriggerElevationError, tileTriggerZoneError } from "../core/tileTriggerZone";
import { automationSourceTile, regionGeometryError } from "../core/regionGeometry";
import { pf1eMovePlan } from "../packages/pf1e/movement";
import {
  buildPendingRoll,
  isPendingExpired,
  pendingPruneOps,
  pendingRollOfSystem,
  pendingRollsOfSystem,
  pendingRollUpdateDiff,
  shouldDeferToPlayer,
  resolvePendingRoll as resolvePendingRollDoc,
  validatePendingRoll,
  PENDING_ROLL_MAX,
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
import {
  pf1eApplyConditionApplication,
  pf1eRemoveConditionApplication,
  validatePF1eConditionApplications,
} from "../packages/pf1e/conditionApplications";
import { pf1eConditionDef, conditionRefusalFor } from "../packages/pf1e/conditions";
import { pf1eSpellEffectById, pf1eSpellEffectLanded, type PF1eSpellEffect }
  from "../packages/pf1e/spellEffects";
import { sightBlockedBetween } from "../core/crosshair";
import { affectedTokens, lineIntersectsTokenFootprint, pf1eAreaGridFromScene, resolveAreaCells } from "../packages/pf1e/targeting";
import { combinedTacticalEffects, resolveTacticalEffects } from "../packages/pf1e/effectOps";
import {
  PF1E_POISON_FIXTURES,
  activatePF1eDelayPoison,
  applyPF1ePoisonExposureToTarget,
  emptyPF1ePoisonTargetState,
  endPF1eDelayPoison,
  neutralizePF1ePoisonCourse,
  nextPF1eQueuedPoisonExposure,
  pf1eCreaturePoisonBaseDc,
  pf1ePoisonExposureSaveDc,
  pf1ePoisonOngoingSaveDc,
  pf1ePoisonDefinitionIdentity,
  resolvePF1ePoisonFrequencySave,
  resolvePF1ePoisonOnset,
  resolveNextPF1eQueuedPoisonExposure,
  validatePF1ePoisonTargetState,
  type PF1ePoisonCourse,
  type PF1ePoisonDefinition,
  type PF1ePoisonEffect,
  type PF1ePoisonTargetState,
} from "../packages/pf1e/afflictions";
import { PF1E_SAVE_SEVERITIES, resolveSpellTarget, spellResistanceCheck, type PF1eSaveSeverity,
  type PF1eSaveType } from "../packages/pf1e/casting";
import { PF1E_ENERGY_TYPES, type PF1eEnergyType } from "../packages/pf1e/healthState";
import { hasPF1eFeat } from "../packages/pf1e/feats";
import { srAlreadyOvercome, srOvercomeBlobFromFlags, srOvercomeDiff } from "../packages/pf1e/srLedger";
import { planAutomationHealth } from "../packages/pf1e/automationHealth";
import { resolveSpellSlotBudget } from "../packages/pf1e/spellSlots";
import {
  appliedWith,
  planRollApply,
  readRollApplications,
} from "../packages/pf1e/rollApply";
import type { DocId, PeerId, TxId, UserId, AssetId } from "../core/ids";
import { DocumentStore } from "../core/store";
import { actionOpRef, actionStaleReason, extendActionReceipt, missingActionMessageDeletes,
  type ActionAudit } from "../core/actionRevert";
import { ACTION_CARD_VERSION, ACTION_RIDER_MAX, actionAsJson, actionCardOf, actionFxContext,
  deriveActionState, normalizeNewActionCard, resolveActionPendingTarget, validateActionCard,
  type ActionCard, type ActionFxContext, type ActionRider, type ActionTarget } from "../core/action";
import { OpLog } from "../core/oplog";
import { UndoStack } from "../core/undo";
import { can } from "../core/permissions";
import {
  canReadCodexRef,
  codexAudienceAllows,
  codexDocumentError,
  codexPageMetadataError,
  codexReferencesRef,
  hasCodexMetadata,
} from "../core/campaignCodex";
import {
  planCodexLootClaim,
  planCodexPurchase,
} from "../core/campaignCodexEconomy";
import { canFetchAsset, projectAssetManifest } from "../core/assetAccess";
import { assetLibrary, assetUsageRoots, unusedAssetIds } from "../core/assetUsage";
import { MAX_IMAGE_BYTES, normalizeLogicalFolder, sniffMedia } from "../core/imageSizing";
import { playerUploadQuotaMBOf } from "../core/imageHandling";
import { FX_FINISH_OFFSET_MAX_MS, fxAudienceAllows, fxResolveSyncOrigins, fxSectionsForViewer,
  resolveFxSequence, validateFxSequence, type FxAudience } from "../core/fx";
import type { FxSyncGroupMember, ResolvedFxSection } from "../core/fx";
import { combatTriggerEvents } from "../core/combat";
import { readWorldClock } from "../packages/pf1e/worldClock";
import { automationImageError, doorTransitionMethod, pinnedSelectorError, planAutomation, SIMULATABLE_METHODS, sweptTileEvents, tileContainsPoint, validateAutomation, validateAutomationState,
  type AutomationContinuation, type AutomationEvent, type AutomationMethod, type AutomationPointerMethod, type AutomationOutcome, type AutomationResult,
  type AutomationScriptResult } from "../core/automation";
import { attachedDeletionOps, attachedMovementOps, planPrefabPlacement, PREFAB_COLLECTIONS, validatePrefab } from "../core/prefabs";
import { boundFxDeletionOps, fxInstanceMatches, validateFxInstance, validateFxInstanceFilter } from "../core/fxInstances";
import { fxPresetDocumentError, macroStrayPresetError } from "../core/fxPresets";
import { MACRO_AUTOMATION_METHOD, macroAutomationDocumentError, macroAutomationGraphId,
  macroAutomationInputs, macroStrayAutomationError } from "../core/macroAutomation";
import { macroCompositeDocumentError, macroCompositeMacroIds,
  macroStrayCompositeError } from "../core/macroComposite";
import { validateMacroArgs, type MacroArgs } from "../core/macroArgs";
import { macroItemReadable } from "../core/macroItems";
import { buildPlayerMacro, canSaveWorldMacros, ownsPlayerMacro, playerMacroAuthoring, PLAYER_MACRO_LIMITS,
  validatePlayerMacroDraft } from "../core/playerMacros";
import { fxBindingDeletionOps, fxBindingEvents, fxItemBindingError, fxSpellBindingError,
  fxSpellBindingKey }
  from "../core/fxBinding";
import { planSummon, summonDeletionOps, summonMarker, summonPlacementError, validateSummon,
  type SummonSource } from "../core/summons";
import { getByTag, isPrototypeTokenTagRef, isWorldDocumentTagRef, isWorldTagRef, listTaggable, tagDataError, tagEditOps, tagRefKey,
  taggerTagsError, tagRuleOps, tagsOf, TAGGABLE_COLLECTIONS, WORLD_TAGGABLE_COLLECTIONS,
  validGlobalTagRefs, validSceneTagRefs, validWorldTagRefs,
  type TagEdit, type TagMatchMode, type TagPattern, type TagRef, type TagSearchCollection } from "../core/tags";
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
import type { AssetGetMsg, FogGetMsg, FogPutMsg, FxDeliverySkips, FxMediaAckMsg, FxMediaAckState,
  PF1ePoisonActionMsg } from "../core/messages";
import { fxMediaReport } from "../core/fxDelivery";
import { axisBlocks, soundSegments } from "../canvas/vision/wallSight";
import { segmentsCross } from "../canvas/vision/polygon";
import { MAX_FOG_PNG_BYTES } from "../core/fogExploration";
import type { AssetServer } from "./assets";
import type { ImportPipeline } from "./import";
import { AssetTransfer } from "../net/transfer";
import type { EventBus, PermissionUser } from "../core";
import type { Transport } from "../core/net";
import { frameMessage, deframeMessage, channelFor } from "../net/frame";
import { verifyHello } from "../net/identity";
import { evaluateFormula, validateFormula } from "../dice";
import type { RngFn } from "../dice";

/** MC-01 (D-386): a macro fire whose live state has already been validated. */
export interface MacroFireTarget {
  graph: AutomationDocument;
  scene: SceneDocument;
  tile: TileDocument;
  /** MC-02: the caller's validated invocation arguments (declared keys only). */
  args?: MacroArgs;
}

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
  /** Durable, bounded facts from a newly committed action revision. FX may observe; never mutate. */
  "action:committed": ActionFxContext;
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
  /** Host-side image validation/derivation/storage used only after the upload gate succeeds. */
  pipeline?: Pick<ImportPipeline, "importImage">;
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

interface ActiveTransientFx {
  sceneId: string;
  ownerId: string;
  /** Only sessions that received `fx.start` may receive its opaque `fx.end`. */
  peers: Set<PeerId>;
  endsAtHostTime: number;
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
  /** Private authored memberships stored only with a durable instance. */
  syncGroups?: FxSyncGroupMember[];
  sourceTokenId?: string;
  targetTokenId?: string;
  conditionApplicationId?: string;
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

interface ImageUploadState {
  uploadId: string;
  userId: UserId;
  name: string;
  displayName: string;
  size: number;
  folder: string;
  sourceKind: "file" | "paste" | "url";
  collisionBehavior: "stop" | "reuse" | "overwrite";
  convertToWebp: boolean;
  webpQuality: number;
  chunks: Uint8Array[];
  received: number;
  lastAck: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
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
  imageUpload: ImageUploadState | null;
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
    const touches = (diff: Diff, field: string) => Object.keys(diff).some((key) => {
      const path = key.startsWith("-=") ? key.slice(2) : key;
      return path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`);
    });
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

/** Bounded, GM-only serialization for a reviewed script's awaited return value. */
function scriptResultSummary(result: Json): string {
  const text = JSON.stringify(result);
  return text.length > 512 ? `${text.slice(0, 509)}…` : text;
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
interface AutomationPostActionRun {
  audit: ActionAudit;
  session: Session;
  caller: SessionUser;
  deadline: number;
  budget: { calls: number };
  trace: string[];
  continuedFailures: number;
  actionCount: number;
  summonCount: number;
}

type PlannedMovementPath = { endpoint: TokenDocument; stopFraction: number };
type PreplannedMovementTrigger = { outcome: AutomationOutcome };
const movementAutomationKey = (sceneId: string, tokenId: string, docId: string, tileId: string, method: AutomationMethod) =>
  `${sceneId}\u0000${tokenId}\u0000${docId}\u0000${tileId}\u0000${method}`;

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
  private readonly assets: AssetServer | null;
  private readonly transfer: AssetTransfer | null;
  private readonly pipeline: HostSyncOptions["pipeline"];
  private readonly rng: RngFn;
  private readonly now: () => number;
  private readonly scriptRunner: ScriptRunner;
  private readonly resolveSummonSource: HostSyncOptions["resolveSummonSource"];
  private readonly summonRequests = new Map<string, number>();
  private summonTimer: ReturnType<typeof setTimeout> | null = null;
  /** Prevent a poison event commit from recursively re-entering its own scheduler. */
  private poisonSweepDepth = 0;
  /** D-308: the media-acknowledgment window (one timer for the earliest deadline). */
  private fxMediaTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fxMediaReceipts = new Map<string, FxMediaReceipt>();
  /** One scheduler for all finite, cancellable presentation runs; no run creates its own timer. */
  private fxTransientTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fxTransientRuns = new Map<string, ActiveTransientFx>();
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
    this.assets = options.assets ?? null;
    this.transfer = this.assets
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
    this.pipeline = options.pipeline;
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
      imageUpload: null,
    };
    this.sessions.set(peerId, session);
    transport.onMessage = (_channel, bytes) => this.onFrame(session, bytes);
    if (user) this.welcomeSession(session, user, undefined);
  }

  removeSession(peerId: PeerId, reason = "closed"): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.cancelImageUpload(session);
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
      case "pf1e.poison":
        this.handlePF1ePoisonAction(session, msg);
        return;
      case "pf1e.condition":
        this.handlePF1eConditionAction(session, msg);
        return;
      case "codex.purchase":
        this.handleCodexPurchase(session, msg);
        return;
      case "codex.claim":
        this.handleCodexClaim(session, msg);
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
        this.handleAutomationTileTrigger(session, msg);
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
      case "macros.invoke":
        this.handleMacroInvoke(session, msg);
        return;
      case "macros.save":
        this.handleMacroSave(session, msg);
        return;
      case "journal.trigger":
        this.handleJournalTrigger(session, msg);
        return;
      // Host→client kinds and later-milestone kinds are never accepted here:
      case "welcome":
      case "snapshot":
      case "ops":
      case "rejected":
      case "asset.chunk":
      case "asset.upload.result":
      case "asset.share.result":
      case "fx.start":
      case "fx.run":
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
      case "asset.upload.start":
        this.handleAssetUploadStart(session, msg);
        return;
      case "asset.upload.chunk":
        this.handleAssetUploadChunk(session, msg);
        return;
      case "asset.upload.finish":
        void this.handleAssetUploadFinish(session, msg);
        return;
      case "asset.upload.cancel":
        if (session.imageUpload?.uploadId === msg.uploadId) this.cancelImageUpload(session);
        return;
      case "asset.share":
        void this.handleAssetShare(session, msg);
        return;
      case "asset.library":
        void this.handleAssetLibrary(session, msg);
        return;
      case "asset.cleanup":
        void this.handleAssetCleanup(session, msg);
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
    // A viewer loading the active scene it does not already hold hears `sceneLoad` — the
    // per-player half of MATT's scene trigger (its wiki: "triggers for each player loading
    // in"). Fired after the snapshot so the graph's own commits arrive as later ops; a scene
    // activation stays the separate `sceneChange` event, so the two never coincide.
    const loaded = this.activeSceneDocument();
    if (!loaded) {
      this.loadedSceneByUser.delete(user.id);
      return;
    }
    if (this.loadedSceneByUser.get(user.id) !== loaded._id) {
      this.loadedSceneByUser.set(user.id, loaded._id);
      this.fireSceneGraphs(loaded, "sceneLoad", user.id);
    }
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
    const movementError = this.playerMovementError(session.user, normalized.ops, txId);
    if (movementError) {
      this.reject(session, txId, "invariant", movementError);
      return;
    }
    const prepared = this.precommitStopMovement(normalized.ops, session.user.id, txId);
    if (!prepared.ok) { this.reject(session, txId, "invariant", prepared.error); return; }
    // User ops were permission-checked above. Token-boundary corrections remain scoped to the
    // already-authorized mover; immutable roll-claim writes are generated separately below.
    const finalValidation = this.validateOps(session.user, prepared.ops);
    if (!finalValidation.ok) {
      this.reject(session, txId, finalValidation.reason, finalValidation.error); return;
    }
    const userOps = prepared.paths.size ? prepared.ops : normalized.ops;
    // Only the final validation's host ops are committed: the first pass exists to reject before
    // movement preflight, and appending both would double-post the condition audit line.
    const commitOps = [...userOps, ...normalized.hostOps, ...finalValidation.hostOps];
    const committed = this.commitOps(commitOps, session.user.id, txId, true, undefined, undefined,
      false, prepared.paths, prepared.triggers, prepared.at);
    if (!committed.ok) this.reject(session, txId, "invariant", committed.error);
  }

  /**
   * PF1e walk allowance is enforced at the host for non-GM intents, never trusted
   * to a player's canvas callback. The GM's own drag is an explicit override and
   * bypasses both this guard and the local movement/AoO preflight. Every player
   * budget comes from the linked actor's live derived speed (including encumbrance),
   * rather than a duplicated 30-ft constant.
   */
  private playerMovementError(user: SessionUser, ops: readonly Op[], txId: TxId): string | null {
    if (user.role === "GM") return null;
    const moving = new Map<string, { sceneId: string; tokenId: string; before: TokenDocument }>();
    for (const op of ops) {
      if (op.kind !== "update" || op.ref.coll !== "tokens" || op.ref.parent?.coll !== "scenes" ||
          !Object.keys(op.diff).some((key) => key === "x" || key === "y")) continue;
      const before = this.store.resolve(op.ref) as TokenDocument | undefined;
      if (before) moving.set(`${op.ref.parent.id}\\u0000${op.ref.id}`, {
        sceneId: op.ref.parent.id, tokenId: op.ref.id, before,
      });
    }
    if (moving.size === 0) return null;
    const shadow = this.store.forkForPreflight();
    const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by: user.id, txId,
      ops: ops as Op[] });
    if (!preview.ok) return null; // the ordinary commit path reports the authoritative schema error
    const settings = encumbranceOptionsOf(worldSettingsFrom(this.store.getAll("settings")));
    const derivedByActor = new Map<string, ReturnType<typeof deriveFromActorDocument>>();
    const derived = (token: TokenDocument) => {
      if (!token.actorId) return null;
      const actor = this.store.get("actors", token.actorId) as ActorDocument | undefined;
      const block = actor?.system?.pf1e;
      if (!actor || actor.type !== "actor" || !block || typeof block !== "object" || Array.isArray(block)) return null;
      let value = derivedByActor.get(actor._id);
      if (!value) { value = deriveFromActorDocument(actor, settings); derivedByActor.set(actor._id, value); }
      return value;
    };
    const byScene = new Map<string, Array<{ tokenId: string; before: TokenDocument }>>();
    for (const row of moving.values()) {
      const rows = byScene.get(row.sceneId) ?? [];
      rows.push(row); byScene.set(row.sceneId, rows);
    }
    for (const [sceneId, rows] of byScene) {
      const beforeScene = this.store.get("scenes", sceneId) as SceneDocument | undefined;
      const afterScene = shadow.get("scenes", sceneId) as SceneDocument | undefined;
      if (!beforeScene || !afterScene) continue;
      const movedIds = new Set(rows.map((row) => row.tokenId));
      const afterById = new Map(afterScene.tokens.map((token) => [token._id, token]));
      const visibleScene = projectWorld(this.store.world, this.store.seq, user).collections.scenes
        ?.find((scene) => scene._id === sceneId);
      const visibleById = new Map((visibleScene?.tokens ?? []).map((token) => [token._id, token]));
      const moverFacts = new Map(beforeScene.tokens.map((token) => [token._id, derived(token)]));
      // Do not let a movement refusal disclose hidden opponents, walls or terrain.
      // Reconstruct only this caller's projected scene, then stage the other moved
      // companions at their submitted destinations for simultaneous group drags.
      const visibleTokens = [...(visibleScene?.tokens ?? [])];
      for (const row of rows) if (!visibleById.has(row.tokenId)) visibleTokens.push(row.before);
      const tokens = visibleTokens.map((token) => {
        const position = movedIds.has(token._id) ? afterById.get(token._id) ?? token : token;
        const stats = moverFacts.get(token._id);
        return { ...position, ...(stats ? { size: stats.size, shape: stats.reachShape } : {}) };
      });
      const explicitDispositions = visibleTokens.length > 0 && visibleTokens.every((token) => token.disposition !== "neutral");
      const isAlly = explicitDispositions
        ? (a: string, b: string) => visibleTokens.find((token) => token._id === a)?.disposition ===
          visibleTokens.find((token) => token._id === b)?.disposition
        : undefined;
      const walls = (visibleScene?.walls ?? []).filter((wall) => axisBlocks(wall.move, wall.door)).map((wall) => ({
        x1: wall.c[0] ?? 0, y1: wall.c[1] ?? 0, x2: wall.c[2] ?? 0, y2: wall.c[3] ?? 0,
      }));
      const terrain = sceneDifficultCells(visibleScene);
      for (const row of rows) {
        const endpoint = afterById.get(row.tokenId);
        const actorStats = moverFacts.get(row.tokenId);
        if (!endpoint || !actorStats || (row.before.x === endpoint.x && row.before.y === endpoint.y)) continue;
        const tokenList = tokens.map((token) => token._id === row.tokenId
          ? { ...token, x: row.before.x, y: row.before.y } : token);
        const plan = pf1eMovePlan({ grid: beforeScene.grid, tokens: tokenList,
          mover: { tokenId: row.tokenId, to: { x: endpoint.x, y: endpoint.y }, speedFt: actorStats.speedFt,
            size: actorStats.size }, walls, ...(terrain ? { difficultCells: terrain.difficultCells } : {}),
          ...(isAlly ? { isAlly } : {}) });
        if (plan.refusal !== null)
          return `${row.before.name} can't move there — ${plan.refusal}`;
      }
    }
    return null;
  }

  /**
   * Bounded Stop preflight. For one moving token, plan only the first movement
   * graph that contains Stop, cache that exact outcome (including gates/RNG),
   * and clip only when Stop actually ran and its world ops are limited to the
   * triggering token correction plus that graph's own history. Conditional
   * skips and graphs with additional effects keep ordinary post-commit behavior;
   * multi-token intents retain D-347's narrower path.
   */
  private precommitStopMovement(
    ops: Op[], by: UserId, txId: TxId,
  ): { ok: true; ops: Op[]; paths: Map<string, PlannedMovementPath>; triggers?: Map<string, PreplannedMovementTrigger>; at?: number } | { ok: false; error: string } {
    const movingTokens = new Map<string, { sceneId: string; tokenId: string; before: TokenDocument }>();
    for (const op of ops) {
      if (op.kind !== "update" || op.ref.coll !== "tokens" || op.ref.parent?.coll !== "scenes" ||
          !Object.keys(op.diff).some((key) => key === "x" || key === "y")) continue;
      const before = this.store.resolve(op.ref) as TokenDocument | undefined;
      if (before) movingTokens.set(`${op.ref.parent.id}\u0000${op.ref.id}`, {
        sceneId: op.ref.parent.id, tokenId: op.ref.id, before,
      });
    }
    if (movingTokens.size === 1) {
      const source = movingTokens.values().next().value as { sceneId: string; tokenId: string; before: TokenDocument } | undefined;
      if (source) return this.preplanSingleTokenStop(ops, by, txId, source);
    }
    if (movingTokens.size > 1 && movingTokens.size <= 128) {
      const multiple = this.preplanMultipleStops(ops, by, txId, movingTokens);
      if (multiple) return multiple;
    }
    if (!movingTokens.size || movingTokens.size > 128) return { ok: true, ops, paths: new Map() };

    const shadow = this.store.forkForPreflight();
    const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by, txId, ops });
    if (!preview.ok) return { ok: true, ops, paths: new Map() }; // normal validation reports authoritative errors
    const movementGraphs = shadow.getAll("automations");
    if (movementGraphs.length > 4096 || movingTokens.size * movementGraphs.length > 65_536)
      return { ok: true, ops, paths: new Map() };

    type MovementEvent = { docId: string; tileId: string; fraction: number; method: "enter" | "exit" };
    type StopCandidate = {
      sceneId: string; tokenId: string; tile: TileDocument; docId: string;
      fraction: number; method: "enter" | "exit"; x: number; y: number; snap: boolean;
    };
    const selected = new Map<string, StopCandidate>();
    for (const [key, source] of movingTokens) {
      const scene = shadow.get("scenes", source.sceneId) as SceneDocument | undefined;
      const endpoint = scene?.tokens.find((token) => token._id === source.tokenId);
      if (!scene || !endpoint || (source.before.x === endpoint.x && source.before.y === endpoint.y)) continue;

      const movementEvents: MovementEvent[] = [];
      const stopEvents: StopCandidate[] = [];
      for (const doc of movementGraphs) {
        const checked = validateAutomation(doc.definition);
        if (!checked.ok || checked.definition.sceneId !== scene._id ||
            !checked.definition.methods.some((method) => method === "enter" || method === "exit")) continue;
        const tile = automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind);
        if (!tile) continue;

        for (const hit of sweptTileEvents(tile, source.before, endpoint, scene.grid)) {
          if ((hit.method !== "enter" && hit.method !== "exit") || !checked.definition.methods.includes(hit.method)) continue;
          movementEvents.push({ docId: doc._id, tileId: tile._id, fraction: hit.fraction, method: hit.method });

          const gates = checked.definition.gates;
          const step = checked.definition.steps.length === 1 ? checked.definition.steps[0] : undefined;
          if (step?.kind !== "stopMovement" || (gates && (gates.paused || gates.chance !== undefined ||
              gates.oncePerToken || gates.cooldownMs || gates.maxRuns))) continue;
          // The graph's bookkeeping must also be able to commit. Avoid clipping when its only
          // remaining reason to fail would otherwise be discovered after the movement envelope.
          const state = doc.state ?? { count: 0, lastAt: 0, byToken: {} };
          const tokenHistory = state.byToken?.[source.tokenId];
          if (!validateAutomationState(state) || state.count >= 1_000_000 ||
              (tokenHistory?.count ?? 0) >= 1_000_000 ||
              (!tokenHistory && Object.keys(state.byToken ?? {}).length >= 4096)) continue;

          const x = source.before.x + (endpoint.x - source.before.x) * hit.fraction;
          const y = source.before.y + (endpoint.y - source.before.y) * hit.fraction;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          stopEvents.push({
            sceneId: scene._id, tokenId: source.tokenId, tile, docId: doc._id,
            fraction: hit.fraction, method: hit.method, x, y, snap: step.snapToGrid === true,
          });
        }
      }

      stopEvents.sort((a, b) => a.fraction - b.fraction ||
        (a.method === "enter" ? 0 : 1) - (b.method === "enter" ? 0 : 1) ||
        (b.tile.sort ?? 0) - (a.tile.sort ?? 0) || a.tile._id.localeCompare(b.tile._id) ||
        a.docId.localeCompare(b.docId));
      const stop = stopEvents[0];
      if (!stop) continue;
      // Pre-commit is safe only if this is the sole movement trigger reached before the stop.
      // Other graphs can branch, fail atomically, or redirect the token before this action runs.
      const preceding = movementEvents.filter((event) => event.fraction <= stop.fraction + 1e-8);
      if (preceding.length !== 1 || preceding[0]?.docId !== stop.docId ||
          preceding[0]?.tileId !== stop.tile._id || preceding[0]?.method !== stop.method) continue;
      selected.set(key, stop);
    }
    if (!selected.size) return { ok: true, ops, paths: new Map() };

    const prepared = [...ops];
    const paths = new Map<string, PlannedMovementPath>();
    for (const [key, stop] of selected) {
      const scene = shadow.get("scenes", stop.sceneId) as SceneDocument | undefined;
      const endpoint = scene?.tokens.find((token) => token._id === stop.tokenId);
      if (!scene || !endpoint)
        return { ok: false, error: "Stop Token Movement endpoint disappeared during preflight" };

      let point = { x: stop.x, y: stop.y };
      if (stop.snap && scene.grid.type !== "gridless") {
        if (!Number.isFinite(scene.grid.size) || scene.grid.size <= 0 ||
            (scene.grid.type === "hex" && !(["oddQ", "evenQ", "oddR", "evenR"] as string[]).includes(scene.grid.hexLayout)))
          continue; // leave ordinary movement intact; runtime action fails closed
        point = snapTokenCenter(scene.grid.type === "hex"
          ? { type: "hex", size: scene.grid.size, layout: scene.grid.hexLayout }
          : { type: "square", size: scene.grid.size }, point.x, point.y);
      }
      if (point.x < 0 || point.y < 0 || point.x > scene.width || point.y > scene.height) continue;

      paths.set(key, { endpoint: structuredClone(endpoint), stopFraction: stop.fraction });
      if (endpoint.x !== point.x || endpoint.y !== point.y) prepared.push({
        kind: "update",
        ref: { coll: "tokens", id: stop.tokenId, parent: { coll: "scenes", id: stop.sceneId } },
        diff: { x: point.x, y: point.y },
      });
    }
    return { ok: true, ops: prepared, paths };
  }

  /**
   * Group movement may cross one Stop-bearing graph per token. Plan those
   * outcomes in the same deterministic order as post-commit dispatch, applying
   * each plan only to the fork so later gates see earlier staged history. Keep
   * the whole group conservative if a token has competing crossings or any
   * candidate graph leaves the supported step family.
   */
  private preplanMultipleStops(
    ops: Op[], by: UserId, txId: TxId,
    sources: ReadonlyMap<string, { sceneId: string; tokenId: string; before: TokenDocument }>,
  ): { ok: true; ops: Op[]; paths: Map<string, PlannedMovementPath>;
    triggers: Map<string, PreplannedMovementTrigger>; at?: number } | undefined {
    const shadow = this.store.forkForPreflight();
    const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by, txId, ops });
    if (!preview.ok) return undefined;
    const definitions = shadow.getAll("automations");
    if (definitions.length > 4096 || sources.size * definitions.length > 65_536) return undefined;

    type Candidate = {
      sceneId: string; tokenId: string; sourceKey: string;
      before: TokenDocument; endpoint: TokenDocument; tile: TileDocument; docId: string;
      method: "enter" | "exit"; fraction: number;
      crossing: NonNullable<AutomationEvent["movementCrossing"]>;
      direction: NonNullable<AutomationEvent["direction"]>;
      movementEntry?: AutomationEvent["movementEntry"];
    };
    const candidates: Candidate[] = [];
    for (const [sourceKey, source] of sources) {
      const scene = shadow.get("scenes", source.sceneId) as SceneDocument | undefined;
      const endpoint = scene?.tokens.find((token) => token._id === source.tokenId);
      if (!scene || !endpoint || (source.before.x === endpoint.x && source.before.y === endpoint.y)) continue;
      const dx = endpoint.x - source.before.x, dy = endpoint.y - source.before.y;
      const direction: AutomationEvent["direction"] = {
        ...(dx < -1e-6 ? { x: "left" as const } : dx > 1e-6 ? { x: "right" as const } : {}),
        ...(dy < -1e-6 ? { y: "up" as const } : dy > 1e-6 ? { y: "down" as const } : {}),
      };
      const tokenCandidates: Candidate[] = [];
      for (const doc of definitions) {
        const checked = validateAutomation(doc.definition);
        if (!checked.ok || checked.definition.sceneId !== scene._id) continue;
        const tile = automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind);
        if (!tile) continue;
        for (const hit of sweptTileEvents(tile, source.before, endpoint, scene.grid)) {
          if (!checked.definition.methods.includes(hit.method)) continue;
          if (hit.method !== "enter" && hit.method !== "exit") return undefined;
          if (!checked.definition.steps.some((step) => step.kind === "stopMovement") ||
              checked.definition.steps.some((step) => ["move", "rotate", "triggerTile", "sequence", "script", "summon", "resetHistory"]
                .includes(step.kind))) return undefined;
          const contact = { x: source.before.x + dx * hit.fraction, y: source.before.y + dy * hit.fraction };
          const entry = hit.method === "enter" ? snapshotMoveEntry(tile, contact, true) : undefined;
          tokenCandidates.push({ sceneId: scene._id, tokenId: source.tokenId, sourceKey,
            before: source.before, endpoint, tile, docId: doc._id, method: hit.method, fraction: hit.fraction,
            crossing: { tileId: tile._id, tokenId: source.tokenId, method: hit.method,
              fraction: hit.fraction, ...contact }, direction,
            ...(entry ? { movementEntry: { ...entry, tileId: tile._id, tokenId: source.tokenId } } : {}) });
        }
      }
      // More than one trigger for a token needs normal post-commit arbitration;
      // this bounded slice does not speculate through competing graphs.
      if (tokenCandidates.length > 1) return undefined;
      candidates.push(...tokenCandidates);
    }
    if (!candidates.length) return undefined;
    const sceneIds = new Set(candidates.map((candidate) => candidate.sceneId));
    if (sceneIds.size !== 1) return undefined;
    candidates.sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.fraction - b.fraction ||
      a.tokenId.localeCompare(b.tokenId) || (a.method === "enter" ? 0 : 1) - (b.method === "enter" ? 0 : 1) ||
      (b.tile.sort ?? 0) - (a.tile.sort ?? 0) || a.tile._id.localeCompare(b.tile._id) || a.docId.localeCompare(b.docId));

    const plannedAt = this.now();
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    const triggers = new Map<string, PreplannedMovementTrigger>();
    const paths = new Map<string, PlannedMovementPath>();
    const prepared = [...ops];
    for (const candidate of candidates) {
      const scene = shadow.get("scenes", candidate.sceneId) as SceneDocument | undefined;
      const doc = shadow.get("automations", candidate.docId) as AutomationDocument | undefined;
      const token = scene?.tokens.find((item) => item._id === candidate.tokenId);
      const tile = scene?.tiles.find((item) => item._id === candidate.tile._id);
      if (!scene || !doc || !token || !tile)
        return { ok: true, ops: paths.size ? prepared : ops, paths, triggers, at: plannedAt };
      const outcome = planAutomation(shadow.world, doc, {
        scene, tile, token, method: candidate.method, caller, direction: candidate.direction,
        movementOriginal: { tokenId: candidate.tokenId, x: candidate.endpoint.x, y: candidate.endpoint.y },
        movementCrossing: candidate.crossing,
        ...(candidate.movementEntry ? { movementEntry: candidate.movementEntry } : {}),
        at: plannedAt, rng: this.rng,
        hurtHeal: planAutomationHealth,
        imageAssetError: (hash) => automationImageError(hash, this.manifestSource()),
      }, this.systemUserId);
      const key = movementAutomationKey(candidate.sceneId, candidate.tokenId, candidate.docId,
        candidate.tile._id, candidate.method);
      triggers.set(key, { outcome });
      if (!outcome.ok || "skipped" in outcome) continue;
      const applied = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: plannedAt, by: this.systemUserId,
        txId: `stop-plan-preview-${randomId()}`, ops: outcome.plan.ops });
      if (!applied.ok || !outcome.plan.stoppedMovement.includes(`${candidate.sceneId}\u0000${candidate.tokenId}`)) continue;
      const plannedGraph = shadow.get("automations", candidate.docId) as AutomationDocument | undefined;
      if (!plannedGraph || JSON.stringify(plannedGraph.state?.variables ?? null) !==
          JSON.stringify(doc.state?.variables ?? null)) continue;
      const settledScene = shadow.get("scenes", candidate.sceneId) as SceneDocument | undefined;
      const settled = settledScene?.tokens.find((item) => item._id === candidate.tokenId);
      if (!settled) continue;
      let stopPositionWrites = 0;
      const stopOnly = outcome.plan.ops.every((op) => {
        if (op.kind !== "update") return false;
        if (op.ref.coll === "automations" && op.ref.id === candidate.docId)
          return Object.keys(op.diff).every((field) => field === "state");
        if (op.ref.coll === "tokens" && op.ref.id === candidate.tokenId &&
            op.ref.parent?.coll === "scenes" && op.ref.parent.id === candidate.sceneId &&
            Object.keys(op.diff).every((field) => ["x", "y", "flags"].includes(field))) {
          stopPositionWrites++;
          return stopPositionWrites === 1;
        }
        return false;
      });
      if (!stopOnly) continue;
      paths.set(candidate.sourceKey, { endpoint: structuredClone(candidate.endpoint), stopFraction: candidate.fraction });
      if (candidate.endpoint.x !== settled.x || candidate.endpoint.y !== settled.y) prepared.push({
        kind: "update", ref: { coll: "tokens", id: candidate.tokenId,
          parent: { coll: "scenes", id: candidate.sceneId } }, diff: { x: settled.x, y: settled.y },
      });
    }
    return { ok: true, ops: paths.size ? prepared : ops, paths, triggers, at: plannedAt };
  }

  /**
   * For one moving token, evaluate the first movement graph that can stop it
   * against the exact post-intent shadow state. Reuse that plan after commit;
   * use it to clip the intent only when its writes are limited to the Stop
   * correction and root graph history. This preserves gates, random choices
   * and conditional branches without executing planners twice.
   */
  private preplanSingleTokenStop(
    ops: Op[], by: UserId, txId: TxId,
    source: { sceneId: string; tokenId: string; before: TokenDocument },
  ): { ok: true; ops: Op[]; paths: Map<string, PlannedMovementPath>;
    triggers: Map<string, PreplannedMovementTrigger>; at?: number } | { ok: false; error: string } {
    const unchanged = () => ({ ok: true as const, ops, paths: new Map<string, PlannedMovementPath>(),
      triggers: new Map<string, PreplannedMovementTrigger>() });
    const shadow = this.store.forkForPreflight();
    const preview = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by, txId, ops });
    if (!preview.ok) return unchanged(); // authoritative validation reports the original error
    const scene = shadow.get("scenes", source.sceneId) as SceneDocument | undefined;
    const endpoint = scene?.tokens.find((token) => token._id === source.tokenId);
    if (!scene || !endpoint || (source.before.x === endpoint.x && source.before.y === endpoint.y)) return unchanged();
    const definitions = shadow.getAll("automations");
    if (definitions.length > 4096) return unchanged();

    type Candidate = {
      doc: AutomationDocument; tile: TileDocument; method: "enter" | "exit"; fraction: number;
      crossing: NonNullable<AutomationEvent["movementCrossing"]>;
      movementEntry?: AutomationEvent["movementEntry"];
    };
    const dx = endpoint.x - source.before.x, dy = endpoint.y - source.before.y;
    const direction: AutomationEvent["direction"] = {
      ...(dx < -1e-6 ? { x: "left" as const } : dx > 1e-6 ? { x: "right" as const } : {}),
      ...(dy < -1e-6 ? { y: "up" as const } : dy > 1e-6 ? { y: "down" as const } : {}),
    };
    const candidates: Candidate[] = [];
    for (const doc of definitions) {
      const checked = validateAutomation(doc.definition);
      if (!checked.ok || checked.definition.sceneId !== scene._id) continue;
      const tile = automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind);
      if (!tile) continue;
      for (const hit of sweptTileEvents(tile, source.before, endpoint, scene.grid)) {
        if ((hit.method !== "enter" && hit.method !== "exit") || !checked.definition.methods.includes(hit.method)) continue;
        const contact = { x: source.before.x + dx * hit.fraction, y: source.before.y + dy * hit.fraction };
        const entry = hit.method === "enter" ? snapshotMoveEntry(tile, contact, true) : undefined;
        candidates.push({ doc, tile, method: hit.method, fraction: hit.fraction,
          crossing: { tileId: tile._id, tokenId: source.tokenId, method: hit.method,
            fraction: hit.fraction, ...contact },
          ...(entry ? { movementEntry: { ...entry, tileId: tile._id, tokenId: source.tokenId } } : {}) });
      }
    }
    const methodOrder = { enter: 0, exit: 1 } as const;
    candidates.sort((a, b) => a.fraction - b.fraction || methodOrder[a.method] - methodOrder[b.method] ||
      (b.tile.sort ?? 0) - (a.tile.sort ?? 0) || a.tile._id.localeCompare(b.tile._id) || a.doc._id.localeCompare(b.doc._id));
    const first = candidates[0];
    if (!first) return unchanged();
    const checked = validateAutomation(first.doc.definition);
    if (!checked.ok || !checked.definition.steps.some((step) => step.kind === "stopMovement")) return unchanged();
    // Avoid executing planner work for graphs that leave the bounded atomic
    // world-plan model (secondary movement, nested graphs or external actions).
    if (checked.definition.steps.some((step) => ["move", "rotate", "triggerTile", "sequence", "script", "summon", "resetHistory"]
      .includes(step.kind))) return unchanged();

    const plannedAt = this.now();
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    const event: AutomationEvent = {
      scene, tile: first.tile, token: endpoint, method: first.method, caller, direction,
      movementOriginal: { tokenId: source.tokenId, x: endpoint.x, y: endpoint.y },
      movementCrossing: first.crossing,
      ...(first.movementEntry ? { movementEntry: first.movementEntry } : {}),
      at: plannedAt, rng: this.rng,
    };
    const outcome = planAutomation(shadow.world, first.doc, { ...event,
      hurtHeal: planAutomationHealth,
      imageAssetError: (hash) => automationImageError(hash, this.manifestSource()),
    }, this.systemUserId);
    const key = movementAutomationKey(scene._id, source.tokenId, first.doc._id, first.tile._id, first.method);
    const triggers = new Map<string, PreplannedMovementTrigger>([[key, { outcome }]]);
    if (!outcome.ok || "skipped" in outcome ||
        !outcome.plan.stoppedMovement.includes(`${scene._id}\u0000${source.tokenId}`))
      return { ok: true, ops, paths: new Map(), triggers, at: plannedAt };

    // Preview the cached graph plan after the submitted endpoint to extract its
    // authoritative Stop result (including grid snap). The plan itself remains
    // a second, ordinary graph commit with its own receipt and undo boundary.
    const planned = shadow.applyEnvelope({ seq: shadow.seq + 1, ts: this.now(), by: this.systemUserId,
      txId: `stop-plan-preview-${randomId()}`, ops: outcome.plan.ops });
    if (!planned.ok) return { ok: true, ops, paths: new Map(), triggers, at: plannedAt };
    const plannedGraph = shadow.get("automations", first.doc._id) as AutomationDocument | undefined;
    if (!plannedGraph || JSON.stringify(plannedGraph.state?.variables ?? null) !==
        JSON.stringify(first.doc.state?.variables ?? null))
      return { ok: true, ops, paths: new Map(), triggers, at: plannedAt };
    const settledScene = shadow.get("scenes", source.sceneId) as SceneDocument | undefined;
    const settled = settledScene?.tokens.find((token) => token._id === source.tokenId);
    if (!settled) return { ok: true, ops, paths: new Map(), triggers, at: plannedAt };
    // Keep existing transaction/undo boundaries for graphs with additional world
    // effects. Only a token correction plus the root graph's own history update
    // may join the movement intent; all other successful plans run post-commit.
    let stopPositionWrites = 0;
    const stopOnly = outcome.plan.ops.every((op) => {
      if (op.kind !== "update") return false;
      if (op.ref.coll === "automations" && op.ref.id === first.doc._id)
        return Object.keys(op.diff).every((field) => field === "state");
      if (op.ref.coll === "tokens" && op.ref.id === source.tokenId &&
          op.ref.parent?.coll === "scenes" && op.ref.parent.id === scene._id &&
          Object.keys(op.diff).every((field) => ["x", "y", "flags"].includes(field))) {
        stopPositionWrites++;
        return stopPositionWrites === 1;
      }
      return false;
    });
    if (!stopOnly) return { ok: true, ops, paths: new Map(), triggers, at: plannedAt };

    const prepared = [...ops];
    if (endpoint.x !== settled.x || endpoint.y !== settled.y) prepared.push({
      kind: "update", ref: { coll: "tokens", id: source.tokenId, parent: { coll: "scenes", id: source.sceneId } },
      diff: { x: settled.x, y: settled.y },
    });
    triggers.set(key, { outcome });
    return { ok: true, ops: prepared,
      paths: new Map([[`${scene._id}\u0000${source.tokenId}`, {
        endpoint: structuredClone(endpoint), stopFraction: first.fraction,
      }]]), triggers, at: plannedAt };
  }

  /** Validate every identity-bearing action reference against host state and caller authority. */
  private actionReferenceError(action: ActionCard, by: UserId): string | null {
    const author = this.store.get("users", by) as UserDocument | undefined;
    const privileged = author?.role === "GM" || author?.role === "ASSISTANT";
    const viewer = author ? { id: by, role: author.role } : null;
    const sourceActor = action.source.actorId
      ? this.store.get("actors", action.source.actorId) as ActorDocument | undefined : undefined;
    if (!privileged) {
      if (!sourceActor || !author ||
          getEffectiveOwnership({ id: by, role: author.role }, sourceActor) < OWNERSHIP_LEVELS.OWNER)
        return "the action source actor is not owned or unavailable to its author";
    } else if (action.source.actorId && !sourceActor) return "the action source actor does not exist";
    if (action.source.itemId &&
        (!sourceActor || !sourceActor.items.some((item) => item._id === action.source.itemId)))
      return "the action source item does not belong to its actor";

    const scene = action.sceneId
      ? this.store.get("scenes", action.sceneId) as SceneDocument | undefined : undefined;
    if (action.sceneId && !scene) return "the action scene does not exist";
    if (!privileged && scene && (!viewer || !docVisibleTo(viewer, scene)))
      return "the action scene is not visible to its author";
    if (action.area && action.area.sceneId !== action.sceneId)
      return "the action area must belong to the action scene";
    const token = (id: string): TokenDocument | undefined => scene
      ? this.store.resolve({ coll: "tokens", id, parent: { coll: "scenes", id: scene._id } }) as TokenDocument | undefined
      : undefined;
    if (action.source.tokenId) {
      const sourceToken = token(action.source.tokenId);
      if (!sourceToken) return "the action source token is not in its scene";
      if (!privileged && (!viewer || !scene || !docVisibleTo(viewer, sourceToken, scene)))
        return "the action source token is not visible to its author";
      if (action.source.actorId && sourceToken.actorId !== action.source.actorId)
        return "the action source token and actor disagree";
    }
    for (const target of action.targets) {
      const targetActor = target.actorId
        ? this.store.get("actors", target.actorId) as ActorDocument | undefined : undefined;
      if (target.actorId && !targetActor)
        return privileged ? `action target ${target.key} actor does not exist`
          : `action target ${target.key} is unavailable to its author`;
      const targetToken = target.tokenId ? token(target.tokenId) : undefined;
      if (target.tokenId) {
        if (!targetToken) return privileged ? `action target ${target.key} token is not in its scene`
          : `action target ${target.key} is unavailable to its author`;
        if (!privileged && (!viewer || !scene || !docVisibleTo(viewer, targetToken, scene)))
          return `action target ${target.key} is unavailable to its author`;
        if (target.actorId && targetToken.actorId !== target.actorId)
          return `action target ${target.key} token and actor disagree`;
      }
      // A visible token may be named as a token-only target, but it must not turn its private
      // actor into a stats/evidence oracle merely because the caller copied the token's actorId.
      if (!privileged && targetActor && (!viewer || !docVisibleTo(viewer, targetActor)))
        return `action target ${target.key} is unavailable to its author`;
    }
    if (action.area?.ref) {
      const area = this.store.resolve({ coll: action.area.ref.kind === "region" ? "regions" : "templates",
        id: action.area.ref.id, parent: { coll: "scenes", id: action.area.sceneId } });
      if (!area) return "the action area reference does not exist";
      if (!privileged && (!viewer || !scene || !docVisibleTo(viewer, area, scene)))
        return "the action area reference is not visible to its author";
    }
    return null;
  }

  private hostRollEvidenceIdExists(rollId: string): boolean {
    return this.store.getAll("messages").some((message) => {
      const marker = message.system.rollEvidence;
      return isRecord(marker) && marker.v === 1 && marker.rollId === rollId;
    });
  }

  private actionEvidenceRollAlreadyUsed(rollId: string): boolean {
    return this.store.getAll("messages").some((message) => {
      const marker = message.system.rollEvidence;
      if (isRecord(marker) && marker.v === 1 && marker.rollId === rollId &&
          typeof marker.claimedBy === "string") return true;
      return actionCardOf(message)?.targets.some((target) => {
        if (target.provenance !== "host" || !isRecord(target.evidence?.payload)) return false;
        const payload = target.evidence.payload;
        return [payload.damageRollId, payload.srRollId, payload.saveRollId,
          ...(target.evidence.adapter === "pf1e.attack.v1" ? [payload.attackRollId] : [])]
          .includes(rollId);
      }) === true;
    });
  }

  private claimableHostRollEvidenceMessage(rollId: string, author: UserId): MessageDocument | null {
    const matches = this.store.getAll("messages").filter((message) => {
      const evidence = message.system.rollEvidence;
      return isRecord(evidence) && Object.keys(evidence).length === 2 && evidence.v === 1 &&
        evidence.rollId === rollId && message.author === author && message.flags.core?.rollId === rollId &&
        message.roll !== null && typeof message.roll?.formula === "string" &&
        typeof message.roll.total === "number" && Number.isFinite(message.roll.total);
    });
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  /** A durable roll fact can only be minted by handleRoll/handleRollReveal and claimed once. */
  private hostRollEvidence(
    rollId: string, author: UserId, reserved: ReadonlySet<string>,
  ): MessageDocument | null {
    if (reserved.has(rollId) || this.actionEvidenceRollAlreadyUsed(rollId)) return null;
    return this.claimableHostRollEvidenceMessage(rollId, author);
  }

  private pf1eEvidenceSourceStable(source: ActorDocument, ops: readonly Op[]): boolean {
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, parent: op.parent } : op.ref;
      if (ref.parent?.coll === "actors" && ref.parent.id === source._id &&
          (ref.coll === "items" || ref.coll === "effects")) return false;
      if ((op.kind === "create" && op.coll === "actors" && op.data._id === source._id) ||
          (op.kind === "delete" && op.ref.coll === "actors" && op.ref.id === source._id)) return false;
      if (op.kind !== "update" || op.ref.coll !== "actors" || op.ref.id !== source._id) continue;
      const unsafe = Object.keys(op.diff).some((key) => {
        if (key === "items" || key.startsWith("items.") || key === "effects" || key.startsWith("effects."))
          return true;
        if (!key.startsWith("system.pf1e")) return key === "system";
        return !key.startsWith("system.pf1e.spells.slotsUsed") &&
          !key.startsWith("system.pf1e.spells.prepared") &&
          key !== "system.pf1e.heldCharge" && key !== "system.pf1e.-=heldCharge";
      });
      if (unsafe) return false;
    }
    return true;
  }

  private pf1eLightningBoltCasterValid(actor: ActorDocument): boolean {
    const pf1e = isRecord(actor.system?.pf1e) ? actor.system.pf1e as Record<string, unknown> : {};
    const spells = isRecord(pf1e.spells) ? pf1e.spells : {};
    const known = Array.isArray(spells.known) ? spells.known : [];
    const derived = deriveFromActorDocument(actor);
    return spells.keyAbility === "cha" && derived.spellCasterLevel === 6 &&
      derived.spellSaveDc[3] === 17 && known.some((entry) => isRecord(entry) &&
        typeof entry.name === "string" && entry.name.trim().toLowerCase() === "lightning bolt" &&
        entry.level === 3 && (entry.slotLevel === undefined || entry.slotLevel === 3));
  }

  /**
   * D-407 spatial evidence for the starter spells. The host rebuilds the Entangle spread or
   * Lightning Bolt corridor from the committed scene geometry and verifies the target's entire
   * token footprint; client-authored area coordinates alone cannot claim a creature was hit.
   */
  private pf1eSpellAreaTargetVerified(action: ActionCard, target: ActionTarget, effectId: unknown): boolean {
    const area = action.area;
    if (!area) return action.targets.length === 1;
    if (action.targets.length !== 1 || area.sceneId !== action.sceneId ||
        !action.sceneId || !target.tokenId) return false;
    const scene = this.store.get("scenes", action.sceneId) as SceneDocument | undefined;
    const token = scene?.tokens.find((candidate) => candidate._id === target.tokenId);
    const casterToken = action.source.tokenId
      ? scene?.tokens.find((candidate) => candidate._id === action.source.tokenId) : undefined;
    if (!scene || !token || token.actorId !== target.actorId || !casterToken ||
        casterToken.actorId !== action.source.actorId || scene.grid.type !== "square") return false;
    const built = pf1eAreaGridFromScene(scene.grid);
    if (built.issues.length > 0 || built.grid.feetPerCell <= 0 || built.grid.cellSize <= 0) return false;

    if (effectId === "entangle" && action.label.trim().toLowerCase() === "entangle" &&
        area.shape === "spread" && area.radius === 40 && area.length === undefined &&
        area.units === "ft" && area.width === undefined && area.direction === undefined) {
      // The spread resolver has no cell-blocker geometry. Refuse to claim a host-verified area
      // across authored blocking walls rather than treating those walls as transparent.
      if (scene.walls.some((wall) => wall.move === 0 || wall.sight === 0)) return false;
      const col = area.origin.x / built.grid.cellSize;
      const row = area.origin.y / built.grid.cellSize;
      const unitsPerFoot = scene.grid.size / scene.grid.distance;
      if (!Number.isFinite(unitsPerFoot) || unitsPerFoot <= 0 ||
          Math.hypot(area.origin.x - casterToken.x, area.origin.y - casterToken.y) / unitsPerFoot > 640 ||
          !Number.isInteger(col) || !Number.isInteger(row) || area.origin.x < 0 || area.origin.y < 0 ||
          area.origin.x > scene.width || area.origin.y > scene.height) return false;
      const resolved = resolveAreaCells({ kind: "spread", origin: { col, row }, radiusFt: 40 }, built.grid);
      if (resolved.issues.length > 0) return false;
      return affectedTokens(resolved.cells, [token], built.grid).length === 1;
    }

    const sourceActor = action.source.actorId
      ? this.store.get("actors", action.source.actorId) as ActorDocument | undefined : undefined;
    if (effectId !== undefined || action.label.trim().toLowerCase() !== "lightning bolt" ||
        !sourceActor || !this.pf1eLightningBoltCasterValid(sourceActor) ||
        area.shape !== "line" || area.length !== 90 || area.width !== 5 || area.radius !== undefined ||
        area.units !== "ft" || !area.direction) return false;
    const directionLength = Math.hypot(area.direction.x, area.direction.y);
    if (!Number.isFinite(directionLength) || Math.abs(directionLength - 1) > 1e-6 ||
        Math.abs(area.origin.x - casterToken.x) > 1e-6 ||
        Math.abs(area.origin.y - casterToken.y) > 1e-6 ||
        area.origin.x < 0 || area.origin.y < 0 || area.origin.x > scene.width || area.origin.y > scene.height)
      return false;
    const line = { origin: area.origin, direction: area.direction, lengthFt: 90, widthFt: 5 };
    return lineIntersectsTokenFootprint(line, token, built.grid) &&
      !sightBlockedBetween(scene.walls, area.origin, { x: token.x, y: token.y });
  }

  /** Versioned PF1e adapter: rederive a normal spell target from immutable host roll facts/state. */
  private pf1eSpellTargetEvidenceVerified(
    action: ActionCard, target: ActionTarget, ops: readonly Op[], by: UserId,
    reserved: ReadonlySet<string>,
  ): boolean {
    const evidence = target.evidence;
    if (evidence?.adapter !== "pf1e.spellTarget.v1" || !isRecord(evidence.payload) ||
        action.kind !== "cast" || action.targets.length !== 1 || !action.source.actorId ||
        action.source.itemId !== undefined || !target.actorId || target.state !== "resolved" ||
        target.healing !== undefined || target.conditions !== undefined)
      return false;
    const payload = evidence.payload;
    const allowed = ["spellLevel", "saveType", "severity", "damageFormula", "energyType", "critical", "effectId",
      "damageRollId", "srRollId", "saveRollId", "combatId"];
    if (Object.keys(payload).some((key) => !allowed.includes(key)) ||
        (payload.effectId !== undefined && (typeof payload.effectId !== "string" ||
          pf1eSpellEffectById(payload.effectId) === null)) ||
        !this.pf1eSpellAreaTargetVerified(action, target, payload.effectId) ||
        !Number.isSafeInteger(payload.spellLevel) || (payload.spellLevel as number) < 0 ||
        (payload.spellLevel as number) > 9 || !["fort", "ref", "will"].includes(String(payload.saveType)) ||
        !(PF1E_SAVE_SEVERITIES as readonly unknown[]).includes(payload.severity) ||
        typeof payload.damageFormula !== "string" || payload.critical !== false ||
        (payload.energyType !== undefined && !(PF1E_ENERGY_TYPES as readonly unknown[]).includes(payload.energyType)) ||
        [payload.damageRollId, payload.srRollId, payload.saveRollId, payload.combatId]
          .some((id) => id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id))))
      return false;
    if (action.area?.shape === "line" &&
        (action.label.trim().toLowerCase() !== "lightning bolt" || payload.effectId !== undefined ||
          payload.spellLevel !== 3 || payload.saveType !== "ref" || payload.severity !== "half" ||
          payload.damageFormula !== "6d6" || payload.energyType !== "electricity")) return false;

    const suppliedRollIds = [payload.damageRollId, payload.srRollId, payload.saveRollId]
      .filter((id): id is string => typeof id === "string");
    if (new Set(suppliedRollIds).size !== suppliedRollIds.length) return false;
    if (payload.damageFormula !== "") {
      const damageMatch = /^(\d+)[dD](\d+)$/.exec(payload.damageFormula.trim());
      if (!damageMatch || Number(damageMatch[1]) < 1 || Number(damageMatch[1]) > 100 ||
          Number(damageMatch[2]) < 2 || Number(damageMatch[2]) > 1_000) return false;
    }
    const source = this.store.get("actors", action.source.actorId) as ActorDocument | undefined;
    const defender = this.store.get("actors", target.actorId) as ActorDocument | undefined;
    if (!source || !defender) return false;
    const caster = deriveFromActorDocument(source);
    const defended = deriveFromActorDocument(defender);
    if (!this.pf1eEvidenceSourceStable(source, ops)) return false;
    const roll = (id: unknown, formula: string): number | null => {
      if (typeof id !== "string") return null;
      const message = this.hostRollEvidence(id, by, reserved);
      if (!message?.roll || message.roll.formula !== formula || !Number.isSafeInteger(message.roll.total)) return null;
      return message.roll.total;
    };

    let damage = 0;
    if (payload.damageFormula === "") {
      if (payload.damageRollId !== undefined) return false;
    } else {
      const total = roll(payload.damageRollId, payload.damageFormula);
      if (total === null) return false;
      damage = Math.max(0, Math.trunc(total));
    }

    const evidenceCombat = typeof payload.combatId === "string"
      ? this.store.get("combats", payload.combatId) as CombatDocument | undefined : undefined;
    if (payload.combatId !== undefined && !evidenceCombat) return false;
    const spellResistance = defended.spellResistance;
    const srBlob = evidenceCombat ? srOvercomeBlobFromFlags(evidenceCombat.flags) : null;
    const alreadyOvercome = !!evidenceCombat && evidenceCombat.round >= 1 && !!srBlob &&
      srAlreadyOvercome(srBlob, source._id, defender._id, evidenceCombat.round);
    let sr = { resisted: false, total: null, reused: false, issues: [] } as ReturnType<typeof spellResistanceCheck>;
    if (spellResistance > 0) {
      if (alreadyOvercome) {
        if (payload.srRollId !== undefined) return false;
        sr = { resisted: false, total: null, reused: true, issues: [] };
      } else if (typeof payload.srRollId === "string") {
        const die = roll(payload.srRollId, "1d20");
        if (die === null || die < 1 || die > 20) return false;
        sr = spellResistanceCheck({ die, casterLevel: caster.spellCasterLevel, spellResistance });
        if (sr.issues.length > 0) return false;
      } else return false;
    } else if (payload.srRollId !== undefined) return false;

    const freshSrSuccess = !sr.resisted && !sr.reused && sr.total !== null;
    if (freshSrSuccess && (!evidenceCombat || evidenceCombat.round < 1)) return false;
    const expectedLedger = freshSrSuccess && evidenceCombat
      ? srOvercomeDiff(source._id, defender._id, evidenceCombat.round) : null;
    if (evidenceCombat) {
      for (const op of ops) {
        if ((op.kind === "create" && op.coll === "combats" && op.data._id === evidenceCombat._id) ||
            (op.kind === "delete" && op.ref.coll === "combats" && op.ref.id === evidenceCombat._id))
          return false;
        if (op.kind !== "update" || op.ref.coll !== "combats" || op.ref.id !== evidenceCombat._id) continue;
        if (!expectedLedger || Object.entries(op.diff).some(([key, value]) =>
          !Object.hasOwn(expectedLedger, key) || expectedLedger[key] !== value)) return false;
      }
    }
    if (expectedLedger && !ops.some((op) => op.kind === "update" && op.ref.coll === "combats" &&
        op.ref.id === evidenceCombat?._id && Object.entries(expectedLedger)
          .every(([key, value]) => op.diff[key] === value))) return false;

    const severity = payload.severity as PF1eSaveSeverity;
    const saveType = payload.saveType as PF1eSaveType;
    const spellLevel = payload.spellLevel as number;
    const allowsSave = severity !== "none" && !sr.resisted;
    const saveBonus = saveType === "fort" ? defended.saves.fort
      : saveType === "ref" ? defended.saves.ref : defended.saves.will;
    const dc = caster.spellSaveDc[spellLevel] ?? null;
    let saveDie: number | undefined;
    if (allowsSave) {
      if (dc === null) return false;
      const die = roll(payload.saveRollId, "1d20");
      if (die === null || die < 1 || die > 20) return false;
      saveDie = die;
    } else if (payload.saveRollId !== undefined) return false;

    const energyResistance = Object.fromEntries(Object.entries(defended.energyResistance)
      .filter(([, value]) => value > 0));
    const result = resolveSpellTarget({
      damage,
      ...(payload.energyType !== undefined ? { energyType: payload.energyType as PF1eEnergyType } : {}),
      severity,
      saveType,
      dc: dc ?? 0,
      saveBonus,
      ...(saveDie !== undefined ? { saveDie } : {}),
      evasion: hasPF1eFeat(defender.items.map((item) => item.name), "Evasion"),
      improvedEvasion: hasPF1eFeat(defender.items.map((item) => item.name), "Improved Evasion"),
      defender: Object.keys(energyResistance).length > 0 ? { energyResistance } : {},
      ...(spellResistance > 0 ? { sr } : {}),
    });
    if (!result.ok) return false;
    const expectedOutcome = result.resisted ? "resisted"
      : allowsSave ? result.passed ? "saved" : "failedSave" : "affected";
    const prevented = result.saveReduced + Object.values(result.erApplied)
      .reduce((sum, value) => sum + (value ?? 0), 0);
    if (target.outcome !== expectedOutcome || (target.damage?.dealt ?? 0) !== result.dealt ||
        (target.damage?.prevented ?? 0) !== prevented) return false;

    if (allowsSave) {
      const expectedFormula = `1d20${saveBonus === 0 ? "" : saveBonus > 0 ? `+${saveBonus}` : String(saveBonus)}`;
      if (!target.check || target.check.kind !== "save" || target.check.status !== "resolved" ||
          target.check.formula !== expectedFormula || target.check.dc !== dc ||
          target.check.total !== (saveDie as number) + saveBonus || target.check.saveType !== saveType ||
          target.check.passed !== result.passed || (target.check.automatic ?? null) !== result.automatic)
        return false;
    } else if (target.check !== undefined) return false;

    const expectedHp = defended.hp - result.dealt;
    let stagedHp = defended.hp;
    let hpTouched = false;
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, parent: op.parent } : op.ref;
      if (ref.parent?.coll === "actors" && ref.parent.id === defender._id &&
          (ref.coll === "items" || ref.coll === "effects")) return false;
      if ((op.kind === "create" && op.coll === "actors" && op.data._id === defender._id) ||
          (op.kind === "delete" && op.ref.coll === "actors" && op.ref.id === defender._id)) return false;
      if (op.kind !== "update" || op.ref.coll !== "actors" || op.ref.id !== defender._id) continue;
      const keys = Object.keys(op.diff);
      if (keys.some((key) => key === "system" || key === "system.pf1e" ||
          key === "system.pf1e.-=hp" || key.startsWith("system.pf1e.hp.") ||
          key.startsWith("system.pf1e.") && key !== "system.pf1e.hp" ||
          key === "items" || key.startsWith("items.") || key === "effects" || key.startsWith("effects.")))
        return false;
      if (Object.hasOwn(op.diff, "system.pf1e.hp")) {
        const hp = op.diff["system.pf1e.hp"];
        if (!Number.isSafeInteger(hp)) return false;
        stagedHp = hp as number;
        hpTouched = true;
      }
    }
    if (stagedHp !== expectedHp || result.dealt > 0 && !hpTouched) return false;
    return true;
  }

  private pf1ePendingSaveEvidenceVerified(
    action: ActionCard, target: ActionTarget, ops: readonly Op[],
  ): boolean {
    const evidence = target.evidence;
    if (evidence?.adapter !== "pf1e.pendingSave.v1" || !isRecord(evidence.payload) ||
        Object.keys(evidence.payload).some((key) => !["spellLevel", "saveType"].includes(key)) ||
        !Number.isSafeInteger(evidence.payload.spellLevel) || (evidence.payload.spellLevel as number) < 0 ||
        (evidence.payload.spellLevel as number) > 9 ||
        !["fort", "ref", "will"].includes(String(evidence.payload.saveType)) || action.kind !== "cast" ||
        !action.source.actorId || action.source.itemId !== undefined || !target.actorId ||
        target.state !== "pending" || target.outcome !== "pending" || target.check?.kind !== "save" ||
        target.check.status !== "pending" || target.damage !== undefined || target.healing !== undefined ||
        target.conditions !== undefined || action.area !== undefined &&
          !this.pf1eSpellAreaTargetVerified(action, target,
            action.label.trim().toLowerCase() === "entangle" ? "entangle" : undefined)) return false;
    const source = this.store.get("actors", action.source.actorId) as ActorDocument | undefined;
    const defender = this.store.get("actors", target.actorId) as ActorDocument | undefined;
    if (!source || !defender || !this.pf1eEvidenceSourceStable(source, ops)) return false;
    if (defender._id !== source._id) {
      for (const op of ops) {
        const ref = op.kind === "create" ? { coll: op.coll, parent: op.parent } : op.ref;
        if (ref.parent?.coll === "actors" && ref.parent.id === defender._id &&
            (ref.coll === "items" || ref.coll === "effects")) return false;
        if ((op.kind === "create" && op.coll === "actors" && op.data._id === defender._id) ||
            (op.kind === "delete" && op.ref.coll === "actors" && op.ref.id === defender._id)) return false;
        if (op.kind === "update" && op.ref.coll === "actors" && op.ref.id === defender._id &&
            Object.keys(op.diff).some((key) => key === "system" || key.startsWith("system.pf1e") ||
              key === "items" || key.startsWith("items.") || key === "effects" || key.startsWith("effects.")))
          return false;
      }
    }
    const caster = deriveFromActorDocument(source);
    const defended = deriveFromActorDocument(defender);
    const spellLevel = evidence.payload.spellLevel as number;
    const saveType = evidence.payload.saveType as PF1eSaveType;
    if (action.area?.shape === "line" &&
        (action.label.trim().toLowerCase() !== "lightning bolt" || spellLevel !== 3 ||
          saveType !== "ref" || !this.pf1eLightningBoltCasterValid(source))) return false;
    const dc = caster.spellSaveDc[spellLevel] ?? null;
    const bonus = saveType === "fort" ? defended.saves.fort
      : saveType === "ref" ? defended.saves.ref : defended.saves.will;
    const formula = `1d20${bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : String(bonus)}`;
    return dc !== null && target.check.dc === dc && target.check.saveType === saveType &&
      target.check.formula === formula && target.check.total === null &&
      typeof target.check.pendingRollId === "string";
  }

  private actionTargetEvidenceVerified(
    action: ActionCard, target: ActionTarget, ops: readonly Op[], by: UserId,
    reserved: ReadonlySet<string>,
  ): boolean {
    try {
      if (target.evidence?.adapter === "pf1e.pendingSave.v1")
        return this.pf1ePendingSaveEvidenceVerified(action, target, ops);
      if (target.evidence?.adapter === "pf1e.attack.v1")
        return this.pf1eAttackEvidenceVerified(action, target, by, reserved);
      if ((target.riders?.length ?? 0) > 0) return this.pf1eRiderEvidenceVerified(action, target);
      return this.pf1eSpellTargetEvidenceVerified(action, target, ops, by, reserved);
    } catch {
      // Evidence can upgrade presentation authority only; malformed/unsupported state fails closed.
      return false;
    }
  }

  /**
   * Versioned attack adapter: the reported strike is host-verified when every number on the row
   * re-derives from the attack-roll message the submitting user's own host roll produced. The
   * reported AC is the one consistency claim the host cannot rederive (it is the table's chosen
   * defense), so the outcome must at least agree with that AC.
   */
  private pf1eAttackEvidenceVerified(
    action: ActionCard, target: ActionTarget, by: UserId, reserved: ReadonlySet<string>,
  ): boolean {
    const evidence = target.evidence;
    if (evidence?.adapter !== "pf1e.attack.v1" || !isRecord(evidence.payload) ||
        action.kind !== "attack" || action.targets.length !== 1 || !action.source.actorId ||
        action.source.itemId !== undefined || !target.actorId || target.state !== "resolved" ||
        target.healing !== undefined || target.conditions !== undefined ||
        (target.outcome !== "hit" && target.outcome !== "miss")) return false;
    const check = target.check;
    if (!check || check.kind !== "attack" || check.status !== "resolved" ||
        typeof check.formula !== "string" || !Number.isSafeInteger(check.total) ||
        !Number.isSafeInteger(check.dc) || (check.dc as number) < 1 ||
        (target.outcome === "hit") !== ((check.total as number) >= (check.dc as number))) return false;
    const payload = evidence.payload;
    if (Object.keys(payload).some((key) =>
      !["attackRollId", "damageRollId", "damageFormula", "damageRollTotal"].includes(key))) return false;
    if (typeof payload.attackRollId !== "string") return false;
    const source = this.store.get("actors", action.source.actorId) as ActorDocument | undefined;
    const defender = this.store.get("actors", target.actorId) as ActorDocument | undefined;
    if (!source || !defender) return false;
    const attackRoll = this.hostRollEvidence(payload.attackRollId, by, reserved);
    if (!attackRoll?.roll || attackRoll.roll.formula !== check.formula ||
        attackRoll.roll.total !== check.total) return false;
    const dealt = Math.max(0, Math.trunc(target.damage?.dealt ?? 0));
    if (target.outcome === "miss") {
      if (payload.damageRollId !== undefined || payload.damageFormula !== undefined ||
          payload.damageRollTotal !== undefined || dealt !== 0) return false;
    } else if (dealt > 0 || target.damage !== undefined) {
      // The host cannot rederive mitigation (DR is a defender fact the card does not carry), so it
      // proves the floor instead: the reported damage came from a host roll of the claimed formula
      // and never exceeds that roll's own total.
      if (typeof payload.damageRollId !== "string" || typeof payload.damageFormula !== "string" ||
          !Number.isSafeInteger(payload.damageRollTotal)) return false;
      const damageRoll = this.hostRollEvidence(payload.damageRollId, by, reserved);
      if (!damageRoll?.roll || damageRoll.roll.formula !== payload.damageFormula ||
          damageRoll.roll.total !== payload.damageRollTotal || dealt > (payload.damageRollTotal as number))
        return false;
    } else if (payload.damageRollId !== undefined) return false;
    return true;
  }

  /**
   * Re-derive a rider card's delivery facts from host state. The card never supplies a definition,
   * DC, dose count or source it cannot prove: every poison rider must name the shipped profile, a
   * landed interaction source, a recomputable base DC and the exact exposure DC the save is rolled
   * against, and every condition rider must name a catalogue effect that applies that condition on
   * the row's own outcome (D-407).
   */
  private pf1eRiderEvidenceVerified(action: ActionCard, target: ActionTarget): boolean {
    if (action.v < 2 || action.kind !== "attack" && action.kind !== "cast" ||
        !action.source.actorId || !target.actorId) return false;
    const defenders = this.store.get("actors", target.actorId) as ActorDocument | undefined;
    if (!defenders) return false;
    for (const rider of target.riders ?? []) {
      if (rider.kind === "condition") {
        // D-407: the condition must be one the catalogue applies, on this row, on its own outcome.
        const payload = rider.evidence?.adapter === "pf1e.spellEffect.v1" ? rider.evidence.payload : null;
        if (!isRecord(payload) || Object.keys(payload).some((key) =>
          !["effectId", "version", "condition", "actionId", "targetKey"].includes(key))) return false;
        const effect = typeof payload.effectId === "string" && Number.isSafeInteger(payload.version)
          ? pf1eSpellEffectById(payload.effectId, payload.version as number) : null;
        if (!effect || typeof payload.condition !== "string" ||
            !effect.conditions.includes(payload.condition)) return false;
        if (payload.actionId !== action.id || payload.targetKey !== target.key) return false;
        if (rider.state !== "applied" || !pf1eSpellEffectLanded(effect, target.outcome)) return false;
        continue;
      }
      if (rider.kind !== "poison") return false;
      const payload = rider.evidence?.adapter === "pf1e.poison.v1" ? rider.evidence.payload : null;
      if (!isRecord(payload) || Object.keys(payload).some((key) => ![
        "definitionId", "version", "baseDC", "route", "doseCount", "exposureId", "newCourseId",
        "sourceActorId", "sourceItemId"].includes(key))) return false;
      const { definitionId, version, baseDC, route, doseCount } = payload;
      if (typeof definitionId !== "string" || !Number.isSafeInteger(version) ||
          !Number.isSafeInteger(baseDC) || (baseDC as number) < 1 || (baseDC as number) > 99 ||
          typeof route !== "string" || !Number.isSafeInteger(doseCount) || (doseCount as number) < 1 ||
          (doseCount as number) > 100_000) return false;
      const definition = PF1E_POISON_FIXTURES.find((entry) =>
        entry.id === definitionId && entry.version === version);
      if (!definition || !definition.delivery.includes(route as PF1ePoisonDefinition["delivery"][number]))
        return false;
      const sourceActorId = typeof payload.sourceActorId === "string" ? payload.sourceActorId : undefined;
      const sourceItemId = typeof payload.sourceItemId === "string" ? payload.sourceItemId : undefined;
      if (sourceActorId !== action.source.actorId || sourceItemId !== action.source.itemId) return false;
      let expectedBase = definition.baseDC;
      if (definition.dcSource === "creature-derived") {
        const source = sourceActorId
          ? this.store.get("actors", sourceActorId) as ActorDocument | undefined : undefined;
        const hitDice = source ? this.poisonBlock(source).hitDice : undefined;
        const conModifier = source ? deriveFromActorDocument(source).abilityMods.con : NaN;
        const derived = source && Number.isSafeInteger(hitDice)
          ? pf1eCreaturePoisonBaseDc(hitDice as number, conModifier) : null;
        if (derived === null) return false;
        expectedBase = derived;
      }
      if (baseDC !== expectedBase) return false;
      const identity = pf1ePoisonDefinitionIdentity(definition);
      const snapshot = this.poisonStateSnapshot(defenders);
      if (!snapshot.ok || snapshot.state.delayPoison.active || this.poisonImmune(defenders)) return false;
      const active = Object.values(snapshot.state.courses).find((course) =>
        course.definitionIdentity === identity && (course.state === "active" || course.state === "onset"));
      const expectedDc = pf1ePoisonExposureSaveDc(expectedBase, active?.doseCount ?? 0, doseCount as number);
      if (rider.state === "pending") {
        if (!rider.save || expectedDc === null || rider.save.dc !== expectedDc ||
            rider.save.saveType !== definition.saveType || rider.save.total !== null ||
            rider.save.passed !== undefined || rider.save.pendingRollId === undefined) return false;
      } else if (rider.save !== undefined && rider.save.saveType !== definition.saveType) {
        return false;
      }
    }
    return true;
  }

  /** Replace client-authored identity labels with names from the referenced host documents. */
  private canonicalActionNames(
    action: ActionCard, ops: readonly Op[], by: UserId, reserved: ReadonlySet<string>,
  ): ActionCard {
    const scene = action.sceneId
      ? this.store.get("scenes", action.sceneId) as SceneDocument | undefined : undefined;
    const token = (id: string | undefined): TokenDocument | undefined => id && scene
      ? this.store.resolve({ coll: "tokens", id, parent: { coll: "scenes", id: scene._id } }) as TokenDocument | undefined
      : undefined;
    const sourceActor = action.source.actorId
      ? this.store.get("actors", action.source.actorId) as ActorDocument | undefined : undefined;
    const sourceItem = action.source.itemId
      ? sourceActor?.items.find((item) => item._id === action.source.itemId) : undefined;
    const sourceName = sourceItem?.name ?? token(action.source.tokenId)?.name ?? sourceActor?.name ?? action.source.name;
    return {
      ...action,
      source: { ...action.source, name: sourceName },
      targets: action.targets.map((target) => {
        const actor = target.actorId
          ? this.store.get("actors", target.actorId) as ActorDocument | undefined : undefined;
        const name = token(target.tokenId)?.name ?? actor?.name ?? target.name;
        // A non-mechanical pending stage is a host-normalized lifecycle fact. Pending check inputs
        // and terminal mechanics become host facts only when a versioned adapter rederives them.
        const provenance = (target.state === "pending" && target.check === undefined) ||
          this.actionTargetEvidenceVerified(action, target, ops, by, reserved)
          ? "host" as const : "reported" as const;
        return { ...target, name, provenance };
      }),
    };
  }

  /** Host-side normalization: chat messages carry the caller's identity (§4);
   * inline `[[formula]]` rolls are resolved HERE (§11: rolls execute on the
   * host) and embedded as `[[total|formula]]` chips in the committed content. */
  private normalizeOps(
    by: UserId,
    ops: Op[],
  ): { ok: true; ops: Op[]; hostOps: Op[] } | { ok: false; error: string } {
    const out: Op[] = [];
    const hostOps: Op[] = [];
    const actionEvidenceClaims = new Set<string>();
    const newActionMessageIds = new Set(ops.flatMap((op) =>
      op.kind === "create" && op.coll === "messages" && op.data.system.action !== undefined
        ? [op.data._id] : []));
    for (const op of ops) {
      if ((op.kind === "delete" || op.kind === "update") && op.ref.coll === "messages" &&
          newActionMessageIds.has(op.ref.id))
        return { ok: false, error: "a new action card cannot be changed in its creation envelope" };
      if (op.kind === "delete" && op.ref.coll === "messages") {
        const existing = this.store.get("messages", op.ref.id) as MessageDocument | undefined;
        if (actionCardOf(existing))
          return { ok: false, error: "action cards change only through host lifecycle" };
        if (existing?.system.pf1ePoison !== undefined)
          return { ok: false, error: "poison action messages are host-owned and immutable" };
        if (existing?.system.pf1eCondition !== undefined)
          return { ok: false, error: "condition action messages are host-owned and immutable" };
        if (existing?.system.rollEvidence !== undefined)
          return { ok: false, error: "host roll evidence is immutable" };
      }
      if (op.kind === "update" && op.ref.coll === "messages") {
        const keys = Object.keys(op.diff);
        const existing = this.store.get("messages", op.ref.id) as MessageDocument | undefined;
        const rootSystem = op.diff.system;
        const rootIntroducesAction = isRecord(rootSystem) && Object.hasOwn(rootSystem, "action");
        const changesAction = keys.some((key) => key === "system.action" || key === "system.-=action" ||
          key.startsWith("system.action.") || key === "system" &&
            (existing?.system.action !== undefined || rootIntroducesAction));
        const changesLinkedPending = actionCardOf(existing) &&
          keys.some((key) => key === "system.pendingRoll" || key === "system.pendingRolls" ||
            key === "system.-=pendingRoll" || key === "system.-=pendingRolls" ||
            key.startsWith("system.pendingRoll.") || key.startsWith("system.pendingRolls."));
        if (existing?.system.pf1ePoison !== undefined)
          return { ok: false, error: "poison action messages are host-owned and immutable" };
        if (existing?.system.pf1eCondition !== undefined)
          return { ok: false, error: "condition action messages are host-owned and immutable" };
        const existingRollEvidence = existing?.system.rollEvidence !== undefined;
        const introducesRollEvidence = isRecord(rootSystem) && Object.hasOwn(rootSystem, "rollEvidence");
        const changesRollEvidence = keys.some((key) => key === "system.rollEvidence" ||
          key === "system.-=rollEvidence" || key.startsWith("system.rollEvidence.")) || introducesRollEvidence ||
          existingRollEvidence && keys.some((key) => key === "system" || key === "roll" || key === "-=roll" ||
            key.startsWith("roll.") || key === "author" || key === "-=author" || key === "flags" ||
            key === "flags.core" || key === "flags.-=core" || key.startsWith("flags.core."));
        if (changesRollEvidence)
          return { ok: false, error: "host roll evidence is immutable" };
        if (changesAction || changesLinkedPending)
          return { ok: false, error: "action cards change only through host resolution" };
      }
      if (op.kind === "create" && op.coll === "messages") {
        const data = structuredClone(op.data) as MessageDocument;
        const rollClaims: Array<{ messageId: string; actionId: string }> = [];
        data.author = by;
        if (data.system.rollEvidence !== undefined)
          return { ok: false, error: "host roll evidence is host-owned" };
        if (data.system.pf1eCondition !== undefined || data.system.pf1ePoison !== undefined)
          return { ok: false, error: "host action messages are host-owned" };
        if (data.whisper === undefined) data.whisper = [];
        data.content = resolveInlineRolls(data.content, this.rng);
        // A structured action is not arbitrary chat metadata: validate the complete bounded
        // schema, then bind its identity/time to this host-committed message. Malformed cards
        // fail the whole envelope rather than rendering prose that disagrees with FX context.
        if (data.system.action !== undefined) {
          const checked = validateActionCard(data.system.action);
          if (!checked.ok) return { ok: false, error: checked.error };
          const normalized = normalizeNewActionCard(checked.action, data._id, this.now());
          const referenceError = this.actionReferenceError(normalized, by);
          if (referenceError) return { ok: false, error: referenceError };
          const canonical = validateActionCard(
            this.canonicalActionNames(normalized, ops, by, actionEvidenceClaims),
          );
          if (!canonical.ok) return { ok: false, error: `canonical action is invalid: ${canonical.error}` };
          const action = canonical.action;
          for (const target of action.targets) {
            if (target.provenance !== "host" || target.state === "pending" ||
                !isRecord(target.evidence?.payload)) continue;
            const claimKeys = target.evidence?.adapter === "pf1e.attack.v1"
              ? ["attackRollId", "damageRollId"] as const
              : ["damageRollId", "srRollId", "saveRollId"] as const;
            for (const key of claimKeys) {
              const rollId = target.evidence.payload[key];
              if (typeof rollId === "string") {
                const rollMessage = this.claimableHostRollEvidenceMessage(rollId, by);
                if (!rollMessage) return { ok: false, error: "verified roll evidence is no longer claimable" };
                actionEvidenceClaims.add(rollId);
                rollClaims.push({ messageId: rollMessage._id, actionId: action.id });
              }
            }
          }
          data.system.action = actionAsJson(action);
          const rawPending = data.system.pendingRoll;
          const rawPendingMany = data.system.pendingRolls;
          if ((rawPending !== undefined && rawPendingMany !== undefined) ||
              (rawPending !== undefined && !validatePendingRoll(rawPending).ok) ||
              (rawPendingMany !== undefined && (!Array.isArray(rawPendingMany) ||
                rawPendingMany.length > PENDING_ROLL_MAX ||
                rawPendingMany.some((value) => !validatePendingRoll(value).ok))))
            return { ok: false, error: "pending roll/action storage is invalid" };
          const hostTurn = this.currentTurnNumber();
          const normalizePending = (pending: PendingRoll): PendingRoll => {
            const target = action.targets.find((candidate) => candidate.key === pending.targetKey);
            const sourceActor = action.source.actorId
              ? this.store.get("actors", action.source.actorId) as ActorDocument | undefined : undefined;
            return {
              ...pending,
              initiator: { ...pending.initiator, name: sourceActor?.name ?? action.source.name },
              target: { ...pending.target, name: target?.name ?? pending.target.name },
              turnNumber: hostTurn,
              expiresTurn: hostTurn + 2,
            };
          };
          if (rawPending !== undefined) {
            const checked = validatePendingRoll(rawPending);
            if (checked.ok) data.system.pendingRoll = normalizePending(checked.pending) as unknown as Json;
          } else if (Array.isArray(rawPendingMany)) {
            data.system.pendingRolls = rawPendingMany.map((value) => {
              const checked = validatePendingRoll(value);
              return normalizePending((checked as { ok: true; pending: PendingRoll }).pending);
            }) as unknown as Json;
          }
          const pendingRolls = pendingRollsOfSystem(data.system);
          const linkedPending = pendingRolls.filter((pending) => pending.actionId !== undefined);
          const pendingChecks = action.targets.filter((target) => target.check?.status === "pending");
          const pendingRiders = action.targets.flatMap((target) => (target.riders ?? [])
            .filter((rider) => rider.state === "pending" && rider.save?.pendingRollId !== undefined)
            .map((rider) => ({ target, rider })));
          const pendingIds = new Set(linkedPending.map((pending) => pending.id));
          const pendingTargetKeys = new Set(linkedPending.map((pending) => pending.targetKey));
          if (linkedPending.length !== pendingRolls.length ||
              linkedPending.length !== pendingChecks.length + pendingRiders.length ||
              pendingIds.size !== linkedPending.length || pendingTargetKeys.size !== linkedPending.length ||
              linkedPending.some((pending) => {
            const target = action.targets.find((candidate) => candidate.key === pending.targetKey);
            if (pending.v !== 1 || typeof pending.id !== "string" || pending.actionId !== action.id ||
                pending.resolved !== false || pending.initiator?.actorId !== action.source.actorId ||
                pending.initiator.tokenId !== (action.source.tokenId ?? null) || !target ||
                pending.target?.actorId !== target.actorId ||
                pending.target?.tokenId !== (target.tokenId ?? null)) return true;
            if (target.check?.status === "pending" && target.check.pendingRollId === pending.id)
              return pending.formula !== target.check.formula || pending.dc !== target.check.dc ||
                pending.kind !== target.check.kind || pending.saveType !== target.check.saveType;
            const rider = pendingRiders.find((entry) => entry.target === target &&
              entry.rider.save?.pendingRollId === pending.id)?.rider;
            if (!rider?.save || pending.kind !== "save" || pending.dc !== rider.save.dc ||
                pending.saveType !== rider.save.saveType) return true;
            const defender = target.actorId
              ? this.store.get("actors", target.actorId) as ActorDocument | undefined : undefined;
            if (!defender) return true;
            const bonus = deriveFromActorDocument(defender).saves[rider.save.saveType];
            const formula = `1d20${bonus === 0 ? "" : bonus > 0 ? `+${bonus}` : String(bonus)}`;
            return pending.formula !== formula;
          })) return { ok: false, error: "pending roll/action linkage is invalid" };
        }
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
        for (const claim of rollClaims) hostOps.push({
          kind: "update",
          ref: { coll: "messages", id: claim.messageId },
          diff: { "system.rollEvidence.claimedBy": claim.actionId },
        });
        continue;
      }
      out.push(op);
    }
    return { ok: true, ops: out, hostOps };
  }

  /** A saved graph never trusts a client-supplied step, anchor or media identifier. */
  private automationDocumentError(
    doc: AutomationDocument,
    stagedScenes?: ReadonlyMap<string, SceneDocument>,
  ): string | null {
    if (doc.type !== "automation") return "automation document type required";
    const checked = validateAutomation(doc.definition);
    if (!checked.ok) return checked.error;
    if (!validateAutomationState(doc.state)) return "invalid trigger history";
    const sceneById = (id: string) => stagedScenes?.get(id) ?? this.store.get("scenes", id) as SceneDocument | undefined;
    const scene = sceneById(checked.definition.sceneId);
    if (!scene || !automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind))
      return "automation anchor source/scene does not exist";
    for (const step of checked.definition.steps) {
      if ((step.kind === "select" || step.kind === "collection") && step.selector) {
        const error = pinnedSelectorError(scene, step.selector);
        if (error) return `${step.id}: ${error}`;
      }
      if (step.kind === "move" && step.destination && !scene[step.destination.coll].some((item) => item._id === step.destination?.id))
        return `${step.id}: Move destination entity is unavailable`;
      if (step.kind === "sceneBackground" && step.targetSceneId && !sceneById(step.targetSceneId))
        return `${step.id}: Scene Background target scene is unavailable`;
      // TR-12: a redirect names its graph, so the reference can be checked now — the
      // target must exist, validate, share this scene and own a real anchor. The invoked
      // method is only knowable at trigger time when it is inherited.
      if (step.kind === "redirect") {
        if (step.automationId === doc._id) return `${step.id}: a redirect cannot target its own graph`;
        const target = this.store.get("automations", step.automationId) as AutomationDocument | undefined;
        const targetChecked = target ? validateAutomation(target.definition) : null;
        if (!target || !targetChecked?.ok)
          return `${step.id}: redirect target is not a saved graph in this world`;
        if (targetChecked.definition.sceneId !== checked.definition.sceneId)
          return `${step.id}: a redirect fires a graph in this scene only`;
        const targetScene = sceneById(targetChecked.definition.sceneId);
        if (!targetScene || !automationSourceTile(targetScene, targetChecked.definition.tileId,
          targetChecked.definition.sourceKind)) return `${step.id}: redirect target has no anchor in this scene`;
        if (step.method === "manual" && !targetChecked.definition.methods.includes("manual"))
          return `${step.id}: redirect target does not accept the manual method`;
      }
      // MC-02: a Call Macro step names a saved macro, so the reference is checkable where it
      // is authored — and the called graph must already pass the same rules the plan will
      // re-apply (this scene, a real anchor, `manual`).
      if (step.kind === "callMacro") {
        const macro = this.store.get("macros", step.macroId) as MacroDocument | undefined;
        const graphId = macro?.kind === "automation" ? macroAutomationGraphId(macro) : null;
        const target = graphId ? this.store.get("automations", graphId) as AutomationDocument | undefined : undefined;
        const targetChecked = target ? validateAutomation(target.definition) : null;
        if (!macro || !graphId || !target || !targetChecked?.ok)
          return `${step.id}: called macro is not a saved automation macro in this world`;
        if (graphId === doc._id) return `${step.id}: a called macro cannot call its own graph`;
        if (targetChecked.definition.sceneId !== checked.definition.sceneId)
          return `${step.id}: a called macro fires a graph in this scene only`;
        const targetScene = sceneById(targetChecked.definition.sceneId);
        if (!targetScene || !automationSourceTile(targetScene, targetChecked.definition.tileId,
          targetChecked.definition.sourceKind)) return `${step.id}: called macro has no anchor in this scene`;
        if (!targetChecked.definition.methods.includes("manual"))
          return `${step.id}: called macro does not accept the manual method`;
        const declared = new Set(macroAutomationInputs(macro).map((field) => field.name));
        const stray = Object.keys(step.args ?? {}).find((name) => !declared.has(name));
        if (stray) return `${step.id}: the called macro does not declare "${stray}"`;
      }
      if (step.kind === "sceneBackground" || step.kind === "tileImage") {
        const images = step.kind === "tileImage" && step.images ? step.images : step.image ? [step.image] : [];
        for (const image of images) {
          const error = automationImageError(image, this.manifestSource());
          if (error) return `${step.id}: ${error}`;
        }
      }
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
    // D-407: the spell binding is validated beside the item binding — a catalogue spell and
    // timelines the author can read, with one cue per spell.
    const spellBinding = fxSpellBindingError(macro, {
      macro: (id) => this.store.get("macros", id) as MacroDocument | undefined,
      readable: (coll, doc) => can(user, "read", doc as BaseDocument, coll),
      boundTimelines: (spellId) => (this.store.getAll("macros") as readonly MacroDocument[])
        .filter((candidate) => candidate.kind === "sequence" &&
          fxSpellBindingKey(candidate.fxSpell) === spellId)
        .map((candidate) => ({ id: candidate._id })),
    });
    if (spellBinding !== null) return spellBinding;
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

  /**
   * A player cannot edit an NPC sheet, but a host-verified Lightning Bolt cast may commit the
   * exact HP delta proven by its spell evidence. No other actor path or field is elevated.
   */
  private verifiedLightningBoltHpWrite(actor: ActorDocument, diff: Record<string, unknown>, ops: readonly Op[]): boolean {
    if (Object.keys(diff).length !== 1 || !Number.isSafeInteger(diff["system.pf1e.hp"])) return false;
    const pf1e = isRecord(actor.system?.pf1e) ? actor.system.pf1e as Record<string, unknown> : {};
    if (!Number.isSafeInteger(pf1e.hp)) return false;
    const nextHp = diff["system.pf1e.hp"] as number;
    return ops.some((op) => {
      if (op.kind !== "create" || op.coll !== "messages") return false;
      const action = actionCardOf(op.data);
      if (!action || action.kind !== "cast" || action.label.trim().toLowerCase() !== "lightning bolt" ||
          action.area?.shape !== "line") return false;
      return action.targets.some((target) => target.actorId === actor._id && target.provenance === "host" &&
        target.evidence?.adapter === "pf1e.spellTarget.v1" && target.damage !== undefined &&
        nextHp === (pf1e.hp as number) - target.damage.dealt);
    });
  }

  /** §5 validation: permissions per op (+ cascade parents), schema-lite diffs. */
  private validateOps(
    user: SessionUser,
    ops: Op[],
  ):
    | { ok: true; hostOps: Op[] }
    | { ok: false; reason: "forbidden" | "invalid_schema"; error: string } {
    const hostOps: Op[] = [];
    // Scene-copy envelopes create the scene and its independently stored automation graphs
    // together. Preflight all automation refs against those staged scenes so neither the copy nor
    // its graphs can partially publish when their mutually bound documents are new to the store.
    const stagedScenes = new Map<string, SceneDocument>();
    for (const op of ops) {
      if (op.kind === "create" && op.coll === "scenes" && op.data.type === "scene")
        stagedScenes.set(op.data._id, op.data as SceneDocument);
    }
    // Codex bundle/import transactions may create a sheet and its linked documents together.
    // Resolve their final staged state for reference checks instead of rejecting a valid atomic
    // batch merely because a target has not reached the live store yet.
    const stagedCodexTargets = new Map<string, BaseDocument>();
    const removedCodexTargets = new Set<string>();
    const codexRootKey = (coll: string, id: string) => `${coll}:${id}`;
    for (const op of ops) {
      if (op.kind === "create" && op.parent === undefined) {
        const key = codexRootKey(op.coll, op.data._id);
        stagedCodexTargets.set(key, op.data);
        removedCodexTargets.delete(key);
      } else if (op.kind === "update" && op.ref.parent === undefined) {
        const key = codexRootKey(op.ref.coll, op.ref.id);
        const before = stagedCodexTargets.get(key) ?? this.store.resolve(op.ref);
        if (before) {
          const next = applyDiff(before, op.diff);
          if (next.ok) stagedCodexTargets.set(key, next.value as BaseDocument);
        }
      } else if (op.kind === "delete" && op.ref.parent === undefined) {
        const key = codexRootKey(op.ref.coll, op.ref.id);
        stagedCodexTargets.delete(key);
        removedCodexTargets.add(key);
      }
    }
    const resolveCodexTarget = (ref: DocRef): BaseDocument | undefined => {
      if (ref.parent !== undefined) {
        const parent = resolveCodexTarget(ref.parent);
        if (ref.coll === "pages" && parent?.type === "journal")
          return (parent as JournalDocument).pages.find((page) => page._id === ref.id);
        if (ref.coll === "items" && parent?.type === "actor")
          return (parent as ActorDocument).items.find((item) => item._id === ref.id);
      }
      const key = codexRootKey(ref.coll, ref.id);
      if (removedCodexTargets.has(key)) return undefined;
      return stagedCodexTargets.get(key) ?? this.store.resolve(ref);
    };
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
          const isGmOrAssistant = user.role === "GM" || user.role === "ASSISTANT";
          if (op.coll === "journals" && op.data.type === "journal" && hasCodexMetadata(op.data)) {
            if (!isGmOrAssistant)
              return { ok: false, reason: "forbidden", error: "Campaign Codex sheets are GM-managed" };
            const candidate = op.data as JournalDocument;
            const error = codexDocumentError(candidate, undefined,
              this.store.getAll("journals") as readonly JournalDocument[],
              (ref) => resolveCodexTarget(ref),
              (assetId) => this.store.world.assetManifest[assetId] !== undefined);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.coll === "pages" && op.data.type === "page") {
            const page = op.data as JournalPageDocument;
            const pageMetadataError = codexPageMetadataError(page.codex);
            if (pageMetadataError) return { ok: false, reason: "invalid_schema", error: pageMetadataError };
            if (page.codex !== undefined || hasCodexMetadata(parent)) {
              if (!isGmOrAssistant)
                return { ok: false, reason: "forbidden", error: "Campaign Codex pages are GM-managed" };
              if (parent?.type !== "journal")
                return { ok: false, reason: "invalid_schema", error: "Codex page requires a journal parent" };
              const journal = parent as JournalDocument;
              const candidate = { ...journal, pages: [...journal.pages, page] };
              const error = codexDocumentError(candidate, journal,
                this.store.getAll("journals") as readonly JournalDocument[],
              (ref) => resolveCodexTarget(ref),
              (assetId) => this.store.world.assetManifest[assetId] !== undefined);
              if (error) return { ok: false, reason: "invalid_schema", error };
            }
          }
          const tagError = tagDataError(op.data);
          if (tagError) return { ok: false, reason: "invalid_schema", error: tagError };
          if (op.coll === "regions") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs author scene regions" };
            const regionError = regionGeometryError(op.data);
            if (regionError) return { ok: false, reason: "invalid_schema", error: regionError };
          }
          if (op.coll === "tiles") {
            const tile = op.data as TileDocument;
            if (user.role !== "GM" && user.role !== "ASSISTANT" && tile.sort !== undefined)
              return { ok: false, reason: "forbidden", error: "only GMs set tile trigger priority" };
            const shapeError = tileTriggerZoneError(tile.triggerZone) ?? tileTriggerElevationError(tile.triggerElevation);
            if (shapeError) return { ok: false, reason: "invalid_schema", error: shapeError };
          }
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
            const error = this.automationDocumentError(op.data as AutomationDocument, stagedScenes);
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
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "automation") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish automations" };
            const error = macroAutomationDocumentError(op.data as MacroDocument) ??
              this.macroAutomationGraphError(op.data as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.coll === "macros" && (op.data as MacroDocument).kind === "composite") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish composites" };
            const error = macroCompositeDocumentError(op.data as MacroDocument) ??
              this.macroCompositeChildrenError(op.data as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          const strayAutomation = op.coll === "macros"
            ? macroStrayAutomationError(op.data as MacroDocument) : null;
          if (strayAutomation) return { ok: false, reason: "invalid_schema", error: strayAutomation };
          const strayComposite = op.coll === "macros"
            ? macroStrayCompositeError(op.data as MacroDocument) : null;
          if (strayComposite) return { ok: false, reason: "invalid_schema", error: strayComposite };
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
            !can(user, "update", doc, this.embeddedCollName(op.ref), canOpts) &&
            !(op.ref.coll === "actors" && this.verifiedLightningBoltHpWrite(
              doc as ActorDocument, op.diff, ops))
          ) {
            return {
              ok: false,
              reason: "forbidden",
              error: `update ${op.ref.coll}/${op.ref.id}`,
            };
          }
          const isGmOrAssistant = user.role === "GM" || user.role === "ASSISTANT";
          if (!isGmOrAssistant && (
            op.ref.coll === "journals" && hasCodexMetadata(doc) ||
            op.ref.coll === "pages" && (doc.type === "page" && (doc as JournalPageDocument).codex !== undefined ||
              hasCodexMetadata(parent))
          )) return { ok: false, reason: "forbidden", error: "Campaign Codex content is GM-managed" };
          // D-394: a self-owned imported User cannot promote its role to bypass the GM opt-in.
          if (op.ref.coll === "users" && user.role !== "GM" && user.role !== "ASSISTANT" &&
              Object.keys(op.diff).some((key) => /^(?:-=)?role(?:\.|$)/.test(key)))
            return { ok: false, reason: "forbidden", error: "user roles are GM-controlled" };
          // D-394: permission and author metadata are not caller-editable via raw intents.
          if (op.ref.coll === "users" && Object.keys(op.diff).some((key) =>
              /^(?:-=)?canSaveMacros(?:\.|$)/.test(key))) {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "macro-saving permission is GM-controlled" };
            if (op.diff.canSaveMacros !== undefined && typeof op.diff.canSaveMacros !== "boolean")
              return { ok: false, reason: "invalid_schema", error: "macro-saving permission must be boolean" };
          }
          if (op.ref.coll === "macros" && user.role !== "GM" && user.role !== "ASSISTANT" &&
              ((doc as MacroDocument).playerAuthoring !== undefined || Object.keys(op.diff).some((key) =>
                /^(?:-=)?playerAuthoring(?:\.|$)/.test(key))))
            return { ok: false, reason: "forbidden", error: "personal macro changes use the authorized save path" };
          if (op.ref.coll === "tiles" &&
              (Object.hasOwn(op.diff, "triggerZone") || Object.hasOwn(op.diff, "triggerElevation"))) {
            const shapeError = tileTriggerZoneError(op.diff.triggerZone) ?? tileTriggerElevationError(op.diff.triggerElevation);
            if (shapeError) return { ok: false, reason: "invalid_schema", error: shapeError };
          }
          if (op.ref.coll === "regions") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs edit scene regions" };
            const regionError = regionGeometryError({ ...doc, ...op.diff });
            if (regionError) return { ok: false, reason: "invalid_schema", error: regionError };
          }
          if (op.ref.coll === "tokens" && Object.hasOwn(op.diff, "elevation") &&
              (typeof op.diff.elevation !== "number" || !Number.isFinite(op.diff.elevation) || Math.abs(op.diff.elevation) > 1_000_000))
            return { ok: false, reason: "invalid_schema", error: "token elevation must be finite and within ±1,000,000 scene units" };
          if (user.role !== "GM" && user.role !== "ASSISTANT" && op.ref.coll === "tokens" &&
              Object.keys(op.diff).some((field) => field === "actorId" || field === "-=actorId"))
            return { ok: false, reason: "forbidden", error: "only GMs link tokens to actors" };
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
          if (op.ref.coll === "macros" && ["sequence", "script", "summon", "fxPreset", "automation"].includes((doc as MacroDocument).kind) &&
              user.role !== "GM" && user.role !== "ASSISTANT") {
            return { ok: false, reason: "forbidden", error: "only GMs edit FX/script/summon/automation macros" };
          }
          if (op.ref.coll === "macros" && Object.keys(op.diff).some((key) => key === "scriptState" || key.startsWith("scriptState.")))
            return { ok: false, reason: "forbidden", error: "execution history is host-owned" };
          const dry = applyDiff(doc, op.diff);
          if (!dry.ok)
            return { ok: false, reason: "invalid_schema", error: dry.error };
          if (op.ref.coll === "journals" && doc.type === "journal" && dry.value.type === "journal") {
            const previous = doc as JournalDocument;
            const candidate = dry.value as JournalDocument;
            if (hasCodexMetadata(previous) || hasCodexMetadata(candidate)) {
              if (!isGmOrAssistant)
                return { ok: false, reason: "forbidden", error: "Campaign Codex sheets are GM-managed" };
              const error = codexDocumentError(candidate, previous,
                this.store.getAll("journals") as readonly JournalDocument[],
              (ref) => resolveCodexTarget(ref),
              (assetId) => this.store.world.assetManifest[assetId] !== undefined);
              if (error) return { ok: false, reason: "invalid_schema", error };
            }
          }
          if (op.ref.coll === "pages" && doc.type === "page" && dry.value.type === "page") {
            const page = doc as JournalPageDocument;
            const candidatePage = dry.value as JournalPageDocument;
            if (candidatePage.codex !== undefined) {
              const error = codexPageMetadataError(candidatePage.codex);
              if (error) return { ok: false, reason: "invalid_schema", error };
            }
            if (page.codex !== undefined || candidatePage.codex !== undefined || hasCodexMetadata(parent)) {
              if (!isGmOrAssistant)
                return { ok: false, reason: "forbidden", error: "Campaign Codex pages are GM-managed" };
              if (parent?.type !== "journal")
                return { ok: false, reason: "invalid_schema", error: "Codex page requires a journal parent" };
              const journal = parent as JournalDocument;
              const candidate = { ...journal, pages: journal.pages.map((existing) =>
                existing._id === candidatePage._id ? candidatePage : existing) };
              const error = codexDocumentError(candidate, journal,
                this.store.getAll("journals") as readonly JournalDocument[],
              (ref) => resolveCodexTarget(ref),
              (assetId) => this.store.world.assetManifest[assetId] !== undefined);
              if (error) return { ok: false, reason: "invalid_schema", error };
            }
          }
          if (op.ref.coll === "actors") {
            const touchedSystem = Object.keys(op.diff).some((field) => {
              const path = field.startsWith("-=") ? field.slice(2) : field;
              return path === "system" || path === "system.pf1e" || path.startsWith("system.pf1e.");
            });
            if (touchedSystem) {
              const beforePf1e = isRecord((doc as ActorDocument).system?.pf1e)
                ? (doc as ActorDocument).system.pf1e as Record<string, unknown> : {};
              const afterPf1e = isRecord((dry.value as ActorDocument).system?.pf1e)
                ? (dry.value as ActorDocument).system.pf1e as Record<string, unknown> : {};
              const beforeApplications = validatePF1eConditionApplications(beforePf1e.conditionApplications);
              const afterApplications = validatePF1eConditionApplications(afterPf1e.conditionApplications);
              if (!beforeApplications.ok)
                return { ok: false, reason: "invalid_schema", error: beforeApplications.error };
              if (!afterApplications.ok)
                return { ok: false, reason: "invalid_schema", error: afterApplications.error };
              // A caller may tag its own manual condition and may remove its own manual tag
              // through a generic actor update. Everything else (mechanics from a source, a
              // foreign attribution, editing an existing instance) stays on the keyed
              // `pf1e.condition` action path. Because this path bypasses the action receipt, the
              // host announces each such change to the log so the GM always sees who added what.
              const conditionChanges: string[] = [];
              for (const [applicationId, application] of Object.entries(afterApplications.value)) {
                const previous = beforeApplications.value[applicationId];
                if (previous !== undefined) {
                  if (JSON.stringify(previous) !== JSON.stringify(application))
                    return { ok: false, reason: "forbidden", error: "condition applications are immutable; remove and reapply through an authorized condition action" };
                  continue;
                }
                if (application.source.kind !== "manual" || application.source.id !== user.id ||
                    application.source.actionId !== undefined || application.source.actorId !== undefined ||
                    application.source.itemId !== undefined || application.source.abilityId !== undefined ||
                    application.source.relationshipId !== undefined || application.source.groupId !== undefined ||
                    application.removal.kind !== "manual")
                  return { ok: false, reason: "forbidden", error: "new conditions must use a host-validated manual application source" };
                conditionChanges.push(`added ${application.condition} [${applicationId}]`);
              }
              for (const [applicationId, application] of Object.entries(beforeApplications.value)) {
                if (afterApplications.value[applicationId] !== undefined) continue;
                if (application.source.kind !== "manual" || application.source.id !== user.id ||
                    application.source.actionId !== undefined)
                  return { ok: false, reason: "forbidden", error: "only your own manual condition tag can be removed this way; use the pf1e.condition action" };
                conditionChanges.push(`removed ${application.condition} [${applicationId}]`);
              }
              if (conditionChanges.length > 0)
                hostOps.push(this.conditionAuditMessageOp(user.id, (doc as ActorDocument)._id,
                  (doc as ActorDocument).name, conditionChanges));
              const beforeAfflictionsRaw = beforePf1e.afflictions;
              const afterAfflictionsRaw = afterPf1e.afflictions;
              const beforeAfflictions = beforeAfflictionsRaw === undefined
                ? null : validatePF1ePoisonTargetState(beforeAfflictionsRaw, (doc as ActorDocument)._id);
              const afterAfflictions = afterAfflictionsRaw === undefined
                ? null : validatePF1ePoisonTargetState(afterAfflictionsRaw, (doc as ActorDocument)._id);
              if (beforeAfflictions && !beforeAfflictions.ok)
                return { ok: false, reason: "invalid_schema", error: beforeAfflictions.error };
              if (afterAfflictions && !afterAfflictions.ok)
                return { ok: false, reason: "invalid_schema", error: afterAfflictions.error };
              const beforeAfflictionState = beforeAfflictions?.ok ? beforeAfflictions.value : null;
              const afterAfflictionState = afterAfflictions?.ok ? afterAfflictions.value : null;
              if (JSON.stringify(beforeAfflictionState) !== JSON.stringify(afterAfflictionState))
                return { ok: false, reason: "forbidden", error: "poison courses and Delay Poison state are host-owned; use an authorized poison action" };
            }
          }
          if (Object.keys(op.diff).some((field) =>
            field === "taggerTags" || field === "-=taggerTags" || field.startsWith("taggerTags."))) {
            const tagError = taggerTagsError((dry.value as BaseDocument).taggerTags);
            if (tagError) return { ok: false, reason: "invalid_schema", error: tagError };
          }
          if (op.ref.coll === "actors" && Object.keys(op.diff).some((field) =>
            field === "prototypeToken" || field.startsWith("prototypeToken."))) {
            const tagError = taggerTagsError((dry.value as ActorDocument).prototypeToken?.taggerTags);
            if (tagError) return { ok: false, reason: "invalid_schema", error: tagError };
          }
          if (op.ref.coll === "automations") {
            const error = this.automationDocumentError(dry.value as AutomationDocument, stagedScenes);
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
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "automation") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish automations" };
            const error = macroAutomationDocumentError(dry.value as MacroDocument) ??
              this.macroAutomationGraphError(dry.value as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          if (op.ref.coll === "macros" && (dry.value as MacroDocument).kind === "composite") {
            if (user.role !== "GM" && user.role !== "ASSISTANT")
              return { ok: false, reason: "forbidden", error: "only GMs publish composites" };
            const error = macroCompositeDocumentError(dry.value as MacroDocument) ??
              this.macroCompositeChildrenError(dry.value as MacroDocument);
            if (error) return { ok: false, reason: "invalid_schema", error };
          }
          const strayAutomationUpdate = op.ref.coll === "macros"
            ? macroStrayAutomationError(dry.value as MacroDocument) : null;
          if (strayAutomationUpdate) return { ok: false, reason: "invalid_schema", error: strayAutomationUpdate };
          const strayCompositeUpdate = op.ref.coll === "macros"
            ? macroStrayCompositeError(dry.value as MacroDocument) : null;
          if (strayCompositeUpdate) return { ok: false, reason: "invalid_schema", error: strayCompositeUpdate };
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
          if (op.ref.coll === "macros" && (doc as MacroDocument).playerAuthoring !== undefined &&
              user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "personal macro deletion uses the authorized save path" };
          if (op.ref.coll === "automations" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete active zones" };
          if (op.ref.coll === "prefabs" && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete prefabs" };
          if (PREFAB_COLLECTIONS.includes(op.ref.coll as (typeof PREFAB_COLLECTIONS)[number]) &&
              doc.flags?.prefab !== undefined && user.role !== "GM" && user.role !== "ASSISTANT")
            return { ok: false, reason: "forbidden", error: "only GMs delete attached prefab parts" };
          if (op.ref.coll === "macros" && ["sequence", "script", "summon", "fxPreset", "automation"].includes((doc as MacroDocument).kind) &&
              user.role !== "GM" && user.role !== "ASSISTANT") {
            return { ok: false, reason: "forbidden", error: "only GMs delete FX/script/summon/automation macros" };
          }
          const parent =
            op.ref.parent !== undefined
              ? this.store.resolve(op.ref.parent)
              : undefined;
          const isGmOrAssistant = user.role === "GM" || user.role === "ASSISTANT";
          if (!isGmOrAssistant && (
            op.ref.coll === "journals" && hasCodexMetadata(doc) ||
            op.ref.coll === "pages" && (doc.type === "page" && (doc as JournalPageDocument).codex !== undefined ||
              hasCodexMetadata(parent))
          )) return { ok: false, reason: "forbidden", error: "Campaign Codex content is GM-managed" };
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
          const codexReferenceRemains = (this.store.getAll("journals") as readonly JournalDocument[]).some((journal) => {
            if (ops.some((pending) => pending.kind === "delete" && pending.ref.coll === "journals" &&
                pending.ref.id === journal._id && pending.ref.parent === undefined)) return false;
            const update = ops.find((pending) => pending.kind === "update" && pending.ref.coll === "journals" &&
              pending.ref.id === journal._id && pending.ref.parent === undefined);
            const candidate = update?.kind === "update" ? applyDiff(journal, update.diff) : undefined;
            if (candidate && !candidate.ok) return true;
            const current = candidate?.ok ? candidate.value as JournalDocument : journal;
            return codexReferencesRef(current, op.ref);
          });
          if (codexReferenceRemains)
            return { ok: false, reason: "invalid_schema", error: "Remove or repair Codex links before deleting this document" };
          continue;
        }
      }
    }
    return { ok: true, hostOps };
  }

  /**
   * A generic actor update may tag/untag the caller's own manual condition (see the policy in
   * `validateOps`). That path has no action receipt, so the host posts this log line naming the
   * acting user, the actor and every condition identity it changed — the GM alert the manual
   * path promises. The message is host-authored and immutable like other host-owned messages.
   */
  private conditionAuditMessageOp(by: UserId, actorId: DocId, actorName: string,
    changes: readonly string[]): Op {
    const author = this.store.get("users", by) as UserDocument | undefined;
    const message: MessageDocument = {
      _id: randomId(), type: "message", name: "Condition (manual)",
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { conditionAuditBy: by } },
      system: { pf1eCondition: { kind: "audit", actorId, by, changes: [...changes] } as unknown as Json },
      author: by,
      content: `${author?.name ?? by} changed conditions on ${actorName}: ${changes.join("; ")}.`,
      whisper: [], roll: null, flavor: "",
    };
    return { kind: "create", coll: "messages", data: message };
  }

  /**
   * The visible record of one keyed condition action. The receipt remains the inverse authority;
   * this message is the chat/log surface the GM reads (and the identity a future action card
   * would project). It is committed in the same envelope as the state ops.
   */
  private conditionMessageOp(input: {
    receiptId: string; action: "apply" | "remove"; actor: ActorDocument; condition: string;
    applicationId: string; by: UserId;
    /** D-407: the spell whose landed cast delivered the condition, when one did. */
    via?: string;
  }): Op {
    const message: MessageDocument = {
      _id: randomId(), type: "message",
      name: `Condition: ${input.action} ${input.condition}`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { conditionReceiptId: input.receiptId } },
      system: { pf1eCondition: { kind: "action", receiptId: input.receiptId, action: input.action,
        actorId: input.actor._id, condition: input.condition, applicationId: input.applicationId,
        by: input.by } as unknown as Json },
      author: input.by,
      content: `${(this.store.get("users", input.by) as UserDocument | undefined)?.name ?? input.by} ` +
        `${input.action === "apply" ? "applied" : "removed"} ${input.condition} on ${input.actor.name}` +
        `${input.via === undefined ? "" : ` via ${input.via}`}.`,
      whisper: [], roll: null, flavor: "",
    };
    return { kind: "create", coll: "messages", data: message };
  }

  private embeddedCollName(ref: DocRef): CollectionName {
    return (ref.parent ? ref.coll : ref.coll) as CollectionName;
  }

  private activeSceneDocument(): SceneDocument | undefined {
    return (this.store.getAll("scenes") as readonly SceneDocument[]).find((scene) => scene.active);
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
    suppressedMovement?: ReadonlySet<string>,
    restoring = false, // Host-only Undo/Redo/Revert; never inferred from a client transaction ID.
    movementPaths?: ReadonlyMap<string, PlannedMovementPath>,
    preplannedMovement?: ReadonlyMap<string, PreplannedMovementTrigger>,
    movementTimestamp?: number,
  ): { ok: true; seq: number } | { ok: false; error: string } {
    // Expand parent transforms BEFORE auditing; the receipt MUST describe the
    // actual committed envelope, not the unexpanded client/script proposal.
    // Undo/redo and named Revert already contain every child pre-image.
    if (!restoring) {
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
    // Remember source-addressable PF1e conditions before the envelope. Condition cleanup belongs
    // to the application identity, so normal removal, actor deletion, Undo/Redo and action Revert
    // all stop only the FX tied to the applications that actually disappeared.
    const conditionApplicationsBefore = new Map<string, Set<string>>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id } : op.ref;
      if (ref.coll !== "actors" || conditionApplicationsBefore.has(ref.id)) continue;
      const before = this.store.get("actors", ref.id) as ActorDocument | undefined;
      if (!before) continue;
      const pf1e = isRecord(before.system?.pf1e) ? before.system.pf1e as Record<string, unknown> : {};
      const applications = validatePF1eConditionApplications(pf1e.conditionApplications);
      if (applications.ok && Object.keys(applications.value).length > 0)
        conditionApplicationsBefore.set(ref.id, new Set(Object.keys(applications.value)));
    }
    const moving = new Map<string, { sceneId: string; tokenId: string; before?: TokenDocument }>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "tokens" || ref.parent?.coll !== "scenes" ||
          (op.kind === "update" && !Object.keys(op.diff).some((key) => ["x", "y", "rotation", "elevation"].includes(key))) ||
          op.kind === "delete") continue;
      const key = `${ref.parent.id}\u0000${ref.id}`;
      if (!moving.has(key)) {
        const before = op.kind === "create" ? undefined : this.store.resolve(op.ref) as TokenDocument | undefined;
        moving.set(key, { sceneId: ref.parent.id, tokenId: ref.id,
          ...(before ? { before } : {}) });
      }
    }
    // A door change is a document update on a wall, exactly like any other edit. Capture the
    // pre-image (0 closed / 1 open / 2 locked) here so the post-commit comparison — never a
    // client claim — decides which of the four door events actually happened.
    const doors = new Map<string, { sceneId: string; wallId: string; before: number }>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "walls" || ref.parent?.coll !== "scenes" ||
          op.kind !== "update" || !Object.hasOwn(op.diff, "door")) continue;
      const before = this.store.resolve(op.ref) as WallDocument | undefined;
      if (!before) continue;
      const key = `${ref.parent.id}\u0000${ref.id}`;
      if (!doors.has(key)) doors.set(key, { sceneId: ref.parent.id, wallId: ref.id, before: before.door });
    }
    // Combat changes are round/turn edits on an encounter document. The tracker's push()
    // always sends both fields, so only the committed pre-image comparison (never the
    // presence of a diff key) can tell which of MATT's five combat kinds actually happened.
    const combats = new Map<string, { combatId: string; before?: CombatDocument }>();
    const poisonTurnActors = new Set<string>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "combats") continue;
      if (op.kind === "update" &&
          !["round", "turn", "combatants"].some((key) => Object.hasOwn(op.diff, key))) continue;
      const before = op.kind === "create" ? undefined : this.store.resolve(op.ref) as CombatDocument | undefined;
      if (!before && op.kind !== "create") continue;
      if (!combats.has(ref.id)) combats.set(ref.id, { combatId: ref.id, ...(before ? { before } : {}) });
    }
    // Ambient darkness is a committed scene value (Settings → Ambient darkness, or a graph's own
    // Scene Lighting action) and the world clock is a committed settings value. Capture both
    // pre-images here so a real change — never a client claim or a no-op write — decides.
    const lighting = new Map<string, { sceneId: string; before: number }>();
    for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "scenes" || op.kind !== "update" || !Object.hasOwn(op.diff, "darkness")) continue;
      const before = this.store.resolve(op.ref) as SceneDocument | undefined;
      if (!before || lighting.has(ref.id)) continue;
      lighting.set(ref.id, { sceneId: ref.id, before: before.darkness });
    }
    const clockTouched = ops.some((op) => {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
      if (ref.coll !== "settings") return false;
      if (op.kind !== "update") return true;
      return Object.keys(op.diff).some((key) => key === "system" || key.startsWith("system.clockSeconds"));
    });
    const clockBefore = clockTouched ? readWorldClock(this.store.getAll("settings")) : null;
    // Scene activation is a document update, not a separate protocol message. Compare the
    // authoritative active scene around this envelope so retries, snapshots and client-provided
    // trigger claims cannot synthesize scene-change events.
    const sceneActivationCandidate = !restoring && ops.some((op) =>
      (op.kind === "update" && op.ref.coll === "scenes" && Object.hasOwn(op.diff, "active")) ||
      (op.kind === "create" && op.coll === "scenes" && op.data.type === "scene" &&
        (op.data as SceneDocument).active === true) ||
      (op.kind === "delete" && op.ref.coll === "scenes"));
    const activeSceneBefore = sceneActivationCandidate ? this.activeSceneDocument() : undefined;
    // Capture action revisions before application. This lets the post-commit hook emit exactly once
    // for a new/transitioned revision and ignore ordinary edits to the containing chat message.
    const actionRevisionsBefore = new Map<string, number | null>();
    if (!restoring) for (const op of ops) {
      const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id } : op.ref;
      if (ref.coll !== "messages" || actionRevisionsBefore.has(ref.id)) continue;
      actionRevisionsBefore.set(ref.id,
        actionCardOf(this.store.get("messages", ref.id) as MessageDocument | undefined)?.revision ?? null);
    }
    const envelope: OpEnvelope = {
      seq: this.store.seq + 1,
      ts: movementTimestamp ?? this.now(),
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
    for (const [messageId, priorRevision] of actionRevisionsBefore) {
      const action = actionCardOf(this.store.get("messages", messageId) as MessageDocument | undefined);
      if (action && action.revision !== priorRevision)
        this.bus.emit("action:committed", actionFxContext(action));
    }
    this.scheduleSummonExpiry();
    // Undo/Redo/Revert restore recorded state, without re-firing traps or RNG. A graph's
    // own committed Move/Rotation re-enters here through its commit; the depth cap
    // keeps a ping-pong graph pair from growing the host's call stack unboundedly.
    if (moving.size > 0 && !restoring) {
      if (this.movementAutomationDepth < HostSync.MOVEMENT_AUTOMATION_DEPTH) {
        this.movementAutomationDepth++;
        try {
          this.fireMovementAutomations([...moving.values()].map((source)=>{
            const path=movementPaths?.get(`${source.sceneId}\u0000${source.tokenId}`);
            return path?{...source,pathEnd:path.endpoint,stopFraction:path.stopFraction}:source;
          }), by, suppressedMovement, preplannedMovement);
        } finally {
          this.movementAutomationDepth--;
        }
      }
    }
    if (activeSceneBefore && sceneActivationCandidate) {
      const activeSceneAfter = this.activeSceneDocument();
      if (activeSceneAfter && activeSceneAfter._id !== activeSceneBefore._id) {
        // Every connected viewer follows the activation, so record the scene they now hold:
        // the commit itself is the `sceneChange` event, and a later reconnect must not replay
        // `sceneLoad` for a scene they already loaded.
        for (const session of this.sessions.values()) {
          if (session.user) this.loadedSceneByUser.set(session.user.id, activeSceneAfter._id);
        }
        this.fireSceneChangeAutomations(activeSceneAfter, by);
      }
    }
    if (doors.size > 0 && !restoring) {
      if (this.doorAutomationDepth < HostSync.DOOR_AUTOMATION_DEPTH) {
        this.doorAutomationDepth++;
        try {
          this.fireDoorAutomations([...doors.values()], by);
        } finally {
          this.doorAutomationDepth--;
        }
      }
    }
    if (combats.size > 0 && !restoring) {
      const changes = [...combats.values()].flatMap(({ combatId, before }) => {
        const after = this.store.get("combats", combatId) as CombatDocument | undefined;
        const events = combatTriggerEvents(before, after);
        if (!events.length) return [];
        for (const event of events) {
          if (event.method !== "combatTurnStart" || !event.tokenId || !after) continue;
          const combatant = after.combatants.find((entry) => entry.tokenId === event.tokenId);
          if (combatant?.actorId) poisonTurnActors.add(combatant.actorId);
        }
        const sceneId = this.sceneIdForCombat(combatId, after ?? before);
        return sceneId ? [{ sceneId, events }] : [];
      });
      if (changes.length > 0 && this.combatAutomationDepth < HostSync.COMBAT_AUTOMATION_DEPTH) {
        this.combatAutomationDepth++;
        try {
          for (const change of changes) {
            const scene = this.store.get("scenes", change.sceneId) as SceneDocument | undefined;
            if (!scene) continue;
            for (const event of change.events)
              this.fireSceneGraphs(scene, event.method, by, event.tokenId ?? undefined);
          }
        } finally {
          this.combatAutomationDepth--;
        }
      }
    }
    // Lighting and time share MATT's scene-wide scope and one reentry budget: a graph's own Scene
    // Lighting or Game Time action commits another environment change, whose scene graphs may do
    // the same again.
    const lightingChanges = [...lighting.values()].filter(({ sceneId, before }) => {
      const scene = this.store.get("scenes", sceneId) as SceneDocument | undefined;
      return !!scene && scene.darkness !== before;
    });
    if ((lightingChanges.length > 0 || clockBefore !== null) && !restoring) {
      if (this.environmentAutomationDepth >= HostSync.ENVIRONMENT_AUTOMATION_DEPTH) {
        // Bounded: the reentrant chain stops committing further trigger work at this depth.
      } else {
        this.environmentAutomationDepth++;
        try {
          for (const change of lightingChanges) {
            const scene = this.store.get("scenes", change.sceneId) as SceneDocument | undefined;
            if (scene) this.fireSceneGraphs(scene, "lightingChange", by);
          }
          if (clockBefore !== null && readWorldClock(this.store.getAll("settings")) !== clockBefore) {
            // MATT's time trigger watches the scene the table is looking at; the host's
            // equivalent is the active scene, which is also what a fresh player loads.
            const active = this.activeSceneDocument();
            if (active) this.fireSceneGraphs(active, "timeChange", by);
          }
        } finally {
          this.environmentAutomationDepth--;
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
          this.now(),
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
    const clockAfter = clockBefore === null ? null : readWorldClock(this.store.getAll("settings"));
    if (!restoring && this.poisonSweepDepth === 0 &&
        ((clockBefore !== null && clockAfter !== clockBefore) || poisonTurnActors.size > 0))
      this.sweepPF1ePoisonDue(clockAfter ?? readWorldClock(this.store.getAll("settings")), poisonTurnActors);
    for (const [actorId, beforeIds] of conditionApplicationsBefore) {
      const after = this.store.get("actors", actorId) as ActorDocument | undefined;
      const pf1e = after && isRecord(after.system?.pf1e) ? after.system.pf1e as Record<string, unknown> : {};
      const applications = validatePF1eConditionApplications(pf1e.conditionApplications);
      const afterIds = applications.ok ? new Set(Object.keys(applications.value)) : new Set<string>();
      for (const applicationId of beforeIds) {
        if (!afterIds.has(applicationId)) this.stopConditionFxForApplication(applicationId);
      }
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
      const viewerManifest = projectAssetManifest(this.store.world, this.manifestSource(), session.user);
      const resolver = {
        resolve: (ref: DocRef) => this.store.resolve(ref) ?? deleted.get(visibilityKey(ref)),
        canReadAsset: (assetId: string) => Object.prototype.hasOwnProperty.call(viewerManifest, assetId),
      };
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
        msg.refs.some((ref) => !isWorldTagRef(ref) && !isWorldDocumentTagRef(ref))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "Invalid Tagger rule references");
      return;
    }
    const requestKey = `${caller.id}:${msg.requestId}`;
    const previous = this.taggerRuleResults.get(requestKey);
    if (previous) { this.send(session, previous); return; } // reconnect/retry never allocates twice
    const seen = new Set<string>();
    const docs: Array<{ ref: TagRef; sceneId: string; doc: BaseDocument }> = [];
    for (const ref of msg.refs) {
      const sceneQualified = isWorldTagRef(ref);
      const prototypeTarget = isPrototypeTokenTagRef(ref);
      const sceneId = sceneQualified ? ref.coll === "scenes" ? ref.id : ref.parent?.id ?? "" : "";
      const scene = sceneId ? this.store.get("scenes", sceneId) : undefined;
      const identity = tagRefKey(ref);
      const entry = listTaggable(this.store.world, { viewer: caller,
        ...(sceneQualified ? { sceneId } : { includeWorldDocs: true }), includeRefs: [ref] })[0];
      const live = prototypeTarget ? this.store.get("actors", ref.id)
        : entry ? this.store.resolve(entry.ref) : undefined;
      const permissionParent = ref.parent?.coll === "actors"
        ? this.store.get("actors", ref.parent.id)
        : sceneQualified && ref.coll !== "scenes" ? scene : undefined;
      const permissionCollection = prototypeTarget ? "actors" : ref.coll;
      if (!entry || !live || seen.has(identity) ||
          (sceneQualified && (!scene || !can(caller, "read", scene, "scenes"))) ||
          (ref.parent?.coll === "actors" && !permissionParent) ||
          !can(caller, "update", live, permissionCollection,
            permissionParent ? { parent: permissionParent } : {})) {
        this.reject(session, msg.requestId, "invalid_schema", "Missing, duplicate or unauthorized Tagger target");
        return;
      }
      seen.add(identity);
      // Prototype rows are virtual Tagger views, while authorization and writes target the actor.
      docs.push({ ref, sceneId: scene?._id ?? "", doc: prototypeTarget ? entry.doc : live });
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

  private poisonBlock(actor: ActorDocument): Record<string, unknown> {
    const system = isRecord(actor.system) ? actor.system : {};
    return isRecord(system.pf1e) ? system.pf1e : {};
  }

  private poisonStateSnapshot(actor: ActorDocument): {
    ok: true; state: PF1ePoisonTargetState; existed: boolean;
  } | { ok: false; error: string } {
    const raw = this.poisonBlock(actor).afflictions;
    if (raw === undefined) {
      const empty = emptyPF1ePoisonTargetState(actor._id);
      return empty.ok ? { ok: true, state: empty.value, existed: false } : empty;
    }
    const checked = validatePF1ePoisonTargetState(raw, actor._id);
    return checked.ok ? { ok: true, state: checked.value, existed: true } : checked;
  }

  private poisonImmune(actor: ActorDocument): boolean {
    const entries = this.poisonBlock(actor).immunities;
    return Array.isArray(entries) && entries.some((entry) => typeof entry === "string" &&
      ["poison", "all poisons", "all"].includes(entry.trim().toLocaleLowerCase("en-US")));
  }

  /** Exact-path state writers keep separate poison courses independently Revertable. */
  private poisonStateOps(
    actor: ActorDocument,
    before: PF1ePoisonTargetState,
    after: PF1ePoisonTargetState,
    existed: boolean,
  ): Op[] {
    const ref = { coll: "actors" as const, id: actor._id };
    const system = isRecord(actor.system) ? actor.system : {};
    const pf1e = isRecord(system.pf1e) ? system.pf1e : {};
    if (!isRecord(system.pf1e)) {
      return [{ kind: "update", ref, diff: {
        "system.pf1e": { ...pf1e, afflictions: after } as unknown as Json,
      } }];
    }
    if (!existed) return [{ kind: "update", ref, diff: { "system.pf1e.afflictions": after as unknown as Json } }];
    const diff: Record<string, Json | null> = {};
    const mapDiff = (root: "courses" | "exposureAttempts",
      oldValues: Readonly<Record<string, unknown>>, newValues: Readonly<Record<string, unknown>>): void => {
      for (const key of new Set([...Object.keys(oldValues), ...Object.keys(newValues)])) {
        const oldValue = oldValues[key];
        const newValue = newValues[key];
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
        const path = `system.pf1e.afflictions.${root}.${key}`;
        if (newValue === undefined) diff[`-=${path}`] = null;
        else diff[path] = newValue as Json;
      }
    };
    mapDiff("courses", before.courses, after.courses);
    mapDiff("exposureAttempts", before.exposureAttempts, after.exposureAttempts);
    if (JSON.stringify(before.delayPoison) !== JSON.stringify(after.delayPoison))
      diff["system.pf1e.afflictions.delayPoison"] = after.delayPoison as unknown as Json;
    if (JSON.stringify(before.queuedExposures) !== JSON.stringify(after.queuedExposures))
      diff["system.pf1e.afflictions.queuedExposures"] = after.queuedExposures as unknown as Json;
    return Object.keys(diff).length ? [{ kind: "update", ref, diff }] : [];
  }

  private poisonEffectPlan(
    actor: ActorDocument,
    course: PF1ePoisonCourse,
    effects: readonly PF1ePoisonEffect[],
    phase: "immediate" | "periodic" | "oneShot",
    receiptId: string,
  ): { ok: true; ops: Op[]; course: PF1ePoisonCourse; summary: string[] } | { ok: false; error: string } {
    const pf1e = this.poisonBlock(actor);
    const abilityValues: Record<"abilitiesDamage" | "abilitiesDrain", Record<string, number>> = {
      abilitiesDamage: isRecord(pf1e.abilitiesDamage) ? { ...pf1e.abilitiesDamage as Record<string, number> } : {},
      abilitiesDrain: isRecord(pf1e.abilitiesDrain) ? { ...pf1e.abilitiesDrain as Record<string, number> } : {},
    };
    const hadAbilityMap = {
      abilitiesDamage: isRecord(pf1e.abilitiesDamage),
      abilitiesDrain: isRecord(pf1e.abilitiesDrain),
    };
    const abilityDiffs: Record<"abilitiesDamage" | "abilitiesDrain", Map<string, number>> = {
      abilitiesDamage: new Map(), abilitiesDrain: new Map(),
    };
    const effectTotals: Record<string, number> = { ...course.effectTotals };
    const ops: Op[] = [];
    const addedConditionIds: string[] = [];
    const summary: string[] = [];
    let hpDamage = 0;

    for (const [index, effect] of effects.entries()) {
      if (effect.kind === "damage") {
        const rolled = evaluateFormula(effect.formula, undefined, this.rng);
        if (!rolled.ok) return { ok: false, error: `Poison effect formula failed: ${rolled.error}` };
        const amount = rolled.value.total;
        if (!Number.isSafeInteger(amount) || amount < 0)
          return { ok: false, error: "Poison effect formula must resolve to a non-negative whole number" };
        if (amount === 0) continue;
        if (effect.target === "hitPoints") {
          if (effect.accumulation === "replace")
            return { ok: false, error: "Replace accumulation is supported only for ability damage/drain" };
          hpDamage += amount;
          summary.push(`${amount} hit point damage`);
          continue;
        }
        const ability = effect.ability;
        if (!ability) return { ok: false, error: "Poison ability damage/drain has no ability key" };
        const field = effect.target === "abilityDamage" ? "abilitiesDamage" : "abilitiesDrain";
        const key = `${phase}_${index}_${field}_${ability}`;
        const priorEffect = effectTotals[key] ?? 0;
        const nextEffect = effect.accumulation === "replace" ? amount : priorEffect + amount;
        const delta = nextEffect - priorEffect;
        const existing = abilityValues[field][ability] ?? 0;
        if (!Number.isSafeInteger(existing) || existing < 0 || existing + delta < 0)
          return { ok: false, error: `Actor ${field}.${ability} is malformed or cannot replace this poison effect` };
        if (delta !== 0) {
          abilityValues[field][ability] = existing + delta;
          abilityDiffs[field].set(ability, existing + delta);
        }
        effectTotals[key] = nextEffect;
        summary.push(`${amount} ${ability.toUpperCase()} ${effect.target === "abilityDamage" ? "damage" : "drain"}`);
        continue;
      }

      const id = `poison-condition-${randomId()}`;
      const activeCourse = course.state === "active" || course.state === "onset";
      const lastDoseSource = course.doseEvents.at(-1)?.source;
      const applied = pf1eApplyConditionApplication({
        actor,
        id,
        condition: effect.condition,
        source: {
          kind: "poison",
          id: course.id,
          actionId: receiptId,
          ...(lastDoseSource?.actorId ? { actorId: lastDoseSource.actorId } : {}),
          ...(lastDoseSource?.itemId ? { itemId: lastDoseSource.itemId } : {}),
        },
        // D8: one channel owns "this effect ends with the course" — the course's
        // `activeEffectIds`, which the cure/expiry transitions read and return as
        // `effectIdsToRemove`. The application records how it is removed (an explicit host
        // action), not a duplicate claim about a poison event no consumer reads.
        removal: effect.removeOnCure && activeCourse ? { kind: "manual" } : { kind: "permanent" },
      });
      if (!applied.ok) return { ok: false, error: `Poison condition effect: ${applied.error}` };
      ops.push(...applied.value);
      if (effect.removeOnCure && activeCourse) addedConditionIds.push(id);
      summary.push(`condition: ${effect.condition}`);
    }

    if (hpDamage > 0) {
      const derived = deriveFromActorDocument(actor);
      const legacyTempHp = !isRecord(pf1e.tempHpSources) && typeof pf1e.tempHp === "number";
      const health = planRollApply({
        mode: "damage",
        amount: hpDamage,
        hp: derived.hp,
        hpMax: derived.hpMax,
        nonlethalDamage: derived.nonlethalDamage,
        tempHpSources: derived.tempHpSources,
        ...(legacyTempHp ? { legacyTempHp: true } : {}),
      });
      if (!health.ok) return { ok: false, error: `Poison HP effect: ${health.error}` };
      if (Object.keys(health.plan.diff).length)
        ops.push({ kind: "update", ref: { coll: "actors", id: actor._id }, diff: health.plan.diff });
    }

    for (const field of ["abilitiesDamage", "abilitiesDrain"] as const) {
      const changed = abilityDiffs[field];
      if (changed.size === 0) continue;
      if (!hadAbilityMap[field]) {
        ops.push({ kind: "update", ref: { coll: "actors", id: actor._id },
          diff: { [`system.pf1e.${field}`]: abilityValues[field] as unknown as Json } });
      } else {
        const diff: Record<string, Json> = {};
        for (const [ability, value] of changed) diff[`system.pf1e.${field}.${ability}`] = value;
        ops.push({ kind: "update", ref: { coll: "actors", id: actor._id }, diff });
      }
    }

    return { ok: true, ops, course: {
      ...course,
      effectTotals,
      activeEffectIds: [...new Set([...course.activeEffectIds, ...addedConditionIds])],
    }, summary };
  }

  private poisonRemoveEffectOps(actor: ActorDocument, ids: readonly string[]):
    { ok: true; ops: Op[] } | { ok: false; error: string } {
    const ops: Op[] = [];
    for (const id of new Set(ids)) {
      const removed = pf1eRemoveConditionApplication(actor, id);
      if (!removed.ok) return { ok: false, error: `Poison source-effect removal: ${removed.error}` };
      ops.push(...removed.value);
    }
    return { ok: true, ops };
  }

  private poisonSave(actor: ActorDocument, saveType: PF1ePoisonDefinition["saveType"], dc: number): {
    d20: number; bonus: number; total: number; passed: boolean;
  } {
    const derived = deriveFromActorDocument(actor);
    const raw = this.rng();
    const d20 = Math.max(1, Math.min(20, Math.floor((Number.isFinite(raw) ? raw : 0) * 20) + 1));
    const bonus = derived.saves[saveType];
    const total = d20 + bonus;
    return { d20, bonus, total, passed: total >= dc };
  }

  /** True when a player-owned victim should roll the exposure save themselves. */
  private poisonSaveDeferred(target: ActorDocument): boolean {
    try {
      const worldSettings = worldSettingsFrom(this.store.getAll("settings"));
      // The host's own (GM/system) ownership is not "a player": an NPC the GM owns has its save
      // rolled by the host, never deferred back to the GM as if it were a player's roll.
      const playerOwned = Object.entries(target.ownership ?? {}).some(([id, level]) =>
        id !== "default" && id !== this.systemUserId && typeof level === "number" && level >= 1);
      return shouldDeferToPlayer({ kind: "save", targetIsPlayerOwned: playerOwned,
        worldSettings, isStrategic: false, isRiderSave: true });
    } catch {
      return false;
    }
  }

  /** Validate a rider reference and return the landed card row it names. */
  private poisonRiderContext(raw: { actionId: string; targetKey: string }, targetActorId: DocId):
    { ok: true; value: { messageId: DocId; targetKey: string; card: ActionCard; targetIndex: number } } |
    { ok: false; error: string } {
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "actionId" && key !== "targetKey") ||
        typeof raw.actionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.actionId) ||
        typeof raw.targetKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.targetKey))
      return { ok: false, error: "Poison rider reference is malformed" };
    const message = this.store.get("messages", raw.actionId) as MessageDocument | undefined;
    const card = actionCardOf(message);
    if (!message || !card) return { ok: false, error: "Poison rider action card does not exist" };
    const targetIndex = card.targets.findIndex((target) => target.key === raw.targetKey);
    const row = card.targets[targetIndex];
    if (!row || row.actorId !== targetActorId)
      return { ok: false, error: "Poison rider target does not match the exposure target" };
    if (row.state !== "resolved" || !["hit", "failedSave", "affected"].includes(row.outcome))
      return { ok: false, error: `Poison can ride only a landed interaction; that target is ${row.outcome}` };
    if ((row.riders?.length ?? 0) >= ACTION_RIDER_MAX)
      return { ok: false, error: "That action target already carries the maximum number of riders" };
    return { ok: true, value: { messageId: message._id, targetKey: raw.targetKey, card, targetIndex } };
  }

  /**
   * D-407 — validate a spell-effect rider reference and return the landed cast row it names plus
   * the catalogue effect the caller claims. The card is the delivery record: the row must be the
   * target's own, resolved and landed **according to the effect's own save shape** (a spell with a
   * save lands only on `failedSave`, one without a save only on `affected`), the check's save type
   * must agree with the catalogue, and a caller who is not the GM must control the delivering actor
   * (checked by the caller alongside this, exactly like the poison rider).
   */
  private spellEffectRiderContext(raw: unknown, targetActorId: DocId, condition: string):
    { ok: true; value: { messageId: DocId; targetKey: string; card: ActionCard; targetIndex: number;
      effect: PF1eSpellEffect } } | { ok: false; error: string } {
    if (!isRecord(raw) ||
        Object.keys(raw).some((key) => !["effectId", "actionId", "targetKey"].includes(key)) ||
        typeof raw.effectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.effectId) ||
        typeof raw.actionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.actionId) ||
        typeof raw.targetKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.targetKey))
      return { ok: false, error: "Spell effect rider reference is malformed" };
    const effect = pf1eSpellEffectById(raw.effectId);
    if (!effect) return { ok: false, error: "Spell effect is not in the host-validated catalogue" };
    if (!effect.conditions.includes(condition))
      return { ok: false, error: `${effect.name} does not apply ${condition}` };
    const message = this.store.get("messages", raw.actionId) as MessageDocument | undefined;
    const card = actionCardOf(message);
    if (!message || !card) return { ok: false, error: "Spell effect action card does not exist" };
    if (card.kind !== "cast") return { ok: false, error: "A spell effect rides a cast card only" };
    const targetIndex = card.targets.findIndex((target) => target.key === raw.targetKey);
    const row = card.targets[targetIndex];
    if (!row || row.actorId !== targetActorId)
      return { ok: false, error: "Spell effect row is not this target's" };
    if (row.state !== "resolved" || !pf1eSpellEffectLanded(effect, row.outcome))
      return { ok: false, error: `${effect.name} delivers only on a landed row; that target is ${row.outcome}` };
    if (effect.save !== null && row.check?.saveType !== undefined && row.check.saveType !== effect.save.type)
      return { ok: false, error: `${effect.name} was cast against a different save` };
    if ((row.riders?.length ?? 0) >= ACTION_RIDER_MAX)
      return { ok: false, error: "That action target already carries the maximum number of riders" };
    return { ok: true, value: { messageId: message._id, targetKey: raw.targetKey, card, targetIndex, effect } };
  }

  /** Bounded display facts for a delivered condition; never machine-consumed. */
  private conditionRiderFacts(effect: PF1eSpellEffect, condition: string, dc: number | null): string[] {
    const facts = [`spell: ${effect.name}`];
    if (effect.save !== null)
      facts.push(`${effect.save.type.toUpperCase()} ${effect.save.severity}${dc === null ? "" : ` (DC ${dc})`}`);
    facts.push(`condition: ${condition}`);
    return facts;
  }

  /** Stop only persistent FX instances owned by this exact condition application. */
  private stopConditionFxForApplication(applicationId: string): void {
    const instances = this.store.getAll("fxInstances").filter((instance) =>
      instance.conditionApplicationId === applicationId);
    if (instances.length === 0) return;
    const stopped = this.commitSystem(instances.map((instance) => ({
      kind: "delete" as const,
      ref: { coll: "fxInstances" as const, id: instance._id },
    })), false);
    if (!stopped.ok) console.warn(`PF1e condition FX cleanup failed for ${applicationId}: ${stopped.error}`);
  }

  /** Bounded display facts for the card; numbers are transcribed from the validated profile. */
  private poisonRiderFacts(definition: PF1ePoisonDefinition, dc: number | null): string[] {
    const facts: string[] = [];
    if (dc !== null) facts.push(`${definition.saveType.toUpperCase()} DC ${dc}`);
    facts.push(`delivery: ${definition.delivery.join("/")}`);
    if (definition.frequency) {
      const { interval, intervals } = definition.frequency;
      facts.push(`${interval.value}/${interval.unit}${interval.value === 1 ? "" : "s"} for ${intervals ?? "unlimited"} interval${intervals === 1 ? "" : "s"}`);
    } else {
      facts.push("single exposure");
    }
    const effects = [...definition.effects.immediate, ...definition.effects.periodic].map((effect) =>
      effect.kind === "damage"
        ? `${effect.formula} ${effect.target === "hitPoints" ? "hp" : `${effect.ability?.toUpperCase() ?? "?"} ${effect.target === "abilityDamage" ? "damage" : "drain"}`}`
        : `condition: ${effect.condition}`);
    if (effects.length) facts.push([...new Set(effects)].join(", "));
    facts.push(`cure: ${definition.cure.successesRequired} save${definition.cure.successesRequired === 1 ? "" : "s"}${definition.cure.consecutive ? " (consecutive)" : ""}`);
    return facts.slice(0, 6);
  }

  private poisonRiderEvidencePayload(input: {
    definition: PF1ePoisonDefinition; baseDC: number; route: string; doseCount: number;
    exposureId: string; newCourseId: string; sourceActorId?: string; sourceItemId?: string;
  }): Json {
    return {
      definitionId: input.definition.id,
      version: input.definition.version,
      baseDC: input.baseDC,
      route: input.route,
      doseCount: input.doseCount,
      exposureId: input.exposureId,
      newCourseId: input.newCourseId,
      ...(input.sourceActorId !== undefined ? { sourceActorId: input.sourceActorId } : {}),
      ...(input.sourceItemId !== undefined ? { sourceItemId: input.sourceItemId } : {}),
    };
  }

  /** Append one rider to the delivering card and return the updated card plus its update op. */
  private actionRiderAttachOps(input: {
    context: { messageId: DocId; targetKey: string; card: ActionCard; targetIndex: number };
    rider: ActionRider;
  }): { ok: true; ops: Op[]; card: ActionCard } | { ok: false; error: string } {
    const row = input.context.card.targets[input.context.targetIndex];
    if (!row) return { ok: false, error: "Action rider target row disappeared" };
    const riders = [...(row.riders ?? []), input.rider];
    const targets = input.context.card.targets.map((target, index) =>
      index === input.context.targetIndex ? { ...target, riders } : target);
    const next: ActionCard = { ...input.context.card, v: ACTION_CARD_VERSION,
      revision: input.context.card.revision + 1, state: deriveActionState(targets), targets,
      updatedAt: Math.max(input.context.card.updatedAt, this.now()) };
    const checked = validateActionCard(next);
    if (!checked.ok) return { ok: false, error: `Action rider card is invalid: ${checked.error}` };
    return { ok: true, card: next, ops: [{ kind: "update",
      ref: { coll: "messages", id: input.context.messageId },
      diff: { "system.action": actionAsJson(next) } }] };
  }

  /**
   * Deferred delivery: the dose is offered but the initial save is the victim's own pending roll.
   * No course exists until that roll resolves; the card revision, the pending save and the log
   * line commit in one host receipt so GM Revert removes the offer cleanly.
   */
  private commitPF1ePoisonRiderPending(input: {
    context: { messageId: DocId; targetKey: string; card: ActionCard; targetIndex: number };
    target: ActorDocument; definition: PF1ePoisonDefinition; baseDC: number; route: string;
    doseCount: number; dc: number; exposureId: string; newCourseId: string;
    sourceActorId?: string; sourceItemId?: string; receiptId: string; requestId: string; by: UserId;
  }): { ok: true; seq: number } | { ok: false; error: string } {
    const sourceActorId = input.context.card.source.actorId;
    if (sourceActorId === undefined)
      return { ok: false, error: "The delivering action has no source actor to link a pending save to" };
    const row = input.context.card.targets[input.context.targetIndex];
    const pendingId = randomId();
    const rider: ActionRider = {
      kind: "poison", label: input.definition.name, state: "pending",
      facts: this.poisonRiderFacts(input.definition, input.dc),
      save: { saveType: input.definition.saveType, dc: input.dc, total: null, pendingRollId: pendingId },
      evidence: { adapter: "pf1e.poison.v1", payload: this.poisonRiderEvidencePayload(input) },
    };
    const attached = this.actionRiderAttachOps({ context: input.context, rider });
    if (!attached.ok) return attached;
    const saveBonus = deriveFromActorDocument(input.target).saves[input.definition.saveType];
    const pending = buildPendingRoll({
      id: pendingId, actionId: input.context.messageId, targetKey: input.context.targetKey,
      kind: "save", saveType: input.definition.saveType,
      initiator: { actorId: sourceActorId, tokenId: input.context.card.source.tokenId ?? null,
        name: input.context.card.source.name,
        actionLabel: `Poison: ${input.definition.name} (DC ${input.dc})` },
      target: { actorId: input.target._id, tokenId: row?.tokenId ?? null, name: input.target.name },
      formula: `1d20${saveBonus === 0 ? "" : saveBonus > 0 ? `+${saveBonus}` : String(saveBonus)}`,
      dc: input.dc,
      modifiers: [{ label: input.definition.saveType.toUpperCase(), value: saveBonus, reason: "poison save" }],
      turnNumber: this.currentTurnNumber(), rollMode: "roll",
    });
    const validated = validatePendingRoll(pending);
    if (!validated.ok) return { ok: false, error: `Poison pending save is invalid: ${validated.error}` };
    const message = this.store.get("messages", input.context.messageId) as MessageDocument;
    const existing = pendingRollsOfSystem(message.system);
    const nextPendings = [...existing, pending];
    const diff: Record<string, Json> = { "system.action": actionAsJson(attached.card) };
    if (nextPendings.length === 1) {
      diff["system.pendingRoll"] = pending as unknown as Json;
    } else {
      diff["system.pendingRolls"] = nextPendings as unknown as Json;
      if (message.system.pendingRoll !== undefined) diff["system.-=pendingRoll"] = null;
    }
    return this.commitPF1ePoisonEvent({
      receiptId: input.receiptId, label: `Poison exposure: ${input.definition.name}`,
      actorId: input.by, requestId: input.requestId, action: "expose",
      ops: [{ kind: "update", ref: { coll: "messages", id: input.context.messageId }, diff }],
      target: input.target,
      summary: `${input.target.name} is exposed to ${input.definition.name}; the DC ${input.dc} ${input.definition.saveType.toUpperCase()} save is pending on the delivering action.`,
      poisonId: input.definition.id,
      pathChecks: [{ ref: { coll: "messages", id: input.context.messageId },
        paths: ["system.action", "system.pendingRoll", "system.pendingRolls"] }],
    });
  }

  /**
   * The deferred exposure save resolved. Re-derive the exposure from live host state and refuse
   * a stale offer (changed DC, new immunity, Delay Poison) instead of applying mechanics the
   * player did not roll against. Everything commits in the caller's envelope and receipt.
   */
  private poisonRiderContinuation(input: {
    target: ActorDocument; rider: ActionRider; receiptId: string; savePassed: boolean;
  }): { ok: true; ops: Op[]; summary: string; courseId?: string; poisonId: string } | { ok: false; error: string } {
    const payload = input.rider.evidence?.payload;
    if (!isRecord(payload)) return { ok: false, error: "Poison rider evidence is missing" };
    const { definitionId, version, baseDC, route, doseCount, exposureId, newCourseId } = payload;
    if (typeof definitionId !== "string" || !Number.isSafeInteger(version) ||
        !Number.isSafeInteger(baseDC) || (baseDC as number) < 1 || (baseDC as number) > 99 ||
        typeof route !== "string" || !Number.isSafeInteger(doseCount) || (doseCount as number) < 1 ||
        (doseCount as number) > 100_000 || typeof exposureId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(exposureId) || typeof newCourseId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(newCourseId))
      return { ok: false, error: "Poison rider evidence is malformed" };
    const definition = PF1E_POISON_FIXTURES.find((entry) =>
      entry.id === definitionId && entry.version === version);
    if (!definition) return { ok: false, error: "Poison profile is no longer in the host-validated pack" };
    if (!definition.delivery.includes(route as PF1ePoisonDefinition["delivery"][number]))
      return { ok: false, error: "Poison rider delivery route is not supported by the profile" };
    const sourceActorId = typeof payload.sourceActorId === "string" ? payload.sourceActorId : undefined;
    const sourceItemId = typeof payload.sourceItemId === "string" ? payload.sourceItemId : undefined;
    if (definition.dcSource === "creature-derived") {
      const source = sourceActorId
        ? this.store.get("actors", sourceActorId) as ActorDocument | undefined : undefined;
      const hitDice = source ? this.poisonBlock(source).hitDice : undefined;
      const conModifier = source ? deriveFromActorDocument(source).abilityMods.con : NaN;
      const derived = source && Number.isSafeInteger(hitDice)
        ? pf1eCreaturePoisonBaseDc(hitDice as number, conModifier) : null;
      if (derived === null || derived !== baseDC)
        return { ok: false, error: "Poison source creature changed since the save was offered" };
    } else if (definition.baseDC !== baseDC) {
      return { ok: false, error: "Poison profile DC changed since the save was offered" };
    }

    const snapshot = this.poisonStateSnapshot(input.target);
    if (!snapshot.ok) return { ok: false, error: snapshot.error };
    const state = snapshot.state;
    if (state.delayPoison.active)
      return { ok: false, error: "Delay Poison is active now; re-deliver the exposure so it queues" };
    if (this.poisonImmune(input.target))
      return { ok: false, error: "The target is immune to poison now" };
    const identity = pf1ePoisonDefinitionIdentity(definition);
    const active = Object.values(state.courses).find((course) =>
      course.definitionIdentity === identity && (course.state === "active" || course.state === "onset"));
    const expectedDc = pf1ePoisonExposureSaveDc(baseDC as number, active?.doseCount ?? 0, doseCount as number);
    if (expectedDc === null || expectedDc !== input.rider.save?.dc)
      return { ok: false, error: "Poison exposure state changed since the save was offered; ask the GM to re-deliver it" };

    const now = this.now();
    const source = {
      kind: sourceItemId ? "item" as const : sourceActorId ? "attack" as const : "environment" as const,
      actionId: input.receiptId, sourceId: definition.id,
      ...(sourceActorId ? { actorId: sourceActorId } : {}),
      ...(sourceItemId ? { itemId: sourceItemId } : {}),
    };
    const exposure = { targetId: input.target._id, definition, newCourseId, exposureId,
      route: route as PF1ePoisonDefinition["delivery"][number], doseCount: doseCount as number,
      exposedAt: now, source, receiptId: input.receiptId };
    const applied = applyPF1ePoisonExposureToTarget({ state, exposure,
      savePassed: input.savePassed, resolvedAt: now });
    if (!applied.ok) return { ok: false, error: applied.error };
    let next = applied.value.state;
    const ops: Op[] = [];
    const resolution = applied.value.resolution;
    const save = input.rider.save;
    let courseId: string | undefined;
    let summary: string;
    if (resolution?.course && resolution.effects.length) {
      const planned = this.poisonEffectPlan(input.target, resolution.course, resolution.effects,
        "immediate", input.receiptId);
      if (!planned.ok) return { ok: false, error: planned.error };
      next = { ...next, courses: { ...next.courses, [planned.course.id]: planned.course } };
      ops.push(...planned.ops);
      courseId = planned.course.id;
      summary = `${input.target.name} ${input.savePassed ? "resists" : "contracts"} ${definition.name}` +
        `${save?.total !== null && save?.total !== undefined ? ` (${save.total} vs DC ${save.dc ?? "?"})` : ""}.` +
        (planned.summary.length ? ` Effect: ${planned.summary.join(", ")}.` : "");
    } else {
      summary = `${input.target.name} resists ${definition.name}` +
        `${save?.total !== null && save?.total !== undefined ? ` (${save.total} vs DC ${save.dc ?? "?"})` : ""}; no dose or effect was added.`;
    }
    ops.push(...this.poisonStateOps(input.target, state, next, snapshot.existed));
    const bonus = deriveFromActorDocument(input.target).saves[definition.saveType];
    ops.push(this.poisonMessageOp({
      receiptId: input.receiptId, action: "exposure-save", target: input.target, summary,
      ...(courseId ? { courseId } : {}), poisonId: definition.id,
      ...(save?.total !== null && save?.total !== undefined
        ? { roll: { d20: save.total - bonus, bonus, total: save.total,
            dc: save.dc ?? 0, passed: input.savePassed } } : {}),
    }));
    return { ok: true, ops, summary, ...(courseId ? { courseId } : {}), poisonId: definition.id };
  }

  private poisonMessageOp(input: {
    receiptId: string; action: string; target: ActorDocument; summary: string;
    courseId?: string; poisonId?: string; roll?: { d20: number; bonus: number; total: number; dc: number; passed: boolean };
  }): Op {
    const message: MessageDocument = {
      _id: randomId(), type: "message", name: `Poison: ${input.action}`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { poisonReceiptId: input.receiptId } },
      system: { pf1ePoison: {
        receiptId: input.receiptId, action: input.action, targetActorId: input.target._id,
        ...(input.courseId ? { courseId: input.courseId } : {}),
        ...(input.poisonId ? { poisonId: input.poisonId } : {}),
        ...(input.roll ? { roll: input.roll } : {}),
      } },
      author: this.systemUserId,
      content: input.summary.slice(0, 500),
      whisper: [],
      roll: null,
      flavor: "",
    };
    return { kind: "create", coll: "messages", data: message };
  }

  private commitPF1ePoisonEvent(input: {
    receiptId: string; label: string; actorId: UserId; requestId: string; action: string;
    ops: Op[]; target: ActorDocument; summary: string; courseId?: string; poisonId?: string;
    roll?: { d20: number; bonus: number; total: number; dc: number; passed: boolean };
    pathChecks?: readonly { ref: DocRef; paths: readonly string[] }[];
  }): { ok: true; seq: number } | { ok: false; error: string } {
    const ops = [...input.ops, this.poisonMessageOp(input)];
    const paths = new Map<string, { ref: DocRef; paths: Set<string> }>();
    for (const op of ops) {
      if (op.kind !== "update" || op.ref.coll !== "actors") continue;
      const key = JSON.stringify(op.ref);
      const entry = paths.get(key) ?? { ref: op.ref, paths: new Set<string>() };
      for (const diffKey of Object.keys(op.diff))
        entry.paths.add(diffKey.startsWith("-=") ? diffKey.slice(2) : diffKey);
      paths.set(key, entry);
    }
    for (const check of input.pathChecks ?? []) {
      const key = JSON.stringify(check.ref);
      const entry = paths.get(key) ?? { ref: check.ref, paths: new Set<string>() };
      for (const path of check.paths) entry.paths.add(path);
      paths.set(key, entry);
    }
    const audit: ActionAudit = {
      id: input.receiptId,
      label: input.label.slice(0, 160),
      system: { userId: input.actorId, requestId: input.requestId, action: input.action },
      ...(paths.size ? { pathChecks: [...paths.values()].map((entry) => ({
        ref: entry.ref, paths: [...entry.paths],
      })) } : {}),
    };
    return this.commitOps(ops, input.actorId, `poison-${input.requestId}`, true, audit);
  }

  private spendPoisonSpell(actor: ActorDocument, spellName: string, spellUse: unknown):
    { ok: true; ops: Op[]; level: number; casterLevel: number } | { ok: false; error: string } {
    if (!isRecord(spellUse) || Object.keys(spellUse).some((key) => !["kind", "index", "level"].includes(key)))
      return { ok: false, error: "Spell source is malformed" };
    const derived = deriveFromActorDocument(actor);
    if (!derived.casting || !Number.isSafeInteger(derived.spellCasterLevel) || derived.spellCasterLevel < 1)
      return { ok: false, error: "The source actor has no validated spellcasting level" };
    const system = isRecord(actor.system) ? actor.system : {};
    const pf1e = isRecord(system.pf1e) ? system.pf1e : {};
    const spells = isRecord(pf1e.spells) ? pf1e.spells : null;
    if (!spells) return { ok: false, error: "The source actor has no spellbook" };
    const sameSpell = (raw: unknown): boolean => isRecord(raw) && typeof raw.name === "string" &&
      raw.name.trim().toLocaleLowerCase("en-US") === spellName.toLocaleLowerCase("en-US");
    if (spellUse.kind === "prepared") {
      const rawIndex = spellUse.index;
      if (derived.spellMode !== "prepared" || typeof rawIndex !== "number" || !Number.isSafeInteger(rawIndex) ||
          rawIndex < 0 || !Array.isArray(spells.prepared))
        return { ok: false, error: "Prepared spell source is not available" };
      const index = rawIndex;
      const row = spells.prepared[index];
      if (!sameSpell(row) || !isRecord(row) || row.expended === true)
        return { ok: false, error: `${spellName} is not available in that prepared row` };
      const rawLevel = typeof row.slotLevel === "number" ? row.slotLevel : row.level;
      if (typeof rawLevel !== "number" || !Number.isSafeInteger(rawLevel) || rawLevel < 0 || rawLevel > 9)
        return { ok: false, error: "Prepared spell level is invalid" };
      const level = rawLevel;
      const prepared = (spells.prepared as unknown[]).map((entry, i) =>
        i === index && isRecord(entry) ? { ...entry, expended: true } as Json : entry as Json);
      return { ok: true, ops: [{ kind: "update", ref: { coll: "actors", id: actor._id },
        diff: { "system.pf1e.spells.prepared": prepared } }], level, casterLevel: derived.spellCasterLevel };
    }
    if (spellUse.kind === "slot") {
      const rawLevel = spellUse.level;
      if (derived.spellMode !== "spontaneous" || typeof rawLevel !== "number" || !Number.isSafeInteger(rawLevel) ||
          rawLevel < 0 || rawLevel > 9)
        return { ok: false, error: "Spontaneous spell slot source is invalid" };
      const level = rawLevel;
      const known = spells.known;
      if (!Array.isArray(known) || !known.some((entry) => sameSpell(entry) && isRecord(entry) &&
          (entry.level === level || entry.slotLevel === level)))
        return { ok: false, error: `${spellName} is not in the source actor's known spells at that level` };
      const keyScore = derived.casting ? derived.abilities[derived.spellKeyAbility] : null;
      const budget = resolveSpellSlotBudget({ baseSlots: derived.spellSlots.slice(0, 10), keyAbilityScore: keyScore });
      const total = budget.ok ? budget.levels[level]?.total ?? 0 : 0;
      const usedRaw = spells.slotsUsed;
      const usedEntry = isRecord(usedRaw) ? usedRaw[String(level)] : undefined;
      const used = typeof usedEntry === "number" && Number.isSafeInteger(usedEntry) ? usedEntry : 0;
      if (total < 1 || used < 0 || used >= total)
        return { ok: false, error: `No level ${level} spell slot is available` };
      const diff = isRecord(usedRaw)
        ? { [`system.pf1e.spells.slotsUsed.${level}`]: used + 1 }
        : { "system.pf1e.spells.slotsUsed": { [level]: used + 1 } as unknown as Json };
      return { ok: true, ops: [{ kind: "update", ref: { coll: "actors", id: actor._id }, diff }],
        level, casterLevel: derived.spellCasterLevel };
    }
    return { ok: false, error: "Spell source must be a prepared row or spontaneous spell slot" };
  }

  private handleCodexPurchase(session: Session, msg: CodexPurchaseMsg): void {
    const reply = (
      ok: boolean,
      detail: string,
      extras: {
        receiptId?: string;
        totalCopper?: number;
        replayed?: boolean;
      } = {},
    ): void => {
      this.send(session, {
        kind: "codex.purchase.result",
        action: "purchase",
        requestId:
          typeof msg.requestId === "string" ? msg.requestId : "invalid",
        ok,
        detail,
        ...extras,
      });
    };
    const user = session.user;
    if (!user) { reply(false, "You are not authenticated."); return; }
    if (!session.intentBucket.tryRemove()) { reply(false, "Purchase requests are rate-limited."); return; }
    if (!msg || typeof msg !== "object" || Object.keys(msg).some((key) =>
      !["kind", "requestId", "sheetId", "stockRowId", "quantity", "actorId"].includes(key)) ||
      typeof msg.requestId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(msg.requestId) ||
      typeof msg.sheetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.sheetId) ||
      typeof msg.stockRowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.stockRowId) ||
      typeof msg.actorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.actorId) ||
      !Number.isSafeInteger(msg.quantity) || msg.quantity < 1 || msg.quantity > 1_000) {
      reply(false, "The purchase request is malformed.");
      return;
    }
    const receiptId = `codexpurchase_${msg.requestId}`;
    const prior = this.store.get("actionReceipts", receiptId) as ActionReceiptDocument | undefined;
    if (prior) {
      const priorSystem = isRecord(prior.system) ? prior.system : {};
      if (priorSystem.action !== "codex.purchase" || priorSystem.requestId !== msg.requestId ||
          priorSystem.userId !== user.id || priorSystem.sheetId !== msg.sheetId ||
          priorSystem.stockRowId !== msg.stockRowId || priorSystem.actorId !== msg.actorId ||
          priorSystem.quantity !== msg.quantity) {
        reply(false, "This request ID has already been used.");
        return;
      }
      if (prior.status === "ready") {
        reply(
          true,
          "Purchase already completed; no second transfer was made.",
          {
            receiptId,
            ...(typeof priorSystem.totalCopper === "number"
              ? { totalCopper: priorSystem.totalCopper }
              : {}),
            replayed: true,
          },
        );
        return;
      }
      reply(false, prior.status === "reverted"
        ? "This purchase was already reverted. Submit a new request if you still want the item."
        : "This purchase request is already being processed.");
      return;
    }

    const sheet = this.store.get("journals", msg.sheetId) as JournalDocument | undefined;
    const actor = this.store.get("actors", msg.actorId) as ActorDocument | undefined;
    const shop = sheet?.codex?.shop;
    if (!sheet || sheet.type !== "journal" || !shop || !can(user, "read", sheet, "journals") ||
        !codexAudienceAllows(shop.audience, user) || shop.mode !== "shop") {
      reply(false, "This shop is unavailable.");
      return;
    }
    const row = shop.stock.find((candidate) => candidate.id === msg.stockRowId);
    const resolver = { resolve: (ref: DocRef) => this.store.resolve(ref) };
    const sourceItem = row ? this.store.resolve(row.item) as ItemDocument | undefined : undefined;
    if (!row || !sourceItem || sourceItem.type !== "item" ||
        !canReadCodexRef(user, row.item, resolver) ||
        !actor || actor.type !== "actor" || !can(user, "update", actor, "actors") ||
        row.item.parent?.coll === "actors" && row.item.parent.id === actor._id) {
      reply(false, "The stock item or selected character is unavailable.");
      return;
    }
    const plan = planCodexPurchase({ sheet, row, sourceItem, actor, quantity: msg.quantity, itemId: randomId() });
    if (!plan.ok) { reply(false, plan.error); return; }
    const audit: ActionAudit = {
      id: receiptId,
      label: `Codex purchase: ${plan.itemName} ×${msg.quantity}`.slice(0, 160),
      system: {
        action: "codex.purchase",
        requestId: msg.requestId,
        userId: user.id,
        sheetId: msg.sheetId,
        stockRowId: msg.stockRowId,
        actorId: msg.actorId,
        quantity: msg.quantity,
        totalCopper: plan.totalCopper,
      },
      pathChecks: [
        { ref: { coll: "journals", id: sheet._id }, paths: ["codex.shop.stock"] },
        { ref: { coll: "actors", id: actor._id }, paths: ["system.pf1e.currency", "items"] },
      ],
    };
    const committed = this.commitOps(plan.ops, user.id, receiptId, true, audit);
    if (!committed.ok) {
      reply(false, `Purchase was not committed: ${committed.error}`);
      return;
    }
    reply(true, `Purchased ${msg.quantity} × ${plan.itemName}.`, {
      receiptId,
      totalCopper: plan.totalCopper,
    });
  }

  private handleCodexClaim(session: Session, msg: CodexClaimMsg): void {
    const requestId =
      typeof msg?.requestId === "string" && msg.requestId.length <= 96
        ? msg.requestId
        : "invalid";
    const reply = (
      ok: boolean,
      detail: string,
      extras: { receiptId?: string; replayed?: boolean } = {},
    ): void => {
      this.send(session, {
        kind: "codex.purchase.result",
        action: "claim",
        requestId,
        ok,
        detail,
        ...extras,
      });
    };
    const user = session.user;
    if (!user) {
      reply(false, "You are not authenticated.");
      return;
    }
    if (!session.intentBucket.tryRemove()) {
      reply(false, "Loot claims are rate-limited.");
      return;
    }
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.kind !== "codex.claim" ||
      Object.keys(msg).some(
        (key) =>
          ![
            "kind",
            "requestId",
            "sheetId",
            "stockRowId",
            "quantity",
            "actorId",
          ].includes(key),
      ) ||
      typeof msg.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(msg.requestId) ||
      typeof msg.sheetId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(msg.sheetId) ||
      typeof msg.stockRowId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(msg.stockRowId) ||
      typeof msg.actorId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(msg.actorId) ||
      !Number.isSafeInteger(msg.quantity) ||
      msg.quantity < 1 ||
      msg.quantity > 1_000
    ) {
      reply(false, "The loot-claim request is malformed.");
      return;
    }
    const receiptId = `codexclaim_${msg.requestId}`;
    const prior = this.store.get("actionReceipts", receiptId) as
      ActionReceiptDocument | undefined;
    if (prior) {
      const priorSystem = isRecord(prior.system) ? prior.system : {};
      if (
        priorSystem.action !== "codex.claim" ||
        priorSystem.requestId !== msg.requestId ||
        priorSystem.userId !== user.id ||
        priorSystem.sheetId !== msg.sheetId ||
        priorSystem.stockRowId !== msg.stockRowId ||
        priorSystem.actorId !== msg.actorId ||
        priorSystem.quantity !== msg.quantity
      ) {
        reply(false, "This request ID has already been used.");
        return;
      }
      if (prior.status === "ready") {
        reply(
          true,
          "Loot claim already completed; no second transfer was made.",
          {
            receiptId,
            replayed: true,
          },
        );
        return;
      }
      reply(
        false,
        prior.status === "reverted"
          ? "This loot claim was already reverted. Submit a new request if you still want the item."
          : "This loot-claim request is already being processed.",
      );
      return;
    }

    const sheet = this.store.get("journals", msg.sheetId) as
      JournalDocument | undefined;
    const actor = this.store.get("actors", msg.actorId) as
      ActorDocument | undefined;
    const shop = sheet?.codex?.shop;
    if (
      !sheet ||
      sheet.type !== "journal" ||
      !shop ||
      !can(user, "read", sheet, "journals") ||
      !codexAudienceAllows(shop.audience, user) ||
      shop.mode !== "loot"
    ) {
      reply(false, "This loot container is unavailable.");
      return;
    }
    const row = shop.stock.find((candidate) => candidate.id === msg.stockRowId);
    const resolver = { resolve: (ref: DocRef) => this.store.resolve(ref) };
    const sourceItem = row
      ? (this.store.resolve(row.item) as ItemDocument | undefined)
      : undefined;
    if (
      !row ||
      !sourceItem ||
      sourceItem.type !== "item" ||
      !canReadCodexRef(user, row.item, resolver) ||
      !actor ||
      actor.type !== "actor" ||
      !can(user, "update", actor, "actors") ||
      (row.item.parent?.coll === "actors" && row.item.parent.id === actor._id)
    ) {
      reply(false, "The loot item or selected character is unavailable.");
      return;
    }
    const plan = planCodexLootClaim({
      sheet,
      row,
      sourceItem,
      actor,
      quantity: msg.quantity,
      itemId: randomId(),
    });
    if (!plan.ok) {
      reply(false, plan.error);
      return;
    }
    const audit: ActionAudit = {
      id: receiptId,
      label: `Codex loot claim: ${plan.itemName} ×${msg.quantity}`.slice(
        0,
        160,
      ),
      system: {
        action: "codex.claim",
        requestId: msg.requestId,
        userId: user.id,
        sheetId: sheet._id,
        stockRowId: row.id,
        actorId: actor._id,
        quantity: msg.quantity,
      },
      pathChecks: [
        {
          ref: { coll: "journals", id: sheet._id },
          paths: ["codex.shop.stock"],
        },
      ],
    };
    const committed = this.commitOps(plan.ops, user.id, receiptId, true, audit);
    if (!committed.ok) {
      reply(false, `Loot claim was not committed: ${committed.error}`);
      return;
    }
    reply(true, `Claimed ${msg.quantity} × ${plan.itemName}.`, { receiptId });
  }

  private handlePF1eConditionAction(session: Session, raw: WireMessage): void {
    const request = raw as unknown as PF1eConditionActionMsg;
    const requestId = typeof (request as { requestId?: unknown }).requestId === "string"
      ? (request as { requestId: string }).requestId : "";
    if (!session.user) {
      this.reject(session, requestId, "forbidden", "not authenticated");
      return;
    }
    const user = session.user;
    const isGM = user.role === "GM" || user.role === "ASSISTANT";
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, requestId, "rate_limited", "condition action rate exceeded");
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId) ||
        typeof (request as { actorId?: unknown }).actorId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(request.actorId) ||
        (request.action !== "apply" && request.action !== "remove")) {
      this.reject(session, requestId, "invalid_schema", "Invalid PF1e condition action identity");
      return;
    }
    const common = ["kind", "requestId", "action", "actorId"];
    const expected = request.action === "apply"
      ? [...common, "condition", "spell"] : [...common, "applicationId"];
    if (request.kind !== "pf1e.condition" ||
        Object.keys(request as unknown as Record<string, unknown>).some((key) => !expected.includes(key))) {
      this.reject(session, requestId, "invalid_schema", "PF1e condition action contains unknown fields");
      return;
    }
    const actor = this.store.get("actors", request.actorId) as ActorDocument | undefined;
    if (!actor || actor.type !== "actor") {
      this.reject(session, requestId, "invalid_schema", "Condition target actor does not exist");
      return;
    }
    const controlsTarget = can(user, "update", actor, "actors");
    // A player cannot edit an NPC's sheet, but may apply the condition evidenced by their own
    // host-verified landed spell row. The rider validator below re-reads that exact target/card,
    // verifies the saved-outcome rule, and still requires control of the delivering actor.
    const verifiedSpellDelivery = request.action === "apply" && request.spell !== undefined;
    if (!controlsTarget && !verifiedSpellDelivery) {
      this.reject(session, requestId, "forbidden", "You do not control this condition target");
      return;
    }
    const receiptDigest = bytesToHex(sha256(new TextEncoder().encode(`${user.id}\u0000${requestId}`)));
    const receiptId = `condition-${receiptDigest}`;
    const expectedPayload = request.action === "apply"
      ? request.condition : request.applicationId;
    const existing = this.store.get("actionReceipts", receiptId) as ActionReceiptDocument | undefined;
    if (existing) {
      const same = existing.type === "actionReceipt" && existing.system.userId === user.id &&
        existing.system.requestId === requestId && existing.system.action === request.action &&
        existing.system.targetActorId === actor._id && existing.system.payload === expectedPayload;
      if (!same) {
        this.reject(session, requestId, "invalid_schema", "Condition action identity has already been used");
        return;
      }
      const result: import("../core/messages").PF1eConditionActionResultMsg = {
        kind: "pf1e.condition.result", requestId, action: request.action, actorId: actor._id,
        applicationId: String(existing.system.applicationId), receiptId, seq: this.store.seq,
      };
      this.send(session, result);
      return;
    }

    const block = isRecord(actor.system) && isRecord(actor.system.pf1e)
      ? actor.system.pf1e as Record<string, unknown> : null;
    if (!block) {
      this.reject(session, requestId, "invalid_schema", "Condition target has no PF1e system block");
      return;
    }
    const current = validatePF1eConditionApplications(block.conditionApplications);
    if (!current.ok) {
      this.reject(session, requestId, "invalid_schema", current.error);
      return;
    }

    let applicationId: string;
    let condition: string;
    let ops: Op[];
    /** D-407: the landed cast a spell-delivered condition rides, when there is one. */
    let spellRider: { context: { messageId: DocId; targetKey: string; card: ActionCard;
      targetIndex: number }; effect: PF1eSpellEffect } | null = null;
    if (request.action === "apply") {
      if (typeof request.condition !== "string" || request.condition.length > 80) {
        this.reject(session, requestId, "invalid_schema", "Condition name is invalid");
        return;
      }
      const def = pf1eConditionDef(request.condition);
      if (!def) {
        this.reject(session, requestId, "invalid_schema", `Unsupported PF1e condition: ${request.condition}`);
        return;
      }
      const refusal = conditionRefusalFor(def, resolveTacticalEffects(
        combinedTacticalEffects(actor, null, null).effects));
      if (refusal) {
        this.reject(session, requestId, "invalid_schema", refusal);
        return;
      }
      condition = def.name;
      applicationId = `condition-${randomId()}`;
      // D-407 — a condition delivered by a landed cast rides that cast's card. The client names the
      // catalogue effect and the card row; the host re-reads the row, re-checks the outcome against
      // the same effect (never the client's claim) and derives the source from the card itself.
      let spellSource: { kind: "spell"; id: string; actionId: DocId; actorId?: string;
        itemId?: string } | null = null;
      if (request.spell !== undefined) {
        const checked = this.spellEffectRiderContext(request.spell, actor._id, def.name);
        if (!checked.ok) {
          this.reject(session, requestId, "invalid_schema", checked.error);
          return;
        }
        const delivererId = checked.value.card.source.actorId;
        if (!isGM) {
          const deliverer = delivererId
            ? this.store.get("actors", delivererId) as ActorDocument | undefined : undefined;
          if (!deliverer || !can(user, "update", deliverer, "actors")) {
            this.reject(session, requestId, "forbidden",
              "You do not control the actor that delivered this spell effect");
            return;
          }
        }
        if (Object.values(current.value).some((application) =>
          application.condition === def.name && application.source.kind === "spell" &&
          application.source.actionId === checked.value.messageId)) {
          this.reject(session, requestId, "invalid_schema",
            "That card already delivered this condition to the target");
          return;
        }
        spellRider = { context: checked.value, effect: checked.value.effect };
        spellSource = { kind: "spell", id: checked.value.effect.id,
          actionId: checked.value.messageId,
          ...(delivererId !== undefined ? { actorId: delivererId } : {}),
          ...(checked.value.card.source.itemId !== undefined
            ? { itemId: checked.value.card.source.itemId } : {}) };
      }
      const applied = pf1eApplyConditionApplication({
        actor, condition, id: applicationId,
        source: spellSource ?? { kind: "manual", id: user.id, actionId: receiptId },
        removal: spellSource === null ? { kind: "manual" }
          : { kind: "manual", reason: `delivered by ${spellRider?.effect.name ?? "a spell"}` },
      });
      if (!applied.ok) {
        this.reject(session, requestId, "invalid_schema", applied.error);
        return;
      }
      ops = applied.value;
      if (spellRider !== null) {
        const row = spellRider.context.card.targets[spellRider.context.targetIndex];
        const rider: ActionRider = {
          kind: "condition", label: condition, state: "applied",
          facts: this.conditionRiderFacts(spellRider.effect, condition, row?.check?.dc ?? null),
          evidence: { adapter: "pf1e.spellEffect.v1", payload: {
            effectId: spellRider.effect.id, version: spellRider.effect.version, condition,
            actionId: spellRider.context.messageId, targetKey: spellRider.context.targetKey,
          } as unknown as Json },
        };
        const attached = this.actionRiderAttachOps({ context: spellRider.context, rider });
        if (!attached.ok) {
          this.reject(session, requestId, "invariant", attached.error);
          return;
        }
        ops.push(...attached.ops);
      }
    } else {
      if (typeof request.applicationId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(request.applicationId)) {
        this.reject(session, requestId, "invalid_schema", "Condition application ID is invalid");
        return;
      }
      const existingApplication = current.value[request.applicationId];
      if (!existingApplication) {
        this.reject(session, requestId, "invalid_schema", "Condition application is no longer active");
        return;
      }
      applicationId = existingApplication.id;
      condition = existingApplication.condition;
      const removed = pf1eRemoveConditionApplication(actor, applicationId);
      if (!removed.ok) {
        this.reject(session, requestId, "invalid_schema", removed.error);
        return;
      }
      ops = removed.value;
    }

    if (ops.length === 0) {
      this.reject(session, requestId, "invalid_schema", "Condition action produced no authoritative changes");
      return;
    }
    const paths = new Set<string>();
    for (const op of ops) {
      if (op.kind !== "update" || op.ref.coll !== "actors" || op.ref.id !== actor._id) continue;
      for (const key of Object.keys(op.diff)) paths.add(key.startsWith("-=") ? key.slice(2) : key);
    }
    const messagePaths = new Set<string>();
    for (const op of ops) {
      if (op.kind !== "update" || op.ref.coll !== "messages") continue;
      for (const key of Object.keys(op.diff)) messagePaths.add(key.startsWith("-=") ? key.slice(2) : key);
    }
    ops.push(this.conditionMessageOp({ receiptId, action: request.action, actor, condition,
      applicationId, by: user.id,
      ...(spellRider !== null ? { via: spellRider.effect.name } : {}) }));
    const audit: ActionAudit = {
      id: receiptId,
      label: `Condition ${request.action}: ${condition} (${actor.name})`.slice(0, 160),
      system: {
        userId: user.id, requestId, action: request.action,
        targetActorId: actor._id, payload: expectedPayload, applicationId,
      },
      pathChecks: [
        ...(paths.size ? [{ ref: { coll: "actors" as const, id: actor._id }, paths: [...paths] }] : []),
        ...(messagePaths.size && spellRider !== null
          ? [{ ref: { coll: "messages" as const, id: spellRider.context.messageId }, paths: [...messagePaths] }]
          : []),
      ],
    };
    const committed = this.commitOps(ops, user.id, requestId, true, audit);
    if (!committed.ok) {
      this.reject(session, requestId, "invariant", committed.error);
      return;
    }
    if (request.action === "apply" && spellRider?.effect.conditionFxMacroId) {
      const row = spellRider.context.card.targets[spellRider.context.targetIndex];
      const sceneId = spellRider.context.card.sceneId ?? spellRider.context.card.area?.sceneId;
      if (sceneId && row?.tokenId) {
        const prepared = this.prepareFx(user, {
          macroId: spellRider.effect.conditionFxMacroId,
          sceneId,
          ...(spellRider.context.card.source.tokenId
            ? { sourceTokenId: spellRider.context.card.source.tokenId } : {}),
          targetTokenId: row.tokenId,
        });
        // The persistent token visual is owned by this exact authoritative application. Failure
        // to deliver a cue never rolls back the already-committed PF1e condition.
        if (prepared.ok && prepared.cue.persistent === true)
          this.emitPreparedFx({ ...prepared, conditionApplicationId: applicationId });
      }
    }
    const result: import("../core/messages").PF1eConditionActionResultMsg = {
      kind: "pf1e.condition.result", requestId, action: request.action,
      actorId: actor._id, applicationId, receiptId, seq: committed.seq,
    };
    this.send(session, result);
  }

  private handlePF1ePoisonAction(session: Session, raw: WireMessage): void {
    const request = raw as unknown as PF1ePoisonActionMsg;
    const requestId = typeof (request as { requestId?: unknown }).requestId === "string"
      ? (request as { requestId: string }).requestId : "";
    if (!session.user) {
      this.reject(session, requestId, "forbidden", "not authenticated");
      return;
    }
    const user = session.user;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, requestId, "rate_limited", "poison action rate exceeded");
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId) ||
        typeof (request as { targetActorId?: unknown }).targetActorId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(request.targetActorId) ||
        !["expose", "frequency", "delay-start", "delay-end", "neutralize"].includes(request.action)) {
      this.reject(session, requestId, "invalid_schema", "Invalid PF1e poison action identity");
      return;
    }
    const common = ["kind", "requestId", "action", "targetActorId"];
    const fields: Record<string, readonly string[]> = {
      expose: [...common, "poisonId", "route", "doseCount", "sourceActorId", "sourceItemId", "rider"],
      frequency: [...common, "courseId"],
      "delay-start": [...common, "sourceActorId", "spellUse"],
      "delay-end": common,
      neutralize: [...common, "sourceActorId", "spellUse", "courseId"],
    };
    const allowed = fields[request.action] ?? common;
    if (request.kind !== "pf1e.poison" || Object.keys(request as unknown as Record<string, unknown>)
        .some((key) => !allowed.includes(key))) {
      this.reject(session, requestId, "invalid_schema", "PF1e poison action contains unknown fields");
      return;
    }
    const target = this.store.get("actors", request.targetActorId) as ActorDocument | undefined;
    if (!target || target.type !== "actor") {
      this.reject(session, requestId, "invalid_schema", "Poison target actor does not exist");
      return;
    }
    const isGM = user.role === "GM";
    const targetOwned = can(user, "update", target, "actors");
    // An environmental/insistence exposure is the GM's call; a rider exposure rides the caller's own
    // landed action, so the deliverer's control of the delivering source is the authorization.
    if (request.action === "expose" && !isGM && request.rider === undefined) {
      this.reject(session, requestId, "forbidden", "Only a GM can create poison exposure events");
      return;
    }
    if (request.action === "frequency") {
      this.reject(session, requestId, "forbidden", "Poison frequency saves are host-scheduled and cannot be client-authored");
      return;
    }
    if (request.action === "delay-end" && !isGM && !targetOwned) {
      this.reject(session, requestId, "forbidden", "You do not control this poison target");
      return;
    }
    let sourceActor: ActorDocument | undefined;
    if (request.action === "delay-start" || request.action === "neutralize") {
      sourceActor = this.store.get("actors", request.sourceActorId) as ActorDocument | undefined;
      if (!sourceActor || sourceActor.type !== "actor") {
        this.reject(session, requestId, "invalid_schema", "Spell source actor does not exist");
        return;
      }
      if (!isGM && (!can(user, "update", sourceActor, "actors") || !targetOwned)) {
        this.reject(session, requestId, "forbidden", "You must control both the spell source and target actors");
        return;
      }
    }
    if ((request.action === "delay-start" || request.action === "delay-end" || request.action === "neutralize") &&
        !isGM && !targetOwned) {
      this.reject(session, requestId, "forbidden", "You do not control this poison target");
      return;
    }

    const digest = bytesToHex(sha256(new TextEncoder().encode(`${user.id}\u0000${requestId}`)));
    const receiptId = `poison-${digest}`;
    const existingReceipt = this.store.get("actionReceipts", receiptId) as ActionReceiptDocument | undefined;
    if (existingReceipt) {
      if (existingReceipt.type === "actionReceipt" && existingReceipt.system.userId === user.id &&
          existingReceipt.system.requestId === requestId && existingReceipt.system.action === request.action) return;
      this.reject(session, requestId, "invalid_schema", "Poison action identity has already been used");
      return;
    }

    let riderContext: { messageId: DocId; targetKey: string; card: ActionCard; targetIndex: number } | null = null;
    if (request.action === "expose" && request.rider !== undefined) {
      const checked = this.poisonRiderContext(request.rider, target._id);
      if (!checked.ok) {
        this.reject(session, requestId, "invalid_schema", checked.error);
        return;
      }
      riderContext = checked.value;
      if (!isGM) {
        const deliverer = riderContext.card.source.actorId
          ? this.store.get("actors", riderContext.card.source.actorId) as ActorDocument | undefined : undefined;
        if (!deliverer || !can(user, "update", deliverer, "actors")) {
          this.reject(session, requestId, "forbidden",
            "Only the delivering actor's owner or a GM can attach a poison rider");
          return;
        }
      }
    }
    const snapshot = this.poisonStateSnapshot(target);
    if (!snapshot.ok) {
      this.reject(session, requestId, "invalid_schema", snapshot.error);
      return;
    }
    const before = snapshot.state;
    const now = readWorldClock(this.store.getAll("settings"));
    let next: PF1ePoisonTargetState;
    const ops: Op[] = [];
    let actionLabel: string;
    let summary: string;
    let courseId: string | undefined;
    let poisonId: string | undefined;
    let roll: { d20: number; bonus: number; total: number; dc: number; passed: boolean } | undefined;
    let poisonPathChecks: { ref: DocRef; paths: readonly string[] }[] | undefined;

    if (request.action === "expose") {
      // A rider inherits the delivering action's source identity when the caller names none.
      const inheritSource = request.sourceActorId === undefined && request.sourceItemId === undefined;
      const sourceActorId: string | undefined = inheritSource
        ? riderContext?.card.source.actorId : request.sourceActorId;
      const sourceItemId: string | undefined = inheritSource
        ? riderContext?.card.source.itemId : request.sourceItemId;
      if (typeof request.poisonId !== "string" || typeof request.poisonId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(request.poisonId)) {
        this.reject(session, requestId, "invalid_schema", "Poison profile ID is invalid");
        return;
      }
      const fixture = PF1E_POISON_FIXTURES.find((entry) => entry.id === request.poisonId);
      if (!fixture) {
        this.reject(session, requestId, "invalid_schema", "Poison profile is not in the host-validated Core pack");
        return;
      }
      const route = request.route ?? fixture.delivery[0];
      if (!route || !fixture.delivery.includes(route)) {
        this.reject(session, requestId, "invalid_schema", `${fixture.name} does not support that delivery route`);
        return;
      }
      const doseCount = route === "injury" || route === "contact" ? 1 : (request.doseCount ?? 1);
      if (!Number.isSafeInteger(doseCount) || doseCount < 1 || doseCount > 100_000 ||
          ((route === "injury" || route === "contact") && request.doseCount !== undefined && request.doseCount !== 1)) {
        this.reject(session, requestId, "invalid_schema", "Invalid poison dose batch for this delivery route");
        return;
      }
      if (sourceActorId !== undefined &&
          (typeof sourceActorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceActorId))) {
        this.reject(session, requestId, "invalid_schema", "Poison source actor ID is invalid");
        return;
      }
      if (sourceItemId !== undefined &&
          (typeof sourceItemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceItemId) || !sourceActorId)) {
        this.reject(session, requestId, "invalid_schema", "A poison source item requires a valid source actor");
        return;
      }
      let definition = fixture;
      if (fixture.dcSource === "creature-derived") {
        const source = sourceActorId
          ? this.store.get("actors", sourceActorId) as ActorDocument | undefined : undefined;
        const sourcePf1e = source ? this.poisonBlock(source) : {};
        const hitDice = sourcePf1e.hitDice;
        const conModifier = source ? deriveFromActorDocument(source).abilityMods.con : NaN;
        if (!source || !Number.isSafeInteger(hitDice)) {
          this.reject(session, requestId, "invalid_schema", "Creature-derived poison DC needs an authored source creature with Hit Dice");
          return;
        }
        const baseDC = pf1eCreaturePoisonBaseDc(hitDice as number, conModifier);
        if (baseDC === null) {
          this.reject(session, requestId, "invalid_schema", "Could not resolve this creature's poison DC");
          return;
        }
        definition = { ...fixture, baseDC };
      }
      const sourceActorForItem = sourceActorId
        ? this.store.get("actors", sourceActorId) as ActorDocument | undefined : undefined;
      if (sourceActorId && !sourceActorForItem) {
        this.reject(session, requestId, "invalid_schema", "Poison source actor does not exist");
        return;
      }
      if (sourceItemId && !sourceActorForItem?.items?.some((item) => item._id === sourceItemId)) {
        this.reject(session, requestId, "invalid_schema", "Poison source item is not carried by its source actor");
        return;
      }
      const source = {
        kind: sourceItemId ? "item" as const : sourceActorId ? "attack" as const : "environment" as const,
        actionId: receiptId,
        sourceId: definition.id,
        ...(sourceActorId ? { actorId: sourceActorId } : {}),
        ...(sourceItemId ? { itemId: sourceItemId } : {}),
      };
      const exposureId = `exposure-${randomId()}`;
      const newCourseId = `course-${randomId()}`;
      const exposure = { targetId: target._id, definition, newCourseId, exposureId, route, doseCount,
        exposedAt: now, source, receiptId };
      const immune = this.poisonImmune(target);
      const queued = before.delayPoison.active;
      const definitionIdentity = pf1ePoisonDefinitionIdentity(definition);
      const active = Object.values(before.courses).find((course) =>
        course.definitionIdentity === definitionIdentity && (course.state === "active" || course.state === "onset"));
      const dc = !immune && !queued
        ? pf1ePoisonExposureSaveDc(definition.baseDC, active?.doseCount ?? 0, doseCount) : null;
      if (!immune && !queued && dc === null) {
        this.reject(session, requestId, "invalid_schema", "Could not calculate poison exposure DC");
        return;
      }
      if (riderContext !== null && dc !== null && this.poisonSaveDeferred(target)) {
        const committed = this.commitPF1ePoisonRiderPending({
          context: riderContext, target, definition, baseDC: definition.baseDC, route, doseCount, dc,
          exposureId, newCourseId,
          ...(sourceActorId !== undefined ? { sourceActorId } : {}),
          ...(sourceItemId !== undefined ? { sourceItemId } : {}),
          receiptId, requestId, by: user.id,
        });
        if (!committed.ok) {
          this.reject(session, requestId, "invariant", committed.error);
          return;
        }
        return;
      }
      if (dc !== null) {
        const savingThrow = this.poisonSave(target, definition.saveType, dc);
        roll = { ...savingThrow, dc };
      }
      const applied = applyPF1ePoisonExposureToTarget({
        state: before, exposure, ...(roll ? { savePassed: roll.passed } : {}),
        resolvedAt: now, ...(immune ? { immune: true } : {}),
      });
      if (!applied.ok) {
        this.reject(session, requestId, "invalid_schema", applied.error);
        return;
      }
      next = applied.value.state;
      const resolution = applied.value.resolution;
      if (resolution?.course && resolution.effects.length) {
        const planned = this.poisonEffectPlan(target, resolution.course, resolution.effects, "immediate", receiptId);
        if (!planned.ok) {
          this.reject(session, requestId, "invalid_schema", planned.error);
          return;
        }
        next = { ...next, courses: { ...next.courses, [planned.course.id]: planned.course } };
        ops.push(...planned.ops);
        summary = `${target.name} is exposed to ${definition.name}; initial save ${roll?.total ?? "—"} vs DC ${roll?.dc ?? "—"}.` +
          (planned.summary.length ? ` Effect: ${planned.summary.join(", ")}.` : "");
      } else if (applied.value.queued) {
        summary = `${target.name}: ${definition.name} exposure queued while Delay Poison is active; its initial save will be resolved when the spell ends.`;
      } else if (immune) {
        summary = `${target.name} is immune to poison; ${definition.name} exposure had no effect.`;
      } else if (roll?.passed) {
        summary = `${target.name} resists ${definition.name} (initial save ${roll.total} vs DC ${roll.dc}); no dose or effect was added.`;
      } else {
        summary = `${target.name} contracts ${definition.name} (initial save ${roll?.total} vs DC ${roll?.dc}).`;
      }
      courseId = resolution?.course?.id;
      poisonId = definition.id;
      actionLabel = `Poison exposure: ${definition.name}`;
      if (riderContext !== null) {
        // The card is the delivery record: attach the outcome (applied/resisted/immune/queued)
        // with the same evidence a deferred save would have carried.
        const riderState: ActionRider["state"] = immune ? "immune"
          : applied.value.queued ? "queued" : roll?.passed ? "resisted" : "applied";
        const riderRecord: ActionRider = {
          kind: "poison", label: definition.name, state: riderState,
          ...(roll ? { save: { saveType: definition.saveType, dc: roll.dc, total: roll.total, passed: roll.passed } } : {}),
          facts: this.poisonRiderFacts(definition, dc),
          evidence: { adapter: "pf1e.poison.v1", payload: this.poisonRiderEvidencePayload({
            definition, baseDC: definition.baseDC, route, doseCount, exposureId, newCourseId,
            ...(sourceActorId !== undefined ? { sourceActorId } : {}),
            ...(sourceItemId !== undefined ? { sourceItemId } : {}),
          }) },
        };
        const attached = this.actionRiderAttachOps({ context: riderContext, rider: riderRecord });
        if (!attached.ok) {
          this.reject(session, requestId, "invariant", attached.error);
          return;
        }
        ops.push(...attached.ops);
        poisonPathChecks = [{ ref: { coll: "messages", id: riderContext.messageId }, paths: ["system.action"] }];
      }
    } else if (request.action === "delay-start") {
      if (!sourceActor) {
        this.reject(session, requestId, "invalid_schema", "Delay Poison has no source actor");
        return;
      }
      if (before.delayPoison.active) {
        this.reject(session, requestId, "invalid_schema", "Delay Poison is already active on this target");
        return;
      }
      const spent = this.spendPoisonSpell(sourceActor, "Delay Poison", request.spellUse);
      if (!spent.ok) {
        this.reject(session, requestId, "invalid_schema", spent.error);
        return;
      }
      const source = { kind: "ability" as const, actionId: receiptId, actorId: sourceActor._id, abilityId: "Delay Poison" };
      const activated = activatePF1eDelayPoison(before, now, {
        durationSeconds: spent.casterLevel * 3600, source, casterLevel: spent.casterLevel,
      });
      if (!activated.ok) {
        this.reject(session, requestId, "invalid_schema", activated.error);
        return;
      }
      next = activated.value;
      ops.push(...spent.ops);
      actionLabel = `Delay Poison: ${target.name}`;
      summary = `${target.name} is protected by Delay Poison for ${spent.casterLevel} hour${spent.casterLevel === 1 ? "" : "s"}; active courses are paused and new exposures are queued.`;
    } else if (request.action === "delay-end") {
      const ended = endPF1eDelayPoison(before, now);
      if (!ended.ok) {
        this.reject(session, requestId, "invalid_schema", ended.error);
        return;
      }
      next = ended.value;
      actionLabel = `End Delay Poison: ${target.name}`;
      summary = `${target.name}'s Delay Poison ends; queued poison exposures will now resolve in order.`;
    } else if (request.action === "neutralize") {
      if (!sourceActor || typeof request.courseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.courseId)) {
        this.reject(session, requestId, "invalid_schema", "Neutralize Poison source/course is invalid");
        return;
      }
      const spent = this.spendPoisonSpell(sourceActor, "Neutralize Poison", request.spellUse);
      if (!spent.ok) {
        this.reject(session, requestId, "invalid_schema", spent.error);
        return;
      }
      const neutralized = neutralizePF1ePoisonCourse({ state: before, courseId: request.courseId,
        attemptId: `neutralize-${randomId()}`, now, receiptId });
      if (!neutralized.ok) {
        this.reject(session, requestId, "invalid_schema", neutralized.error);
        return;
      }
      const removed = this.poisonRemoveEffectOps(target, neutralized.value.effectIdsToRemove);
      if (!removed.ok) {
        this.reject(session, requestId, "invalid_schema", removed.error);
        return;
      }
      next = neutralized.value.state;
      ops.push(...spent.ops, ...removed.ops);
      courseId = neutralized.value.course.id;
      poisonId = neutralized.value.course.definition.id;
      actionLabel = `Neutralize Poison: ${target.name}`;
      summary = `${neutralized.value.course.definition.name} on ${target.name} is neutralized; damage already suffered is unchanged.`;
    } else {
      this.reject(session, requestId, "invalid_schema", "Unknown PF1e poison action");
      return;
    }

    ops.push(...this.poisonStateOps(target, before, next, snapshot.existed));
    if (ops.length === 0) {
      this.reject(session, requestId, "invalid_schema", "Poison action produced no authoritative changes");
      return;
    }
    const committed = this.commitPF1ePoisonEvent({
      receiptId, label: actionLabel, actorId: user.id, requestId, action: request.action,
      ops, target, summary, ...(courseId ? { courseId } : {}), ...(poisonId ? { poisonId } : {}),
      ...(roll ? { roll } : {}),
      ...(poisonPathChecks ? { pathChecks: poisonPathChecks } : {}),
    });
    if (!committed.ok) {
      this.reject(session, requestId, "invariant", committed.error);
      return;
    }
    if (request.action === "delay-end")
      this.sweepPF1ePoisonDue(now, new Set([target._id]));
  }

  /** World-clock and affected-creature turn boundaries drive saves; client-supplied outcomes never do. */
  private sweepPF1ePoisonDue(now: number, turnActorIds: ReadonlySet<string> = new Set()): void {
    if (this.poisonSweepDepth > 0 || !Number.isSafeInteger(now) || now < 0) return;
    this.poisonSweepDepth++;
    let budget = 512;
    try {
      for (const original of this.store.getAll("actors") as readonly ActorDocument[]) {
        if (budget <= 0) break;
        let actor = this.store.get("actors", original._id) as ActorDocument | undefined;
        if (!actor || actor.type !== "actor") continue;
        let snapshot = this.poisonStateSnapshot(actor);
        if (!snapshot.ok) continue;
        let state = snapshot.state;

        if (state.delayPoison.active && state.delayPoison.endsAt !== null && state.delayPoison.endsAt <= now) {
          const ended = endPF1eDelayPoison(state, now);
          if (ended.ok) {
            const receiptId = `poison-${randomId()}`;
            const ops = this.poisonStateOps(actor, state, ended.value, snapshot.ok && snapshot.existed);
            const committed = this.commitPF1ePoisonEvent({ receiptId, label: `Delay Poison expires: ${actor.name}`,
              actorId: this.systemUserId, requestId: receiptId, action: "delay-expiry", ops, target: actor,
              summary: `Delay Poison expires on ${actor.name}; queued poison exposures resolve in order.` });
            if (!committed.ok) continue;
            actor = this.store.get("actors", actor._id) as ActorDocument;
            snapshot = this.poisonStateSnapshot(actor);
            if (!snapshot.ok) continue;
            state = snapshot.state;
            budget--;
          }
        }

        // Queued exposures resolve in source timestamp/ID order, and each is its own durable event.
        while (!state.delayPoison.active && state.queuedExposures.length > 0 && budget > 0) {
          const nextExposure = nextPF1eQueuedPoisonExposure(state);
          if (!nextExposure.ok || !nextExposure.value) break;
          const exposure = nextExposure.value.exposure;
          const immune = this.poisonImmune(actor);
          const saving = immune ? null : this.poisonSave(actor, exposure.definition.saveType, nextExposure.value.dc);
          const receiptId = `poison-${randomId()}`;
          const resolved = resolveNextPF1eQueuedPoisonExposure({
            state, exposureId: exposure.exposureId, savePassed: saving?.passed ?? false,
            now, ...(immune ? { immune: true } : {}),
          });
          if (!resolved.ok) break;
          let nextState = resolved.value.state;
          const eventOps: Op[] = [];
          const result = resolved.value.resolution;
          let effectSummary: string[] = [];
          if (result?.course && result.effects.length) {
            const effectPlan = this.poisonEffectPlan(actor, result.course, result.effects, "immediate", receiptId);
            if (!effectPlan.ok) break;
            eventOps.push(...effectPlan.ops);
            effectSummary = effectPlan.summary;
            nextState = { ...nextState, courses: { ...nextState.courses, [effectPlan.course.id]: effectPlan.course } };
          }
          const eventCourseId = result?.course?.id;
          const ops = [...eventOps, ...this.poisonStateOps(actor, state, nextState, snapshot.ok && snapshot.existed)];
          const summary = immune
            ? `${actor.name} is immune to ${exposure.definition.name}; queued exposure has no effect.`
            : saving?.passed
              ? `${actor.name} resists queued ${exposure.definition.name} exposure (${saving.total} vs DC ${nextExposure.value.dc}); no dose or effect was added.`
              : `${actor.name} contracts queued ${exposure.definition.name} (${saving?.total} vs DC ${nextExposure.value.dc}).` +
                (effectSummary.length ? ` Effect: ${effectSummary.join(", ")}.` : "");
          const committed = this.commitPF1ePoisonEvent({ receiptId, label: `Poison exposure resolves: ${exposure.definition.name}`,
            actorId: this.systemUserId, requestId: receiptId, action: "queued-exposure", ops, target: actor, summary,
            ...(eventCourseId ? { courseId: eventCourseId } : {}), poisonId: exposure.definition.id,
            ...(saving ? { roll: { ...saving, dc: nextExposure.value.dc } } : {}) });
          if (!committed.ok) break;
          budget--;
          actor = this.store.get("actors", actor._id) as ActorDocument;
          snapshot = this.poisonStateSnapshot(actor);
          if (!snapshot.ok) break;
          state = snapshot.state;
        }

        if (state.delayPoison.active) continue;
        const courses = Object.values(state.courses).sort((a, b) => a.id.localeCompare(b.id));
        for (const originalCourse of courses) {
          let course = state.courses[originalCourse.id];
          while (course && (course.state === "onset" || course.state === "active") &&
              course.pausedAt === null && budget > 0) {
            const frequency = course.definition.frequency;
            if (course.state === "onset" && frequency === null) {
              const onsetDue = course.onsetDueAt;
              const turnDue = course.definition.onset?.unit === "round" && turnActorIds.has(actor._id);
              if (onsetDue === null || (onsetDue > now && !turnDue)) break;
              const eventTime = Math.max(now, onsetDue);
              const receiptId = `poison-${randomId()}`;
              const resolved = resolvePF1ePoisonOnset({ course, attemptId: `${course.id}-onset`, now: eventTime, receiptId });
              if (!resolved.ok) break;
              const planned = this.poisonEffectPlan(actor, resolved.value.course, resolved.value.effects, "oneShot", receiptId);
              if (!planned.ok) break;
              const nextState = { ...state, courses: { ...state.courses, [course.id]: planned.course } };
              const ops = [...planned.ops, ...this.poisonStateOps(actor, state, nextState, snapshot.ok && snapshot.existed)];
              const committed = this.commitPF1ePoisonEvent({ receiptId, label: `Poison onset: ${course.definition.name}`,
                actorId: this.systemUserId, requestId: receiptId, action: "onset", ops, target: actor,
                summary: `${actor.name}: ${course.definition.name} onset elapsed.` +
                  (planned.summary.length ? ` Effect: ${planned.summary.join(", ")}.` : ""),
                courseId: course.id, poisonId: course.definition.id });
              if (!committed.ok) break;
              budget--;
              actor = this.store.get("actors", actor._id) as ActorDocument;
              snapshot = this.poisonStateSnapshot(actor);
              if (!snapshot.ok) break;
              state = snapshot.state;
              course = state.courses[originalCourse.id];
              continue;
            }
            if (!frequency || course.nextAttemptAt === null) break;
            const roundFrequency = frequency.interval.unit === "round";
            const turnDue = roundFrequency && turnActorIds.has(actor._id);
            if (course.nextAttemptAt > now && !turnDue) break;
            if (course.state === "onset" && course.onsetDueAt !== null && course.onsetDueAt > now && !turnDue) break;
            const eventTime = course.nextAttemptAt <= now ? course.nextAttemptAt : course.nextAttemptAt;
            const dc = pf1ePoisonOngoingSaveDc(course.definition.baseDC, course.doseCount);
            if (dc === null) break;
            const saving = this.poisonSave(actor, course.definition.saveType, dc);
            const receiptId = `poison-${randomId()}`;
            const attemptId = `${course.id}-attempt-${course.attemptsResolved + 1}`;
            const resolved = resolvePF1ePoisonFrequencySave({ course, attemptId, now: eventTime,
              passed: saving.passed, receiptId });
            if (!resolved.ok) break;
            const planned = this.poisonEffectPlan(actor, resolved.value.course, resolved.value.effects, "periodic", receiptId);
            if (!planned.ok) break;
            const removal = this.poisonRemoveEffectOps(actor, resolved.value.effectIdsToRemove);
            if (!removal.ok) break;
            const nextState = { ...state, courses: { ...state.courses, [course.id]: planned.course } };
            const ops = [...planned.ops, ...removal.ops, ...this.poisonStateOps(actor, state, nextState, snapshot.ok && snapshot.existed)];
            const summary = `${actor.name}: ${course.definition.name}, ${course.definition.saveType.toUpperCase()} ${saving.total} vs DC ${dc} — ${saving.passed ? "success" : "failure"}.` +
              (planned.summary.length ? ` Effect: ${planned.summary.join(", ")}.` : "") +
              (resolved.value.cured ? " Poison cured." : resolved.value.expired ? " Course expired." : "");
            const committed = this.commitPF1ePoisonEvent({ receiptId, label: `Poison save: ${course.definition.name}`,
              actorId: this.systemUserId, requestId: receiptId, action: "frequency-save", ops, target: actor,
              summary, courseId: course.id, poisonId: course.definition.id,
              roll: { ...saving, dc } });
            if (!committed.ok) break;
            budget--;
            actor = this.store.get("actors", actor._id) as ActorDocument;
            snapshot = this.poisonStateSnapshot(actor);
            if (!snapshot.ok) break;
            state = snapshot.state;
            course = state.courses[originalCourse.id];
            // A combat-turn trigger is one save opportunity, not a catch-up loop. Clock advances
            // may replay all elapsed non-round boundaries, one saved interval at a time.
            if (roundFrequency && turnDue && course?.nextAttemptAt !== undefined && course.nextAttemptAt !== null &&
                course.nextAttemptAt > now) break;
          }
        }
      }
    } finally {
      this.poisonSweepDepth--;
    }
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
    const committed = this.commitOps(ops, this.systemUserId, `action-revert-${id}`, false, undefined, undefined, true);
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

  /**
   * TR-12 / MC-01 (D-381): run a saved automation macro.
   *
   * The client names a **macro**, never a graph, so a player can hold a callable
   * directory entry without ever holding a private graph id. The host resolves the
   * GM-authored binding against live state and applies the same publication rules a
   * direct trigger obeys: the definition must still validate, the graph must still
   * subscribe to `manual`, a region anchor and the `playerRunnable` gate decide
   * whether a player may ask, and a player must be looking at the graph's own scene.
   * Success and refusal both answer with `macro.result`; a refusal never tells a
   * player whether the graph exists, what it is called, or why it said no.
   *
   * MC-01 (D-386) adds the `composite` kind: a macro whose binding is an ordered list of
   * automation macros. The children are resolved here, against live state, with the very
   * same rules and under the caller's own identity — a composite is a convenience, never
   * an authority of its own. All children are pre-flighted before the first one fires, so
   * a caller who may not run one of them gets nothing at all.
   */
  /** D-394: personal authoring is one authenticated, undoable world operation, never a grant. */
  private handleMacroSave(session: Session, msg: MacroSaveMsg): void {
    const caller = session.user;
    if (!caller || typeof msg.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.macroId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(msg.macroId)) return;
    const base = { kind: "macro.result" as const, requestId: msg.requestId, macroId: msg.macroId, callerId: caller.id };
    if (!session.intentBucket.tryRemove()) {
      this.send(session, { ...base, ok: false, detail: "macro saving rate-limited" }); return;
    }
    const key = `${caller.id}\u0000${msg.requestId}`;
    const prior = this.seenMacroSaves.get(key);
    if (prior) { this.send(session, prior); return; }
    const reply = (ok: boolean, detail: string): void => {
      const result = { ...base, ok, detail };
      this.seenMacroSaves.set(key, result);
      if (this.seenMacroSaves.size > 256) {
        const first = this.seenMacroSaves.keys().next().value;
        if (first) this.seenMacroSaves.delete(first);
      }
      this.send(session, result);
    };
    if (!["save", "delete"].includes(msg.action) || Object.keys(msg).some((field) =>
        !["kind", "requestId", "macroId", "action", ...(msg.action === "save" ? ["draft"] : [])].includes(field))) {
      reply(false, "invalid personal macro request"); return;
    }
    if (!canSaveWorldMacros(caller, this.store.getAll("users"))) {
      reply(false, "GM has not enabled world macro saving for you"); return;
    }
    const previous = this.store.get("macros", msg.macroId) as MacroDocument | undefined;
    // Existing foreign, private, revoked and unsupported-kind refs are indistinguishable.
    if (previous && !ownsPlayerMacro(caller, previous) || msg.action === "delete" && !previous) {
      reply(false, "personal macro unavailable"); return;
    }
    let ops: Op[];
    if (msg.action === "delete") ops = [{ kind: "delete", ref: { coll: "macros", id: msg.macroId } }];
    else {
      const checked = validatePlayerMacroDraft(msg.draft);
      if (!checked.ok) { reply(false, checked.error); return; }
      if (!previous && this.store.getAll("macros").filter((macro) =>
          playerMacroAuthoring(macro)?.userId === caller.id).length >= PLAYER_MACRO_LIMITS.perUser) {
        reply(false, "limit of 64 personal macros per player"); return;
      }
      if (checked.draft.kind === "script") {
        const scene = this.store.get("scenes", checked.draft.sceneId);
        if (!scene || !docVisibleTo(caller, scene)) { reply(false, "script draft scene unavailable"); return; }
      }
      const doc = buildPlayerMacro(msg.macroId, caller.id, checked.draft, previous);
      if (previous) {
        // Explicit clears prevent a kind switch from retaining reviewed source/policy/bindings.
        ops = [{ kind: "update", ref: { coll: "macros", id: msg.macroId }, diff: {
          kind: doc.kind, name: doc.name, command: doc.command, ownership: doc.ownership,
          flags: doc.flags, system: doc.system, playerAuthoring: doc.playerAuthoring as unknown as Json,
          script: doc.script as unknown as Json ?? null, scriptState: doc.scriptState as unknown as Json ?? null,
          sequence: null, summon: null, preset: null, fxItem: null, fxSpell: null,
          automation: null, composite: null,
        } }];
      } else ops = [{ kind: "create", coll: "macros", data: doc }];
    }
    const committed = this.commitOps(ops, caller.id, `macro-save-${msg.requestId}`);
    reply(committed.ok, committed.ok ? (msg.action === "delete" ? "Deleted from GM world" : "Saved in GM world — included in next world export")
      : "world macro save failed");
  }

  private handleMacroInvoke(session: Session, msg: MacroInvokeMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "macro invocation rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.macroId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.macroId) ||
        (msg.args !== undefined && (typeof msg.args !== "object" || msg.args === null || Array.isArray(msg.args))) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "macroId", "args"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid automation macro request");
      return;
    }
    const requestKey = `${caller.id}:${msg.requestId}`;
    if (this.seenMacroInvokes.has(requestKey)) return;
    this.seenMacroInvokes.set(requestKey, this.now());
    if (this.seenMacroInvokes.size > 256) {
      const first = this.seenMacroInvokes.keys().next().value;
      if (first) this.seenMacroInvokes.delete(first);
    }
    const isGm = caller.role === "GM" || caller.role === "ASSISTANT";
    const macro = this.store.get("macros", msg.macroId) as MacroDocument | undefined;
    // Same predicate the projection used to hand this macro out in the first place.
    const delivered = macro ? docVisibleTo(caller, macro) : false;
    const base = { kind: "macro.result" as const, requestId: msg.requestId,
      macroId: msg.macroId, callerId: caller.id };
    const refused = (detail: string): void => {
      this.send(session, { ...base, ok: false,
        detail: isGm ? detail : "automation macro unavailable" });
    };
    if (!macro || !delivered) {
      refused("macro unavailable");
      return;
    }
    // MC-01 (D-386): a composite runs its children in order. Every child is pre-flighted
    // first, so a composite either fires all of them or none — and nothing at all when the
    // caller may not run one of them.
    if (macro.kind === "composite") {
      const childIds = macroCompositeMacroIds(macro);
      if (!childIds) {
        refused("macro unavailable");
        return;
      }
      if (msg.args && Object.keys(msg.args).length > 0) {
        // A composite has no declared schema of its own, so it accepts no arguments —
        // a child that wants inputs is called directly.
        refused("a composite macro takes no arguments");
        return;
      }
      const children: Array<{ macro: MacroDocument; target: MacroFireTarget }> = [];
      for (const [index, childId] of childIds.entries()) {
        const child = this.store.get("macros", childId) as MacroDocument | undefined;
        const resolved = child ? this.resolveMacroFireTarget(caller, child, isGm) : null;
        if (!resolved) {
          refused(`composite macro ${index + 1} is not published for this caller`);
          return;
        }
        children.push({ macro: child as MacroDocument, target: resolved });
      }
      for (const [index, child] of children.entries()) {
        const fired = this.fireMacroTarget(caller, child.target);
        if (!fired.ok) {
          // Earlier children already committed; say so instead of pretending nothing ran.
          this.send(session, { ...base, ok: false,
            detail: isGm
              ? `Composite stopped at macro ${index + 1} of ${children.length}: ${fired.error}`
              : "Automation failed" });
          return;
        }
      }
      this.send(session, { ...base, ok: true,
        detail: isGm ? `Fired ${macro.name} (${children.length} macro(s))` : "Automation fired" });
      return;
    }
    const target = this.resolveMacroFireTarget(caller, macro, isGm);
    if (!target) {
      refused(this.macroFireTargetError(macro));
      return;
    }
    // MC-02: the caller's arguments are validated against the macro's own declared schema,
    // with the target scene's live visibility for a `token` input and the caller's own read
    // access for an `actor` one (D-388), exact world/parent item reads (D-393) — spelled out or defaulted
    // from the caller's selection. An undeclared key, a wrong type or an unreadable
    // reference never reaches the graph.
    const checkedArgs = validateMacroArgs(msg.args, macroAutomationInputs(macro),
      (type, id) => type === "token"
        ? this.tokenVisibleTo(caller, target.scene._id, id)
        : type === "item" ? macroItemReadable(this.store.world, caller, id)
        : this.referenceVisibleTo(caller, id));
    if (!checkedArgs.ok) {
      refused(checkedArgs.error);
      return;
    }
    if (Object.keys(checkedArgs.args).length > 0) target.args = checkedArgs.args;
    const fired = this.fireMacroTarget(caller, target);
    if (!fired.ok) {
      refused(fired.error);
      return;
    }
    // MC-02: the value the graph returned. It is private to the invoker — never a chat
    // message and never sent to another session — and a `gm`-audience value is withheld
    // from a non-GM invoker entirely.
    const returned = fired.result && (fired.result.audience === "caller" || isGm) ? fired.result : undefined;
    // The graph's own name is GM-private (players never receive the automations
    // collection), so the success line stays generic for a player.
    this.send(session, { ...base, ok: true,
      detail: isGm ? `Fired ${target.graph.name}` : "Automation fired",
      ...(returned ? { result: returned.value } : {}) });
  }

  /**
   * MC-01 (D-386): everything a fire needs, already validated against live state.
   * `null` means "this caller may not run this macro here" — the caller of this helper
   * decides how much of the reason the requester may hear.
   */
  private resolveMacroFireTarget(
    caller: SessionUser, macro: MacroDocument, isGm: boolean,
  ): MacroFireTarget | null {
    if (macro.kind !== "automation") return null;
    const graphId = macroAutomationGraphId(macro);
    const graph = graphId
      ? (this.store.get("automations", graphId) as AutomationDocument | undefined)
      : undefined;
    const checked = graph ? validateAutomation(graph.definition) : null;
    const definition = checked?.ok ? checked.definition : null;
    const scene = definition
      ? (this.store.get("scenes", definition.sceneId) as SceneDocument | undefined)
      : undefined;
    const tile = scene && definition
      ? automationSourceTile(scene, definition.tileId, definition.sourceKind)
      : undefined;
    if (!graph || !definition || !scene || !tile) return null;
    if (!definition.methods.includes(MACRO_AUTOMATION_METHOD)) return null;
    // A macro grants no authority of its own: it is a second way to ask for an
    // already-published graph, so the click rules apply unchanged, plus the player's
    // own loaded scene (a macro cannot reach into a scene they are not looking at).
    const playerAllowed = definition.sourceKind !== "region" &&
      definition.gates?.playerRunnable === true &&
      this.loadedSceneByUser.get(caller.id) === scene._id &&
      can(caller, "read", tile, "tiles", { parent: scene }) && docVisibleTo(caller, tile, scene);
    if (!isGm && (!playerAllowed || !docVisibleTo(caller, macro))) return null;
    return { graph, scene, tile };
  }

  /** The GM-facing reason an automation macro is unavailable (never sent to a player). */
  private macroFireTargetError(macro: MacroDocument): string {
    if (macro.kind !== "automation") return "macro unavailable";
    const graphId = macroAutomationGraphId(macro);
    const graph = graphId
      ? (this.store.get("automations", graphId) as AutomationDocument | undefined)
      : undefined;
    const checked = graph ? validateAutomation(graph.definition) : null;
    // A graph that is gone or no longer a valid definition reads exactly as D-381 read it.
    if (!graph || !checked?.ok) return "macro unavailable";
    if (!checked.definition.methods.includes(MACRO_AUTOMATION_METHOD))
      return "macro is not published for manual invocation";
    return "macro is not published for this caller";
  }

  /**
   * MC-01 (D-386): the live authoring gate for a composite. Every child must be a
   * committed automation macro in this world that could run on `manual` with a real
   * anchor, the list has no duplicates, and a composite never contains itself or
   * another composite (recursion is MC-02's subject).
   */
  private macroCompositeChildrenError(doc: MacroDocument): string | null {
    const childIds = macroCompositeMacroIds(doc);
    if (!childIds) return "a composite macro needs a bounded list of macro ids";
    for (const [index, childId] of childIds.entries()) {
      if (childId === doc._id) return "a composite macro cannot contain itself";
      const child = this.store.get("macros", childId) as MacroDocument | undefined;
      if (!child) return `composite macro ${index + 1} does not exist in this world`;
      if (child.kind === "composite")
        return "a composite macro cannot contain another composite";
      if (child.kind !== "automation")
        return `composite macro ${index + 1} is not an automation macro`;
      const error = macroAutomationDocumentError(child) ?? this.macroAutomationGraphError(child);
      if (error) return `composite macro ${index + 1} cannot run: ${error}`;
    }
    return null;
  }

  /**
   * MC-02: a `token` argument is visible when the caller's **own projected view** of that
   * scene holds the token — the same predicate the reviewed-script path uses for its inputs.
   */
  /** D-388: `actor` arguments are ids the caller must be able to read in their own replica. */
  private referenceVisibleTo(caller: SessionUser, actorId: string): boolean {
    const actor = this.store.get("actors", actorId);
    return !!actor && docVisibleTo(caller, actor);
  }

  private tokenVisibleTo(caller: SessionUser, sceneId: string, tokenId: string): boolean {
    const view = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
      ?.find((item) => item._id === sceneId);
    return !!view?.tokens.some((token) => token._id === tokenId);
  }

  /** Fire a pre-flighted macro target under the caller's identity. */
  private fireMacroTarget(
    caller: SessionUser, target: MacroFireTarget,
  ): { ok: true; result?: AutomationResult } | { ok: false; error: string } {
    const fired = this.fireAutomation(target.graph, { scene: target.scene, tile: target.tile, caller,
      method: MACRO_AUTOMATION_METHOD, originSource: "macro", ...(target.args ? { args: target.args } : {}),
      at: this.now(), rng: this.rng });
    if (!fired.ok) return { ok: false, error: fired.error };
    return { ok: true, ...(fired.result ? { result: fired.result } : {}) };
  }

  /**
   * TR-12: a journal page's `@Tile[…]{}` link (MATT "Triggering a Tile via Journal").
   * The client names a page and the link's ordinal in the text it received; the host
   * re-reads the page and resolves the anchor itself, so no tile, region or graph id ever
   * travels. A readable page is the publication surface — the GM chose to hand the reader
   * that link — so the target anchor need not be visible or `playerRunnable`; the graphs
   * still must be real, same-scene, `manual` and un-paused (the universal gate), and for a
   * player the target scene must be the one that player currently has loaded.
   */
  private handleJournalTrigger(session: Session, msg: JournalTriggerMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "journal triggers rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.journalId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.journalId) ||
        typeof msg.pageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.pageId) ||
        !Number.isSafeInteger(msg.index) || msg.index < 0 || msg.index > 255 ||
        Object.keys(msg).some((key) => !["kind", "requestId", "journalId", "pageId", "index"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid journal trigger");
      return;
    }
    const requestKey = `${caller.id}:${msg.requestId}`;
    if (this.seenJournalTriggers.has(requestKey)) return;
    this.seenJournalTriggers.set(requestKey, this.now());
    if (this.seenJournalTriggers.size > 256) {
      const first = this.seenJournalTriggers.keys().next().value;
      if (first) this.seenJournalTriggers.delete(first);
    }
    const isGm = caller.role === "GM" || caller.role === "ASSISTANT";
    const journal = this.store.get("journals", msg.journalId) as JournalDocument | undefined;
    const page: JournalPageDocument | undefined =
      journal?.pages.find((item) => item._id === msg.pageId);
    // The same read boundary the projection used to deliver the page in the first place.
    const readable = journal !== undefined && page !== undefined && docVisibleTo(caller, journal) &&
      (isGm || (can(caller, "read", journal, "journals") &&
        getEffectiveOwnership(caller, page, journal) >= OWNERSHIP_LEVELS.LIMITED));
    // A player's ordinal list excludes links hidden inside `<secret>` blocks; a GM may click
    // any link on the page (their own text is the raw one).
    const link: JournalTileLink | undefined = readable && page
      ? (isGm ? journalLinks(page.text) : visibleJournalLinks(page.text))[msg.index]
      : undefined;
    if (!readable || !page || !link || link.error !== undefined || link.tileId === "") {
      this.reject(session, msg.requestId, "forbidden", "journal link unavailable");
      return;
    }
    const sceneId = link.sceneId ?? this.loadedSceneByUser.get(caller.id) ?? this.activeSceneDocument()?._id;
    const scene = sceneId ? this.store.get("scenes", sceneId) as SceneDocument | undefined : undefined;
    if (!scene || (!isGm && this.loadedSceneByUser.get(caller.id) !== scene._id)) {
      this.reject(session, msg.requestId, "forbidden", "journal link unavailable");
      return;
    }
    const tile = scene.tiles.find((item) => item._id === link.tileId);
    const region = tile ? undefined : scene.regions?.find((item) => item._id === link.tileId);
    const sourceKind = tile ? "tile" : region ? "region" : null;
    if (!sourceKind) {
      this.reject(session, msg.requestId, "forbidden", "journal link unavailable");
      return;
    }
    const anchor = automationSourceTile(scene, link.tileId, sourceKind);
    if (!anchor) {
      this.reject(session, msg.requestId, "forbidden", "journal link unavailable");
      return;
    }
    const graphs = this.store.getAll("automations").flatMap((doc) => {
      const checked = validateAutomation(doc.definition);
      return checked.ok && checked.definition.sceneId === scene._id &&
        checked.definition.tileId === anchor._id &&
        (checked.definition.sourceKind ?? "tile") === sourceKind &&
        checked.definition.methods.includes(MACRO_AUTOMATION_METHOD) ? [doc] : [];
    }).sort((a, b) => a._id.localeCompare(b._id));
    // A link to a plain tile (or to an unpublished graph) is indistinguishable from a
    // no-op: never answer with whether a hidden graph exists.
    if (!graphs.length) return;
    for (const graph of graphs) {
      const liveScene = this.store.get("scenes", scene._id) as SceneDocument | undefined;
      const liveAnchor = liveScene ? automationSourceTile(liveScene, link.tileId, sourceKind) : undefined;
      if (!liveScene || !liveAnchor) break;
      this.fireAutomation(graph, { scene: liveScene, tile: liveAnchor, caller,
        method: MACRO_AUTOMATION_METHOD, originSource: "journal", at: this.now(), rng: this.rng },
        false, undefined, undefined, link.landing);
    }
  }

  /** Creation/update gate: a macro may only reference a graph that exists and can be
   * invoked by hand. Runtime re-checks everything, because publication can change. */
  private macroAutomationGraphError(doc: MacroDocument): string | null {
    const graphId = macroAutomationGraphId(doc);
    if (!graphId) return "an automation macro needs a bounded graph id";
    const graph = this.store.get("automations", graphId) as AutomationDocument | undefined;
    const checked = graph ? validateAutomation(graph.definition) : null;
    if (!graph || !checked?.ok) return "an automation macro must reference a saved graph in this world";
    if (!checked.definition.methods.includes(MACRO_AUTOMATION_METHOD))
      return "the referenced graph does not run on the manual method";
    const scene = this.store.get("scenes", checked.definition.sceneId);
    if (!scene || !automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind))
      return "the referenced graph has no tile in its scene";
    return null;
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
    runAsChoice?: "approved" | "caller" | "gm",
  ): Promise<Json> {
    const { caller, session } = ctx;
    if (!isActive() || Date.now() >= ctx.deadline || stack.length >= 32 || stack.includes(macroId))
      throw new Error("Script deadline, nesting depth or recursion limit reached");
    const doc = this.store.get("macros", macroId) as MacroDocument | undefined;
    const checked = doc?.kind === "script" ? validateScriptMacro(doc) : null;
    if (!doc || !checked?.ok) throw new Error("Script is missing, unapproved or malformed");
    const policy = checked.policy;
    const runAs = runAsChoice === undefined || runAsChoice === "approved" ? policy.runAs : runAsChoice;
    if (runAs === "gm" && policy.runAs !== "gm")
      throw new Error("GM run-as is not approved by the saved script policy");
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
      { sceneId: policy.sceneId, callerId: caller.id, requestId: ctx.requestId, runAs },
      (method, payload, live) => this.scriptAction(doc, policy, runAs, method, payload, ctx, path,
        () => isActive() && live()),
      Math.min(remaining, 10_000));
    if (!boundedJson(result)) throw new Error("Script result is not bounded JSON");
    ctx.trace.push(`return ${macroId}`);
    return result;
  }

  private async scriptAction(
    macro: MacroDocument, policy: ScriptPolicy, runAs: "caller" | "gm", method: string,
    payload: unknown, ctx: ScriptInvocation, stack: readonly string[], isActive: () => boolean,
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
      if (Object.keys(payload).length !== 1 ||
          !(isWorldTagRef(payload.ref) || isWorldDocumentTagRef(payload.ref)))
        throw new Error("Invalid explicit-scene or world-document tag reference");
      const ref = payload.ref;
      if (isWorldTagRef(ref)) {
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
      const hit = listTaggable(this.store.world, { includeWorldDocs: true, viewer: caller,
        includeRefs: [ref] })[0];
      if (!hit) throw new Error("Tag target unavailable");
      return [...hit.tags];
    }
    if (method === "tags.find") {
      const options = payload.options ?? {};
      if (!isRecord(options) || Object.keys(options).some((k) =>
            !["mode", "pattern", "caseSensitive", "contains", "collections", "includeRefs", "excludeRefs",
              "sceneId", "allScenes", "groupByScene", "includeWorldDocs"].includes(k)) ||
          (options.collections !== undefined && (!Array.isArray(options.collections) || options.collections.length > 14 ||
            options.collections.some((c: unknown) => c !== "scenes" &&
              !TAGGABLE_COLLECTIONS.includes(c as typeof TAGGABLE_COLLECTIONS[number]) &&
              !WORLD_TAGGABLE_COLLECTIONS.includes(c as typeof WORLD_TAGGABLE_COLLECTIONS[number])))) ||
          (options.mode !== undefined && !["all", "any", "exactSet"].includes(String(options.mode))) ||
          (options.pattern !== undefined && !["literal", "wildcard", "regex"].includes(String(options.pattern))) ||
          (options.caseSensitive !== undefined && typeof options.caseSensitive !== "boolean") ||
          (options.contains !== undefined && typeof options.contains !== "boolean") ||
          (options.allScenes !== undefined && typeof options.allScenes !== "boolean") ||
          (options.groupByScene !== undefined && typeof options.groupByScene !== "boolean") ||
          (options.includeWorldDocs !== undefined && typeof options.includeWorldDocs !== "boolean") ||
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
      const worldCollectionRequested = Array.isArray(options.collections) && options.collections.some((coll: unknown) =>
        WORLD_TAGGABLE_COLLECTIONS.includes(coll as typeof WORLD_TAGGABLE_COLLECTIONS[number]));
      const includeWorldDocs = options.includeWorldDocs === true || worldCollectionRequested;
      if (targetSceneId && includeWorldDocs)
        throw new Error("World documents require an all-scene tag query");
      // In an all-scene query, refs must still explicitly identify their
      // parent scene or world-document parent. Entitlement is enforced by
      // projecting from the actual caller's view at query time.
      const validRefs = targetSceneId
        ? validSceneTagRefs(options.includeRefs, targetSceneId) &&
          validSceneTagRefs(options.excludeRefs, targetSceneId)
        : includeWorldDocs
          ? validGlobalTagRefs(options.includeRefs) && validGlobalTagRefs(options.excludeRefs)
          : validWorldTagRefs(options.includeRefs) && validWorldTagRefs(options.excludeRefs);
      if (!validRefs) throw new Error("Invalid tag query references");
      if (!(typeof payload.query === "string" || Array.isArray(payload.query) &&
          payload.query.every((q: unknown) => typeof q === "string"))) throw new Error("Invalid tag query");
      const hits = getByTag(this.store.world, payload.query as string | string[], {
        ...(targetSceneId ? { sceneId: targetSceneId } : {}), viewer: caller, includeWorldDocs,
        ...(options.mode !== undefined ? { mode: options.mode as TagMatchMode } : {}),
        ...(options.pattern !== undefined ? { pattern: options.pattern as TagPattern } : {}),
        ...(options.caseSensitive !== undefined ? { caseSensitive: options.caseSensitive as boolean } : {}),
        ...(options.contains !== undefined ? { contains: options.contains as boolean } : {}),
        ...(options.collections !== undefined ? { collections: options.collections as TagSearchCollection[] } : {}),
        ...(options.includeRefs !== undefined ? { includeRefs: options.includeRefs as unknown as TagRef[] } : {}),
        ...(options.excludeRefs !== undefined ? { excludeRefs: options.excludeRefs as unknown as TagRef[] } : {}),
      });
      if (hits.length > 100) throw new Error("Tag query matched over 100 documents; narrow the selector");
      // No entire documents or hidden host-only fields cross the worker
      // boundary. World rows have empty sceneId plus an explicit world scope.
      const rows = hits.map((hit) => ({ scope: hit.scope, sceneId: hit.sceneId,
        ref: { coll: hit.ref.coll, id: hit.ref.id,
          ...("target" in hit.ref ? { target: hit.ref.target } : {}),
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
      // principal. Even reviewed, elevated player code cannot write a hidden
      // target by supplying its ID. Scene targets carry a scene parent; embedded
      // world items carry an actor parent. Writes always require concrete refs.
      const visible = listTaggable(this.store.world, { viewer: caller, includeWorldDocs: true });
      const seen = new Set<string>();
      const docs: Array<{ ref: TagRef; sceneId: string; doc: BaseDocument }> = [];
      for (const input of payload.refs) {
        if (!(isWorldTagRef(input) || isWorldDocumentTagRef(input)))
          throw new Error("Invalid explicit-scene or world-document tag target");
        const ref = input as unknown as TagRef;
        const sceneQualified = isWorldTagRef(ref);
        const prototypeTarget = isPrototypeTokenTagRef(ref);
        const targetSceneId = sceneQualified ? ref.coll === "scenes" ? ref.id : ref.parent?.id : undefined;
        const targetScene = targetSceneId ? this.store.get("scenes", targetSceneId) : undefined;
        if (sceneQualified && (!targetScene || !can(caller, "read", targetScene, "scenes")))
          throw new Error("Tag scene unavailable");
        const identity = tagRefKey(ref);
        if (seen.has(identity)) throw new Error("Duplicate tag target");
        seen.add(identity);
        const entry = visible.find((item) => tagRefKey(item.ref) === identity);
        if (!entry) throw new Error("Invisible or missing tag target");
        const live = prototypeTarget ? this.store.get("actors", ref.id) : this.store.resolve(entry.ref);
        const permissionParent = ref.parent?.coll === "actors"
          ? this.store.get("actors", ref.parent.id)
          : sceneQualified && ref.coll !== "scenes" ? targetScene : undefined;
        if (ref.parent?.coll === "actors" && !permissionParent)
          throw new Error("Tag target not authorized");
        const permissionCollection = prototypeTarget ? "actors" : ref.coll;
        if (!live || (runAs === "caller" &&
            !can(caller, "update", live, permissionCollection,
              permissionParent ? { parent: permissionParent } : {})))
          throw new Error("Tag target not authorized");
        // Prototype rows are intentionally synthetic tag views; the stored actor is the
        // permission target, while tagEditOps emits an ordinary nested actor update.
        docs.push({ ref: entry.ref, sceneId: targetScene?._id ?? "", doc: prototypeTarget ? entry.doc : live });
      }
      // World uniqueness depends on every world actor/item/prototype tag, even on
      // documents hidden from this caller. Never let GM elevation launder that read.
      if (method === "tags.rules" && caller.role !== "GM" && caller.role !== "ASSISTANT" &&
          docs.some(({ ref }) => isWorldDocumentTagRef(ref)))
        throw new Error("World-document Tagger rule allocation requires a GM caller");
      // Scene-unique ordinals depend on all tags in the referenced scene, including
      // hidden ones; a player cannot infer a secret tag from the chosen ordinal.
      if (method === "tags.rules" && caller.role !== "GM" && caller.role !== "ASSISTANT" &&
          docs.some(({ doc }) => tagsOf(doc).some((tag) => tag.includes("{#}"))))
        throw new Error("Scene-unique Tagger numbering requires a GM caller");
      const ops = method === "tags.rules"
        ? tagRuleOps(this.store.world, docs as Array<{ ref: DocRef; sceneId: string; doc: BaseDocument }>)
        : tagEditOps(docs, payload.edit as TagEdit, payload.tags as string[]);
      if (!ops.length) return { changed: 0 };
      const committed = this.commitOps(ops, runAs === "gm" ? this.systemUserId : caller.id,
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
        runAs === "gm" ? this.systemUserId : caller.id, `macro-${ctx.requestId}-${seq}`, true, ctx.audit);
      if (!committed.ok) throw new Error(`Chat commit failed: ${committed.error}`);
      ctx.trace.push(`  chat seq ${committed.seq} audience ${payload.audience}`);
      return { messageId: message._id };
    }
    if (method === "fx.play") {
      if (typeof payload.macroId !== "string" ||
          (payload.sourceTokenId !== undefined && typeof payload.sourceTokenId !== "string") ||
          (payload.targetTokenId !== undefined && typeof payload.targetTokenId !== "string") ||
          (payload.waitForEnd !== undefined && payload.waitForEnd !== true) ||
          (payload.finishOffsetMs !== undefined && (payload.waitForEnd !== true ||
            !Number.isSafeInteger(payload.finishOffsetMs) ||
            Math.abs(payload.finishOffsetMs as number) > FX_FINISH_OFFSET_MAX_MS)) ||
          Object.keys(payload).some((key) => !["macroId", "sourceTokenId", "targetTokenId", "waitForEnd",
            "finishOffsetMs"].includes(key)))
        throw new Error("Invalid FX call");
      const projected = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
        ?.find((item) => item._id === scene._id);
      for (const tokenId of [payload.sourceTokenId, payload.targetTokenId]) {
        if (tokenId && !projected?.tokens.some((t) => t._id === tokenId))
          throw new Error("Invisible FX target");
      }
      const gm: SessionUser = { id: this.systemUserId, role: "GM", name: "Script" };
      const prepared = this.prepareFx(runAs === "gm" ? gm : caller, {
        macroId: payload.macroId, sceneId: scene._id,
        ...(payload.sourceTokenId ? { sourceTokenId: payload.sourceTokenId } : {}),
        ...(payload.targetTokenId ? { targetTokenId: payload.targetTokenId } : {}),
      }, undefined, caller.id);
      if (!prepared.ok) throw new Error(`FX preflight failed: ${prepared.error}`);
      // An all-skipped conditional timeline is a successful no-op. It still has the
      // host's scheduled launch time, but no section contributes additional duration.
      const durationMs = Math.max(0,
        ...prepared.cue.sections.map((step) => step.startMs + step.durationMs));
      // An awaited short sequence must be safe to finish before this reviewed
      // Worker expires. Fail BEFORE emitting anything, including a persistent
      // loop or a 60-second cue that the 10-second Worker cannot await.
      const finishOffsetMs = typeof payload.finishOffsetMs === "number" ? payload.finishOffsetMs : 0;
      if (payload.waitForEnd === true && durationMs + finishOffsetMs < 0)
        throw new Error("Awaited FX finish overlap cannot begin before the cue starts");
      if (payload.waitForEnd === true && (prepared.cue.persistent ||
          prepared.cue.atHostTime + durationMs + finishOffsetMs - this.now() > 7000))
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
      if (instance) {
        if (instance.sceneId !== scene._id ||
            (caller.role !== "GM" && caller.role !== "ASSISTANT" && instance.ownerId !== caller.id))
          throw new Error("FX run unavailable");
        const committed = this.commitOps([{ kind: "delete", ref: { coll: "fxInstances", id: instance._id } }],
          this.systemUserId, `macro-${ctx.requestId}-${seq}`);
        if (!committed.ok) throw new Error(`FX stop failed: ${committed.error}`);
        ctx.trace.push(`  stopped durable FX instance at seq ${committed.seq}`);
        return { stopped: true, persistent: true, seq: committed.seq };
      }
      if (!this.cancelTransientFx(payload.runId, caller, scene._id))
        throw new Error("FX run unavailable");
      ctx.trace.push("  cancelled finite FX run (presentation only; no world transaction)");
      return { stopped: true, persistent: false };
    }
    if (method === "summons.place") {
      const gm = caller.role === "GM" || caller.role === "ASSISTANT";
      const elevated = runAs === "gm";
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
      const elevated = runAs === "gm";
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
      if (typeof payload.automationId !== "string" || !SIMULATABLE_METHODS.includes(payload.method as AutomationMethod) ||
          (payload.tokenId !== undefined && typeof payload.tokenId !== "string"))
        throw new Error("Invalid automation call");
      const graph = this.store.get("automations", payload.automationId) as AutomationDocument | undefined;
      const checked = graph ? validateAutomation(graph.definition) : null;
      const definition = checked?.ok ? checked.definition : null;
      const tile = definition ? automationSourceTile(scene, definition.tileId, definition.sourceKind) : undefined;
      const token = payload.tokenId ? scene.tokens.find((item) => item._id === payload.tokenId) : undefined;
      const gm = caller.role === "GM" || caller.role === "ASSISTANT";
      if (!graph || !definition || !tile || definition.sceneId !== scene._id ||
          !definition.methods.includes(payload.method as AutomationMethod) ||
          (payload.tokenId && !token) ||
          (!gm && (definition.sourceKind === "region" || payload.method !== "click" || !definition.gates?.playerRunnable ||
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
    if (this.fxTransientTimer) clearTimeout(this.fxTransientTimer);
    this.fxTransientTimer = null;
    this.fxTransientRuns.clear();
  }

  // ─── Active-zone graphs: host events → atomic world plan → projected cues ───

  private readonly seenAutomationRequests = new Map<string, number>();
  /** TR-12/MC-01: one fire per (caller, requestId) for macro-initiated graphs. */
  private readonly seenMacroInvokes = new Map<string, number>();
  /** D-394: bounded idempotent save replies, scoped to the authenticated author. */
  private readonly seenMacroSaves = new Map<string, MacroResultMsg>();
  /** TR-12: one fire per (caller, requestId) for journal-link triggers. */
  private readonly seenJournalTriggers = new Map<string, number>();
  /** Reentry depth of movement-trigger dispatch. A graph's committed Move/Rotation
   * can land a token in another tile whose graph moves it on, so the chain is
   * bounded at the host, not by each plan's own invocation budget. */
  private movementAutomationDepth = 0;
  private static readonly MOVEMENT_AUTOMATION_DEPTH = 8;
  /** Reentry depth of door-trigger dispatch: a graph's own door action commits another
   * state change, whose destination graphs may operate a further door. */
  private doorAutomationDepth = 0;
  private static readonly DOOR_AUTOMATION_DEPTH = 8;
  /** Reentry depth of combat-trigger dispatch: a graph's own committed work can advance the
   * encounter (a later PF1e adapter), whose turn/round graphs then fire again. */
  private combatAutomationDepth = 0;
  private static readonly COMBAT_AUTOMATION_DEPTH = 8;
  /** Reentry depth of the lighting/time family, which share one budget: a graph's own Scene
   * Lighting or Game Time action commits another environment change. */
  private environmentAutomationDepth = 0;
  private static readonly ENVIRONMENT_AUTOMATION_DEPTH = 8;
  /**
   * MATT's scene trigger is a single `canvasready` mode that fires "for each player loading
   * in", while this engine keeps the two moments distinguishable: `sceneChange` is the
   * committed activation transition (once per commit) and `sceneLoad` is a viewer loading the
   * active scene it does not already hold. This remembers what each user last loaded, so a
   * plain reconnect never re-fires and a return to a different scene does.
   */
  private readonly loadedSceneByUser = new Map<UserId, string>();

  /** The encounter's own scene: its `flags.core.sceneId` binding, or — for a document saved
   * before the binding — the scene whose active encounter pointer names it. */
  private sceneIdForCombat(combatId: string, fallback?: CombatDocument | undefined): string | null {
    const combat = (this.store.get("combats", combatId) as CombatDocument | undefined) ?? fallback;
    const bound = (combat?.flags as { core?: { sceneId?: unknown } } | undefined)?.core?.sceneId;
    if (typeof bound === "string" && this.store.get("scenes", bound)) return bound;
    for (const scene of this.store.getAll("scenes") as SceneDocument[]) {
      const active = (scene.flags as { core?: { activeCombatId?: unknown } } | undefined)?.core?.activeCombatId;
      if (active === combatId) return scene._id;
    }
    return null;
  }

  /** A committed change in the active scene fires destination-scene graphs once, host-side. */
  private fireSceneChangeAutomations(scene: SceneDocument, by: UserId): void {
    const caller = this.sessionUsers().find((user) => user.id === by);
    if (!caller || !scene.active || !can(caller, "read", scene, "scenes")) return;
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const candidates = this.store.getAll("automations").flatMap((doc) => {
      const checked = validateAutomation(doc.definition);
      if (!checked.ok || checked.definition.sceneId !== scene._id ||
          !checked.definition.methods.includes("sceneChange") ||
          (!gm && checked.definition.gates?.playerRunnable !== true)) return [];
      const sourceKind = checked.definition.sourceKind ?? "tile";
      const source = sourceKind === "region"
        ? scene.regions?.find((region) => region._id === checked.definition.tileId)
        : scene.tiles.find((tile) => tile._id === checked.definition.tileId);
      const tile = automationSourceTile(scene, checked.definition.tileId, sourceKind);
      const collection = sourceKind === "region" ? "regions" : "tiles";
      if (!source || !tile || !can(caller, "read", source, collection, { parent: scene }) ||
          !docVisibleTo(caller, source, scene)) return [];
      return [{ doc, tile }];
    }).sort((a, b) => (b.tile.sort ?? 0) - (a.tile.sort ?? 0) ||
      a.tile._id.localeCompare(b.tile._id) || a.doc._id.localeCompare(b.doc._id));

    for (const candidate of candidates) {
      const liveScene = this.store.get("scenes", scene._id) as SceneDocument | undefined;
      if (!liveScene?.active || !can(caller, "read", liveScene, "scenes")) return;
      const liveDoc = this.store.get("automations", candidate.doc._id) as AutomationDocument | undefined;
      const checked = liveDoc ? validateAutomation(liveDoc.definition) : null;
      if (!liveDoc || !checked?.ok || checked.definition.sceneId !== liveScene._id ||
          !checked.definition.methods.includes("sceneChange") ||
          (!gm && checked.definition.gates?.playerRunnable !== true)) continue;
      const sourceKind = checked.definition.sourceKind ?? "tile";
      const source = sourceKind === "region"
        ? liveScene.regions?.find((region) => region._id === checked.definition.tileId)
        : liveScene.tiles.find((tile) => tile._id === checked.definition.tileId);
      const tile = automationSourceTile(liveScene, checked.definition.tileId, sourceKind);
      const collection = sourceKind === "region" ? "regions" : "tiles";
      if (!source || !tile || !can(caller, "read", source, collection, { parent: liveScene }) ||
          !docVisibleTo(caller, source, liveScene)) continue;
      this.fireAutomation(liveDoc, { method: "sceneChange", scene: liveScene, tile, caller,
        at: this.now(), rng: this.rng });
    }
  }

  /**
   * A committed door change fires graphs anchored on the tiles/regions that cover the door,
   * mirroring MATT's "Tiles Under Door" targeting: the door's midpoint decides which source
   * zones own the event. Ordering is deterministic (descending Sort, then stable IDs) and
   * nothing about the graph or its trace reaches a caller who may not run it.
   */
  private fireDoorAutomations(
    changes: Array<{ sceneId: string; wallId: string; before: number }>, by: UserId,
  ): void {
    // A graph's own door action commits as the system identity, which has no session of its
    // own; synthesize it exactly like the movement path does so host work still fires rules.
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const hits: Array<{ docId: string; sceneId: string; tileId: string; method: AutomationMethod;
      sort: number; at: { x: number; y: number } }> = [];
    for (const change of changes) {
      const scene = this.store.get("scenes", change.sceneId) as SceneDocument | undefined;
      const wall = scene?.walls.find((candidate) => candidate._id === change.wallId);
      if (!scene || !scene.active || !wall || !can(caller, "read", scene, "scenes")) continue;
      const method = doorTransitionMethod(change.before, wall.door);
      if (!method) continue;
      const at = { x: (wall.c[0] + wall.c[2]) / 2, y: (wall.c[1] + wall.c[3]) / 2 };
      for (const doc of this.store.getAll("automations")) {
        const checked = validateAutomation(doc.definition);
        if (!checked.ok || checked.definition.sceneId !== scene._id ||
            !checked.definition.methods.includes(method) ||
            (!gm && checked.definition.gates?.playerRunnable !== true)) continue;
        const sourceKind = checked.definition.sourceKind ?? "tile";
        const source = sourceKind === "region"
          ? scene.regions?.find((region) => region._id === checked.definition.tileId)
          : scene.tiles.find((tile) => tile._id === checked.definition.tileId);
        const tile = automationSourceTile(scene, checked.definition.tileId, sourceKind);
        const collection = sourceKind === "region" ? "regions" : "tiles";
        if (!source || !tile || !can(caller, "read", source, collection, { parent: scene }) ||
            !docVisibleTo(caller, source, scene) || !tileContainsPoint(tile, at)) continue;
        hits.push({ docId: doc._id, sceneId: scene._id, tileId: tile._id, method, at,
          sort: typeof tile.sort === "number" && Number.isFinite(tile.sort) ? tile.sort : 0 });
      }
    }
    hits.sort((a, b) => a.sceneId.localeCompare(b.sceneId) || b.sort - a.sort ||
      a.tileId.localeCompare(b.tileId) || a.docId.localeCompare(b.docId) ||
      a.method.localeCompare(b.method));
    for (const hit of hits) {
      const liveScene = this.store.get("scenes", hit.sceneId) as SceneDocument | undefined;
      if (!liveScene?.active || !can(caller, "read", liveScene, "scenes")) continue;
      const liveDoc = this.store.get("automations", hit.docId) as AutomationDocument | undefined;
      const checked = liveDoc ? validateAutomation(liveDoc.definition) : null;
      if (!liveDoc || !checked?.ok || checked.definition.sceneId !== liveScene._id ||
          !checked.definition.methods.includes(hit.method) ||
          (!gm && checked.definition.gates?.playerRunnable !== true)) continue;
      const sourceKind = checked.definition.sourceKind ?? "tile";
      const source = sourceKind === "region"
        ? liveScene.regions?.find((region) => region._id === checked.definition.tileId)
        : liveScene.tiles.find((tile) => tile._id === checked.definition.tileId);
      const tile = automationSourceTile(liveScene, checked.definition.tileId, sourceKind);
      const collection = sourceKind === "region" ? "regions" : "tiles";
      if (!source || !tile || !can(caller, "read", source, collection, { parent: liveScene }) ||
          !docVisibleTo(caller, source, liveScene) || !tileContainsPoint(tile, hit.at)) continue;
      this.fireAutomation(liveDoc, { scene: liveScene, tile, caller, method: hit.method,
        at: this.now(), rng: this.rng });
    }
  }

  /**
   * MATT fires several trigger families on **every** tile of the scene — combat turns, darkness
   * and world time — with no geometric anchor test (unlike doors, which need the midpoint).
   * This is that dispatch: each graph anchored in the scene whose method list contains the
   * event, one authored change at a time, ordered by descending Sort then stable IDs, with the
   * same live re-validation before every fire that the scene-change and door paths use. The
   * optional triggering token is the current combatant for combat kinds.
   */
  private fireSceneGraphs(
    scene: SceneDocument, method: AutomationMethod, by: UserId, tokenId?: string,
  ): void {
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    if (!can(caller, "read", scene, "scenes")) return;
    const gm = caller.role === "GM" || caller.role === "ASSISTANT";
    const anchors = this.store.getAll("automations").flatMap((doc) => {
      const checked = validateAutomation(doc.definition);
      if (!checked.ok || checked.definition.sceneId !== scene._id ||
          !checked.definition.methods.includes(method) ||
          (!gm && checked.definition.gates?.playerRunnable !== true)) return [];
      const sourceKind = checked.definition.sourceKind ?? "tile";
      const source = sourceKind === "region"
        ? scene.regions?.find((region) => region._id === checked.definition.tileId)
        : scene.tiles.find((tile) => tile._id === checked.definition.tileId);
      const tile = automationSourceTile(scene, checked.definition.tileId, sourceKind);
      const collection = sourceKind === "region" ? "regions" : "tiles";
      if (!source || !tile || !can(caller, "read", source, collection, { parent: scene }) ||
          !docVisibleTo(caller, source, scene)) return [];
      return [{ docId: doc._id, tileId: tile._id,
        sort: typeof tile.sort === "number" && Number.isFinite(tile.sort) ? tile.sort : 0 }];
    }).sort((a, b) => b.sort - a.sort || a.tileId.localeCompare(b.tileId) ||
      a.docId.localeCompare(b.docId));
    for (const anchor of anchors) {
      // Re-validate against the live documents immediately before firing; an earlier graph in
      // this loop may have changed them.
      const liveScene = this.store.get("scenes", scene._id) as SceneDocument | undefined;
      if (!liveScene || !can(caller, "read", liveScene, "scenes")) break;
      const liveDoc = this.store.get("automations", anchor.docId) as AutomationDocument | undefined;
      const checked = liveDoc ? validateAutomation(liveDoc.definition) : null;
      if (!liveDoc || !checked?.ok || checked.definition.sceneId !== liveScene._id ||
          !checked.definition.methods.includes(method) ||
          (!gm && checked.definition.gates?.playerRunnable !== true)) continue;
      const sourceKind = checked.definition.sourceKind ?? "tile";
      const source = sourceKind === "region"
        ? liveScene.regions?.find((region) => region._id === checked.definition.tileId)
        : liveScene.tiles.find((tile) => tile._id === checked.definition.tileId);
      const tile = automationSourceTile(liveScene, checked.definition.tileId, sourceKind);
      const collection = sourceKind === "region" ? "regions" : "tiles";
      if (!source || !tile || !can(caller, "read", source, collection, { parent: liveScene }) ||
          !docVisibleTo(caller, source, liveScene)) continue;
      const token = tokenId
        ? liveScene.tokens.find((candidate) => candidate._id === tokenId) : undefined;
      this.fireAutomation(liveDoc, { method, scene: liveScene, tile, caller,
        ...(token ? { token } : {}), at: this.now(), rng: this.rng });
    }
  }

  /** Public canvas pointer event resolves a visible tile to private graphs on the host. */
  private handleAutomationTileTrigger(session: Session, msg: AutomationClickMsg): void {
    const caller = session.user;
    if (!caller) return;
    if (!session.intentBucket.tryRemove()) {
      this.reject(session, String(msg.requestId), "rate_limited", "tile interactions rate-limited");
      return;
    }
    if (typeof msg.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.requestId) ||
        typeof msg.sceneId !== "string" || typeof msg.tileId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.sceneId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.tileId) ||
        (msg.tokenId !== undefined && (typeof msg.tokenId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(msg.tokenId))) ||
        (msg.method !== undefined && !["click", "rightClick", "doubleClick", "hoverIn", "hoverOut"].includes(msg.method as string)) ||
        !isRecord(msg.point) || Object.keys(msg.point).some((key) => !["x", "y"].includes(key)) ||
        typeof msg.point.x !== "number" || !Number.isFinite(msg.point.x) ||
        typeof msg.point.y !== "number" || !Number.isFinite(msg.point.y) ||
        Object.keys(msg).some((key) => !["kind", "requestId", "sceneId", "tileId", "point", "method", "tokenId"].includes(key))) {
      this.reject(session, String(msg.requestId), "invalid_schema", "invalid tile interaction");
      return;
    }
    const method: AutomationPointerMethod = msg.method ?? "click";
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
        (checked.definition.sourceKind ?? "tile") === "tile" && checked.definition.tileId === tile._id && checked.definition.methods.includes(method) &&
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
      this.fireAutomation(graph, { scene: liveScene, tile: liveTile, caller, method,
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
        !SIMULATABLE_METHODS.includes(msg.method as AutomationMethod) ||
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
    const tile = scene && definition ? automationSourceTile(scene, definition.tileId, definition.sourceKind) : undefined;
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
    sources: Array<{ sceneId: string; tokenId: string; before?: TokenDocument; pathEnd?:TokenDocument; stopFraction?:number }>, by: UserId,
    suppressedMovement?: ReadonlySet<string>,
    preplannedMovement?: ReadonlyMap<string, PreplannedMovementTrigger>,
  ): void {
    const caller = this.sessionUsers().find((user) => user.id === by) ??
      { id: by, role: "GM" as const, name: "System" };
    const candidates: Array<{ docId: string; sceneId: string; tokenId: string; tileId: string;
      method: AutomationMethod; fraction: number; sort: number; direction?: AutomationEvent["direction"]; movementEntry?: AutomationEvent["movementEntry"]; movementOriginal?: AutomationEvent["movementOriginal"]; movementCrossing?: AutomationEvent["movementCrossing"] }> = [];
    for (const source of sources) {
      const scene = this.store.get("scenes", source.sceneId) as SceneDocument | undefined;
      const token = scene?.tokens.find((t) => t._id === source.tokenId);
      if (!scene || !token) continue;
      const pathEnd=source.pathEnd??token;
      const dx = source.before ? pathEnd.x - source.before.x : 0;
      const dy = source.before ? pathEnd.y - source.before.y : 0;
      const direction: AutomationEvent["direction"] = {
        ...(dx < -1e-6 ? { x: "left" as const } : dx > 1e-6 ? { x: "right" as const } : {}),
        ...(dy < -1e-6 ? { y: "up" as const } : dy > 1e-6 ? { y: "down" as const } : {}),
      };
      for (const doc of this.store.getAll("automations")) {
        const checked = validateAutomation(doc.definition);
        if (!checked.ok || checked.definition.sceneId !== scene._id) continue;
        const tile = automationSourceTile(scene, checked.definition.tileId, checked.definition.sourceKind);
        if (!tile) continue;
        for (const hit of sweptTileEvents(tile, source.before, pathEnd, scene.grid)) {
          if (source.stopFraction!==undefined&&hit.fraction>source.stopFraction+1e-8)continue;
          if (suppressedMovement?.has(`${source.sceneId}\u0000${source.tokenId}`) && ["enter", "exit", "stop", "elevation"].includes(hit.method)) continue;
          const contact = source.before && (hit.method === "enter" || hit.method === "exit") ? {
            x: source.before.x + dx * hit.fraction, y: source.before.y + dy * hit.fraction,
          } : null;
          const entry = hit.method === "enter" && contact ? snapshotMoveEntry(tile, contact, true) : null;
          if (checked.definition.methods.includes(hit.method)) candidates.push({
            docId: doc._id, sceneId: scene._id, tokenId: token._id, tileId: tile._id,
            method: hit.method, fraction: hit.fraction, direction,
            ...(entry ? { movementEntry: { ...entry, tileId: tile._id, tokenId: token._id } } : {}),
            ...(source.before && (dx !== 0 || dy !== 0) ? { movementOriginal: { tokenId: token._id, x: pathEnd.x, y: pathEnd.y } } : {}),
            ...(contact && (hit.method === "enter" || hit.method === "exit") ? { movementCrossing: {
              tileId: tile._id, tokenId: token._id, method: hit.method, fraction: hit.fraction, ...contact,
            } } : {}),
            sort: typeof tile.sort === "number" && Number.isFinite(tile.sort) ? tile.sort : 0,
          });
        }
      }
    }
    // Path fraction determines first contact; for coincident tiles use method,
    // descending tile Sort (not elevation), then stable IDs. No player sets priority.
    const methodOrder: Record<AutomationMethod, number> = {
      enter: 0, exit: 1, stop: 2, elevation: 3, create: 4, sceneChange: 5, sceneLoad: 6, rotate: 7, click: 8, rightClick: 9, doubleClick: 10,
      hoverIn: 11, hoverOut: 12, doorOpen: 13, doorClose: 14, doorLock: 15, doorUnlock: 16,
      combatStart: 17, combatRound: 18, combatTurnStart: 19, combatTurnEnd: 20, combatEnd: 21,
      lightingChange: 22, timeChange: 23, manual: 24,
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
      const tile = scene && doc?.definition
        ? automationSourceTile(scene, doc.definition.tileId, doc.definition.sourceKind) : undefined;
      const token = scene?.tokens.find((t) => t._id === hit.tokenId);
      if (!doc || !scene || !tile || !token) continue;
      const event: AutomationEvent = { scene, tile, token, caller, method: hit.method,
        ...(hit.direction ? { direction: hit.direction } : {}),
        ...(hit.movementEntry ? { movementEntry: hit.movementEntry } : {}),
        ...(hit.movementOriginal ? { movementOriginal: hit.movementOriginal } : {}),
        ...(hit.movementCrossing ? { movementCrossing: hit.movementCrossing } : {}), at: this.now(), rng: this.rng };
      const planned = preplannedMovement?.get(movementAutomationKey(
        hit.sceneId, hit.tokenId, hit.docId, hit.tileId, hit.method));
      const result = this.fireAutomation(doc, event, false, planned?.outcome);
      if (result.ok && result.stopOthers) stopped.set(scope, hit.tileId);
    }
  }

  private reportAutomation(
    doc: AutomationDocument, method: AutomationMethod,
    result: AutomationTraceMsg["result"], detail: string, trace: string[], seq?: number,
  ): void {
    // A bounded-graph rejection can follow 10,000 executed steps. Keep its
    // GM-facing diagnostic compact too: AutomationPanel renders every row.
    const budgetDiagnostic = result === "rejected" &&
      /cycle\/resource budget|depth\/invocation budget|trigger tile recursion/.test(detail);
    const maxTrace = budgetDiagnostic ? 128 : 4_096;
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
    doc: AutomationDocument, event: AutomationEvent, dryRun = false, planned?: AutomationOutcome,
    postActionRun?: AutomationPostActionRun, landing?: string,
  ): { ok: true; stopOthers: boolean; completion?: Promise<void>; result?: AutomationResult }
    | { ok: false; error: string } {
    const result = planned ?? planAutomation(this.store.world, doc,
      { ...event, hurtHeal: planAutomationHealth,
        imageAssetError: (hash) => automationImageError(hash, this.manifestSource()) }, this.systemUserId,
      undefined, landing);
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
      }, cue.audience, event.caller.id, prepared);
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
    const actionSession = postActionRun?.session ?? (postActions.length ? [...this.sessions.values()].find((s) =>
      s.user === event.caller) : undefined);
    if (postActions.length && (!actionSession?.user || this.sessions.get(actionSession.peerId) !== actionSession ||
        (!postActionRun && this.activeMacroRuns >= 8))) {
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
        const selectedRunAs = action.runAs ?? "approved";
        const validated = checked?.ok ? validateScriptArgs(action.args, checked.policy,
          (id) => !!view?.tokens.some((t) => t._id === id)) : null;
        if (checked?.ok && selectedRunAs === "gm" && checked.policy.runAs !== "gm") {
          const error = `Reviewed script ${action.macroId} does not approve GM run-as`;
          this.reportAutomation(doc, event.method, "rejected", error, result.plan.trace);
          return { ok: false, error };
        }
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
    const audit = postActionRun?.audit ??
      this.newActionAudit(`Active zone: ${doc.name} (${event.method})`, postActions.length > 0);
    const committed = this.commitOps(result.plan.ops, this.systemUserId,
      `zone-${randomId()}`, true, audit, new Set(result.plan.suppressedMovement));
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
    if (postActionRun) postActionRun.trace.push(...result.plan.trace);
    const actionCaller = postActionRun?.caller ?? actionSession?.user;
    let completion: Promise<void> | undefined;
    if (actionCaller && actionSession && postActions.length) {
      if (!postActionRun) this.activeMacroRuns++;
      // External source resolution and Worker RPCs cannot be folded into an
      // atomic graph transaction. Result-capturing scripts resume a later
      // graph segment only after their awaited outcome is known.
      const runState = postActionRun ?? { audit, session: actionSession, caller: actionCaller,
        deadline: Date.now() + 30_000, budget: { calls: 0 }, trace: [...result.plan.trace],
        continuedFailures: 0, actionCount: postActions.length, summonCount: summonsQueued };
      if (postActionRun) {
        runState.actionCount += postActions.length;
        runState.summonCount += summonsQueued;
      }
      const trace = runState.trace;
      let currentKind: "script" | "summon" = "script";
      let currentStepId = "";
      completion = (async () => {
        let outcome: "completed" | "partial" = "completed";
        const deadline = runState.deadline;
        const budget = runState.budget;
        const actionSession = runState.session;
        const actionCaller = runState.caller;
        const capturedResults = new Map<string, AutomationScriptResult>();
        const graphLive = () => Date.now() < deadline &&
          this.store.get("actionReceipts", audit.id)?.status === "pending" &&
          this.sessions.get(actionSession.peerId) === actionSession && actionSession.user === actionCaller &&
          JSON.stringify((this.store.get("automations", doc._id) as AutomationDocument | undefined)?.definition) ===
            approvedRootDefinition;
        try {
          for (const [i, action] of postActions.entries()) {
            currentKind = action.kind;
            currentStepId = action.stepId;
            if (!graphLive()) throw new Error("Zone changed or caller disconnected after graph commit");
            try {
              if (action.kind === "script") {
                const ctx: ScriptInvocation = { session: actionSession, caller: actionCaller,
                  requestId: `zone-${committed.seq}-${i}`, deadline, budget, trace: [], audit };
                try {
                  const value = await this.executeScript(action.macroId, action.args, ctx, "", [], graphLive,
                    action.runAs);
                  if (action.captureResult) capturedResults.set(action.stepId, { ok: true, value });
                  trace.push(`reviewed script [${action.stepId}] completed with ${scriptResultSummary(value)}`);
                } finally { trace.push(...ctx.trace); }
              } else {
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
            } catch (cause) {
              // A failed captured call becomes a branchable result only when
              // this authored step explicitly permits continuing. Revocation,
              // timeout or disconnect still cancels the graph continuation.
              const reason = cause instanceof Error ? cause.message : "unknown error";
              if (action.kind === "script" && action.captureResult)
                capturedResults.set(action.stepId, { ok: false, error: reason.slice(0, 500) });
              if (action.onError !== "continue" || !graphLive()) throw cause;
              runState.continuedFailures++;
              outcome = "partial";
              trace.push(`POST-COMMIT ${currentKind.toUpperCase()} [${currentStepId}] FAILED: ${reason}; continuing with remaining authorized actions`);
            }
          }
          if (result.plan.continuation) {
            const suspended = result.plan.continuation;
            const captured = capturedResults.get(suspended.captureStepId);
            if (!captured) throw new Error(`Missing awaited result for script [${suspended.captureStepId}]`);
            if (!graphLive()) throw new Error("Zone changed or caller disconnected before graph continuation");
            const liveDoc = this.store.get("automations", doc._id) as AutomationDocument | undefined;
            const liveScene = this.store.get("scenes", event.scene._id) as SceneDocument | undefined;
            const liveTile = liveScene && liveDoc?.definition
              ? automationSourceTile(liveScene, liveDoc.definition.tileId, liveDoc.definition.sourceKind) : undefined;
            const liveToken = event.token ? liveScene?.tokens.find((token) => token._id === event.token?._id) : undefined;
            if (!liveDoc || !liveScene || !liveTile || (event.token && !liveToken))
              throw new Error("Automation source or triggering token is unavailable after the awaited script");
            const nextEvent: AutomationEvent = { ...event, scene: liveScene, tile: liveTile,
              ...(liveToken ? { token: liveToken } : {}) };
            const nextContinuation: AutomationContinuation = { ...suspended,
              scriptResults: { ...suspended.scriptResults, [suspended.captureStepId]: captured } };
            const next = planAutomation(this.store.world, liveDoc, { ...nextEvent, hurtHeal: planAutomationHealth,
              imageAssetError: (hash) => automationImageError(hash, this.manifestSource()) },
            this.systemUserId, nextContinuation);
            if (!next.ok) throw new Error(`Automation continuation rejected: ${next.error}`);
            if ("skipped" in next) throw new Error(`Automation continuation skipped: ${next.skipped}`);
            const continued = this.fireAutomation(liveDoc, nextEvent, false, next, runState);
            if (!continued.ok) throw new Error(`Automation continuation failed: ${continued.error}`);
            if (continued.completion) await continued.completion;
          }
          if (runState.continuedFailures) outcome = "partial";
          if (!postActionRun) {
            if (runState.continuedFailures) {
              this.reportAutomation(doc, event.method, "post-commit-failed",
                `${runState.continuedFailures} post-commit action(s) failed; remaining authorized actions completed`, trace, committed.seq);
            } else {
              this.reportAutomation(doc, event.method, "committed",
                runState.summonCount ? `${runState.actionCount} post-commit actions completed` :
                  `${runState.actionCount} post-commit scripts completed`, trace, committed.seq);
            }
          }
        } catch (cause) {
          outcome = "partial";
          if (postActionRun) throw cause;
          trace.push(`POST-COMMIT ${currentKind.toUpperCase()} [${currentStepId}] FAILED: ${cause instanceof Error ? cause.message : "unknown error"}`);
          this.reportAutomation(doc, event.method, "post-commit-failed",
            currentKind === "script" ? "Script failed after the graph committed; graph state was not rolled back" :
              "Summon failed after the graph committed; graph state was not rolled back", trace, committed.seq);
        } finally {
          if (!postActionRun) {
            this.finishActionAudit(audit, outcome);
            this.activeMacroRuns--;
          }
        }
      })();
    } else if (postActions.length) {
      this.finishActionAudit(audit, "partial");
    }
    // MC-02: a graph may hand a value back to whoever invoked it.
    return { ok: true, stopOthers: result.plan.stopOthers, ...(completion ? { completion } : {}),
      ...(result.plan.result ? { result: result.plan.result } : {}) };
  }

  // ─── Macros / FX Wizard: approved, recipient-projected timeline ─────────────

  /** Idempotency plus the private acknowledgement a same-ID retry receives. */
  private readonly seenFxRequests = new Map<string, FxRunMsg>();
  /** Per-session delivery ledger: revocation/end is sent only to past recipients. */
  private readonly fxViewers = new Map<string, { sceneId: string; peers: Set<string> }>();
  /** Non-media cues need only enough lead for every viewer to schedule the host clock. */
  private static readonly FX_LEAD_MS = 300;
  /**
   * Active-scene asset transfer plus video first-frame decode needs more than the base
   * scheduler lead. Media runs receive a bounded head start for both; honest late reporting
   * still applies when fetch/decode exceeds this window.
   */
  private static readonly FX_MEDIA_LEAD_MS = 2_000;
  /** How many runs' worth of media expectations the host remembers (oldest evicted). */
  private static readonly FX_MEDIA_RUNS = 32;
  /** The shortest wait for viewer answers: a cue with everything due at once still gets this. */
  private static readonly FX_MEDIA_MIN_WINDOW_MS = 4_000;
  /** The longest: beyond a minute a "report" describes a cue nobody is watching any more. */
  private static readonly FX_MEDIA_MAX_WINDOW_MS = 60_000;
  /** After the first line, how long a changed answer may still produce *one* correction. */
  private static readonly FX_MEDIA_CORRECTION_MS = 20_000;
  /** Host-memory bound for finite cancellation handles. Timelines already end within 60 s. */
  private static readonly FX_TRANSIENT_RUNS = 256;

  private fxEndsAt(cue: FxStartMsg): number {
    // A condition may authoritatively select no sections. Its accepted no-op ends at
    // the scheduled launch rather than producing -Infinity or a recipient-visible cue.
    return cue.atHostTime + Math.max(0, ...cue.sections.map((section) =>
      section.startMs + section.durationMs));
  }

  private fxRunAck(requestId: string, prepared: PreparedFx): FxRunMsg {
    const persistent = prepared.cue.persistent === true;
    return { kind: "fx.run", requestId, runId: prepared.cue.runId,
      macroId: prepared.cue.macroId, sceneId: prepared.cue.sceneId,
      atHostTime: prepared.cue.atHostTime, persistent,
      ...(persistent ? {} : { endsAtHostTime: this.fxEndsAt(prepared.cue) }) };
  }

  /** Drop naturally completed finite runs. Playback ends locally; no end packet is needed. */
  private pruneTransientFx(): void {
    const now = this.now();
    for (const [runId, run] of this.fxTransientRuns)
      if (run.endsAtHostTime <= now) this.fxTransientRuns.delete(runId);
  }

  private sweepTransientFx(): void {
    if (this.disposed) return;
    this.pruneTransientFx();
    this.scheduleTransientFxSweep();
  }

  /** One absolute-deadline timer for all finite runs, rather than one timer per section/run. */
  private scheduleTransientFxSweep(): void {
    if (this.fxTransientTimer) clearTimeout(this.fxTransientTimer);
    this.fxTransientTimer = null;
    if (this.disposed) return;
    let next = Infinity;
    for (const run of this.fxTransientRuns.values()) next = Math.min(next, run.endsAtHostTime);
    if (!Number.isFinite(next)) return;
    this.fxTransientTimer = setTimeout(() => this.sweepTransientFx(),
      Math.max(0, Math.min(2_147_483_647, next - this.now())));
    (this.fxTransientTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Register only after successful fan-out. Recipients stay private host state. */
  private rememberTransientFx(prepared: PreparedFx, recipients: readonly Session[]): void {
    if (prepared.cue.persistent) return;
    this.fxTransientRuns.set(prepared.cue.runId, {
      sceneId: prepared.cue.sceneId, ownerId: prepared.callerId,
      peers: new Set(recipients.map((session) => session.peerId)),
      endsAtHostTime: this.fxEndsAt(prepared.cue) });
    this.scheduleTransientFxSweep();
  }

  /**
   * Presentation-only cancellation. It has no world op to undo: the host forgets the
   * finite handle and sends the same opaque end signal durable instances already use,
   * only to sessions that received this run. Unknown and unauthorized IDs are identical.
   */
  private cancelTransientFx(runId: string, user: SessionUser, sceneId?: string): boolean {
    this.pruneTransientFx();
    const run = this.fxTransientRuns.get(runId);
    const privileged = user.role === "GM" || user.role === "ASSISTANT";
    if (!run || (sceneId !== undefined && run.sceneId !== sceneId) ||
        (!privileged && run.ownerId !== user.id)) return false;
    this.fxTransientRuns.delete(runId);
    // A cancelled cue has no meaningful late media report. Client-side async work is
    // epoch-guarded and cannot acknowledge after it receives this end.
    if (this.fxMediaReceipts.delete(runId)) this.scheduleFxMediaSweep();
    for (const peerId of run.peers) {
      const recipient = this.sessions.get(peerId);
      if (recipient?.user) this.send(recipient, { kind: "fx.end", runId, sceneId: run.sceneId });
    }
    this.scheduleTransientFxSweep();
    return true;
  }

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
    const previous = this.seenFxRequests.get(key);
    if (previous) { this.send(session, previous); return; }
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
    // Name the exact approved run only to its requester. This contains no recipient
    // counts or projection data. The requester may therefore own the handle without being
    // a playback recipient (for example, a GM running an `others`-audience timeline).
    const ack = this.fxRunAck(msg.requestId, prepared);
    this.send(session, ack);
    // Register after successful host commit/fan-out; retries receive this ack but cannot clone cues.
    this.seenFxRequests.set(key, ack);
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

  /**
   * Phase origins supplied by still-active durable runs of this exact saved timeline.
   * Scope includes owner, effective audience and invocation anchors: a public cue must
   * never reveal merely through phase that another caller, hidden token or GM-only run
   * already existed.
   */
  private activeFxSyncOrigins(
    scene: SceneDocument,
    macroId: string,
    ownerId: string,
    audience: FxAudience,
    sourceTokenId: string | undefined,
    targetTokenId: string | undefined,
    manifest: AssetManifest,
    pending: readonly PreparedFx[] = [],
  ): ReadonlyMap<string, number> {
    const audienceKey = (value: FxAudience): string => typeof value === "string"
      ? value : `players:${value.players.join("\u0000")}`;
    const expectedAudience = audienceKey(audience);
    const origins = new Map<string, number>();
    const add = (members: readonly FxSyncGroupMember[] | undefined,
      sections: readonly ResolvedFxSection[]): void => {
      if (!members?.length) return;
      const byId = new Map(sections.map((section) => [section.id, section]));
      for (const member of members) {
        const section = byId.get(member.sectionId);
        const origin = section && (section.kind === "image" || section.kind === "text")
          ? section.syncAtHostTime : undefined;
        if (origin === undefined) continue;
        origins.set(member.group, Math.min(origins.get(member.group) ?? Infinity, origin));
      }
    };
    for (const doc of this.store.getAll("fxInstances")) {
      if (doc.sceneId !== scene._id || doc.macroId !== macroId || doc.ownerId !== ownerId ||
          doc.sourceTokenId !== sourceTokenId || doc.targetTokenId !== targetTokenId ||
          audienceKey(doc.audience) !== expectedAudience || !doc.syncGroups?.length ||
          !validateFxInstance(doc, scene, manifest)) continue;
      add(doc.syncGroups, doc.sections);
    }
    // An automation graph preflights its complete cue list before any durable commit.
    // Earlier prepared siblings are active-for-this-transaction origins, so two copies
    // of one grouped timeline in the same atomic graph do not miss each other by 1 ms.
    for (const prepared of pending) {
      if (prepared.cue.sceneId !== scene._id || prepared.cue.macroId !== macroId ||
          prepared.callerId !== ownerId || prepared.sourceTokenId !== sourceTokenId ||
          prepared.targetTokenId !== targetTokenId ||
          audienceKey(prepared.audience) !== expectedAudience) continue;
      add(prepared.syncGroups, prepared.cue.sections);
    }
    return origins;
  }

  /** Same host scheduler for editor/macros and triggered FX. Can NARROW a graph's audience,
   * never expand the saved macro's audience or a recipient's asset entitlement. */
  private prepareFx(
    caller: SessionUser,
    req: Pick<FxRequestMsg, "macroId" | "sceneId" | "sourceTokenId" | "targetTokenId">,
    narrowAudience?: "gm" | "scene",
    /** Reviewed GM-elevated scripts execute with GM rights but retain the invoking caller as owner/audience. */
    ownerId = caller.id,
    /** Earlier cues in one atomic automation preflight (not yet present in the store). */
    pending: readonly PreparedFx[] = [],
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
    // Definition visibility, invocation and playback recipients are independent policies. A
    // published player needs macro read access and `playerCallable`; the saved/narrowed audience
    // is applied below only to recipients, so a player may intentionally trigger GM-only FX.
    if (!can(caller, "read", macro, "macros") || !can(caller, "read", scene, "scenes") ||
        (!isGm && macro.flags?.core?.playerCallable !== true))
      return forbidden("FX macro is not published for this caller");
    const callerScene = projectWorld(this.store.world, this.store.seq, caller).collections.scenes
      ?.find((s) => s._id === scene._id);
    const source = req.sourceTokenId ? scene.tokens.find((t) => t._id === req.sourceTokenId) : undefined;
    const target = req.targetTokenId ? scene.tokens.find((t) => t._id === req.targetTokenId) : undefined;
    if ((req.sourceTokenId && (!source || !callerScene?.tokens.some((t) => t._id === source._id))) ||
        (req.targetTokenId && (!target || !callerScene?.tokens.some((t) => t._id === target._id))))
      return forbidden("FX source/target is not visible to caller");
    const manifest = this.manifestSource();
    // Random timing and conditional inclusion are sampled once here, before per-viewer
    // projection, so every recipient shares one schedule/decision and receives neither
    // the authored range nor the play predicate.
    const resolved = resolveFxSequence(macro.sequence, scene, source, target,
      (id) => manifest[id]?.mime, this.rng);
    if (!resolved.ok) return invalid(resolved.error);
    if (macro.sequence.persistent && (this.store.getAll("fxInstances").length >= 64 ||
        this.store.getAll("fxInstances").filter((entry) => entry.sceneId === scene._id).length >= 24))
      return invalid("persistent FX instance limit reached; stop an effect first");
    this.pruneTransientFx();
    if (!macro.sequence.persistent && this.fxTransientRuns.size +
        pending.filter((entry) => entry.cue.persistent !== true).length >= HostSync.FX_TRANSIENT_RUNS)
      return invalid("active one-shot FX run limit reached; wait for or cancel a run first");
    const leadMs = resolved.sections.some((section) => section.kind === "image" || section.kind === "sound")
      ? HostSync.FX_MEDIA_LEAD_MS : HostSync.FX_LEAD_MS;
    const atHostTime = this.now() + leadMs;
    // D-316: one rule for every audience form. It also scopes active sync origins, so a
    // narrowed/other-owner run cannot disclose itself through a public cue's phase.
    const audience: FxAudience = narrowAudience === "gm" ? "gm" : macro.sequence.audience ?? "scene";
    const syncedSections = resolved.syncGroups === undefined ? resolved.sections
      : fxResolveSyncOrigins(resolved.sections, resolved.syncGroups, atHostTime,
          this.activeFxSyncOrigins(scene, macro._id, ownerId, audience, source?._id, target?._id,
            manifest, pending)).sections;
    const cue: FxStartMsg = {
      kind: "fx.start", runId: randomId(), macroId: macro._id, sceneId: scene._id,
      atHostTime, sections: syncedSections,
      ...(macro.sequence.persistent ? { persistent: true } : {}),
    };
    const recipients: Session[] = [];
    // SQ-13 (A10): preflight says who will NOT get this cue. Counts are per reason so
    // the requester hears "two viewers are missing the media", not a silent drop.
    const skipped: FxDeliverySkips = { audience: 0, rights: 0, anchor: 0, media: 0 };
    // D-303: preflight also says who got a *reduced* payload (a targeted camera section,
    // D-300) and who was left with nothing, which is a different fact from a skip.
    const targeting = { targeted: 0, empty: 0 };
    // D-316: audience is evaluated per viewer. A caller-side narrowing can only ever
    // narrow what the saved macro already allows.
    for (const viewer of this.sessions.values()) {
      // An all-skipped conditional run has no recipient projection to evaluate. It is
      // acknowledged privately, without an empty cue or audience/targeting report.
      if (cue.sections.length === 0) break;
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
      if (cue.sections.some((step) =>
        (step.kind === "image" || step.kind === "sound") && !available[step.assetId])) { skipped.media++; continue; }
      // Would this viewer receive the whole run? Targeting is decided by the author's
      // audiences, not by a document change, so it is settled here rather than later.
      const entitled = fxSectionsForViewer(cue.sections, asViewer, ownerId);
      if (entitled.length === 0) { targeting.empty++; continue; }
      if (entitled.length < cue.sections.length) targeting.targeted++;
      recipients.push(viewer);
    }
    return { ok: true, cue, recipients, callerId: ownerId, skipped, targeting,
      audience,
      checkedAtSeq: this.store.seq,
      ...(resolved.syncGroups ? { syncGroups: resolved.syncGroups } : {}),
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
        ...(prepared.syncGroups ? { syncGroups: prepared.syncGroups } : {}),
        ...(prepared.sourceTokenId ? { sourceTokenId: prepared.sourceTokenId } : {}),
        ...(prepared.targetTokenId ? { targetTokenId: prepared.targetTokenId } : {}),
        ...(prepared.conditionApplicationId ? { conditionApplicationId: prepared.conditionApplicationId } : {}) };
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
    const delivered: Session[] = [];
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
      delivered.push(recipient);
      sentTo?.push(recipient);
      const forSound = hostScene ? this.fxOccludedFor(hostScene, forViewer, user.id) : forViewer;
      const shared = forViewer === prepared.cue.sections && forSound === forViewer;
      this.send(recipient, shared ? prepared.cue : { ...prepared.cue, sections: [...forSound] });
    }
    this.rememberTransientFx(prepared, delivered);
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
    if (doc) {
      if (user.role !== "GM" && user.role !== "ASSISTANT" && doc.ownerId !== user.id) {
        this.reject(session, msg.requestId, "forbidden", "FX run unavailable");
        return;
      }
      const stopped = this.commitOps([{ kind: "delete", ref: { coll: "fxInstances", id: doc._id } }],
        this.systemUserId, `fx-stop-${msg.requestId}`);
      if (!stopped.ok) this.reject(session, msg.requestId, "invariant", "FX instance could not be stopped");
      return;
    }
    if (!this.cancelTransientFx(msg.instanceId, user))
      this.reject(session, msg.requestId, "forbidden", "FX run unavailable");
  }

  // ─── Assets (§7) ─────────────────────────────────────────────────────────────

  private currentUploadUser(session: Session): SessionUser | null {
    const sessionUser = session.user;
    if (!sessionUser) return null;
    const stored = this.store.get("users", sessionUser.id) as UserDocument | undefined;
    // Loopback/legacy tests may provide a session without a stored users row. When a row exists,
    // its current role is authoritative so a just-revoked TRUSTED grant fails closed.
    return stored
      ? { id: stored._id, role: stored.role, name: stored.name }
      : sessionUser;
  }

  private imageUploadAllowed(user: SessionUser): boolean {
    if (user.role === "GM" || user.role === "ASSISTANT") return true;
    if (user.role !== "TRUSTED") return false;
    return worldSettingsFrom(this.store.getAll("settings")).restrictedPlayerImageMode !== true;
  }

  private uploadQuotaError(user: SessionUser, size: number, excludeUploadId?: string): string | null {
    if (user.role === "GM" || user.role === "ASSISTANT") return null;
    const quota = playerUploadQuotaMBOf(worldSettingsFrom(this.store.getAll("settings")));
    if (quota === null) return null;
    const used = Object.values(this.manifestSource()).reduce((sum, entry) => {
      const source = entry.source;
      const recorded = source?.uploadedBytesByUser?.[user.id];
      const legacy = source?.importedBy === user.id ? source.uploadedBytes ?? entry.size : 0;
      return sum + (recorded ?? legacy);
    }, 0);
    // Reserve the declared size of active uploads so concurrent sessions cannot race past a quota.
    const reserved = [...this.sessions.values()].reduce((sum, peer) => {
      const pending = peer.imageUpload;
      return pending && pending.userId === user.id && pending.uploadId !== excludeUploadId
        ? sum + pending.size : sum;
    }, 0);
    return used + reserved + size > quota * 1024 * 1024
      ? `Image upload quota reached (${((used + reserved) / (1024 * 1024)).toFixed(1)} MB used or reserved of ${quota} MB)`
      : null;
  }

  private sendImageUploadResult(session: Session, result: import("../core/messages").AssetUploadResultMsg): void {
    this.send(session, result);
  }

  private failImageUpload(session: Session, uploadId: string, error: string): void {
    const received = session.imageUpload?.uploadId === uploadId ? session.imageUpload.received : 0;
    if (session.imageUpload?.uploadId === uploadId) this.cancelImageUpload(session);
    this.sendImageUploadResult(session, { kind: "asset.upload.result", uploadId, status: "error", received, error });
  }

  private cancelImageUpload(session: Session): void {
    const upload = session.imageUpload;
    if (!upload) return;
    globalThis.clearTimeout(upload.timer);
    upload.chunks.length = 0;
    session.imageUpload = null;
  }

  private handleAssetUploadStart(session: Session, msg: AssetUploadStartMsg): void {
    if (!session.user) return;
    if (!this.assets || !this.pipeline) {
      this.failImageUpload(session, msg.uploadId, "The host image-import service is unavailable");
      return;
    }
    const user = this.currentUploadUser(session);
    if (!user || !this.imageUploadAllowed(user)) {
      this.failImageUpload(session, msg.uploadId, "Image persistence requires GM permission or the TRUSTED upload grant");
      return;
    }
    if (session.imageUpload) {
      this.failImageUpload(session, msg.uploadId, "Finish or cancel the current image upload first");
      return;
    }
    if ([...this.sessions.values()].filter((peer) => peer.imageUpload !== null).length >= 4) {
      this.failImageUpload(session, msg.uploadId, "The host is already processing the maximum number of image uploads");
      return;
    }
    if (typeof msg.uploadId !== "string" || msg.uploadId.length < 8 || msg.uploadId.length > 128 ||
        typeof msg.name !== "string" || msg.name.trim() === "" || msg.name.length > 1024 ||
        typeof msg.displayName !== "string" || msg.displayName.trim() === "" || msg.displayName.length > 160 ||
        !Number.isSafeInteger(msg.size) || msg.size < 1 || msg.size > MAX_IMAGE_BYTES ||
        typeof msg.folder !== "string" || msg.folder.length > 512 ||
        (msg.sourceKind !== "file" && msg.sourceKind !== "paste" && msg.sourceKind !== "url") ||
        (msg.collisionBehavior !== "stop" && msg.collisionBehavior !== "reuse" && msg.collisionBehavior !== "overwrite") ||
        (user.role === "TRUSTED" && msg.collisionBehavior !== "stop") ||
        typeof msg.convertToWebp !== "boolean" || !Number.isFinite(msg.webpQuality) ||
        msg.webpQuality < 0.1 || msg.webpQuality > 1) {
      this.failImageUpload(session, msg.uploadId, "The image-upload request has invalid metadata or exceeds the 64 MB limit");
      return;
    }
    const quotaError = this.uploadQuotaError(user, msg.size);
    if (quotaError) { this.failImageUpload(session, msg.uploadId, quotaError); return; }
    const uploadId = msg.uploadId;
    const timer = globalThis.setTimeout(() => {
      if (session.imageUpload?.uploadId === uploadId)
        this.failImageUpload(session, uploadId, "Image upload expired before it completed");
    }, 10 * 60_000);
    session.imageUpload = {
      uploadId, userId: user.id, name: msg.name, displayName: msg.displayName, size: msg.size,
      folder: normalizeLogicalFolder(msg.folder), sourceKind: msg.sourceKind,
      collisionBehavior: msg.collisionBehavior,
      convertToWebp: msg.convertToWebp, webpQuality: msg.webpQuality,
      chunks: [], received: 0, lastAck: 0, expiresAt: this.now() + 10 * 60_000, timer,
    };
    this.sendImageUploadResult(session, { kind: "asset.upload.result", uploadId, status: "ready", received: 0 });
  }

  private handleAssetUploadChunk(session: Session, msg: AssetUploadChunkMsg): void {
    const upload = session.imageUpload;
    if (!session.user || !upload || upload.uploadId !== msg.uploadId) return;
    if (this.now() > upload.expiresAt) {
      this.failImageUpload(session, msg.uploadId, "Image upload expired before it completed");
      return;
    }
    const user = this.currentUploadUser(session);
    if (!user || user.id !== upload.userId || !this.imageUploadAllowed(user)) {
      this.failImageUpload(session, msg.uploadId, "The uploader's TRUSTED permission was revoked");
      return;
    }
    if (!(msg.bytes instanceof Uint8Array) || msg.bytes.byteLength < 1 || msg.bytes.byteLength > 32 * 1024 ||
        msg.offset !== upload.received || upload.received + msg.bytes.byteLength > upload.size) {
      this.failImageUpload(session, msg.uploadId, "Image upload chunk order or size is invalid");
      return;
    }
    upload.chunks.push(new Uint8Array(msg.bytes));
    upload.received += msg.bytes.byteLength;
    if (upload.received - upload.lastAck >= 1024 * 1024) {
      upload.lastAck = upload.received;
      this.sendImageUploadResult(session, { kind: "asset.upload.result", uploadId: upload.uploadId,
        status: "progress", received: upload.received });
    }
  }

  private async handleAssetUploadFinish(session: Session, msg: AssetUploadFinishMsg): Promise<void> {
    const upload = session.imageUpload;
    if (!session.user || !upload || upload.uploadId !== msg.uploadId) return;
    if (this.now() > upload.expiresAt) {
      this.failImageUpload(session, msg.uploadId, "Image upload expired before it completed");
      return;
    }
    if (upload.received !== upload.size) {
      this.failImageUpload(session, msg.uploadId, "The image upload was incomplete; no bytes were imported");
      return;
    }
    const user = this.currentUploadUser(session);
    if (!user || user.id !== upload.userId || !this.imageUploadAllowed(user)) {
      this.failImageUpload(session, msg.uploadId, "The uploader's TRUSTED permission was revoked");
      return;
    }
    const quotaError = this.uploadQuotaError(user, upload.size, upload.uploadId);
    if (quotaError) { this.failImageUpload(session, msg.uploadId, quotaError); return; }
    const bytes = new Uint8Array(upload.size);
    let offset = 0;
    for (const chunk of upload.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const uploadId = upload.uploadId;
    const isPrivileged = user.role === "GM" || user.role === "ASSISTANT";
    let uploadAuditId: string | null = null;
    let uploadAuditHash: string | null = null;
    let uploadPreparedHash: string | null = null;
    let uploadWasReused = false;
    try {
      // Validate the real container/header at the host before any bitmap decode or asset write.
      const sniffed = sniffMedia(bytes);
      const imported = await this.pipeline?.importImage(bytes, upload.name, sniffed.mime, {
        visibility: isPrivileged ? "referenced" : "gm",
        source: { kind: upload.sourceKind, originalName: upload.name, originalMime: sniffed.mime,
          importedBy: user.id, uploadedBytes: upload.size },
        logicalFile: { folder: upload.folder, name: upload.displayName },
        logicalFileBehavior: upload.collisionBehavior,
        convertToWebp: upload.convertToWebp, webpQuality: upload.webpQuality,
        beforeStore: ({ assetHash, preparedHash, reused }) => {
          const current = this.currentUploadUser(session);
          if (!current || current.id !== upload.userId || !this.imageUploadAllowed(current))
            throw new Error("The uploader's TRUSTED permission was revoked before the image was stored");
          const currentQuota = this.uploadQuotaError(current, upload.size, upload.uploadId);
          if (currentQuota) throw new Error(currentQuota);
          const gmIds = [...new Set([this.systemUserId, ...(this.store.getAll("users") as UserDocument[])
            .filter((entry) => entry.role === "GM" || entry.role === "ASSISTANT")
            .map((entry) => entry._id)])];
          const auditMessage: MessageDocument = {
            _id: randomId(), type: "message", name: "Image upload audit",
            ownership: { default: 0 }, flags: {},
            system: { auditKind: "image-upload", auditStatus: "pending", assetId: assetHash,
              preparedHash, uploadId, uploadedBytes: upload.size, sourceKind: upload.sourceKind },
            author: user.id,
            content: `${user.name} started uploading image “${upload.displayName}” (${assetHash.slice(0, 12)}).`,
            whisper: gmIds, roll: null, flavor: "Image upload audit",
          };
          const auditCommit = this.commitOps([{ kind: "create", coll: "messages", data: auditMessage }],
            user.id, `image-upload-start-${uploadId}`, false);
          if (!auditCommit.ok)
            throw new Error(`Image upload audit could not be committed; no bytes were stored: ${auditCommit.error}`);
          uploadAuditId = auditMessage._id;
          uploadAuditHash = assetHash;
          uploadPreparedHash = preparedHash;
          uploadWasReused = reused;
        },
      });
      if (!imported) throw new Error("The host image-import service is unavailable");
      let auditWarning: string | undefined;
      if (uploadAuditId) {
        const auditStatus = uploadWasReused ? "reused" : "stored";
        const auditMessage: MessageDocument = {
          ...((this.store.get("messages", uploadAuditId) as MessageDocument | undefined) ?? {
            _id: uploadAuditId, type: "message", name: "Image upload audit",
            ownership: { default: 0 }, flags: {}, system: {}, author: user.id,
            content: "Image upload", whisper: [], roll: null, flavor: "Image upload audit",
          }),
          system: { auditKind: "image-upload", auditStatus, assetId: imported.hash,
            ...(uploadPreparedHash ? { preparedHash: uploadPreparedHash } : {}), uploadId,
            uploadedBytes: upload.size, sourceKind: upload.sourceKind },
          content: `${user.name} ${uploadWasReused ? "reused" : "uploaded"} image “${upload.displayName}” (${imported.hash.slice(0, 12)}).`,
        };
        const audited = this.commitOps([{ kind: "update", ref: { coll: "messages", id: uploadAuditId },
          diff: { system: auditMessage.system as unknown as Json, content: auditMessage.content } }],
        user.id, `image-upload-complete-${uploadId}`, false);
        if (!audited.ok) auditWarning = `Image stored, but the audit entry remains pending: ${audited.error}`;
      }
      this.cancelImageUpload(session);
      this.sendImageUploadResult(session, { kind: "asset.upload.result", uploadId, status: "complete",
        received: upload.size, asset: { hash: imported.hash, name: imported.entry.name, mime: imported.entry.mime,
          size: imported.entry.size, ...(imported.entry.width !== undefined ? { width: imported.entry.width } : {}),
          ...(imported.entry.height !== undefined ? { height: imported.entry.height } : {}),
          ...(imported.entry.thumb ? { thumbnail: imported.entry.thumb.assetId } : {}),
          ...(auditWarning ? { auditWarning } : {}) } });
    } catch (error) {
      if (uploadAuditId) {
        const detail = error instanceof Error ? error.message : String(error);
        const failedAudit: Op[] = [{ kind: "update", ref: { coll: "messages", id: uploadAuditId },
          diff: { system: { auditKind: "image-upload", auditStatus: "failed",
            ...(uploadAuditHash ? { assetId: uploadAuditHash } : {}),
            ...(uploadPreparedHash ? { preparedHash: uploadPreparedHash } : {}),
            uploadId, uploadedBytes: upload.size, sourceKind: upload.sourceKind,
            error: detail.slice(0, 1000) }, content: `${user.name}'s image upload failed: ${detail.slice(0, 1000)}` } }];
        try { this.commitOps(failedAudit, user.id, `image-upload-failed-${uploadId}`, false); }
        catch { /* the pre-import pending audit entry remains as a durable failure signal */ }
      }
      this.failImageUpload(session, uploadId, error instanceof Error ? error.message : String(error));
    } finally {
      bytes.fill(0);
    }
  }

  private async handleAssetShare(session: Session, msg: AssetShareMsg): Promise<void> {
    const user = this.currentUploadUser(session);
    if (!session.user || !user || !this.assets || !/^[a-f0-9]{64}$/i.test(msg.assetId)) {
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: false, error: "Image sharing is unavailable" });
      return;
    }
    if (!this.imageUploadAllowed(user)) {
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: false, error: "Image sharing requires GM permission or the TRUSTED upload grant" });
      return;
    }
    const entry = await this.assets.meta(msg.assetId);
    const uploadedByUser = entry?.source?.uploadedBytesByUser?.[user.id];
    if (!entry || (user.role === "TRUSTED" && entry.source?.importedBy !== user.id &&
        !(typeof uploadedByUser === "number" && uploadedByUser > 0))) {
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: false, error: "This image is not available to share" });
      return;
    }
    const settingsDoc = this.store.get("settings", "world-settings");
    const priorSystem = settingsDoc?.system ?? {};
    const priorSlots = priorSystem.imageShareSlots;
    const slots = typeof priorSlots === "object" && priorSlots !== null && !Array.isArray(priorSlots)
      ? priorSlots as Record<string, Json> : {};
    const nextSlots = { ...slots, [user.id]: msg.assetId };
    const settingOp: Op = settingsDoc
      ? { kind: "update", ref: { coll: "settings", id: "world-settings" }, diff: { system: { ...priorSystem, imageShareSlots: nextSlots } } }
      : { kind: "create", coll: "settings", data: { _id: "world-settings", type: "settings", name: "World Settings",
          ownership: { default: OWNERSHIP_LEVELS.NONE }, flags: {}, system: { imageShareSlots: nextSlots } } };
    const committed = this.commitOps([settingOp], user.id, `image-share-slot-${msg.requestId}`, false);
    if (!committed.ok) {
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: false, error: committed.error });
      return;
    }
    try {
      // Persist the stable per-user slot first; make the asset world-readable only for the explicit
      // share action, then send the ephemeral cue after the asset manifest is available.
      await this.assets.describe(msg.assetId, { visibility: "world" });
      if (!(await this.assets.has(msg.assetId))) throw new Error("Shared image bytes are missing");
      const data: Record<string, Json> = { assetId: msg.assetId, name: entry.name };
      const ephemeral: EphemeralMsg = { kind: "ephemeral", from: user.id, t: "image", data };
      const manifest = this.manifestSource();
      for (const recipient of this.sessions.values()) {
        if (!recipient.user || !canFetchAsset(this.store.world, manifest, recipient.user, msg.assetId)) continue;
        this.send(recipient, ephemeral);
      }
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: true });
    } catch (error) {
      this.send(session, { kind: "asset.share.result", requestId: msg.requestId, ok: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** §6.8: what counts as live is the world's documents, minus audit provenance (see assetUsageRoots). */
  private liveAssetRoots(): unknown[] {
    return assetUsageRoots(this.store.world as unknown as Record<string, unknown>);
  }

  private async handleAssetLibrary(session: Session, msg: AssetLibraryMsg): Promise<void> {
    if (!session.user || session.user.role !== "GM" || !this.assets) {
      this.send(session, { kind: "asset.library.result", requestId: msg.requestId, ok: false,
        error: "Only the GM can list stored images" });
      return;
    }
    const manifest = await this.assets.manifest();
    const assets = assetLibrary(manifest, this.liveAssetRoots());
    this.send(session, { kind: "asset.library.result", requestId: msg.requestId, ok: true, assets });
  }

  /**
   * §6.8 GM-only clean-up. The client's list is advisory: each image is re-checked against the live
   * documents immediately before its bytes are removed, and anything now in use is reported as
   * skipped instead of deleted.
   */
  private async handleAssetCleanup(session: Session, msg: AssetCleanupMsg): Promise<void> {
    const fail = (error: string): void => {
      this.send(session, { kind: "asset.cleanup.result", requestId: msg.requestId, ok: false, error });
    };
    if (!session.user || session.user.role !== "GM" || !this.assets) {
      fail("Only the GM can clean up stored images");
      return;
    }
    if (!Array.isArray(msg.hashes) || msg.hashes.length > 5000 ||
        !msg.hashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash))) {
      fail("The clean-up list is not valid");
      return;
    }
    const removed: AssetId[] = [];
    const skipped: AssetId[] = [];
    let bytes = 0;
    try {
      for (const hash of new Set(msg.hashes)) {
        const manifest = await this.assets.manifest();
        const unused = new Set(unusedAssetIds(manifest, this.liveAssetRoots()));
        if (!unused.has(hash) || !manifest[hash]) {
          skipped.push(hash);
          continue;
        }
        bytes += manifest[hash].size;
        await this.assets.remove(hash);
        removed.push(hash);
      }
    } catch (error) {
      this.broadcastAssetManifest();
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.broadcastAssetManifest();
    this.send(session, { kind: "asset.cleanup.result", requestId: msg.requestId, ok: true, removed, skipped, bytes });
  }

  private broadcastAssetManifest(): void {
    for (const recipient of this.sessions.values()) this.sendProjectedManifest(recipient);
  }

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
      system: { rollEvidence: { v: 1, rollId: msg.rollId } },
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
        system: { rollEvidence: { v: 1, rollId: msg.rollId } },
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
    const pending = pendingRollOfSystem(doc.system, msg.pendingId);
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
    const isGM = session.user.role === "GM" || session.user.role === "ASSISTANT";
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
      const isRiderSave = actionCardOf(doc)?.targets.some((target) =>
        target.riders?.some((rider) => rider.state === "pending" &&
          rider.save?.pendingRollId === pending.id)) === true;
      const should = shouldDeferToPlayer({
        kind: pending.kind,
        targetIsPlayerOwned,
        worldSettings,
        isStrategic,
        isRiderSave,
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
    // Crypto evaluation yields to the event loop. Re-read the card and authorization before
    // staging anything: another target may have resolved, the selected roll may have expired,
    // or ownership/session state may have changed while this request was in flight.
    const liveDoc = this.store.get("messages", String(msg.messageId)) as MessageDocument | undefined;
    const livePending = liveDoc ? pendingRollOfSystem(liveDoc.system, msg.pendingId) : null;
    if (!liveDoc || !livePending || livePending.resolved ||
        JSON.stringify(livePending) !== JSON.stringify(pending) ||
        isPendingExpired(livePending, this.currentTurnNumber()) ||
        this.sessions.get(session.peerId) !== session || session.user === null) {
      this.reject(session, String(msg.messageId), "invalid_schema", "pending roll changed or expired");
      return;
    }
    const liveRollerId = livePending.kind === "attack"
      ? livePending.initiator.actorId : livePending.target.actorId;
    const liveRoller = this.store.get("actors", liveRollerId) as ActorDocument | undefined;
    const liveLevel = liveRoller?.ownership[session.user.id];
    if (!isGM && !(typeof liveLevel === "number" && liveLevel >= 1)) {
      this.reject(session, String(msg.messageId), "forbidden", "you no longer own this pending roll");
      return;
    }
    const total = evaluation.value.total;
    const updated: PendingRoll = resolvePendingRollDoc(livePending, {
      total,
      seedClient: msg.seedClient,
      seedHost,
    });
    // follow-up message (public narrative — same shape ChatPanel used to synthesize locally)
    const followUp: MessageDocument = {
      _id: randomId(),
      type: "message",
      name: `${livePending.target.name} ${livePending.kind}`,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: {},
      system: {},
      author: session.user.id,
      content: `${livePending.target.name} rolled ${String(total)} vs ${livePending.dc !== null ? `DC ${livePending.dc}` : "—"} — ${
        livePending.dc !== null && total >= livePending.dc
          ? "Success"
          : livePending.dc !== null && total < livePending.dc
            ? "Failure"
            : "rolled"
      } (${livePending.formula})`,
      whisper: [],
      roll: null,
      flavor: "",
      rollMode: livePending.rollMode,
    };
    // Also post a rolled message for the dice log. Multi-target cards need one durable, unique
    // evidence identity per selected check; legacy single-roll cards retain their message id.
    const pendingEvidenceId = livePending.id ?? String(msg.messageId);
    if (this.hostRollEvidenceIdExists(pendingEvidenceId) ||
        this.actionEvidenceRollAlreadyUsed(pendingEvidenceId)) {
      this.reject(session, String(msg.messageId), "invalid_schema", "pending roll identity was already used");
      return;
    }
    const rollMessage: MessageDocument = {
      _id: randomId(),
      type: "message",
      name: livePending.formula,
      ownership: { default: OWNERSHIP_LEVELS.LIMITED },
      flags: { core: { rollId: pendingEvidenceId } },
      // This roll is consumed by the selected pending-card transition in the same envelope.
      // Mint it already claimed so it cannot later masquerade as fresh immediate evidence.
      system: { rollEvidence: { v: 1, rollId: pendingEvidenceId, claimedBy: String(msg.messageId) } },
      author: session.user.id,
      content: livePending.formula,
      // Roll content stays visible per rollMode projection downstream; whisper
      // redaction is handled by the existing message projection, not here.
      whisper: [],
      roll: {
        formula: livePending.formula,
        total,
        terms: evaluation.value.terms,
        seedClient: msg.seedClient,
        seedHost,
        ...(msg.seedClientCommit ? { commit: msg.seedClientCommit } : {}),
      },
      rollMode: livePending.rollMode,
      flavor: livePending.initiator.actionLabel.slice(0, 300),
    };
    const pendingDiff = pendingRollUpdateDiff(liveDoc.system, livePending, updated);
    if (!pendingDiff) {
      this.reject(session, String(msg.messageId), "invalid_schema", "pending roll storage changed");
      return;
    }
    const action = actionCardOf(liveDoc);
    let poisonContinuation: { ops: Op[]; audit: ActionAudit } | null = null;
    if (action && livePending.actionId !== undefined) {
      const transition = resolveActionPendingTarget(action, livePending, total, this.now());
      if (!transition.ok) {
        this.reject(session, String(msg.messageId), "invalid_schema", transition.error);
        return;
      }
      pendingDiff["system.action"] = actionAsJson(transition.action);
      // A rider save is a first-class continuation: the same envelope that resolves the card row
      // also applies the poison mechanics, so the outcome is atomic and Revertable.
      const riderEntry = livePending.id === undefined ? undefined
        : action.targets.flatMap((target) => (target.riders ?? []).map((rider) => ({ target, rider })))
          .find((entry) => entry.rider.state === "pending" &&
            entry.rider.save?.pendingRollId === livePending.id);
      if (riderEntry?.rider.evidence?.adapter === "pf1e.poison.v1" && livePending.target.actorId) {
        const riderDc = riderEntry.rider.save?.dc ?? null;
        const targetActor = this.store.get("actors", livePending.target.actorId) as ActorDocument | undefined;
        if (!targetActor || riderDc === null) {
          this.reject(session, String(msg.messageId), "invariant", "poison rider save lacks its target or DC");
          return;
        }
        const applied = this.poisonRiderContinuation({ target: targetActor, rider: riderEntry.rider,
          receiptId: `poison-${livePending.id}`, savePassed: total >= riderDc });
        if (!applied.ok) {
          this.reject(session, String(msg.messageId), "invariant", applied.error);
          return;
        }
        poisonContinuation = { ops: applied.ops, audit: {
          id: `poison-${livePending.id}`,
          label: `Poison exposure save: ${targetActor.name}`.slice(0, 160),
          system: { userId: session.user.id, requestId: String(msg.messageId),
            action: "exposure-save", targetActorId: targetActor._id, payload: livePending.id ?? "legacy" },
        } };
      }
    }
    const ops: Op[] = [
      {
        kind: "update",
        ref: { coll: "messages", id: String(msg.messageId) },
        diff: pendingDiff,
      },
      { kind: "create", coll: "messages", data: rollMessage },
      { kind: "create", coll: "messages", data: followUp },
      ...(poisonContinuation?.ops ?? []),
    ];
    const committed = this.commitOps(
      ops,
      session.user.id,
      `pending-${String(msg.messageId)}-${livePending.id ?? "legacy"}`,
      false,
      poisonContinuation?.audit,
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
    // Image publication must go through asset.share so the stable slot, visibility and audit gates run.
    if (msg.t === "image") return;
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
      false, undefined, undefined, true,
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
      false, undefined, undefined, true,
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
