/**
 * §13 Message protocol — every message type, with a 1-byte MsgKind prefix in
 * front of a msgpack-encoded payload (§6.1). Wire format:
 *
 *     [u8 MsgKind][msgpack payload]
 *
 * Payloads also carry a string `kind` field (dev sanity + exhaustive-switch
 * decoding). Directions: c→h client→host, h→c host→client, both, internal.
 */
import type { AssetId, DocId, PeerId, TxId, UserId, WorldId } from "./ids";
import type { AssetManifest, Json, Role, RollMode } from "./documents";
import type { Op, OpEnvelope } from "./ops";
import type { ModelColumnType, TurnMode, TurnPhase } from "./strategic";
import type { SimEvent, TurnReport } from "./sim";

export type { RollMode };

/**
 * The 1-byte message-type prefix (§6.1/§13). This map is the
 * single source of truth; PROTOCOL.md is kept in sync by a unit test.
 */
export const MsgKind = {
  // client → host
  hello: 0x01,
  intent: 0x02,
  roll: 0x03,
  ephemeral: 0x04,
  "asset.get": 0x05,
  "fog.put": 0x06,
  "relay.offer": 0x07,
  "turn.ready": 0x08,
  "sim.control": 0x09,
  "report.detail": 0x0a,
  "sim.snapshot.get": 0x0b,
  "audio.cmd": 0x0c,
  "roll.reveal": 0x0d,
  // F01 — tactical roll ledger (reroll / revert / delegate), host-evaluated, 2-round window
  "roll.reroll": 0x30,
  "roll.revert": 0x31,
  "roll.delegate": 0x32,
  // F03 — player pending roll resolution (client → host, host → client commit-reveal)
  "roll.pending": 0x33,
  // §2.2 item 3 (G-20/D-261) — apply a roll card's total to an actor (the amount stays host-side)
  "roll.apply": 0x34,
  // Macros / FX Wizard: authorized run request and recipient-projected timeline
  "fx.request": 0x35,
  "fx.start": 0x36,
  "asset.manifest": 0x37,
  "automation.request": 0x38,
  "automation.trace": 0x39,
  "macro.request": 0x3a,
  "macro.result": 0x3b,
  "automation.click": 0x3c,
  "prefab.place": 0x3d,
  "prefab.result": 0x3e,
  "fx.sync": 0x3f,
  "fx.stop": 0x44,
  "fx.end": 0x45,
  "summon.place": 0x46,
  "summon.dismiss": 0x47,
  "summon.result": 0x48,
  "fx.stopMatching": 0x49,
  "tagger.rules": 0x4a,
  "tagger.rules.result": 0x4b,
  "action.revert": 0x4c,
  // D-250 — explored fog restore: the client asks, the host answers from its fog store
  "fog.get": 0x0e,
  // host → client
  welcome: 0x20,
  snapshot: 0x21,
  ops: 0x22,
  rejected: 0x23,
  "asset.chunk": 0x24,
  clock: 0x25,
  kick: 0x26,
  ban: 0x27,
  "sim.delta": 0x28,
  "sim.snapshot": 0x29,
  "turn.phase": 0x2a,
  "turn.report": 0x2b,
  "report.detail.page": 0x2c,
  "roll.challenge": 0x2d,
  "fog.state": 0x2e,
  // internal / both directions
  heartbeat: 0x40,
  ping: 0x41,
  pong: 0x42,
  "relay.frame": 0x43,
} as const;

export type MsgKind = (typeof MsgKind)[keyof typeof MsgKind];
export type MsgName = keyof typeof MsgKind;

// ─── client → host ────────────────────────────────────────────────────────────

/** §6.4: sig = Sign("vtt:hello:<roomId>:<displayName>:<ts>") with the browser keypair (D-007). */
export interface HelloMsg {
  kind: "hello";
  /** Ed25519/ECDSA public key (hex) — becomes the userId. */
  pubkey: string;
  displayName: string;
  ts: number;
  sig: string;
  /** Reconnect (§5): GM/assistant may receive ops-since-seq; players get fresh
   * recipient-projected snapshots until history-aware delta projection exists. */
  lastSeq?: number;
}

/** §5 flow: intents carry uncommitted ops; host replies ops (commit) or rejected. */
export interface IntentMsg {
  kind: "intent";
  txId: TxId;
  ops: Op[];
}

