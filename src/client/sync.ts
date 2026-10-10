/**
 * §5 ClientSync — the client-side sync endpoint.
 *
 * - tracks lastSeq; reconnects send it (hello.lastSeq, D-031). GM/assistant
 *   can receive ops-since; players receive a fresh projected snapshot;
 * - applies committed envelopes strictly in seq order, buffering gaps
 *   (late join: ops with seq > snapshot.seq apply after the snapshot, §14);
 * - optimistic UI (§5): latency-sensitive ops apply locally to an overlay
 *   echo store; commit reconciles (drop pending), rejected rolls back.
 */
import { DocumentStore, type StoreMeta } from "../core/store";
import { estimateClockOffset, type ClockSample } from "../core/audio";
import type { Op, OpEnvelope } from "../core/ops";
import type { AssetChunkMsg, AssetPriority, AssetUploadResultMsg, AssetShareResultMsg, AudioCmdMsg, ClockMsg, EphemeralKind, EphemeralMsg, FxStartMsg, FxRunMsg, FxEndMsg, FxDeliveryMsg, FxMediaAckState, AutomationTraceMsg, TaggerRulesResultMsg, PrefabResultMsg, SummonResultMsg, MacroResultMsg, FogStateMsg, HelloMsg, PongMsg, RollChallengeMsg, OpsMsg, RejectedMsg, PF1ePoisonActionRequest, PF1eConditionActionRequest, PF1eConditionActionResultMsg, CodexPurchaseResultMsg, RollMode, SimControlAction, SimDeltaMsg, SimSnapshotMsg, SnapshotMsg, TurnPhaseMsg, TurnReportMsg, WelcomeMsg, WelcomeSimInfo, WireMessage, AssetLibraryResultMsg, AssetCleanupResultMsg, AssetLibraryMsg, AssetCleanupMsg } from "../core/messages";
import type { AssetManifest, Json } from "../core/documents";
import { assertImageByteLength } from "../core/imageSizing";
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
import type { FxInstanceFilter } from "../core/fxInstances";
import type { PlayerMacroDraft } from "../core/playerMacros";
import type { TagRef } from "../core/tags";
import type { SysSchema } from "../sim/pool";
import type { RollHighlightRequest } from "./rollHighlight";
import { applySimDelta, decodeSimDelta, decodeSimSnapshot, poolFromSnapshot } from "../sim/codec";

