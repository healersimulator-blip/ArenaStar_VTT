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
  + contracts/frame tests extended to 29 kinds.
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
  1) — alpha now lives on the view, g.alpha carries it for the placeholder.
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
- Flanking was +2 to-hit *and* −2 to AC (SRD: +2 to-hit only, from the helper), so a +2 flank could turn
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
  separately. Parity is a convention — shared *data and tables* under `src/packages/pf1e/` — and there
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
  pool hash *and* the wire. The p95 gate is a catastrophe ceiling (250 ms) with the measured p50/p95/max
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
  *shipped* `dist/packages/pf1e-{core,mass-battles}-1.0.0.zip` through the app surface, asserts `packages()`
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
  asserts the ownership level *through the projection itself*, and that a `default: 0` settings doc does
  **not** reach a player, so the level is load-bearing rather than decorative. Name collision to avoid:
  `src/storage/idb.ts:189`'s `getSetting/putSetting` are app-local `[scope, key]` pairs — unrelated.
- **No manifest version bump, no declarative migration in P0.** `derivePF1eActor` is *total over partial
  input* instead: a document with no `system.pf1e` at all yields a legal Medium commoner, naming every
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
  *every* attacker beats *every* defender, and the round runs before core's round 1 so `combat.round`
  stays 0), flat-footed-until-your-first-turn, the AoO ledger (A.10: refreshed at the start of *your*
  turn), held actions (A.10: six allies acting before you turns the hold into a full-round action), and
  the clock. Core still owns `round`/`turn`/initiative order — `startWithSurprise` hands over to
  `startCombat`, `pf1eNextTurn` delegates to `nextTurn` and only then applies PF1e's boundaries. The
  last test in `pf1eCombatState.test.ts` exists to prove that delegation: an embedded effect still ticks
  down and expires through the wrapper, with the expiry *reported*.
- **4. Fireball is 20 ft.** The pack/SRD value wins; the sim's 15 ft and the invented spell scatter are
  due to be deleted or filed in `DEVIATIONS.md` in P5 — that file still reads "None." and is stale.
- **5. PR order A→B→C** (sheet before tracker): a context menu needs a derived actor to act on.
- **Initiative ties carry a 0.5 marker** rather than a re-rolled die or an insertion-order accident:
  core orders purely by `initiative`, and `initiativeDisplay()` floors the value for display, so the
  tie-break is expressible without lying about what was rolled. Equal roll *and* equal Dexterity returns
  `needsReroll` instead of picking a winner.
- **A stat-block adapter, because the pack and the sheet author different shapes.** The shipped bestiary
  publishes totals and modifiers (`bab`, `strMod`, `ac`, `weapon.damageMod`, `dr: {val, bypass}`) —
  pool-shaped, because that is what `compilePF1eProfile` consumes; a sheet must author components (six
  scores, armor/shield/natural) or no buff can move a total. `src/packages/pf1e/statBlock.ts` converts
  one into the other *once*, and reports it: an ability score rebuilt from a modifier says so (a modifier
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
