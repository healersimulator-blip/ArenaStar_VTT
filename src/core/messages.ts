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
 * The 1-byte message-type prefix (§6.1/§13). 28 kinds — this map is the
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
  /** Reconnect (§5): the client's lastSeq — host replies ops-since-seq instead
   * of a full snapshot when the log still covers it (D-031). */
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

/** §8/§9: fog explored-texture downscaled PNG readback, per user + scene. */
export interface FogPutMsg {
  kind: "fog.put";
  sceneId: DocId;
  png: Uint8Array;
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
  | EphemeralMsg
  | AssetGetMsg
  | FogPutMsg
  | RelayOfferMsg
  | TurnReadyMsg
  | SimControlMsg
  | ReportDetailMsg
  | SimSnapshotGetMsg
  | AudioCmdMsg
  | WelcomeMsg
  | SnapshotMsg
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