export interface ClientEvents {
  welcome: { user: { id: UserId; role: Role; name: string }; world: WelcomeMsg["world"] };
  snapshot: { seq: number };
  assetManifest: AssetManifest;
  ops: { envelope: OpEnvelope; reconciled: TxId | null };
  rejected: { txId: TxId; reason: RejectedMsg["reason"]; detail: string };
  ephemeral: EphemeralMsg;
  kick: { reason: string };
  /** §7: one chunk of a streamed asset (AssetFetcher consumes these). */
  asset: AssetChunkMsg;
  /** Host-authorized image upload progress/results. */
  assetUpload: AssetUploadResultMsg;
  /** Host-authorized image share-slot result. */
  assetShare: AssetShareResultMsg;
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
  /** A host-approved timeline for this viewer only (not an ephemeral relay). */
  fx: FxStartMsg;
  /** Private requester acknowledgement for exact-run cancellation controls. */
  fxRun: FxRunMsg;
  /** Only a recipient of a cue receives its end/revocation. */
  fxEnd: FxEndMsg;
  fxDelivery: FxDeliveryMsg;
  /** GM-only tile/zone execution diagnostics. */
  automationTrace: AutomationTraceMsg;
  /** Host-allocated Tagger rules on exact scene or world-document refs (GM/assistant only). */
  taggerRulesResult: TaggerRulesResultMsg;
  /** Host-validated keyed condition application/removal committed with a private Revert receipt. */
  conditionActionResult: PF1eConditionActionResultMsg;
  /** Private result for a host-validated Campaign Codex purchase or loot claim. */
  codexPurchaseResult: CodexPurchaseResultMsg;
  /** Host-validated atomic prefab placement (GM only). */
  prefabResult: PrefabResultMsg;
  /** Source-free host result for an authorized summon or dismissal. */
  summonResult: SummonResultMsg;
  /** A completed GM-reviewed macro; non-GM results omit logs and returned data. */
  macroResult: MacroResultMsg;
  /** F01/F03: a chat roll-card link asks the canvas to center + outline. */
  rollHighlight: RollHighlightRequest;
  /** D-250: the host's answer to `requestFog` (also resolves the pending promise). */
  fogState: FogStateMsg;
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

/** N01: column-map equality (name → wire kind), order-independent. */
function sameSimSchema(
  a: { readonly [name: string]: unknown },
  b: { readonly [name: string]: unknown },
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export interface ClientImageUploadOptions {
  name: string;
  displayName: string;
  folder: string;
  sourceKind: "file" | "paste" | "url";
  collisionBehavior: "stop" | "reuse" | "overwrite";
  convertToWebp: boolean;
  webpQuality: number;
}

type AssetUploadWaiter = {
  predicate: (result: AssetUploadResultMsg) => boolean;
  resolve: (result: AssetUploadResultMsg) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

/** One stored image as the GM library shows it (§6.8). */
export type AssetLibraryItem = NonNullable<AssetLibraryResultMsg["assets"]>[number];

export class ClientSync {
  /** §11 pending client seeds, keyed by committed rollId. */
  private readonly committedRolls = new Map<string, string>();
  /** D-250: `requestFog` waiters per sceneId. */
  private readonly fogWaiters = new Map<DocId, Array<(png: Uint8Array | null) => void>>();
  private readonly assetUploadWaiters = new Map<string, Set<AssetUploadWaiter>>();
  private readonly assetHostWaiters = new Map<string, { resolve: (msg: AssetLibraryResultMsg | AssetCleanupResultMsg) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly assetShareWaiters = new Map<string, { resolve: (msg: AssetShareResultMsg) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly store: DocumentStore;
  private echoImpl: DocumentStore;
  private transport: Transport;
  private readonly bus: EventBus<ClientEvents>;
  /** §5A: the retained last turn report (see `lastTurnReport`). */
  private lastTurnReportMsg: TurnReportMsg | null = null;
  private readonly policy: OptimisticPolicy;
  private readonly now: () => number;
  private readonly ephemeralBucket: TokenBucket;
  private simSys: SysSchema | null;
  private simSceneId: DocId | null;
  /** §5A/N01: the host-announced battle adopted from the welcome (if any). */
  private simAnnounce: WelcomeSimInfo | null = null;

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
   * and pending intents. The hello carries lastSeq; host uses ops-since only
   * for trusted roles, and a projected snapshot for players (§5, D-031).
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
    this.sendIntent(txId, ops);
    return txId;
  }

  /** Submit and wait until the host commits this transaction or explicitly rejects it. */
  submitAndWait(ops: Op[], timeoutMs = 30_000): Promise<TxId> {
    const txId = globalThis.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      let offOps: () => void = () => {};
      let offRejected: () => void = () => {};
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offOps();
        offRejected();
        settle();
      };
      offOps = this.bus.on("ops", ({ envelope }) => {
        if (envelope.txId === txId) finish(() => resolve(txId));
      });
      offRejected = this.bus.on("rejected", ({ txId: rejectedId, reason, detail }) => {
        if (rejectedId === txId) finish(() => reject(new Error(`${reason}: ${detail}`)));
      });
      const timer = setTimeout(() => {
        // Drop the optimistic echo for an intent the host never answered. A late commit still
        // lands through applyCommitted; a late rejection only emits, so nothing is left stuck.
        if (settled) return;
        this.pending.delete(txId);
        this.inFlight.delete(txId);
        this.rebuildEcho();
        finish(() => reject(new Error("The host did not acknowledge this image action in time.")));
      }, timeoutMs);
      try {
        this.sendIntent(txId, ops);
      } catch (error) {
        this.pending.delete(txId);
        this.inFlight.delete(txId);
        this.rebuildEcho();
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  private sendIntent(txId: TxId, ops: Op[]): void {
    this.inFlight.add(txId);
    const optimistic = ops.filter((op) => this.policy(op));
    if (optimistic.length > 0) {
      this.pending.set(txId, optimistic);
      this.rebuildEcho();
    }
    this.send({ kind: "intent", txId, ops });
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

  /**
   * SQ-13/D-308: one viewer's answer about one asset of a cue it was sent — the bytes are
   * in hand, they arrived late, or this device could not use them. No user, URL or asset
   * name travels: the host matches the asset against the cue it fanned out to *this*
   * session and turns the answers into one line for the requester.
   */
  reportFxMedia(ack: { runId: string; assetId: string; state: FxMediaAckState;
    reason?: "fetch" | "decode"; ms?: number }): void {
    this.send({ kind: "fx.media", ...ack });
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

  roll(
    formula: string,
    mode: RollMode = "roll",
    to?: UserId[],
    flavor?: string,
  ): string {
    const rollId = globalThis.crypto.randomUUID();
    this.send({
      kind: "roll",
      rollId,
      formula,
      mode,
      ...(to ? { to } : {}),
      ...(flavor !== undefined && flavor !== "" ? { flavor } : {}),
    });
    return rollId;
  }

  /**
   * §11 commit-reveal roll: commits H(seed_c), auto-answers the host
   * challenge with the reveal. Falls back to a plain roll when crypto is
   * unavailable — chat never blocks.
   */
  async rollVerified(
    formula: string,
    mode: RollMode = "roll",
    to?: UserId[],
    flavor?: string,
  ): Promise<string> {
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
    this.send({
      kind: "roll",
      rollId,
      formula,
      mode,
      commit,
      ...(to ? { to } : {}),
      ...(flavor !== undefined && flavor !== "" ? { flavor } : {}),
    });
    return rollId;
  }

  /**
   * F03 — pending player reaction roll (commit-reveal, host-verified).
   * The pending MessageId is the shell card; the host validates the 2-round
   * window + ownership + shouldDefer predicate and evaluates deterministically
   * from both seeds. Falls back to a plain pending resolve when crypto is
   * unavailable — chat never blocks.
   */
  async rollPending(messageId: DocId, pendingId?: string): Promise<string> {
    let seedClient: string;
    let commit: string;
    try {
      seedClient = randomSeedHex();
      commit = await sha256Hex(seedClient);
    } catch {
      // fallback to uncommitted seed — host will still accept without commit
      seedClient = randomSeedHex();
      commit = "";
    }
    this.send({
      kind: "roll.pending",
      messageId,
      ...(pendingId !== undefined ? { pendingId } : {}),
      seedClient,
      ...(commit ? { seedClientCommit: commit } : {}),
    });
    return seedClient;
  }

  /** F01 — GM reroll or delegated player reroll (host-evaluated, 2-round window). */
  rollReroll(messageId: DocId, newModifiers?: Array<{ label: string; value: number; reason: string }>): void {
    this.send({
      kind: "roll.reroll",
      messageId,
      ...(newModifiers ? { newModifiers } : {}),
    });
  }

  /**
   * §2.2 item 3 (G-20/D-261) — ask the host to apply this card's total to `actorId`. No amount
   * travels: the host owns the number (and the permission check).
   */
  rollApply(messageId: DocId, actorId: DocId, mode: "damage" | "healing"): void {
    this.send({ kind: "roll.apply", messageId, actorId, mode });
  }

  /** F01 — GM revert (inverse of ledgerOps). */
  rollRevert(messageId: DocId): void {
    this.send({ kind: "roll.revert", messageId });
  }

  /** Ask the host to check and reverse one durable world-action receipt. */
  actionRevert(receiptId: DocId): void {
    this.send({ kind: "action.revert", receiptId });
  }

  /** Submit a Codex purchase by identifiers only; prices and generated Ops stay host-authoritative. */
  requestCodexPurchase(sheetId: DocId, stockRowId: string, quantity: number, actorId: DocId, requestId?: string): string {
    const id = requestId ?? globalThis.crypto.randomUUID();
    this.send({ kind: "codex.purchase", requestId: id, sheetId, stockRowId, quantity, actorId });
    return id;
  }

  /** Ask the host to claim a loot-mode stock row to an owned actor without charging currency. */
  requestCodexClaim(
    sheetId: DocId,
    stockRowId: string,
    quantity: number,
    actorId: DocId,
    requestId?: string,
  ): string {
    const id = requestId ?? globalThis.crypto.randomUUID();
    this.send({ kind: "codex.claim", requestId: id, sheetId, stockRowId, quantity, actorId });
    return id;
  }

  /** Ask HostSync to resolve one Core PF1e poison operation; mechanics/results never travel here. */
  requestPF1ePoisonAction(request: PF1ePoisonActionRequest): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "pf1e.poison", requestId, ...request });
    return requestId;
  }

  /**
   * Ask HostSync to apply or remove one keyed condition instance with a named GM Revert receipt.
   * `requestId` may be supplied by a producer that needs its retry to be idempotent (D-407's
   * spell-effect delivery derives it from the card and the condition).
   */
  requestPF1eConditionAction(request: PF1eConditionActionRequest, requestId?: string): string {
    const id = requestId ?? globalThis.crypto.randomUUID();
    this.send({ kind: "pf1e.condition", requestId: id, ...request });
    return id;
  }

  /** F01 — GM delegates reroll window to a player (expires in 2 turns). */
  rollDelegate(messageId: DocId, playerId: UserId): void {
    this.send({ kind: "roll.delegate", messageId, playerId });
  }

  /** GM/assistant-only graph invocation and dry-run; players must click the visible tile below. */
  requestAutomation(automationId: DocId, sceneId: DocId, method: import("../core/automation").AutomationMethod, tokenId?: DocId, dryRun = false): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "automation.request", requestId, automationId, sceneId, method,
      ...(tokenId ? { tokenId } : {}), ...(dryRun ? { dryRun: true } : {}) });
    return requestId;
  }

  /** Request host-allocated, atomic placement of a saved GM prefab. */
  requestPrefabPlace(prefabId: DocId, sceneId: DocId, at: { x: number; y: number }, rotation = 0, scale = 1): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "prefab.place", requestId, prefabId, sceneId, at, rotation, scale });
    return requestId;
  }

  /** Request a published summon; source/actor fields never leave the host. */
  requestSummonPlace(presetId: DocId, sceneId: DocId, at: { x: number; y: number }, summonerTokenId?: DocId): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "summon.place", requestId, presetId, sceneId, at,
      ...(summonerTokenId ? { summonerTokenId } : {}) });
    return requestId;
  }

  /** Expand existing {#}/{id} templates on live scene/world documents; GM/assistant only. */
  requestTagRules(refs: TagRef[]): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "tagger.rules", requestId, refs });
    return requestId;
  }

  /** Caller may dismiss their instance; GM/assistant may dismiss any. */
  requestSummonDismiss(sceneId: DocId, tokenId: DocId): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "summon.dismiss", requestId, sceneId, tokenId });
    return requestId;
  }

  /** Canvas pointer event names a visible tile, never a GM-only graph ID or step. */
  requestAutomationTileTrigger(sceneId: DocId, tileId: DocId, point: { x: number; y: number }, tokenId?: DocId,
    method: import("../core/automation").AutomationPointerMethod = "click"): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "automation.click", requestId, sceneId, tileId, point, method,
      ...(tokenId ? { tokenId } : {}) });
    return requestId;
  }

  /** @deprecated Use requestAutomationTileTrigger for new canvas event methods. */
  requestAutomationClick(sceneId: DocId, tileId: DocId, point: { x: number; y: number }, tokenId?: DocId,
    method: import("../core/automation").AutomationPointerMethod = "click"): string {
    return this.requestAutomationTileTrigger(sceneId, tileId, point, tokenId, method);
  }

  /**
   * TR-12: a journal page's `@Tile[…]{}` link. Names the page and the link's ordinal in
   * the text this client received — never a tile, region or graph id; the host re-reads
   * the page and resolves the anchor for this caller.
   */
  requestJournalTrigger(journalId: DocId, pageId: DocId, index: number): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "journal.trigger", requestId, journalId, pageId, index });
    return requestId;
  }

  /** Execute a published, revision-pinned script by ID; no code/grants/ops cross the wire. */
  requestMacro(macroId: DocId, args: Record<string, Json> = {}): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "macro.request", requestId, macroId, args });
    return requestId;
  }

  /** TR-12/MC-01: run a saved automation macro. Only the macro id travels — the host
   * resolves its private graph binding and re-validates publication. */
  invokeMacro(macroId: DocId, args?: Record<string, Json>): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "macros.invoke", requestId, macroId,
      ...(args && Object.keys(args).length > 0 ? { args } : {}) });
    return requestId;
  }

  /** D-394: ask to store personal content in the host world; no grants or ownership supplied. */
  saveWorldMacro(macroId: DocId, draft: PlayerMacroDraft): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "macros.save", requestId, macroId, action: "save", draft });
    return requestId;
  }

  deleteWorldMacro(macroId: DocId): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "macros.save", requestId, macroId, action: "delete" });
    return requestId;
  }

  /** Request a host-approved saved sequence. No client-authored cue or audience travels. */
  requestSequence(macroId: DocId, sceneId: DocId, sourceTokenId?: DocId, targetTokenId?: DocId): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "fx.request", requestId, macroId, sceneId,
      ...(sourceTokenId ? { sourceTokenId } : {}),
      ...(targetTokenId ? { targetTokenId } : {}),
    });
    return requestId;
  }

  /** Replay only live persistent instances entitled to this user and scene. */
  requestFxSync(sceneId: DocId): void {
    this.send({ kind: "fx.sync", sceneId });
  }

  /** Stop an owned active run (finite or persistent), or any active run as GM/assistant. */
  requestFxStop(instanceId: DocId): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "fx.stop", requestId, instanceId });
    return requestId;
  }

  /** GM-only live scene filter, with one authoritative transaction/undo. */
  requestFxStopMatching(sceneId: DocId, filter: FxInstanceFilter): string {
    const requestId = globalThis.crypto.randomUUID();
    this.send({ kind: "fx.stopMatching", requestId, sceneId, filter });
    return requestId;
  }

  /** §7: lazy asset fetch with resume; answered by asset.chunk frames. */
  requestAsset(assetId: AssetId, priority: AssetPriority = "scene", offset = 0): void {
    this.send({ kind: "asset.get", assetId, offset, priority });
  }

  /**
   * Upload through the host's role/quota/format gate. Reliable 24 KiB chunks are acknowledged in
   * 1 MiB windows to respect WebRTC DataChannel backpressure and keep the in-memory request bounded.
   */
  async uploadImageAsset(bytes: Uint8Array, options: ClientImageUploadOptions): Promise<NonNullable<AssetUploadResultMsg["asset"]>> {
    if (!this.user || !["GM", "ASSISTANT", "TRUSTED"].includes(this.user.role))
      throw new Error("Only a GM-granted Trusted player may persist an image");
    assertImageByteLength(bytes.byteLength);
    const uploadId = globalThis.crypto.randomUUID();
    let started = false;
    try {
      const readyWait = this.waitForAssetUpload(uploadId, (msg) => msg.status === "ready" || msg.status === "error", 30_000);
      this.send({
        kind: "asset.upload.start", uploadId, name: options.name, displayName: options.displayName, size: bytes.byteLength,
        folder: options.folder, sourceKind: options.sourceKind,
        collisionBehavior: options.collisionBehavior,
        convertToWebp: options.convertToWebp, webpQuality: options.webpQuality,
      });
      const ready = await readyWait;
      if (ready.status === "error") throw new Error(ready.error ?? "The host rejected this image upload");
      started = true;
      const chunkSize = 24 * 1024;
      const ackWindow = 1024 * 1024;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const checkpoint = Math.min(bytes.byteLength, Math.ceil((offset + 1) / ackWindow) * ackWindow);
        const ack = checkpoint < bytes.byteLength
          ? this.waitForAssetUpload(uploadId, (msg) => msg.status === "error" || (msg.status === "progress" && msg.received >= checkpoint), 120_000)
          : null;
        while (offset < checkpoint) {
          const end = Math.min(checkpoint, offset + chunkSize);
          this.send({ kind: "asset.upload.chunk", uploadId, offset, bytes: bytes.slice(offset, end) });
          offset = end;
        }
        if (ack) {
          const result = await ack;
          if (result.status === "error") throw new Error(result.error ?? "The host stopped this image upload");
        }
      }
      const completeWait = this.waitForAssetUpload(uploadId, (msg) => msg.status === "complete" || msg.status === "error", 180_000);
      this.send({ kind: "asset.upload.finish", uploadId });
      const completed = await completeWait;
      if (completed.status === "error" || !completed.asset)
        throw new Error(completed.error ?? "The host could not finish this image upload");
      return completed.asset;
    } catch (error) {
      if (started) {
        try { this.send({ kind: "asset.upload.cancel", uploadId }); } catch { /* connection may already be closed */ }
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Publish this user's current share slot; the host commits the durable mapping before broadcasting. */
  shareImageToPlayers(assetId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/i.test(assetId)) return Promise.reject(new Error("Invalid image asset reference"));
    const requestId = globalThis.crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.assetShareWaiters.delete(requestId);
        reject(new Error("The host did not acknowledge the image share"));
      }, 30_000);
      this.assetShareWaiters.set(requestId, { resolve: (msg) => {
        globalThis.clearTimeout(timer);
        if (msg.ok) resolve(); else reject(new Error(msg.error ?? "The host refused this image share"));
      }, reject, timer });
      try { this.send({ kind: "asset.share", requestId, assetId: assetId as AssetId }); }
      catch (error) {
        globalThis.clearTimeout(timer);
        this.assetShareWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** §6.8 GM-only: every stored image with whether undo or a live document still uses it. */
  async requestAssetLibrary(): Promise<AssetLibraryItem[]> {
    const msg = await this.requestAssetHost((requestId) => ({ kind: "asset.library", requestId }), 30_000);
    if (msg.kind !== "asset.library.result" || !msg.ok) throw new Error(msg.error ?? "The host could not list stored images");
    return msg.assets ?? [];
  }

  /** §6.8 GM-only: delete the unused images among `hashes`. Anything the host finds in use is skipped. */
  async requestAssetCleanup(hashes: AssetId[]): Promise<{ removed: AssetId[]; skipped: AssetId[]; bytes: number }> {
    const msg = await this.requestAssetHost((requestId) => ({ kind: "asset.cleanup", requestId, hashes }), 120_000);
    if (msg.kind !== "asset.cleanup.result" || !msg.ok) throw new Error(msg.error ?? "The host could not clean up stored images");
    return { removed: msg.removed ?? [], skipped: msg.skipped ?? [], bytes: msg.bytes ?? 0 };
  }

  private requestAssetHost(
    build: (requestId: string) => AssetLibraryMsg | AssetCleanupMsg,
    timeoutMs: number,
  ): Promise<AssetLibraryResultMsg | AssetCleanupResultMsg> {
    const requestId = globalThis.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.assetHostWaiters.delete(requestId);
        reject(new Error("The host did not answer the image request"));
      }, timeoutMs);
      this.assetHostWaiters.set(requestId, { resolve, reject, timer });
      try { this.send(build(requestId)); }
      catch (error) {
        globalThis.clearTimeout(timer);
        this.assetHostWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolveAssetHost(msg: AssetLibraryResultMsg | AssetCleanupResultMsg): void {
    const waiter = this.assetHostWaiters.get(msg.requestId);
    if (!waiter) return;
    this.assetHostWaiters.delete(msg.requestId);
    globalThis.clearTimeout(waiter.timer);
    waiter.resolve(msg);
  }

  private waitForAssetUpload(
    uploadId: string,
    predicate: (msg: AssetUploadResultMsg) => boolean,
    timeoutMs: number,
  ): Promise<AssetUploadResultMsg> {
    return new Promise((resolve, reject) => {
      const waiter: AssetUploadWaiter = {
        predicate, resolve, reject,
        timer: globalThis.setTimeout(() => {
          const waiters = this.assetUploadWaiters.get(uploadId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) this.assetUploadWaiters.delete(uploadId);
          reject(new Error("Timed out waiting for the host image-upload service"));
        }, timeoutMs),
      };
      const waiters = this.assetUploadWaiters.get(uploadId) ?? new Set<AssetUploadWaiter>();
      waiters.add(waiter);
      this.assetUploadWaiters.set(uploadId, waiters);
    });
  }

  private receiveAssetUpload(result: AssetUploadResultMsg): void {
    this.bus.emit("assetUpload", result);
    const waiters = this.assetUploadWaiters.get(result.uploadId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result)) continue;
      globalThis.clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
    if (waiters.size === 0) this.assetUploadWaiters.delete(result.uploadId);
  }

  sendEphemeral(t: EphemeralKind, data: Record<string, Json>): void {
    if (!this.ephemeralBucket.tryRemove()) return; // client-side pre-limit (§5)
    const msg: EphemeralMsg = { kind: "ephemeral", from: this.user?.id ?? "anonymous", t, data };
    this.send(msg);
  }

  close(): void {
    this.transport.close();
    // nothing more can arrive: release fog restores as "nothing stored"
    for (const waiters of this.fogWaiters.values()) for (const w of waiters) w(null);
    this.fogWaiters.clear();
    for (const waiters of this.assetUploadWaiters.values()) for (const waiter of waiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(new Error("The connection closed during image upload"));
    }
    this.assetUploadWaiters.clear();
    for (const waiter of this.assetShareWaiters.values()) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(new Error("The connection closed during image share"));
    }
    this.assetShareWaiters.clear();
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
        // §5A/N01: adopt the host-announced battle (schema/scene) before any
        // sim frame is applied — joiners never guess columns or scene ids.
        if (msg.sim) this.adoptSimInfo(msg.sim);
        this.bus.emit("welcome", { user: msg.user, world: msg.world });
        return;
      case "snapshot":
        this.applySnapshot(msg);
        return;
      case "asset.manifest":
        this.store.replaceAssetManifest(msg.manifest);
        this.echoImpl.replaceAssetManifest(msg.manifest);
        this.bus.emit("assetManifest", msg.manifest);
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
      case "fx.start":
        this.bus.emit("fx", msg);
        return;
      case "fx.run":
        this.bus.emit("fxRun", msg);
        return;
      case "fx.end":
        this.bus.emit("fxEnd", msg);
        return;
      case "fx.delivery":
        this.bus.emit("fxDelivery", msg);
        return;
      case "automation.trace":
        this.bus.emit("automationTrace", msg);
        return;
      case "tagger.rules.result":
        this.bus.emit("taggerRulesResult", msg);
        return;
      case "pf1e.condition.result":
        this.bus.emit("conditionActionResult", msg);
        return;
      case "codex.purchase.result":
        this.bus.emit("codexPurchaseResult", msg);
        return;
      case "prefab.result":
        this.bus.emit("prefabResult", msg);
        return;
      case "summon.result":
        this.bus.emit("summonResult", msg);
        return;
      case "macro.result":
        this.bus.emit("macroResult", msg);
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
      case "automation.request":
      case "tagger.rules":
      case "prefab.place":
      case "macro.request":
      case "macros.invoke":
      case "macros.save":
      case "fx.request":
      case "fx.sync":
      case "fx.stop":
      case "fx.stopMatching":
      case "asset.get":
      case "asset.upload.start":
      case "asset.upload.chunk":
      case "asset.upload.finish":
      case "asset.upload.cancel":
      case "asset.share":
      case "fog.put":
      case "fog.get":
      case "relay.offer":
      case "turn.ready":
      case "sim.control":
      case "report.detail":
      case "sim.snapshot.get":
        return; // client→host kinds and later-milestone kinds are never received here
      case "fog.state": {
        const waiters = this.fogWaiters.get(msg.sceneId) ?? [];
        this.fogWaiters.delete(msg.sceneId);
        for (const w of waiters) w(msg.png);
        this.bus.emit("fogState", msg);
        return;
      }
      case "asset.chunk":
        this.bus.emit("asset", msg);
        return;
      case "asset.upload.result":
        this.receiveAssetUpload(msg);
        return;
      case "asset.library.result":
      case "asset.cleanup.result":
        this.resolveAssetHost(msg);
        return;
      case "asset.share.result": {
        this.bus.emit("assetShare", msg);
        const waiter = this.assetShareWaiters.get(msg.requestId);
        if (waiter) {
          this.assetShareWaiters.delete(msg.requestId);
          globalThis.clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
        return;
      }
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
        // Retained as well as emitted (D-287): a bus event is a moment, and a reader that was not
        // listening at that moment — an agent asked "what happened?" after the fact — has nothing
        // to read. The report is the turn's own record, so keeping the last one is not state the
        // client invented.
        this.lastTurnReportMsg = msg;
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
  /** §5A: the last turn report this replica received; null until the first turn is resolved. */
  get lastTurnReport(): TurnReportMsg | null {
    return this.lastTurnReportMsg;
  }

  get simReplica(): ModelPool | null {
    return this.simPool;
  }

  get simReplicaVersion(): number {
    return this.simVersion;
  }

  /** §5A/N01: the battle adopted from the host's welcome (null = none seen). */
  get simInfo(): WelcomeSimInfo | null {
    return this.simAnnounce;
  }

  /**
   * §5A/N01 — adopt a welcome-announced battle. First adoption overrides any
   * constructor guess (wrong schema/scene replicas are discarded); a changed
   * re-announcement (package switch) resets the replica and re-pulls a
   * snapshot, so the next frame is always decoded with the current schema.
   * Re-announcing the same info is a no-op (reconnects stay seamless).
   */
  private adoptSimInfo(info: WelcomeSimInfo): void {
    const announcedBefore = this.simAnnounce;
    const sameAsAnnounced =
      announcedBefore !== null &&
      announcedBefore.sceneId === info.sceneId &&
      announcedBefore.packageId === info.packageId &&
      announcedBefore.version === info.version &&
      sameSimSchema(announcedBefore.schema, info.schema);
    const matchesCurrent =
      this.simSys !== null &&
      sameSimSchema(this.simSys, info.schema) &&
      this.simSceneId === info.sceneId;
    this.simAnnounce = info;
    if (sameAsAnnounced && matchesCurrent) return; // idempotent reconnect
    if (matchesCurrent && announcedBefore === null) return; // constructor already right
    // Schema and/or scene changed (or the constructor guess was wrong): drop
    // anything decoded under the old shape and re-sync from a full snapshot.
    this.simSys = info.schema;
    this.simSceneId = info.sceneId;
    this.simPool = null;
    this.simVersion = -1;
    this.pendingDeltas = [];
    this.snapshotInFlight = false;
    // In-flight dedup (same semantics as the gap path): the host's snapshot
    // reply clears the flag; pre-start no-ops are followed by the start()
    // broadcast, so the request can never wedge.
    this.snapshotInFlight = true;
    this.requestSimSnapshot();
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
   * §8/§9 fog explored-map upload (PNG readback of the fog texture). The host keeps it per
   * user + scene, persists it and hands it back through `requestFog` (D-250).
   */
  sendFogPng(sceneId: DocId, png: Uint8Array): void {
    this.send({ kind: "fog.put", sceneId, png });
  }

  /**
   * D-250: this user's stored explored map for a scene — null when nothing is stored or the
   * connection closes first. Concurrent requests for one scene share the answer.
   */
  requestFog(sceneId: DocId): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const waiters = this.fogWaiters.get(sceneId);
      if (waiters) {
        waiters.push(resolve);
        return;
      }
      this.fogWaiters.set(sceneId, [resolve]);
      this.send({ kind: "fog.get", sceneId });
    });
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
    // The manifest is a separately projected snapshot field, not part of
    // `world.collections`. Keep the replica's MIME/variants in sync with the
    // same viewer entitlement decision that gates asset.get on the host.
    this.store.hydrate({ ...msg.world.collections, assetManifest: msg.manifest }, msg.seq);
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