/** §11: rolls are executed on the host from `roll` intents. */
export interface RollMsg {
  kind: "roll";
  rollId: string;
  formula: string;
  rollData?: Record<string, Json>;
  mode: RollMode;
  /** Whisper targets (§10). */
  to?: UserId[];
  /** Optional breakdown line rendered on the roll card (A06). */
  flavor?: string;
  /** §11 commit-reveal: SHA-256 hex of the client seed (optional path). */
  commit?: string;
}

/**
 * §11 commit-reveal step 2: the host's seed, chosen before the client's
 * seed is known (sent only to the requesting session).
 */
export interface RollChallengeMsg {
  kind: "roll.challenge";
  rollId: string;
  seedHost: string;
}

/** §11 commit-reveal step 3: the client opens its commitment. */
export interface RollRevealMsg {
  kind: "roll.reveal";
  rollId: string;
  seedClient: string;
}

/**
 * F03 — player pending roll resolution (commit-reveal, host-verified).
 * The client sends the pending MessageId and its seed commitment; the host
 * validates the 2-round window + ownership + shouldDefer predicate, reveals
 * with seedHost, evaluates deterministically, and commits
 * [pendingRoll resolved + follow-up + ledgerOps] atomically.
 */
export interface RollPendingMsg {
  kind: "roll.pending";
  messageId: DocId;
  seedClient: string;
  seedClientCommit?: string;
}

/** F01 — GM reroll (or delegated player reroll) of a tactical ledger card, host-evaluated. */
export interface RollRerollMsg {
  kind: "roll.reroll";
  messageId: DocId;
  /** Optional extra modifiers to fold into the reroll (e.g. from the card dropdown). */
  newModifiers?: Array<{ label: string; value: number; reason: string }>;
}

/** F01 — GM revert of a ledger card (inverse of ledgerOps). */
export interface RollRevertMsg {
  kind: "roll.revert";
  messageId: DocId;
}

/**
 * §2.2 item 3 (G-20/D-261) — apply (or heal) a roll card's total to one actor. **The intent carries
 * no number**: the host re-reads `roll.total` from the committed card and refuses the apply unless
 * the sender may update the actor, so a client can ask for a verb but never invent a figure.
 */
export interface RollApplyMsg {
  kind: "roll.apply";
  /** The roll card to apply. */
  messageId: DocId;
  actorId: DocId;
  mode: "damage" | "healing";
}

/** GM-only named Revert of a durable, host-authored world-action receipt. */
export interface ActionRevertMsg {
  kind: "action.revert";
  receiptId: DocId;
}

/** F01 — GM delegates a reroll window to a player (expires in 2 turns). */
export interface RollDelegateMsg {
  kind: "roll.delegate";
  messageId: DocId;
  playerId: UserId;
}

/** GM/assistant-only graph invocation; never send steps, selectors or world operations. */
export interface AutomationRequestMsg {
  kind: "automation.request";
  requestId: string;
  automationId: DocId;
  sceneId: DocId;
  method: import("./automation").AutomationMethod;
  tokenId?: DocId;
  /** GM-only: trace the same plan/preflight without committing or emitting cues. */
  dryRun?: boolean;
}

/** Click a *visible* tile; the client does not know private graph IDs or submit actions.
 * Host checks the rotated hit, scene, publication, optional owned token and dedup. */
export interface AutomationClickMsg {
  kind: "automation.click";
  requestId: string;
  sceneId: DocId;
  tileId: DocId;
  point: { x: number; y: number };
  tokenId?: DocId;
}

/** GM/assistant-only Tagger rule expansion. Send exact, scene-qualified refs,
 * NEVER client-computed ordinals or final tags; the host allocates against live
 * tags in every referenced scene in one authoritative undoable transaction. */
export interface TaggerRulesMsg {
  kind: "tagger.rules";
  requestId: string;
  refs: import("./documents").DocRef[];
}

export interface TaggerRulesResultMsg {
  kind: "tagger.rules.result";
  requestId: string;
  changed: number;
  seq: number;
}

/** GM-only request: host resolves the saved template; no authored ops cross the wire. */
export interface PrefabPlaceMsg {
  kind: "prefab.place";
  requestId: string;
  prefabId: DocId;
  sceneId: DocId;
  at: { x: number; y: number };
  rotation?: number;
  scale?: number;
}

/** GM/assistant-only placement result; players see projected spawned objects, never the template. */
export interface PrefabResultMsg {
  kind: "prefab.result";
  requestId: string;
  ok: boolean;
  detail: string;
  seq?: number;
  instanceId?: string;
  rootId?: DocId;
}

