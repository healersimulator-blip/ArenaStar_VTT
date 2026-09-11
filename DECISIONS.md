# DECISIONS — judgement calls (spec-consistent choices, logged per operating rule 1)

Format: **D-###** — decision — spec §ref — rationale.

- **D-001** Repo root is `/home/user/vtt` (self-contained project; uploads/ and toolchain live
  outside it). All tracking files at repo root per §0. — internal, no spec impact.
- **D-002** pnpm workspace has one root member; `systems/*` are declared workspace packages
  (empty for now) because §12 system packages are folder/zip data packages loaded at runtime,
  not npm build units. — §0 "pnpm workspace" + §12.
- **D-003** Dependencies are staged with their units: @msgpack/msgpack, fflate, idb installed
  now (needed by the first M1 units); PixiJS, nostr-tools, mqtt.js, @tanstack/virtual join in
  their respective units to keep intermediate builds honest. No deps outside §17. — §0, §17.
- **D-004** TypeScript pinned to `~5.9` because the registry's current `typescript@7.x` is not
  yet supported by typescript-eslint. — §0 toolchain health.
- **D-005** e2e navigates the `file://` URL of the built `dist/index.html` (no static server);
  this doubles as the §15 file:// boot check. Chromium profile runs headless via Playwright;
  Firefox/WebKit exercised per §15 matrix at milestone acceptance.
- **D-006** TS strict extras enabled: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals/Parameters`. — §9 quality bar.
- **D-007** `hello` message carries an added `ts` field; the signature covers
  `vtt:hello:<roomId>:<displayName>:<ts>`. Spec §13 lists `hello{pubkey, displayName, sig}`;
  a signature is meaningless without a signed payload, so this is an additive clarification,
  not a rename. — §6.4/§13.
- **D-008** Spec names collections and embedded collections but not their fields; M1 uses
  Foundry-style minimal field sets (Token x/y/rotation/img/hidden/disposition/…, Wall c/door/
  one-way/restrictions, etc.) — typed in `src/core/documents.ts`, refined per unit. — §4.
- **D-009** Wall restriction codes: `0 = blocks`, `1 = conditional (door state applies)`,
  `2 = permits`, per axis (move/sight/sound/light). — §9 (implemented in M2).
- **D-010** PROTOCOL.md is hand-maintained next to `src/core/messages.ts` and kept in sync by
  a unit test that cross-checks every `MsgKind` name against the doc. — §0, §13.
- **D-012** Embedded documents are addressed as `DocRef { coll: <embedded name>, id,
parent: <parent DocRef> }` with `EmbeddedCollectionName = tokens|walls|lights|sounds|
tiles|drawings|templates|notes|items|effects|pages|combatants|units` (§4 embedded
  collections; §4A units-in-armies). FlatDiff paths traverse objects; numeric segments
  index arrays in-range; array-element deletion is rejected (replace the array) —
  wholesale array values are the diff unit for arrays.
- **D-013** `can()` treats ASSISTANT like GM (everything): §6.5 gives assistants the
  full unfiltered replica and failover authority, so restricting them in `can()` would
  contradict the spec's own trust model. — §4/§6.5.
- **D-014** `can()` takes an optional 5th arg `{ parent? }` (CanOptions): §4A's cascade
  ("OWNER on unit or army") is uncomputable from the unit alone. Embedded reads also
  cascade through the parent (a token is as visible as its scene), matching how
  projection walks top-level documents. — §4/§4A.
- **D-015** `assetManifest` is world data maintained by the host AssetServer and carried
  in snapshots, NOT an Op-target collection (assets aren't documents; §7). `settings` is
  a normal documents collection holding a singleton doc (id `"core"`). — §4/§8.
- **D-016** OpEnvelopes are applied as true transactions: inverses captured per-op
  before apply; any failing op rolls the whole envelope back (inverses in reverse);
  seq is not consumed on rejection. — §4 "transactions (one OpEnvelope)".
- **D-017** Store reactivity API is `watch(ref, cb, path?)` with chain-prefix matching
  (embedded children report their top-level root) and segment-aware path filters;
  plus `onChange(env, changes)` for sync layers. This is the substrate §10's "reactive
  bindings to DocumentStore paths" compile against.
- **D-018** `messages` cap defaults to 100 (Foundry default); trims oldest-first inside
  the applying envelope, deterministically (identical on replay), surfaced to watchers
  as synthetic delete ops. — §4 "capped/paginated".
- **D-019** Create-ops get lenient defaults for `flags`/`system`/`ownership`
  (ownership.default = NONE); `_id`, `name`, `type` are required. — §4 document shape.
- **D-020** Toolchain note (carried from D-011): after re-running `pnpm install` in a
  fresh session, use `export PATH=/home/user/.toolchain/bin:$PATH` and
  `PLAYWRIGHT_BROWSERS_PATH=/home/user/.pw-browsers` for e2e.
- **D-021** Projection scope details: the `users` collection is always projected
  (player list / whisper targets need it); `assetManifest` is not part of the projected
  world — it travels in `snapshot.manifest` (§7 snapshot carries only the manifest);
  `settings` follows the generic ownership rule. — §5.
- **D-022** "Walls and lights sent to everyone" (§5) applies within any scene the
  recipient already receives (ownership ≥ LIMITED); a fully invisible scene omits the
  whole document (sending its walls would leak the scene). Embedded docs otherwise ride
  their parent's inclusion (cascade-max), so the only per-token restriction is the
  `hidden` flag. — §5.
- **D-023** `projectEnvelope(env, user, resolver?)` takes an optional pure document
  resolver: update/delete visibility depends on current doc state (hidden flag,
  ownership, whisper lists), which the host supplies from its store. Journal-page text
  diffs are secret-stripped; message roll fields redacted in-place (gmroll/blindroll).
  — §5.
- **D-024** Dice semantics: modifier order explode → reroll → clamp → keep/drop →
  count; `r` rerolls each matching die once, `ro` rerolls a single die; `cs`/`cf` totals
  = successes − failures (cs alone counts successes, cf alone counts failures); guards:
  no exploding 1-sided dice, ≤ 1000 dice/term, ≤ 10 000/formula, ≤ 500 chars;
  `validateFormula` parse-checks `@paths` by substituting a dummy 1. — §11.
- **D-025** Rate-limiter defaults: ephemeral 20 Hz (burst 4, §5), intents 30/s
  (burst 30), asset.get 10/s (burst 20) — host wiring lands with HostSync/AssetTransfer. — §16.
- **D-026** Dev-only dependency `fake-indexeddb` runs the §8 storage tests against
  real IndexedDB semantics in Node; runtime code uses `idb` only (§17 unchanged).
- **D-027** Write-behind atomicity: each envelope is appended to the oplog store in
  its own transaction immediately; the ~500 ms documents batch writes dirty roots
  AND advances `worlds.flushedSeq` in ONE transaction, so startup can always replay
  `oplog since flushedSeq` over the documents state without gaps or double-apply.
  `checkpoint()` = full rewrite + oplog compaction ≤ seq in one txn.
- **D-028** OPFS access is abstracted behind DirHandleLike; tests inject an
  in-memory fake. `OpfsAssetStore.open` returns null where OPFS is unavailable
  (the AssetServer unit decides the IDB-blob fallback). — §8/§15.
- **D-029** `DocumentStore.onChange` also passes the captured inverse ops (pre-images)
  to subscribers; the persister persists them alongside each oplog entry so undo
  survives host restart. `DocumentStore.hydrate(collections, seq)` merges persisted
  documents into a live store at startup. — §8.
- **D-030** UndoStack (core): push(env, inverses) / applyUndo / applyRedo with
  redo-branch invalidation and depth cap 100; the host wraps results in fresh
  envelopes (new seq + txId). — §8.

- **D-031** Reconnect catch-up (§5): hello carries optional `lastSeq`; when it lies
  within the retained log (`[log.baseSeq, store.seq]`) the host replays ops-since-seq
  (no snapshot), otherwise it sends a full projected snapshot; `welcome.snapshotSeq`
  reports the chosen catch-up point. `ClientSync.reattach(transport)` keeps the
  replica/pending and re-stamps hello.lastSeq from the current seq. — §5/§6.4.
- **D-032** `EventBus<TEvents extends object>`: the bus only requires a string-keyed
  event record, so `object` (not a bespoke shape) is the constraint. — core/events.
- **D-033** `Transport.onMessage` is a plain mutable slot (not readonly): transports
  may be created before their handler is installed (loopback pair, PeerSession
  re-attach); InMemoryTransport reads the peer handler at delivery time, not send
  time, so sends before receiver construction are not lost. — §6.1.
- **D-034** `HostSync.addSession(peerId, transport, user?)`: trusted sessions (GM
  loopback, `gmSessionUser`) receive welcome + catch-up immediately on attach — the
  GM client gets state through the same wire protocol, never host internals (§2
  invariant). — §2/§5.
- **D-035** Host intent validation resolves create/update targets and parents, runs
  `can()` with the parent doc, and dry-applies update diffs (`applyDiff`) before
  commit; commit failures surface to the client as `rejected{invariant}`. Message
  creates are normalized host-side: author = session user, whisper default [],
  ownership floor LIMITED; users-create by clients is forbidden. — §4/§5.
- **D-036** Roll intents share the session intent bucket; results resolve via the
  injected `rng` and commit as chat message docs; `gmroll`/`blindroll` project
  `roll=null` to everyone except the roller (gmroll) or nobody (blindroll). — §11.

- **D-037** §7 host asset storage: the "vtt" IDB gains an `assets` store
  (DB_VERSION 2, guarded creation; records keyed [worldId, hash] holding
  name/mime/size/chunks). Blobs go to OPFS /vtt/<worldId>/assets/<hash>; when
  OPFS is unavailable the bytes are inlined in the IDB record so the GM tab
  still works from file://. Import is idempotent per content (first name wins).
  — §7/§8.
- **D-038** Client AssetCache: Cache API (`vtt-assets`, synthetic URLs) where
  available, else IndexedDB "vtt-client" DB (store keyed by hash) — a separate
  DB from the host's "vtt" because the GM tab is both host and client. — §7.
- **D-039** Unknown asset on asset.get → single sentinel chunk
  {offset:0, total:0, bytes:[], done:true}; the client rejects the request with
  "asset not found" and may retry later. No protocol kind added. — §7/§13.
- **D-040** AssetTransfer: pump start is deferred one microtask so requests
  arriving in the same tick are priority-ranked together; per-peer pacing gate
  (chunkBytes / bytesPerSecond after each send; defaults 32 KiB chunks,
  1 MiB/s/peer); the loop terminates on an empty queue (stale gates are not
  spun on); re-request resumes at the new offset and upgrades priority. — §7.
- **D-041** asset.get requires an authenticated session and draws from a
  per-session bucket (burst 20, 10/s refill, createAssetRateLimiter §16);
  over-limit requests are silently dropped (the client dedups and resumes, so
  drops cost latency, not correctness). — §7/§16.

- **D-042** §7 import variants: thumbnail = WebP q0.8 at longest edge ≤ 256;
  mid-res = WebP q0.8 at ≤ 1024; tiles = WebP q0.85, 1024 px grid, generated
  only when a side exceeds 4096 px (never upscale — small images' variants
  dedupe to the full asset's hash). All derived artifacts are content-addressed
  assets named `<name>#thumb|#mid|#tile<i>`. — §7.
- **D-043** AssetManifestEntry gained additive optional descriptors
  {width, height, thumb?, mid?, tiles?{size, cols, rows, ids[]}}; they persist
  in the IDB asset record (AssetServer.describe), so restarts need no
  re-derivation, and travel inside snapshot manifests (older entries simply
  omit them). — §7/§13.
- **D-044** Image work is a port: `ImageCodec` (metadata/derive/tile) with the
  pure geometry (fitWithin, tileGrid) shared in src/workers/assetJob.ts; the
  browser implementation is the asset worker (createImageBitmap +
  OffscreenCanvas) behind a correlation-id RPC (assetWorkerClient). The worker
  enters the bundle when the GM import UI imports the codec client (assets UI
  unit); tests drive the pipeline with a fake codec.

- **D-045** Test-only e2e hook: `?e2e` in the URL lazily installs
  `window.__vttE2E` (src/app/e2eHook.ts) exposing the bundled module surface to
  Playwright (webrtcLoopback). Inert in normal use; ships in the single-file
  deliverable so e2e proves the REAL bundled code path from file://. — §14/§15.
- **D-046** Signaling crypto (§6.2): key = HKDF-SHA256(roomSecret, salt=
  "vtt:<roomId>", info="vtt:room:v1") → AES-GCM-256; wire code format
  `vtt1.<base64url(iv[12] || ciphertext+tag)>`; plaintext envelope
  `{ from: PeerId, msg: SignalMsg }` (sender id authenticated, invisible to
  relays). Invite link keeps the secret in the URL fragment. JSON envelopes
  (msgpack framing stays for the DataChannel wire). — §6.2.
- **D-047** WebRTCTransport: the PLAYER initiates (§2 star) via
  createOutgoing→offer(); host accepts via createIncoming(offer)→answer();
  descriptions are non-trickle with pre-gathered ICE (3 s gather timeout
  fallback, §6.2 Manual). Backpressure band per §6.1: bufferedAmountLow-
  Threshold 256 KiB; frames arriving while bufferedAmount > 1 MiB queue
  (≤256/channel, then throw — never silent loss) and drain on
  bufferedamountlow. ephemeral = ordered:false + maxRetransmits:0. RTCPeer-
  Connection absence (Node) throws at construction; those unit tests skip and
  the real loopback runs as e2e against the bundle. — §6.1.

- **D-048** Heartbeat (§6.5) rides the existing ping/pong protocol kinds inside
  a ManagedTransport wrapper: the client pings every 2 s on `ops`; the host
  wrapper replies pong{t0,t1,t2} (host clock) and stamps lastSeen; the host
  reaps sessions silent > 3×interval + 1 s. Consumers (HostSync/ClientSync)
  keep their single onMessage slot and never see ping/pong frames; undecodable
  frames pass through untouched. Clock stats (§7 prep): rtt = (t2−t1)+(t3−t0),
  offset = ((t1−t0)+(t2−t3))/2. — §6.5/§7.
- **D-049** Reconnect (§6.5): ClientPeerSession re-offers through signaling
  with exponential backoff 1 s ×2 → 30 s cap, reset on connect; with non-trickle
  signaling a fresh pre-gathered offer IS the ICE-restart equivalent. A
  re-offer at the host closes the previous session ("replaced by new offer")
  and fires onSession again with the new transport (app re-adds it to
  HostSync). — §6.5.
- **D-050** PeerConnectionFactory port (createClientPeer/createHostPeer →
  PeerWire{offer,answer,acceptAnswer,addIceCandidate,onStateChange,transport}):
  the default RtcPeerFactory wraps §6.1 createOutgoing/createIncoming; Node
  tests drive the full session state machine over a token-SDP loopback factory
  (real WebRTC path is covered by the bundle e2e). — §6/§14.

- **D-051** Nostr adapter (§6.2, default): nostr-tools@2.25.2 (in the §17 fixed
  stack) is used for NIP-01 event building/verification only (schnorr
  secp256k1); the WebSocket relay plumbing is ours behind an injectable
  RelaySocket port so tests run against an in-memory relay hub. Kind 20250
  (NIP-01 ephemeral range — relays must not store); room tag `["t", roomId]`
  (single-letter tags are the only ones relays index); content = the §6.2 room
  crypto code (`vtt1.`), so relays never see plaintext, sender ids or room
  semantics beyond an opaque topic. selfId = the nostr pubkey; envelope `to`
  routes targeted sends (broadcast when absent, D-046 envelope extended).
  Fan-out to ALL connected relays + event-id dedupe + per-relay reconnect
  (1 s ×2 → 30 s). Default relays: damus, nos.lol, nostr.band (3; list and
  order configurable). Adapter not yet imported by the app entry, so it stays
  out of the single-file bundle until the join UI wires it (lazy import there).
  — §6.2.

- **D-052** MQTT adapter (§6.2): mqtt.js@5.15.2 (§17 stack) behind an async
  factory port (MqttClientPort with per-event callbacks; the real client is
  lazy-imported so it stays out of the entry bundle). Topic
  `vtt/<sha256hex(roomId)>`; QoS 0, no retain; payload = the room-crypto code.
  Default public broker wss://broker.emqx.io:8084/mqtt (configurable for
  self-hosters). — §6.2.
- **D-053** WebTorrent tracker adapter (§6.2): speaks the tracker WebSocket
  JSON protocol with info_hash = sha1(roomId) hex and a random 20-char
  peer_id. The tracker treats `offers`/`answers` as opaque payloads it
  forwards — our encrypted `vtt1.` code rides inside them, so the mapping is:
  unknown target → broadcast announce with offers[]; known target (envelope
  id → tracker peer_id learned on first receipt) → routed answer with
  to_peer_id + the peer's last offer_id. Envelope identity stays independent
  of transport peer ids; the tracker sees only ciphertext + swarm ids. Default
  trackers: openwebtorrent + webtorrent.dev; fan-out to all, dedupe by code
  prefix. No webtorrent runtime dependency added (§17 discipline). — §6.2.
- **D-054** Generic WebSocket adapter (self-hosters, §6.2) + SignalingStack
  registry: the ws adapter targets a user-supplied relay URL (rooms scoped by
  URL server-side) and reuses the RelaySocket port; the registry tries
  adapters in configurable order (default nostr → mqtt → tracker), promoting
  the first whose ready() settles within 8 s, and ALWAYS exposes Manual
  (stack.manual) per §6.2. Shared envelope dispatch (decrypt → self-echo skip
  → authenticated to-routing) lives in signaling/dispatch.ts. — §6.2.

- **D-055** §6.5 host lifecycle wiring: installHostLifecycle(persister) hooks
  beforeunload + pagehide (bfcache-safe) and visibilitychange→hidden onto
  HostPersister.drain() (the §6.5 hook Unit 5 exposed); optional interval
  tick; document injectable for tests; returns remove(). — §6.5.
- **D-056** Canvas (§9 M1 subset): PixiJS 8.20.1 (§17 stack). Pure math
  (camera world⇄screen/zoomAt/fitRect, square-grid line/snap geometry, token
  center→top-left rects, marquee hit test, disposition colors) lives in
  environment-free modules tested in Node; stage.ts (Application init, root
  container carrying the camera transform, layers Background → Grid → Tokens
  → Controls in §9 M1 order, ticker-driven grid redraw at 1/scale line width)
  is exercised through the ?e2e hook against the real single-file bundle
  (D-045 pattern). Bundle impact: 44 KB → 627 KB raw (Pixi tree-shaken),
  188 KB gzip — budget 6 MB. Token x/y = center (pixel w/h); hidden tokens
  render at alpha 0.5 (projection already keeps them from players). — §9.

- **D-057** §10 interactions (M1, tool-less pointer mapping): left-drag on a
  token moves it (per-frame local preview; one update Op per drag on release,
  snapped to grid intersections when a grid is active, token x/y = center);
  left-drag on empty space is marquee select (normalized rect hit test);
  middle/right/shift+left pans; wheel zooms cursor-pinned. Unowned tokens
  select but never drag (canMove gate). CanvasController is port-injected
  (StageLike / PointerEventSource / IntentSink — ClientSync.submit satisfies
  it) so the whole state machine runs in Node; domPointerSource is the thin
  DOM adapter (map-backed listener wrapping so remove actually unbinds).
  Stage tokens glide exponentially to their targets each tick (§9 animated
  movement; new tokens appear in place). — §9/§10.

### D-058 — Unit 15: GM-tab app shell & boot composition (§2, §14)

- `bootHostApp()` is the composition root, order: openVttDb → world pick (explicit `worldId` → `listWorlds()[0]` → fresh `w-<uuid8>` createWorld, meta name "World One"/system mass-battle-basic) → HostPersister.attach → seed envelope at seq 1 when store.seq===0 (users/gm GM + scenes/scene-1 with square grid 100/5 ft, 2000×1500) via applyEnvelope+log.append+drain → AssetServer.open + wireManifestToStore → ImportPipeline(codec ?? AssetWorkerCodec) → HostSync(roomId=worldId, verifyHello, undo, assets) → InMemoryTransport loopback added as session "gm" (gmSessionUser) → ClientSync.connect(hello, sig "gm-loopback") → AssetCache.open + AssetFetcher(request=gmClient.requestAsset, bus "asset"→onChunk) → installHostLifecycle.
- GM tab = Host Core + Client Core over InMemoryTransport (invariant kept: shell NEVER touches host internals; all mutations via client.submit).
- makeToken ownership `{default: 0, gm: 3}`; canvas errors surface in a `.error` line instead of a dead shell.
- `installHostLifecycle` default target now probes for window (`addEventListener` present); in Node it installs nothing (tests boot without a DOM).
- main.ts installs the ?e2e hook BEFORE awaiting boot (transport surfaces race-free), then re-installs with the live app after boot; e2e surface exposes {worldId, seq, tokenCount, tokenPos, sceneImg} for the app spec.
- Playwright evaluate() structured-clones → the surface is read via per-call `page.evaluate` expressions, never by shipping methods across the wire.

### D-059 — Unit 15: single-file bundle runtime compatibility

- Pixi: side-effect `import "pixi.js/unsafe-eval"` in stage.ts — file:// (and any CSP-restricted) contexts forbid Function()-based fast paths; eval-free module is the official supported fallback.
- Asset worker: `import Ctor from "./asset.worker.ts?worker&inline"` — the single-file deliverable has no worker chunk to fetch; inline embeds it as a data URL.
- AssetWorkerCodec never transfers `bytes` (all postMessages clone): the import pipeline reuses the same buffer for metadata → derive → asset-store sha256, and a transfer would detach it mid-flow (two runtime crashes found via e2e). All codec calls are cold import-time paths; the hot streaming path (chunk serving) never goes through the codec.

### D-060 — Unit 16: §8 world.zip export/import (streaming fflate)

- Archive layout (format 1): `world.json` {format, worldId, name, system, version, seq, exportedAt} + `documents.json` {seq, docs:[{coll,id,doc}]} (every raw documents row; oplog tail NOT exported — checkpoint semantics) + `assets.json` (metadata incl. width/thumb/mid/tiles) + `assets/<hash>` blobs. fog/, checkpoints/, reports/ absent until their M2 features exist (ROADMAP); world-scope settings join when §10 settings land.
- Export: `Zip`/`ZipDeflate` streaming accumulation into a Blob; flushes the live persister first; missing blob (neither IDB fallback nor OPFS) → explicit error.
- Import = restore: keeps the ORIGINAL worldId; one readwrite txn clears documents/oplog/fog/assets ranges for the world, re-puts doc rows + asset records, writes the worlds row with flushedSeq=oplogBase=exported seq (attach() then hydrates with an empty tail). OPFS blobs written BEFORE the txn (content-addressed → idempotent; OPFS failure leaves orphan files, never a half-imported DB). Undo history resets, same as after checkpoint().
- UI: `#export-world` (object-URL download `world-<slug>.zip`), `#import-world` (file input → app.close() → importWorldZip → location.reload into the restored world). HostApp now exposes readonly db + root.
- Corrupt archives fail explicitly (format mismatch / missing world.json|documents.json|blob) with `{cause}` preserved.
- e2e note: Playwright intercepts the file:// download; after `setInputFiles` the app's own `reload()` races pending evaluates — the spec awaits a pre-registered `load` event before polling.

### D-061 — Unit 17: join flow (role picker, manual signaling, player shell)

