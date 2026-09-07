# PROTOCOL — message reference (§13)

Single source of truth for kinds/bytes: `src/core/messages.ts` (`MsgKind`).
A unit test cross-checks this file against that map — **keep both in sync**.

## Framing (§6.1)

```
frame := [u8 MsgKind][msgpack payload]
```

- Encoding: MessagePack (`@msgpack/msgpack`) with the 1-byte type prefix.
- Channels (§6.1), four per peer:

| channel     | reliability                   | carries                                                        |
| ----------- | ----------------------------- | -------------------------------------------------------------- |
| `ops`       | reliable + ordered            | hello/welcome/snapshot/ops/rejected/roll/chat/control/kick/ban |
| `ephemeral` | unreliable, maxRetransmits: 0 | ephemeral (cursors, pings, drags, ruler, typing) ≤ 20 Hz       |
| `assets`    | reliable + ordered            | asset.get / asset.chunk (16–64 KB chunks, backpressure)        |
| `sim`       | reliable + ordered            | sim.delta / sim.snapshot / turn.report (backpressure-aware)    |

- Ephemeral traffic never touches the Document Store or OpLog (§5).
- Binary fields (`Uint8Array`) ride inside the msgpack payload (bin type).
- sim.delta / sim.snapshot `bytes` = fflate-compressed, msgpack-framed
  SimDelta/SimSnapshot per §5A (RLE changed-index runs, quantized values).

## Messages

### hello (0x01 · client → host · ops)

Ed25519/ECDSA pubkey identity; `sig = Sign("vtt:hello:<roomId>:<displayName>:<ts>")` (§6.4, D-007).

```ts
interface HelloMsg {
  kind: "hello";
  pubkey: string;
  displayName: string;
  ts: number;
  sig: string;
  lastSeq?: number; // reconnect: highest seq the client already has → ops-since-seq catch-up (D-031)
}
```

### intent (0x02 · client → host · ops)

Transaction proposal; host validates (permissions, JSON-schema, invariants), applies with seq++, appends to OpLog, projects, broadcasts `ops` or `rejected` (§5).

```ts
interface IntentMsg {
  kind: "intent";
  txId: TxId;
  ops: Op[];
}
```

### roll (0x03 · client → host · ops)

Rolls execute on the host (§11).

```ts
type RollMode = "roll" | "gmroll" | "blindroll" | "selfroll";
interface RollMsg {
  kind: "roll";
  rollId: string;
  formula: string;
  rollData?: Record<string, Json>;
  mode: RollMode;
  to?: UserId[];
}
```

### roll.reveal (0x0d · client → host · ops)

§11 commit-reveal step 3: the client opens its commitment (seed_c) for a
pending committed roll; the host verifies SHA-256(seed_c) against the
recorded commitment before resolving the roll deterministically from both
seeds.

```ts
interface RollRevealMsg {
  kind: "roll.reveal";
  rollId: string;
  seedClient: string;
}
```

### roll.challenge (0x2d · host → client · ops)

§11 commit-reveal step 2: the host's seed (seed_h), chosen and sent BEFORE
the client reveals its own — a malicious host cannot grind the outcome.
Sent only to the session that issued the committed roll.

```ts
interface RollChallengeMsg {
  kind: "roll.challenge";
  rollId: string;
  seedHost: string;
}
```

### ephemeral (0x04 · both · ephemeral)

Never persisted, rate-limited 20 Hz per peer (§5).

```ts
type EphemeralKind = "cursor" | "ping" | "drag" | "ruler" | "typing";
interface EphemeralMsg {
  kind: "ephemeral";
  from: UserId;
  t: EphemeralKind;
  data: Record<string, Json>;
}
```

### asset.get (0x05 · client → host · assets)

Lazy fetch by sha256 with resume; priority queue order scene > ui > audio > preload (§7).
Requires an authenticated session; per-session rate bucket burst 20 @ 10/s (§16, D-041).
Per-peer bandwidth cap and 32 KB default chunks (D-040).