/** Request a GM-published summon by ID at a point; never supply an actor or world op. */
export interface SummonPlaceMsg {
  kind: "summon.place";
  requestId: string;
  presetId: DocId;
  sceneId: DocId;
  at: { x: number; y: number };
  summonerTokenId?: DocId;
}
/** Request dismissal by visible instance token ID; source and actor IDs remain host-private. */
export interface SummonDismissMsg { kind: "summon.dismiss"; requestId: string; sceneId: DocId; tokenId: DocId }
/** Caller-only, source-free status. Other recipients only see projected ops. */
export interface SummonResultMsg {
  kind: "summon.result";
  requestId: string;
  ok: boolean;
  detail: string;
  seq?: number;
  tokenId?: DocId;
}

/** Private diagnostic: only GM/assistant sessions receive graph history/step decisions. */
export interface AutomationTraceMsg {
  kind: "automation.trace";
  automationId: DocId;
  method: import("./automation").AutomationMethod;
  result: "committed" | "skipped" | "rejected" | "post-commit-failed";
  detail: string;
  trace: string[];
  seq?: number;
}

/** A caller supplies ONLY named inputs to a GM-reviewed, revision-pinned saved script. */
export interface MacroRequestMsg {
  kind: "macro.request";
  requestId: string;
  macroId: DocId;
  args: Record<string, Json>;
}

/** Private diagnostic for GMs; players receive only a generic status, never logs/results. */
export interface MacroResultMsg {
  kind: "macro.result";
  requestId: string;
  macroId: DocId;
  callerId: UserId;
  ok: boolean;
  detail: string;
  result?: Json;
  trace?: string[];
}

/** A client asks to run a SAVED macro by ID, never sends arbitrary FX/assets/ops. */
export interface FxRequestMsg {
  kind: "fx.request";
  requestId: string;
  macroId: DocId;
  sceneId: DocId;
  sourceTokenId?: DocId;
  targetTokenId?: DocId;
}

/** Host-stamped, per-viewer projection. Coordinates and media MIME are authoritative. */
export interface FxStartMsg {
  kind: "fx.start";
  runId: string;
  macroId: DocId;
  sceneId: DocId;
  atHostTime: number;
  sections: import("./fx").ResolvedFxSection[];
  /** Instance survives scene switch/reconnect/reload; sections loop until fx.end. */
  persistent?: boolean;
}

/** Request only a recipient-projected, live-instance replay for a visible scene. */
export interface FxSyncMsg { kind: "fx.sync"; sceneId: DocId }
/** Stop a host-owned instance. Owner or GM; unauthorized IDs have a generic error. */
export interface FxStopMsg { kind: "fx.stop"; requestId: string; instanceId: DocId }
/** GM-only bounded scene-local bulk stop. The host re-evaluates the filter; no
 * client-supplied instance IDs or counts are trusted. All deletes share an undo. */
export interface FxStopMatchingMsg { kind: "fx.stopMatching"; requestId: string;
  sceneId: DocId; filter: import("./fxInstances").FxInstanceFilter }
/** Recipient-only revocation/end. Contains no hidden macro/asset/source details. */
export interface FxEndMsg { kind: "fx.end"; runId: string; sceneId: DocId }

/** §5 ephemeral kinds: cursors, pings, drags, ruler, typing. */
export type EphemeralKind = "cursor" | "ping" | "drag" | "ruler" | "typing";

/** §5: never touches the Document Store or OpLog; unreliable channel, ≤ 20 Hz. */
export interface EphemeralMsg {
  kind: "ephemeral";
  from: UserId;
  t: EphemeralKind;
  data: Record<string, Json>;
}

/** §7 lazy asset fetch with resume; priority: current scene > UI > audio > preload. */
export type AssetPriority = "scene" | "ui" | "audio" | "preload";

export interface AssetGetMsg {
  kind: "asset.get";
  assetId: AssetId;
  /** Resume offset in bytes. */
  offset: number;
  priority: AssetPriority;
}

/**
 * §8/§9: the sender's explored-fog map for a scene as a PNG (opaque = unexplored). The host
 * keeps the latest per user + scene and persists it (D-250: `fog` store, world file `fog/`).
 */
export interface FogPutMsg {
  kind: "fog.put";
  sceneId: DocId;
  png: Uint8Array;
}