- main.ts routing: `?e2e` auto-hosts (existing specs), `?join` or an invite fragment `#room=&k=` mounts JoinApp directly, default lands on Root.svelte role picker (Host / Join / Import world file) which also carries the §0 capability report (smoke spec target).
- startHostShare: roomId = worldId, secret = 32 random bytes hex persisted at settings[world, invite-secret] (stable across host restarts for rejoin), ManualSignalingAdapter (always available incl. file://) + HostSessions; onSession → HostSync.addSession; join:request AUTO-APPROVED as PLAYER in M1 (§6.4 approval dialog + ban UI = PLAN-open M2 item). Nostr stack = lazy background upgrade, PLAN-open.
- bootPlayerApp: ensureIdentity (per-browser Ed25519→ECDSA keypair, JWK in settings[client, identity]; userId = pubkey, stable ⇒ known-pubkey auto-approve on rejoin), ClientPeerSession (offer/answer codes via the manual outbox), ClientSync + hello (signed payload) on DataChannel connect, AssetCache/AssetFetcher as in the GM loopback.
- PlayerApp owns the raw session callbacks and exposes onDisconnected/onConnectionState hooks — the UI must not clobber joinBoot's connect handler (state-chained).
- makeToken ownership now {default: 3, gm: 3}: tabletop default — GM-added tokens are visible & movable by players; host still re-validates every op (§5). Player-side canMove gate = permissions.can(user, "update", token, "tokens", {parent: scene}).
- API adjustments (internal): HostSync.bus made public readonly; HostSessions.onSession/onClosed made mutable fields; HostSessions accepts factory override (tests: in-memory wire); HostSessions signaling errors now surface via console.error instead of a swallowed `void`.
- Node tests drive the REAL manual-crypto path (two ManualSignalingAdapters with outbox⇄receiveCode pump) + MemFactory RTC pairs; the two-context e2e does real WebRTC with the manual code exchange through the UI.

### D-062 — Unit 17b: crash & recovery (§6.5/§14) — reconnect machinery hardening

Five real-browser findings, all fixed in the session/transport layer (each verified by the crash e2e):

1. RTCPeerConnection fires "connected" BEFORE DataChannels open → hello/reattach sends threw "transport closed". Fix: WebRTCTransport.opened threaded through ManagedTransport → ClientPeerSession.transportOpen(); joinBoot awaits it before the first hello and before reattach.
2. PeerConnectionState lacked "disconnected" — the FIRST ICE signal of a vanished host. Added to the union; ClientPeerSession treats disconnected|failed as failure → backoff re-offer.
3. A reconnect timer armed by an earlier failure fires later and unconditionally tore down the session — assassinating a connection that succeeded in between (manual answers land after stale ones). Guard: timer callback no-ops when closed or already connected.
4. Stale-answer healing must never kill a live session: acceptAnswer failures only trigger reconnect when the session is NOT connected; a stray late answer against a stable pc is logged and ignored.
5. Manual signaling cadence: default reconnect backoff for the manual join flow is 5 s→30 s (a human ferries codes; 1 s re-offers invalidate pending exchanges).

- Reconnect data path: ClientSync.reattach(transport) on a connected session with an existing replica — hello carries lastSeq; host answers ops-since-seq when within the retained log (D-031), full snapshot otherwise. Node test asserts the SAME ClientSync instance survives recovery and converges on ops the host committed while the player was offline.
- Manual adapter: new non-destructive `lastSentCode` mirror; UI polls the mirror (textareas never drain the outbox), tests drain the real outbox through the e2e surfaces (double-drain was silently eating offer codes).
- Crash e2e shape: host PAGE closed (context storage survives) → player #disconnect-notice → host reopens (same worldId from IDB) → #share → direct code re-exchange loop (≤12 attempts, answers take ~1–2 s of non-trickle ICE) → connected → post-recovery op converges on the player.

### D-063 — Unit 18: chat (§10/§11 M1)

- Inline rolls: HostSync.normalizeOps rewrites `[[formula]]` → `[[total|formula]]` in message-create intents using the host rng (§11 rolls execute host-side; the client never dictates results). INVALID inline formulas stay literal text (explicit; no silent drops, no hostile message rejection).
- Wire rolls unchanged (existing path): client.roll(formula, mode) → host evaluates → commits a MessageDocument roll card {roll: {formula,total,terms}, rollMode}; projection redacts gmroll for non-authors, omits whispers for non-targets (verified against a live store via projectWorld).
- ChatPanel (src/ui/chat, shared GM+player): #chat-log + #chat-input; commands /roll /r, /gmroll /gmr, /emote /e, /w|/whisper <name> (name resolved against the projected users collection); inline chips render as `.chip` spans (title=formula); roll cards as `.rollcard`; whisper/emote styling; auto-scroll via $effect.
- Messages are Document ops on the `messages` collection (persist + replay); chat ordering = store insertion order (hydrate/oplog order is chronological; MessageDocument carries no timestamp — display-only order, no protocol impact).
- Authorship spoof-proofing already enforced host-side (normalizeOps stamps data.author = session user, §4).

### D-064 — Unit 19: sheets (§10 M1) + projection visibility crossings (§5)

- SheetPanel (src/ui/sheets, shared GM+player): Actors/Items tabs, generic system-field editor (number/string/bool via dotted-path `system.<k>` diffs), name editing, GM-only create (+ New) and owner assignment (#assign-owner → ownership[userId]=3), read-only rendering when `can(user,"update")` fails.
- **Visibility crossings (real §5 gap found by this unit):** an update that replaces `ownership` can cross a session's read boundary. The plain projection either sends an update for a doc the viewer never received (grant) or drops the envelope entirely (revoke → stale replica). Fix in HostSync.broadcastEnvelope: pre-state ownership is reconstructed from the oplog inverses; per-session `projectWithCrossings` merges per-op projection with boundary rewrites — grant ⇒ full-doc create (same seq, materializes in the replica), revoke ⇒ delete. No new message types.
- **Client gap-skipping (D-065, same root):** envelopes omitted by a user's projection leave seq holes; ClientSync used to buffer them forever (the replica silently froze). The §6.1 ops channel is reliable+ordered, so a hole means "omitted for me": the client now advances with empty gap envelopes (txId "projected-gap", no mutations) and applies the arrived envelope. Echo store unaffected (it clones the committed store).
- SheetPanel reactivity is explicit (bus snapshot/ops → refresh; no $effects) — a $effect that refreshed $state raced into effect_update_depth_exceeded and killed rendering mid-edit.
- e2e detail: Playwright fill()+blur() does not reliably fire `change`; specs dispatchEvent("change") explicitly.

### D-066 — Nostr join, late-join gating, thumb-first client, M1 gap-closing (Unit 20)

- **Invite carries the host nostr pubkey**: `RoomInvite.hostPubkey?`; `buildInviteLink` appends `&h=<npub-hex>`; `parseInviteLink` reads it back. Backwards compatible (manual invites have no `&h=`).
- **Host share runs manual + nostr concurrently** (`src/app/hostShare.ts`): a second `HostSessions` bound to an eager `NostrSignalingAdapter` (its `selfId` pubkey is needed _before_ the invite is rendered — `SignalingStack` constructs its own adapters, so it cannot supply that; drive the adapter directly). Relays overridable via `?relay=` for e2e; defaults damus/nos.lol/nostr.band. `HostShare.nostrPubkey()` / `signalingKind()` exposed for UI/e2e.
- **Player join is nostr-primary when `&h=` present** (`src/app/joinBoot.ts`): 8 s ready-timeout race, manual fallback. `transportKind()` reports "nostr"/"manual" so the UI shows which path connected; `assetChunks()` / `cacheHas(hash)` surface §7 behavior for e2e.
- **§14 fix (real regression from D-065)**: ops arriving _before_ the snapshot on a fresh replica were gap-skipped as no-ops. `client/sync.ts` now buffers envelopes until `hasSnapshot` (set by the snapshot handler); D-065 gap-skip still applies to post-snapshot projection gaps. Covered by `tests/client/latejoin.test.ts`.
- **Thumbnail-first scene rendering** (App/JoinApp): scene shows `manifest.thumb` immediately ("ui" grade), full map streams by hash into "scene" grade; player e2e rejoin streams **0** chunks (cache hit, `assets.spec.ts`).
- **e2eHook hardening**: the pre-boot `installE2eHook(null)` can resolve _after_ JoinApp installs its surface and previously clobbered it — it now preserves any existing `app`/`player`/`share` surfaces. Added `PlayerSurface.sceneImg()`.
- **Manual-exchange specs use manual-only fragments**: `lib.manualFragment()` strips `&h=` (join/chat/crash/sheets) — with network access the nostr attempt would race the manual session binding. `nostr.spec.ts` covers the relay path against a local `ws` relay (`e2e/nostrRelay.ts`, kind 20_250, live-push only — relies on the adapter's re-offer backoff as expected for ephemeral relays). https boot verified with a self-signed cert (`https.spec.ts`).

### D-067 — Strategic sim core: PRNG, ModelPool, Sim codecs (Unit 21, M2)

- **`ModelPool.freeTop` added** to the §4A sketch interface (additive bookkeeping; the
  sketch's `free: Uint32Array` stack needs a top). No other implementors existed.
- **sys column storage** honors the §4A sys union `Float32Array | Int32Array | Uint8Array`:
  schema kinds f32/f64 → Float32Array; i32/u32/i16/u16/i8 → Int32Array (widened in-pool);
  u8 → Uint8Array. The wire codec packs to the _declared_ width regardless of storage.
- **hp/hpMax quantization decode order**: hp permille references hpMax[i]; applySimDelta
  applies the hpMax column before hp so an empty replica decodes against the new hpMax.
  Found by round-trip test (replica hp = code/1000 instead of code/1000×hpMax).
- **f32 sys codes travel as IEEE-754 bit patterns** (reinterpreted int32), not rounded —
  lossless. Quantized domains per §5A: x/y int16 grid/16, rot u16/2π, hp/hpMax u16 permille.
- **diffPools compares in the quantized domain** (sub-quantum drift → no column) and clears
  runs on fullResend columns. Deltas are byte-deterministic for identical inputs.
- **hashPool**: 4-lane FNV-1a over the live prefix only (dead slots past `count` are not
  logical state; free-list bookkeeping excluded) — 128-bit hex, the §5A replay proof token.
- Budgets verified in tests/sim: ≤200 B/model (actual 29 B base+2 sys); snapshot @10k well
  under 1.5 MB; delta @10% movement ≪ 200 KB; 5 Hz tick ≪ 30 KB.

### D-068 — mass-battle-basic RulesModule + TurnEngine reducer (Unit 22, M2)

- **Additive §5A state extensions**: `seed` on the orders/resolution/report/paused
  TurnEngine states and a `turn.ready {user, ready}` input (players toggle ready, §5A
  step 1) — the §0 sketch omitted both; the reducer needs them. `realtime?: RealtimeClockConfig`
  rides the orders state (paused already carried `config`).
- **TurnEngine is a pure reducer** (`src/host/turnEngine.ts`): every side effect returns as an
  explicit `TurnEngineEffect` (checkpoint → resolve → newTurn → restoreCheckpoint →
  realtimeCheckpoint → reject). Reject reasons are protocol strings ("phase_locked",
  "not_in_orders", …). Per-turn seed = `splitmix(initialSeed + turnNumber·0x9E3779B9)`.
- **mass-battle-basic** (`src/packages/massBattleBasic.ts`): profiles infantry/cavalry/artillery
  (overridable per-unit via `unit.profile`), sub-phases move→shoot→melee→morale→supply;
  units processed in ascending unit-id order; all dice from `rng.fork(hash(unitId))`
  sub-streams (order-independence, §5A). Morale break = 2d6 + courage < 7. Supply attrition:
  army `supply.level` 0 → one model per unit per turn. `detection()` honors
  `worldSettings.detectionMultiplier`. hp=1/hpMax=1 fixtures in tests keep combat legible.
- **§5A replay proof test**: clone Checkpoint N → resolve → hashPool; replay from the clone
  must reproduce the hash AND the full event list (tests/packages/massBattleBasic.test.ts).

### D-069 — SimWorker sandbox, HostSync⇄SimWorker bridge, §8A strategic stores (Unit 23, M2)

- **SimRunnerCore** (`src/sim/runner.ts`): the exact code inside the worker, factored to run
  in-process too. resolve() = freeze snapshot (Checkpoint N) → RulesModule.resolveTurn →
  turn-end compaction → modelRange/stat reconciliation → SimDelta + Checkpoint N+1 snapshot
  - canonical hash + ordered TurnReport. One runner per scene.
- **Canonical hashing**: `poolHash`/`hash()` hash the wire-quantized canonical form
  (`canonicalPoolHash` = snapshot round-trip then hashPool) — raw f32 pools carry sub-quantum
  noise (x=0.2 vs 0.1875), so identical logical states must hash identically. Found by the
  replica test: replica == decoded checkpoint but ≠ raw hash.
- **Checkpoints store the FREEZE (pre-turn) state** (§5A step 2 "writes Checkpoint N" at
  advance): resume of a mid-resolution turn re-runs deterministically from it. Storing the
  post-turn pool made "re-run" apply the turn twice (caught by hash mismatch).
- **SimWorker** (`sim.worker.ts`): deletes fetch/XHR/WebSocket/importScripts/indexedDB(±webkit)
  from the worker global before any rules code runs; speaks load/refresh/resolve/tick/hash.
  Clients: `WorkerSimRunner` (?worker&inline, host-side CPU-limit timer → terminate + restore,
  default 30 s) and `InlineSimRunner` (Node tests / same-thread fallback, trusted built-in
  rules only). Blob-URL RulesModule loading stays per §12 (mass-battle-basic ships in-bundle
  as the reference system; package loader is M3).
- **§8A stores** (DB v3, additive): checkpoints [worldId,sceneId,slot] (slot = turn|tick),
  turnReports (fflate-compressed JSON), simdeltas (ring, last 50). Retention: all checkpoints
  of the last 10 turns, every 5th older. world.zip export/import carries checkpoints/ +
  reports/ (older archives simply lack the dirs).
- **SimBridge** (`src/host/simBridge.ts`): start (resume-from-checkpoint or optional initial
  snapshot — the GM mass-spawn entry), resolveTurn (persist freeze + report + delta,
  retention), CPU-limit failure → best-effort checkpoint reload + rethrow. HostSync drives it
  from Unit 24 (HostSync remains the only SimWorker talker, §2).

### D-070 — DetectionGrid + per-faction sim/report projection (Unit 24, M2)

- **DetectionGrid** (`src/host/detection.ts`): cell = 5 grid squares (configurable); faction
  bitmask per cell (≤31 factions/scene); sources = unit anchors × RulesModule.detection radius.
  LOS per cell pair against sight-restricted walls (`WALL_SIGHT_BIT = 1<<1` per the §0
  RulesWallsContext convention), order-independent quantized pair key, cache invalidated when
  the caller's `wallsVersion` changes (reseed then refills — verified by a moved-wall test).
  Allies share vision by default (§5A).
- **Faction projection** (`src/host/simProjection.ts` + `codec.projectSimDelta`): deltas are
  filtered index-based, once per faction per delta (never per user); projected columns carry
  rebuilt RLE runs; count is preserved (hidden indices simply never update). GM unfiltered.
- **TurnReport projection**: events whose subject is undetected become `{type:"unknown",
text:"unknown enemy activity"}` stubs; detected subjects with hidden targets keep the event
  but have target refs scrubbed (delete targetUnitId/modelIndices, text redacted).
- Found while testing: my own two precedence bugs (`?? 0 | bit` mixing — SyntaxError-adjacent;
  `restriction[i] ?? 0 & BIT` which silently disabled ALL walls) — both caught by the wall
  tests before they could ship.

### D-071 — HostSync sim channel: TurnChannel + ClientSync replica (Unit 25, M2)

- **TurnChannel** (`src/host/turnChannel.ts`): owns the stepwise turn loop on top of SimBridge.
  `start(mode, initial)` seeds the runner from store armies (unitViews: armies sorted by `_id`,
  stable unit order = pool unitIdx order — tests must seed pools in that order); `advance()`
  resolves the turn (orders, `turnSeed(seed, turn)`, turnNumber), then commits ONE ops envelope
  (unitStatDiffs + modelRange diffs + turn doc phase) with the inverse kept for undo. Resolve
  failures reopen the same turn in orders (determinism-safe retry) and record `lastError`;
  engine "paused" maps to wire phase "orders".
- **Visibility on the wire**: per-faction visible-index bitmaps (DetectionGrid, merged per-user
  across userFactions) drive `projectSimDelta/Snapshot` (players) vs raw delta (GM) and TurnReport
  stubbing. `sendSnapshotTo` serves `sim.snapshot.get` (gap recovery) with the same projection.
- **Two stale-range bugs found by the e2e tests, both the same class**: after compaction the
  runner computed post-turn `strength` from PRE-compaction `modelRange`s (blue's attrition kill
  was charged to red because compaction shifted every slot down by one), and the channel's report
  stubbing used doc ranges against the compacted pool. Fix: `statSnapshots(ranges?)` takes the
  `recomputeRanges` result; `broadcastSimTurn` overlays `result.rangeDiffs` onto its range map.
  Rule recorded: **anything indexing the pool after a resolve must use post-compaction ranges.**
- **ClientSync replica** (`src/client/sync.ts`): `sim.delta` applies when `from === version`;
  gap queues + sends exactly one `sim.snapshot.get` (`snapshotInFlight` latch); snapshot installs
  the pool then replays queued deltas in order, emitting a `sim` event per applied frame
  (`snapshot:v0`, then `delta:v1`, `delta:v2`, …) — UI re-renders see real per-frame versions.
  Stale deltas after a resync (undo race) are dropped. Public: `simReplica`, `simReplicaVersion`,
  `setTurnReady`, `simControl`, `requestSimSnapshot`.
- Chain: tsc/eslint/prettier clean; 368 passed / 3 skipped (50 files); build 838,956 B raw /
  256,792 B gzip; e2e 14/14.

### D-072 — ModelLayer (instancing/LOD/culling) + SpatialHash (Unit 26, M2)

- **ModelSpatialHash** (`src/canvas/spatial`, cell 5 = DetectionGrid parity): mirrors x/y so
  `applyDelta(pool, delta)` moves only the union of changed x/y indices between cells; a pool
  count change (spawn / end-of-turn compaction shifts indices) or any fullResend column falls
  back to full `rebuild`. Random-move property test: applyDelta ≡ rebuild across 4 deltas × 12
  sample rects. queryPoint is nearest-first and filters dead+hidden; unitAtPoint/unitsInRect
  map model hits to OWNING units (§9A selection targets Units); cellEntries feeds DetectionGrid.
- **Hidden-slot rule carries into rendering**: projected player replicas zero positions and set
  `status|=hidden` — every draw/cull/hit path (bbox, drawableModelIndices, strengthFraction,
  hash queries) must skip dead+hidden or hidden enemies pile up at the origin and wreck bboxes.
- **LOD** (`lod.ts`, pure): zoom thresholds (LOD1 < 0.6, LOD2 < 0.22) with a ±15 % hysteresis
  band a unit must fully exit to switch — state is zoom-driven ONLY; density demotion (drawable
  models > budget 12k → largest-first demote LOD0→LOD1, id tie-break) is a pure per-frame
  overlay so it cannot oscillate against hysteresis. Density counts DRAWABLE models, not range
  length (deaths free LOD0 headroom).
- **ModelLayer** (`layers/ModelLayer`): LOD0 = one ParticleContainer (sanctioned §9A API),
  pooled Particle objects, fields written per-unit in a tight loop from the pool's typed arrays
  (no per-model display objects, no per-model allocation once warm); directional stand texture
  (tintable body + full-bright head) generated via renderer.generateTexture — file://-safe.
  LOD1 = pooled per-unit Graphics (formation bbox + green→red strength bar + banner, redrawn
  only when a bbox/strength/zoom-bucket key changes). LOD2 = per-army marker at model-weighted
  centroid. Selection rings at every LOD; hitTest/unitsInRect via the hash. Stage gained the
  `models` layer between tokens and controls (full §9 stack lands with walls/vision); LAYER_ORDER
  is now background/grid/tokens/models/controls and the smoke e2e expects 5 layers.
- Layer `sync()` rebuilds its hash each call (O(n), same order as the particle loop);
  incremental `hash.applyDelta` is the realtime path for the interactions unit (next).
- Chain: tsc/eslint/prettier clean; 387 passed / 3 skipped (53 files); build 869,265 B raw /
  266,311 B gzip; e2e 15/15 (new models.spec: 13k models, density demotion, hit-test,
  box-select from file://).

### D-073 — Unit interactions + order overlays + pluggable measurement (Unit 27, M2)

- **Measurement** (`src/canvas/grid/measure.ts`): the §9 555/5105/euclidean API —
  cellDistance / measureSegment / measurePath in world units (grid size = world units per
  cell; gridless + hex measure euclidean until the hex unit). captureWaypoints quantizes a
  drag trail (≥ minSpacing from last capture, cap 12 = §4A, same-ref return when unchanged);
  callers append the release point explicitly.
- **Order intents** (`interactions/unitOrders.ts`): gestures/shortcuts → ONE update Op per
  unit on the embedded doc (`orders.pending` flat-diff replace; Order[] cast through Json —
  named interfaces lack Json's index signature). Optional RulesModule validateOrder gates
  every order (first failure per unit → onInvalid). Shortcuts: m/c arm move(march/charge),
  a arms attack, r arms retreat, h commits hold immediately. contextActions() data-drives the
  right-click menu (attack on unit; move/charge/retreat/hold on empty).
- **Controller** (`interactions/unitController.ts`, port-injected like the M1 token one):
  click select / shift-toggle / marquee box-select via ModelLayer hash; drag unit→unit =
  attack (whole commandable selection); drag unit→map = move with ruler-spaced waypoints;
  right-click empty = move-here, shift+right = append waypoint to existing pending move;
  right-click cancels armed mode; ownership gate (canCommand) filters everything. RTS
  selection semantics (test-driven fix): pressing a unit already in the selection KEEPS it so
  the drag issues to the whole selection; shift-click toggles off.
- **Overlays** (`interactions/orderOverlays.ts` pure + `layers/OrderOverlay.ts` renderer):
  geometry from Unit.orders (move → path with anchor prepended; charge → bold red arrow;
  attack → dashed target line + crosshair; retreat → grey path; hold/formation/supply draw
  nothing), visibility = owning faction, GM sees all (orderVisibility predicate). Renderer
  redraws one Graphics per sync with scale-compensated strokes and pooled length labels;
  syncPreview draws the live drag (move path + ruler length / attack line).
- e2e modelsSmoke now also draws committed overlays + a preview from file:// (geometry
  counts asserted).
- Chain: tsc/eslint/prettier clean; 407 passed / 3 skipped (54 files); build 874,732 B raw /
  268,359 B gzip; e2e 15/15. /opt was wiped again mid-unit — standard recovery rerun.

### D-074 — Armies tab + Army Management Window (Unit 28, M2)

- **Pure layer** `src/ui/armies/armyModel.ts` (fully unit-tested): armyCards aggregation;
  flattenTree (Army → echelons grouped by unit type, sorted → Units — the §4A flat
  army.units list makes the echelon level a type grouping); moveUnitOps (drag-drop reorg =
  delete + embedded create under the new parent; modelRanges are scene-pool state and carry
  over); rosterRows (unit rows + expanded model rows read from client.simReplica; hidden
  slots of projected replicas collapse to a single gap row; dead models stay listed);
  windowRows (fixed-height virtualization math with overscan); sort/filter (sortRoster takes
  the UNIT list so it composes with filterRoster — the initial army-doc/tunits[] mismatch
  crashed the window at runtime while each helper passed tests in isolation: compose the two
  in a test too now); ORDER_TEMPLATES (advance/screen/fallBack relative to anchor+facing);
  report filters, casualtySummary, RFC-4180 eventsToCsv; rulesContextFromStore (client-side
  §12 RulesContext mirroring TurnChannel.rulesCtx for validateOrder/forecast).
- **Components** (Svelte 5 runes, ChatPanel pattern): ArmiesTab (cards from the replica,
  drop target for cross-army unit drags via dataTransfer) and ArmyWindow (Hierarchy/Roster/
  Orders/Reports tabs; ready toggle rides turnPhase/turn.ready; orders are embedded update
  Ops with per-unit validateOrder feedback; CSV export via Blob; SvelteSet for reactive
  selection — eslint svelte/prefer-svelte-reactivity).
- **e2e** armiesSmoke (e2e/armies.spec.ts, 16th test): REAL ClientSync↔HostSync over the
  memory transport in the bundle — cards render, window opens, tree click selects, the
  Advance template's op round-trips into the store, 120-unit roster renders 25 rows.
  Debugging lessons: Svelte 5 effects flush on the microtask queue — DOM queries after
  mount()/click need a flush first; a failed `pnpm build` leaves the old dist running, so
  always check build exit status before re-running a browser debug.
- Chain: tsc/eslint/prettier clean; 420 passed / 3 skipped (55 files); build 925,414 B raw /
  285,761 B gzip; e2e 16/16.

### D-075 — walls + vision.worker + lighting/fog (Unit 29, M2)

- **Restriction semantics finalized** (`canvas/vision/wallSight.ts`): axis codes 0 blocks /
  2 permits (§0) and 1 conditional = door state, with doors 0 closed / 1 open / 2 locked
  (spec left the pairing implicit — this is the recorded choice). Conditional walls block
  unless the door is open; an open doorway must be a real gap (two solid walls + the
  conditional segment between) — a conditional wall OVER a solid one stays opaque.
- **Visibility polygon** (`canvas/vision/polygon.ts`): angular sweep — endpoint events
  sorted, STARTS before ENDS at equal angles (a hand-off at a shared corner must not
  empty the active set), spans crossing 0° pre-seeded as active, and radius-capped arcs
  sampled at 64-step so open regions are proper arc polygons (a single chord made
  degenerate 2-vertex polygons). Two float traps fixed by tests: rays aimed EXACTLY at a
  wall endpoint miss by ±1 ulp on the segment parameter — the u-bound check needs 1e-9
  tolerance; and boundary vertices are outside ray-cast point-in-polygon by construction
  (assert numeric bounds instead).
- **vision.worker** (`workers/vision.worker.ts` + client): transferable Float32 segment
  quads in / polygon out; the client takes an injectable Worker ctor (real
  `?worker&inline` in the e2e bundle, InlineVisionWorker for Node); the worker module is
  Node-importable (`self` guarded, handler exported) so the REAL message handler is
  unit-tested through a stub worker scope.
- **Layers**: WallsLayer (GM overlay: restriction colors, dashed conditionals, one-way
  chevrons, door-state dots, version-keyed redraw); LightingLayer (colored ambient
  darkness rect + per-light additive radial-gradient FillGradients drawn in a local
  0-1 frame and clipped by the light's visibility polygon); FogLayer (512px explored
  RenderTexture, opaque black, reveal = erase-blended polygons that ACCUMULATE;
  128px PNG readback via extract+canvas). Stage now mounts the full §9 order — 14
  containers, tilesBelow before grid (first build had it after) — asserted by the canvas
  smoke e2e.
- **fog.put wired end-to-end**: ClientSync.sendFogPng(sceneId, png) → HostSync stores
  per `${sceneId}:${userId}` (fogPngs getter; IDB persistence rides the world-file unit).
- Chain: tsc/eslint/prettier clean; 431 passed / 3 skipped (56 files); build 941,192 B
  raw / 291,050 B gzip; e2e 17/17 (new vision.spec: worker polygon through an open
  doorway, wall shadow, layers, fog readback 750 B, fog.put landed).

### D-076 — hex grids (4 layouts) + gridless + templates + drawings (Unit 30, M2)

- **Hex math** (`canvas/grid/hex.ts`, pure): the §0 HexLayout quartet (evenQ/oddQ flat-top
  columns, evenR/oddR pointy-top rows) via offset ⇄ axial ⇄ pixel with cube rounding.
  `size` = circumradius (center→corner) — the recorded unit choice. Grid layer draws
  hexesInView outlines; `snapPoint` unifies square-intersection / hex-center / gridless
  identity snapping. Hex measurement = cube distance between containing hexes × size
  (diagonals rule is square-only).
- **Template semantics recorded**: circle distance=radius; ray distance=length &
  width=corridor breadth with ROUND CAPS (points ≤ half-width past the end hit); cone
  width=aperture in DEGREES around `direction`; rect distance×width rotated by direction.
  pointInTemplate hit-tests all four; TemplatesLayer draws fills+measured labels.
- **DrawingsLayer**: freehand (open polyline), poly (closed+optional fill), rect, text
  (fontSize from strokeWidth); drawingBounds pure helper (needs ≥ 2 points).
- Boundary-point lesson repeated: ray-cast hit tests are unstable exactly ON edges —
  tests probe strictly-interior/exterior points (same class as the U29 polygon issue).
  Cube-round note: the y-axis reset leaves BOTH axial coords unchanged; getting that
  wrong silently corrupts half the hexes (caught by the nearest-center property test).
- Chain: tsc/eslint/prettier clean; 451 passed / 3 skipped (57 files); build 950,789 B
  raw / 293,977 B gzip; e2e 18/18 (new grids.spec: in-page hex snap + layer draws).

### D-077 — combat tracker + roll tables + folders + chat commands + markdown (Unit 31, M2)

- **Combat tracker** (`core/combat.ts`, pure transitions returning hook names — the
  caller fires them on the §3 `globalHooks` bus): initiative sort (desc, nulls last,
  defeated last, stable), start/end, next/previous turn with round wrap, delay,
  defeat, initiative application, effect-duration ticks on the owner's turn end.
  Delay & durations ride `flags.core` (§0 FlagStore is SCOPED `{[scope]: Record<string,
Json>}` — first attempt used flat flags and broke; empty scopes are dropped on clear).
- **Chat command semantics**: `/roll|gmroll|blindroll|selfroll <formula>` (whole
  argument IS the formula, evaluated host-crypto via client.roll §11);
  `/w <name[,name…]> <message>` — FIRST token names recipients (comma-separated),
  greedy multi-token name heuristics rejected (ambiguous, untestable); `/me`/`/emote`,
  `/ooc`; unknown commands echo as speech. Inline `[[formula]]` rewrites to
  `[[total|formula]]` chips (the renderer's existing format).
- **Markdown** (`core/markdown.ts`): escape-FIRST then transform a fixed subset
  (h1-3, bold/italic/code/strike, lists, quotes, http(s)-only links, paragraphs);
  javascript: URLs stay inert escaped text. Chat renders markdown per non-chip
  segment (scoped svelte/no-at-html-tags disable documented).
- **Roll tables**: inclusive ranges, gap re-roll (≤25), overlap/inversion validation,
  broken formula → missed draw (no throw in chat flow), documentRef passthrough.
- **Folders**: scoped-targetType trees, depth-first flatten, cycle-safe moves
  (tolerates pre-existing cycles), display paths.
- Toolchain NOTE: /opt was wiped by a sandbox recycle mid-unit — rebuild recipe:
  mkdir /opt/{toolchain,pnpm-store,pw-browsers}; corepack enable --install-directory
  /opt/toolchain/bin; corepack prepare pnpm@10.34.5 --activate; pnpm install
  --frozen-lockfile; playwright install chromium (env: PATH, npm_config_store_dir,
  COREPACK_HOME=/opt/toolchain/corepack, PLAYWRIGHT_BROWSERS_PATH).
- Regex lesson: `[^\][]` parses as a never-matching empty class in Annex-B — use
  `[^[\]]`; no-useless-escape only tolerates the NECESSARY `\]` escape.
- Chain: tsc/eslint/prettier clean; 492 passed / 3 skipped (60 files); build 962,338 B
  raw / 297,575 B gzip; e2e 19/19 (new combat.spec: start→init→turn wrap→delay→defeat).

### D-078 — playlists/audio §7 + journals/tables/playlists panels + sidebar tabs (Unit 32, M2)

- **audio.cmd (0x0c, both directions, ops channel)**: client→host request
  {playlistId, soundId, action play|stop|pause|resume, offset} (GM/ASSISTANT
  only, else rejected); host stamps atHostTime = now + 120 ms lead and
  rebroadcasts to ALL sessions incl. the GM loopback (§2 GM UI speaks only
  ClientSync). NTP-style sync: ping {t0} → pong {t0,t1,t2} → client t3; best
  estimate = lowest-RTT sample of the last 8; offset = ((t1−t0)+(t2−t3))/2;
  client starts playback at atHostTime − offset (scheduleDelayMs). PROTOCOL.md
  - contracts/frame tests extended to 29 kinds.
- **AudioPlayer**: lazy AudioContext (constructed on FIRST play command) —
  a boot-time `new AudioContext()` froze Playwright actionability in headless
  (stability gate needs rAF; the audio thread starved it). Sounds resolve
  data:/http(s) URLs directly (§7 external refs) or asset hashes via the
  injected fetcher; decode → schedule → per-sound state machine
  (loading/playing/suspended/stopped/error) exposed for UI + e2e.
- **Playlist modes** (mode is a §4 string): off | sequential | loop | shuffle
  (shuffle = uniform other-sound, guard fallback idx+1). Pure nextPlaylistSound.
- **Sidebar tabs** (§10): Chat (default) / Combat / Journals / Tables /
  Playlists / Actors(SheetPanel); GM controls stay outside tabs.
  Layout traps fixed: (1) tabbody must be `flex: 0 0 auto` — a flex-compressed
  tabbody paints its overflow UNDER later siblings (h3 "World file" literally
  intercepted clicks — elementFromPoint found the h3 at the button's center);
  (2) e2e viewport standardized 1280×960 (D-078). ChatPanel now re-renders only
  when messages-collection ops arrive (handshake op storms kept the send row
  "unstable").
- JournalsPanel: GM edit (whole `pages` array diff — embedded docs ride the
  parent), markdown render, `<secret>` blocks highlighted for GM (stripped by
  §5 projection for players, core-tested). TablesPanel: draw → chat message
  with roll record. PlaylistsPanel: play/stop → sendAudioCmd, mode select.
- Chain: tsc/eslint/prettier clean; 503 passed / 3 skipped (61 files); build
  985,169 B raw / 304,126 B gzip; e2e 21/21 ×2 consecutive runs (new
  parity.spec: clock sync |offset|<5 s, audio loop lands + scheduled ≥ 0,
  secret visible, table→chat; journals tab test).

### D-079 — window manager + permissions/undo/macros/settings UI (Unit 33, M2)

- **WindowManager (core/windows.ts, pure)**: open (clamp+focus+restore), close,
  focus/z-bump, drag (title bar stays reachable), resize (min 180×120, parent
  bounds), minimize, setBounds re-clamp. Chrome renders INLINE in WindowHost —
  geometry/z/minimized sync via a Svelte ACTION (bindWindow) subscribed to the
  manager, NOT via template reactivity.
- **Svelte 5.57 compiler trap (root-caused via compiled-output diffing)**:
  {#each} items that only feed CHILD COMPONENT props compile as snapshots
  (flags 17) — item-field reads INSIDE the block compile reactive (flags 21).
  Symptom: window opens (array identity change reconciles) but drag/resize/z
  never repaint. Store-derived arrays in App must also be SPREAD-COPIED
  (store.getAll returns a live array; identical refs make keyed eachs bail).
  Also: pointer-capture drags die when the captured element re-renders →
  global move/up listeners instead; .wm-layer AND .shell need overflow:
  visible or the resize handle below the canvas edge is clipped away
  (elementFromPoint returned <html>).
- **GM toolbar + windows**: Perms/Macros/Settings open as floating windows;
  Undo/Redo buttons → HostSync.undo/redo (GM tab IS the host, §2); journal
  Popout button per page. Permissions window: role selects (users ops) +
  doc ownership editor (default + per-user overrides) on actors/items/
  journals/rollTables. Macros: chat macros (parse+buildChatMessage / client.roll
  for /roll), flags.core.slot 1-5 → hotbar buttons + keybindings; SCRIPT macros
  stored but NOT run until the M3 system API. Settings: scene grid editor
  (type/hexLayout/size/distance/units/diagonals → scene op; canvas now takes
  the full §9 GridSpec incl. hex/gridless via sceneGridSpec; interactions use
  snapPoint for all three), keybinding reference, undo/redo.
- **Scene nav + players**: scene buttons (active flag ops, activeScene()
  respects the flag with DEFAULT_SCENE fallback), "+" creates scenes,
  player list with roles.
- e2e viewport 1280×960 (D-078) kept; windows.spec covers drag/resize/z-order/
  close, undo↔redo of token creates, macro create→slot→hotbar-click AND key
  run, grid-size op round-trip, scene add+switch, journal popout secrets.
- Chain: tsc/eslint/prettier clean; 513 passed / 3 skipped (62 files); build
  1,010,674 B raw / 311,003 B gzip (< 6 MB); e2e 26/26 (+5 windows specs),
  repeated ×3 green.

### D-080 — strategic fog + GM extras panel (Unit 34, M2)

- **Strategic fog (§9A)**: `sceneIsStrategic` gates on `flags.core.scale ===
"strategic"`; `buildStrategicFog` (src/core/strategicFog.ts) seeds a
  DetectionGrid from ally-unit anchors (mean live-model position per unit,
  `unitAnchor`) using massBattleBasic detection radii; `undetectedRectsInView`
  returns the dark cell rects for the view rect. **Allies must be passed
  explicitly** to the cell queries — `buildStrategicFog` returns
  `allyFactionIds` (viewer + allies) and the caller forwards
  `allyFactionIds.slice(1)`; a bare `factionCellRects(id)` sees only own
  vision. StrategicFogLayer draws covers (0x05070c α0.82) with zoom-bucket +
  rect-list dedupe (`fogSyncKey`, pure core — pixi Graphics cannot load in
  node tests, so the layer itself stays untested below e2e). App syncs fog on
  a 300 ms timer; god view / no faction / non-strategic scene / EMPTY POOL all
  clear the layer (empty pool is a clear, not all-dark).
- **Honesty gap resolved**: the scene editor (Settings window) gained a Scale
  select writing `flags` as a whole-object scene update op (FlatDiff cannot
  create missing intermediates, D-012) — the flag is now settable in-product.
- **GM extras panel** (`#gm-extras` → window kind `gmextras`): faction editor
  (create + ally-checkbox ops), god-view checkbox + view-as-faction select
  (`gmState` module rune), mass spawn (army create op embedding ONE Unit doc
  with strength=count, modelRange null), casualty/heal (strength ±delta
  clamped ≥0 via army units array rebuild), batch orders (ORDER_TEMPLATES
  appended to selected units' orders.pending as multi-army update ops).
  SvelteSet lives at module scope WITHOUT $state (no-unnecessary-state-wrap;
  exported from svelte/reactivity, mutated in place).
- **KNOWN GAP → M2 §8A**: nothing materializes pool models — SimRunnerCore
  starts an EMPTY pool and no deploy step exists anywhere, so a faction
  preview on a strategic scene never shows cover rects until campaign-start
  deployment lands (mass-spawn "sim materializes models per profile" is
  aspirational). e2e therefore asserts the implemented gates (scale flag
  round-trip, god view, viewAsFaction plumbing, cleared layer); model-seeded
  cover rides the 10k-model stepwise E2E.
- **e2e surface pattern**: `__vttE2E.gm` (installGmFogE2e from App onMount)
  exposes rectCount/sceneScale/godView/viewAsFaction/armySnapshot; evaluate
  callers must invoke the method INSIDE page.evaluate (functions cannot cross
  the structured-clone wire). Bootstrap world ships NO factions/armies — specs
  create them via the panel.
- Chain: tsc/eslint/prettier clean; 520 passed / 3 skipped (63 files); build
  1,026,945 B raw / 315,984 B gzip (< 6 MB); e2e 28/28 (+2 gmextras specs),
  repeated ×3 green.

### D-081 — §8A model deployment + campaign controls (Unit 35, M2)

- **Deployment** (`src/sim/deploy.ts`, pure): `deploySnapshot(units, factions,
sys)` materializes each unit's `stats.strength` into pool models when a
  campaign starts with no stored checkpoint and no injected snapshot.
  Deterministic layout: factions sorted by id get x-lanes (150 + k·300), units
  stack in y (150 + j·250); `profile.anchor {x,y}` overrides. Formations: line
  (ranks of 10, rectangle-centered), column (files of 4), wedge (triangle
  rows); hp/hpMax 1, sys.ammo 6. `TurnChannel.start` passes the deployment as
  the initial snapshot, commits modelRange ops (units w/ army parent), and
  broadcasts per-faction snapshots — a stored checkpoint still wins (resumed >
  0 skips the deploy path). `sim.control` gained action "start" (mode extra;
  engine rejects turn_active) — no new MsgKind.
- **App wiring**: hostBoot now constructs SimBridge (InlineSimRunner — worker
  offload stays §12) + TurnChannel per boot (seed = worldId hash) and the GM
  loopback ClientSync passes simSys/simSceneId so the GM tab actually receives
  sim frames (previously the channel existed only in tests — nothing could
  start a campaign). GmExtrasPanel "Campaign" section: start (stepwise)/
  advance/next buttons + phase chip from turnPhase frames.
- **Fog closes the loop**: e2e now drives mass-spawn ×2 factions → campaign
  start (40 models, simCount readback) → advance/report → next/orders → god
  view off → cover rects > 0 → god view clears. The D-080 "no deploy" honesty
  gap is resolved ahead of the 10k spec.
- **Test-isolation trap**: turnChannel tests share ONE IDB database — §8A
  checkpoints persisted across tests and a resumed checkpoint silently
  overrides injected initial pools (invisible while every test injected
  byte-identical pools). setup() now takes a unique worldId per test.
  `-0` vs `0` breaks toEqual in offsets — compute as `0 - rank*spacing`.
  Fresh-sandbox note: /opt rebuild ALSO needs apt libnspr4 libnss3 libatk1.0-0
  libatk-bridge2.0-0 libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libdrm2
  (+ libasound2*) for the headless shell.
- Chain: tsc/eslint/prettier clean; 533 passed / 3 skipped (64 files); build
  1,055,101 B raw / 324,210 B gzip (< 6 MB); e2e 28/28 ×3 green.

### D-082 — M2 acceptance: 10k 2-player stepwise E2E + cross-browser (Unit 36, M2)

- **e2e/m2.spec.ts (§19)**: two browser contexts join over the REAL manual-
  signaling WebRTC path (same exchange as join.spec); GM creates 2 factions +
  4×2500-strength armies via GM extras, grants the player OBSERVER on a
  faction through the permissions window (factions/armies added to EDITABLE —
  §4A ownership cascade), starts the stepwise campaign (10,000 models deploy +
  per-faction snapshot broadcast), issues a batch move order, advances
  (projected delta + report to the player), and reopens orders via next.
  Budgets asserted: deploy ≤ 15s and advance ≤ 15s (observed ≈1–2s each incl.
  projections). Player readbacks extended: simCount/simVersion/turnPhase/
  reportEvents (tracked on the player bus); GM surface gained simCount/
  turnPhase/factionOwnership. Join client now passes simSys/simSceneId (the
  player page previously could not receive strategic frames at all).
- **Empty-report trap**: no orders + supply 5 → resolveTurn emits ZERO events;
  reportEvents assertions need a guaranteed event (batch move template before
  advance). Report delivery itself was already correct — the probe showed
  delta+phase arriving with an empty report.
- **Window-overlap trap bit again**: permissions opens on top of GM extras and
  swallowed the campaign-start click; the spec closes it after granting.
- **Cross-browser (playwright projects firefox/webkit added; browsers under
  /opt/pw-browsers + `playwright install-deps firefox webkit`)**:
  - webkit 29/29 after two real fixes: (1) opaque-origin workers under file://
    cannot decode Blobs (`blob:null/…`) — asset job logic extracted to
    assetJobRun.ts; AssetWorkerCodec falls back to the SAME runner on the main
    thread with a robust decode (direct bitmap → Image/data:-URL → canvas);
    worker stays the primary path (§17). Firefox main thread ALSO fails direct
    Blob bitmaps — same fallback covers it. (2) assets rejoin: webkit
    regenerates the answer code slower than the old blind 2s drain — the spec
    now polls for a DIFFERENT answer. WebKit file:// Cache API is memory-only
    per page → rejoin re-streams exactly 1 chunk (allowed for webkit in-spec;
    chromium still asserts 0).
  - firefox: 20/20 non-WebRTC specs; the five RTC-joining specs (webrtc, join,
    assets, sheets, m2) cannot connect IN THIS SANDBOX — ICE/DTLS for firefox
    is blocked (chromium+webkit loopbacks pass in the identical environment;
    firefox fails headless AND headed under xvfb). Environment constraint
    recorded, not an app regression.
- Chain: tsc/eslint/prettier clean; 533 passed / 3 skipped (64 files); build
  1,058,133 B raw / 324,955 B gzip (< 6 MB); e2e chromium 29/29 ×3, webkit
  29/29, firefox 20/20 (non-RTC).

### D-083 — §9 tiles/pings/rulers closeout (Unit 37, M2)

- **Pure core** (`src/canvas/ephemera.ts`): pingPhase (ease-out, 1.4s TTL),
  rulerAppend (cap 12, §4A), rulerLabel, tileAlpha (below=1 / fade=α /
  roof=α only under occupancy), rectsOverlap, tileTint (FNV-hash hue for
  imageless tiles). Layers stay thin pixi drawers; node tests cover behaviour
  (pixi can't load in node — same split as StrategicFogLayer).
- **TilesLayer** (below/above stage containers): tinted-rect placeholder with
  a loadTexture port (asset hash via GM fetcher → blob URL → pixi Assets;
  external URLs load directly); roof outline rides a texture. FIRST PASS BUG:
  alpha was baked into the fill color while the readback read g.alpha (always
  1. — alpha now lives on the view, g.alpha carries it for the placeholder.
     App refresh() computes occupied rects = vision-token rects; roofs over them
     fade to occlusion.alpha (GM affordance), fade tiles ignore occupancy.
- **EffectsLayer** (effects container): spawnPing (expanding ring, ticker
  driven), showRuler per user (polyline + waypoint dots + measurePath total
  label in grid units, 2.5s linger + fade), tick(dtMS) from the stage ticker.
- **Interactions** (tool-less mapping preserved): alt+click = ping (port
  onPing, never selects/drags), ctrl+click = snapped ruler waypoint append
  (port onRulerChange; [] clears), Escape clears (App keydown). PointerEvt
  gained optional altKey/ctrlKey (DOM adapter maps them; node fakes default
  them absent). Rulers broadcast on the §5 ephemeral channel (sendEphemeral,
  ≤20Hz bucketed); remote pings/rulers render from the bus "ephemeral" event.
  Animated token movement was already the ticker glide (kept, unchanged).
- **Bundle trap**: `await import("pixi.js")` inside App.svelte inlined a
  SECOND pixi copy into the single-file bundle (+290 KB) — static import
  shares the stage's chunk. SvelteMap satisfies prefer-svelte-reactivity for
  the non-reactive texture cache (used as a plain Map).
- e2e `ephemera.spec.ts` (chromium ×3, webkit ×1): ping spawn + TTL expiry,
  ruler 2 waypoints + Escape, roof 0.25 over a vision token → 1 after a
  canvas drag off, fade 0.4 constant, floor 1 constant; seedTile rides the
  real client op path.
- Chain: tsc/eslint/prettier clean; 542 passed / 3 skipped (65 files); build
  1,066,516 B raw / 327,499 B gzip (< 6 MB); e2e chromium 31/31 ×3, webkit
  spot-check green.

### D-084 — §11 bulk sim dice + TurnReport distributions (Unit 38, M2)

- **Engine @path AST nodes**: the formula parser now emits `{t:"data",path}`
  atoms resolved from rollData AT EVAL TIME (was: string substitution
  pre-parse). evaluateFormula/validateFormula parse @paths natively;
  substituteData stays exported. NEW `compileFormula(formula)` →
  CompiledFormula{evaluate(data?, rng?)} — parse once, evaluate many.
- **BulkDice** (`src/dice/bulk.ts`): implements the §5A PRNG interface
  (delegates raw draws to XoshiroPRNG — stream-identical, so every pinned
  determinism test still passes) + `roll(formula, data)` through a per-turn
  compile cache (Map + parseCount/formulaCount readbacks) + `forkDice(sub)`
  sharing the cache. SimRunnerCore resolve AND tick now hand rules a BulkDice
  seeded from the per-turn seed; mass-battle-basic keeps its arithmetic (raw
  draws) — formula-ified mechanics are the module's choice, deferred.
- **Distributions** (`src/core/reportSummary.ts`): summarizeDistributions over
  SimEvents → byType/bySubPhase/totals/damageByUnit(top-6 by wounds→hits)/
  routRolls histogram; stored as TurnReport.summary.distributions (Json
  round-trip). ArmyWindow reports tab renders the line (type counts · top
  damage units · break rolls). Player e2e surface gained reportByType; m2
  spec asserts arrive ≥ 1 (move orders emit type "arrive", not "move").
- Chain: tsc/eslint/prettier clean; 553 passed / 3 skipped (67 files); build
  1,069,333 B raw / 328,366 B gzip (< 6 MB); e2e chromium 31/31 ×3, webkit
  spot-check green.

## D-085 — §7 sprite atlases (Unit type × faction palette)

- **Planner** (`src/canvas/layers/ModelLayer/atlases.ts`, pure/testable): frame
  16 px, 4×4 grid = 16 frames/atlas; frame key `m-{fnv8(unitType)}-{palette
hex6}`, atlas id `atl-{fnv8(keys "|")}`; entries dedupe; plans cap at
  MAX_BOUND_ATLASES = 16 with overflow **dropped** (fallback rendering).
  `bindDecision(bound, wanted, max)` keeps the NEWEST `max` wanted ids
  (wanted is oldest→newest) — slice, don't loop.
- **ModelLayer**: `registerAtlases(plans)` builds one 64×64 base per plan via
  `renderer.generateTexture` (glyphs palette-baked per type: cavalry wedge,
  artillery wheel+barrel, skirmish/archer lozenge, default directional
  stand), subframes via `new Texture({source, frame: Rectangle})`; evicted
  atlases destroy base+subframes. `writeParticles` prefers the atlas frame
  (tint 0xffffff) over the tinted stand marker; scale math unchanged (both
  16 px). `atlasStats()` readback; destroy() cleans bases.
- **DrawableUnit.type** now carried from UnitDocument.type (modelsSmoke uses
  infantry/cavalry/artillery × 2 palettes → 1 atlas, 3 frames, 0 dropped).
- Chain: tsc/eslint/prettier clean; 559 passed / 3 skipped (68 files); build
  1,072,772 B raw / 329,493 B gzip; e2e chromium 31/31 ×3, webkit spot 3/3.

## D-086 — §12 RulesModule loader from package blob URL inside worker

- **Loader** (`src/sim/rulesLoader.ts`): `importRulesModule(source)` — Blob URL
  created and imported INSIDE the sandboxed worker (§12 path), data: URL
  fallback (Node), then `evalRulesModule` for engines whose classic workers
  reject module-script imports AND allow eval (single `export default
<expression>` form only). `validateRulesModule` shape-checks the §12
  contract (schema fields incl. modelColumn types, required/optional fns)
  with specific errors; `RulesModuleRegistry` caches by exact source text.
  urlScheme echo: "blob" | "data" | "eval".
- **Why blob must be worker-created**: on file:// origins Chromium classic
  workers cannot import page-created blob: or data: URLs ("Failed to fetch
  dynamically imported module") but CAN import blob: URLs the worker itself
  created — the source text crosses via postMessage, never a URL.
- **Module workers are a dead end on file://**: `worker.format: "es"` makes
  all inline workers module workers — they fail to boot on file:// in
  Chromium entirely (worker.onerror with no message). Reverted; classic
  workers kept.
- **Protocol**: worker `loadRules {source}` → `{kind:"rulesLoaded", info}`
  (host CPU-capped via termination, default 5 s); `SimLoadRequest.rulesSource`
  imports + caches then hands the module to SimRunnerCore (built-in
  mass-battle stays the default). `SimRunner.loadRules` optional on the
  interface; InlineSimRunner implements the same path (Node-tested); SimBridge
  plumbs `rulesSource` through `start()`. WorkerSimRunner + sim.worker are
  bundled via e2eHook dynamic `?worker&inline` (they were previously
  tree-shaken out — hostBoot uses InlineSimRunner).
- **hardenSandbox fix** (sim.worker + vision.worker): XHR/WebSocket are own
  configurable props (delete works) but fetch/importScripts/indexedDB are
  PROTOTYPE members — `Reflect.deleteProperty(self, …)` never removed them
  (D-069 gap, first probed here). Now deletes the own prop, then shadows any
  survivor with a non-configurable `undefined` own property. Package-side
  typeof probes now read "undefined" ×5 in Chromium.
- **WebKit**: classic workers reject blob/data module imports AND engine CSP
  (`script-src 'self' 'unsafe-inline' blob:`) blocks Function-eval inside
  blob workers → packages cannot load; e2e asserts clean degradation (error
  string, worker keeps running built-in mass-battle, report rulesVersion
  "1.0.0"). Package authoring for WebKit would need the M3 importScripts
  classic-register form.
- Chain: tsc/eslint/prettier clean; 568 passed / 3 skipped (69 files); build
  1,143,575 B raw / 352,934 B gzip (< 6 MB); e2e chromium 32/32 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-087 — §12 package loader (folder/zip manifest; data-only vs script)

- **Manifest** (`src/core/packageManifest.ts`): id slug / semver version /
  `type: "system" | "data"`; system → `rules {entry, modelColumns}` (entry is a
  traversal-safe package path; columns mirror the §4A sys union); data →
  rules block FORBIDDEN; `packs[]` descriptors (compendia consumer later).
- **Loader** (`src/packages/packageLoader.ts`): fflate unzip → text-only
  decode (fatal UTF-8) → manifest at zip root or single nested root dir →
  referenced files must exist (entry, pack files) and packs must be JSON.
  Folder import shares `buildPackageFromFiles` (webkitdirectory feeds it).
- **Storage**: IDB v4 + `packages` store `[worldId, id]` (PackageRecord =
  validated manifest + file texts); active package pinned per world on
  `WorldsRecord.activeRulesPackage` (rides world persistence).
- **hostBoot**: boots the REAL sandboxed SimWorker now — `WorkerSimRunner`
  (static `?worker&inline` import; InlineSimRunner only on ctor failure) —
  closing the D-086 gap where the worker was e2e-only. Boot chain: read active
  package → `runner.loadRules(source, 5s)` as the §12 import/validation GATE
  (blob URL inside the worker) → success: pool sys from manifest columns +
  `rulesSource` to SimBridge; failure: degrade to built-in mass-battle with
  `rulesBoot.error` recorded. `HostApp.rulesBoot` + `HostApp.packages`
  (list/importZip/activate/deactivate). Activation rules are PINNED per
  campaign: any checkpoint for the scene blocks activate/deactivate
  ("campaign already started") — swapping post-checkpoint would break §5A
  determinism/replay. close() terminates the runner.
- **GM UI**: GmExtrasPanel "System package (§12)" section — zip file input
  (#pkg-file), package rows ([data-pkg-row], Activate button, active badge),
  error line, "applies on world reload" hint.
- **e2e** (`e2e/packages.spec.ts`, chromium — WebKit skipped per D-086):
  UI zip import → row listed; not-a-zip + data-only-activate rejected via API;
  panel Activate → badge; RELOAD → `rulesBoot {source:package, version:9.9.9}`;
  faction + spawn 100 + start + move order + advance → turn report
  `rulesVersion 9.9.9` with custom `pkg-move` events; post-campaign
  activate/deactivate blocked. NOTE: boot now outlasts page load (worker +
  gate) — specs wait for the app surface (waitForApp poll).
- Chain: tsc/eslint/prettier clean; 577 passed / 3 skipped (70 files); build
  1,152,691 B raw / 355,759 B gzip (< 6 MB); e2e chromium 33/33 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-088 — §12 sandboxed iframe module RPC (game./Hooks/canvas/ChatMessage/ui)

- **Protocol** (`src/core/moduleApi.ts`): postMessage frames tagged
  `vttModuleRpc:1` — request {id, method, args} / response {id, ok,
  result|error} / event {event, payload}. Whitelisted methods (game.info,
  settings.get/set, tokens.list/move, chat.create, notify, hooks.subscribe);
  whitelisted hooks (ready, snapshot, turnPhase, turnReport); args JSON-safe
  and ≤ 64 KB; malformed frames dropped, handler throws → error responses.
  Pure `createModuleDispatcher` (node-tested without any iframe).
- **Runtime** (`moduleRuntimeSource.ts`, classic-script STRING): provides
  `game`, `Hooks.on/once/off`, `canvas.tokens.list/move`, `ChatMessage.create`,
  `ui.notifications.notify` as promise RPC + hook dispatch; 10 s call timeout.
  Classic script (not ESM) — inline module scripts cannot rely on imports and
  the sandbox has no loader; package module entries are plain scripts.
- **Host** (`moduleIframe.ts`): hidden `<iframe sandbox="allow-scripts"
srcdoc>` (opaque origin on every engine), source escaping for
  `</script`, per-frame source validation, hook events forwarded only for
  names the module subscribed to; `onSubscribe` callback drives the "ready"
  handshake (host emits ready when the subscription lands, not on a timer).
- **Manifest**: optional `module {entry}` block on SYSTEM packages only
  (data-only packages rejected); loader requires the file to exist.
- **App wiring** (App.svelte): active package with module entry + successful
  rulesBoot → ModuleIframe with handlers: settings via IDB scope
  `module:<pkgId>`; tokens.list from active scene; tokens.move submits the
  standard token update op (INTENT through the client op path, no direct
  writes); chat.create submits a MessageDocument create op; notify pushes a
  capped toast log (DOM stack `[data-notify]`, level-colored). bus snapshot/
  ops → hook "snapshot" {seq}; turnPhase/turnReport forwarded. onDestroy
  disposes the iframe. `HostApp.moduleBoot` {packageId, source} | null.
- **e2e** (packages.spec test 2, chromium): module package (rules + module
  entry) → activate → reload → ready hook fires → settings.set probe read
  back via gm surface moduleSetting(); SANDBOX PROOF: module's own probes
  report localStorage THROWS and parent.document THROWS (opaque origin);
  add-token → ops hook → tokens.list/move intent lands the exact op
  (+120/+40 from the deterministic scene center); ChatMessage.create visible
  in chat; toasts render. Race note: assert ABSOLUTE final token position —
  the module can win the race against the spec's first tokenPos read.
- Chain: tsc/eslint/prettier clean; 584 passed / 3 skipped (71 files); build
  1,161,552 B raw / 358,643 B gzip (< 6 MB); e2e chromium 34/34 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-089 — §12 trusted in-page execution opt-in

- **Model**: one module source, two execution tiers. The manifest may
  REQUEST in-page execution (`module.trusted: true`, validated boolean);
  trust is only ever GRANTED by the GM per world
  (`WorldsRecord.trustedPackages[]`, IDB — no DB version bump needed).
  Ungranted (or revoked) → sandboxed iframe tier (D-088). Granted →
  TrustedModuleHost.
- **In-page execution without eval**: the page CSP (§15) has no
  `unsafe-eval`; probed that BOTH page-level `import(blob:)` and a blob
  `<script src>` tag work under `script-src … blob:` on file:// chromium.
  Chose the classic blob script tag — same classic-script module form as
  the iframe tier, synchronous execution after the API globals install.
- **TrustedModuleHost** (`src/packages/trustedModule.ts`): installs
  `game/Hooks/canvas/ChatMessage/ui` on window (prior values restored on
  dispose), evaluates the package source from a blob URL, Hooks registry
  with the same onSubscribe/ready handshake. Module code cannot be truly
  unloaded once evaluated (accepted; trusted = host-class code); dispose
  removes the script tag + globals + hook dispatch.
- **Shared handlers** (`src/packages/moduleHandlers.ts`): the §12 handler
  implementations (game.info/settings IDB scope `module:<pkg>`/tokens list/
  move-intent op/chat create op/notify toast) moved out of App.svelte into a
  factory used by BOTH tiers — the module API is tier-identical by
  construction. `ModuleHost` shared emitter interface.
- **Host wiring**: `HostModuleBoot.mode: "iframe" | "inPage"`; App picks the
  host by mode. `HostPackages.grantTrust(id)` (requires the package to
  request trust) / `revokeTrust(id)`; `PackageSummary {trustRequested,
trusted}`. GM panel: "wants in-page" badge, two-step Grant (first click
  arms "Confirm grant?" 3 s, second grants), Revoke trust, "trusted
  (in-page)" badge. gm.moduleMode() readback.
- **e2e** (packages.spec test 3, chromium): trust-requesting package →
  activate → reload → moduleMode "iframe", module's own probes report
  {inPage: false, hasLocalStorage: false} → two-step grant → reload →
  "inPage", {inPage: true, hasLocalStorage: true} → revoke → reload →
  "iframe" again. Gotcha hit: game.info() returns `packageId` (not `pkg`).
- Chain: tsc/eslint/prettier clean; 585 passed / 3 skipped (71 files); build
  1,165,310 B raw / 359,745 B gzip (< 6 MB); e2e chromium 35/35 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-090 — §12 compendia (read-only packs, indexed, drag import)

- **Core** (`src/core/compendium.ts`, node-tested): pack = {name,
  type (top-level collection), entries ≤ 2000}. Entries: slug id (unique),
  name ≤ 80, optional img/keywords, and a create payload that MUST NOT carry
  `_id` (world assigns fresh — packs stay read-only, imports are world-owned
  copies). `searchCompendia` ranking: name prefix 4 > name word-prefix 3 >
  contains 2 > keyword 1; multi-term = AND; empty query lists pack heads.
  Index cached per pack object (WeakMap).
- **Access**: `HostPackages.compendia()` — walks imported package records'
  manifest.packs, parses each file (invalid packs skipped), returns
  {packageId, pack}[]. No new storage: packs ride PackageRecords (D-087);
  "compressed" = the package zip at rest.
- **UI**: Compendia sidebar tab (`src/ui/compendia/CompendiaPanel.svelte`):
  #compendium-search, census line, ranked rows ([data-entry-id], draggable),
  per-row Import button → ordinary create Op (id `<coll-singular>-<uuid8>`).
  Canvas host accepts the `application/x-vtt-compendium` drag type
  (dragover gated on it): drop → create op + for ACTOR packs a linked token
  (makeToken at screenToWorld(drop), token.actorId = fresh doc id,
  token.img = entry.img). gm readbacks: compendiumStats {packs, entries},
  actorCount, importedTokens (name/actorId/img).
- **e2e** (packages.spec test 4, all engines — data packages work on WebKit
  too): import bestiary (2 packs / 4 entries) → tab shows 4 rows → "gob" →
  2 rows, "beast" → 1 (keyword path) → button import → actorCount 1 →
  locator.dragTo(canvas-host) → actorCount 2, tokenCount +1,
  importedTokens shows {name: Goblin Warrior, actorId set}. HTML5 dnd works
  with Playwright dragTo on chromium.
- Chain: tsc/eslint/prettier clean; 591 passed / 3 skipped (72 files); build
  1,171,993 B raw / 361,544 B gzip (< 6 MB); e2e chromium 36/36 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-091 — §12 migrations per dataSchema version on world load

- **Engine** (`src/core/migrations.ts`, node-tested): semver parse/compare
  (prerelease < release); `planMigrationChain` walks EXPLICIT from→to links
  (cycle + missing-link + overshoot errors); declarative transforms —
  set/default/move/remove over dotted paths with `*` fan-out segments
  (`units.*.stats.drill` reaches embedded unit stats); `default` yields only
  on the LEAF key (bug caught by tests: early-return at every level skipped
  nested defaults); path segments reject `__proto__`/`prototype`/`constructor`
  and depth > 8; untouched docs keep their reference (change counting).
  Code-step registry (`registerCodeMigrations(systemId, steps)`) for the
  built-in system — declarative steps run first, then code steps.
- **Manifest**: `migrations: [{from, to, transforms: {<docType>: [ops]}}]` —
  SYSTEM packages only; validated at import. Transform keys are DOCUMENT
  TYPES (singular: "army", not the collection "armies").
- **World-load integration** (hostBoot): effective system = activeRulesPackage
  ?? world.system; current version = package manifest version (built-in
  1.0.0); persisted = WorldsRecord.version. When older: migrate and apply.
  CRITICAL architecture point discovered by probing: world persistence is
  OPLOG-first — the IDB documents store can lag arbitrarily (nothing calls
  persister.start(); attach() replays the oplog tail), so migrating the
  documents store directly is WRONG. Migrations therefore run over the
  HYDRATED STORE and commit as a NORMAL OP ENVELOPE (update ops built with
  `diffFlat`) → persisted by the existing machinery, replayable (idempotent
  diff), undoable, visible to clients. putWorld bumps the version after the
  envelope drains. `activate()` now baselines WorldsRecord.version to the
  package's manifest version. HostApp.migrationBoot {systemId, from, to,
  applied[], changedDocs, error} readback (app surface).
- **Rebuild lesson**: a python slice between two anchors deleted the whole
  Assets/HostSync/sim-section span of hostBoot (only detected via TS6133
  unused-import errors) — reinserted; and one full chromium run failed
  purely because PLAYWRIGHT_BROWSERS_PATH was missing from that command's
  env (browsers looked up under /home/user/.cache). Always re-export the
  full env block per command.
- **e2e** (packages.spec test 5): v1.0.0 package active + army spawned in
  old format → import v1.1.0 (same id, declarative migration) → reload →
  migrationBoot {from 1.0.0, to 1.1.0, applied ["1.0.0→1.1.0"], changedDocs
  ≥ 1}, firstArmyProbe {schemaNote "v1.1", drill 1} → second reload: null
  (versions current, idempotent).
- Chain: tsc/eslint/prettier clean; 597 passed / 3 skipped (73 files); build
  1,179,257 B raw / 363,976 B gzip (< 6 MB); e2e chromium 37/37 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-092 — §11 3D dice (three.js, lazy Blob URL, determined result)

- **Lazy Blob URL**: `await import("three")` in `src/dice/dice3d.ts` → vite
  code-splits three (0.185) → vite-plugin-singlefile inlines the chunk as a
  Blob-URL module (same machinery as the inline workers). Bytes are always in
  the file (+644 KB raw / +188 KB gzip → 1.91 MB / 552 KB, well under 6 MB)
  but the library is only PARSED on the first roll; WebGL/renderer failures
  degrade silently (the chat card still shows the result).
- **Determined result, never chosen by the animation**: dice terms in
  RollEvaluation carry per-die `kept` values — `diceFromTerms` maps each
  kept value to one die (≤ 8 dice in the scene). `planDieFaces(sides, value,
topSlot)` builds 6 face labels where the chosen top slot carries the
  ROLLED value; `orientationForTopFace(face)` is the quaternion putting that
  slot on +y (unit + basis-vector verified in node tests — first test helper
  had sign errors in the Hamilton product, the DATA was right).
- **Animation**: perspective camera, ambient+directional lights, one
  BoxGeometry mesh per die with 6 CanvasTexture face labels (parchment for
  small dice, dark for d20-style); tumble (fixed angular velocity +
  ballistic drop w/ bounce) 900 ms → slerp to the settle quaternion 450 ms →
  hold 900 ms → dispose all geometries/materials/textures/renderer + canvas.
  `dice3dStats` module readback {loads, rolls, settled, lastValues,
  lastTotal, disposed} exposed via gm.dice3d().
- **Wiring**: App's existing gm bus "ops" handler now also scans created
  message docs for `roll !== null` (dedup by message id) and fires the
  overlay into a `.dice3d-host` overlay div (absolute, pointer-events none).
- **e2e** (`e2e/dice3d.spec.ts`): loads === 0 before any roll → `/roll 2d6 +
1d20` → three loaded exactly once → 3 dice settle with values in range
  (1-6, 1-6, 1-20) summing EXACTLY to the roll total → overlay disposes.
- Env trap recurred twice this unit: playwright runs WITHOUT
  PLAYWRIGHT_BROWSERS_PATH in the command env report missing browsers under
  /home/user/.cache — always export the full env block per command.
- Chain: tsc/eslint/prettier clean; 603 passed / 3 skipped (74 files); build
  1,911,767 B raw / 551,779 B gzip (< 6 MB); e2e chromium 38/38 ×3, webkit
  m2+gmextras+rules+models 5/5.

## D-093 — §11 commit-reveal rolls (U47)

Blum-style verifiable rolls over the existing ops channel; no new
connection, no crypto UI — the audit trail is the chat record itself.

- **Module** (`src/dice/commitReveal.ts`): `randomSeedHex` (16 B hex),
  `sha256Hex` (WebCrypto, async), `deriveSeed32` = first 4 B of
  SHA-256(`${seed_c}:${seed_h}`) as uint32 (concat-order sensitive),
  `evaluateCommitRoll` (XoshiroPRNG → evaluateFormula), `verifyCommitRoll`
  (checks H(seed_c) = commit AND re-derives the total; Result, not bool).
- **Wire**: `roll.reveal` 0x0d (c2h) + `roll.challenge` 0x2d (h2c) — both on
  the existing "ops" channel (frame channelFor whitelist + switch — the
  five-place MsgKind checklist from the error log held). `RollMsg.commit?`,
  `RollRecord.commit?`; PROTOCOL.md sections enforced by protocol-doc test.
- **Host** (`host/sync.ts`): `roll{commit}` → pendingRolls map entry (formula,
  rollData, mode, to, ts) + `roll.challenge{seedHost}` reply; 60 s sweep for
  abandoned challenges; `roll.reveal` is session-bound — SHA-256 mismatch or
  unknown rollId → reject; on match `evaluateCommitRoll` decides the total
  and the message records seedClient/seedHost/commit.
- **Client** (`client/sync.ts`): `rollVerified()` pre-generates seed_c,
  commits, auto-answers `roll.challenge` from a bounded (≤32) committedRolls
  map; crypto failure degrades to a plain roll — chat never blocks.
  `ChatPanel` routes explicit `/roll` through it; inline `[[..]]` stays
  host-random (no user stake in inline flavor rolls).
- **Tests**: node (KATs for SHA-256, determinism, seed sensitivity, verify
  ok/commit-mismatch/total-mismatch/missing-fields); e2e
  `commitroll.spec.ts` — player `/roll 2d6+3` → host record carries 32-hex
  seeds + 64-hex commit and `committedRoll()` (gm surface) verifies in-app.
- **Env trap hit again**: e2e runs against `dist/index.html` — rebuild before
  e2e after ANY app-side change, or surfaces read back stale code.
- Chain: tsc/eslint/prettier clean; 611 passed / 3 skipped (75 files); build
  1,915,173 B raw / 557,143 B gzip (< 6 MB); e2e chromium 39/39 ×3, webkit
  m2+gmextras+rules+models 5/5; PLAN 124 [x]/24 [ ].

## D-094 — §5A realtime mode (U48)

The TurnEngine reducer already modeled pause/resume/rate/scene-change; this
unit built the RUNTIME around it. No new wire kinds — realtime rides the
existing sim channel.

- **Pump** (turnChannel): injectable `RealtimeDriver` (default 50 ms
  setInterval; node tests pass a manual driver and call `pumpRealtime(t)` with
  a fake clock). `syncRealtimeClock()` arms/stops the driver on every engine
  transition (orders+realtime ⇒ running; paused/resolution/idle ⇒ stopped), so
  stepwise flows are untouched. Due-tick accumulator with catch-up cap 8
  prevents spiral-of-death after a stall; resume starts with no burst.
- **Ticks**: `bridge.tickOnce` (runner passthrough, no storage) with
  `tickSeed(seed, turn, tick)` = turnSeed + imul(tick+1, 0x632be59b) —
  deterministic, replayable. Orders re-read from the store each pump so live
  order ops steer movement. runner.tick now COLLECTS rules-module events
  (cap 32) into SimTickResult.events (was a noop sink).
- **Coalesced flush**: `mergeSimDeltas` (codec) unions per-column changed
  indices of the window's tick deltas, latest code wins, rebuilt RLE —
  proven ≡ sequential application by test. ONE projected sim.delta per
  flushHz; with rate 10 Hz / flush 5 Hz, to-from spans ≥ 2. Clients' existing
  gap detection covers missed coalesced frames. Visibility bitmaps are cached
  ~1 s (refreshed at report cadence) — full-pool projection at 5 Hz would be
  wasted work; fog/projection lag ≤ 1 s, acceptable and documented.
- **1 Hz report**: bounded (100) accumulated events + `{realtime, tick}`
  summary, `rulesVersion:"realtime"`; GM full, players projected. Merged
  flush deltas persist via putDelta (per-tick deltas never hit IDB).
- **Checkpoints**: every `checkpointEveryTicks` (300) + on pause/scene-change
  (the reducer's realtimeCheckpoint effect, previously DROPPED by applyEffect).
  Slot = tick, `tick !== null`; stepwise freezes keep `tick === null` and
  reloadFromFreeze/freezeBytes now filter on that — undo can never land on a
  mid-tick state.
- **turn.phase**: optional `mode/paused/simHz` fields (wire-compatible, no
  new kind; paused still reports phase "orders").
- **Client**: `PoolInterpolator` (pure) — push on every replica update, sample
  240 ms behind; snaps on pool-count change (never lerps across deploy/
  compaction); replica itself never mutated (sample arrays are render-side).
  App pushes on the gm bus "sim" event + samples at 100 ms; ModelLayer
  per-frame consumption rides the strategic-view/replay unit (ModelLayer is
  not yet replica-driven in the live app).
- **UI**: GM extras gains Start (realtime), Pause, Resume, rate select
  (2/5/10 Hz) + a phase chip with paused/Hz state.
- **Tests**: node — pump with fake clock (ticks/flush/report cadence, rate
  coalescing ≥2/frame, pause freeze + checkpoint + resume, 300-tick interval
  checkpoint, merge ≡ sequential, bounded events); interpolator — midpoint
  lerp, clamp ends, snap single-state/count-change. e2e (realtime.spec):
  in-browser campaign — 12 models, move order, ≥8 ticks/3 frames/1 report in
  ~3 s, probe moves ≥1 grid unit, interpolatedMoves ≥ 1, pause freezes
  version + chip shows paused + checkpoint, resume, live rate 10 Hz.
- **Trap (recurring)**: rebuilt dist before e2e — the suite runs against
  dist/index.html, not source.
- Chain: tsc/eslint/prettier clean; 622 passed / 3 skipped (77 files); build
  1,925,372 B raw / 553,399 B gzip (< 6 MB); e2e chromium 40/40 ×3, webkit
  m2+gmextras+rules+models 5/5; PLAN 125 [x]/23 [ ].

## D-095 — §9A TurnReport timeline animation with scrubber + GM skip

- **TurnReportPlayback** controller (`src/ui/armies/turnReportPlayback.ts`):
  manages step-by-step resolution playback, sub-phase indicators ("move", "shoot", "melee",
  "morale", "supply"), step forward/back, seek scrubber (0 to N-1), speed multipliers (0.5x, 1x,
  2x, 4x), event location pings, and GM skip button (jumps directly to end).
- **TurnReportTimeline.svelte** component integrated into `ArmyWindow.svelte` Reports tab.
- Unit tested in `tests/ui/turnReportPlayback.test.ts`.

## D-096 — §10/§4A/§12 Logistics & Attrition Documents, Panel + Forecast

- **Top-level collections**: `depots`, `routes`, `reinforcements` added to `DocumentStore` and
  `WorldCollections`.
- **Forecast math**: `calculateLogisticsForecast` in `src/core/logistics.ts` computes supply demand
  vs depot capacity per faction, attrition warnings for units at 0 supply, reinforcement arrival schedules,
  and total upkeep costs.
- **UI**: `LogisticsPanel.svelte` provides tabs for Forecast, Depots, Routes, and Reinforcements.
- Unit tested in `tests/core/logistics.test.ts`.

## D-097 — §5A Hero Attachment (leaderTokenId)

- **UnitDocument.leaderTokenId** links a hero Token on the tactical canvas to a strategic Unit.
- **Host sync**: `TurnChannel.syncHeroTokens()` calculates unit centroid anchors after turn
  resolution or realtime ticks, updating `leaderTokenId` token positions via ordinary `update` Ops.
- Detaching (`leaderTokenId = null`) restores manual player/GM control of the token.
- Unit tested in `tests/host/heroAttachment.test.ts`.

## D-098 — §8A After-action replay from checkpoints

- **ReplayEngine** (`src/sim/replay.ts`): queries historical checkpoints from IDB (`checkpoints` store in
  `strategicStore.ts`), decodes compressed ModelPool snapshots (`poolFromSnapshot`), and steps through turn-by-turn history.
- **ReplayPanel.svelte**: UI with scrubber slider, play/pause/step controls, speed selector, and turn report previews.
- Unit tested in `tests/sim/replay.test.ts`.

## D-099 — §9A Strategic↔tactical scene linking

- **Token mapping**: `generateTacticalTokens` in `src/core/sceneLink.ts` converts strategic army units into tactical `TokenDocument`s on linked tactical scenes (`flags.core = { unitId, armyId, strategicLink: true }`).
- **Tactical outcome sync**: `syncTacticalOutcomeOps` maps tactical token losses back to strategic `UnitDocument.stats.strength` via update Ops.
- Unit tested in `tests/core/sceneLink.test.ts`.

## D-100 — §8 File System Access API "Save to folder"

- **exportWorldToFolder** in `src/host/worldFile.ts` streams `world.json`, `documents.json`, `assets.json`, `assets/<hash>`, `checkpoints/`, and `reports/` into a directory handle (`DirHandleLike` / `FileSystemDirectoryHandle`).
- Exposed in `App.svelte` sidebar when `showDirectoryPicker` is supported.
- Unit tested in `tests/host/folderExport.test.ts`.

## D-101 — §6.3 Peer Relay (relay.offer / relay.frame)

- **PeerRelayRouter** in `src/net/peerRelay.ts` routes opaque e2e-encrypted `RelayFrameMsg` frames through connected intermediary peers to destination peers.
- Enables connectivity for players behind restrictive NATs/firewalls without central servers.
- Unit tested in `tests/net/relay.test.ts`.

## D-102 — §6.3 User-supplied TURN Credentials

- **buildIceServers** in `src/net/webrtc.ts` merges default public STUN servers (`DEFAULT_ICE_SERVERS`) with user-configured TURN credentials (`TurnConfig[]`).
- Supports username/credential authentication for custom TURN servers.
- Unit tested in `tests/net/relay.test.ts`.

## D-103 — §6.5 Assistant-GM Failover

- **FailoverMonitor** in `src/net/failover.ts` tracks host liveness for ASSISTANT role sessions.
- Triggers `onHostFailed` after 30 seconds of host absence or on transport disconnect, allowing the Assistant GM to promote to active host, reopening the world from IDB + oplog tail.
- Unit tested in `tests/net/failover.test.ts`.

## D-104 — §1 Voice & Video Mesh (<= 6 peers)

- **VoiceVideoMesh** in `src/net/voiceVideo.ts` manages audio/video mute states and per-peer volume controls for up to 6 connected peers.
- Unit tested in `tests/net/voiceVideo.test.ts`.

## D-105 — §12 PF1e: deploy-time profile compilation, content-addressed interning, real model columns

- Gap List §1.2–§1.4 (PR 1). `systems/pf1e-mass-battles/manifest.json` declared 9 `modelColumns` while
  `PF1E_MODEL_SCHEMA` uses 13; the host builds the deploy schema from the **manifest**
  (`src/app/hostBoot.ts:433-443`), so undeclared columns are never allocated: reads return `undefined`,
  writes are dropped, and the column vanishes from diffs, hashes and joiner replicas. Manifest now
  matches the schema and `tests/packages/pf1eManifest.test.ts` pins them together.
- `PF1E_MODEL_SCHEMA` grew `flatFootedAc` (§2.1) and `nonlethal` (§2.3/§2.12). AC is no longer taken off
  the unit sheet: `compilePF1eProfile` derives `ac` / `touchAc` / `flatFootedAc` from one
  `ACBreakdown` (armor + shield + Dex + natural + size + misc + dodge; no Dex/dodge when flat-footed,
  no armor/shield/natural when touching), so one breakdown serves every attack flavour.
- New `src/packages/pf1e/deploySeed.ts`: `src/sim/deploy.ts` only allocates `hp/hpMax = 1` + `sys.ammo`,
  so PF1e battles fought at AC 0 and — because nothing wrote `profileIdx` — resolved **zero attacks**
  (`registry.get(0)` is `undefined` ⇒ every attack loop `continue`d). `buildUnitProfiles` +
  `seedPF1ePool` now compile and stamp every model at turn start.
- Profiles are **content-addressed**: `PF1eProfileRegistry.intern` keys on the stat-bearing fields
  (`pf1eProfileKey`), so identical profiles share one id. That makes the old per-turn `register()` churn
  (a new id for every unit every turn, registry never cleared, `profileIdx` frozen at deploy) harmless
  and puts profile identity — hence dice order — outside the RNG stream, where it belongs.
- Interning happens over `sortUnitsForInterning` (id-sorted), never over `Object.keys(army.units)`: unit
  key order is a persistence artefact and must not reach the dice.
- `resolveTurn` re-seeds every turn on purpose. The host's `applyHeroLeadershipToUnits` mutates
  `unit.stats` (and it accumulates auras turn over turn — unfixed, Gap List §5), so a deploy-time-only
  snapshot would freeze AC/attack at whatever the stats were at deploy.

## D-106 — §12 PF1e: all battle dice come from the runner's PRNG

- Gap List §1.5. `massBattlePf1e.ts` seeded its own `SimpleRng` from `Math.random()` in two places and
  `combatEngine.ts` / `spells.ts` rolled on private LCGs, so PF1e battles were neither reproducible from
  a seed nor checkpoint/hash/replay stable (`src/sim/runner.ts` hands rules a `BulkDice(req.seed)`;
  `massBattleBasic.ts` forks per unit).
- `combatEngine.ts` now takes a `PF1eRng` (`pf1eRngFromPrng` bridges the host `PRNG`,
  `pf1eRngFromSeed` keeps unit tests free of RNG plumbing); the module forks
  `rng.fork(unitIndex(unit), phase)` (phase 1 = melee, 2 = spellcasting) exactly like the basic module,
  and `resolvePF1eSpellAOE` takes the same `rng`. `SimpleRng` is `@deprecated`, kept only so
  `tests/packages/pf1eCombat.test.ts` still compiles.
- Verified by `tests/packages/pf1eDeploySeed.test.ts`: same seed ⇒ equal `canonicalPoolHash`, and a
  unit's fork key is its identity (`unitIdx` alone would make two same-army units share one stream).

## D-107 — §12 PF1e: flat-footed AC column, single-count flanking, minimum damage is nonlethal

- Gap List §2.1–§2.3. `targetAcType: "flatFooted"` read a column that did not exist and fell back to the
  **attacker's** `profile.ac` — with the fallback AC column absent, unseeded battles attacked AC 0, which
  is why the pre-existing troll-regen test "hit" only by luck (now seeded explicitly in
  `tests/packages/pf1ePrecreatedUnits.test.ts`). `resolveTargetAc(pool, index, acType, defProfile)` is
  the single entry point; it also fixes DR, which used `pool.sys.drVal ?? profile.dr` and so read the
  attacker's DR whenever the defender's was 0.
- Flanking was +2 to-hit _and_ −2 to AC (SRD: +2 to-hit only, from the helper), so a +2 flank could turn
  a 19 into a 20 twice over. The −2 is gone; the `FLANKED` status bit is still set by the caller
  (envelopment geometry owns it later, §5).
- Minimum damage (CRB: "if penalties would reduce damage below 1, deal 1 point of **nonlethal**") was
  `Math.max(1, …)` lethal in all three resolvers. Damage now returns `{lethal, nonlethal}`; sub-lethal
  nonlethal accumulates in `sys.nonlethal` and trips `UNCONSCIOUS` at ≥ current hp (and `DEAD` at 0 hp,
  which is the bit `compactPool` reclaims), so the §2.12 thresholds have somewhere to live.
- Deliberately NOT done: the hero cleave (still one unconditional kill), envelopment's flanked bit and
  routing logic, and the analytics fields — all wrong in ways that need the §5 rules data model, not a
  patch.

## D-108 — §4A codec: `i8` is a real wire kind (found while doing Gap List §1.3)

- `ModelColumnType` admits `i8`, `rulesLoader.validateRulesModule` and `packageManifest` accept it, and
  `pool.ts` allocates an `Int32Array` for it — but `codec.ts`'s `ColKind`/`KIND_BYTES` had no `i8`, and
  `colKind` casts the schema value through unchecked. Consequences: `packCodes` wrote a
  `codes.length * undefined = NaN`-sized buffer (empty) so the column silently disappeared from every
  delta, and `unpackCodes` computed `n = 0 / undefined = NaN` → `new Array(NaN)` threw
  `RangeError: Invalid array length` in `canonicalPoolHash`, i.e. at the end of the first turn of any
  battle whose module declared an i8 column (PF1e's three saves).
- Fixed in `src/sim/codec.ts` (signed 1-byte kind) rather than by re-typing PF1e's saves as `i16`: the
  platform promised the type, so a third-party module would otherwise hit the same trap. Regression test
  covers both the snapshot and the delta path, including −128/+127.

## D-109 — §12 PF1e: scale authority is the two implementations, not a shared kernel

- Answered on the Gap List review (2026-09-08), overriding its recommendation: tactical (ActorDocument /
  CombatDocument / grid) and strategic (ModelPool / SimWorker) each implement the Combat chapter
  separately. Parity is a convention — shared _data and tables_ under `src/packages/pf1e/` — and there
  is **no** parity gate and no `resolveAttackRoll`-style kernel. The strategic layer keeps grid-quantised
  abstractions where exact tactical bookkeeping would cost 10 000× the work.
- Same review: **no core `EffectDocument` changes** (`mode`/`type`/`origin`/`duration` rejected), so
  core PRD items P-12/P-13/P-14 are retired and no document migration is needed; typed bonuses live in
  PF1e's own data and stacking is PF1e's business.

## D-110 — §12 PF1e ships as a real package: build step, data-only core pack, generated `rules.js`

- Gap List §1.1 (PR 2). `scripts/buildSystemPackages.mjs` (`pnpm build:systems`) bundles
  `src/packages/pf1e/rulesEntry.ts` with vite into one self-contained ESM file and writes
  `systems/<id>/rules.js`, then zips every package folder to `dist/packages/<id>-<version>.zip` — the
  shape `#pkg-file`/`readZipPackage` actually consume. The generated `rules.js` is git-ignored
  (`.gitignore`, `.prettierignore`, eslint ignores): a committed bundle would drift from the module it
  was bundled from, which is the exact failure mode §1.2/§1.3 just fixed.
- The emitted file is rewritten into `export default (() => { … })();`. Not cosmetics:
  `rulesLoader.evalRulesModule` (the fallback for engines whose classic workers cannot import module
  scripts) matches only a single-`export default <expression>` source. The rewrite **throws** instead
  of emitting a bundle that still contains `import`/`export`, so an unloadable package fails the build.
- `systems/pf1e-core` became `type: "data"` with its two packs, and its `module: { entry: "module.js" }`
  block was deleted rather than fabricated. As declared it was uninstallable — `validatePackageManifest`
  rejects a `system` package with no `rules` block — and PF1e's hero-level sheets are in-repo Svelte
  (§1.7), not a sandboxed iframe module. Nothing was invented to make a manifest honest.
  `pf1e-mass-battles` keeps a `dependencies: ["pf1e-core"]` key that **nothing enforces** (the manifest
  validator ignores unknown fields); it is documentation of intent, and PF1e must stay loadable with
  only itself installed.
- Seed packs open Gap List §6 rather than finish it: `packs/spells.json` (fireball, magic missile,
  shield, true strike — the fields `PF1eSpellOrder` consumes under `system.massBattle`) and
  `packs/bestiary.json` (the six `PRECREATED_PF1E_UNITS`, in readable `dr.bypass` /
  `regeneration.suppress` names). `tests/packages/pf1ePackage.test.ts` translates the names back into
  the engine bitfields and requires `compilePF1eProfile` to agree with the in-repo table, so content
  and code cannot drift silently.
- `HostPersister.patchWorld(patch)` is now the only sanctioned way to change a live world record
  (activation, GM trust, migration version stamp). `HostPersister` owns a cached `WorldsRecord` and
  rewrites it on every write-behind flush; the §12 sites called `putWorld` directly, so activations
  were reverted by the next tick — "import zip → activate → reload" only worked by timing. Keys are
  cleared by omission because structured clone preserves `key: undefined`.
- `HostAppOptions.simRunner` was added as a boot seam (alongside the existing injected `db`/`codec`/
  `root`). Node has no DOM `Worker`, and `WorkerSimRunner` constructs successfully and fails only at
  `loadRules`, so without the seam the package-boot path is untestable outside a browser — the
  alternative (silently falling back to the unsandboxed runner) is a security regression, not a fix.

## D-111 — §4A codec, follow-up: `i8` was not the only unchecked cast

- `colKind` still casts `sys[name]` to `ColKind` for every declared type; `f64` is deliberately widened
  to `f32` (matching `pool.ts` storage) and `i8` now exists on the wire (D-108), so the cast is
  total over `ModelColumnType`. If a type is ever added to `ModelColumnType`, the compiler will not
  catch the missing `KIND_BYTES` entry — the `toSingleDefaultExpression`-style approach of throwing on
  an unmapped kind at encode time is the follow-up, deferred because it is a hot path (per-column, per
  model, per turn) and no consumer needs a new type yet.

## D-112 — §1.8: the 10k gate runs in Node; the browser asserts artifacts, not timings

- The 10 000-model acceptance test for PF1e moved from `e2e/` to `tests/packages/pf1eMassBattleScale.test.ts`,
  driving the real `deploySnapshot` → `InlineSimRunner` → `SimRunnerCore` path (the code the SimWorker runs)
  for 4 warm-up + 24 turns. A Playwright-only gate is unauditable in this environment (no browser binaries,
  `playwright install` blocked), and turn-cost assertions are machine-dependent by nature; the old spec was
  worse than unauditable — it asserted a hardcoded `{ok:true,hits:15}` and never touched the sim.
- **Budgets are asserted, timings are measured.** Strict on everything reproducible: `bytesPerModel ≤ 200`
  (66.00 with the 13 PF1e columns), a full 10k checkpoint ≤ 1.5 MB, `toVersion == turns`, casualties
  (`Σ rangeDiffs length` between 0 and 10 000), melee events emitted, `report.rulesVersion`/`subPhases`
  stamped by the module, `console.error`/`console.warn` call counts 0 via spies, and replay equality of the
  pool hash _and_ the wire. The p95 gate is a catastrophe ceiling (250 ms) with the measured p50/p95/max
  logged, so the test fails on a 5× regression instead of on noisy CI. §19's "p95 < 50 ms at 10k" is
  reported against, not asserted; the dense 40 × 250 shape genuinely misses it (p95 54–58 ms) and that is
  recorded as a perf finding in Gap List §5 rather than hidden by shaping the fixture until it passes.
- **Determinism is asserted on the decompressed wire.** `encodeSimDelta`/`encodeSimSnapshot` gzip via fflate
  `compressSync`, whose header carries MTIME: two byte-identical turns produce different compressed bytes.
  Comparing `decompressSync(bytes)` (or decoded structures, as `tests/sim/replay.test.ts` already does) is
  the rule for any future wire-level determinism test. Nothing is content-addressed from compressed bytes —
  checkpoint identity is `canonicalPoolHash(pool, sys)` — so this is a test-authoring trap, not a wire bug,
  and making fflate emit a fixed mtime was rejected as an unnecessary wire change.
- **The browser half keeps only what a browser can prove.** `e2e/pf1e_mass_battles.spec.ts` imports the
  _shipped_ `dist/packages/pf1e-{core,mass-battles}-1.0.0.zip` through the app surface, asserts `packages()`
  rows (a data package refuses activation with "data-only"), that `rulesBoot` reports
  `{source:"package", packageId:"pf1e-mass-battles", version:"1.0.0", error:null}` — i.e. a real Worker
  imported the bundle from a blob URL — that deactivation returns to `builtin`, and that the page threw no
  `pageerror`. `test:e2e` now runs `pnpm build:systems` after `pnpm build` (vite empties `dist/`, so the
  zips must be built after it) and the spec fails loudly with "run pnpm build:systems" if the artifacts are
  absent, instead of silently skipping the thing it exists to check.
- No host-side `simAdvance` e2e hook was invented. The `?e2e` app surface has no deploy/advance entry and the
  §5A readbacks live on the joiner surface; adding one is deferred until the tactical (§4) flow needs the
  same hook, so the seam is designed once.

## D-113 — §10 P0: three tactical data contracts, and world settings as a replicated document

The five open questions in `PF1e_ImplementationPlan.md` §10 were answered "adopt the plan's defaults";
the defaults are recorded here as decisions, and **two of them were revised against the code** before a
line was written. The revisions matter more than the adoptions, so they lead.

- **World settings are a document, not a `WorldsRecord` field.** The plan proposed storing
  `worldSettings` + the round clock on `WorldsRecord` through `HostPersister.patchWorld`. That record is
  the local host's row and is **not replicated** — players would be buffed against a clock they cannot
  see. `src/core/documents.ts:314` already declares `SettingsDocument` (`type: "settings"`, in
  `TOP_LEVEL_COLLECTIONS`) and nothing anywhere read or wrote it; `projectWorld`
  (`src/core/projection.ts:122`) replicates any top-level document at effective ownership ≥ LIMITED. So
  `src/core/worldSettings.ts` reads/merges that collection into one document, `_id="world-settings"`,
  `ownership.default = LIMITED` (1), with flat keys in `system` — the same flat convention
  `massBattleBasic.ts:380` already uses for `detectionMultiplier`. `tests/core/worldSettings.test.ts`
  asserts the ownership level _through the projection itself_, and that a `default: 0` settings doc does
  **not** reach a player, so the level is load-bearing rather than decorative. Name collision to avoid:
  `src/storage/idb.ts:189`'s `getSetting/putSetting` are app-local `[scope, key]` pairs — unrelated.
- **No manifest version bump, no declarative migration in P0.** `derivePF1eActor` is _total over partial
  input_ instead: a document with no `system.pf1e` at all yields a legal Medium commoner, naming every
  reconstructed field in `defaults` and every malformed one in `issues`. The parity a migration would
  have bought is asserted directly, by deriving the shipped `systems/pf1e-core/packs/bestiary.json` and
  comparing it against `compilePF1eProfile`. A bump would have churned the zip names and the §12 manifest
  tests to migrate data that does not exist. (For whoever lands a real one: `MigrationStep` carries
  `transforms`, not `ops` — `src/core/migrations.ts:58`.)
- **1. `system.pf1e` is the single authored tactical location** and `derivePF1eActor` its only tactical
  consumer; nothing derived is ever stored, which is also what makes buff expiry free.
- **2. Effects stay in `flags.pf1e`; core keeps ticking.** `EffectDocument` is untouched (D-112 stands),
  `changes` is not the mechanic — a typed bonus cannot be expressed as a path overwrite. Core's
  `flags.core.duration` remains the only timer, read through
  `combatant.flags.core.effects` exactly as `core/combat.ts` stores it, and a round-start expiry
  variant is a wrapper transition in `combatState.ts`, not a core edit. `ttlToTicks` is the one place
  `1 round = 6 s` / `1 minute = 10 rounds` is written down, so the seed and the SRD text cannot drift.
- **3. Round structure lives in `combat.flags.pf1e` / `combatant.flags.pf1e`.** Surprise (A.1: only when
  _every_ attacker beats _every_ defender, and the round runs before core's round 1 so `combat.round`
  stays 0), flat-footed-until-your-first-turn, the AoO ledger (A.10: refreshed at the start of _your_
  turn), held actions (A.10: six allies acting before you turns the hold into a full-round action), and
  the clock. Core still owns `round`/`turn`/initiative order — `startWithSurprise` hands over to
  `startCombat`, `pf1eNextTurn` delegates to `nextTurn` and only then applies PF1e's boundaries. The
  last test in `pf1eCombatState.test.ts` exists to prove that delegation: an embedded effect still ticks
  down and expires through the wrapper, with the expiry _reported_.
- **4. Fireball is 20 ft.** The pack/SRD value wins; the sim's 15 ft and the invented spell scatter are
  due to be deleted or filed in `DEVIATIONS.md` in P5 — that file still reads "None." and is stale.
- **5. PR order A→B→C** (sheet before tracker): a context menu needs a derived actor to act on.
- **Initiative ties carry a 0.5 marker** rather than a re-rolled die or an insertion-order accident:
  core orders purely by `initiative`, and `initiativeDisplay()` floors the value for display, so the
  tie-break is expressible without lying about what was rolled. Equal roll _and_ equal Dexterity returns
  `needsReroll` instead of picking a winner.
- **A stat-block adapter, because the pack and the sheet author different shapes.** The shipped bestiary
  publishes totals and modifiers (`bab`, `strMod`, `ac`, `weapon.damageMod`, `dr: {val, bypass}`) —
  pool-shaped, because that is what `compilePF1eProfile` consumes; a sheet must author components (six
  scores, armor/shield/natural) or no buff can move a total. `src/packages/pf1e/statBlock.ts` converts
  one into the other _once_, and reports it: an ability score rebuilt from a modifier says so (a modifier
  only determines the even score), a published AC is honoured as a total rather than recomposed into fake
  components, `weapon.damageMod` is marked as already containing the ability bonus so Strength is not
  added twice, and published saves are flagged so Con/Dex/Wis are not re-added. Fields no tactical rule
  implements yet are listed in `unsupported` **with the phase that owns them** (`weapon.isFirearm —
firearm rules are P6`), which is what keeps "not modelled" from reading as "not present". The
  conversion is idempotent, so an import round-trips.
- **Deliberately not fixed here:** `compilePF1eProfile`'s `maxAoos` and its generic `sizeMod` on
  CMB/CMD, and its base-only saves. `rulesTables.ts` is correct and the strategic compile is not; the
  three differences are recorded in Gap List §10.2 with the parity relationship pinned by a test, because
  silently editing them would move 10k-model fixtures and their byte budgets in a PR about data shapes.
  P8 switches the sim onto the same tables.
- **Found while reading, not fixed:** `nextTurn`'s round-wrap loop tests `"delayed" in c.flags` while the
  flag lives at `flags.core.delayed` (`src/core/combat.ts:103`), so a delayed combatant is never
  un-flagged. `startCombat`'s clear works, which is why nobody noticed. Fixed in P2, where the plan
  already intends to assert delay behaviour — see the corrected P2 accept item.

## D-114 — PF1e P1 first slice: mounted sheet, authored edits through ClientSync

**Date:** 2026-09-08. **Tracking:** `PF1e_Unified_TODO.md` S01–S04 (only S03 closed).

- Replace the orphan PF1e sheet's fabricated local envelopes with `ClientSync.submit`.
  A pure `pf1eSheetModel.ts` adapter builds allowlisted authored-field Ops and reads
  the latest projected actor/ownership before sending. Host permission checks remain
  authoritative; non-owner forged requests are covered by the real memory-transport
  HostSync/ClientSync test.
- Mount in the shared Sheets panel first, so GM and player owners can use it without
  expanding player window infrastructure in this slice. An object-shaped `system.pf1e`
  selects this sheet; generic actors/items retain their existing editor. WindowHost
  popouts and token double-click remain S01 work, not silently removed requirements.
- Read `deriveFromDocuments` with parsed embedded effects, and expose normalization,
  unsupported-field and validation notes. Never show derived totals as editable fields,
  or write an effect-adjusted score back as an authored base. No tables/rules are changed.
- On the first edit to legacy flat saves, materialize the normalized authored save group
  and `savesAsTotal` in the same transaction. Otherwise editing Fort alone discards Ref/Will
  or causes ability modifiers to be added to already-published totals. Preserve unrelated
  actor data and do not migrate entire documents as a side effect of an edit.
- Initial UI is intentionally bounded: numeric authored inputs and derived summary/attack
  readouts. Armor/weapon authoring, dedicated monster editor, richer HP fields, rolls and
  timer authoring are not claimed complete. The TODO records those remainders.
- Validation: 828 unit tests passed / 3 skipped; typecheck, lint, build and size passed
  (1.884 MB raw). Added Playwright sheet flow collects for all three projects. Browser
  execution is unverified: installing Chromium failed with download `ECONNRESET`.

## D-115 — PF1e P1 floating sheets and token activation through projected actor access

**Date:** 2026-09-08. **Tracking:** `PF1e_Unified_TODO.md` S01/S04 implementation progress;
checkboxes remain open pending actual browser acceptance.

- Both app paths use `openPF1eSheetWindow` and the existing WindowManager/WindowHost.
  Sheet-row navigation and token double-click identify the actor; opening resolves it
  from the client's projected store and requires actor read permission. Movement ownership
  of a linked token is neither required to inspect a readable actor nor sufficient to
  inspect a private actor. No host-private lookup or core document/schema change.
- Window payloads contain actor IDs, not captured actor objects. `PF1eSheetWindow` subscribes
  to snapshots/Ops/rejections/welcome and disposes subscriptions on close. It clears the
  content on revocation/deletion and uses a generic title to avoid retaining private names
  in window chrome. Reopening restores/focuses one stable window per actor.
- CanvasController gains an optional, system-independent `onTokenActivate` callback and
  DOM dblclick adapter. Unmodified left double-click uses existing camera/picking math.
  With activation enabled, a 4-screen-pixel click dead zone prevents inspection from
  submitting moves/snapping an off-grid token. Real drags, pan, ping and ruler gestures
  retain their paths; non-activation consumers retain their previous behavior.
- The player shell now hosts sheet windows over a positioned canvas area; this does not
  expose new GM tools or add player undo/redo capabilities. Its sidebar scrolls when the
  expanded sheet exceeds the viewport.
- Tests: topmost camera-transformed picking, non-movable readable tokens, click-vs-drag,
  modifier exclusion, DOM event cleanup, singleton/restore, live data/effects and real
  player revocation/regrant/deletion. Full suite: 835 passed / 3 skipped. Typecheck, lint,
  build and size pass (1.887 MB raw). Expanded Playwright sheet spec collects for all three
  projects; no browser execution claim (browser download previously failed).

## D-116 — PF1e P1 bounded detail authoring and missing-parent edit repair

**Date:** 2026-09-08. **Tracking:** unified TODO S02 partial; S03 regression repair.

- Add authored armor/AC component, string-list feat/trait and descriptive monster editors
  through the existing authorized submit path. The monster tab exists only for an object
  `system.pf1e.creature`; adding that block is an explicit user action, not pack-based inference.
  CR accepts textual fractions; senses/special attacks remain descriptive metadata.
- P0 AC derivation prioritizes published totals. Do not invent a decomposition, clear totals
  implicitly, or present ineffective armor changes as successful: component editing for
  those actors is disabled with an explanation pending explicit conversion work.
- Preserve structured imported list/monster fields as read-only data, with full readback.
  Text/list edits compare their expected value against the current local document; this
  catches known stale edits but does not add host-side conditional-write semantics. Diffs
  remain narrow and preserve unknown sibling metadata. Lists and text have bounded lengths.
- Armor check penalty and spell failure are visibly record-only until their mechanics land.
  Clearing maximum Dex means no cap, not a zero cap; derived statistics remain read-only.
  Weapon authoring, richer HP fields and ER remain open; this is not full S02 acceptance.
- Found a prior-slice bug: `applyDiff` rejects missing intermediate objects, so a first
  `abilities.str` or base-save edit on a partial/imported actor could fail despite a correct
  looking Op. Materialize only the missing authored group (with normalized siblings), not
  the entire actor. Tests apply these Ops to every shipped bestiary actor and empty actors.
- Validation: 843 tests passed / 3 skipped, typecheck/lint/format/build/size passed, 1.895 MB
  raw HTML. Browser spec extended and collected; Chromium executable absent, no browser
  execution claim. No core document, rules table, pool schema or package version changes.

## D-117 — PF1e P1 tactical weapon authoring and canonical defense preservation

**Date:** 2026-09-08. **Tracking:** unified TODO S02 partial; no new combat resolver.

- Add a bounded attack-line editor over the existing P0 attack descriptors. Authoring
  supports names, simple NdM dice, static damage, type, threat/multiplier, range/reach
  and existing boolean flags. Optional-field clearing deletes the key instead of writing
  a misleading zero. Derived totals remain read-only. Complex dice expressions, extra
  weapon mechanics, attack legality/rolls and critical/damage resolution remain later work.
- On the first legacy weapon edit, materialize the normalized tactical attack array only.
  Keep the raw strategic weapon object intact and visible: tactical edits are not a silent
  rewrite of strategic data. Tests pin unchanged derived attack readouts on first
  materialization for all six shipped bestiary entries. Original adapter rule arithmetic
  is reused, not reinterpreted or certified as SRD-correct by this UI slice.
- Existing-row edits use narrow dotted Ops; add/remove replace the array. Preserve unknown
  metadata, reject malformed/structured inputs and known stale local lists, and keep an
  empty array after final deletion so a legacy weapon cannot reappear. The expected-list
  check is local validation, not host-side compare-and-swap for simultaneous writers.
- Expose existing DR/SR/fast-healing/regeneration inputs, explicitly marked record-only
  where mitigation/recovery is not automated. Preserve imported object bypass/suppression
  metadata by updating val/value, not replacing the object. Add an HP progress readout;
  temporary HP, ability damage and ER await real contracts rather than inert new fields.
- Found/fixed in `statBlock.ts`: the alias-drop list removed canonical numeric DR and
  regeneration, even on tactical actors. Preserve those values (including mixed inputs)
  and assert normalization idempotence and derived readback. No pool/schema/package
  version changes and no new damage/healing algorithm.
- Validation: 853 tests passed / 3 skipped; typecheck, lint, edited UI/test formatting,
  build and size passed (1.906 MB raw). Real HostSync/ClientSync test covers attack edits;
  Playwright flow covers UI authoring/validation/removal but is only collected. Chromium
  remains uninstalled, so browser execution is not claimed.

## D-118 — Reversible tactical AC selection and manual health/defense contracts

**Date:** 2026-09-08. **Tracking:** P1 / S02 remains partial.

- Add `system.pf1e.acMode: "components" | "published"`. Absence keeps historical source
  selection. Component mode explicitly ignores retained AC totals; published mode can
  normalize original strategic totals even when manually authored components now exist.
  This is a tactical choice, not a strategic profile rewrite. No guessed decomposition.
- The owner supplies every armor/shield/natural/dodge/misc component and an optional Dex
  cap, previews both sides through `pf1eSheetView`, then confirms. Preserve published
  totals, effects, unrelated armor metadata and all other source data. A second preview
  can restore original published totals. Reject opaque armor imports rather than overwrite.
  Snapshot checks cover the actor, including effects/ownership; rebuild from latest local
  projection at submit. They are local stale-preview guards, not distributed host CAS.
- Introduce a typed, pure P1 read contract for canonical `tempHp` and per-type
  `energyResistance` (acid/cold/electricity/fire/sonic). These are manually adjudicated
  remaining/effective values, not stacks of grants. UI labels state this limitation;
  current/max HP do not include temporary HP. Invalid values contribute zero with issues;
  unsupported resistance keys remain authored and are reported, never silently applied.
  Numeric edits preserve resistance siblings; opaque group/temp-HP imports are protected.
- Rule checks: [Temporary Hit Points, CRB p.191](https://aonprd.com/Rules.aspx?ID=171)
  keeps temporary HP distinct from real HP/Constitution increases, consumes it first and
  does not heal lost temporary HP; [Energy Resistance](https://www.d20pfsrd.com/gamemastering/special-abilities/#energy_resistance)
  is typed per-attack mitigation, not immunity or a spent resource. Only the P1 storage
  boundary is implemented here. Automatic absorption, expiry/stacking, Con/HD HP changes,
  mitigation and healing await their owning phases. Ability damage/drain is not guessed
  or partially propagated; broader rule-plan disputes remain open.
- Evidence: 862 tests passed / 3 skipped (111 files passed / 1 skipped); real host/GM/player
  round trips for health and reversible source changes; typecheck/lint/edited UI and test
  formatting/build/size/system-package build passed. HTML 1.913 MB raw (2,006,409 bytes).
  Browser flows extended and six cases collected only. Chromium download retried and
  failed with TLS ECONNRESET from cdn.playwright.dev; browser acceptance remains unverified.
  No core document/pool schema, strategic resolver or package version changes.

## D-119 — Executed PF1e sheet acceptance and browser-only runtime fixes

**Date:** 2026-09-08. **Tracking:** P1 S01/S04 Chromium acceptance; S02 remains partial.

- Playwright's CDN remains inaccessible, but an external npm-distributed headless
  Chromium (`@sparticuz/chromium@149.0.0`, browser 149.0.7827.0) runs here. Add optional
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the Chromium project, preserving the pinned
  default. Do not adopt the package's suggested security-disabling flags. The run used
  ordinary Playwright launch defaults and external library path `/tmp/al2023/lib`.
  Browser/dependency assets remain outside Git; README documents the binary override.
- Actual browser execution exposed two PF1e UI bugs: `derived` as a prop shadows the
  Svelte `$derived` rune and triggers an invalid store subscription; rename it to
  `derivedAttacks`. AC preview cloned a Svelte proxy; snapshot the actor at the UI
  boundary and use `$state.raw` for request/preview. Latest-store apply/staleness and
  permission checks are preserved. Exercise stale-preview refusal via a second window.
- Shipped compendium drag in a live two-peer world exposed a projection exception:
  D-019 default ownership was present only on the store clone, absent on the raw create
  passed to projection. Mirror that private default locally in `createVisible`; don't
  broaden ownership or mutate the envelope. Private actor/public linked-token creation
  now reaches peers correctly without leaking the actor. Add real two-player host
  regression and actual player token-to-sheet/revocation/regrant coverage.
- Wider window tests exposed a Settings temporal-dead-zone error: initialize rules after
  `DEFAULT_RULES`, not before. No settings mechanics changed.
- Evidence: **9 actual Chromium browser tests passed** (4 sheets, 5 existing windows),
  `file://` build, including all six shipped bestiary actors and clean PF1e page-error
  assertions. **863 unit/integration tests passed / 3 skipped**, typecheck/lint/edited-code
  formatting/build/size passed; raw HTML 2,006,541 bytes, gzip 579,746. Firefox/WebKit and
  pinned Chromium were not executed, so no complete supported-matrix acceptance claim.
  S01/S04 checkboxes retain that matrix gate; ability damage/drain and combat automation
  remain future scoped work. No new rule formulas, wire formats or package versions.

## D-120 — Repair scoped delayed-marker cleanup without claiming PF1e scheduling

**Date:** 2026-09-08. **Tracking:** T03 partial, bounded generic tracker prerequisite.

- The round-wrap loop checked the wrong flag level. Delegate to `clearDelayed` for each
  combatant, preserving scoped siblings and other modules. The bug left non-starting
  combatants marked until their individual turn start; it was not literally permanent.
- Keep the existing generic marker lifecycle (start/end/turn start/round wrap). Rename
  the button “Mark delayed” with an explicit no-rescheduling tooltip, and remove false
  core comments claiming that marking delay acts last or changes UI order.
- Rules boundary: PF1e Delay changes initiative when the delayed action is taken and
  may cross the round boundary before the original turn; it does not merely clear at
  a round boundary (CRB p.203, [2](https://www.aonprd.com/Rules.aspx?ID=200)). The generic
  cleanup repair is not implementation of that rule. PF1e delay/resume, surprise and
  flat-footed transitions still need separate state/verified scheduling work.
- Add three core tests (non-starting marker, metadata/effect preservation, metadata-only
  behavior) and a real three-combatant browser regression. No new document fields,
  initiative policy, effect tick policy or combat resolution formulas.
- Validation: 866 tests passed / 3 skipped (111 files passed / 1 skipped), 11 actual
  Chromium combat/sheet/window tests passed, typecheck/lint/edited-code format/build/size
  passed. HTML 2,006,597 bytes raw, gzip 579,796. Alternate Chromium 149 as D-119;
  full browser matrix, P1 ability damage/drain and remaining T03 work stay open.

## D-121 — Scene-scoped encounter creation and replicated selection

**Date:** 2026-09-08. **Tracking:** T04 delivered for the GM tracker.

- Replace arbitrary first-combat lookup with a named encounter selector using scoped
  flags: combat `core.sceneId`, scene `core.activeCombatId`. A single pointer per scene
  avoids inconsistent per-combat active booleans. Create and select are atomic submit
  Ops; switching preserves encounter progress and does not reset initiative or effects.
- New rosters copy active-scene tokens with optional linked actor IDs. Normal Start
  retains the one-action create/start path when there is no selected encounter. An
  explicit missing/cross-scene pointer shows no selected encounter rather than falling
  back unexpectedly. Unbound legacy encounters remain accessible only from the first
  stored scene; absent-pointer fallback preserves legacy first-encounter behavior there.
- Keep this generic: no PF1e formulas, actor-aware initiative, token selection policy,
  surprise/action budget or hidden-roll behavior is introduced. Core documents and
  transitions are unchanged; this is an authored binding/selection adapter over them.
- Validate selection permissions on current projected documents, preserve other core
  flags, and refresh on rejection. Host authorization remains decisive; these checks are
  not host CAS. Concurrent activation has the existing last-authorized-write semantics.
- Two-scene browser acceptance exposed Add token still writing to DEFAULT_SCENE_ID;
  fix its parent reference to the active scene, matching the coordinates already used.
- Evidence: 871 tests passed / 3 skipped, 12 Chromium combat/sheet/window tests passed,
  typecheck/lint/edited-code formatting/build/size passed. Tests include legacy binding,
  stale pointer, permission denial, applied flag Ops, metadata preservation and real
  host/GM/player replication with inactive-round retention. HTML 2,009,452 bytes raw,
  gzip 580,819. Alternate Chromium 149 as D-119; Firefox/WebKit remain unverified.

## D-122 — Public actor-aware initiative and explicit reroll policy

**Date:** 2026-09-08. **Tracking:** T02 partial; no hidden-roll/tie-resolution completion.

- Use current projected actor/effect data and the shared sheet derivation for PF1e
  initiative; generic actors remain unmodified d20. Prefer the combatant's actor link,
  with scene-token fallback for older null-actor rosters. Validate the entire roster
  before RNG; missing actor/token, wrong scene, malformed PF1e data or hidden roster
  prevents any proposed update. Current encounter/permission checks remain at submit.
- Record die/modifier/total/explanation/actor ID under combatant `flags.core.initiativeRoll`.
  The roll is explicitly public and local, not cryptographically verified. A public
  result can expose the modifier of a private actor without publishing its document;
  hidden-token/combatant rolls are blocked until their own verification/projection path.
  No new feat-name parsing or core sorting changes.
- Initial all-unrolled initiative at round 1, turn 0 establishes the first combatant.
  Subsequent rerolls/manual edits preserve current combatant identity while re-sorting,
  without turn-start hooks or extra effect ticks. Manual edits invalidate old receipts.
  Actor/effect changes do not retroactively alter an already recorded initiative roll.
- Fix derived initiative dropping Dex when denied Dex to AC. The rule is a Dexterity
  check, and flat-footed removes the AC bonus, not the initiative modifier. Ties use
  total initiative modifiers and then a tie roll, not Dex alone (CRB p.178 Initiative,
  [1](https://www.aonprd.com/Rules.aspx?ID=95)). Tests pin the corrected +1 for flat-footed
  Dex 12 and the effect-aware +9 for Dex 16 / authored +4 / active +2.
  Automatic tie handling remains unimplemented; stable order + GM adjudication is
  explicitly disclosed in the tracker. No automatic flat-footed transitions added.
- Validation: 879 tests passed / 3 skipped, 12 actual Chromium browser tests passed,
  typecheck/lint/new and edited UI/test formatting/build/size passed. HTML 2,012,386 bytes
  raw, gzip 582,120. Seven new model tests and one real host/GM/player test cover totals,
  effects, turn retention, initial order, malformed/hidden data, and manual receipt clearing.
  Browser exercises real compendium-token links. Alternate Chromium 149 as D-119;
  Firefox/WebKit and the rest of T02 remain open.

## D-123 — PF1e public initiative tie resolution with stable persisted order

**Date:** 2026-09-08. **Tracking:** T02 partial, automatic public tie policy implemented.

- Implement CRB p.178 Initiative's verified rule (D-122;
  https://www.aonprd.com/Rules.aspx?ID=95): compare equal-total combatants by total
  initiative modifier, then roll still-tied groups. Use unmodified d20 roll-offs;
  equal modifiers cancel. Only duplicate subgroups reroll; resolved positions do not.
- Apply the PF1e policy to batches containing a PF1e actor, including mixed rosters.
  Generic-only batches and manual overrides retain stable ties. The UI states both
  boundaries. Read modifiers from the same roll snapshot, not live later actor data.
- Preserve the resolved relative order in the combatant array. Core's stable equal-total
  sort retains it during next/start/round-wrap, without fractional totals or a PF1e
  comparator in core. Existing defeated-last behavior is unchanged. D-122's initial-roll
  and active-identity-preserving reroll policy remains in force.
- Extend the public roll receipt with `tiePolicy` and per-combatant `tieRolls` histories.
  These record how order was determined, not extra initiative bonuses or cryptographic
  proof. Manual overrides still clear stale receipts. No package/schema version bump.
- Reject invalid dice and unresolved ties after 20 roll-off rounds on a still-tied path.
  Discard the full proposed transition; retain the old encounter unchanged. This is a
  defensive retry bound, not a rule that settles ties by insertion order or arbitrary IDs.
- Validation: 889 tests passed / 3 skipped, 13 actual Chromium browser tests passed;
  typecheck/lint/edited-code formatting/build/size/build:systems passed. Six rule-helper
  fixtures, four adapter regressions, and updated real host/GM/player replication test
  cover order/receipt persistence. Browser deterministically ties two shipped actors
  through the real DOM handler and checks turn/round order. HTML 2,013,894 bytes raw,
  gzip 582,633. Alternate Chromium 149 as D-119; Firefox/WebKit remain unverified.
  T02 remains open for selected-token and verified hidden-roll work; no P1 closure claim.

## D-124 — Scene-scoped canvas selection into encounter roster and initiative workflows

**Date:** 2026-09-08. **Tracking:** selected-token portions of T01/T02, both still partial.

- Reuse CanvasController's existing click/marquee selection callback; route local
  `{sceneId, ids}` through App to the GM tracker, with count/names and an explicit clear
  control. No selected flags are persisted on tokens or interpreted as permissions.
  Preserve right/middle/Shift pan gestures. Clear/cancel selection gestures on scene
  changes; pending pointer-up cannot submit a stale drag after that cancellation.
- New encounters copy selected tokens (including actor links), using all current-scene
  tokens only when the selection is empty. Nonempty foreign/deleted selections reject
  instead of being filtered down into an implicit all-token fallback. A deletion keeps
  the local selection visibly stale until explicit clearing/reselection. Starting an
  existing encounter does not rebuild its roster from the current selection.
- Add selected is idempotent and keeps existing data. Remove selected preserves current
  combatant identity, never ticks effects or advances the turn, and rejects removal of
  the active member while combat is running. Advance/end first; this avoids inventing
  scheduler semantics in a roster-edit operation. All changes still use authorized Ops.
- Selected initiative validates membership and rolls only the selected subset. Unselected
  records remain byte-for-byte equivalent; D-122 active-turn policy and D-123 within-batch
  ties apply. Cross-subset equal totals reject the proposal and ask for explicit Roll all
  or a manual override. Do not silently expand the randomization scope, rewrite another
  combatant's receipt, or invent a modifier for an unrecorded old result. An explicit
  Roll all control remains available even with selection. Hidden chosen tokens remain
  blocked by the existing public-roll validator; no hidden-roll verification added.
- Evidence: 899 tests passed / 3 skipped, 15 real Chromium browser tests passed,
  typecheck/lint/edited-code formatting/build/size passed. Tests include real host/GM/player
  replication of selected roster edits/partial rolls and unchanged unselected records.
  Browser uses actual marquee/click gestures and undo-deletion, not injected selections.
  HTML 2,018,741 bytes raw, gzip 584,344. Alternate Chromium 149 as D-119; Firefox/WebKit
  remain unverified. Context menu/hidden state, verified hidden rolls and remaining
  P1/P2 mechanics remain future work. No schema, wire format or package version changes.

## D-125 — GM control overrides the D-124 active-removal and selected-tie restrictions

**Date:** 2026-09-08. **User correction:** GM must be free to remove/change active or
non-active combatants whenever desired. D-124's two blocking policies were too restrictive.

- Allow immediate active-combatant removal, including batch and last-member removal.
  Retain the active identity if it survives; otherwise choose the next surviving member
  in the old sorted order, wrapping as necessary. Preserve the round; no automatic
  advancement, effect ticks or turn lifecycle hooks. This is GM roster editing, not a
  gameplay turn action. Show “No combatants” for an emptied running encounter.
- Accept selected rolls even when their totals tie untouched results. Keep stable
  cross-selection order and all untouched receipts, annotating newly tied receipts with
  `crossSelectionTie: "stable-order"`. Full Roll all tie resolution is optional, not a
  prerequisite imposed on the GM. Existing manual initiative edits remain unrestricted
  by active status. Permission and invalid/stale-reference checks remain in place.
- These policies explicitly supersede D-124's active-removal veto and cross-subset tie
  rejection. Future gameplay automation should not veto valid GM authoring simply to
  avoid resolving tracker state. No new map-token deletion behavior is introduced;
  these controls edit the encounter roster.
- Validation: 900 tests passed / 3 skipped, 15 real Chromium combat/sheet/window tests
  passed, typecheck/lint/edited-code formatting/build/size passed. Added successor test,
  replaced restrictive expectations, and extended browser/peer tests through active/last
  removal and accepted selected ties. HTML 2,018,848 bytes raw, gzip 584,394. Other
  unfinished TODO work and Firefox/WebKit acceptance are unchanged.

## D-126 — N01/N02: the active sim schema and scene are host-announced in the welcome

**Date:** 2026-09-09. **Scope:** PF1e_Unified_TODO §2 (multiplayer correctness),
protocol slice per the file's recommended execution order.

- `WelcomeMsg` carries optional `sim` info (`WelcomeSimInfo`: scene id, SysSchema
  column map, package id, version). `HostSync.setSimInfo()` owns it: called by
  hostBoot AFTER the §12 rules boot resolves the active package's schema and
  BEFORE the GM loopback `addSession`, so every welcome (GM and joiners) carries
  the real battle. A _changed_ announcement re-welcomes live authenticated
  sessions; identical re-announcement is a no-op (reconnects stay seamless).
  `null`/absent keeps legacy worlds exactly as before.
- `ClientSync` adopts the announcement in its welcome handler: no constructor
  guess needed. First adoption overrides any constructor `simSys`/`simSceneId`
  (the old joiner hardcoded `MASS_BATTLE_SCHEMA_COLUMNS` + `scene-1` and could
  not decode a PF1e campaign at all); a changed re-announcement discards the
  replica/pending deltas and re-requests a snapshot (in-flight dedup matches
  the existing gap path). Constructor options remain for direct unit tests.
  Pre-start requests are a host-side no-op (`SimBridge.started` gate) — the
  campaign's `start()` broadcast is each joiner's first frame either way.
- joinBoot no longer imports the schema guess; hostBoot's GM loopback rides the
  same adoption path as remote joiners. PROTOCOL.md welcome section updated
  (doc-consistency test green). e2e surfaces expose `simInfo()` (GM + player).
- Tests (`tests/host/simAnnounce.test.ts`, 5 cases): verbatim welcome contract;
  no-guess adoption + exactly one pre-start `sim.snapshot.get`; wrong-guess
  override + replica discard; idempotent re-announce vs. package-switch reset
  with snapshot rebuild (last sim event = snapshot); wire-level
  adoption→delta-queue→snapshot→replay ordering with signed i8 intact; N02
  mid-battle joiner receives seeded PF1e columns (u8 AC 18, i8 fort −2, u16
  profile idx) through BOTH the snapshot and the delta path (next → advance)
  against the real `createMassBattlePf1e()` rules.
- `e2e/pf1e_join.spec.ts` (collected, 3 projects; NOT executed — no browser
  binaries in this environment): import+activate dist zips → reload → PF1e
  rules boot → GM simInfo carries the PF1e schema → manual-signaling joiner
  adopts the identical battle → 10-model campaign start + resolved turn reach
  the player's replica with zero page errors. Browser execution and the
  Firefox/WebKit matrix remain open, so N01/N02 stay unchecked in the TODO.
- Validation: 905 tests passed / 3 skipped (116 files + 1 skipped); typecheck,
  lint and touched-file Prettier pass; build 2,020,346 bytes raw / 584,769
  gzip (within the 6 MB budget); `build:systems` emits both PF1e packages.
  `rulesBoot`-driven live package switching remains reload-based as before
  (D-087/D-110); the re-announce machinery is the protocol-level resync path.

## D-127 — R01: Implementation Plan rule references corrected against the Gap List appendix

**Date:** 2026-09-09. **Scope:** PF1e_Unified_TODO §0 reconciliation, before any
P3+ rule encoding.

- Verified every `A.x` citation in PF1e_ImplementationPlan.md against the
  headings actually transcribed in PF1e_Combat_Fidelity_GapList.md Appendix A
  (A.1 round/initiative … A.18 regeneration/massive damage). Fixed 13 wrong
  targets and removed the three phantom entries (A.19/A.20/A.21): sheet-derivation
  accept now cites A.2/A.9/A.14 (was A.2/A.8/A.15); the cover/concealment
  modifier stack and its P5 accept cite A.8 (was A.7/A.5); splash cites A.12
  (was A.18); initiative-Dex cites A.1 (was A.15); diagonals cite A.7 (was
  A.5); defensive casting cites A.16 (was A.19); maneuver aftermath + accept
  cite A.9 (was A.11); AoO exclusion list cites A.10 (was A.12); mounted cites
  A.11 (was A.21); object/hardness cites A.17 (was A.18). The dying/stable A.13
  and attack-stack A.2/A.3/A.4 citations were already correct; the SR
  no-auto-success citation was verified to belong to A.16 (those rules close
  that section) and stays.
- Two rules have NO appendix entry yet: the Two-Weapon Fighting penalty table
  and Charge. The plan now names the SRD pages as the canonical source and
  requires transcribing them into Appendix A before fixtures are written, so
  V01 can never snapshot a missing table as expected truth. G/M/B carry no
  other phantom appendix references (checked).
- No code, contracts or tests changed; the three source documents other than I
  are untouched. This closes R01 only — R02 (disputed-rule verification) and
  R03 (intentional variants) remain open.

## D-128 — S02 closed: ability damage and drain are authored accumulators with rule-exact propagation

**Date:** 2026-09-09. **Scope:** S02 final slice; `pf1e/actor.ts` derivation, sheet
model/Svelte, tests. Source: CRB p.555 "Ability Score Damage, Penalty, and Drain"
(AoN Rules ID 416), read in full before any code or fixture was written.

- **Authored contract:** `abilitiesDamage`/`abilitiesDrain` are
  `Partial<Record<PF1eAbilityKey, number>>` (non-negative integers, zero-filled on
  read; malformed values are issues contributing zero, never a crash), plus
  `hitDice` (non-negative integer, default 0 — the bestiary pack has no HD data,
  which is why this is authored at all). Malformed input to `parsePF1eActorSystem`
  is rejected before any op is submitted.
- **Damage never reduces the score** (the rule's own headline): it applies
  `floor(damage/2)` as a penalty via an _effective modifier_ (`mods − penalty`)
  to every ability-based statistic — AC/capped Dex, touch, component saves,
  initiative, CMB/CMD, attack to-hit and melee ability damage (×1.5/×0.5 rounded),
  AoO count, spell DCs keyed to the ability. Published save totals and published
  AC totals (normal/touch) take the penalty on top like effects do; flat-footed
  AC never does (Dex already excluded). Reconstruction arithmetic under authored
  totals subtracts the RAW Dex contribution and then the penalty exactly once.
  Stat-block attack lines flagged `abilityDamageIncluded` lose the flat Str
  penalty; ranged lines are exempt from Str.
- **Drain actually reduces the score** (clamp ≥ 0), so every derived statistic
  follows the new modifier; drain and damage stack (score reduced, then penalty).
- **Constitution HP:** when `hitDice > 0`, current AND max HP each move by
  `hitDice × (Con-mod drain delta − Con damage penalty)`; without authored HD the
  adjustment is an `unsupported` note ("hitDice: not authored"), never a guess.
  Fort and the dying threshold use effective Con.
- **Thresholds:** damage ≥ current (drained) score ⇒ `unconscious` joins
  conditions; Constitution ⇒ `dead`. Natural 1/day healing and penalties-vs-damage
  (no threshold, floor 1) are runtime/actor-state concerns, not derivation.
- **Surface:** 13 SHEET_FIELDS entries route through the existing editor op path
  (first edit materializes only the missing accumulator; structured non-object
  imports are read-only, matching D-118's resistance policy); the attributes tab
  shows effective scores/modifiers plus a damage/drain readout with per-ability
  penalties. New derived fields `abilityDamageTaken`/`abilityDrainTaken`/
  `abilityDamagePenalty` (zero-filled `PF1eAbilities`), `abilityMods` now returns
  effective modifiers; `explain.abilities`/`explain.hp` added.
- **Verification:** 19 new tests (14 derivation fixtures hand-computed from the
  rule text — including 1-point-no-penalty, Str 3/Dex 5 propagation, drain+damage
  stacking, Con HP with and without HD, thresholds against the drained score,
  published totals, spell DCs, included-bonus lines, malformed accumulators,
  bestiary parity with empty accumulators — and 5 sheet-model op/edit/readout
  tests). Full suite 924 passed / 3 skipped; typecheck/lint/format/build/size
  green (dist 2,025,106 raw / 586,250 gzip, was 2,020,346/584,769). S02 is
  checked off: temp HP (D-121 flow), ER, weapons, armor, features and the
  conditional monster tab landed in earlier slices; this was the last listed
  gap. In-journey healing (1/day, penalties) remains a P3+ runtime concern.

## D-129 — R02: eighteen disputed rules verified against authoritative sources; G/I/B/M repaired

**Date:** 2026-09-09. **Scope:** R02 reconciliation — every rule the TODO flagged as
having conflicting or suspect statements across G/I/B/M was checked against the PRD
text (AoN rule IDs or verbatim PRD quotes) before any repair. No runtime code changed:
where code exists it already matched the verified rule (notably
`attacksOfOpportunityPerRound()` vs the strategic `maxAoos` deviation, which §10.2
documents), and the remaining rules are future-phase work whose fixture oracle is now
the corrected Appendix A / scenario text.

- **Surprise (A.1, I S1, I §3.3):** all three docs had it backwards. Correct (CRB
  p.178): only combatants that started the battle AWARE act in the surprise round, one
  standard or move action each (plus free actions); unaware combatants do not act and
  are flat-footed. A surprise round requires some-but-not-all aware.
- **Initiative ties (A.1, I S1):** "highest Dex bonus" is wrong — ties are broken by
  the **total initiative modifier** (Improved Initiative +4 counts), then reroll. A
  later Str buff never rewrites an initiative result (only delay/ready reorder
  mid-combat), so I's S2 "initiative order changes" claim is removed.
- **Delay/Ready (A.1):** delay does NOT lose the standard action — you act normally at
  any lower count (full-round allowed) and your initiative permanently drops (AoN ID
  200, CRB p.203). Ready was missing entirely: standard action, readies a
  standard/move/swift/free action, resolves just before the trigger, initiative moves
  immediately ahead of the triggerer, lost if untriggered by your next turn (AoN ID
  201).
- **Touch AC (A.2):** the appendix omitted Dex. Correct: 10 + Dex + size + misc (dodge
  applies; armor/shield/natural are the only losses). The sheet's `acFromBreakdown`
  already computes this — the appendix, not the code, was wrong.
- **AoO budget (A.10, §10.2):** the appendix had encoded the strategic sim's house
  rule (`1 + max(0, dexMod)`) as SRD truth. Correct (Combat Reflexes "Normal" text):
  **one AoO per round, period**; additional AoOs equal to your Dex bonus come only
  with Combat Reflexes, which also permits AoOs while flat-footed. The garbled
  "threaten with a reach weapon" parenthetical and the untranscribed "resets at the
  start of your turn" were removed; §10.2's deviation quote updated.
- **Charge (I §7):** I listed "bull-rush/charge −2" as an attack modifier and showed
  "− 2 charge" in the example breakdown. Correct (CRB p.198): +2 on the attack roll,
  −2 to AC until your next turn; a charging bull rush takes +2 on the CMB. G's own §7
  and mounted rows were already right.
- **Bull's Strength (I S2 + effect JSON):** +2 enhancement / 1 round/level was
  invented. The spell is **+4 enhancement, 1 min/level** (CRB p.250): at CL 8 the
  badge reads 80 six-second rounds. Scenario retitled "Bull's Strength for 8 minutes".
- **Evasion vs ordinary half (I S3, M Task 5):** ordinary characters take half on a
  successful save — round down, **no minimum** (the "min 1" was a conflation with the
  minimum-damage rule, which is 1 point of nonlethal on weapon attacks, A.3); Evasion
  takes 0 on success; Improved Evasion half even on failure. M's pipeline never stated
  the ordinary-half step; added.
- **Defensive casting vs injury (I S4):** the scenario applied the injury formula
  (10 + damage + spell level) to a "cast defensively" beat. Both are now stated:
  defensive = DC 15 + 2 × spell level (no AoO); injury while casting = 10 + damage
  taken + spell level (PRD Concentration table; A.16 was already correct).
- **Prone/grapple (I §P6, B bitmask):** grapple makes nobody flat-footed (verified
  grappled condition: −4 Dex, −2 attack/CMB rolls, no AoOs, no two-hand actions, cast
  only with a DC 10 + grappler's CMB + spell level concentration check); pinned is the
  state that denies Dex. B's "loses DEX to AC / no somatic spells" row and merged
  Stunned/Dazed row were split and corrected; prone attacker ranged = crossbow or
  shuriken only (verified modifier-table footnote — A.14 was already right).
- **Mounted (A.11):** the higher-ground +1 applies vs a foe **smaller than your
  mount** that is on foot (CRB p.202), not "a smaller foe".
- **Dying/stabilization/nonlethal (A.13, I S5):** "standard action ⇒ DC 10 Con check
  (−1 per damage taken)" was invented — at 0 HP you are staggered and a standard action
  simply deals 1 damage after the act (AoN ID 164/166). The dying check is DC 10 Con
  with a **penalty equal to your negative HP total** (nat 20 auto-stabilizes, fail ⇒
  −1 HP); Heal DC 15 first aid (standard action, provokes). Nonlethal: staggered at
  exactly equal to current HP, unconscious in excess ("staggering at half" was
  invented); −4 to deal nonlethal with a lethal weapon and vice versa.
- **Coup de grâce (A.13, I S5):** "skips the save" removed — the Fort save (DC 10 +
  damage dealt) is mandatory if the target survives the auto-crit; delivery provokes
  AoOs; bow/crossbow only while adjacent; crit-immune creatures skip both crit and
  save (AoN ID 413).
- **Temp HP stacking (A.13):** "don't stack between different spells" was backwards.
  Paizo FAQ: the **same source** doesn't stack (highest applies); **different
  sources do stack**, tracked separately.
- **DR/precision/riders (A.17):** "precision damage ignores DR" was wrong — sneak
  attack is part of the weapon attack's damage total and is reduced by DR together
  with it. DR does negate ability damage/drain, energy riders, touch attacks and force
  effects.
- **Firearms (G §2.9):** the transcribed numbers verified correct against UC p.135
  (early: touch AC within 1st increment, max 5; advanced: within 5th, max 10; −2 per
  increment beyond; never a "touch attack" for Deadly Aim). **Misfire/clearing/jam
  rules are transcribed nowhere** — they join TWF and Charge on the
  transcribe-before-fixtures list; no conflicting statement existed to repair.
- **Invisibility Stealth (A.8, B bitmask, G §6):** +40 Stealth while stationary, +20
  while moving (G §6 had the values swapped and tied to "passive/attacking"); B's
  invisible row gained the modifiers.
- **Spell-per-round/components (A.6/A.16, B §4.4):** verified already correct —
  one swift per turn (immediate on your turn counts as swift; off-turn immediate eats
  next turn's swift), concentration = d20 + CL + ability mod, defensive/injury DCs,
  component restrictions (V impossible while gagged/silenced, 20% spoil when
  deafened; S needs a free hand; M/F/DF free action). No repair needed.
- **B §4.2 Stealth formula:** the "− Cover Bonus" sign was backwards — cover and
  concealment bonuses accrue to the hider's Stealth (e.g. +10 improved cover), never
  lower the Perception DC.
- **Out of scope by design:** rage/smite magnitudes in B §4.3 are not on R02's list
  and were not verified this pass. No fixtures were added in this slice: the verified
  text above is the fixture oracle for the phases that implement each rule (P3–P7),
  matching how R01 closed.

## D-130 — R03: intentional variants resolved — scatter removed, carryover/envelopment rejected, deviations indexed

**Date:** 2026-09-09. **Scope:** R03 reconciliation. Sources verified before deciding:
Cleave (CRB p.119, verified text), fireball 20-ft radius (the shipped pack's data, the
agreed baseline), SRD flanking (+2, A.14), and the live code (`spells.ts` scatter,
`massBattlePf1e.ts:170` radius literal). No runtime code changed in this slice — the
deviations carry correction paths into P5/P8 and DEVIATIONS.md now indexes them.

- **Invented spell scatter: REMOVE.** The current `spells.ts` behavior is worse than any
  doc described: every model inside a template is _unconditionally_ moved 5 ft away from
  the epicenter (no check, no awareness gate) and takes **no damage** if the step exits
  the radius. Nothing in the SRD lets a creature step out of a fireball. Decision: the
  SRD-fidelity path resolves SR and the save **in the model's square**; P5 deletes the
  scatter and its `modelsScattered` metric. It does not become a `worldSettings` toggle
  (the P0-toggle idea stays rejected); it may return only as a _named_ opt-in setting if
  a mass-battle consumer asks for it — none exists today. Filed as DEVIATIONS D-1.
- **Overkill carryover: REJECTED.** `overkillDamage` remains an analytics metric
  (damage exceeding a model's remaining HP — a reporting number) and never propagates
  damage to another model. SRD Cleave is not spillover: standard action, one attack at
  full BAB, then if it hits one additional attack at full BAB against a foe adjacent to
  the first, −2 AC until your next turn; not triggered by dropping a target. B §4.3's
  "free extra attack upon dropping a target + carryover" was 3.5-flavored invention and
  is repaired to the verified text.
- **Total envelopment (+4 AB / flat-footed): REJECTED.** SRD flanking is +2 melee with
  no flat-footing; no envelopment rule exists. It was plan-only (never in code); M Task 4
  now targets real flanking geometry with per-round set/clear (per Gap List §5), and the
  invented step is explicitly forbidden in the plan text.
- **Combat_Resolver_5 parity ≠ SRD fidelity.** M Task 6's title is relabeled to
  "metric parity": the old resolver is a compatibility reference for which report fields
  exist, never a rules authority.
- **Fireball radius: the pack's 20 ft is the baseline.** The hard-coded
  `radius: 15` literal (`massBattlePf1e.ts:170`) is filed as DEVIATIONS D-2, corrected
  when P5 makes spell orders profile-driven.
- DEVIATIONS.md gets its first real entries (D-1 scatter, D-2 fireball radius) with spec
  section, conflict, minimal change and approval state, plus a rejected-inventions list
  and a pointer to Gap List §10.2 for the standing strategic-scale trade-offs (AoO
  budget, published saves, size ladder) that keep their P8 unification phases.

## D-131 — T05: the PF1e action economy is authored data + a per-turn budget, visible in the tracker

**Date:** 2026-09-09. **Scope:** T05. Sources verified before any code: Table 7-2
"Actions in Combat" and the Action Types text (CRB p.181–182, AoN Rules ID 128),
Start/Complete Full-Round Action (CRB p.185), the immediate/swift rule (CRB p.183),
the 5-foot-step/movement lock (CRB p.189), and swift-actions-in-surprise-rounds
(a swift may be taken "anytime you would normally be allowed to take a free action").

- **The Gap List's A.6 transcription was wrong and is replaced** (the T05 "verified
  table" did not exist until now): run was transcribed "no" (table: **yes**),
  mount/dismount "yes" (table: **no**), and rows like "snipe", "remove curse" and
  "draw a weapon and move" were invented. Appendix A.6 now carries the verified
  Table 7-2 rows with the footnotes (charge/withdraw as standard actions when
  restricted, the BAB +1 draw rules, combat maneuvers substituting for attacks) and
  the restricted-activity paragraph. The invented rows must not return.
- **Shared data:** `packages/pf1e/actions.ts` exports `PF1E_ACTIONS` (all Table 7-2
  rows: id/name/category/provokes/note, ids stable for the UI and tests) and
  `NON_SPLITTABLE_FULL_ROUND` (full attack, charge, run, withdraw — CRB p.185).
- **Budget engine (pure, no dice):** a per-combatant `PF1eActionLedger` under
  `combatant.flags.pf1e.actions` — standard/move/swift slots, an off-turn-immediate
  `swiftReserved` flag, 5-ft-step and movement tracking, a surviving
  `fullRoundPending`, and a `restriction` ("single-standard-or-move" for surprise/
  staggered/slowed). `actionRefusal` returns the rule reason (the UI shows it as a
  tooltip; P3+/P6 action execution will use it as the legality gate), `spendAction`
  applies. Encoded rules: standard+move OR full-round per round; move may substitute
  for standard (two moves legal, two standards never); restricted = one standard OR
  one move — spending either consumes both — with free and swift actions unaffected,
  full-round refused but **start/complete allowed** (CRB p.181/185); one swift per
  turn; an off-turn immediate reserves and then consumes the next turn's swift; any
  movement blocks the 5-foot step and vice versa; a started full-round action
  survives the turn boundary to be completed with the next standard.
- **Wiring:** `readCombatantState` defaults the ledger defensively;
  `pf1eNextTurn` resets the active combatant's ledger at turn start (reservation →
  "swift used", pending survives); `startWithSurprise` and the surprise→round-1
  transition give the first actor a fresh ledger (the latter now also marks
  `acted: true` — previously the first regular actor stayed flat-footed during their
  own turn, an adjacent bug this wiring exposed); `spendCombatantAction` applies a
  spend to a whole CombatDocument.
- **Visible:** the combat tracker shows the active combatant's chips (STD/MOVE/
  SWIFT/5-ft, moved-ft, pending) plus spend buttons (standard, move, move-as-standard,
  swift, full-round, 5-ft step, start/complete full-round) disabled with the refusal
  reason as tooltip, and an off-turn "Immediate" button on non-active rows — only for
  encounters with at least one PF1e-linked actor (same detection as the initiative
  roller), so generic combats never get PF1e flags. `ui/combat/actionBudget.ts` holds
  the pure glue (detection, budget view, permission-gated spend) and is unit-tested
  without a browser.
- **Verification:** 20 new tests (11 table/budget fixtures hand-checked against CRB
  p.181–185/189, 5 wiring fixtures including the reservation conversion and pending
  survival across the round wrap, 4 panel-helper tests including permission refusal).
  Full suite 944 passed / 3 skipped; typecheck/lint/format/build/size green
  (dist 2,035,684 raw / 588,837 gzip, was 2,025,106/586,250). Interrupt execution
  (readied/immediate resolution) stays in P6 as the TODO states; setting the
  restriction from the surprise round lands with T03's tracker wiring, and from
  conditions (staggered) with the condition library.

## D-132 — T03: the surprise round, flat-footed transitions and encounter flags run in the real tracker

**Date:** 2026-09-09. **Scope:** T03. Source: CRB p.178 Surprise/Flat-Footed (the
corrected A.1 from D-129). The `flags.core.delayed` round-wrap lookup bug named by the
TODO was already fixed in D-120 with its regression; this slice wired the rest.

- **`checkSurprise` was still encoding the pre-D-129 rule and is rewritten:** awareness
  is per combatant (a defender is aware when their Perception matches or beats ANY ONE
  attacker's Stealth; a defender with no Perception authored notices nothing). A
  surprise round happens when some but not all combatants are aware — including the
  case where one defender noticed but another did not (the old code cancelled the
  round for everyone the moment any defender saw anything). The outcome now carries
  `aware` (attackers + aware defenders — **aware defenders act in the surprise
  round**) and `flatFooted` is the unaware list only, not every defender. No round
  when every defender noticed someone, and none when the marks make everyone unaware.
- **`startWithSurprise` gains an explicit-awareness path:** `unaware: ids` — the GM's
  marks — produce the same outcome shape as the stealth/perception check (the tracker
  path; the GM knows who is ambushing without inventing dice). Unknown ids are
  ignored. The surprise order is the aware combatants in initiative order. The first
  surprise actor's turn starts immediately: `acted` (acting in the surprise round ends
  flat-footed — "unaware combatants are flat-footed because they have not acted yet")
  and a **single-standard-or-move restricted budget** (A.1/A.6 — the T05 wiring this
  slice owed). `pf1eNextTurn`'s surprise branch marks each subsequent surprise actor
  the same way; the surprise→round-1 boundary lifts the restriction (verified by the
  T05 boundary test, now strengthened).
- **New helpers:** `activePF1eCombatant` (during a surprise round the acting combatant
  is the surprise-order pointer — core's `turn` is meaningless while round is 0) and
  `pf1eEndCombat` (core's end + a fresh setup round state, so a restarted encounter
  cannot inherit a stale phase, surprise order or clock).
- **Tracker flow (the actual wiring):** the panel's update diff now carries
  `combat.flags` — until now the PF1e round state was computed and then **dropped on
  submit**, so no client ever saw it. PF1e encounters (≥1 PF1e-linked actor, the
  initiative roller's detection) route Start through `startWithSurprise` (initiative
  must be rolled and ties resolved first; GM awareness marks are pre-start local
  input, cleared on encounter switch), Next through `pf1eNextTurn` (AoO refresh, held
  delivery, world clock and budget reset now actually flow), and End through
  `pf1eEndCombat`. A surprise round renders as a running tracker state ("Surprise
  round · 2/3 aware") even though core's round is still 0, the active row and budget
  bar follow the surprise pointer, and every roster row shows a flat-footed chip with
  its reason (surprise / has-not-acted). Generic encounters keep the plain core
  transitions with no PF1e flags written.
- **Verification:** 3 surprise tests rewritten/added against the corrected rule
  (mixed awareness with an aware defender acting, all-aware and all-unaware refusals,
  explicit marks with unknown ids ignored, actor marking through the surprise round,
  end-of-combat reset) plus strengthened assertions in the two existing surprise
  fixtures. Full suite 947 passed / 3 skipped; typecheck/lint/format/build/size green
  (dist 2,044,962 raw / 591,474 gzip). T03 is checked off; the PF1e resume/interrupt
  logic beyond this (delay/ready rescheduling, held-action interrupts) remains P6/T05
  follow-up work as the plan states.

## D-133 — T01/T02: a right-click token menu, and hidden initiative as real order + GM-only receipts

**Date:** 2026-09-09. **Scope:** T01 + T02 (the last open P2 tracker items).
Source: CRB p.178 Initiative (D-122/D-123 semantics unchanged); no new rules
research — this slice is UI reachability and hidden-roll verification.

- **T01's gesture is a right-CLICK, not a right-press:** the canvas controller
  tracks the pan button and total pointer movement; a right-button release with
  <4 px of travel over a token fires `onContextMenu({screen, world, tokenId})`,
  while a right-drag still pans (D-057 preserved) and a right-click on empty
  canvas opens nothing. Five gesture tests pin click-vs-drag, empty-space and
  the `contextmenu` DOM suppression that keeps the browser menu out of the way.
  The menu model itself (`tokenContextMenu.ts`) is pure: it reads combat/scene/
  user, and every entry carries `disabled` + `reason`. Entries: the token's
  initiative (informational, always disabled), add/remove combatant (reuses
  `editSelectedRoster` — idempotent additions, D-125 active-removal policy, no
  turn/effect ticks), and toggle hidden (one `tokens` update op). Effect/spell
  entries are deliberately absent until P4/P5 handlers exist, per the TODO.
  Players see state entries but every mutation is permission-gated with its
  reason; the menu closes on Escape, any new canvas gesture, or running an entry.
- **T02's hidden rolls are real order, concealed breakdown:** "hidden" means
  combatant.hidden OR token.hidden (either flag is enough to hide). `rollHiddenInitiative`
  rolls only hidden in-scope members — scope is the selected roster or the full
  encounter — with the same PF1e modifier derivation and invalid-data refusals as
  the public path (D-122), and PF1e tie policy inside the hidden batch (D-123,
  tieRolls recorded per member). Initiative totals ARE written — order is
  observable at the table — but the breakdown (die, modifier, explanation,
  actorId, tieRolls) goes to `flags.pf1e.hiddenInitiative`, and any stale public
  `flags.core.initiativeRoll` receipt is DELETED for rolled members so a
  previously-visible lurker cannot keep leaking its old roll. Untouched members
  keep everything. Permission/scene-gate failures return errors before any RNG
  call, so a refused roll has no side effects at all.
- **Verification, not trust:** `verifyHiddenInitiativeReceipt` re-derives the
  receipt (die in 1–20, total = die + modifier, tieRolls are d20 faces) and the
  GM panel renders a receipt block with ✓/✗ per rolled member. Players see "?"
  in the initiative input (`hiddenInitiativeDisplay`), which is disabled for
  hidden members; the GM sees the real value. The "Roll hidden" button appears
  alongside the existing public roll controls.
- **Test-bug corrections while landing this:** the three initially failing
  hidden-roll tests were wrong, not the code — `skipped` legitimately lists the
  in-scope visible members when no selection exists (Roll hidden with no
  selection means "roll the hidden ones, skip the visible ones"), and a `player`
  fixture was missing from that file. Fixed the expectations, kept the semantics.
- **Evidence:** 18 new tests (5 canvas gesture, 8 menu model, 5 hidden-roll).
  Full suite 965 passed / 3 skipped across 119 files; typecheck/lint/
  touched-file formatting/build/size green; dist 2,054,484 raw / 591,545 gzip.
  Browser matrix remains unverified (no Chromium in this sandbox; §2 S01/S04
  still track that). T01 and T02 are checked off; P2 is complete on the unit
  level — effect/spell menu entries, delay/ready rescheduling and held-action
  interrupts remain P4–P6 work as planned.

## D-134 — A01: typed weapon/armor descriptors, and two rule corrections the encoding surfaced

**Date:** 2026-09-10. **Scope:** P3/A01. Sources: AoN Rules ID 131 ("Attack" ›
Unarmed Attacks), AoN Rules ID 413 (Conditions › Broken), and the Gap List's
already-verified rows (§2.8/§2.9/§2.9b, A.9, A.17) — no new rules research
beyond the two corrections below, each verified against a primary text before
encoding.

- **Two shipped rules were wrong and are corrected with the descriptors:**
  (1) the unarmed damage ladder said Medium 1d2/Large 1d3 — AoN ID 131
  verifies Small 1d2, **Medium 1d3**, Large 1d4 (Huge 1d6 … Colossal 2d6 from
  the SRD table Pathfinder did not republish outside that range); the shared
  `UNARMED_STRIKE_DAMAGE_BY_SIZE` now lives in `weapons.ts` and `actor.ts`
  imports it instead of carrying its own copy. (2) the Gap List A.9 sunder
  paraphrase "≤ ½ HP ⇒ broken" is tightened against the glossary's primary
  text: an item is broken at damage **in excess of** half its HP — `hp <
hpMax/2`, so exactly half is not broken (also encoded in A.17's memory).
- **`weapons.ts` (new):** the authored shape under `system.pf1e.weapons[]` and
  a total `resolvePF1eWeapon` (garbage in ⇒ usable unarmed-strike-shaped
  fallback out, every malformed field named in `issues` — the
  `derivePF1eActor` convention). The descriptor resolves what should never be
  persisted: max range increments by class (thrown 5, projectile 10, early
  firearm 5, advanced 10), the firearm touch-AC window (1st increment early,
  5th advanced), and the broken-misfire escalation (+4). Carried per weapon:
  handedness, proficiency group, damage dice/type, nonlethal, threat range and
  multiplier (kept even when out of range, flagged — never inverted),
  enhancement + special-ability bonus with `effectiveBonusTotal` for the
  /epic comparison, material (`cold iron`/`silver`/`adamantine` — the spaced
  spelling `drBypass` already uses, not the sim's `cold_iron`), alignment
  list, double head, natural/secondary, unarmed, touch, reach, trip/disarm,
  splash, ammo `{type, capacity, loadActionId, consumedPerAttack}` (load
  action ids reference A.6's Table 7-2), misfire, and item wear
  (HP/hardness/broken). `brokenWeaponAdjustments` returns the AoN ID 413
  facts: −2 attack and damage, crit only on a natural 20 at ×2 — the authored
  threat range does not survive the condition.
- **`items.ts` (new):** armor/shield authored shape + `resolvePF1eArmor`
  (slot, proficiency, armor/shield bonus, max Dex, ACP as a non-negative
  number — the sign belongs to the consumers, ASF), `brokenArmorAdjustments`
  (AC bonus halved rounding down, ACP doubled, **no** ASF change — the
  glossary lists none), `itemHpAfterDamage` (hardness first, A.17),
  `isBrokenFromDamage` (the corrected threshold) and `sunderVerdict` (the
  arithmetic half of A.9; the maneuver is P6). No material HP/hardness table
  is invented — the Gap List has no verified one; those are authored per item.
- **Deliberately not encoded:** TWF penalty numbers (the Gap List marks the
  SRD table "not yet transcribed — cite the page when fixtures are written"),
  Gun Training's +2 broken-misfire variant (a feat, A07), nonproficiency −4
  (applied by A02's attack path, carried as data here), and the DR bypass
  ladder itself (A05's resolver — the weapon carries the properties it reads).
- **Evidence:** 18 new tests (10 weapon, 8 armor/wear) including the
  corrections, the total-validator garbage paths, the /epic total, double
  heads, misfire escalation and the full hardness→HP→sunder chain. Two
  existing `pf1eActor` expectations updated to the corrected unarmed dice.
  Full suite 983 passed / 3 skipped across 120 files; typecheck/lint/
  touched-file formatting/build/size green; dist 2,054,514 raw / 591,568 gzip.
  A02–A07 remain open; nothing consumes these descriptors in the attack path
  yet (that is A02's first job).

## D-135 — A02: the tactical attack layer — Table 8-7, natural attacks, unarmed, nonproficiency

**Date:** 2026-09-10. **Scope:** P3/A02. Sources fetched and verified against
primary texts before encoding: Two-Weapon Fighting + Table 8-7 (CRB p.202, AoN
Rules ID 198), Attack — unarmed/natural/criticals/shooting-into-melee (CRB
p.182, AoN Rules ID 131), Natural Attacks UMR (Bestiary p.301), weapon
nonproficiency (CRB p.144 via AoN Firearm Rules' "the standard −4"), armor
nonproficiency (CRB p.153, AoN Rules ID 361). Situational numbers (flanking +2,
charge +2, invisible attacker +2, squeezing −4) were already verified in the
Gap List and are only assembled here.

- **`src/packages/pf1e/tactical.ts` (new, pure):** the Implementation Plan's
  named module for the tactical half. No ModelPool, no dice — callers pass the
  d20 result, so every fixture is exact. The modifier stack
  (`attackModifierParts`) is a list of labeled parts (BAB / Str-or-Dex / size /
  enhancement / broken −2 / weapon nonproficiency −4 / armor ACP / TWF per
  Table 8-7 / secondary natural −5 / unarmed lethal −4 / situational /
  shooting-into-melee / misc), which is what the plan's chat breakdown line is
  built from. `resolveAttackRoll` encodes natural 1 = automatic miss, natural
  20 = automatic hit and threat, and the CRB's two threat caveats: a threat
  range below 20 does not make the roll an automatic hit, and a roll that does
  not hit is never a threat. `selectDefenseAc` covers the touch × flat-footed
  AC combination the cached three-flavor set cannot express (10 + size + misc),
  cross-checked against `acFromBreakdown` in tests.
- **Table 8-7 exactly:** normal −6/−10, light off-hand −4/−8, feat −4/−4,
  feat+light −2/−2; the penalties apply to **every** primary-hand iterative and
  to the **one** extra off-hand attack; a double weapon's off-hand end counts
  as light; an unarmed strike is always light. `fullAttackPlan` turns those
  into attack series: manufactured iteratives from the BAB ladder, one
  off-hand attack (no ladder), and the natural attacks — which never iterate,
  become secondary (−5) when any manufactured attack is made, and are **all
  primary** when they are the only attacks and all one type (UMR), overriding
  an authored `naturalSecondary`. A sole natural attack is always full BAB and
  carries the 1½-Str flag for A03 (two claws do not qualify; the increase
  never applies to one of several attacks). The limb-sharing rule is the
  caller's authoring concern — pass only limbs that are actually free.
- **Nonproficiency:** weapons −4 (natural weapons and unarmed strikes have no
  proficiency group and never take it); nonproficient armor/shield applies its
  ACP to attack rolls, armor and shield stacking (CRB p.153). An absent
  proficiency list means "proficient" — nonproficiency is opt-in, never guessed.
- **Shooting into a melee:** −4, −2 when the target is two size categories
  larger than the friendly characters it is engaged with, none at three; the
  "target ≥ 10 ft from the nearest friendly" avoidance and the "engaged"
  definition are caller geometry (A04/C01) and only referenced in docs.
  Precise Shot removes it. The three feats this layer recognizes are named
  constants; A07 generalizes feat handling.
- **Deliberately not interpreted:** the CRB sentence "feats such as Two-Weapon
  Fighting and Multiattack can reduce these [natural secondary] penalties" —
  ambiguous, and Multiattack is A07's; the −5 stands unreduced. Fighting
  defensively's −4/+2 is now verified on AoN ID 131 but belongs to A07's
  stance slice. Improvised-weapon use of a bow in melee is noted, never
  resolved (no verified rule encoded). Damage, confirmation, range penalties
  and DR mitigation are A03/A04/A05.
- **Evidence:** 25 new tests in `tests/packages/pf1eTactical.test.ts`, named
  after the SRD headings, hand-computed (the two initial failures were test
  arithmetic that forgot the fixture sword's +1 enhancement — the code was
  right). Full suite 1008 passed / 3 skipped across 121 files; typecheck/lint/
  touched-file formatting/build/size green; dist 2,054,514 raw / 591,568 gzip
  (unchanged — nothing imports tactical.ts yet; A06 wires it into the sheet).

## D-136 — A03: damage and critical arithmetic — confirmation, multipliers, Str rules, minimums, immunities

**Date:** 2026-09-10. **Scope:** P3/A03. Sources fetched and verified against
primary texts before encoding: Damage — minimum damage, Strength bonus,
Multiplying Damage (CRB p.179, AoN Rules ID 100); Attack — Critical Hits
(CRB p.182, AoN Rules ID 131); Nonlethal Damage (CRB p.191, AoN Rules ID 172);
Magic Weapons (CRB p.468, AoN Rules ID 377); Broken (AoN Rules ID 413, already
carried by A01); the rogue's Precision Damage & Critical Hits sidebar
(d20pfsrd, quoting the Bestiary creature-type traits); Improved Critical /
keen stacking ("this effect doesn't stack with any other effect that expands
the threat range"). The strategic engine's already-fixed §2.3 semantics
(confirm die 20 confirms / 1 fails; minimum applied to the final result) were
mirrored, not re-decided.

- **`tactical.ts` stays pure and diceless.** A03 is added to the same file the
  A02 layer lives in, and the callers still supply every rolled value: the
  confirmation d20, one weapon-dice sum per damage roll, and each bonus line's
  rolled sum. No RNG, no ModelPool, no DOM — the plan's PR-D damage half as a
  set of total helpers rather than one fat `damageRoll` closure.
- **Criticals.** `effectiveCritThreatMin`: a broken weapon threatens on a
  natural 20 only, and an expansion cannot re-widen it (order matters — broken
  first, doubling second); otherwise a single doubling re-anchors the range at
  2×min−21 (20→19–20, 19–20→17–20, 18–20→15–20). The doubling is one boolean
  because the verified stacking text forbids two. `confirmCritical`: the
  confirmation is an attack roll with the same modifiers — natural 20 always
  confirms, natural 1 never does, otherwise die+bonus ≥ AC ("it doesn't need
  to come up 20 again").
- **Multipliers add.** `combinedDamageMultiplier` implements "each multiplier
  works off the original, unmultiplied damage": 1 + Σ(m−1), so ×2+×2=×3,
  ×3+×2=×4, and the ×3 lance under a ×3 spirited charge with a ×3 weapon crit
  is ×5. A broken weapon's confirmed crit is ×2 regardless of its authored
  multiplier. A defender immune to critical hits contributes no crit
  multiplier — but outside multipliers (a mounted charge is not a critical)
  still apply. Extra multipliers must be integers ≥ 2; garbage is rejected,
  never guessed.
- **The damage split the Gap List demanded (§2.4) is explicit.**
  `resolveDamageRoll` takes one roll per multiplier step plus the static stack
  (`damageModifierParts` total, or a stat-block line's derived bonus) and the
  bonus lines separately: base dice and every static modifier are multiplied
  ("roll the damage with all modifiers multiple times and total the results" —
  Str, enhancement, Power-Attack-style misc all multiply), while precision
  damage and extra damage dice (flaming) are added exactly once. The
  base-vs-precision split is carried on the result so A05's DR resolver can
  apply "precision damage is never reduced by DR" without re-deriving it.
- **Strength rules exactly (CRB p.179).** One-handed ×1; two-handed wield ×1½
  with bonuses rounded down — a light weapon or unarmed strike never gains the
  increase however it is held; off-hand and secondary natural attacks ×½ (the
  sole natural attack is ×1½ via A02's `oneAndHalfStr` flag, overriding the
  secondary classification); Strength **penalties are never multiplied** — the
  entire penalty applies off-hand, and two-handed wielding does not deepen it.
  Ranged Str is full for thrown weapons, for a melee weapon with a range
  increment (its only ranged use is being thrown), and for the authored sling
  exception; penalty-only for a non-composite bow; none for everything else —
  a composite bow's rating is authored flat damage, never guessed here.
  Enhancement adds to damage (magic weapons apply to attack and damage;
  special-ability equivalents modify neither, AoN ID 377).
- **Buckets, minimum, and immunities.** Weapon damage lands nonlethal when the
  weapon is nonlethal (unarmed, saps) unless an intent flips it; the minimum
  rule converts a total result below 1 into 1 point of nonlethal damage
  (mirroring the strategic §2.3 fix, applied to the whole hit so bonus dice
  can legitimately lift a 0-weapon-total hit above the minimum); a negative
  bucket against a positive rider is clamped with a note (damage never heals).
  Crit immunity and precision immunity are **separate** defender flags per the
  Bestiary traits — a swarm takes sneak attack but no extra crit damage; an
  elemental takes neither; a confirmed crit against a crit-immune defender
  deals normal (×1) damage with an explicit note.
- **Rule correction found while encoding:** A02's −4 lethal-swap guard fired
  only for unarmed strikes. CRB p.191 (AoN ID 172) covers every nonlethal
  weapon — "a weapon that deals nonlethal damage, including an unarmed
  strike" — and IUS waives it for unarmed strikes only, never a sap. The guard
  now covers all nonlethal weapons; the mirror `nonlethalIntent` (−4 with a
  lethal weapon; no core feat waives it) was added symmetrically and threaded
  through `fullAttackPlan`. One A02 test label was updated; its behavior was
  and is unchanged.
- **Deliberately not encoded:** DR/ER/hardness (A05 consumes the carried
  split), range penalties and splash scatter (A04), Improved Critical / Power
  Attack / fighting defensively wiring (A07 — `threatRangeExpanded` and `misc`
  are the seams), charge multipliers (P06/P08 supply `extraMultipliers`), and
  any dice. Nothing imports the damage layer yet; A06 wires it into the sheet
  roll buttons and chat breakdown.
- **Evidence:** 32 new tests named after the SRD headings (confirmation
  extremes, doubling re-anchors, additive multipliers, one-roll-per-step
  validation, Str ladder with penalty cases, sling/bow rules, minimum damage,
  both swap directions with the IUS-only exemption, swarm-vs-elemental
  immunity discrimination, and the SRD's own worked flaming-longsword
  composition). The two initial failures were test arithmetic (a missed third
  static application; a one-roll ×2 crit), not code. Full suite 1040 passed /
  3 skipped across 121 files; typecheck/lint/touched-file Prettier/build/
  size/build:systems green; dist 2,054,514 raw, byte-identical to D-135 (no
  importer yet), gzip 594,184 in this environment.

## D-137 — A04: range penalties and legality, melee reach, and splash-weapon targeting

**Date:** 2026-09-10. **Scope:** P3/A04. Sources fetched and verified against
primary texts before encoding: the Range weapon quality with its worked
dagger example (CRB p.144, quoted via the PRD — "a cumulative –2 penalty for
each full range increment **(or fraction thereof)** of distance to the target…
a dagger (with a range of 10 feet) thrown at a target that is 25 feet away
would incur a –4 penalty"); Ranged Attacks maximum-range text and melee reach
text (CRB p.182, AoN Rules ID 131 — already fetched for A02/A03); Throw Splash
Weapon verbatim (CRB p.202, AoN Rules ID 197), including the scatter
clarification example quoted with the rule (a 25-ft throw with a 20-ft
increment ⇒ the weapon lands 2 squares off), which resolved the one genuinely
ambiguous phrase ("equal to the range increment of the throw" = the number of
range increments the throw covered — not the weapon's increment in squares,
and not the 1d8 result; the Appendix A.12 paraphrase "move that many range
increments" was garbled and is superseded). Firearm windows were already
verified in Gap List §2.9 and carried by A01.

- **Range:** `rangeIncrementsSpanned` counts fractions as full increments
  (ceil), pinned by the dagger example; `rangedAttackRange` returns the −2
  penalty per increment beyond the first and refuses the attack entirely
  beyond the weapon's maximum (a refusal, never a bigger penalty — CRB
  p.182), plus the early/advanced firearm touch-window flag. This is the
  tactical path only; the strategic engine's §2.8 bugs (range penalty
  computed only in the firearm branch, no max-range cutoff) are M01's to fix
  under the separate-resolvers decision — no shared kernel was created, the
  helpers are simply available to both.
- **Reach:** `meleeReachLegality` encodes the A.5 bands — normal weapons
  within natural reach; reach weapons in the open band (natural, double];
  zero-reach attackers strike only at distance 0 with the provoke rule named
  in notes. Occupancy, entering squares and the actual AoO are P06's. Natural
  reach is caller-supplied — no size table was re-derived here.
- **Splash:** the delivery is a ranged touch attack derived on read in
  `resolvePF1eWeapon` (authored `touch: false` cannot opt a splash weapon out
  of its own delivery rule); no nonproficiency penalty (guard in
  `attackModifierParts`); precision bonus lines are rejected by
  `resolveDamageRoll` rather than silently dropped; the grid-intersection
  attack is `resolveSplashIntersectionRoll` against AC 5 — a ranged attack,
  not touch, with no threat field because no creature is there; the miss
  scatter is `splashMissScatter`: 1d8 with die 1 toward the thrower and 2–8
  clockwise (45°-snapped compass in screen coordinates, y-down), moving a
  number of squares equal to the throw's range-increment count. This is
  weapon scatter only; D-130's removal of the invented strategic **spell**
  scatter stands.
- **A01 correction found while encoding:** a melee weapon with an authored
  range increment (dagger, spear, throwing axe — exactly how the SRD lists
  them) had been marked display-only with `maxRangeIncrements = 0`, refusing
  its ranged use. CRB p.182 ("The maximum range for a thrown weapon is five
  range increments") and p.468 ("Some of the weapons listed as melee weapons
  can also be used as ranged weapons") make thrown use real: the derivation
  now yields 5, the dead-data issue is removed, and `class` stays "melee" so
  melee use still ignores increments. No persisted shape changed.
- **Deliberately not encoded:** line of sight, distance measurement and
  splash-area membership (caller geometry — C01/P03), the
  occupied-intersection targeting ban (enforced where targets are chosen),
  splash damage amounts (content), Point-Blank Shot (+1 within 30 ft — A07),
  and any dice. Nothing imports the A04 helpers yet; A06 wires them into the
  sheet roll path.
- **Evidence:** 21 new tests (19 in `pf1eTactical.test.ts`, 2 derivation tests
  in `pf1eWeapons.test.ts`), hand-computed from the verified texts: the
  dagger/25-ft ⇒ −4 example, 45-ft alchemist's fire at the 5-increment −8
  ceiling and 51-ft refusal, firearm touch windows flipping exactly at the
  1st/5th increment boundary with the penalty still applying, reach dead
  zones at (5,10] and (10,20], Tiny in-square striking with the provoke note,
  the full clockwise 1d8 rose from a due-east thrower, the 25-ft/20-ft
  scatter clarification, the angled-thrower nearest-compass snap, and the
  −0-vs-0 penalty edge the first run exposed. Full suite 1061 passed /
  3 skipped across 121 files; typecheck/lint/touched-file Prettier/build/
  size/build:systems green; dist 2,054,514 raw, byte-identical to D-136 (no
  importer yet).

## D-138 — A05: defensive mitigation — DR, energy resistance/immunity/vulnerability, object hardness

**Date:** 2026-09-10. **Scope:** P3/A05. Sources fetched and verified verbatim
before encoding: Damage Reduction + Overcoming DR (CRB p.561, AoN Rules ID
424), Energy Resistance (CRB p.563, AoN Rules ID 429), Energy Immunity and
Vulnerability (CRB p.563 / Bestiary UMR "Vulnerabilities", AoN), Smashing an
Object (CRB p.173, AoN Rules ID 126), DR/epic (Bestiary p.299 UMR + Mythic
Adventures glossary, both ways confirmed by the Paizo FAQ), and the Paizo
rules-forum answer on DR vs nonlethal damage. R02/D-129's precision-is-reduced
ruling stands; the Gap List's own §2.10 column ("precision damage… never
reduced by DR") is wrong against its A.17 correction and is superseded.

- **`src/packages/pf1e/mitigation.ts` (new, pure):** the defender-side half of
  the damage path, consuming A03's result as typed components — physical
  (weapon + precision, one combined DR total per attack) and energy (by type,
  DR-immune, ER-mitigated). `drAttackFacts` builds the attack facts from a
  weapon with an optional launcher context (ammunition); `drBypasses` encodes
  the ladder; `applyMitigation` resolves everything with labeled notes for the
  chat breakdown; `damageComponentsFromRoll` is the A03 seam.
- **Bypass ladder exactly:** +1 magic (the launcher's bonus makes ammunition
  magic — "treated as a magic weapon", nothing more; its alignment transfers;
  the ammunition's own enhancement feeds the ladder, the launcher's never
  does); +3 cold iron/silver; +4 adamantine with the explicit "does not give
  the ability to ignore hardness" caveat; +5 alignment; epic = enhancement
  ≥ +6 OR total effective ≥ +6 (special-ability equivalents count only for
  epic — a +5 flaming weapon bypasses DR/epic but not DR/cold iron). Bypass
  lists are OR; strings split on " or " so stat-block forms like "piercing or
  slashing" work; unknown tokens never bypass and are named in notes. Multiple
  DR entries never stack — the best applies in the situation.
- **Riders:** DR completely negating the physical damage negates injury
  poison, stunning and injury-based disease (`physicalDamageNegated`); touch
  attacks, energy riders and energy drains are never DR-negated — the caller
  models energy riders as energy components, which DR skips by rule.
- **Two disputed points, decided and named:**
  1. **Vulnerability before resistance/hardness.** PF1e print is silent —
     3.5's "apply the resistance before the vulnerability" frost-giant
     paragraph was dropped in the Pathfinder glossary. The Paizo developer
     rulings (the Iron Gods robot answer: "determine the total amount of
     damage the creature WOULD take… first thing you do is apply the
     vulnerability") direct vulnerability-first; encoded as ×1.5 (floored) →
     energy resistance → object halvings → hardness. The dropped 3.5 order is
     recorded here, not encoded; a consumer wanting it must ask.
  2. **DR applies to nonlethal damage** (Paizo rules forum: "DR makes no
     consideration whether the damage is lethal or not"), including negating
     A03's minimum 1-point nonlethal. The strategic engine's
     `combatEngine.ts` comment "DR never applies to nonlethal damage" is
     wrong against this and stays untouched here — M01 owns the strategic
     repair. Which bucket DR eats first in a mixed lethal/nonlethal attack is
     unspecified in print ("GM fiat"); the resolver takes lethal first and
     names the choice in the result notes.
- **Objects (CRB p.173):** hardness subtracts once per attack from the
  post-halving total; energy attacks and ranged-weapon damage halve (floored)
  **before** hardness; objects are immune to nonlethal damage (dropped) and to
  critical hits (attack-side: callers must not confirm crits against objects —
  documented, not enforced); an actual adamantine weapon ignores hardness, the
  +4 enhancement equivalent does not (CRB p.561's table footnote).
- **A03 additive extensions:** `PF1eBonusDamageLine.energyType` (an energy
  rider — flaming); `bonusContributions` carry `precision`/`energyType`; the
  result exposes `weaponContribution` final buckets (post minimum/clamp) so
  the physical component needs no re-derivation. Also superseded: Appendix
  A.17's line "DR does negate ability damage/drain, energy damage dealt along
  with an attack (riders), touch attacks, and force effects" had the polarity
  backwards — the verbatim CRB text says DR does **not** negate touch
  attacks, energy riders or energy drains; the encoding follows the verbatim.
- **Deliberately not encoded:** spell resistance (C02), regeneration/fast
  healing and their suppression (H03), temporary-HP absorption (P4/P7
  bookkeeping), saving-throw halves (C02), protection-from-energy pools, the
  natural-weapons-of-a-DR-creature counting as magic/epic (caller authoring),
  and any strategic-loop change (M01). Nothing imports mitigation.ts yet;
  A06 wires it into the sheet roll path and chat breakdown.
- **Evidence:** 22 new tests in `tests/packages/pf1eMitigation.test.ts`,
  hand-computed from the verified texts: every ladder boundary, the
  +5-flaming-is-epic-but-not-cold-iron discrimination, ammunition transfer in
  both directions (launcher magic yes, launcher ladder no, own enhancement
  yes), rider negation, best-of-multiple-DR, per-type ER spanning components,
  the vulnerability order with the 30-fire/10-resist ⇒ 35 worked case and the
  25 ⇒ 37 floor, object halvings, adamantine-vs-+4 hardness, nonlethal object
  immunity, the A03→A05 seam end-to-end (19 physical + 6 fire vs DR 10/— ⇒
  15), and validation refusals for malformed components/DR/hardness. One A03
  test was updated for the two new contribution fields. Full suite 1083
  passed / 3 skipped across 122 files; typecheck/lint/touched-file Prettier/
  build/size/build:systems green; dist 2,054,514 raw, byte-identical to
  D-137 (no importer yet).

## D-139 — A06a: the sheet roll bridge — roll specs, flavor-on-roll, sheet roll buttons

**Date:** 2026-09-10. **Scope:** P3/A06, first slice. No new rule texts were
needed: every number is `derivePF1eActor`'s existing derivation (D-121/D-125)
and the one formula re-encoded here — the critical-damage group expansion —
rests on the already-verified CRB p.179 text ("roll the damage multiple times
and total the results") recorded in D-136/A.3. The AoN unarmed "provoke"
wording (ID 131, verified in D-135) supplies the unarmed-provoke flag. This
entry records wiring decisions, not fresh rules research.

- **`src/packages/pf1e/rollData.ts` (new, pure, diceless):** `pf1eAttackRollGroups`
  turns each derived attack line into a roll group — standard attack, one spec
  per full-attack iterative ("(attack 2)" suffix when the ladder has more than
  one), damage, crit damage — plus `pf1eSaveRollSpecs` (Fort/Ref/Will at the
  derived totals) and `pf1eInitiativeRollSpec`. The buttons can never disagree
  with the sheet readout because both read the same derivation; the A02–A05
  resolver layers are deliberately NOT consulted for button totals — their
  importer is the authoritative attack-resolution flow (A06b), where a chosen
  defense and rider context exist to resolve against. Unparseable explain
  strings fall back to a verbatim-flavor note rather than a guessed formula.
- **Critical-damage formula:** N groups of "dice + static" joined
  (`1d8 + 4 + 1d8 + 4`), never `(1d8 + 4) × 2` — the host engine has no
  multiplication grouping and the printed rule is per-step rolling with all
  modifiers. Dice-less ×N lines flatten to one baked number (each step adds the
  static stack; "8" reads cleaner than "4 + 4"). A multiplier below 2 is the
  resolver's clamped domain and is refused with a note, never guessed. Threat
  ranges narrower/wider than 20 surface as a note, since the confirm roll
  itself is A06b resolution. Bonus-dice and precision riders are not part of a
  derived line and so cannot be silently multiplied here — they enter in A06b
  where the A03 result structure exists.
- **Unarmed provoke (AoN ID 131 via D-135):** the derived unarmed fallback
  (authoredAttacksCount 0) flags `provokes` unless Improved Unarmed Strike or
  natural attacks exist; authored unarmed-named lines get an advisory note
  only, because authored damage dice imply a statted stat block whose provocation
  the author owns. The context (feats/hasNaturalAttacks/authoredAttacksCount)
  is supplied by the sheet from authored data — no core shape extension (D-113).
- **Flavor rides the existing roll protocol, not a new message:** `RollMsg.flavor?`
  (optional string, PROTOCOL.md updated) passes through `ClientSync.roll` /
  `rollVerified` as a fourth optional parameter; the host slices it to 300
  characters on both the plain and commit-reveal paths (a 300-char breakdown is
  far beyond any derived explain string; the cap bounds a hostile client
  pushing a wall of text into replicated chat). The pendingRolls entry carries
  the full unsliced flavor so the reveal cannot truncate twice. ChatPanel
  renders `.flavor` as a small breakdown line under the total — an 8-line
  touched-lines-only patch; the legacy file is not prettier-reformatted.
- **Sheet buttons (PF1eActorSheet Combat tab):** per attack line — Attack
  (standard), Full Attack (posts every iterative as its own public card),
  Damage, Crit; saves row (Fort/Ref/Will); an Initiative button next to the
  derived readout. All posts are public chat rolls through the existing
  seeded/commit-reveal machinery; no new permission surface.
- **Deliberately not in this slice (A06b/P6 own them):** defense selection and
  the A02 hit resolution, A03 confirmation arithmetic, A05 mitigation, HP
  application, the _Verify_ chip via `rollVerified`, targeting, AoO interrupt
  prompts and full-attack sequencing beyond posting each iterative. Nothing
  here applies damage or writes HP.
- **Evidence:** 12 new tests in `tests/packages/pf1eRollData.test.ts`
  (iterative ladder, ×2 and ×4 crit group expansion, dice-less ×N, refused
  multiplier <2, threat note, unarmed-provoke context matrix, verbatim-fallback,
  saves/initiative) plus 1 host flavor test (plain path cap at 300, riding the
  deterministic rng). One new e2e specification
  ("PF1e sheet roll buttons post attacks, damage and saves to chat with their
  breakdown (A06)") with a BAB 6/Str 16 fixture asserting the +9 attack card
  with breakdown, 1d8+4 damage, ×2 crit as 1d8+4+1d8+4 and the Fort save —
  collected across 3 projects (24 tests in the file), not executed (no
  browser binaries, D-119 precedent). Full suite **1096 passed / 3 skipped**
  across 124 files; typecheck, lint, touched-file Prettier (new files
  formatted; the legacy core/sync/chat/e2e files keep touched-lines-only
  patches), build, size and `build:systems` green; dist 2,059,693 raw /
  595,828 gzip — +5,179 bytes over D-138, within the 6 MB budget.

## D-140 — A06b: attack resolution — defense selection, confirmation, mitigation, HP writes, the Verify chip

**Date:** 2026-09-10. **Scope:** P3/A06, second slice (closes A06). Sources
fetched and verified verbatim before encoding: Injury and Death (CRB p.189–190,
AoN Rules IDs 164–168 — disabled at **exactly** 0 HP; negative-but-not-≥Con ⇒
unconscious and dying, losing 1 HP per round; dead when the negative total
equals the Constitution score) and Nonlethal Damage (CRB p.191, AoN Rules
ID 172 — nonlethal is never deducted from hit points; equal to current HP ⇒
staggered, exceeding ⇒ unconscious; nonlethal already at **total maximum** HP
⇒ all further nonlethal is treated as lethal, with the explicit regeneration
exception; both −4 damage-intent swaps). Everything else composes layers
already verified in D-135/D-136/D-138 — no other new rule research.

- **`src/packages/pf1e/resolve.ts` (new, pure, diceless):** `pf1eResolveAttack`
  composes A02's `resolveAttackRoll` (defense picked from the derived AC trio,
  a touch attack forcing touch), A03's `confirmCritical` (a threat without
  `confirmDie` is a caller error, never a rules state; a multiplier below 2
  downgrades a confirmed threat to a normal hit, matching D-139), the
  minimum-damage rule (a sub-1 total deals 1 point of **nonlethal**, even on a
  lethal-intent hit), A05's `applyMitigation` through `damageComponentsFromRoll`
  (one physical weapon component — a derived line carries no riders), and the
  HP arithmetic: lethal subtracts, nonlethal accumulates with the max-HP
  conversion (regeneration suppresses it). Condition annotations — dead at
  −Con, dying, disabled at exactly 0, unconscious/staggered from nonlethal —
  are notes only; P7 owns the writes. `pf1eResolvePrepare` is the exported
  first half (bonus/defense/A02 roll) the chat flow orchestrates with, and
  `pf1eResolveAttack` runs the same code, so the halves cannot disagree.
- **The situational/intent numbers live once:** `tactical.ts` now exports
  `situationalAttackParts` (flanking/charge/invisible +2, squeezing −4) and
  `damageIntentPenaltyPart` (the CRB p.191 −4 swaps, IUS waiving the unarmed
  lethal one only), with `attackModifierParts` refactored onto them — a pure
  extraction; all 76 A02/A03 tests pass unchanged. The resolve layer consumes
  the same helpers on top of a derived attack line.
- **`src/ui/sheets/pf1eResolveFlow.ts` (new):** the orchestration — every die
  is a public host-evaluated roll (`client.roll`, or `client.rollVerified`
  when verifiable), found back in the replica by `flags.core.rollId` with the
  natural d20 face read from the message's dice terms; a threat rolls the
  confirmation at the effective bonus; a hit rolls the damage formula (the
  D-139 crit-formula groups on a confirmed crit, chosen by the same exported
  `confirmCritical` the resolver runs). The resolution card is an ordinary
  `messages` create op whose content uses the chat's `[[total|formula]]` chips;
  HP writes go through `pf1eSheetEdit` ("hp"/"nonlethalDamage") so ownership
  and validation are the sheet's own path — a resolver without target
  ownership narrates but cannot write, and the card says so.
- **The Verify chip (the plan's "where the GM opted in"):** implemented as the
  resolving user's commit-reveal toggle in the resolve panel; when on, the
  attack rides `rollVerified` and the card carries the `verifyCommitRoll`
  verdict ("✓ verified" / "⚠ verification FAILED"), omitted when crypto was
  unavailable (the silent plain-roll fallback). A world-level GM setting can
  replace the toggle later without any protocol change.
- **Unarmed natural bucket:** the derived unarmed fallback's `damageType`
  string ("bludgeoning") does not say nonlethal, but an unarmed strike deals
  nonlethal by default (AoN ID 131) — the flow passes `unarmed: true` for the
  fallback (authoredAttacksCount 0), which makes nonlethal the natural bucket,
  so toggling to lethal takes the −4 (waived with IUS) instead of the reverse.
- **Deliberately not encoded:** defender critical-hit immunity and energy
  immunity/vulnerability (no authored actor fields exist — E03/P4 own the
  condition side; A05's flags light up when authoring lands), DR bypass facts
  beyond the mundane default (derived attack lines carry no weapon descriptor —
  `attackFacts` is the seam for the Weapons-tab/A07 wiring), precision/energy
  riders, resolving full-attack iteratives against a target as one sequence
  (each attack resolves individually), dying/stable bookkeeping (P7) and the
  AoO interrupt queue (P6 — the provocation is a note on the card and the
  sheet badge, exactly the "preliminary prompt" A06 asks for).
- **Evidence:** 20 new tests in `tests/packages/pf1eResolve.test.ts` — the
  plan §6.2 discriminating fixtures all land: the 22/16/17 AC trio (total 19
  misses normal, hits touch and flat-footed), flanked 18-vs-AC-19 misses and
  19 hits (with the dropped/doubled-flank controls), and the min-damage
  fixture (1d6−10 ⇒ 1 nonlethal, DR bypassed via the damage type, unconscious
  when nonlethal exceeds current HP; the equals-case staggers) — plus the
  confirmation boundary, the multiplier-<2 downgrade, the max-HP conversion
  and its regeneration exception, dead-at-−Con, the IUS waiver matrix, the
  object halving and validation refusals. 9 new tests in
  `tests/ui/pf1eResolveFlow.test.ts` drive the flow through a fake client:
  hit/miss/confirmed-crit (asserting the D-139 crit formula is the one
  rolled)/unconfirmed-threat/rejected HP write/the commit-reveal Verify chip
  (a legitimately verifiable record built from the exported seed machinery)
  and the pure helpers. One new e2e specification (resolve-vs-target with a
  two-actor fixture; 27 tests collected in `e2e/sheets.spec.ts` across 3
  projects, not executed — no browser binaries, D-119 precedent). Full suite
  **1125 passed / 3 skipped** across 126 files; typecheck, lint, touched-file
  Prettier, build, size and `build:systems` green; dist 2,080,869 raw /
  602,541 gzip — +21,176 over D-139, within the 6 MB budget. A07 remains.

## D-141 — A07 slice: supported feat/stance modifiers, Weapon Finesse, and Manyshot (modifier slice landed)

**Date:** 2026-09-09/10 (code landed on the merged branch; this entry backfills the
V11 record the slice was missing — the checklist progress block existed without its
decision). **Scope:** P3/A07, first slice (A07 stays open for the remaining feat
set and browser acceptance). Sources: the A.15 stance transcription (total defense
+4 dodge/1 round/can't attack or take AoOs) and AoN ID 131 for Weapon Finesse's
stat swap; everything else composes D-134's weapon descriptors and D-135's attack
layer — no new primary-text research.

- **`src/packages/pf1e/feats.ts` (new, pure):** normalization plus modifier helpers
  for explicit Power Attack/Deadly Aim (including handedness scaling on the −1/−2
  ladder), Combat Expertise, fighting defensively/total defense, weapon-scoped
  Weapon Focus/Specialization/Improved Critical, Weapon Finesse's stat selection,
  Point-Blank Shot's 30-foot boundary, and Improved/Greater TWF off-hand attack
  counts. `manyshotPlan` gates the feat/ranged/BAB requirement and returns the
  standard-action arrow count (2–4) with the −4 volley penalty.
- **Wired into `tactical.ts` only when the caller activates a stance** — no feat is
  silently activated from authored content; prerequisites not represented in the
  actor contract stay caller-owned. Weapon Finesse applies to eligible light melee
  weapons; the TWF upgrades lay out additional off-hand attacks.
- **Manyshot resolution:** `pf1eManyshotRollSpecs` exposes one same-bonus roll per
  arrow; pure `pf1eResolveManyshot` applies 2–4 host-evaluated arrows in order
  against one evolving defender state (per-arrow hit/miss, confirmation,
  mitigation, HP and nonlethal transitions), refusing non-ranged attacks and
  invalid volley sizes before resolving any arrow. `resolveManyshotFlow` emits one
  public card and writes final HP/nonlethal through the normal authorized sheet
  path; the Combat tab renders the Manyshot button when the feat and the derived
  ranged line qualify.
- **UI validation:** the Features tab reports unmet prerequisites for supported
  feats without deleting or disabling authored entries. `shootingIntoMeleePenalty`
  now accepts explicit `targetEngaged`/`nearestFriendlyDistanceFt` facts (the
  caller owns producing them); Precise Shot still removes the penalty
  unconditionally.
- **Evidence (re-verified on the merged HEAD before this backfill):** full suite
  **1135 passed / 3 skipped** across 126 files; typecheck, lint, build and size
  green; dist 2,089,293 raw / 604,442 gzip — within the 6 MB budget. A07 remains
  open: browser acceptance plus the feats whose consumers live in later slices
  (Multiattack's natural-secondary reduction note in D-135, Gun Training's
  broken-misfire variant noted in D-134).

## D-142 — E01: the effect apply/persist path — two homes, the derivation bridge, and the denies/boosts consumers

**Date:** 2026-09-10. **Scope:** P4/E01 (closes E01 at the logic level; browser
acceptance pending per the D-119 precedent). No new primary-text research: the
stacking/penalty/suppression mathematics is P0's `resolveEffects`, the tick
machinery is core `combat.ts`, and the one preset magnitude (Bull's Strength +4
enhancement, 1 min/level) was verified in R02/D-129. Durations count 1 round =
6 s ⇒ minute = 10 ticks, hour = 100 (A.1), as `ttlToTicks` already encoded.

- **`src/packages/pf1e/effectOps.ts` (new, pure):** the one sanctioned place that
  turns a `PF1eEffectPayload` into documents and Ops for both homes the core
  badge/tick code already reads — **actor-embedded** (`actor.effects`, the
  out-of-combat home) and **combatant-referenced** (`combatant.flags.core.effects`,
  what `core/combat.ts` ticks at the owner's turn end and what the CombatPanel
  badges). `buildEffectDoc` validates (`validateEffectPayload`), keeps `changes`
  empty (D-112) and seeds `flags.core.duration` via `effectFlagsFor`; apply/
  suppress/restore/remove helpers return Ops for `ClientSync.submit` with the same
  client-side permission gates as the sheet path (`update` on the actor / on the
  encounter), duplicate-id refusal, a 50-effect cap and named errors.
- **The derivation bridge:** `combinedTacticalEffects(actor, combat, combatantId)`
  merges both homes, with the **combatant copy winning an id collision** — it is
  the instance the tick decrements, so it is the live truth; the embedded twin is
  shadowed, not deleted. `pf1eSheetView` now takes an optional `{ combat,
combatantId }` ctx (the component resolves the linked combatant through
  `linkedCombatantId`, preferring an active encounter), so sheet numbers and
  badges can no longer disagree.
- **Expiry stays free** (P0's read-on-read design, now proven end-to-end): the
  acceptance test applies a 2-round effect through the real op, starts the
  encounter and advances turns — the owner's turn-end tick consumes the owner's
  duration only (the other combatant's turn never touches it), expiry drops the
  effect, and `derivePF1eActor` returns the base numbers with no undo write.
- **Action denies gain a consumer:** `actionRefusal`/`spendAction`/
  `spendCombatantAction` accept the deny token set; a token refuses a spend when
  it names the spend's action id ("charge", "full-attack", "cast-spell") or its
  kind. `actionBudget.ts` computes it per combatant from the linked actor's
  combined effects (`deniedActionsForCombatant`) and the tracker's budget chips
  and spend path both pass it. Tokens without a consumer yet ("aoo", P6's
  interrupt queue) are inert but preserved in the set.
- **Damage boosts gain a consumer:** `PF1eAttackRollContext.effectBoosts` (fed
  from `ResolvedEffects.boosts` + the new parallel `boostSources` attribution)
  appends `NdS`/static rider terms to every attack line's damage roll with a
  named note, and adds the caveat note to the crit roll — riders are **never
  multiplied on a critical** (CRB p.179 via D-136), so the crit formula is
  unchanged.
- **`src/ui/sheets/PF1eEffectsTab.svelte` (new):** the minimal apply surface — a
  typed, validated form (name, condition label, one mod row from the closed
  `PF1E_MOD_KEYS`/`PF1E_BONUS_TYPES` lists, ttl unit/value/per-level, and the
  home: actor vs. combatant when linked), the R02-verified Bull's Strength
  preset, and suppress/enable/remove per listed effect. The open-ended editor
  (free-form keys, boosts/grants/immunities authoring) remains E02; the condition
  _library_ remains E03 — this tab deliberately encodes no condition numbers.
- **Deliberately not encoded:** per-level conversion against a replicated world
  clock and round-start expiry differences (E04/E05 — `endsOn` is carried but both
  boundaries tick as core ticks today), concentration/sustained enforcement (E04),
  condition math (E03), token condition icons (E06), and combatant-effect
  attribution in the resolve flow's cards.
- **Evidence:** 14 new tests in `tests/packages/pf1eEffectOps.test.ts` (doc
  shaping + validation refusals, the stacking fixture through the real apply path,
  permission/duplicate/cap refusals, the core-shape combatant write read back
  through `activeEffects`, the expiry-revert acceptance, collision precedence,
  ctx'd sheet view, deny gating through ledger and spend, boost/crit formula
  shapes). Full suite **1149 passed / 3 skipped** across 127 files; typecheck,
  lint, touched-file Prettier, build, size and `build:systems` green; dist
  2,103,405 raw / 607,994 gzip — +14,112 over the pre-slice build, within the
  6 MB budget. Browser acceptance of the Effects tab is collected-not-executed in
  this environment (no browser binaries, D-119 precedent).

## D-143 — E02: the custom effect editor — full payload authoring, in-place edits, and token application

**Date:** 2026-09-10. **Scope:** P4/E02 (closes E02 at the logic level; browser
acceptance pending per the D-119 precedent). No new primary-text research: the
payload contract, validation and stacking are P0's (`effects.ts`), the
persistence/authorization mechanics are D-142's (`effectOps.ts`), and the SRD
condition _names_ in the picker are presentation data — E03 still owns every
condition's mathematics.

- **On "open-ended stat keys" (the plan sketch) — resolved against the P0
  contract:** `PF1E_MOD_KEYS` stays closed ("the closed list is what makes typos
  loud") because a mod key the derivation cannot consume would be a silent no-op
  that looks loaded. Custom buffs remain first-class through the free-form name,
  condition label, deny/grant tokens, damage boosts and stacking group; widening
  the mechanical key list is a deliberate contract change (derivation consumers
  first), never an editor option.
- **`src/ui/sheets/pf1eEffectEditorModel.ts` (new, pure):** `EffectForm` covering
  the whole `flags.pf1e` payload — typed mod rows (key/type/value/per-mod source,
  N rows), boost rows (dice/sides/flat/energy/precision), deny and grant token
  lists (comma/space parsed, lowercased), the immunity block
  (mind-affecting/conditions/energy/DR), structural flags (flat-footed, denied
  Dex, no AoO), stacking group, concentration, ttl (unit/value/per-level/
  ends-on) and the effect origin (kind/id/level/DC). `buildEffectRequest`
  assembles the request with empty-numbers-are-absent, garbage-numbers-are-named-
  errors semantics — it never guesses a zero — and the request revalidates
  through `validateEffectPayload` inside `buildEffectDoc` before any write.
  `formFromEffect` round-trips a validated effect back into the form (tested:
  form → request → doc → read → form is fact-preserving both ways).
- **In-place edits:** `pf1eEditActorEffect` / `pf1eEditCombatantEffect` keep the
  effect id and its suppression state, swap the validated payload/name/icon, and
  re-seed `flags.core.duration` from the edited ttl — an edit is a new agreement
  on how long the effect lasts, not a resume of the old countdown. The sheet
  routes an edit to the effect's current home (combatant map wins when present,
  the same precedence as the read side).
- **`src/ui/sheets/PF1eEffectEditor.svelte` (new):** the full authoring surface,
  embedded in the Effects tab (replacing E01's minimal one-row form): condition
  picker as an SRD-names datalist (display only), suggested deny tokens, add/
  remove rows for mods and boosts, the actor-vs-combatant home select (locked
  during an edit — the home is where the effect lives, not a field), and
  read-only rendering without ownership. Player permissions ride the same
  `can(user, "update", actor, "actors")` gate as every sheet edit.
- **Token application (the T01 deferral resolved):** the token context menu gains
  **"Apply effect…"** — shown for tokens linking a PF1e actor, enabled by actor
  ownership, and returning `openEffectEditorActorId` so App opens that actor's
  sheet directly on the Effects tab (`openPF1eSheetWindow` gained an optional
  tab, threaded through the window data to `PF1eActorSheet`'s new `initialTab`).
  Non-PF1e/unlinked tokens keep the entry disabled with the reason visible —
  the menu stays honest about what it is looking at.
- **Deliberately not encoded:** condition mechanics behind the picker (E03),
  turn-end/round-start expiry differences and the world clock (E04/E05 —
  `endsOn` is authored and carried, both boundaries tick as core ticks today),
  token condition icons (E06), effect templates/favorites, and mass application
  to a selection (a later P4 polish once E03 lands the math).
- **Evidence:** 9 new tests in `tests/ui/pf1eEffectEditor.test.ts` (full-payload
  assembly + core doc shaping, absent-vs-garbage numerics, token parsing, the
  two-way round-trip, the closed-key/condition-picker presentation contract,
  edit id/suppression/duration semantics, permission and unknown-id refusals,
  the menu entry's ownership gating and the returned actor id) + the extended
  token-menu fixtures. Full suite **1158 passed / 3 skipped** across 128 files;
  typecheck, lint, touched-file Prettier, build, size and `build:systems`
  green; dist 2,120,722 raw / 612,628 gzip — +17,317 over D-142, within the
  6 MB budget; e2e at **159 collected** across 28 files (new editor flow spec,
  not executed — no browser binaries, D-119 precedent).

## D-144 — E03: the condition library — 27 canonical conditions as effect payloads, verified against the Conditions text

**Date:** 2026-09-10. **Scope:** P4/E03 (closes E03's mathematical library;
the two P7-owned HP-state interactions and the geometry-dependent consequences
stay with their owning phases, recorded per condition). **Sources:** the
canonical Conditions page was fetched and read in full for this slice — every
number below is its text, cross-checked against the in-repo A.14 modifier
transcription (which agrees); no other new research.

- **`src/packages/pf1e/conditions.ts` (new, pure):** 27 condition definitions
  (the 26 the E03 clause enumerates plus Staggered, which Disabled/Unconscious
  and the nonlethal path cite): each carries the exact SRD name, a condensed
  summary quoting its numbers, the mechanical payload builder, `mindAffecting`
  /`fear` tags, and `notes` for consequences the current contract cannot
  express — recorded, never silently dropped.
- **Payloads ride the P0 machinery:** applying a condition is applying an
  effect payload (`condition` label + typed mods + flags + denies), so the
  derivation, stacking, suppression and expiry need zero changes. Verified
  encodings include: Fatigued −2/Exhausted −6 Str&Dex (both deny run/charge);
  Shaken/Frightened −2 attack+saves and Panicked saves-only (the print does
  not penalize the panicked attack roll); Stunned −2 AC + denied Dex;
  Grappled −2 attack/−2 CMB/−4 Dex vs Pinned denied-Dex + −4 AC; Prone −4
  melee attack; Blinded −2 AC + denied Dex; Entangled −2 attack/−4 Dex +
  no-run/charge; the helpless family (Helpless/Unconscious/Paralyzed/
  Petrified/Dying/Stable) all deny Dex to AC; Flat-Footed sets the
  derivation's own `flatFooted`/`cannotAoO` flags; Dazed/Nauseated/Staggered/
  Disabled encode their action restrictions as deny tokens (Staggered/
  Disabled deny only full-round — the move-XOR-standard limit is the ledger's
  `single-standard-or-move` restriction, which the P7 health path sets).
- **Two named classifications:** fear penalties (shaken/frightened/panicked/
  cowering) are typed **morale** — so two fear conditions take the worse
  instead of stacking, which is the printed fear rule (tested: shaken +
  frightened ⇒ −2, shaken + sickened ⇒ −4); every other condition penalty is
  **untyped with its own source string** because the print types nothing
  there. Fear and Confused tag `mindAffecting`; `conditionRefusalFor` refuses
  those (and name-matched `immune.conditions`) against a protected target —
  the E03 mind-affecting immunity hook, surfaced as a visible apply refusal
  in the Effects tab's new condition quick-apply row.
- **Not encoded on purpose (per-definition notes):** prone's +4/−4 ranged/
  melee AC split (no per-range AC mod key — the attacker-side situational
  seam P06 owns alongside flanking/charge); blinded's 50% total concealment
  (P5) and Acrobatics DC 10 (P03); helpless-family Dex-0 (−5) statics and the
  attacker's +4 melee/coup-de-grace bonus (P06 seam); forced flee/panic
  behaviors (L05 morale); skill-check penalties (no mod keys); grapple/
  pinned concentration DCs (C03); confused's d% behavior table (GM-owned);
  Disabled's half speed and 1-damage-after-strenuous-standard (P7).
- **Evidence:** 20 new tests in `tests/packages/pf1eConditions.test.ts` —
  coverage + validator survival for all 27, the severity/adjacent
  discriminating pairs (fatigued/exhausted, shaken/frightened/panicked,
  stunned/dazed, grappled/pinned, prone/blinded/entangled, the helpless
  family, Flat-Footed), fear-vs-untyped stacking through the real resolver,
  derivation integrations (fatigue drops attack+AC by 1; shaken drops all
  saves by 2; blinded removes Dex from touch/flat-footed; exhaustion outranks
  fatigue by exactly −2 attack), and the immunity refusals. Full suite
  **1178 passed / 3 skipped** across 129 files; typecheck, lint,
  touched-file Prettier, build, size and `build:systems` green; dist
  2,133,897 raw / 616,537 gzip — +13,175 over D-143, within the 6 MB budget.

## D-145 — 2026-09-10 — P4/E04: turn-boundary durations via restore-and-tick, not a second ticker

- **Context:** A.16 requires concentration to lapse when the caster's turn ends
  without a spent standard, and round-start effects must expire on round
  boundaries; core's `nextTurn` already ticks durations at owner turn end, and
  E01–E03 store all tactical payloads in `flags.core.effects` / `actor.effects`
  where core can see them.
- **Decision:** E04 is not a new ticker. `pf1eNextTurn` keeps core as the single
  engine and repairs its semantics at the two boundary moments:
  (a) _Round start:_ core ticks `endsOn: "round-start"` payloads at owner turn
  end — the wrong moment — so `pf1eNextTurn` restores the ending owner's
  round-start effect documents from the input combat (owner captured before the
  advance), strips core's expiry records for those ids, and then, on round wrap
  only, decrements each carrier's `durationLeft` once, dropping at ≤ 0 and
  writing `flags.core.duration` otherwise. Round-start ids without a remaining
  duration are inert markers and are never restored or ticked.
  (b) _Concentration:_ payloads with `concentration: true` are dropped at the
  owner's turn end when `actions.standardUsed === false`; sustaining (spending
  the standard) preserves the document at its pre-wrap value until the next
  wrap tick. Lapsed ids are reported in the new `lapsed` return
  (`{combatantId, effectId}[]`) and excluded from `expired`, so a lapse never
  double-reports an effect core already dropped; the surprise round returns
  `lapsed: []`.
- **Consequences:** duration semantics now differ by `endsOn` key with a test
  proving the interleave (own-turn ttl 3 vs round-start ttl 2 on one carrier);
  per-level conversion (rounds→minutes→hours) is deferred to E05 where the
  replicated clock lands; `lapsed` is UI-ready but unrendered (E06 owns
  recompute + icons); core stays untouched (P4 constraint).
- **Evidence:** 10 new tests in `tests/packages/pf1eTurnBoundaries.test.ts`
  (timeline, core-equivalence on effect boundaries, inert marker, sustain,
  lapse, combined sustain+round-start, surprise short-circuit, derivation
  through real `readTacticalEffects`); full suite **1188 passed / 3 skipped**
  across 131 files; typecheck, lint, touched-file Prettier, build, size and
  `build:systems` green; dist 2,135,336 raw / 616,970 gzip (+1,439 over
  D-144, within the 6 MB budget).

## D-146 — 2026-09-10 — P4/E05: the replicated world clock and clock-counted durations

- **Context:** §10 forbids putting the clock on the local `WorldsRecord` (D-113): a clock a
  player cannot see is not a clock their durations tick against. The tracker already kept a
  per-combat `clockSeconds` on the round state and `pf1eNextTurn` reported a
  `clockDeltaSeconds` per wrap (E04), but nothing wrote a world-level time, and day-long (and
  out-of-combat) durations had no consumer at all.
- **Decision:** the world clock is the `clockSeconds` key of the replicated `world-settings`
  document — the same seam, merge and projection every rule option uses — written only through
  `worldSettingsOps`, from exactly two places: the combat tracker's round wrap
  (`wrapAdvanceOps`, gated on `advanceClockOnRound`) and the GM's settings-window time controls
  (+1 min/+1 h/+1 day scaled to the world's duration ladder; reset rewinds to 0 and sweeps
  nothing). Durations join it by anchoring: applying an effect with the clock in scope stamps
  `appliedAtClock` on the `flags.pf1e` payload (validator allow-listed and round-tripped), and
  `pf1eClockSweepOps` removes anchored, clock-counted payloads — round/minute/hour (whose
  per-turn ticks remain the turn engine's in-combat consumer, E04) and `day` (defined as
  2 400 rounds = 24 of the landed 100-round hours; the clock is its only consumer) — from both
  effect homes when `now ≥ anchor + ttlSeconds`. The sweep only removes; it never rewrites
  `flags.core.duration`, so the turn engine and the clock can never double-decrement one
  effect. Unanchored (pre-E05) payloads are never swept: the sweep refuses to guess an anchor.
  Instant/concentration/permanent are not clock-counted (an instant is over, concentration
  lapses on maintenance per A.16/E04, permanent never ends).
- **Consequences:** a GM advancing time out of combat ends buffs in the same measure combat
  rounds would; joining clients read the clock through the normal settings merge with no new
  protocol. The ladder stays the landed abstraction (1 min = 10 rounds, 1 h = 100 rounds,
  1 day = 2 400 rounds × the configured `secondsPerRound`) rather than real-clock units.
  Calendar dates, real-time tickers and per-level _display_ conversion remain open (P5/E06+
  seams); the E04 "per-level conversion" deferral is closed by this ladder.
- **Evidence:** 21 new tests in `tests/packages/pf1eWorldClock.test.ts` (read/normalize/joiner
  merge, op shapes incl. create-from-empty and no-op, wrap→clock integration through a real
  `pf1eNextTurn` round wrap, tick ladder with per-level and configured rounds, anchor
  stamping through `buildEffectDoc` and the authorized apply ops, minute/per-level/day
  boundaries, legacy/non-counted survival, both sweep homes with unparseable-effect
  preservation, the validator range rule, readout format). Full suite **1209 passed / 3
  skipped** across 132 files; typecheck, lint, touched-file Prettier, build, size and
  `build:systems` green; dist 2,139,571 raw / 618,239 gzip (+4,235 over D-145, within the
  6 MB budget).

## D-147 — 2026-09-10 — P4/E06: token condition badges and read-only recompute; initiative stays frozen

- **Context:** E06 asks for UI/roll statistics to recompute on effect changes, token condition
  icons, proof that expiry restores base values, and an initiative-policy check before any
  re-sort. Derivation is already on-read (`deriveFromDocuments`, D-112: never persist derived
  totals), so "recompute on change" needs no listener — only consumers that read the replica
  every frame, and proof.
- **Decision:** token badges are a pure read-side model (`tokenBadgesFor`/`tokenBadgesMap` in
  the pf1e package) consumed by the canvas stage's `syncTokens` as structural
  `{code, tint}` chips (core canvas never imports the package). Badge sources are the two E01
  homes — the combatant linked by `tokenId` (combat copy wins id collisions; an under-way
  encounter with `round ≥ 1` wins the claim, matching the E01 linked-combatant rule) and the
  token's `actorId` embedded effects — filtered to validated, non-suppressed documents, with
  E03 conditions sorted first under their SRD label. Chip abbreviation ("Flat-Footed" → "FF")
  and tint are deterministic, so badges don't flicker between refreshes; the renderer caps at
  3 chips + "+N" and rebuilds only when the chip signature changes. Initiative policy (R02):
  order is frozen when the encounter starts; effect apply/expire/recompute never re-sorts and
  never rewrites initiative values — the D-145/E04 tracker mutates only round state, action
  ledgers and effect documents, and the E06 test pins array order + initiative across a real
  expiry transition.
- **Consequences:** P4 is complete (E01–E06). Recompute-on-effect-change is structural: any
  future consumer that reads the replica (roll panels, sheets) inherits it for free. Badge
  icons remain text chips until an asset pipeline exists (P5 seam); hover/detail UI for chips
  is deferred with it. Browser e2e remains collected-not-executed (D-119).
- **Evidence:** 10 new tests in `tests/packages/pf1eTokenBadges.test.ts` (chip codes/tints,
  record-level collect incl. suppressed + unparseable, both homes, collision + encounter
  preference, condition ordering, the real apply→expire→base-restore round trip with
  initiative stability, map shape). Full suite **1219 passed / 3 skipped** across 133 files;
  typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist
  2,141,938 raw / 619,453 gzip (+2,367 over D-146, within the 6 MB budget).

## D-148 — 2026-09-11 — P5/C01a: pure grid targeting for area spells, and the two shapes refused

- **Context:** C01 asks for "pure grid targeting + canvas preview overlay: burst, cone, line,
  emanation, spread/cylinder where supported; scene distance/units/diagonals, affected-token
  highlighting, walls/line of effect and cover". Nothing in `src/` read scene grid metadata for
  PF1e areas, and the Gap List has **no appendix table for spell shapes** — exactly the
  transcribe-before-fixtures gap R01 filed for TWF/Charge. So the rules had to be verified
  before any fixture could exist.
- **Verified sources (transcribed 2026-09-11):** Archives of Nethys Rules ID 212 "Aiming a
  Spell" (CRB pp.214–216), cross-checked against d20pfsrd.com/magic and d20srd.org. The
  load-bearing sentences: the point of origin "is always a grid intersection"; count
  "intersection to intersection" where "every second diagonal counts as 2 squares of
  distance"; "if the far edge of a square is within the spell's area, anything within that
  square is within the spell's area. If the spell's area only touches the near edge of a
  square, however, anything within that square is unaffected"; a burst "can't affect creatures
  with total cover from its point of origin (its effects don't extend around corners)"; a
  cylinder "ignores any obstructions within its area"; a spread "can turn corners … count
  around walls, not through them. As with movement, do not trace diagonals across corners";
  and the larger-creature rule that a "centered on you" burst measures "from the edge of the
  creature's space".
- **Decision:** `src/packages/pf1e/targeting.ts` — pure math in **cell coordinates** (the
  canvas/host layer converts world units; no Pixi import). Area counting reuses the existing
  `cellDistance` from `src/canvas/grid/measure.ts` rather than adding a second distance
  kernel, and every size comes from caller-supplied `PF1eAreaGrid {cellSize, feetPerCell,
diagonals}` (P01: scene metadata, not hardcoded 5/15/30). The inclusion rule is implemented
  as **distance to the cell's far corner**, which is the only reading that reproduces the
  published templates: at a 5-ft. radius it yields exactly the four cells sharing the origin
  corner (a 10-ft. square), and at 15 ft it yields the canonical 24-cell burst (rows of
  2/4/6/6/4/2). Both are hand-derived fixtures, not captured outputs (V01). Spread is Dijkstra
  over `(cell, diagonal-parity)` with orthogonal steps at 1 and diagonal steps at 1/2
  alternating, which reproduces `ortho + diag + floor(diag/2)` exactly — the cost of the path
  actually travelled, as the rule requires; the four cells around the origin intersection are
  seeded at cost 1 because the effect starts at the intersection, matching the 5-ft. burst's
  2×2. LoE is a 5-probe (4 corners + centre) test where **any** unblocked probe wins, since
  total cover means no line reaches the square; the "hole of at least 1 square foot does not
  block" clause needs no special case because this model authors such a barrier as two
  segments with a gap.
- **The cylinder/LoE conflict, reconciled explicitly:** AoN 212 says both that a cylinder
  "ignores any obstructions within its area" and that a cylinder "affects only an area … to
  which it has line of effect from its origin (… a cylinder's circle …)". The encoded reading:
  the caster must have LoE to the **point of origin** (`hasLineOfEffectToOrigin`), after which
  the cylinder fills its whole circle — so per-cell LoE is not applied to cylinders, and is
  applied to burst/emanation. A fixture pins the difference against one wall: the burst loses
  every cell behind it, the cylinder keeps all of them.
- **Refused on purpose — cone and line (C01b).** Both have a grid discretization the rules
  text does not settle, so encoding either would be inventing a rule:
  - **Cone:** "a quarter-circle … starts from any corner of your square and widens out as it
    goes", but the published templates disagree (1/2/3 rows vs 2/4/6 rows for a 15-ft. cone)
    and the rules designer's own resolution is "Cones can't be perfect on a square grid. Just
    pick one, drop it on the map so its origin point is the corner of one of the caster's
    squares, and that's what area the spell effects" (Sean K Reynolds, Paizo forums).
  - **Line:** "affects all creatures in squares through which the line passes", but a
    zero-width line drawn along a grid line or an exact diagonal only grazes shared edges,
    while the published template is a 5-ft.-wide corridor — the two readings differ on every
    axis-aligned and 45° cast.
    C01b must fix a named template from a canonical figure first. `resolveAreaCells` returns a
    named `kind` issue pointing at C01b rather than guessing. C01's own wording ("where
    supported") permits shipping the subset.
- **The scene bridge, and a bug wiring it to a real scene exposed:** `pf1eAreaGridFromScene`
  maps `SceneGrid` → `PF1eAreaGrid` and pins the diagonal rule to `PF1E_AREA_DIAGONALS`
  ("5105"). The first draft let the scene's `SceneGrid.diagonals` drive area counting, which
  is wrong: that setting configures the VTT **ruler**, and this repository's default scene
  ships `diagonals: "555"` (`hostBoot.ts:178`), so a GM retuning the ruler would have silently
  changed which squares a fireball covers. AoN 212 states 5-10-5 as a rule of spell areas, so
  the scene supplies cell size and feet-per-cell while the counting rule stays the rules'. The
  pure module keeps `diagonals` as a field (general, testable); the bridge is where the
  decision lives. Metric scenes get a named `grid.units` issue rather than an invented
  conversion.
- **Wired to the existing Playwright surface, not left dormant.** `AppSurface.pf1eArea(spec)`
  in `src/app/e2eHook.ts` resolves an area against the **live** scene — its grid metadata, its
  sight-blocking walls (via the existing `sightSegments`, since AoN 212 makes LoE "like line
  of sight … except that it isn't blocked by fog, darkness") and its tokens — returning cells,
  affected token ids, preview-rect count and named issues. This is the seam the canvas
  overlay/highlighting will read, so the browser spec asserts the real scene→cells→tokens path
  instead of a re-implementation.
- **Consequences:** C01 stays **open** — this is the C01a pure-geometry slice plus its browser
  seam. Remaining: the Pixi preview overlay and the visible affected-token highlight, and
  cone/line after their templates are transcribed. Unlike D-135's `tactical.ts`, this module
  is **not** dormant: `e2eHook.ts` imports it, so it is now in the bundle (dist +5,587 bytes
  over D-147). C02 (casting/save flow) is the next consumer.
- **Evidence:** 36 new tests in `tests/packages/pf1eTargeting.test.ts`, each named after the
  rule it pins (intersection-only origin, 5-10-5 diagonal counting, the far-edge/near-edge
  pair, the 24-cell 15-ft. burst, emanation≡burst≡cylinder shape, burst total cover vs the
  cylinder exemption, LoE-to-origin placement, spread turning a corner at a derived path cost
  of 5 vs 9, no diagonals across corners, a 10-ft-grid recomputation for P01, the
  ruler-vs-rules bridge, token footprints/Large touch, centered-on-you bonus, named-issue
  garbage handling, the maxCells cap, labels, and the exact supported-shape list). Plus
  `e2e/pf1e_targeting.spec.ts` (4 tests × 3 projects) driving the live scene. Full suite
  **1255 passed / 3 skipped** across 134 files (+36 tests, +1 file over D-147); typecheck,
  lint, touched-file Prettier, build, size and `build:systems` green; dist 2,147,525 raw /
  621,553 gzip (+5,587 over D-147 — the module is now bundled, within the 6 MB budget); e2e
  **171 collected across 29 files** (was 159/28), still not executed (D-119 precedent —
  `cdn.playwright.dev` returns `ECONNRESET` and no browser binary exists on this machine).

## D-149 — 2026-09-11 — P5/C02: tactical spell saves and spell resistance, without the natural-die house rule

- **Context:** C02 asks for "tactical casting/save flow: chosen targets, DC from spell level/key
  ability/focus, Fort/Ref/Will, save-negates/half/no-save distinctions, Evasion/Improved
  Evasion, per-type damage/ER and SR without natural-roll auto outcomes. Respect target-specific
  resistance bookkeeping" (Gap List A.16). The strategic engine already resolved spell damage in
  `src/packages/pf1e/spells.ts`, but it does so with a house rule — its SR check short-circuits on
  `if (srRoll !== 20)`, which gives a caster-level check the automatic-success-on-20 property that
  belongs to attack rolls and saving throws, not to SR. That is DEVIATIONS D-1's family, and it was
  to be removed in P5. Fixing it in place would have meant changing the strategic engine's numbers,
  so the tactical flow needed its own resolver.
- **Verified sources (transcribed 2026-09-11):** Archives of Nethys Rules ID 230 "Saving Throw"
  for the automatic outcomes — "A natural 1 (the d20 comes up 1) on a saving throw is always a
  failure… A natural 20 (the d20 comes up 20) is always a success" — and for voluntary surrender:
  "A creature can voluntarily forego a saving throw and willingly accept a spell's result. Even a
  character with a special resistance to magic can suppress this quality." The DC formula from the
  magic overview: "10 + the level of the spell + your bonus for the relevant ability… A spell's
  level can vary depending on your class. Always use the spell level applicable to your class." The
  severity keywords verbatim: **Negates** "no effect on a subject that makes a successful saving
  throw"; **Partial** "a successful saving throw means that some lesser effect occurs"; **Half**
  "a successful saving throw halves the damage taken (round down)"; **None** "No saving throw is
  allowed"; **Disbelief** "lets the subject ignore the spell's effect"; **(object)** objects save
  only if magical or attended, else the holder's bonus if greater, and "A magic item's saving throw
  bonuses are each equal to 2 + 1/2 the item's caster level". SR from the universal monster rules:
  the caster makes "a caster level check (1d20 + caster level). If the result equals or exceeds the
  creature's spell resistance, the spell works normally, although the creature is still allowed a
  saving throw" — resistance is overcome once per spell per round.
- **Decision:** `src/packages/pf1e/casting.ts` — pure, diceless (the caller supplies every die
  face), no Pixi, no `Math.random`. `spellSaveDc` implements 10 + level + ability modifier, with
  `focusBonus` an explicit caller input rather than a school lookup: Spell Focus is a feat, A07 does
  not author it, and D-141 forbids silently activating feats from authored content.
  `resolveSpellSave` makes natural 1 always fail and natural 20 always succeed, and reads no die at
  all when the save was voluntarily foregone. `spellSaveOutcome` maps the five SRD severities to a
  multiplier, with Evasion/Improved Evasion applied only to **Reflex half** — the definition of
  Evasion is an attack "that normally allows a Reflex saving throw for half damage", so it does
  nothing to a Fortitude-half or a Reflex-negates spell, and one fixture pins that a Fort-half
  success with Improved Evasion still takes half.
- **SR has no natural-die special cases, deliberately:** `spellResistanceCheck` compares
  `1d20 + caster level` against SR and nothing else. A natural 20 from a 5th-level caster does not
  reach SR 30, and a natural 1 from a 20th-level caster still overcomes SR 10. Both are fixtures.
  This is the contrast that motivated the slice, and `spells.ts` is **not** changed by it, so
  DEVIATIONS **D-1 remains live** and now records a known divergence between the strategic and
  tactical paths rather than a single house rule.
- **Ordering, named rather than incidental:** the save halves first (`Math.floor`, per "round
  down"), then energy mitigation runs on what the creature actually takes. That order matters
  because A.17 spends energy resistance once per attack per type against damage that is actually
  dealt — halving afterwards would let a creature apply resistance to damage the save had already
  removed. DR is never applied to spell damage (CRB p.561 scopes it to weapons and natural
  attacks), and one fixture pins that a 20/— DR creature takes a full untyped spell.
- **One pipeline, not two:** the energy half of A05's `applyMitigation` (immunity → vulnerability
  +50% floor → resistance spent once per type) was extracted into an exported
  `applyEnergyMitigation(components, defender)` in `mitigation.ts`, and `applyMitigation` now calls
  it. Spells cannot reuse `applyMitigation` itself — that function is weapon-shaped and requires
  `PF1eDrAttackFacts` (enhancement, material, alignment, damage type), and inventing weapon facts to
  model a fireball would be fabricating input. The extraction is behaviour-preserving: the existing
  22 mitigation fixtures pass unchanged, and a new fixture drives the extracted helper directly
  with two fire components to prove resistance is spent once across both.
- **Partial and Disbelief are not given a number.** Both return `kind: "lesser"` with an
  explanatory note and multiplier 1, because the rule text says "some lesser effect occurs" and
  "lets the subject ignore the spell's effect" without quantifying either; a multiplier here would
  be invented. Objects are resolved by `magicItemSaveBonus` (2 + floor(CL/2)) and `objectSaveBonus`
  (the holder's bonus when better; **no save at all** for an unattended mundane object).
- **Not a barrel export:** `src/packages/pf1e/` has no `index.ts` and the TODO never asks for one —
  every consumer in this repo imports the module directly, so `casting.ts` follows that convention.
- **Still open for C02:** chosen-target selection and the round-scoped resistance bookkeeping
  (`alreadyOvercomeThisRound` is currently a caller-supplied flag, not a tracked store), plus the
  casting UI itself. C02 stays unchecked.
- **Evidence:** 34 new unit tests in `tests/packages/pf1eCasting.test.ts`, including the two SR
  fixtures that would fail under the strategic engine's rule; `e2e/pf1e_casting.spec.ts` (5 tests ×
  3 projects) drives `AppSurface.pf1eCastResolve`, which runs the **real** bundled chain authored
  `system.pf1e` → `deriveFromDocuments` → save total → `spellSaveDc` → `resolveSpellTarget` →
  `applyEnergyMitigation`, so the browser path asserts wiring rather than re-implementing the rules.
  Full suite **1289 passed / 3 skipped** across 134 files (+34 tests); typecheck, lint, touched-file
  Prettier, build, size and `build:systems` green; dist **2,153,859 raw / 623,545 gzip** (+6,334
  over D-148, within the 6 MB budget); e2e **186 collected across 30 files** (was 171/29), still
  collected-not-executed per D-119.

## D-150 — 2026-09-11 — P5/C03a: casting legality, components, arcane spell failure and concentration

- **Context:** C03 asks for "concentration/components and timing: defensive casting versus
  taking-damage checks, spell loss, threatened casting, armor spell failure, verbal/somatic/
  material/focus requirements, touch/held charge, multi-round casting, swift/quickened/metamagic
  timing". Nothing in `src/` answered "may this caster cast this spell right now, and does it
  survive?" — the strategic engine cast unconditionally and the tactical C02 resolver started at
  the saving throw, after the casting had already succeeded. The Gap List has no appendix table for
  concentration DCs, so the rules were verified before encoding (R02).
- **Verified sources (transcribed 2026-09-11):** Archives of Nethys Rules ID 203 / CRB pp.206–208,
  Table 9-1 "Concentration Check DCs", verbatim: cast defensively "15 + double spell level";
  injured while casting "10 + damage dealt + spell level"; continuous damage "10 + 1/2 damage dealt
  - spell level"; a non-damaging spell "DC of the spell + spell level"; grappled or pinned "10 +
    grappler's CMB + spell level"; vigorous/violent/extremely violent motion 10/15/20 + spell level;
    wind with rain or sleet 5 + spell level; wind with hail and debris 10 + spell level; entangled
    15 + spell level. Plus: "you roll d20 and add your caster level and the ability score modifier
    used to determine bonus spells of the same type"; "If you fail the check, you lose the spell just
    as if you had cast it to no effect"; "Pinned creatures can only cast spells that do not have
    somatic components"; and, for grappling, casting is allowed "provided its casting time is no more
    than 1 standard action, it has no somatic component, and you have in hand any material components
    or focuses you might need". Spell Failure (CRB p.208): "might fail if you're wearing armor while
    casting a spell with somatic components". From the Armor table: "The number in the Arcane Spell
    Failure Chance column … is the percentage chance that the spell fails and is ruined. If the spell
    lacks a somatic component, however, it can be cast with no chance of arcane spell failure";
    "Shields: If a character is wearing armor and using a shield, add the two numbers together to get
    a single arcane spell failure chance"; "A spellcaster who has been deafened has a 20% chance to
    spoil any spell with a verbal component". Component text: "To cast a spell, you must be able to
    speak (if the spell has a verbal component), gesture (if it has a somatic component), and
    manipulate the material components or focus (if any)"; a somatic component needs "at least one
    hand free"; and "If the Components line includes F/DF or M/DF, the arcane version of the spell has
    a focus component or a material component (the abbreviation before the slash) and the divine
    version has a divine focus component (the abbreviation after the slash)".
- **Decision:** `src/packages/pf1e/concentration.ts` — pure and diceless. `parseSpellComponents`
  returns **per-tradition segments** rather than a flat code list, so `M/DF` resolves to M for an
  arcane caster and DF for a divine one instead of both casters needing both. `checkCastingLegality`
  returns named refusals (cannot speak / no free hand / components not in hand / pinned /
  grappling) rather than a boolean, because the table has to say _why_. `arcaneSpellFailureChance`
  resolves each item **before** summing, so an exemption (bard light armour, mithral, Arcane Armour
  Training) is per item — the Paizo-clarified reading — and returns chance 0 with `applies: false`
  for a spell with no somatic component. `resolveConcentration` takes one die **per trigger**, since
  several checks can apply to one casting and each is a separate roll; any single failure loses the
  spell, and all checks are still evaluated and reported so the table can show which one failed.
- **Table 7-2 is read, not re-encoded.** `castingAction` resolves casting times through the existing
  `pf1eActionById` in `actions.ts` ("cast-spell" ⇒ standard/provokes yes; "cast-quickened" ⇒
  swift/provokes no), which already carries the verified provoke column, so a free- or swift-action
  spell inherits "doesn't incur an attack of opportunity" from the same row the action ledger uses.
  Metamagic for a sorcerer or bard moves a 1-standard-action spell to a full-round action, and Quicken
  Spell overrides that back to swift.
- **Refused rather than guessed:** Table 7-2 lists only "Cast a spell (1 standard action casting
  time)", so a full-round or longer casting time returns `provokes: null` with a note instead of an
  inherited `yes`. `featBonus` (Combat Casting +4) and item exemptions are caller inputs, not
  inferred from authored content (D-141), and casting times arrive as a caller-assigned bucket
  because PF1e casting times are free text this module declines to parse.
- **One assumption, named:** the continuous-damage row reads "10 + 1/2 damage dealt + spell level"
  with no rounding rule stated. This floors it, following Pathfinder's general round-down convention
  — that is an assumption, not a transcribed sentence, and is flagged in the code comment and here
  for R03 review rather than presented as verified.
- **Still open for C03:** touch spells and holding the charge, multi-round casting completion, the
  prepared-caster metamagic cost, and the actual attack-of-opportunity trigger that makes "injured
  while casting" happen (that is P06's interrupt queue — this slice takes the damage as an input).
  No casting UI. **C03 stays unchecked.**
- **Evidence:** 29 new unit tests in `tests/packages/pf1eConcentration.test.ts`, including the
  level-9 cast-defensively DC (33) that pins the doubling against "15 + spell level", and the
  two-check case where casting defensively passes but the injury check fails;
  `e2e/pf1e_concentration.spec.ts` (5 tests × 3 projects) drives `AppSurface.pf1eCastAttempt`, which
  derives deafened/grappled/pinned from the **authored actor document** through
  `deriveFromDocuments` before running the gate, so the browser path proves real data reaches the
  legality rules. Full suite **1318 passed / 3 skipped** across 135 files (+29 tests, +1 file over
  D-149); typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist
  **2,162,913 raw / 626,059 gzip** (+9,054 over D-149, within the 6 MB budget); e2e **201 collected
  across 31 files** (was 186/30), still collected-not-executed per D-119.

## D-151 — 2026-09-11 — P5/C05a: pack-driven cast payloads, and both live DEVIATIONS closed

- **Context:** DEVIATIONS carried exactly two live entries and P5 owned both. **D-1** was the
  strategic spell _scatter step_ — every model inside a template was unconditionally moved 5 ft away
  from the epicenter and took no damage if the step left the radius. No SRD rule lets a creature step
  out of a `fireball` before saving; D-130 decided "remove", not "make it a toggle". **D-2** was the
  reference system's hard-coded Fireball order (`massBattlePf1e.ts`), whose `radius: 15` and `dc: 16`
  disagreed with the content pack it claimed to fire. C05 asks for "profile/pack-driven cast payloads
  for location, shape, range, radius, CL, DC, dice and targets".
- **Verified sources (transcribed 2026-09-11):** Fireball, CRB p.283, cross-checked across
  pathfinder.d20srd.org, d20pfsrd.com, roll20's compendium and legacy.aonprd.com: "School evocation
  [fire]; **Level sorcerer/wizard 3**"; "Casting Time 1 standard action"; "Components V, S, M (a ball
  of bat guano and sulfur)"; "Range **long (400 ft. + 40 ft./level)**"; "Area **20-ft.-radius
  spread**"; "Saving Throw **Reflex half**; Spell Resistance **yes**"; and "1d6 points of fire damage
  per caster level (**maximum 10d6**)". Class levels elsewhere: bloodrager 3 / magus 3 / sorcerer-
  wizard 3, and oracle (flame mystery) 3.
- **Decision:** `src/packages/pf1e/spellPacks.ts` — `parsePackSpellOrder({entry, casterLevel})` reads
  the `system.massBattle` block a content pack ships and returns a validated payload, so radius,
  shape, save type, half/negates, evasion applicability and the dice all come from the pack instead of
  a literal at the call site. It resolves "1d6 per caster level (maximum 10d6)" from
  `dicePerCasterLevel` + `maxDice`, and it **cross-checks the sim block against the spell's own
  Saving Throw line**: a pack saying "Reflex half" while driving `halfOnSave: false`, or flagging
  `evasion` on a spell that is not Reflex half, is reported as a content bug rather than silently
  resolved. The save DC is deliberately **not** derived from the pack's class table — it is
  `spellSaveDc` from `casting.ts`, so the strategic and tactical paths now share one DC formula and
  cannot drift.
- **Three rules fixes fell out of reading the strategic resolver closely, each now pinned by a
  fixture:** (1) the scatter block is deleted and `modelsScattered` removed from the metrics — a
  model resolves the save in the square it occupies, and the fixture puts one 14.5 ft from the
  epicenter of a 15-ft blast, exactly where the old step would have pushed it to 15.5 ft and reported
  it as having escaped; (2) `if (srRoll !== 20 && srTotal < targetSr)` became `if (srTotal <
targetSr)` — a caster level check has no automatic success on a 20, and this was the divergence
  D-149 recorded between the strategic and tactical paths; (3) Evasion was being applied to _any_
  save type and _any_ severity, so a Fortitude-half spell was negated outright by it — it is now gated
  on `saveType === "ref" && halfOnSave`, and `halfOnSave: false` negates on a success instead of
  halving.
- **The pack's own Fireball entry is wrong, and is reported rather than silently absorbed.**
  `systems/pf1e-core/packs/spells.json` carries `level.wizard: 5` against CRB p.283's
  "sorcerer/wizard 3", `range: "100 ft. + 50 ft./level"` against "long (400 ft. + 40 ft./level)", and a
  `target` line ("one creature or object per caster level; no two may be more than 30 ft. apart") that
  an area spell does not have. Secondary sources also indicate Fireball is **not** on the alchemist or
  investigator list, which the pack lists at 5. Only the `massBattle.notes` field was edited, because
  it described the sim's old hard-coded DC 16 and was therefore made false by this change; the level,
  range and target fields were **left alone** on purpose — correcting a combined `sorcererWitch` key
  and deleting class entries needs the whole class list verified against primary text, and the
  negative claims ("not on the alchemist list") are only supported by secondary sources this turn.
  This is safe precisely because nothing reads the pack's `level` table: the DC comes from
  `spellSaveDc` with a caller-supplied spell level. **Open content bug, tracked in the TODO.**
- **Packs stay content, not code.** Nothing in `src/` reads `systems/**` at runtime, so
  `PF1E_PACK_FIREBALL_MASS_BATTLE` mirrors the shipped block for the reference system and
  `tests/packages/pf1eSpellPacks.test.ts` asserts the mirror against the real file — reading it the
  same way `pf1eActor.test.ts` reads the bestiary. That test caught genuine drift on its first run:
  the mirror omitted `notes`. The test now asserts `notes` is the _only_ omission rather than
  loosening the comparison, since `notes` is prose for a pack author and not a sim input.
- **Each fix was mutation-checked, and the first D-2 guard did not work.** Re-running green tests
  proves nothing about whether they would catch a regression, so all four changes were reverted one
  at a time and the suite re-run. Three failed immediately as intended: restoring `srRoll !== 20`
  gives `srBlocked` 0 instead of 1; restoring the scatter step empties `affectedModels` for the model
  at 14.5 ft; restoring the old Evasion branch gives 0 instead of 6 on the Fortitude-half case and 6
  instead of 0 on the negates case. **Restoring the hard-coded `radius: 15` / `dc: 16` at the call
  site left the suite fully green** — the pack-parity test only pins the mirror constant, not the
  order that is actually built. A first attempt at a call-site guard also passed under the mutation,
  because it asserted the _reported_ cast parameters while the mutated code still reported the pack
  values and only the resolution used the literal. What actually catches it is an outcome
  discriminator: a third model at (10, 27), 17 ft from the epicenter, is inside the pack's 20-ft
  spread but outside a 15-ft literal, so `modelsTargeted` is 3 with pack data and 2 with the
  hardcode. That is now asserted in `tests/packages/massBattlePf1e.test.ts`, and the mutation fails
  it with `expected 2 to be 3`.
- **Formatting discipline corrected in the same pass.** This repo is _not_ uniformly Prettier-
  formatted — `pnpm format` is a manual script, not a gate, and many files (all of `e2e/`, both
  mass-battle test files, `DEVIATIONS.md`, `spells.json`) are unclean at HEAD. Running
  `prettier --write` on those files reformatted hundreds of untouched lines; that was reverted and
  the edits re-applied in each file's existing style. The rule this leaves behind: **check
  `git show HEAD:<file> | prettier --check --stdin-filepath <file>` first, and only format files that
  were already clean.** Verified afterwards by diffing deletions — every deleted line in
  `spells.ts` (25) and `massBattlePf1e.ts` (13) is a line this change replaces, and the appended
  tests show 0 deletions.
- **Evidence:** 16 new tests (11 in `tests/packages/pf1eSpellPacks.test.ts`, 4 added to
  `pf1eSpells.test.ts`, whose first test was also renamed — it advertised the scatter it no longer
  does, and 1 in `massBattlePf1e.test.ts`); full suite **1334 passed / 3 skipped** across 136 files
  (+16 tests, +1 file over D-150); typecheck, lint, build, size and `build:systems` green.
  `dist/index.html` is byte-identical to D-150 (2,162,913 raw / 626,059 gzip) **because
  `massBattlePf1e.ts` is not in the app bundle** — verified, not assumed: `grep -c massBattle
dist/index.html` returns 0. It ships in the rules artifact instead, verified by unpacking:
  `rules.js` grew 46.7 kB → **55.1 kB**, contains the new "no massBattle block" message and the
  `radiusFeet` mirror, and no longer contains `modelsScattered` or `srRoll`.
  `dist/packages/pf1e-core-1.0.0.zip` was unpacked and its `packs/spells.json` confirmed to carry
  radius 20 and the corrected note. The existing `e2e/pf1e_mass_battles.spec.ts` imports and
  activates that exact zip in a real browser Worker and asserts `packCount === 2`, so the edited pack
  and the edited rules bundle are both covered on the browser side at the load-and-activate level;
  the spell resolution itself is covered by unit tests and is **not** browser-executed here (D-119).
  **C05 stays unchecked** — location, range and targets are still a fixed demo origin rather than
  order-driven, and only `circle` is wired.

## D-152 — Spell slots, bonus spells and prepared/spontaneous bookkeeping (P5/C04, 2026-09-11)

**Context.** C04 asks for "level 0–9 spellbook/preparation/slot readouts, prepared versus spontaneous
data and bonus slots; MVP overuse produces warnings, not hard enforcement". Before this slice the
repo had **no bonus-spell computation at all** (`grep -rn bonusSpell src/` → 0 hits) and the only
slot data was `PF1eDerived.spellSlots`, which `actor.ts:973–985` fills with the **authored** budget
verbatim — no Table 1-3 bonuses, no minimum-ability check, no ledger, and nothing in `src/ui/` read
it (`grep -rn spellSlots src/` matched only `actor.ts`).

**Rules verified against primary text before encoding (R02).**

- **CRB Table 1-3, "Ability Modifiers and Bonus Spells"** (p.17; verified 2026-09-11 against
  d20pfsrd.com/basics-ability-scores/ability-scores/, cross-checked against the dandwiki PFSRD
  mirror and the Kingmaker wiki). All 23 rows transcribed into
  `PF1E_BONUS_SPELL_TABLE`. Two properties of the table are easy to get wrong from its shape and are
  the reason it is written out rather than computed: **0th-level spells never receive a bonus spell
  at any score** (the "Bonus Spells per Day" columns start at 1st), and **the progression is not
  linear** — 20–21 grants 2/1/1/1/1, not 2 at every level. Scores 1 through 9 all read "Can't cast
  spells tied to this ability". The table ends with "etc. . ." above 45, so **46+ is reported as out
  of range rather than extrapolated** — inventing a 46th row would be a fabricated fixture (V01).
- **Minimum ability score** — CRB, Wizard: "To learn, prepare, or cast a spell, the wizard must have
  an Intelligence score equal to at least **10 + the spell level**." Generalised to any spellcasting
  ability (Int wizard/magus/alchemist; Wis cleric/druid/ranger/inquisitor; Cha bard/paladin/
  sorcerer), which is how the class write-ups state it. Encoded as `minimumAbilityScore`.
- **A bonus is usable only where the class already grants the slot** — the CRB's own gloss: "he can
  only use the 1st-level bonus spell because as a 1st-level wizard he only has access to 1st-level
  spells." So a bonus at a level with no slots is a **warning**, never a granted slot.
- **Ability damage does not cost bonus spells; ability drain does** (CRB p.555, already implemented
  in `actor.ts:549–556`): drain _actually reduces the score_, damage applies only a −1 penalty per
  two full points to statistics using the modifier. Table 1-3 is a **score** table, so the readout
  takes `derived.abilities[keyAbility]` — which `actor.ts` has already drain-adjusted but never
  damage-adjusted — and must not. Pinned both ways by a fixture (drain 6 ⇒ Int 12 loses 3rd/4th;
  damage 6 ⇒ still 18, warnings empty). Writing this test first produced a **wrong expectation, not a
  wrong implementation**: `abilitiesDamage` returned 18 and the test failed. The rule, not the code,
  was corrected.

**What landed.**

- **`src/packages/pf1e/spellSlots.ts` (new, pure, no repo imports).** `bonusSpellsForAbility` (Table
  1-3), `minimumAbilityScore`, `resolveSpellSlotBudget` (authored budget + bonuses + castability +
  warnings), `emptySlotLedger`/`spendSlot`, `spendSpontaneousSlot` (lowest sufficient slot, escalates
  when a level is exhausted), `reviewPreparation`/`expendPrepared`, and the readout layer
  `slotLevelLabel`/`slotLedgerView`. Every over-budget path returns **`allowed: true` plus a
  `warning`** — nothing refuses a cast, per C04.
- **`pf1eSpellSlotReadout(derived)` in `src/ui/sheets/pf1eSheetModel.ts`** — a thin adapter that maps
  a `PF1eDerived` onto the budget. This file's stated rule is "no rules arithmetic" and it keeps it:
  Table 1-3, the minimum score and the warnings all live in the package. It truncates the derived
  0–10 slot array at 9 because C04 scopes the readout to **levels 0–9**; level 10 is not silently
  widened in, and a fixture asserts a 10th-level slot stays out.
- **Sheet readout** in the summary tab of `PF1eActorSheet.svelte`, under Spell resistance:
  `<dd data-pf1e-spell-slots>` renders `0th 0/4 · 1st 0/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2 (INT 18,
prepared)`, and each budget warning renders as `data-pf1e-spell-slot-warning`.
- **`AppSurface.pf1eSpellSlots({system})` in `src/app/e2eHook.ts`** plus
  `e2e/pf1e_spell_slots.spec.ts` (7 tests). The surface calls the **same** `pf1eSpellSlotReadout` the
  sheet renders rather than a copy, so the browser path proves the sheet's own code reaches the rules.

**Every rule claim was mutation-checked.** Re-running green tests says nothing about whether they
would catch a regression, so five mutations were applied one at a time and the suite re-run: making
the 20–21 row linear (**2 failed**), shifting the row so 0th level gets the 1st-level bonus (**9
failed**), turning overuse into a hard refusal (**2 failed**), ignoring bonuses entirely (**8
failed**), and dropping the no-slots-for-bonus warning (**1 failed**). Restored baseline: 36/36.

**Evidence.** 42 new tests (36 in `tests/packages/pf1eSpellSlots.test.ts`, 6 added to
`tests/ui/pf1eSheetModel.test.ts`, which went 13 → 19); full suite **1376 passed / 3 skipped** across
137 files (+42 tests, +1 file over D-151); typecheck, lint, build, size and `build:systems` green.
dist **2,169,035 raw / 627,929 gzip** (+6,122 / +1,870 over D-151, within the 6 MB budget);
`rules.js` unchanged at **55.1 kB**; e2e **222 collected across 32 files** (was 201/31), still
collected-not-executed per D-119. Prettier status audited per file against HEAD — **no file flipped**
except `PF1eActorSheet.svelte`, where the "flip" is an artifact of the check and not a formatting
regression: this repo has no Svelte parser, so `prettier --check <file>.svelte` exits 2 with "No
parser could be inferred", while the `git show HEAD:<f> | prettier --check --stdin-filepath` form
silently no-ops and exits 0. **Prettier does not apply to Svelte files here**; `pnpm lint`
(`svelte/require-each-key` caught the one real issue) is what covers them.
DEVIATIONS.md is unchanged: 2 rows, both **CLOSED (D-151)**, none live.

**What is deliberately not shipped, and why C04 stays unchecked.** The bundle confirms the boundary
rather than leaving it assumed: `grep -c "Spell slots (0th-9th)" dist/index.html` → 1 and
`grep -c "is below the required"` → 1, but `grep -c "no slots granted at that level"` → 0,
`"which grants no slots"` → 0 and `"no unspent slot at level"` → 0. The **readout** path ships; the
**spending and preparation** path (`spendSlot`, `spendSpontaneousSlot`, `reviewPreparation`,
`expendPrepared`) is tree-shaken out because nothing in `src/` calls it yet. So C04's "overuse
produces warnings, not hard enforcement" is implemented and mutation-tested as a data layer but is
**not observable in the product** — no cast decrements a slot. Two pieces of the item also remain
unbuilt: a **rendered spellbook/prepared list** (there is no authored prepared-spell list on the
actor document at all, so this needs a schema field plus validation and an editor, not just markup),
and wiring the ledger to actual casting. **C04 stays `[ ]`.**

## D-153 — First executed full-Chromium e2e pass: five latent failures found, three product repairs (S01/S04/N01/N02 browser half, 2026-09-11)

**Context.** Every slice from D-119 onward recorded its browser specs as
"collected, not executed": the Playwright browser CDN (`cdn.playwright.dev` →
`storage.googleapis.com`) is unreachable from the sandbox, and Debian mirrors
are closed too, so no Chromium existed to run them. This slice got a real
browser running — `@sparticuz/chromium@152.0.0` (npm, the D-119 precedent)
extracted to `/tmp/chromium`, with its three missing shared libraries
(`libnspr4.so`, `libnss3.so`, `libnssutil3.so`) inflated from the package's own
`al2023.tar.br` into `LD_LIBRARY_PATH` — and ran the **whole collected e2e
suite on Chromium: 74/74 passing**, after repairing what the run exposed. No
security-bypass flags; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is the documented
override path (README), default pinned-browser behavior unchanged.

**Why this matters:** five of the "collected" specs were **wrong or uncovered
real bugs** — exactly the risk the collection-only convention carried. Three
were product bugs unit tests could not see; three were spec bugs (one spec had
both).

**Product repairs (the browser saw what Node could not):**

1. **The E02 effect editor crashed on every typed number.** All eight numeric
   inputs in `PF1eEffectEditor.svelte` used `bind:value` on `type="number"`,
   which Svelte 5 coerces to `number` — then `buildEffectRequest`'s
   `row.value.trim()` threw `e.trim is not a function` (observed as a page
   error; the form silently kept its values, no effect applied, no visible
   error). The model's contract is string-in ("empty numerics are absent,
   garbage numerics are named errors"), so the fix is at the binding: each
   numeric input now stores `e.currentTarget.value` verbatim via `oninput`.
   The model-level unit tests all fed strings, which is why they never caught
   it; the fix is pinned by the E02 browser spec executing for the first time.
2. **The PF1e pre-start initiative gate was unreachable.** D-132 routes PF1e
   encounter starts through `startWithSurprise`, which requires initiative
   rolled and ties resolved **before** Start ("Roll initiative before starting
   a PF1e encounter."). But every roll control (`#combat-init`, Roll all, Roll
   hidden) rendered only in the running branch — a pre-created PF1e encounter
   could never satisfy its own gate (the create-and-start shortcut bypasses it,
   which is how the gap stayed hidden). `rollInitiative` needs only a selected
   encounter, not a running one, so the pre-start branch now renders the same
   three controls for `combat && pf1e` (exclusive branches, so the `#combat-init`
   id is never duplicated in the DOM), with a one-line note that PF1e starts
   are surprise-aware. No rules change — the gate D-132 designed is now
   reachable.
3. **Effective scores were invisible where effects are edited.** The E02
   acceptance reads the live ability scores back after apply/suppress/remove,
   but `data-pf1e-effective-scores` rendered only on the attributes tab while
   the editor lives on the effects tab. The effects tab now carries the same
   read-only effective-scores line, so applying a buff shows the numbers move
   without tab-switching — the E02 intent ("recompute-on-effect-change is
   structural") made visible.

**Spec repairs (written against assumptions, not against a running app):**

4. **A06/A06b roll-card specs** asserted `#chat-log .rollcard` while driving
   the sheet **embedded in the sidebar** — but `ChatPanel` mounts only when the
   chat tab is active, and switching to it unmounts the sheets panel. The
   product's real flow is the floating sheet window; the specs now open the
   sheet via `[data-open-pf1e-sheet]`, activate the chat tab, and drive
   `.wm-window [data-pf1e-sheet]`. Both pass — including the A06b hp write
   (`PF Dummy 12 → N HP`) through the op path.
5. **The N01/N02 join spec** called `armySnapshot`, `factionOwnership` and the
   GM-side `simCount` on the **app** surface; they live on the **gm** surface
   (`GmFogSurface`, installed at `?e2e=1` boot). Added a `gmCall` helper
   mirroring `gmextras.spec.ts` and switched the three calls. The spec now
   **executes end-to-end**: import/activate both shipped zips, manual-signaling
   joiner adopts the announced PF1e schema, 10-model campaign reaches the
   player replica (snapshot + delta), resolved turn advances `simVersion`, zero
   page errors on either peer.
6. **The §1.8 package spec** expected `rulesBoot` to flip to `package`
   immediately after `activatePackage`; activation is persist-only and the
   SimWorker rules slot resolves at boot (D-087/D-110 reload-based switching —
   `packages.spec.ts` has always modeled the reload). The spec now reboots
   after activate and after deactivate, and both reads report the right source.

**Also fixed while running the join spec:** `dist/packages/*.zip` is wiped by
`pnpm build`, so `build:systems` must run **after** `build` (the `test:e2e`
script order); running them out of order reproduces "zip missing".

**Verification and evidence.** Full unit suite **1376 passed / 3 skipped**
across 137 files (unchanged — no unit behavior moved); typecheck, lint and
touched-file Prettier green; `pnpm build` + `pnpm size`: dist **2,170,273 raw
/ 628,118 gzip** (+1,238 over D-152, within the 6 MB budget);
`build:systems` emits both zips (rules.js unchanged at 55.1 kB). **Chromium
152 e2e: 74/74 passing in 3.8 min**, including every previously
collected-but-unexecuted PF1e spec: sheets (24 incl. A06/A06b/E02 and the
scoped-roster flow — which additionally needed the pre-start roll, since D-132
gates PF1e starts), windows, combat, the N01/N02 join, casting/concentration/
targeting/spell-slots and the §1.8 package flow.

**What stays unchecked and why.** Per the D-119 convention, S01/S04 and
N01/N02 need the **full supported-browser matrix**, and Firefox/WebKit cannot
be downloaded here (the Playwright CDN and all Debian mirrors are blocked;
D-082 already records the sandbox's firefox ICE limitation). Their **Chromium
acceptance half is now executed and green**, which this decision records; the
boxes stay `[ ]` pending Firefox/WebKit runs in an environment that can fetch
those binaries.

## D-154 — 2026-09-11 — P5/C01 closed: the PF1e area canvas preview overlay, and one seam for it

**Context.** D-148 landed the pure grid targeting (burst/emanation/cylinder/spread,
5-10-5 counting, far-corner inclusion, wall LoE, scene-grid bridging) with the
comment on `cellRect` promising "for the canvas preview overlay" — but the overlay
itself, and the affected-token highlighting C01 asks for, did not exist. This slice
delivers them and closes C01, with cone/line staying refused under their C01b named
issue (below).

**One seam, not three re-wirings.** `src/packages/pf1e/areaPreview.ts` (new, pure,
diceless, Pixi-free) is the single composition `pf1eAreaPreviewModel`: scene grid →
`pf1eAreaGridFromScene` → `resolveAreaCells` (walls arrive as caller-supplied
`segments`, so the pf1e package never imports a WallDocument) → `areaPreviewRects`
draw list + `affectedTokens` read. It returns world-space cell rects, affected token
ids, token **highlight rects** and a UI label — or `ok: false` with the named issues
(metric scene, refused shape, non-intersection origin, caps). The canvas layer, any
future casting UI and the e2e surfaces all consume this one function; nothing
re-derives the chain.

**The layer rides the controls holder.** `src/canvas/layers/AreaPreviewLayer.ts`
draws the cells (orange fill + stroke) and a ring around each affected token,
version-keyed like `StrategicFogLayer`, with `rectCount`/`highlightCount` readbacks.
It lives in the controls container: the preview is local caster UI state, not a
replicated document, and the §9 `LAYER_ORDER` constant stays verbatim (the
`canvasSmoke` layer-order assertion is unchanged). `App.svelte` owns the preview
state: `showPF1eAreaPreview(spec)` resolves against the active scene's grid/tokens/
`sightSegments(walls)`; a scene switch clears the preview rather than repainting
stale cells; every `refresh()` re-syncs through the version key.

**Surfaces:** `GmFogSurface.pf1eAreaPreviewShow/Clear/State` (the App-installed
surface, which alone can reach the stage). Show returns the resolved model so
callers surface the named issues; state reports what the layer actually drew.
`e2e/pf1e_targeting.spec.ts` drives the full loop in Chromium: burst-on-the-token's-
2×2 draws 4 rects + 1 highlight, a refused cone is reported and never drawn, clear
empties the overlay, zero page errors.

**Cone and line remain refused (C01b), now visibly.** `pf1eAreaPreviewModel` returns
`ok: false, issues: [{field: "kind", … "cone and line are C01b"}]` for them — the
D-148 position is unchanged: their square-grid discretization is contested (the
published cone templates disagree; the designer's own answer is "just pick one"),
so encoding either would be inventing a rule. C01's "where supported" wording covers
the shipped subset; C01b needs a canonical transcription decision (R01 discipline)
before any geometry exists.

**Verification.** 7 new unit tests in `tests/packages/pf1eAreaPreview.test.ts`
(composition: world rects for the hand-derived 5-ft burst, in/out token highlights,
the D-148 wall fixture forwarded through the model, metric/cone/non-intersection
refusals). Full suite **1383 passed / 3 skipped** across 138 files (+7/+1);
typecheck, lint, touched-file Prettier green. **Chromium e2e 75/75** (was 74, +1
overlay spec). dist **2,173,082 raw / 629,122 gzip** (+2,809 over D-153, within the
6 MB budget).

**C01 is checked.** Landed: burst/emanation/cylinder/spread targeting, scene
distance/units/diagonals bridging, wall line-of-effect, canvas preview overlay,
affected-token highlighting. Open under C01's umbrella, named rather than dropped:
cone/line shapes (C01b, refused with a named issue) and "cover" as a targeting
_modifier_ (soft/partial cover bonuses belong to P04's positional defenses; the
preview respects walls via LoE, which is what C01's "walls/line of effect" asks).
The preview's in-product consumer arrives with the C02 casting UI; until then the
overlay is reachable through the documented surface, and its state machine
(show/refuse/clear/scene-switch) is browser-tested.

## D-155 — 2026-09-11 — P5/C04 closed: persisted slot ledger + prepared list, and the sheet's Spells tab

**Context.** D-152 shipped C04's rules layer — Table 1-3 bonus spells, the `10 + spell level`
minimum, `spendSlot`/`spendSpontaneousSlot`/`reviewPreparation`/`expendPrepared`/`slotLedgerView`,
all pure and mutation-checked — but left it tree-shaken: nothing in `src/` called the ledger, there
was no authored prepared list on the actor document at all, and the sheet only rendered a
spent-always-zero readout. D-152's own close-out named exactly what C04 still needed: a schema field
plus validation for the daily state, an editor for it, and observability in the product. D-155 is
that slice: **persistence + UI, with zero new rule encoding** — every rules claim reuses D-152's
verified layer.

**What landed.**

- **Schema (`src/packages/pf1e/actor.ts`).** `PF1eSpellsAuthored` gains two daily-state fields,
  validated in the same `o.spells` block that guards the rest of `system.pf1e`:
  `slotsUsed?: Partial<Record<number, number>>` (keys integers 0–9, values non-negative integers —
  the per-level spent ledger) and `prepared?: Array<{ name; level; slotLevel?; expended? }>`
  (name 1–120 chars, level/slotLevel integers 0–9, list capped at the new
  `MAX_PREPARED_SPELLS = 200`, a malformed-pack defense matching `MAX_SHEET_ATTACKS`). Both are
  optional: every existing actor and fixture stays valid, and a caster with no daily state reads as
  all-unspent/nothing-prepared.
- **`src/ui/sheets/pf1eSpellbook.ts` (new).** The spellbook surface, following the Weapons-tab
  contract (D-117) and the `pf1eAttackEdit` shape:
  - `pf1eSpellbookView(actor, derived)` maps the authored block onto D-152's layer —
    `slotLedgerView(budget, ledger, preparedByLevel)` for the 0–9 rows (Table 1-3 totals included),
    the resolved budget for the base/bonus split, the normalized prepared rows, and
    `reviewPreparation(...).warnings` for prepared casters.
  - `pf1eSpellbookEdit(actor, derived, user, edit)` returns `{ops, error, warning}` for
    `spend`/`restore`/`prepare`/`preparedRemove`/`preparedToggle`. Ownership-gated
    (`isPF1eActor` + `can(user, "update", actor, "actors")`); spends write the dotted
    `system.pf1e.spells.slotsUsed.<level>` path when the ledger exists (preserving sibling levels)
    and materialize the full ten-level object on first spend; prepared operations replace the array
    whole. Over-budget spending goes through D-152's `spendSlot`, which returns `allowed: true` plus
    a `warning` — the edit is written and the warning surfaced, never refused (C04's "warnings, not
    hard enforcement"). Restore clamps at zero as a no-op; prepared-list operations are refused for
    spontaneous casters with a named error.
- **Spells tab (`PF1eActorSheet.svelte`).** A casting-only `spells` tab (hidden for non-casters):
  per-granted-level rows with base/total/spent/remaining and Spend/Restore buttons, the prepare form
  (name, spell level 0–9, optional cast slot), per-row expend checkbox and remove button, the
  preparation warnings and a warning area for over-budget spends. The summary tab's
  `data-pf1e-spell-slots` readout now threads the authored block through the same
  `pf1eSpellSlotReadout` adapter (new optional `spells` parameter), so both homes read one ledger.
- **e2e surface parity (`src/app/e2eHook.ts`).** `pf1eSpellSlots(spec)` now passes the authored
  `spells` block into `pf1eSpellSlotReadout`, so the browser path proves the persisted-ledger
  projection through the sheet's own adapter, not a copy.

**Verification.** 15 new unit tests in `tests/ui/pf1eSpellbook.test.ts` (dotted-diff shape and
sibling preservation, first-spend materialization, restore clamp/no-op, over-budget warn-not-refuse,
out-of-range and malformed-input named errors, prepared append/toggle/remove array replacement,
spontaneous refusal, ownership denial, ledger + prepared-count projection, over-preparation
warning). Full suite **1398 passed / 3 skipped** across 139 files (+15/+1 over D-154); typecheck and
lint green; touched-file Prettier applied. **Chromium e2e 79/79** (was 75, +4 new): 4 new tests in
`e2e/pf1e_spellbook.spec.ts` — adapter projection of `slotsUsed`/prepared counts, over-budget
projection as a warning, a full store round-trip (spend×2 → restore → overuse to 6-of-5 with the
visible warning → prepare → expend → remove → summary reading `1st 6/5`), and a non-caster with no
tab; zero page errors. dist **2,185,403 raw / 637,840 gzip** (+12,321 / +8,718 over D-154, within
the 6 MB budget). D-152's tree-shake gap is closed: `"no slots granted at that level"` and
`"which grants no slots"` now each grep to 1 in `dist/index.html` (both were 0) — the ledger layer
is reachable from the product.

**Scope boundaries.** Casting a spell does not yet decrement a slot — that coupling belongs to the
C02 casting flow, which will also become the preview overlay's consumer (D-154). Resting/recovery
automation is P7; until then Restore is the GM's manual daily reset. Spontaneous casters spend
through the same manual controls for now (`spendSpontaneousSlot`'s lowest-sufficient-slot escalation
awaits the cast flow). Cone/line stay refused under C01b. **C04 is checked.**

## D-156 — 2026-09-11 — P5/C02 closed: the tactical cast flow — validation-first, damage→SR→save, round-scoped SR ledger

**Context.** D-149 encoded C02's arithmetic as pure functions in `src/packages/pf1e/casting.ts`
(spell DC, save outcomes with Evasion/Improved Evasion, spell-resistance checks, energy resistance
inside `resolveSpellTarget`) and its close-out named exactly what C02 still needed: chosen-target
selection, the round-scoped resistance bookkeeping (then only a caller-supplied flag), and the
casting UI. D-152/D-155 meanwhile shipped the slot ledger and spellbook sheet that a cast must spend.
D-156 is the slice that wires the three together in the product — **zero new rule encoding**; every
rules claim reuses D-149's layer.

**What landed.**

- **`src/packages/pf1e/srLedger.ts` (new, pure).** The round-scoped SR ledger C02 asks for under
  "target-specific resistance bookkeeping". The combat document's `flags.pf1e.srOvercome` blob maps
  `"casterId:targetId" → round`; four exported helpers own all access — `srOvercomeKey`,
  `srAlreadyOvercome` (true iff the recorded round equals the current round), `srOvercomeDiff`
  (minimal diff writing only the changed key, deletes never emit a spurious write), and
  `srOvercomeBlobFromFlags` (defensive read). Consequences: an overcome SR is **not re-rolled for
  the rest of the round**, a new round re-rolls, out of combat every cast rolls, and the GM's
  per-cast `srOvercomeByCaller` forces a fresh roll.
- **`src/ui/sheets/pf1eCastFlow.ts` (new).** `resolveCastFlow(client, user, params)` — the
  single-target cast orchestrator, shaped like `pf1eResolveFlow`'s attack flow. Hard orderings,
  each pinned by a test: (1) slot and prepared validation runs **before any roll** — a refused cast
  posts nothing and spends nothing; (2) rolls happen damage → SR check → save, each through the host
  roll service; (3) submission creates the card op first, then the state writes (slot/prepared
  spends, HP write, SR-ledger diff) as one batched op. DC comes from the caster's derived
  `spellSaveDc[level]` — null (no slots granted at that level) is a named refusal, not a silent
  zero. Severity is the full `PF1E_SAVE_SEVERITIES` set; Evasion/Improved Evasion read the target's
  authored feats via `hasPF1eFeat`; ER filters into `resolveSpellTarget`'s defender block.
  `castResolutionCardContent` renders the card: "X casts Spell (level N) at Y — DC d.",
  `[[total|formula]]` chips, the HP-transition line ("PF Ogre 20 → 15 HP.") and ⚠ warning lines.
- **Sheet wiring (`PF1eActorSheet.svelte`).** The Spells tab gains a cast panel (save type,
  severity, damage formula, energy type, SR-override checkbox, target picker over
  `pf1eTargetActors`) and a per-prepared-row Cast button that pins the panel to that row — the row's
  name, level and slot ride with it, and a successful cast expends the row. Over-budget casting
  stays warn-not-refuse per C04/D-155: the warning surfaces in the panel, the ledger row and the
  card. `pf1eResolveFlow.awaitRollMessage` accepts the cast-flow client via its structural
  `{ store }` shape rather than a shared interface, so the attack flow stays untouched.

**Verification.** 18 new unit tests — 4 in `tests/packages/pf1eSrLedger.test.ts` (key format,
same-round reuse, round rollover, delete-free diffs) and 14 in `tests/ui/pf1eCastFlow.test.ts`
(validation-before-rolls, roll order, DC-null refusal, all five severities, Evasion/Improved
Evasion, ER halving + floor, SR reuse/re-roll/override, card content). Full suite **1416 passed /
3 skipped** across 141 files (+18 over D-155); typecheck and lint green; touched-file Prettier
applied. **Chromium e2e 82/82** (+3 in `e2e/pf1e_cast_flow.spec.ts`): a harmless over-budget cast
spends 5→6 of 5 with ledger + panel + card warnings, expends the prepared row, disables its Cast
button and posts the no-save card; a 2d6 damaging cast lands the ogre's HP inside the roll range
with the transition line and the summary reading `1st 6/5`; named refusals (no target, bad dice)
spend nothing. dist **2,198,130 raw / 641,330 gzip** (+12,727 / +3,490 over D-155, within the
6 MB budget).

**Scope boundaries.** One chosen target per cast — area payloads and multi-target casts are C05's
profile-driven job (the preview overlay from D-154 is their future consumer). Components,
concentration, touch/holding, multi-round and metamagic timing are C03; D-150's legality helpers
are not yet wired into the cast path. Cast rolls are not commit/reveal — the damage/SR/save dice
are single-shot host rolls like the card chips. Resting/recovery remains manual (P7). **C02 is
checked.**