```ts
type AssetPriority = "scene" | "ui" | "audio" | "preload";
interface AssetGetMsg {
  kind: "asset.get";
  assetId: AssetId;
  offset: number;
  priority: AssetPriority;
}
```

### fog.put (0x06 · client → host · ops)

Per-user explored fog, downscaled PNG readback (§8 key [worldId,sceneId,userId]).

```ts
interface FogPutMsg {
  kind: "fog.put";
  sceneId: DocId;
  png: Uint8Array;
}
```

### relay.offer (0x07 · client → host · ops · M4)

Offer from a player unreachable directly, forwarded through a connected peer (§6.3).

```ts
interface RelayOfferMsg {
  kind: "relay.offer";
  from: PeerId;
  sdp: string;
}
```

### turn.ready (0x08 · client → host · ops)

Player toggles readiness for the orders phase (§5A).

```ts
interface TurnReadyMsg {
  kind: "turn.ready";
  turnId: DocId;
  ready: boolean;
}
```

### sim.control (0x09 · client → host · ops · GM only)

Pause/resume/rate/advance/next/undoTurn/mode (§5A, §13). Realtime campaigns
start with `action:"start", mode:"realtime"`; the host then runs a sim clock —
ticks at `simHz` (default 5), deltas coalesced into one frame per `flushHz`
interval (default 5), a 1 Hz realtime `turn.report` (bounded events,
`rulesVersion:"realtime"`), and a tick checkpoint every 300 ticks plus on
pause/scene change. `rate` adjusts `simHz` live (flush capped at the original
`flushHz`); `pause` freezes the clock and writes a tick checkpoint (`tick`
non-null in the checkpoints store, distinct from stepwise freezes); `resume`
continues without a catch-up burst.

```ts
type SimControlAction =
  "pause" | "resume" | "rate" | "advance" | "next" | "undoTurn" | "mode" | "start";
interface SimControlMsg {
  kind: "sim.control";
  action: SimControlAction;
  rateHz?: number;
  mode?: "stepwise" | "realtime";
  deadlineMs?: number;
}
```

### report.detail (0x0a · client → host · ops)

Paginated verbose per-model rolls of a TurnReport, fetched on demand (§11).

```ts
interface ReportDetailMsg {
  kind: "report.detail";
  turnId: DocId;
  unitId?: DocId;
  page: number;
}
```

### sim.snapshot.get (0x0b · client → host · sim)

Client detected a version gap and requests a full snapshot (§5A).

```ts
interface SimSnapshotGetMsg {
  kind: "sim.snapshot.get";
  sceneId: DocId;
}
```

### welcome (0x20 · host → client · ops)

After approval: assigned User document info + world info (§6.4).

```ts
interface WelcomeMsg {
  kind: "welcome";
  user: { id: UserId; role: Role; name: string };
  world: { id: WorldId; name: string; system: string; version: string };
  snapshotSeq: number;
}
```

### snapshot (0x21 · host → client · ops)

Projected world snapshot; carries only the asset manifest — assets stream lazily by hash (§5, §7).
Manifest entries may carry image descriptors (D-042/D-043): `width/height`,
`thumb {assetId,width,height}` (≤256 px WebP), `mid` (≤1024 px WebP),
`tiles {size, cols, rows, ids[]}` (row-major, maps >4096 px).

```ts
interface SnapshotMsg {
  kind: "snapshot";
  seq: number;
  world: ProjectedWorld;
  manifest: AssetManifest;
}
```

### ops (0x22 · host → client · ops)

Commit broadcast — the projected OpEnvelope `{ seq, ts, by, ops', txId }` (§5). Late joiners buffer ops with seq > snapshot.seq.

```ts
interface OpsMsg {
  kind: "ops";
  envelope: OpEnvelope;
}
```

### rejected (0x23 · host → client · ops)

Sent to the origin of a failed intent; clients roll back optimistic state (§5). `phase_locked` rejects order ops after turn.advance (§5A).