/** D-250: ask for one's own stored explored map of a scene (answered with `fog.state`). */
export interface FogGetMsg {
  kind: "fog.get";
  sceneId: DocId;
}

/** D-250: the stored explored map for the asking user + scene; `png` null = nothing stored. */
export interface FogStateMsg {
  kind: "fog.state";
  sceneId: DocId;
  png: Uint8Array | null;
}

/** §6.3 (M4): an unreachable player's offer forwarded through a connected peer. */
export interface RelayOfferMsg {
  kind: "relay.offer";
  from: PeerId;
  sdp: string;
}

/** §5A: player toggles turn readiness. */
export interface TurnReadyMsg {
  kind: "turn.ready";
  turnId: DocId;
  ready: boolean;
}

/** §5A/§13: GM sim control. */
export type SimControlAction =
  "pause" | "resume" | "rate" | "advance" | "next" | "undoTurn" | "mode" | "start";

export interface SimControlMsg {
  kind: "sim.control";
  action: SimControlAction;
  /** For action "rate" (Hz). */
  rateHz?: number;
  /** For action "mode" and action "start" (fixed at start, §5A). */
  mode?: TurnMode;
  /** For action "advance": orders-phase deadline (ms epoch), optional. */
  deadlineMs?: number;
}

/** §11: paginated verbose per-model rolls, fetched on demand. */
export interface ReportDetailMsg {
  kind: "report.detail";
  turnId: DocId;
  unitId?: DocId;
  page: number;
}

/** §5A: client detected a delta gap → requests a full snapshot. */
export interface SimSnapshotGetMsg {
  kind: "sim.snapshot.get";
  sceneId: DocId;
}

// ─── host → client ────────────────────────────────────────────────────────────

export interface WelcomeUser {
  id: UserId;
  role: Role;
  name: string;
}

export interface WorldInfo {
  id: WorldId;
  name: string;
  system: string;
  version: string;
}

/**
 * §5A/N01: the host's active strategic battle, announced in every welcome so
 * joiners adopt the schema/scene BEFORE the first sim frame instead of guessing
 * (the old joiner hardcoded mass-battle-basic columns + scene-1 and could not
 * decode a PF1e campaign at all). `schema` is the active package's SysSchema
 * (column name → wire kind); a schema/scene change re-announces and forces the
 * client to drop its replica and pull a fresh snapshot.
 */
export interface WelcomeSimInfo {
  /** The scene whose model pool the sim channel serves. */
  sceneId: DocId;
  /** Active rules columns (SysSchema: name → wire kind). */
  schema: { readonly [name: string]: ModelColumnType };
  /** Active rules package id (null = built-in mass-battle-basic). */
  packageId: string | null;
  /** Active rules version (package version, or the built-in's). */
  version: string;
}

/** §6.4: after approval the client is welcomed, then receives the snapshot. */
export interface WelcomeMsg {
  kind: "welcome";
  user: WelcomeUser;
  world: WorldInfo;
  /** Snapshot follows; client buffers ops with seq > this. */
  snapshotSeq: number;
  /** §5A/N01: the active strategic battle (absent when the host has none). */
  sim?: WelcomeSimInfo;
}

/** §5: projected snapshot — manifest only; assets fetched lazily by hash (§7). */
export interface SnapshotMsg {
  kind: "snapshot";
  seq: number;
  world: import("./projection").ProjectedWorld;
  manifest: AssetManifest;
}

/** Full per-recipient manifest replacement after a publication/entitlement change. No bytes. */
export interface AssetManifestMsg {
  kind: "asset.manifest";
  manifest: AssetManifest;
}

/** §5 commit broadcast: the projected envelope { seq, txId, ops' }. */
export interface OpsMsg {
  kind: "ops";
  envelope: OpEnvelope;
}

export type RejectionReason =
  "forbidden" | "invalid_schema" | "invariant" | "phase_locked" | "rate_limited" | "error";

export interface RejectedMsg {
  kind: "rejected";
  txId: TxId;
  reason: RejectionReason;
  detail: string;
}

export interface AssetChunkMsg {
  kind: "asset.chunk";
  assetId: AssetId;
  offset: number;
  total: number;
  bytes: Uint8Array;
  done: boolean;
}

/** §7 audio sync: host clock broadcast; NTP-style offset from ping/pong. */
export interface ClockMsg {
  kind: "clock";
  hostTime: number;
}