```ts
type RejectionReason =
  "forbidden" | "invalid_schema" | "invariant" | "phase_locked" | "rate_limited" | "error";
interface RejectedMsg {
  kind: "rejected";
  txId: TxId;
  reason: RejectionReason;
  detail: string;
}
```

### asset.chunk (0x24 · host → client · assets)

Chunked transfer with resume (`offset`), 16–64 KB per chunk (§6.1, §7).
Unknown asset → sentinel `{ offset: 0, total: 0, bytes: [], done: true }` (D-039).

```ts
interface AssetChunkMsg {
  kind: "asset.chunk";
  assetId: AssetId;
  offset: number;
  total: number;
  bytes: Uint8Array;
  done: boolean;
}
```

### audio.cmd (0x0c · both · ops)

§7 audio playback command (transfer-once assets, scheduled on the host clock).

Client → host (GM/ASSISTANT request; `atHostTime` absent — the host stamps it):

```ts
interface AudioCmdMsg {
  kind: "audio.cmd";
  playlistId: string;
  soundId: string;
  action: "play" | "stop" | "pause" | "resume";
  atHostTime?: number; // host send time + lead; host-stamped on rebroadcast
  offset: number; // playback offset into the sound (seconds)
}
```

Host → clients: broadcast with `atHostTime = hostNow + 120 ms` lead; clients
start playback at `atHostTime − clockOffset` (NTP-style offset from ping/pong).

### clock (0x25 · host → client · ops)

Host-clock broadcast for audio sync; offset refined NTP-style from ping/pong (§7).

```ts
interface ClockMsg {
  kind: "clock";
  hostTime: number;
}
```

### kick (0x26 · host → client · ops)

```ts
interface KickMsg {
  kind: "kick";
  reason: string;
}
```

### ban (0x27 · host → client · ops)

```ts
interface BanMsg {
  kind: "ban";
  reason: string;
}
```

### sim.delta (0x28 · host → client · sim)

Faction-projected binary delta; clients apply strictly sequentially (§5A). In
realtime mode frames are COALESCED: `to - from` spans every tick merged since
the last flush (e.g. 2 at 10 Hz sim / 5 Hz flush); a client that missed frames
detects the version gap and recovers via `sim.snapshot.get`. Clients smooth
motion by interpolating positions ~240 ms behind the newest state.

```ts
interface SimDeltaMsg {
  kind: "sim.delta";
  sceneId: DocId;
  from: number;
  to: number;
  bytes: Uint8Array;
}
```

### sim.snapshot (0x29 · host → client · sim)

Full compressed pool for late joiners / gap recovery (§5A).

```ts
interface SimSnapshotMsg {
  kind: "sim.snapshot";
  sceneId: DocId;
  version: number;
  bytes: Uint8Array;
}
```

### turn.phase (0x2a · host → client · ops)

Phase announcements with deadline and ready list (§5A, §13). Realtime
campaigns add the optional clock fields: `mode:"realtime"` marks the campaign,
`paused:true` rides the orders-phase frame sent on pause (the phase itself
stays `"orders"`), and `simHz` reports the current tick rate.

```ts
interface TurnPhaseMsg {
  kind: "turn.phase";
  turnId: DocId;
  phase: "orders" | "resolution" | "report";
  deadlineMs: number | null;
  readyUsers: UserId[];
  mode?: "stepwise" | "realtime";
  paused?: boolean;
  simHz?: number;
}
```

### turn.report (0x2b · host → client · sim)

The projected TurnReport — events referencing undetected units become "unknown enemy" stubs (§5A).

```ts
interface TurnReportMsg {
  kind: "turn.report";
  turnId: DocId;
  report: TurnReport;
}
```

### report.detail.page (0x2c · host → client · ops)

Response to report.detail (§11).

```ts
interface ReportDetailPageMsg {
  kind: "report.detail.page";
  turnId: DocId;
  page: number;
  totalPages: number;
  events: SimEvent[];
}
```

### heartbeat (0x40 · internal · ops)

2 s liveness probe (§6.5).

```ts
interface HeartbeatMsg {
  kind: "heartbeat";
  t: number;
}
```

### ping (0x41 · internal · ops)

Clock probe, client → host (§7).

```ts
interface PingMsg {
  kind: "ping";
  t0: number;
}
```

### pong (0x42 · internal · ops)

Clock reply; offset = ((t1−t0)+(t2−t3))/2 (§7).

```ts
interface PongMsg {
  kind: "pong";
  t0: number;
  t1: number;
  t2: number;
}
```

### relay.frame (0x43 · internal · ops · M4)

Opaque e2e-encrypted frame relayed via a connected peer (§6.3).

```ts
interface RelayFrameMsg {
  kind: "relay.frame";
  from: PeerId;
  to: PeerId;
  bytes: Uint8Array;
}
```

## Supporting types

Imported from the core contracts (`src/core/*.ts`): `Op`, `OpEnvelope`, `FlatDiff`,
`Json`, `AssetId`, `DocId`, `PeerId`, `TxId`, `UserId`, `WorldId`, `Role`,
`AssetManifest`, `ProjectedWorld`, `SimEvent`, `TurnReport`. Full definitions
live in those modules (§4, §4A, §5A) — see `src/core/documents.ts`,
`src/core/ops.ts`, `src/core/sim.ts`, `src/core/projection.ts`.

`Op` (§4, orders travel as ordinary intent Ops on `unit.orders`):

```ts
type Op =
  | { kind: "create"; coll: CollectionName; parent?: DocRef; data: Doc }
  | { kind: "update"; ref: DocRef; diff: FlatDiff } // dotted keys; "-=key": null deletes
  | { kind: "delete"; ref: DocRef };

interface OpEnvelope {
  seq: number;
  ts: number;
  by: UserId;
  ops: Op[];
  txId: string;
}
```

## Signaling (§6.2)

Adapters exchange opaque, authenticated codes — no relay ever sees plaintext.

```ts
type SignalMsg =
  | { t: "offer"; sdp: string } // non-trickle, pre-gathered ICE
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: RTCIceCandidateInit }
  | { t: "leave" };

interface SignalingAdapter {
  open(roomId: string, key: CryptoKey): Promise<void>; // key = HKDF(roomSecret)
  send(to: PeerId, msg: SignalMsg): Promise<void>;
  onMessage(cb: (from: PeerId, msg: SignalMsg) => void): void;
  close(): void;
}
```

Wire code: `vtt1.<base64url(iv[12] || AES-GCM(ct({from, to?, msg})))>` (D-046).
Invite link: `<base>#room=<id>&k=<secret>[&h=<host nostr pubkey hex>]` — fragment only,
never sent to a server. `&h=` opts the joiner into Nostr signaling (kind 20_250, room tag);
without it the invite is manual copy/paste only (D-066).

### Other transports (D-052–D-054)

- **MQTT-over-WSS**: topic `vtt/<sha256(roomId)>`, QoS 0, payload = `vtt1.` code.
- **WebTorrent trackers**: WS tracker protocol, info_hash = sha1(roomId) hex;
  the code rides opaquely inside `offers[]` (broadcast) and `answer`+
  `to_peer_id` (routed once the peer is learned).
- **Generic WebSocket** (self-hosters): code frames over a user-supplied relay
  URL; rooms scoped by URL server-side.
- **Ordering**: SignalingStack tries nostr → mqtt → tracker (configurable),
  first ready wins within 8 s; Manual is always available.

### Nostr transport specifics (D-051)

Ephemeral events, kind **20250** (NIP-01 20000–29999), tag `["t", <roomId>]`,
content = the `vtt1.` code. selfId = nostr pubkey (hex). Sends fan out to every
connected relay; receivers dedupe by event id, drop unverified signatures,
never dispatch their own echoes, and honor the authenticated `to` field.