/**
 * §7 audio playback command. Client → host: a GM/ASSISTANT playback request
 * (atHostTime absent — the host stamps it). Host → clients: the broadcast
 * schedule on the host clock; clients start at `atHostTime − clockOffset`.
 */
export interface AudioCmdMsg {
  kind: "audio.cmd";
  playlistId: string;
  soundId: string;
  action: "play" | "stop" | "pause" | "resume";
  /** Host-clock time to start at (host-stamped on rebroadcast). */
  atHostTime?: number;
  /** Playback offset into the sound (seconds). */
  offset: number;
}

export interface KickMsg {
  kind: "kick";
  reason: string;
}

export interface BanMsg {
  kind: "ban";
  reason: string;
}

/** §5A: binary frame; bytes = fflate-compressed msgpack SimDelta (already faction-projected). */
export interface SimDeltaMsg {
  kind: "sim.delta";
  sceneId: DocId;
  from: number;
  to: number;
  bytes: Uint8Array;
}

/** §5A: full compressed pool (late joiners, gap recovery). */
export interface SimSnapshotMsg {
  kind: "sim.snapshot";
  sceneId: DocId;
  version: number;
  bytes: Uint8Array;
}

/** §5A/§13 phase announcements. */
export interface TurnPhaseMsg {
  kind: "turn.phase";
  turnId: DocId;
  phase: TurnPhase;
  deadlineMs: number | null;
  readyUsers: UserId[];
  /** §5A realtime: present when the campaign runs in realtime mode. */
  mode?: TurnMode;
  /** §5A realtime: true while paused (phase reports "orders"). */
  paused?: boolean;
  /** §5A realtime: current sim tick rate (Hz). */
  simHz?: number;
}

/** §5A: the (projected) TurnReport — undetected units stubbed as "unknown enemy". */
export interface TurnReportMsg {
  kind: "turn.report";
  turnId: DocId;
  report: TurnReport;
}

export interface ReportDetailPageMsg {
  kind: "report.detail.page";
  turnId: DocId;
  page: number;
  totalPages: number;
  events: SimEvent[];
}

// ─── internal / both directions ───────────────────────────────────────────────

export interface HeartbeatMsg {
  kind: "heartbeat";
  t: number;
}

/** NTP-style clock sync probes (§7). */
export interface PingMsg {
  kind: "ping";
  t0: number;
}

export interface PongMsg {
  kind: "pong";
  t0: number;
  t1: number;
  t2: number;
}

/** §6.3 (M4): opaque e2e-encrypted frame relayed between host and a peer via a connected player. */
export interface RelayFrameMsg {
  kind: "relay.frame";
  from: import("./ids").PeerId;
  to: import("./ids").PeerId;
  bytes: Uint8Array;
}

// ─── Union ────────────────────────────────────────────────────────────────────

export type WireMessage =
  | HelloMsg
  | IntentMsg
  | RollMsg
  | RollChallengeMsg
  | RollRevealMsg
  | RollPendingMsg
  | RollRerollMsg
  | RollRevertMsg
  | ActionRevertMsg
  | RollDelegateMsg
  | RollApplyMsg
  | AutomationRequestMsg
  | AutomationClickMsg
  | AutomationTraceMsg
  | TaggerRulesMsg
  | TaggerRulesResultMsg
  | PrefabPlaceMsg
  | PrefabResultMsg
  | SummonPlaceMsg
  | SummonDismissMsg
  | SummonResultMsg
  | MacroRequestMsg
  | MacroResultMsg
  | FxRequestMsg
  | FxStartMsg
  | FxSyncMsg
  | FxStopMsg
  | FxStopMatchingMsg
  | FxEndMsg
  | EphemeralMsg
  | AssetGetMsg
  | FogPutMsg
  | FogGetMsg
  | FogStateMsg
  | RelayOfferMsg
  | TurnReadyMsg
  | SimControlMsg
  | ReportDetailMsg
  | SimSnapshotGetMsg
  | AudioCmdMsg
  | WelcomeMsg
  | SnapshotMsg
  | AssetManifestMsg
  | OpsMsg
  | RejectedMsg
  | AssetChunkMsg
  | ClockMsg
  | KickMsg
  | BanMsg
  | SimDeltaMsg
  | SimSnapshotMsg
  | TurnPhaseMsg
  | TurnReportMsg
  | ReportDetailPageMsg
  | HeartbeatMsg
  | PingMsg
  | PongMsg
  | RelayFrameMsg;
