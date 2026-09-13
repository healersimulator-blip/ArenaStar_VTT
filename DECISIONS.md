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

## D-157 — 2026-09-11 — P5/C03 partial: the C03a casting gate wired into the cast path

**Context.** D-150 encoded C03's pre-save gate as pure functions — component parsing with
per-tradition `M/DF` resolution, named legality refusals (cannot speak / no free hand /
components not in hand / pinned / grappling), per-item arcane spell failure, deafened spoilage,
Table 9-1 concentration DCs and `resolveCastingAttempt` as the orchestrator — but nothing in
`src/` called any of it: the layer was tree-shaken exactly as the slot ledger was before D-155.
D-157 is the wiring slice: **zero new rule encoding**, every ruling delegates to D-150's layer.

**What landed.**

- **Schema (`src/packages/pf1e/actor.ts`).** Prepared rows gain an optional `components` line
  (string ≤ 120 chars; deep parsing happens at cast time with named refusals) and the spells
  block an optional `tradition` (`"arcane" | "divine"`, validated). Both are additive — every
  existing actor and fixture stays valid, and a row without a line reads as gateless.
- **The flow (`src/ui/sheets/pf1eCastFlow.ts`).** `PF1eCastFlowParams` gains an optional
  `gate: PF1eCastGateInput` (components line, GM-declared caster state, casting time, and
  die-less concentration declarations). Hard orderings, each test-pinned:
  1. the gate's diceless half runs in the validation block — a malformed line or an illegal
     casting (silence vs V, no free hand vs S, pinned vs S, grappling vs >1-standard-action
     times, components not in hand vs M/F/DF) is refused by name **before any roll and spends
     nothing**;
  2. the dice half rolls after slot/prepared bookkeeping and before the effect rolls: one d100
     for arcane spell failure when `armor.spellFailure` applies (arcane tradition only, a
     somatic-less spell exempt), one d100 for deafened spoilage of a verbal component, one d20
     per declared concentration trigger — all through the host roll service;
  3. `resolveCastingAttempt` consumes the dice and returns the authoritative outcome. A ruined
     spell (`lost`) still spends its slot and prepared row — "you lose the spell just as if you
     had cast it to no effect" — posts a `Spell lost` card naming the failed check, and skips
     damage/SR/save/HP entirely; a surviving cast continues unchanged, carrying `gateNotes`.
- **The concentration bonus** composes from what derivation already exposes: caster level +
  key ability modifier (`abilityMods[spellKeyAbility]`) + the authored `concentration` bonus
  with effect mods — no new derived field.
- **Sheet wiring (`PF1eActorSheet.svelte`, `pf1eSpellbook.ts`).** The prepare form authors the
  components line (validated ≤ 120 chars); prepared rows display it; the row's Cast button
  prefills the panel's gate; the cast panel gains the gate fieldset — components, casting time
  (free/swift/standard/full-round/longer), cannot-speak / no-free-hand / components-not-in-hand
  / deafened / grappling / pinned checkboxes, casting-defensively, and injured-while-casting
  with a damage-taken input. An empty components line skips the gate, so every pre-D-157 cast
  behaves exactly as before.

**Verification.** 16 new unit tests — 15 in `tests/ui/pf1eCastGate.test.ts` (named legality
refusals roll nothing and spend nothing; malformed line refused; ASF ruin spends the slot and
posts the lost card with no effect rolls; ASF pass continues d100→damage; somatic-less and
divine casters get no ASF roll; deafened spoilage both ways; defensive casting DC 17 pass/fail;
injured trigger DC 10+damage+level; `M/DF` divine reading needs the focus in hand; empty line
skips the gate) and one schema test (tradition + prepared components validation). Full suite
**1432 passed / 3 skipped** across 142 files (+16 over D-156); typecheck and lint green;
touched-file Prettier applied. **Chromium e2e 83/83** (+1): a silenced caster's V/S cast is
refused by name with no spend and no card, then the same cast with the voice restored passes
the gate silently and lands; the first cast-flow test now rides the gate's pass path through
the prepared row's components line. dist **2,206,360 raw / 643,280 gzip** (+8,230 / +1,950
over D-156, within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: touch/held charges, multi-round casting,
swift/quickened/metamagic timing, threatened-casting attacks of opportunity, and the nine
remaining Table 9-1 situations in the UI (the pure layer supports all eleven). Per-item ASF
exemptions (bard light armour, mithral) and shield ASF have no authoring surface yet; caster
state is the GM's per-cast declaration, not yet derived from conditions. Area/multi-target
payloads remain C05.

## D-158 — 2026-09-11 — P5/C03 partial: touch spells and held charges ride the actor document

**Context.** C03's pre-save gate (components/concentration) landed product-reachable in D-157;
its touch-spell half — "touch/held charge" — was still a pure-layer aspiration. Per R02 the
CRB "Cast a Spell" touch section was transcribed before encoding: a touch-range spell is cast
and then delivered by an attack roll (melee touch: BAB + Str mod + size attack bonus; ranged
touch: BAB + Dex mod + size attack bonus) against the target's touch AC — full AC minus
armour, shield and natural-armor bonuses; missing a melee touch cast **holds the charge** on
the caster indefinitely ("you can hold the charge indefinitely"); holding a charge while
casting another spell **dissipates** the held spell; a successful touch runs the spell's
normal resolution; ranged touch attacks resolve as part of the spell and cannot be held.

**Decisions.**

- **Pure layer first** (`src/packages/pf1e/touchSpell.ts`): `resolveTouchAttack` computes the
  bonus and reports hit/miss/natural-20 for the flows to consume — critical *confirmation* is
  deliberately deferred (no second roll yet), so a natural 20 is simply a hit with a flag.
  `PF1eHeldCharge` is the persisted shape: spell name, level, damage formula, save type and
  severity — everything the delivery flow needs to re-run resolution without the original
  prepared row. `heldChargeFromSystem` is null-tolerant and returns `null` for absent or
  malformed blocks.
- **The charge is authored actor state**: `system.pf1e.heldCharge`, validated in
  `parsePF1eActorSystem` like the rest of the spells block. This keeps it replicated, joiner-
  visible and GM-authoritative with no new machinery — the same home the D-155 slot ledger
  uses.
- **Cast-flow integration** (`resolveCastFlow` in `src/ui/sheets/pf1eCastFlow.ts`): a new
  optional `touch` param (`"melee" | "ranged"`) routes touch-range casts through the attack
  branch before the shared effect pipeline. On a melee miss the slot is spent, the charge is
  written, and the card names it; on a ranged miss the spell is lost (ranged touch cannot be
  held). On a hit, the existing damage→SR→save→HP pipeline runs under a touch-attack line —
  the pipeline itself was extracted into a private `runSpellEffect` shared by casting and
  delivery (refactor covered unchanged by all pre-existing flow tests).
- **Dissipation is unconditional and ordered:** any cast first deletes an existing held
  charge (delete op + warning on the card), then proceeds — matching "if you cast another
  spell, the touch spell dissipates."
- **`resolveTouchDelivery` is a separate entry point**, not a cast: it re-reads the freshest
  documents (the charge may have been delivered/dismissed since the sheet rendered), refuses
  on ownership or when the caster's DC for the charge's level is unavailable, rolls the touch
  attack, and on a hit runs the shared pipeline then clears the charge. A miss spends nothing
  and keeps the charge.
- **Sheet UI** (`PF1eActorSheet.svelte`): a touch-mode select in the cast panel, a held-charge
  panel (`data-held-charge`) with Deliver (requires a selected target) and Dismiss buttons;
  handlers re-derive the freshest docs before acting so two open sheets cannot stale-write.

**The store-roundtrip repair (the e2e pass caught it).** Clearing a charge with
`{"system.pf1e.heldCharge": null}` is wrong for this store: `applyDiff` writes the literal
`null` (only the `-=` delete-marker prefix removes keys), and the next `parsePF1eActorSystem`
rejects `heldCharge: null` ("must be an object") — which blanks the actor's *entire* derived
block (casting off, all DCs null, "No slots authored", the Spells tab button vanishes while
stale tab content lingers). The fix is two-layer, both required: `heldChargeDiff(null)` emits
`{"-=system.pf1e.heldCharge": null}` (the repo's delete convention), and the parser treats a
literal `heldCharge: null` as absent. A new regression test runs
write→clear→`applyDiff`→re-parse to pin the round-trip. **Rule of thumb for future slices:**
deletions always use the `-=` marker, and parsers should treat `null` as absent defensively.

**Verification.** 20 new unit tests — 9 in `tests/packages/pf1eTouchSpell.test.ts` (attack
bonus composition, touch AC derivation, miss/hit/nat-20, charge parse tolerances, diff shapes
including the store round-trip) and 11 in `tests/ui/pf1eTouchFlow.test.ts` (touch cast
miss-holds / hit-resolves / ranged-miss-loses, dissipation ordering and warnings, delivery
hit-delivers-and-clears / miss-keeps, ownership and DC refusals, stranger cannot deliver).
Full suite **1453 passed / 3 skipped** across 144 files (+21 over D-157); typecheck and lint
green; touched-file Prettier applied. **Chromium e2e 85/85** (+2) via `e2e/pf1e_touch.spec.ts`:
dissipation is deterministic (authored Chill Touch → cast Magic Missile → warning + panel
gone); the touch-cast test spends the slot, asserts the touch-AC line, then conditionally
delivers or keeps the charge based on the card text (no dice seeding available). dist
**2,217,984 raw / 645,780 gzip** (+11,624 / +2,500 over D-157, within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: critical-threat confirmation on touch
attacks, unarmed/natural-weapon delivery while holding a charge, touching allies (one friend
standard / six friends full-round), multi-charge touch spells (Chill Touch), attacks of
opportunity against ranged-touch casters, multi-round casting, swift/quickened/metamagic
timing, and the remaining Table 9-1 UI triggers.

## D-159 — 2026-09-11 — P5/C03 partial: touch criticals confirm and willing targets auto-touch

**Context.** D-158 shipped touch spells and held charges with the threat *face* reported but
confirmation deferred, and every touch — even onto a willing ally — rode an attack roll. Both
gaps were explicitly documented in the D-158 scope boundaries; this slice closes them.

**Decisions.**

- **R02 first.** Transcribed before encoding: CRB "Critical Hits" (Rules ID 131, "Attack",
  pg. 182) — a natural 20 threatens; confirming is "another attack roll with all the same
  modifiers as the attack roll you just made"; if the confirmation misses the attack is "just a
  regular hit"; threat range 20, multiplier ×2 ("roll your damage more than once ... and add
  the rolls together"); precision and special-ability dice are exempt from multiplication.
  Rules ID 133 supplies the touch-specific limits: criticals only "as long as the spell deals
  damage"; "You can automatically touch one friend or use the spell on yourself"; holding the
  charge, "You can touch one friend as a standard action."
- **Pure layer pins the rulings** (`src/packages/pf1e/touchSpell.ts`):
  `touchCriticalNeedsConfirmation(threat, dealsDamage)` and `criticalDamageTotal(base)` (×2).
  The confirmation computation itself reuses `resolveTouchAttack` — it is exactly "all the same
  modifiers" against the same touch AC, so there is no second attack model to drift.
- **Flow integration** (`pf1eCastFlow.ts`): both the cast-time touch branch and
  `resolveTouchDelivery` roll the confirmation on a hit-threat when the damage formula is
  non-empty; the doubled total enters the shared `runSpellEffect` pipeline (new optional
  `critical` input) before SR/save/energy-resistance composition, so saving-throw reductions
  apply to doubled damage as normal. A damageless threat posts a card note instead of rolling.
  Cards append "CRITICAL HIT (damage doubled)" or "not confirmed (regular hit)".
- **Willing auto-touch**: both flows take an optional `willing` declaration (GM's call, like
  every other table-side declaration in this sheet): no attack roll at all — the outcome
  reports `total: null, auto: true` and the card narrates the automatic touch. This is the
  correct reading of the CRB for allies/self and removes a false failure mode (you cannot miss
  touching a willing friend).
- **Sheet UI**: a "Willing target" checkbox appears in the cast panel whenever a touch mode is
  selected (`data-cast-willing`); the held-charge panel gains an Auto-touch button next to
  Deliver/Dissipate (`data-held-autotouch`), both disabled until a target is selected.
- **Outcome types widened deliberately**: `PF1eCastTouchSummary` (named type shared by all
  three cast-outcome variants) carries nullable `total` plus optional `auto`/`critical`; the
  delivery outcome's delivered variant does the same. Consumers pattern-match, so the widening
  is compile-checked everywhere (the Svelte sheet reads only warnings).

**Verification.** 9 new unit tests — 7 in `tests/ui/pf1eTouchFlow.test.ts` (confirmed critical
doubles the rolled damage; unconfirmed threat is a regular hit; damageless threat rolls no
confirmation; willing cast and willing delivery skip the attack roll, deliver, and clear the
charge) and 2 pure-layer tests (`touchCriticalNeedsConfirmation` truth table; ×2). Full suite
**1462 passed / 3 skipped** across 144 files (+9 over D-158); typecheck and lint green;
touched authored-file Prettier applied (`pf1eCastFlow.ts` predates this authoring and keeps its
existing formatting). **Chromium e2e 86/86** (+1): the new test is fully deterministic — no
dice are in play: the authored Chill Touch charge is auto-touched onto the willing ogre, then a
willing melee-touch cast of Shocking Grasp skips the attack and holds no charge; both cards
assert the automatic-touch narration and the absence of any touch-attack chip. dist
**2,220,480 raw / 646,400 gzip** (+2,500 / +620 over D-158, within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: unarmed/natural-weapon delivery of a held
charge, touching up to six friends as a full-round action, multi-charge touch spells, attacks
of opportunity against ranged-touch casters, multi-round casting, swift/quickened/metamagic
timing (the Quickened Spell text, Rules ID 158, is transcribed-ready for that slice), and the
remaining Table 9-1 UI triggers.

## D-160 — 2026-09-11 — P5/C03 partial: the full Table 9-1 concentration surface in the cast panel

**Context.** D-150 encoded all eleven Table 9-1 concentration situations as pure functions
(`concentration.ts`); D-157 wired the gate into the cast flow with a `declarations` array that
already accepted every situation type. The sheet, however, only exposed two triggers — casting
defensively and injured-while-casting. The remaining eight situations were reachable in tests
but not at any table. This slice is pure UI wiring: **zero new rule encoding**, the same posture
as D-157's gate wiring.

**Decisions.**

- **Eight new GM-declared surfaces** in the cast panel's gate fieldset
  (`PF1eActorSheet.svelte`): a motion select (vigorous DC 10+level / violent DC 15+level /
  extremely violent DC 20+level), a weather select (windy rain or sleet DC 5+level / windy hail
  or dust/debris DC 10+level), an entangled checkbox (DC 15+level), and three checkbox+value
  rows — continuous damage with the damage amount (DC 10 + half + level), a distracting
  non-damaging spell with its DC (DC spell DC + level), and concentrating while grappled or
  pinned with the grappler's CMB (DC 10 + CMB + level). The declaration builder appends each
  enabled situation to the existing `declarations` array; the flow's existing switch turns each
  into a trigger with its own host d20.
- **Mutually exclusive situations stay exclusive in the UI**: motion is one select (you ride
  one mount or earthquake, not several); weather likewise. The free combinations (entangled +
  motion + weather + damage + distraction + grappling simultaneously) remain allowed, matching
  the table's per-distraction structure.
- **No schema, no flow, no pure-layer changes** — the only edited product file is the sheet;
  everything downstream (DC math, single-failure-ruins, slot spent as if cast to no effect,
  named `Spell lost` card) was already tested.

**Verification.** 7 new flow tests in `tests/ui/pf1eCastGate.test.ts`: one per new DC formula
(vigorous fail 9 vs DC 11; violent pass 18 vs DC 16; continuous damage 12 → 16 vs DC 17 fail;
non-damaging spell DC 15 → pass; grappling CMB 12 → 28 vs DC 23 pass; wind+entangled two-die
cast where entangled fails 10 vs DC 16) plus the lost-cast slot-spend assertion. Full suite
**1469 passed / 3 skipped** across 144 files (+7 over D-159); typecheck and lint green;
touched authored-file Prettier applied. **Chromium e2e 87/87** (+1): both directions of the
new surface are deterministic — windy rain/sleet is DC 6 against a worst-case concentration
total of 9 (always passes, spell lands); continuous damage 60 is DC 41 against a best-case 28
(always fails: `concentration failed on continuousDamage … vs DC 41`, slot still spent). dist
**2,223,470 raw / 647,170 gzip** (+2,990 / +770 over D-159, within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: multi-round casting,
swift/quickened/metamagic timing, unarmed/natural-weapon delivery of a held charge, touching
up to six friends as a full-round action, multi-charge touch spells, and attacks of
opportunity against ranged-touch casters.

## D-161 — 2026-09-11 — P5/C03 partial: multi-round casting — begin, disrupt, complete

**Context.** With the gate (D-157), the full Table 9-1 surface (D-160) and the touch half
(D-158/D-159) live, C03's remaining headline was its *timing* half: spells whose casting time
is 1 round or longer. This slice encodes the begin/disrupt/complete lifecycle.

**Decisions.**

- **R02 first.** Transcribed before encoding: Rules ID 147 ("Cast a Spell", full-round action,
  CRB pg. 187) — a 1-round spell is a full-round action; "It comes into effect just before the
  beginning of your turn in the round after you began casting the spell"; "If you lose
  concentration after starting the spell and before it is complete, you lose the spell"; AoOs
  provoke only at the begin. Rules ID 133's Concentration text supplies the spend-at-begin
  ruling: a lost spell "counts against your daily limit of spells even though you did not cast
  it successfully" — the slot and prepared row are therefore spent when the casting **begins**,
  not when it completes.
- **The pending casting rides the actor document** (`system.pf1e.pendingCast`, validated in
  `parsePF1eActorSystem` like its D-158 sibling): spell name/level/slot level, the authored
  effect (damage formula, save type/severity, energy type) and — critically — the `targetId`
  the casting was begun at. New pure module `src/packages/pf1e/pendingCast.ts` with the
  null-tolerant reader and the diff builder. The D-158 round-trip lesson is applied up front:
  `pendingCastDiff(null)` emits the `-=` delete marker, the parser treats a literal `null` as
  absent, and the write→clear→`applyDiff`→re-parse regression test ships with the slice.
- **The cast flow gains a `pending` outcome.** `resolveCastFlow` with `castingTime: "longer"`
  runs the gate normally, spends the slot and prepared row, writes the pending state, posts a
  "begins casting" card, and returns without rolling a single die — the effect is deferred.
  Beginning a second long casting forfeits the first (concentration maintains one spell); the
  existing held-charge dissipation still runs, so beginning any spell consumes a held charge.
  Touch spells refuse the longer casting time by name (out of slice). The outcome union gained
  a fourth ok variant; the other three carry `pending?: undefined` markers and every consumer
  guard was widened compile-checked.
- **Completion and disruption are their own flows.** `resolvePendingCompletion` re-reads the
  freshest documents, refuses when the stored `targetId` no longer matches the presented target
  (the spell lands where it was aimed or is lost — no retargeting), runs the shared
  `runSpellEffect` pipeline with the stored authored data, and clears the pending state.
  `resolvePendingDisruption` resolves the GM-declared interruption damage with one host d20:
  DC 10 + damage + spell level — the same Table 9-1 row as an injured caster — failure loses
  the spell (named card, state cleared, slot already spent), success keeps it pending.
- **Sheet UI**: a pending-cast panel mirrors the held-charge panel — Complete the casting, an
  interruption-damage input with a Concentration check button, and Lose the spell — all
  re-deriving the freshest documents before acting.

**Verification.** 19 new unit tests — 7 pure layer (parse tolerances, diff shapes, the store
round-trip, schema accept/reject including the literal-null-as-absent case) and 12 flow
(begin spends and writes and rolls nothing; replacing forfeits the old pending; held charge
dissipates at begin; touch+longer refused by name; illegal gate refuses before any spend;
completion runs the pipeline at DC and clears; completion refuses absent/mismatched-target/
stranger; disruption fail loses, pass holds, nothing-pending refuses). Full suite **1488 passed
/ 3 skipped** across 146 files (+19 over D-160); typecheck and lint green; touched authored-
file Prettier applied. **Chromium e2e 88/88** (+1): the new test is fully deterministic —
severity-none casts with no damage dice, and the disruption declaration (100 damage → DC 111
vs best-case +8) is unwinnable: Magic Missile begins (slot + prepared row spent, effect
deferred), the check loses it with the slot still spent, then Shield begins and completes at
the original target. dist **2,234,110 raw / 648,810 gzip** (+10,640 / +1,640 over D-160,
within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: swift/quickened/metamagic timing
(Quickened Spell text transcribed-ready), unarmed/natural-weapon delivery of a held charge,
touching up to six friends as a full-round action, multi-charge touch spells, and attacks of
opportunity against ranged-touch casters. Minute-plus castings reuse this machinery as-is (the
GM judges the completion either way); casting while mounted and AoO *resolution* at the begin
(narrated, not resolved) are documented deferrals.

## D-162 — 2026-09-11 — P5/C03 partial: the held-charge consumers — multi-touch charges, six-friend touches, and weapon release

**Context.** With the gate (D-157), Table 9-1 surface (D-160), touch criticals
and willing auto-touch (D-158/D-159) and multi-round casting (D-161) live,
C03's remaining touch half was its *consumers*: what a caster can do with a
held charge besides one touch attack per round. This slice closes three of
the five listed remainders: multi-charge touch spells, touching up to six
friends as a full-round action, and unarmed/natural-weapon delivery.

**Decisions.**

- **R02 first.** Transcribed before encoding, all from the same CRB chapter:
  Rules ID 133 ("Cast a Spell", CRB pg. 183, "Holding the Charge", verbatim):
  "You can touch one friend as a standard action or up to six friends as a
  full-round action. Alternatively, you may make a normal unarmed attack (or
  an attack with a natural weapon) while holding a charge. In this case, you
  aren't considered armed and you provoke attacks of opportunity as normal
  for the attack. If your unarmed attack or natural weapon attack normally
  doesn't provoke attacks of opportunity, neither does this attack. If the
  attack hits, you deal normal damage for your unarmed attack or natural
  weapon and the spell discharges. If the attack misses, you are still
  holding the charge." Rules ID 229 ("Duration", CRB pg. 215): "Some touch
  spells allow you to touch multiple targets as part of the spell. You can't
  hold the charge of such a spell; you must touch all targets of the spell in
  the same round that you finish casting the spell." And the spell that
  motivates multi-charge bookkeeping — Chill Touch (CRB pg. 255): "You can
  use this melee touch attack up to one time per level."
- **Charges are persisted actor state, like the charge itself.**
  `PF1eHeldCharge` gains optional `charges` (integer 1–50; the cap is an
  authoring bound, not a rule — spell counts scale with caster level). The
  schema names the error for anything else; the reader treats a malformed
  count as the single-charge default rather than rejecting the actor. The
  write→clear→`applyDiff`→re-parse round-trip regression ships with the
  slice, per the D-158 lesson.
- **Every successful delivery consumes exactly one charge** — touch attack
  (`resolveTouchDelivery`), willing auto-touch, ally touch, or weapon
  release. `consumeHeldCharge`/`consumeHeldCharges` are the pure arithmetic;
  a multi-charge spell keeps holding `charges − n` (the card narrates
  "Charges remaining"), the last one clears the path with the `−=` marker.
  Misses spend nothing. `resolveCastFlow` gained a `charges` param, refused
  by name for ranged-touch and non-touch casts before any die rolls.
- **The six-friend flow is its own entry point**
  (`resolveChargeAllyTouches`): 1–6 willing targets (named refusals for
  zero, more than six, duplicates, more allies than charges, missing DC,
  missing permission), each touched automatically — "You can automatically
  touch one friend" needs no roll — each running the shared
  `runSpellEffect` pipeline in order (own damage roll, SR check and save),
  then one combined charge write and one summary card. One friend as a
  standard action remains the existing `willing` delivery.
- **The weapon release is a NORMAL attack, not a touch attack**
  (`resolveChargeWeaponRelease`): the selected authored line's attack bonus
  against the target's **normal** AC — pinned by a test with an armored
  target where the roll hits touch AC 9 and misses normal AC 13. On a hit
  the weapon deals its normal damage (host roll + static bonus; a natural 20
  threatens and the confirmation doubles the **weapon** damage only — the spell
  resolves once, on its own save/SR terms) and the spell discharges through
  the shared pipeline with a new `skipHpWrite` option, so ONE combined HP
  write applies weapon + spell damage. On a miss the charge is kept. The
  card narrates "not considered armed, provokes as normal" — resolving those
  attacks of opportunity stays with P6's interrupt queue.
- **Sheet wiring** (`PF1eActorSheet.svelte`): the cast panel gains a charges
  input (melee touch only); the held-charge panel shows the delivery count,
  a release-weapon select over the authored attack lines with a "Release
  through attack" button, and the full-round ally touch — a checkbox list of
  PF1e actors plus one button. The panel's stale-state guards are unchanged:
  every flow re-reads the freshest documents before acting.

**Verification.** 24 new unit tests — 6 pure in
`tests/packages/pf1eTouchSpell.test.ts` (multi-charge round-trip, malformed
counts read as the default, single-delivery decrement, bulk consumption,
schema accept/reject, the multi-charge write→clear round-trip) and 18 flow
in `tests/ui/pf1eTouchFlow.test.ts` (cast-miss holds all declared charges;
charges refused for ranged/non-touch and outside 1–50 with nothing spent;
delivery decrements/keeps/clears exactly; misses keep every charge; the
two-ally touch rolls damage+save per ally in order and writes both HP
totals; the last allies fully discharge; the named limits — zero/seven/
duplicate/too-many; no-charge and no-permission refusals; the release's
single combined HP write, normal-AC pinning, confirmed/unconfirmed crits
doubling the weapon only, dice-less lines, multi-charge keeps, malformed
weapon refusals). Full suite **1512 passed / 3 skipped** across 146 files
(+24 over D-161); typecheck and lint green; touched-file Prettier applied.
**Chromium e2e collected, not executed** (+3 in `e2e/pf1e_touch.spec.ts`,
91 unique specs): no browser binaries exist in this environment and the
Playwright CDN is unreachable (D-082/D-119 precedent) — the two die-less
tests (multi-charge decrement, six-friend discharge) are fully
deterministic; the release test branches on its card like the D-158 touch
cast test. dist **2,249,739 raw / 646,914 gzip** (+15,629 / −1,906
recompression over D-161, within the 6 MB budget).

**Scope boundaries.** C03 stays open. Still missing: swift/quickened/
metamagic timing, and attacks of opportunity against ranged-touch casters
(the trigger text — "Ranged touch attacks provoke an attack of opportunity,
even if the spell that causes the attacks was cast defensively", Rules ID
133 — is transcribed-ready; both remain with P6's interrupt queue and the
action ledger). The ID 229 spell-specific "can't hold a multi-target touch
spell" restriction is not modeled as data; it is a GM call on which spells
may be held at all. The weapon release consumes the authored line's derived
bonus; the unarmed-fallback line (no authored attacks) is refused by name
rather than inventing a Medium 1d3 default.

## D-163 — 2026-09-11 — P5/C03 partial: swift and quickened casting ride the turn's swift action

**Context.** D-162 closed three of the five remaining C03 consumers; the
timing half — "swift/quickened/metamagic timing" — was next, with the Rules
ID 158 text already flagged transcribed-ready by D-159. This slice wires it
into the cast flow through the D-131 action ledger.

**Decisions.**

- **R02 first.** Transcribed before encoding, both from CRB pg. 188: Rules
  ID 157 ("Swift Actions") — "You can perform one swift action per turn
  without affecting your ability to perform other actions. ... You can,
  however, perform only one single swift action per turn, regardless of what
  other actions you take"; and Rules ID 158 ("Cast a Quickened Spell") —
  "You can cast a quickened spell (see the Quicken Spell feat), or any spell
  whose casting time is designated as a free or swift action, as a swift
  action. Only one such spell can be cast in any round, and such spells
  don't count toward your normal limit of one spell per round. Casting a
  spell as a swift action doesn't incur an attack of opportunity." The
  Quicken Spell feat body itself (the +4-level slot cost, the
  beyond-full-round exclusion) did not render from AoN this pass; the slot
  cost therefore stays GM-side (the cast panel already picks the slot
  level), and the multi-round exclusion is derived from the transcribed ID
  158 text — a quickened spell comes into effect as a swift action this
  round, so `quickened` + `castingTime: "longer"` is refused by name.
- **The ledger IS the "only one such spell in any round" gate.** A swift- or
  free-time cast, or a GM-declared quickened one, spends the caster
  combatant's per-turn swift action (`flags.pf1e.actions`) through the same
  pure `actionRefusal`/`spendCombatantAction` path the tracker panel uses —
  the refusal names why (swift already used; an off-turn immediate reserved
  it). The spend lands as the CombatPanel's own `combatants` update shape,
  batched with the cast's other ops, so a refused cast spends nothing and
  publishes nothing. Without a linked combatant the usage stays the GM's
  call (no silent invention); effect deny-tokens against the swift spend
  remain the panel's gate.
- **The card narrates the timing**: quickened casts read "cast as a
  quickened swift action — does not provoke attacks of opportunity and does
  not count against the one-spell-per-round limit"; swift/free casts read
  the same note without the quickened clause. The "doesn't count toward the
  one-spell-per-round limit" half is satisfied by construction: the flow
  never touches the ledger's standard slot.
- **Sheet wiring**: a "Quickened" checkbox in the cast panel
  (`data-cast-quickened`); the linked combatant id now rides the cast-flow
  params. Everything else — gate, touch, multi-round, held charges —
  composes with the timing unchanged.

**Verification.** 8 new flow tests in `tests/ui/pf1eSwiftCasting.test.ts`:
the swift cast spends the ledger (and a free-time cast does too — ID 158's
"designated as a free or swift action"); the second swift spell and a
swift-reserved turn are both refused with nothing spent or rolled; the
quickened cast spends and narrates both timing clauses; quickening a
1-round+ casting is refused; no encounter or an unknown combatant casts on
without a ledger write. Full suite **1520 passed / 3 skipped** across 147
files (+8 over D-162); typecheck and lint green; touched-file Prettier
applied. **Chromium e2e collected, not executed** (+1 deterministic test in
`e2e/pf1e_touch.spec.ts`: a die-less quickened cast asserts the timing
narration; 92 unique specs, 276 across projects) — no browser binaries in
this environment, Playwright CDN unreachable (D-082/D-119 precedent). dist
**2,251,235 raw / 647,311 gzip** (+1,496 over D-162, within the 6 MB
budget).

**Scope boundaries.** C03 stays open on its last remainder: attacks of
opportunity against ranged-touch casters — the trigger text ("Ranged touch
attacks provoke an attack of opportunity, even if the spell that causes the
attacks was cast defensively", Rules ID 133) is transcribed; resolution
waits on P06's interrupt queue. Other metamagic feats (the feat bodies
beyond Quicken) are not encoded; the Quicken Spell +4 slot adjustment is
the GM's slot pick until the feat text is transcribed. The tracker panel's
own swift-spend button and the cast flow write the same ledger, so a swift
cast is visible in the budget immediately.

## D-164 — 2026-09-11 — P5/C05 closed: the strategic Fireball is order- and profile-driven end to end

**Context.** D-151 made the strategic Fireball pack-driven for shape, radius,
DC formula and dice, and deleted the scatter deviation — but location, range
and targets were still the fixed demo origin `{x: 10, y: 10}`, and caster
level / key-ability modifier were demo constants. C05 asked for
profile/pack-driven payloads for location, shape, range, radius, CL, DC,
dice and targets. This slice closes the remainder.

**Decisions.**

- **R02 first.** Transcribed before encoding, from AoN Rules ID 227 "Range"
  (CRB pg. 213): "A spell's range is the maximum distance from you that the
  spell's effect can occur, **as well as the maximum distance at which you
  can designate the spell's point of origin.** If any portion of the spell's
  area would extend beyond this range, that area is wasted." — plus the
  standard categories verbatim: **Close** "as far as 25 feet away from you.
  The maximum range increases by 5 feet for every two full caster levels";
  **Medium** "as far as 100 feet + 10 feet per caster level"; **Long** "as
  far as 400 feet + 40 feet per caster level". Fireball's own "Range long
  (400 ft. + 40 ft./level)" was already D-151's four-source CRB p.283
  transcription.
- **Location is order-driven.** The `spell_aoe` custom order's `data` now
  carries `{ x, y }` — the point of origin the GM chose, in feet. Both
  coordinates are required and must be finite; `validateOrder` names the
  error at issue time (`spell_aoe: order data needs finite numeric x and y`)
  and `resolveTurn` refuses a malformed order at resolve time
  (`refusal: "bad_order"`) rather than re-anchoring on a fixed spot. The
  `DEMO_SPELL_ORIGIN` constant is deleted.
- **Range is pack-driven and enforced.** The `massBattle` block gains
  `rangeCategory: "close" | "medium" | "long"` (shipped Fireball: `long`);
  `spellRangeFeet(category, casterLevel)` resolves it with the ID 227
  formulas (close `25 + 5*floor(CL/2)`, medium `100 + 10*CL`, long
  `400 + 40*CL`). The cast is refused with a named `out_of_range` event when
  the point of origin is farther from the casting unit's anchor (first
  living model) than the range — exactly "the maximum distance at which you
  can designate the spell's point of origin"; the limit is inclusive. Area
  cells that extend past range "waste" onto an empty battlefield, so the
  wasted-area clause needs no extra machinery. Personal/touch/unlimited
  ranges have no point of origin to designate and "range expressed in feet"
  spells would need their own field — none ship a `massBattle` block today,
  so the category union covers everything currently authored.
- **CL and the DC's key modifier are profile-driven.** `rawProfileFromUnit`
  now carries `castingStatMod` and `spellPenetration` from unit stats
  (alongside the existing `casterLevel`), so the casting unit's own compiled
  profile supplies caster level (dice scale with it), the DC modifier
  (`spellSaveDc`, same function as the tactical path) and spell penetration.
  Missing stats fall back to the documented compiled defaults in
  `compilePF1eProfile` (CL 1, key modifier +3) — never to a call-site
  constant. The demo constants `DEMO_CASTER_LEVEL` and `DEMO_KEY_ABILITY_MOD`
  are deleted.
- **Targets = the designated point, membership stays spatial.** A fireball's
  area affects every creature in it (CRB p.283 — an Area spell, no Target
  line), so the order's targeting input *is* the point of origin and the
  membership rule stays D-151's distance check — including friendly fire.
  Inventing an enemies-only filter would be a house rule needing a
  DEVIATIONS proposal; none is filed. `validateOrder` already accepts the
  targeting payload, and the emitted spell event reports
  `epicenterX/epicenterY`, `rangeCategory` and `rangeFeet` alongside the
  D-151 parameters so the payload is observable.
- **Refusals are named events, not silent skips.** `resolveTurn` emits
  `spellRefused` with `data.refusal` one of `bad_order`,
  `no_caster_profile`, `no_living_caster`, `pack_issue`, `out_of_range` —
  a GM always sees why a cast did not happen.
- **Spell level stays a named verified constant (`FIREBALL_SPELL_LEVEL = 3`).**
  The pack's `level` table still carries the known CRB-disagreement (5) with
  a mangled key structure; repairing it needs the whole class list verified
  against primary text, which is not done. Nothing reads the table; the DC
  keeps using the D-151-verified 3.
- **Two verified prose repairs in the pack (content, not code):** Fireball's
  free-text `range` field now reads "long (400 ft. + 40 ft./level)" and the
  spurious `target` line ("one creature or object per caster level…") is
  deleted — both fixed against D-151's four-source CRB p.283 transcription
  (the stat block has Range/Area and no Target line). They were inert
  (nothing reads them) but contradicted the payload the sim now enforces.
- **Tests are outcome discriminators, per the D-151 rule.** Reverting each
  fix was verified to break a specific test: the fixed origin (2 tests:
  relocated epicenter targets 1 model instead of 3; boundary cast moves),
  the constant CL (CL 7 ⇒ 7d6/DC 15/680 ft), the range check (690 ft >
  600 ft must refuse; 600 ft exactly must cast), the close-range formula
  ("every two FULL caster levels": CL 3 ⇒ 30 ft, not 40), and the
  deploySeed wiring (DC 17 requires the profile's +4, not the default +3).
  New coverage: 7 tests in `massBattlePf1e.test.ts` (8 total), 4 in
  `pf1eSpellPacks.test.ts` (16 total) incl. the ID-227 formula table, 1 in
  `pf1eDeploySeed.test.ts` (9 total). Pack↔mirror parity asserts
  `rangeCategory: "long"`.
- **Deliberately out of scope:** cone/line area shapes remain the C01b
  named refusal (grid discretization unsettled); LOS/wall checks between
  anchor and epicenter (the strategic layer has no wall data in
  `RulesContext` today); per-unit hit attribution in metrics (M11/P8);
  hero-actor inputs for CL/key modifier (M07 — unit stats are the source
  until P8 wires actors); the inert `level` table repair.

**Alternatives considered.** Enemies-only membership (rejected: house rule
against the Area line; would need a filed deviation). Epicenter clamped to
max range instead of refused (rejected: "the maximum distance at which you
can designate" is a designation limit — clamping would silently retarget the
cast). Spell level from the pack's level table (rejected: known content bug,
mangled keys, and class selection is not modelled at this layer yet).

**Evidence.** 12 new/extended tests; targeted runs green, then mutation-
checked (five reverts, five reds, all restored). Full suite, typecheck,
lint, build, size and `build:systems` green (numbers in the TODO entry).
Prettier per the D-151 rule: the two touched files clean at HEAD
(`spellPacks.ts`, `pf1eSpellPacks.test.ts`) stay prettier-clean; the four
dirty-at-HEAD files keep their native style, so their diffs are semantic
only. `pf1e-mass-battles` remains a reference RulesModule —
not in the app bundle (`dist/index.html` greps 0 for `massBattle`), shipped
via `build:systems`.

## D-165 — 2026-09-11 — P5/C05+: strategic spell hits are attributed per owning unit (M11 piece)

**Context.** D-164 closed C05's payload inputs, but the spell's *outcome* was
still only caster-side: the analytics collector never learned which units
lost models (its advertised `deathsCount` had no event source anywhere), and
the emitted event carried no per-unit breakdown.

**Decisions.**

- **The resolver reports per-model outcomes.** `resolvePF1eAOESpell` adds
  `perModel: { idx, damageDealt, killed, savePassed }[]` alongside
  `affectedModels` — the post-save damage, death and save outcome for every
  model the area reached. The resolver stays unit-agnostic: attribution is
  the caller's job, because only the caller sees `modelRange`.
- **The module attributes per owning unit.** `massBattlePf1e.ts` maps each
  outcome index to its unit and emits `hitsByUnit` on the spell event:
  `{ modelsHit, damageDealt, kills }` per unit, caster included — friendly
  fire is rules-correct for an Area spell, so the caster's own losses appear
  here too. The per-unit breakdown reconstructs the aggregates exactly
  (asserted, not assumed).
- **`deathsCount` finally lands on the dying side.** New
  `PF1eBattleAnalyticsCollector.recordSpellKills(targetUnitId, deaths)`
  increments the advertised-but-never-written `deathsCount` for each unit
  that lost models; `recordSpell` keeps booking `killsCount` on the caster.
  No new summary fields were invented — `modelsHit`/damage-by-target ride
  the event data until the report schema grows them (M11's other fields
  remain their own slices).
- **Evidence:** 3 new tests (analytics ledger, resolver per-model
  reconstruction, module attribution incl. friendly fire); mutation check —
  deleting the `perModel` push breaks both downstream tests (red, restored).

**Alternatives considered.** Giving the resolver a units list and doing the
attribution internally (rejected: it would couple the spatial engine to
strategic document shapes); adding `modelsHit`/`damageTaken` summary fields
(deferred: M11 advertises specific fields and `deathsCount` was the one
this slice could honestly close).

## D-166 — 2026-09-11 — P5/C05+: line of effect — walls now gate strategic spells

**Context.** D-164 noted "no wall data in strategic `RulesContext`" as the
reason LoS was skipped. That note was wrong: `RulesContext.walls`
(`RulesWallsContext`, §0 restriction bits) is populated at every production
construction site (`TurnChannel.rulesCtx`, `rulesContextFromStore`); the
module simply ignored `_ctx`. This slice consumes it.

**Decisions.**

- **R02 basis (already transcribed in D-148's chunk reads, restated from
  CRB p.214 verbatim):** "You must have a clear line of effect to any target
  that you cast a spell on or to any space in which you wish to create an
  effect. **You must have a clear line of effect to the point of origin of
  any spell you cast.** A burst, cone, cylinder, or emanation spell affects
  only an area, creature, or object to which it has line of effect from its
  origin." Line of effect "is canceled by a solid barrier. It's like line of
  sight for ranged weapons, except that it's not blocked by fog, darkness,
  and other factors that limit normal sight" — which the sim authors as
  non-sight walls (§0 bit convention: bit 1 of `restriction` = sight).
- **Shared helper.** `hasLineOfEffect(ax, ay, bx, by, walls)` exported from
  `core/detection.ts`, reusing its proven `segmentsIntersect` and the sight
  bit; the detection grid keeps its cached private copy.
- **Two gates, both named.** (1) Designation: the module refuses a cast
  `no_line_of_effect` when a sight-blocking wall crosses caster-anchor →
  point of origin. (2) Membership: the resolver skips (and reports as
  `modelsBlockedByCover`) any in-area model that has no line of effect from
  the origin — "It can't affect creatures with total cover from its point
  of origin". Absent walls keep the historic open-field behaviour, so every
  pre-existing fixture passes unchanged.
- **Evidence:** 3 new tests (module refusal + clear-shot control, module
  cover skip with per-unit breakdown, resolver-level cover pair); mutation
  checks — deleting either gate breaks its test (red, restored).

**Deliberately out of scope.** The "hole of at least 1 square foot"
exception (would need wall thickness/aperture authoring the sim does not
have); spread-around-corner pathing for Fireball's *spread* keyword
(D-151 already pinned distance-based membership; noted there).

## D-167 — 2026-09-11 — P5/C05+: cone and line areas resolve on the strategic layer

**Context.** C01b refused cone/line *cell discretization* on the tactical
grid — the published templates genuinely disagree there. The strategic
resolver is a different layer: it works in continuous feet, where the shapes
have one unambiguous geometric reading. This slice wires that reading; the
C01b refusal stands untouched for tactical cells.

**Decisions.**

- **R02 first.** Transcribed before encoding, from AoN Rules ID 212 / CRB
  pp.213–214 ("Spell Descriptions", Area): **Cone** — "A cone-shaped spell
  shoots away from you in a quarter-circle in the direction you designate.
  It starts from any corner of your square and widens out as it goes. Most
  cones are either bursts or emanations … and thus won't go around
  corners." **Line** — "A line-shaped spell shoots away from you in a line
  in the direction you designate. It starts from any corner of your square
  and extends to the limit of its range or until it strikes a barrier that
  blocks line of effect. A line-shaped spell affects all creatures in
  squares through which the line passes." Plus the LoE clause quoted in
  D-166 and the burst clause "It can't affect creatures with total cover
  from its point of origin".
- **Continuous membership, hand-derived from the text.** Cone: within the
  length *and* within 45° of the aim (quarter-circle ⇒ `perp ≤ proj`,
  `proj ≥ 0`). Line: projection within `[0, length]`, perpendicular offset
  within half the corridor width (`widthFeet`, default 5 — the published
  5-ft-wide lines). Both originate at the caster: **cones and lines take no
  point of origin**, so the order payload carries `{ dirX, dirY }` for them
  (finite, non-zero) and `{ x, y }` for circles; `validateOrder` and the
  resolve-time refusal both name the requirement per shape. The range
  category and the designation LoE check apply to circles only; a cone/line
  reaches exactly its length, and D-166's origin→model LoE handles the
  "until it strikes a barrier" clause for both.
- **Pack schema.** `massBattle.rangeCategory` becomes circle-only (required
  there, ignored on cone/line — a cone's Range line *is* its length,
  expressed in feet); `massBattle.widthFeet` joins for lines (named content
  bug if missing/invalid). `parsePackSpellOrder` carries both through
  (`rangeCategory: null` / `widthFeet: null` where not applicable). No pack
  file changes: no shipped spell is a cone or line yet — the capability,
  parser and resolver are tested with synthetic entries and an injectable
  `createMassBattlePf1e({ spellEntry })` seam; the mirror and parity test
  are untouched.
- **Friendly fire stands.** The caster's own model sits inside its own
  cone/line (they start at the caster), and the area still affects every
  model in it regardless of faction — asserted in the cone test.
- **Evidence:** 9 new tests (parser: cone/line/width/circle-range cases;
  resolver: cone quarter-circle and line corridor fixtures with in/edge/out
  models each; module: cone cast from the anchor, direction validation at
  issue and resolve); mutation checks — degrading the cone to a circle and
  doubling the corridor width each break their test (red, restored).

**Alternatives considered.** Emitting cone/line from the designated point
instead of the caster (rejected: "shoots away from you … starts from any
corner of your square"); porting the tactical C01b refusal to the strategic
layer (rejected: the refusal exists because *cell counting* is unsettled,
and this layer counts no cells).

## D-168 — 2026-09-11 — P8/M07 piece: leader actors feed the strategic caster inputs

**Context.** M07: "Produce real hero identity and actor inputs:
`leaderTokenId` → actor → profile; populate `RulesContext.leaderActors` at
production construction sites instead of empty maps." Until now every
construction site passed `leaderActors: {}` and the strategic caster used
unit stats only.

**Decisions.**

- **Contract fix, zero-consumer verified first.** `RulesContext.leaderActors`
  is now **keyed by unit id** (value: the leader actor's full document
  JSON). The docstring previously said "key = actorId", but a grep proved
  zero consumers anywhere in `src/` — the module reading it is the first —
  and unit-id keying is what a RulesModule can look up from a `UnitView`
  (units carry `leaderTokenId`, not an actor id). Recorded here because it
  is a §12 contract change.
- **Shared collector.** `collectLeaderActors({ units, tokens, getActor })`
  in `core/rules.ts` resolves unit → leader token → `token.actorId` → actor
  document, skipping silently when any hop is missing. Both production
  sites use it: `TurnChannel.rulesCtx()` and `rulesContextFromStore`
  (client-side validate/forecast context). The e2e hook keeps `{}`.
- **Consumption reuses the tactical derivation — one source of truth.**
  `casterInputsFromLeaderActor(actorJson)` runs `deriveFromDocuments` on the
  actor's `system` and returns `{ casterLevel: spellCasterLevel,
  keyAbilityMod: abilityMods[spellKeyAbility], spellPenetration: authored }`
  — the same numbers the sheet's cast flow uses, so a hero's strategic and
  tactical casts cannot drift. Returns null when the document is missing,
  unparseable, or not a caster (`spellCasterLevel` 0, i.e. no authored
  spells block with a positive CL); the caller then keeps the unit-stats
  profile. **Precedence: leader actor > unit stats > compiled defaults** —
  documented at the call site.
- **Cost, named.** The module now imports `pf1e/actor`, so the shared
  derivation rides into the `pf1e-mass-battles` artifact: rules.js
  59.4 → 117.5 kB. Accepted rather than re-implementing a second actor
  parser (which would be exactly the drift this slice removes). The app
  bundle moves +500 raw bytes (core collector only).
- **Evidence:** 5 new tests (host populate: token→actor→document by unit id,
  non-leader unit excluded; module override CL 9/Int 20 ⇒ 9d6/DC 18/760 ft
  over unit-stats CL 5; non-caster actor falls back; helper unit tests incl.
  garbage and key-ability cases); mutation checks — removing the override
  and the populate each break their test (red, restored).

**Still open for M07 proper:** hero identity beyond casting inputs
(`isHeroUnit` still reads `type: "hero"`/`stats.hero`), the remaining
leader-actor consumers (leadership auras still use a fixed radius/bonus),
and the other five M11 unincremented metric fields beyond `deathsCount`.

## D-169 — 2026-09-11 — P8/M07 piece: hero identity includes the M07 leader-actor binding

**Context.** M07: "Produce real hero identity and actor inputs." D-168 wired
the leader actor's *caster inputs*; the identity half was still missing —
`isHeroUnit` recognized only `type: "hero"` and `stats.hero`, so an ordinary
infantry unit bound to a player's leader actor got none of the hero treatment
(no leadership aura).

**Decisions.**

- **Identity = unit property OR data-path binding.** `isHeroUnit(unit,
  ctx.leaderActors)` is now also true when `unit.id in leaderActors` — the
  M07 data path identifies the hero, exactly like D-168's caster inputs. No
  magic profile id, no token lookup at resolve time; the map is already
  keyed by unit id at the two production construction sites (D-168).
- **Both hero call sites consume it.** The leadership-aura loop and the
  Cleave-overkill path pass `ctx.leaderActors` through, so a bound unit's
  anchor model radiates the aura and its overkill cleaves.

**Evidence.** Test: 2-model infantry unit, no hero markers; with
`leaderActors: { u0: actorDoc }` the non-anchor ally reads Fort/Will +2 (the
aura's morale bonus) while the anchor stays unbuffed; with `{}` neither is
buffed. Mutation check — dropping the `unit.id in leaderActors` clause turns
the test red (restored).

**Still pinned:** aura radius 30 ft / bonus +2 remain fixed defaults — the
Leadership feat text could not be transcribed (AoN FeatDisplay pages serve no
rule body to the fetcher; recorded as a dead end), so authored radius/bonus
stay out of scope until a source exists.

## D-170 — 2026-09-11 — P8/M11 piece: metric sources — defensive-cast AoO wired, dead SR field removed, forecast reports real totals

**Context.** Gap List §Analytics named six metric fields with no production
source: `PF1eCombatMetrics.srBlocked/aooExecuted/aooHits/cmbSuccesses` and
`UnitAnalyticsSummary.deathsCount/damageHealed`. D-165 closed `deathsCount`.
Additionally `generateReport()` had no caller (forecast returned empty rows)
and the CSV export was unquoted.

**Decisions.**

- **`aooExecuted`/`aooHits` now have their real source.** The only AoO path
  in the codebase is the defensive-cast one (`resolvePF1eAoO`, sole caller
  `spells.ts`), which the mass-battle module never armed: it passed neither
  `casterIdx` nor `casterAdjacentEnemies`, and not even the `registry` the
  gate requires — so no cast was ever defensive. Now the module builds the
  threat list itself (living models of other units within 5 ft reach of the
  casting anchor; coordinates are feet, `SpatialGrid.queryPoint` radius is
  feet) and passes `casterIdx` + `casterAdjacentEnemies` + `registry`.
  `resolvePF1eAoO` returns `{ executed, hits, totalDamage }`; a swing counts
  as executed even on a miss, matching the "attack of opportunity taken"
  meaning. This is a behavior change in the rules-correct direction: a
  threatened caster who fails DC 15 + 2×level now actually provokes.
- **Spell metrics carry the counters.** `PF1eSpellMetrics.aooExecuted/
  aooHits` are incremented in the defensive-cast block and rolled into the
  unit ledger by `recordSpell`, so they reach `generateReport` and the CSV.
- **Dead combat-side `srBlocked` removed.** SR never applies to melee
  attacks — the field was initialized and never written. It is deleted from
  `PF1eCombatMetrics` and `recordCombat`. The *summary* field
  `srBlocked` stays: it is fed by the spell side (`recordSpell`), where SR
  genuinely applies.
- **Collector hoisted to module lifetime; forecast answers.** The analytics
  collector is created once in `createMassBattlePf1e`'s closure (not per
  turn), and `forecast()` returns per-army rows and totals from
  `generateReport()` filtered to the army's units. Caveat stated in code:
  accumulation covers one module instance — a SimWorker restart begins a
  fresh ledger.
- **CSV export is actually RFC-4180 now.** The Gap List named it: a comma in
  a unit name corrupted every column after it despite the work plan's
  "RFC-4180" claim. Every field now goes through an encoder that wraps
  fields containing a comma, quote, or line break in double quotes and
  doubles embedded quotes.
- **Refused with reason (kept as fields):** `cmbSuccesses` and
  `damageHealed` have no mass-battle mechanic to source them — mass battles
  resolve neither combat maneuvers nor a healing phase. The fields remain
  initialized; inventing a source would violate "no invented mechanics".

**Evidence.** Deterministic test: caster anchor within 5 ft of an enemy,
CL 1 / key mod −8 so the DC-21 check can never succeed, caster AC 40 so the
provoked swing always misses — asserts `concentrationFailed 1`,
`aooExecuted 1`, `aooHits 0`, spell not interrupted, and forecast rows/data
carrying the same totals; analytics unit test covers the `recordSpell`
rollup; a CSV test proves a unit id with a comma and embedded quotes stays
quoted without corrupting the column count. Mutation checks — dropping the
module's threat wiring and dropping the `recordSpell` rollup each turn tests
red (restored). The shared spell battlefield's nearest enemy moved 12 ft →
16 ft from the caster so pre-defensive-casting tests stay unprovoked; the
D-170 test builds its own adjacent-enemy field.

## D-171 — 2026-09-11 — P5/C05+: Burning Hands ships — a real cone spell in the pack, selectable per order

**Context.** The cone/line machinery (D-167) ran only on a synthetic test
entry; the pack carried no cone spell and the module fired exactly one spell
(the Fireball constant). Gap List: "no real cone/line spell in the pack."

**R02 transcription (aonprd.com/SpellDisplay.aspx?ItemName=Burning%20Hands,
CRB pg. 251).** "Burning Hands … School evocation [fire]; Level … sorcerer 1,
… wizard 1 … Casting Time 1 standard action; Components V, S … Range 15 ft.;
Area cone-shaped burst; Duration instantaneous; Saving Throw Reflex half;
Spell Resistance yes. A cone of searing flame shoots from your fingertips.
Any creature in the area of the flames takes 1d4 points of fire damage per
caster level (maximum 5d4)."

**Decisions.**

- **Pack entry.** `burning-hands` added to `systems/pf1e-core/packs/
  spells.json`: cone, `radiusFeet` 15, 1d4 (`damageDiceSides` 4),
  `dicePerCasterLevel` with `maxDice` 5, Reflex half, `evasion` true
  (Reflex-half spell), SR true, `damageType` fire, no `rangeCategory` — a
  cone starts at the caster, so there is no designated point to range-check
  (CRB pp.213–214, as encoded in D-167).
- **Mirror + parity.** `PF1E_PACK_BURNING_HANDS_MASS_BATTLE` mirrors the
  block (reference system cannot read `systems/**`), asserted against the
  real file by the same parity pattern as Fireball — drift fails a test.
- **Module spell registry.** `PF1E_MASS_SPELLS = { fireball: {entry, level
  3}, "burning-hands": {entry, level 1} }` — levels are the R02-verified CRB
  constants (D-151 precedent: the pack's `level` tables are not read). An
  order selects the spell by id in `data.spell`; absent means `fireball`
  (every existing order unchanged). Shape, payload validation, pack parse,
  DC level and the emitted event (`spellId`) are all per selected spell.
  Unknown ids are refused by name (`unknown_spell`) at both validate and
  resolve time. `opts.spellEntry` now overrides the default spell's entry —
  the existing cone-injection test seam keeps working.

**Evidence.** Parity + parse tests (cone payload, no range category, 1d4 →
2d4 → 5d4 cap at CL ≥ 5); module tests (CL 5 cast: 5d4, DC 15, level 1,
cone from the caster covering caster + one enemy; CL 2 → 2d4; default still
fireball; circle payload on the cone refused; unknown id refused by name at
issue and resolve). Mutation checks — disabling `data.spell` selection and
raising the mirrored cap each turn tests red (restored). Full suite green.

**Flagged, not changed here:** LoE "1 sq. ft. hole" and spread-around-corner
pathing remain refused-with-reason (aperture authoring / D-151 pinned
membership). The `heroBridge` radii flag (`radius / 5`, `1.5` treating feet
as grid cells) was taken up in D-172: it proved a bug fix against the code's
own documented intent, not deviation territory — the old tests pinned
nothing (2 ft / 1 ft probes).

## D-172 — 2026-09-11 — P8/M07 closure: heroBridge radii converged on their documented intent; Leadership feat R02 closes the aura-source question

**Context.** D-170/D-171 flagged `heroBridge`'s spatial queries: the
leadership aura passed `radius / 5` and the cleave adjacency a literal
`1.5`, both assuming `SpatialGrid.queryPoint` takes grid cells — it takes
**feet** (model coordinates are feet; the radius is compared against
feet-squared, as D-170's threat query established). The result: the
documented 30-ft aura reached 6 ft, and "adjacent" cleave reach was 1.5 ft.
Open since D-169: whether the aura radius/bonus could ever come from the
Leadership feat (Gap List §4.12: "aura radius from feat data").

**R02 transcription (d20pfsrd.com/feats/general-feats/leadership, CRB).**
"Leadership … Prerequisite: Character level 7th. Benefits: This feat enables
you to attract a loyal cohort and a number of devoted subordinates who assist
you." The feat defines a Leadership score (level + Cha modifier), a
cohort-level/followers table, and reputation modifiers — **nothing else**.
There is no aura in the SRD Leadership feat, so "aura radius from feat data"
is untranscribable because it does not exist. The mass-battle "Leadership
Aura" (+2 morale to Fort/Will of friendly models within 30 ft) is the work
plan's own mechanic (Task 7 "Player Hero Control: … Leadership Auras",
Combat_Resolver_5 feature parity) — an intentional strategic-layer design,
recorded here rather than as a deviation because the work plan *is* the spec
for Task 7 and no SRD rule is contradicted (the feat simply has nothing to
say about auras).

**Decisions.**

- **Bug fix, not deviation: converge on documented intent.** The code's own
  docstrings say "default 30ft" (aura) and "Query adjacent models within 5ft
  reach" (cleave); the implementation contradicted both. The aura now passes
  `radius` unconverted, and cleave queries 5 ft. Radius/bonus stay the
  work-plan defaults (30 ft / +2) — there is no authorable source for them
  in the SRD.
- **Tests now pin the real geometry.** The old probes (ally at 2 ft, cleave
  target at 1 ft) passed at any radius ≥ 2 ft and therefore pinned nothing;
  the suite now asserts an ally at 20 ft buffed, one exactly at 30 ft
  buffed (the edge is inclusive), one at 31 ft excluded, cleave reaching a
  model 4 ft away and stopping before one at 7 ft. Mutation checks —
  restoring `radius / 5` and `1.5` respectively — each red the suite
  (restored).

**Known wrong, deliberately untouched (future slice):** the module's cleave
call still passes a literal `damageDealt: 25` and the overkill-cascade model
itself was rejected as a non-rule in D-130 (SRD Cleave is one extra attack
at full BAB against an adjacent foe, not carried-over damage). Replacing it
needs a hero attack routine and interacts with P06's interrupt/attack
infrastructure — Gap List §5 holds the requirement.

## D-173 — 2026-09-12 — P4/M05 first slice: move orders execute — formations march within a pace-scaled budget

**Context.** Gap List §5: "PF1e `resolveTurn` has no move/shoot/morale
sub-phase at all (subPhases are declared but unused) — orders other than
`attack`/`custom:spell_aoe` do nothing." Move orders were accepted by
`validateOrder` and then silently dropped. M05's full scope (terrain,
charge/withdraw semantics, shoot, morale, movement-triggered AoOs) is a
multi-slice item; this slice makes movement itself real.

**R02 (d20pfsrd "Combat", CRB; cross-checked legacy.aonprd.com CRB combat).**
Speed: "If you use two move actions in a round (sometimes called a 'double
move' action), you can move up to double your speed. If you spend the entire
round running, you can move up to quadruple your speed (or triple if you are
in heavy armor)." Run: "You can run as a full-round action. … When you run,
you can move up to four times your speed in a straight line." Charge:
"Charging is a special full-round action that allows you to move up to twice
your speed and attack during the action."

**Decisions.**

- **Formation movement, mirroring the §12 reference package.** The anchor
  (first living model) walks the ordered waypoint path up to the movement
  budget; every other living model is translated by the same delta, so
  spacing and unit membership survive intact. Dead models stay where they
  fell; a unit with no living models emits nothing. The turn's single order
  already guarantees a unit moves OR attacks/casts, never both.
- **Pace → distance from the SRD.** `march` = 1× (the round's move),
  `charge` = 2× ("up to twice your speed"), `run` = 4× ("up to four times
  your speed"). Charge's attack requirements and Run's straight-line/armor
  clauses are combat-mechanic concerns deferred to later M05 slices with the
  distances recorded here; this slice executes only the distances.
- **Budget is scene-metadata-driven (P01's direction).** Move points ×
  `ctx.grid.distance` feet per cell — the scene grid supplies the cell size
  rather than a hard-coded 5. The move-point values themselves are the
  schema's own mass-battle abstraction (work-plan unit types), not SRD
  speeds; the schema is the module's content.
- **Phase ordering.** Movement runs before `grid.rebuild`, so every spatial
  consumer of the same turn (auras, cleave adjacency, envelopment, spell
  threats and ranges) sees post-move positions. `validateOrder` also
  rejects NaN waypoints by name now.

**Slice boundary (recorded, not silently skipped):** no terrain cost or
wall/obstacle legality (P03 scope), no charge straight-line/target rules,
no movement-triggered AoOs (P06), no `retreat` execution, no shoot or
morale sub-phases — all still named in M05.

**Evidence.** Tests: infantry 4 pts × 5 ft stops at 20 ft on a long path
with formation spacing preserved and an un-ordered unit untouched; cavalry
march/charge/run land exactly at 40/80/160 ft; a waypoint consumes the
whole budget at its exact point; dead models are left behind and an
all-dead unit never emits; NaN waypoints refused at issue. Mutation checks
— flattening all pace multipliers to 1 and letting dead models translate —
each red the suite (restored). Full suite 1564 passed / 3 skipped; rules.js
127,268 B (+2.5 kB for the move phase).

## D-174 — 2026-09-12 — P4/M05: movement cannot pass through movement-blocking walls

**Context.** D-173 made move orders real — and thereby let formations march
through walls the scene authors as movement-blocking. The §0 wall contract
(`RulesWallsContext`: bit i of `restriction` = move|sight|sound|light) was
already honored for sight (LOS/detection, spell line of effect); bit 0 had
no consumer. Full movement *legality* (terrain cost, pathfinding, occupied
squares) remains P03's scope; this slice enforces the hard walls the scene
already authors.

**Decisions.**

- **`core/detection.ts` owns the wall geometry.** New `WALL_MOVE_BIT`
  (1<<0) and `firstMoveBlock(ax, ay, bx, by, walls)`: the earliest crossing
  of a segment with any movement-blocking wall, as a fraction t ∈ (0,1)
  along the segment, or null when clear. Same strict-crossing convention as
  the LOS test (grazing a wall endpoint does not block; parallel segments
  never cross), so wall behavior is consistent across sight and movement.
- **The move loop clips each leg at the first blocking wall.** The
  formation stops `MOVE_BLOCK_EPSILON` (0.001 ft) short of the wall — the
  epsilon matters: the strict crossing test excludes t = 0, so stopping
  exactly on the wall would let next turn's segment start *on* it and pass
  through. The remaining budget is spent (the unit already acted) and later
  waypoints are not attempted — they lie beyond the wall, and routing
  around obstacles is pathfinding (P03), not wall-clipping. The event
  reports `blockedByWall: true` and the distance actually traveled
  (accumulated steps; identical to the D-173 budget-spent figure whenever
  no wall intervenes, so the earlier tests are unchanged). A zero-distance
  block — a wall exactly in front — still emits, so a GM sees the march go
  nowhere instead of hearing nothing.
- **Sight-only walls never block movement.** Bit 1 restricts sight; the
  distinction is pinned by test rather than assumed.

**Evidence.** Tests: infantry marching 10→90 ft stops at 24.999 when a
move-blocking wall stands at x=25 (distance 15, `blockedByWall`); the same
wall authored sight-only lets the full 20-ft budget land; a wall past the
first waypoint clips the second leg at 21.999 and the third waypoint is
never attempted. Mutation checks — disabling the clip entirely and swapping
the restriction bit to sight — each red the suite (restored). Full suite
1566 passed / 3 skipped; rules.js 129,030 B.

**Process note.** Mid-slice, a `git checkout` of `detection.ts` reverted
the file to HEAD and silently discarded this session's uncommitted D-166
additions (`hasLineOfEffect`), breaking 17 tests before the cause was
spotted. The file was reconstructed from the session's own transcripts and
re-verified by the D-166 tests. Lesson recorded: never `git checkout`
files with uncommitted session work; mutation restores use file backups.

## D-175 — 2026-09-12 — P4/M05: retreat orders execute — SRD Withdraw, double speed toward the rally point

**Decision.** The last previously no-op mass-battle order kind, `retreat`, now moves the unit toward `order.toward` with a **double-speed** travel budget — the SRD Withdraw action.

**R02 transcription (SRD "Withdraw").** d20pfsrd.com/Gamemastering/Combat:

> "Withdrawing from melee combat is a full-round action. When you withdraw, you can move up to double your speed. The square you start out in is not considered threatened by any opponent you can see, and therefore visible enemies do not get attacks of opportunity against you when you move from that square."

**Implementation notes.**
- `validateOrder` now rejects `retreat` with NaN/missing `toward` coordinates (previously unvalidated); `move` keeps its NaN-rejection.
- Retreat reuses the D-173/174 movement machinery with `paceMul = 2` (infantry 40 ft): path = `[order.toward]`, wall clipping (`firstMoveBlock`, `MOVE_BLOCK_EPSILON`), full unit translation, same `arrive` event with `pace: "retreat"` and event verb "retreats". No facing write (no orientation semantics for retreat).
- Retreat's AoO immunity on leaving the starting square is deliberately **not** modeled — mass battle has no AoO economy yet (P06). Charge/run movement restrictions and terrain costs likewise remain M05 remainder.

**Verification.** Tests (module suite 29 passed): retreat reaches a rally point 40 ft away (full double budget, pace "retreat", formation intact); rally point nearer than budget stops at it; a blocking wall shortens retreat (blockedByWall); `validateOrder` NaN rejection. Mutation (paceMul 2→1) red. Full gates: 1568 passed / 3 skipped (148 files); typecheck/lint/build clean; dist/index.html 2,251,732 B (gzip 644,927 B); systems/pf1e-mass-battles/rules.js 129,487 B; e2e collects 276 tests / 36 files.

## D-176 — 2026-09-12 — P4/M06 first slice: fast healing & regeneration execute in mass battle turns

**Decision.** The mass-battle module now runs a once-per-turn **heal sub-phase**: units whose profiles carry SRD fast healing or regeneration heal the listed amount each turn, booked into analytics and emitted as events. This consumes the previously dead `resolvePF1eHealing` engine (which only ran in a test) and the declared-but-never-incremented `damageHealed` counter.

**R02 transcription (SRD Universal Monster Rules).** d20pfsrd/starjammer-compatible SRD text:

> **Fast Healing (Ex)** — "The creature regains the listed number of Hit Points at the start of its turn. Unless otherwise noted, the creature can never exceed its maximum Hit Points. … Fast healing continues to function until a creature dies, at which point the effects of fast healing end immediately."
> **Regeneration (Ex)** — "The creature regains Hit Points at the start of its turn, as with fast healing, but it can't die as long as its regeneration is still functioning…"

**Implementation notes.**
- `rawProfileFromUnit` now carries `fastHealing` / `regeneration` unit-stat numbers into the compiled profile (clamped ≥ 0, floored), so armies can author both abilities; pre-created profiles (e.g. the troll with `regenerationVal: 5`) already had the field.
- Placement: immediately after `seedPF1ePool` — the first moment the pool carries interned profile indices — and before melee/spell damage, so healed hit points enter the round's exchanges. Only living models heal (SRD: ends at death); healing is capped at the effective maximum (`hpMax − lethalDmg`).
- Events: `{ subPhase: "heal", type: "heal", data: { healed, revived } }`, emitted only when a unit actually healed; `"heal"` added to the module's declared `subPhases` between "move" and "shoot" (matching execution order; all consumers treat subPhases as opaque strings). `analytics.recordHealing` finally has a caller. Regeneration's suppress-damage-types, can't-die clause and reviving-unconscious-models semantics are tactical-layer concerns (`resolvePF1eHealing` already models the lethal-damage cap); suppression by fire/acid damage types is not representable at the strategic layer yet.
- SRD's "at the start of its turn" is honored as once-per-turn before any damage resolution; the module has no initiative-granular ordering within a round.

**Verification.** Tests: fast healing heals 3 (11→14) and caps at max (20 stays 20); regeneration 5 with lethal damage 5 caps at the effective max (10→15); ability-less units and dead models never heal (no event); `rawProfileFromUnit` carriage incl. clamp/floor. Mutations (heal step disabled; carriage dropped) each red; restores byte-identical via backups. Two existing subPhase-list assertions updated for the new phase. Full gates: **1571 passed / 3 skipped** (148 files); typecheck/lint/build clean; dist/index.html 2,251,732 B (gzip 644,927 B); rules.js **131,975 B**; e2e collects 276 tests / 36 files.

## D-177 — 2026-09-12 — P4/M04+P01 slice: envelopment reach is feet, and FLANKED expires each round

**Decision.** Two Gap List §5 defects in the envelopment engine are fixed: the reach constant's unit error and the never-expiring FLANKED bit.

**R02 transcription (SRD Combat).** "Most creatures of Medium or smaller size have a reach of only 5 feet. This means that they can make melee attacks only against creatures up to 5 feet (1 square) away" (d20pfsrd Combat, Reach Weapons); a creature threatens "all squares adjacent to your space".

**Fixes.**
- `calculatePF1eEnvelopment`'s default `reach` was `1.5` passed into `SpatialGrid.queryPoint`, which takes **feet** — a 1.5-ft radius that engaged almost nothing (the inherited unit error Gap List §5 / P01 name). The default is now **5 ft**, the SRD natural reach of a Medium creature; `queryPoint` is radius-inclusive, so an adjacent square's center at exactly 5 ft engages while 6 ft does not. Per-size reach, reach weapons and flanking angles remain P02 scope.
- The mass-battle melee call site passes `reach: cellFeet` — the scene's authored `grid.distance` (fallback 5) — the same scene-derived value the movement budget uses (P01: scene metadata, not constants).
- `PF1E_STATUS_FLANKED` (bit 2) was set on enveloped defenders and never cleared, so a single envelopment lasted the rest of the battle (Gap List §5: "sets the bit and never expires it"). `resolveTurn` now clears the bit across the pool first thing each round; the melee sub-phase recomputes it from current geometry after movement. The bit-2 alias with core `ModelStatus.pinned` is the documented §2.13 status-column collision, untouched by this slice.

**Verification.** Envelopment suite rewritten around feet semantics (5 ft engages, 6 ft does not; enveloped defenders carry the bit). New module test: two attackers 3 ft from a defender ⇒ FLANKED after round 1; attackers beyond reach ⇒ bit expired after round 2. Mutations (default reach back to 1.5; clear disabled) each red; restores byte-identical via backups. Full gates: **1574 passed / 3 skipped** (148 files); typecheck/lint/build clean; dist/index.html 2,251,732 B (gzip 644,927 B); rules.js **132,127 B**; e2e collects 276 tests / 36 files.

## D-178 — 2026-09-12 — P4/M07 closure piece: hero Cleave is now one real extra attack — the overkill cascade is deleted

**Decision.** The mass-battle hero cleave no longer force-kills a model and splashes literal damage. It is now the SRD Cleave feat resolved as a real attack: one extra melee attack at full BAB against an adjacent enemy. The rejected overkill-cascade model (D-130, Gap List §5, flagged again in D-172/M07) is deleted from the codebase.

**What was wrong.** `applyHeroCleaveOverkill` ran once per hero unit per engagement with a literal `damageDealt: 25`: it set `defenders[0]` to 0 hp and the dead bit *unconditionally* (outside any attack roll), then carried "excess" damage into adjacent enemies — a mass-battle rule that exists nowhere in the SRD and a steady one free kill per hero per turn.

**Fix.**
- SRD Cleave (R02, d20pfsrd Cleave feat): "Benefit: Once per round, when you make a melee attack, you can make one additional attack at your full attack bonus against a creature adjacent to you. Normal: You can only make one additional attack per round with the Cleave feat. Penalty: You take a −2 penalty to your Armor Class until your next turn when using Cleave." Both clauses are implemented: the extra attack, and the −2 AC applied to the hero model's `ac` column when the cleave swings. Because seeding rewrites `ac` from the profile at the start of every round, the penalty is naturally wiped before the hero's next round — enemy units resolved later in the same round attack against the reduced AC. This completes the R03 resolution text ("SRD Cleave = second attack at full BAB vs an adjacent foe, −2 AC").
- `resolvePF1eAttacks` gains `maxIterativeAttacks?` so a caller can cap how many of an attacker's BAB iterative swings actually land — the cleave passes `1`, so a BAB 9 hero swings exactly one extra attack, not a second full routine. The name is deliberately about the iterative routine only, not effects outside it (Haste's extra attack, Vital Strike's damage dice).
- The melee call site: the hero's lead model (`attackers[0]`) cleaves the first living defender model within `cellFeet` (scene grid distance, feet — D-177's reach source; `queryPoint` already excludes dead/hidden). Cleave metrics merge into the engagement's `combatRes.metrics` before `recordCombat` and the melee event, so analytics and the GM-facing event carry the combined totals. RNG rides a fresh per-unit fork (`phase 3`), keeping seeded turns replayable.
- Gating stays `isHeroUnit` (unit type / stats.hero / leader-actor binding) until actor feat data exists — same gate as the leadership aura; documented in the code.
- `applyHeroCleaveOverkill`, its option/result types and its unit test are removed; `heroBridge.ts` keeps the leadership aura only.

**Verification.** New module test pins the rule with a BAB-9 probe (normal routine iterates twice): hero adjacent ⇒ 3 total attacks and the hero's AC drops to 12 (the −2 penalty); non-hero ⇒ 2 attacks, AC 14; hero with the defender 30 ft away ⇒ 2 attacks, AC 14 (adjacency requirement, no penalty). Mutation (attack cap removed ⇒ cleave would grant a full second iterative) red; restore byte-identical via backup. Full gates: **1574 passed / 3 skipped** (148 files; +1 test, −1 deleted cascade test); typecheck/lint/build clean; dist/index.html 2,251,732 B (gzip 644,927 B); rules.js **131,585 B** (down from 132,127 — the deleted cascade was larger than its replacement); e2e collects 276 tests / 36 files.

## D-179 — 2026-09-12 — Executed Chromium acceptance at 92/92: one real §8 restore race fixed, three spec defects repaired

**Context.** The whole collected suite was executed on Chromium at its current
size — **92/92, twice** (276 tests / 36 files across the three projects; D-153's
pass was 74/74 before D-154…D-178 added 18 specs). Same browser route as D-153:
`@sparticuz/chromium@152.0.0` (npm) → Chromium 152.0.7977.0 with the `al2023`
libraries on `LD_LIBRARY_PATH`, driven through the documented
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override; the Playwright CDN is still
unreachable and no security-bypass flags are added. The first run was 89/92, and
the three failures plus one intermittent fourth were all worth more than a
green tick: one was a **real product race** the Node suite could not reach.

**Product fix — `HostApp.close()` fire-and-forgot the persister's final flush.**
§8 persistence batches document writes (~500 ms) and `HostPersister.close()`
runs one FINAL flush (`await this.flushing; await this.flush()`). `hostBoot`'s
`close()` discarded it (`void persister.close()`) and returned `void`, while
`App.importWorld` immediately replaced every world row with the archive's and
reloaded. A document dirtied after the export could therefore commit AFTER the
restore's `delete(range)` + `put(docs)` transaction — and because tokens are
embedded in the scene document, the drifted scene (3 tokens) was written back
over the restored one (2), with `worlds.flushedSeq` drifted too. The reload then
booted a world the archive never contained.

- **Fix:** `close(): Promise<void>` that awaits `persister.close()`; `importWorld`
  awaits it before `importWorldZip`; `Root.svelte`'s teardown-only path keeps the
  fire-and-forget form but says so explicitly (`void app?.close()`). 19 test call
  sites now await. Teardown semantics are unchanged — only awaitable.
- **Why Node never saw it:** `tests/host/worldFile.test.ts`'s restore test calls
  `await drifted.persister.flush()` before closing, so the dirty-write window was
  never open. The browser opened it by clicking "add token" and importing
  immediately. Observed as `worldfile.spec.ts` polling tokenCount 2 and timing
  out on 3 — intermittently, only under 2-worker load.

**Spec repairs (all three written against assumptions, never executed).**

1. **`pf1e_touch` ally picks keyed on ids that cannot exist.** The D-162
   full-round-touch spec selected `[data-ally-touch-pick="pf-ogre"]`, but that
   attribute carries the imported **actor `_id`** (`importEntryOp` mints
   `actor-<hash>`) — a compendium entry carries no `_id` by contract (D-090), so
   the locator could never match and the test timed out at 30 s while the
   checkboxes were visibly rendered. Now picks by visible label and asserts
   exactly one pick row per ally.
2. **`pf1e_touch` weapon release — two defects plus a wrong discriminator.**
   (a) It read `#chat-log` once immediately after the click, but the card is a
   `create` op submitted only after the attack roll replicates. (b) Its miss
   branch matched `release miss` — the card's *name* — and `#chat-log` renders
   `content`, never `name`, so a miss could never pass however long it waited.
   (c) It expected the held-charge panel to disappear on a hit, but this fixture
   holds TWO charges: a hit leaves one (and the plural "N deliveries" element
   renders only above 1), a miss leaves two — both keep the panel. A shared
   `chatAfter(page, waitFor, occurrences)` helper now waits on the accumulated
   log (occurrence form because the discharging delivery card has no unique text
   at all — `pf1eCastFlow.ts:1461` appends "Charges remaining" only when a charge
   survives), the branch is read from rendered content, and the state assertion
   is `[data-held-charge]` count 1 + `[data-held-charges]` count `released ? 0 : 1`.
   The same helper replaced **all nine** single-snapshot log reads in the file,
   including the one that had already flaked twice under parallel workers.
3. **`dice3d` demanded a capability the environment does not have.** It asserted
   `settled >= 1`, which requires a WebGL context; `showDice3D` returns
   immediately when `new WebGLRenderer()` cannot get one ("chat never blocks") —
   the documented degradation, and the correct product behaviour. This Chromium
   build has no WebGL at all (`webgl` and `webgl2` both null, unchanged by
   `--enable-unsafe-swiftshader --use-angle=swiftshader`). The spec now probes
   the same capability the product checks and, when it is absent, asserts the
   degradation path for real instead of skipping: `loads`/`rolls` incremented,
   `settled === 0`, `disposed === false`, the determined values still recorded
   (3 dice, total intact — they are captured before the renderer is attempted),
   no `[data-dice3d-canvas]` in the DOM, and the chat card's rendered total equal
   to the overlay's `lastTotal`, which is §11's "the animation never chooses the
   outcome" verified with no animation at all. On a WebGL-capable browser the
   original settle/dispose assertions run unchanged.

**Verification.** Mutation checks, all red, all restored from file backups (the
D-174 lesson): `void persister.close()` restored → the new Node test fails
`expected [ 't-1', 't-2' ] to deeply equal [ 't-1', 't-2', 't-3' ]`; `released`
inverted → the release spec fails, so the charge-count assertion is load-bearing;
`expect(degraded.settled).toBe(1)` → dice3d fails Expected 1 / Received 0, which
proves the degradation branch executes rather than passing vacuously. New Node
test `tests/host/worldFile.test.ts` → "close() settles the final flush before a
restore replaces the rows": the drift is left dirty, `close()` is awaited, and the
**documents store is read directly** — a re-boot would replay the oplog tail and
hide the difference — before the restore lands back on the export point.

**Evidence.** Unit **1575 passed / 3 skipped** across 148 files (+1); typecheck
and lint green; `e2e/pf1e_touch.spec.ts` Prettier-clean (clean at HEAD, so it
stays; every other touched file was dirty at HEAD and keeps its native style per
the D-151 rule, diffs semantic only); build **2,251,755 raw / 647,474 gzip**
(+23 B, budget 6 MB); `build:systems` unchanged (`rules.js` 131,588 B — no rules
touched); Chromium e2e **92/92 twice**, `--repeat-each=8` on
worldfile+touch+dice3d **72/72**, `--repeat-each=20` on the random-branch release
spec **20/20**. **Still open:** the Firefox/WebKit matrix (Playwright CDN and
Debian mirrors unreachable — D-082/D-119/D-153 precedent), so N01/N02 and
S01/S04 stay unchecked. C03 stays unchecked for its one remaining consumer (AoO
against ranged-touch casters, which rides P06's interrupt queue) — but its D-162
browser specs now execute green rather than merely collecting.

## D-180 — 2026-09-12 — P6/P02 first slice: space/reach/threat geometry lands, and the strategic battle reads a unit's own reach

**Decision.** P02's geometry is now a pure layer — `src/packages/pf1e/geometry.ts` — with a live consumer: the mass-battle module derives each unit's natural reach from its bound leader actor's size instead of assuming one grid cell for everybody, and the tactical derivation authors Table 8-4's tall/long body form. The canvas threatened-square overlay (Gap List §4.5's `src/canvas/layers/*`) and a tactical-scale consumer follow, on the D-148→D-154 staging (pure layer first, preview seam and overlay second). **P02 stays unchecked** with three named remainders, listed under Evidence.

**R02 transcription (re-verified 2026-09-12 against Archives of Nethys; quoted in full at the head of `geometry.ts`).**
- **AoN 179** (CRB p.194, "Big and Little Creatures in Combat" + Table 8-4): "Creatures that take up less than 1 square of space typically have a natural reach of 0 feet, meaning they can't reach into adjacent squares. They must enter an opponent's square to attack in melee. This provokes an attack of opportunity from the opponent. … Since they have no natural reach, they do not threaten the squares around them. You can move past them without provoking attacks of opportunity. They also can't flank an enemy." / "Unlike when someone uses a reach weapon, a creature with greater than normal natural reach (more than 5 feet) still threatens squares adjacent to it." / "Large or larger creatures using reach weapons can strike up to double their natural reach but can't strike at their natural reach or less." Table 8-4 prints **two** natural-reach columns for the four multi-square sizes — Large 10/5, Huge 15/10, Gargantuan 20/15, Colossal 30/20 — and one figure each for Fine through Medium, so body shape is only ever a question for Large and larger.
- **AoN 102** (CRB p.180): "You threaten all squares into which you can make a melee attack, even when it is not your turn. Generally, that means everything in all squares adjacent to your space (including diagonally)." Plus "Small and Medium creatures wielding reach weapons threaten more squares than a typical creature."
- **AoN 131** (CRB p.182): "With a typical reach weapon, you can strike opponents 10 feet away, but you can't strike adjacent foes (those within 5 feet)" — the Small/Medium half of the band AoN 179 states for Large+, so `reachWeaponBand` is **one** rule, `(natural, 2 × natural]`, not two.
- **AoN 175** (CRB p.192): "distance is measured assuming that 1 square equals 5 feet", and "the first diagonal counts as 1 square, the second counts as 2 squares, the third counts as 1, the fourth as 2, and so on" — pinned as `PF1E_DISTANCE_DIAGONALS = "5105"`, deliberately **not** the scene's `diagonals` ruler setting, for the reason D-148 recorded for spell areas: the scene owns the scale, the rules own the counting. This is what makes a Medium reach weapon threaten exactly **12** squares (four 10-ft orthogonal, eight knight's-move) and *not* the four diagonal corners, which 5-10-5 puts at 15 ft.
- **AoN 176** (CRB p.193): "A Fine, Diminutive, or Tiny creature can move into or through an occupied square. The creature provokes attacks of opportunity when doing so." Read as an occupancy fact only — the movement legality around it is P03's.

**Two data bugs the re-verification found, both fixed and pinned by tests.**
1. **A.5's transcription had Fine at "1½ ft".** Table 8-4 prints **½ ft**, and `rulesTables.ts` had faithfully encoded the typo (`spaceFeet: 1.5`), which the actor readout then printed as "1.5 ft space". Corrected to `0.5`, and the Gap List's A.5 text is fixed with a re-verification note — the A.6 precedent for a transcription that a later read proved wrong.
2. **Colossal's square columns were one short.** `spaceSquares: 25` / `reachSquares: 5` continue a "+1 per category" ladder (Large 2, Huge 3, Gargantuan 4, Colossal 5) that Table 8-4 does not support: Colossal is 30 ft across and reaches 30 ft, which is **6** squares on a side (36 occupied) and **6** squares of reach. So a Colossal creature had a 25-ft space and 25-ft reach instead of 30/30 — and because every per-attack `reachSquares` default and `meleeReachLegality`'s caller-supplied reach read that column, it could not strike a target the table says it reaches. Both columns are now derived from the table's own feet ÷ 5, with the division documented in the field so the ladder is not re-guessed by eye.

**What landed.**
- **`geometry.ts`** (pure, no Pixi/scene/document access): `naturalReachSquares`/`naturalReachFt` (both Table 8-4 columns), `normalizeReachShape`, `footprintSide`/`footprintCells` (1×1 to Medium — a sub-square creature still occupies the one square it is in, since a footprint of zero cells could never be located — then 2×2, 3×3, 4×4, 6×6), `squareDistance`/`squareDistanceFt` (5-10-5), `footprintDistance`/`footprintDistanceFt` (nearest occupied square, **0 when two spaces share a square** — the Tiny-creature-inside-its-target's-square case `meleeReachLegality` resolves at distance 0; `+Infinity` for an empty footprint rather than a guessed number), `reachWeaponBand`, `threatenedCells`, and `occupancy` (Table 8-4's sub-square facts read from A.5, never restated). A creature's own squares are never threatened — its space is not a square *adjacent* to its space — and striking into your own square is legality, not threat.
- **`rulesTables.ts`**: Table 8-4's long column transcribed as `longReachSquares` (Large 1, Huge 2, Gargantuan 3, Colossal 4; **null** for Fine through Medium, which print one figure — null, never a copy of the first).
- **`actor.ts`**: `system.pf1e.reachShape` is authored, validated (`parsePF1eActorSystem` rejects a third value by name) and derived: `PF1eDerived.reachShape` + `reachFeet`, which is the producer `meleeReachLegality`'s "caller-derived from A.5's space/reach table" comment asked for. Tall is the default because it is the column the table prints first and because "these values are typical"; a shape authored on a size with one printed figure is **reported** ("does not apply to a Medium creature") and changes nothing, rather than silently shortening its reach. Per-attack `reachSquares` defaults now read the shape, an authored per-attack reach still outranks it, and the readout prints feet ("10 ft space, 5 ft natural reach (long)") instead of a unitless square count.
- **`massBattlePf1e.ts`**: `reachSquaresFromLeaderActor` reads the size through the existing M07 seam (`ctx.leaderActors`, keyed by unit id). Envelopment now passes the **attacking** unit's own reach, so a Large unit contacts the rank two squares out instead of stopping one model short; and the caster-threat query — which hard-coded `5` — now asks each enemy at **its own** reach, querying at the widest reach present and filtering by distance, because threat is the threatening creature's property (AoN 102), not the caster's and not a constant. A unit with no bound actor keeps the one-cell default, so an army deployed without actor data resolves exactly as it did before this slice.
- **Deliberate non-choice:** the strategic scale keeps reach in *squares × the scene's cell feet* rather than absolute feet. On the shipped 5-ft grid the two are identical; on a hypothetical 10-ft grid, absolute feet would leave no unit able to engage anything (deploy spacing is grid-derived), so this stays D-177's scale-relative reading, now per size — the same strategic-vs-tactical trade-off family §10.2 records. The tactical layer keeps absolute feet, because that is the unit AoN 131/179 and `meleeReachLegality` speak in.
- **Not encoded, on purpose:** flanking angles (P04), the interrupt queue (P06), squeeze/difficult terrain/move-through/5-ft-step hooks (P03), and "unarmed threatens nothing" as a flag — AoN 102 states it as reach, so an unarmed caller passes 0.

**Verification.** Fixtures were derived **before** the module was run: the four small cases by hand from AoN 175's sentence (Medium 8 adjacent squares; Medium-with-reach-weapon 12; Large long 12; Large tall 28) and the larger counts from an independent path-walking implementation of that same sentence, which reproduces all four hand-derived numbers — so no fixture is this module's own output. Two fixtures were caught wrong by that cross-check and corrected (the Large reach-weapon cells, which measure from the near edge of the 2×2 space, and a mixed diagonal offset). Five mutation checks, all red, all restored from fresh backups with `grep -c MUTATION` verified 0: tall/long columns swapped (9 tests red), threat counted on the ruler's `"555"` diagonals (8 red), Colossal reach back to the ladder's 5 (6 red across three files), caster threat back to one cell for everybody (1 red), envelopment reach back to `cellFeet` (1 red).

**Evidence.** Unit **1621 passed / 3 skipped** across 148 files (+46 tests: 32 geometry, 7 actor, 4 rules-table, 3 mass-battle); typecheck and lint green; build **2,253,202 raw / 647,879 gzip** (+1,447 B, budget 6 MB); `rules.js` **133.1 kB** (+1.5 kB — geometry is bundled into the mass-battles rules entry, which is where its consumer lives). Chromium e2e **92/92** (2.5 m): the derivation change alters what the sheet reads out, so the browser suite ran as well, not only the unit gates. Prettier: `geometry.ts`, `actor.ts`, `rulesTables.ts` and the two clean-at-HEAD test files formatted; `massBattlePf1e.ts` and the envelopment/mass-battle tests were dirty at HEAD and keep their native style per the D-151 rule. **Still open (P02's remainders):** (1) threatened-square **highlighting** — the canvas draw list and overlay, following this pure layer exactly as D-154's `areaPreview.ts` followed D-148's targeting; (2) a **tactical** consumer — nothing in the sheet flows carries token positions yet, so `meleeReachLegality` has a producer for `naturalReachFt` but still no caller, and A04's `shootingIntoMeleePenalty` still receives its `targetEngaged`/`nearestFriendlyDistanceFt` facts from nobody (`threatenedCells` + `footprintDistanceFt` are the primitives that will feed them, with P04); (3) **content** — `systems/pf1e-core/packs/bestiary.json` authors no `size` field at all, so every shipped creature derives Medium and no pack data exercises the new columns yet.

## D-181 — 2026-09-12 — P6/P04 first slice: flanking is AoN 183's line test, plus the scene seam that reads it

**Decision.** P04's flanking clause is now a pure rule — `src/packages/pf1e/flanking.ts` — with a scene seam (`src/packages/pf1e/threatPreview.ts`) and a live app surface (`e2eHook.pf1ePlaceTokens` / `pf1eThreat`), browser-tested in Chromium. It consumes P02's geometry (`threatenedCells`, `occupancy`) and leaves the existing **+2 appliers untouched**: `tactical.ts`'s `situational.flanking` part and `resolvePF1eAttacks`' `isFlanked` already put the bonus on the attack roll and not on AC (Gap List §2.2), which is what the rule says, so this slice supplies the *fact* they were being handed by a checkbox. The strategic `envelopment.ts` FLANKED bit is deliberately **not** switched over to it — see the non-choice below. **P04 stays unchecked**: cover, concealment, invisibility, helplessness and higher ground are all still open, and flanking itself has no position-aware tactical consumer yet.

**R02 transcription (re-verified 2026-09-12; AoN Rules ID 183, CRB p.197, "Flanking" — quoted in full at the head of `flanking.ts`).** "When making a melee attack, you get a +2 flanking bonus if your opponent is threatened by another enemy character or creature on its opposite border or opposite corner. When in doubt about whether two characters flank an opponent in the middle, trace an imaginary line between the two attackers' centers. If the line passes through opposite borders of the opponent's space (including corners of those borders), then the opponent is flanked. *Exception*: If a flanker takes up more than 1 square, it gets the flanking bonus if any square it occupies counts for flanking. Only a creature or character that threatens the defender can help an attacker get a flanking bonus. Creatures with a reach of 0 feet can't flank an opponent."

**Every clause, and how it is encoded.**
- **The line test** — `segmentFlanks`. Endpoints are cell *centers*, the defender's space is the bounding box of its occupied cells, and "opposite borders" is left+right or top+bottom of that box. Crossings are decided in **doubled cell coordinates** (every center an odd integer, every border an even one, so a center can never lie on a border) with the crossing ordinate compared as a rational — no floating-point tolerance anywhere, and corner contact counts for both borders meeting there, which is the parenthetical.
- **The multi-square exception** — `footprintsFlank` tries every occupied square of each flanker against every occupied square of the other and succeeds if *any* pair counts. This is load-bearing, not decorative: a fixture in `pf1eFlanking.test.ts` has a Large 2×2 attacker whose footprint-centre line misses the far border while its (1,−1) square runs exactly corner-to-corner through the defender's space.
- **Threatening ally** — `threatensSpace` asks P02's `threatenedCells` and tests it against *any* square of the defender's space, so reach per size, the tall/long body form and the reach-weapon band all decide it, and a Large defender is threatened from any of its four squares.
- **0-foot reach can't flank** — `canFlank` refuses on an authored reach of 0 **and** on Table 8-4's `occupancy().cannotFlank` sizes: the rules state the same exclusion twice (AoN 183 by reach, AoN 179 by size), and an unarmed Medium creature hits the first while a Tiny creature with data claiming 5 ft of reach hits the second.
- **A segment running along a border crosses nothing.** That is the case where a flanker shares the defender's cell, and it is *named* in the module header rather than quietly decided: the rule describes no such configuration, and calling collinearity a flank would be an invented fill.

**The scene seam.** `threatPreview.ts` is the single composition D-154's staging asks for — scene grid → `tokenCells` → `naturalReachSquares` → `threatenedCells` → `occupancy` → `resolveFlanking` — so the canvas overlay, the sheet and the e2e surfaces read one model instead of re-wiring the chain each. It reports `issues` (fatal: unusable scene grid, a token that covers no square) separately from `defaults` (announced assumptions: an unresolved size → Medium, per `sizeEntry`'s contract), because a model that refused to answer whenever an actor was still loading would be useless, and one that assumed silently would be lying. Each entry carries `threatRects` — P02's deferred threatened-square **draw list**, so that remainder now has its model layer and only the canvas layer/overlay is left. Hostility is a caller input (`isEnemy`): AoN 183 asks for "another **enemy** creature", and `TokenDocument.disposition` is read for an outline colour and nothing else in this codebase, so the seam does not invent a faction model — without a predicate it reports every qualifying pair and says so in `defaults`.

**Deliberate non-choice: the strategic FLANKED bit stays as it is.** Gap List §5 asks for `envelopment.ts`'s "≥2 attackers in contact ⇒ flanked" to be replaced with real flanking geometry, and the tactical rule now exists to replace it with — but at that scale models are *points in feet* and can share a cell: `massBattlePf1e.ts:110` builds `new SpatialGrid(5)` while `src/sim/deploy.ts` defaults formation spacing to **4 ft**, under one cell. Converting those points to 5-ft squares makes the line test decide flanking from a layout the rules never describe (several models per square, flankers collinear with the space they flank), and it would silently change what 10k-model battles pin. So the prerequisite is **P01's named deploy-spacing remainder** — spacing riding the scene grid, one model per cell — after which `envelopment.ts` can call `resolveFlanking` with each unit's footprint and reach. Recorded in Gap List §5 and in TODO P01 rather than papered over with an angle heuristic of my own invention.

**Verification.** Fixtures were cross-checked against **two independent implementations** of the same sentence before being written down: an exact-rational (`fractions.Fraction`) solver and a dense-sampling solver, neither sharing this module's doubled-integer arithmetic. All three agreed on **52,947 configurations** (1×1, 2×2 and 3×3 defenders at five origins; 1×1 and 2×2 flankers swept over a 9×9 neighbourhood), and the maps they print are the canonical ones — for an attacker due east of a Medium defender the qualifying allies are due west, and the two cells two squares out on either diagonal, and nothing else. Two of my hand-picked fixtures were wrong and were corrected by that check: the defender's western *diagonal* neighbours do **not** flank an eastern attacker (their lines leave through a corner and an adjacent border), and the extended-diagonal case needs an ally that actually threatens — a Huge creature at 15 ft, not a Medium one two squares out. Mutation checks, all restored from fresh backups with `grep -c MUTATION` verified 0: in `flanking.ts` — opposite-borders `||`→`&&` (6 red), corner contact made exclusive (4 red), Table 8-4's can't-flank ignored (1 red), reach-0 allowed to flank (1 red), the multi-square exception reduced to first-cell-only (2 red), the threatening-ally requirement dropped (1 red), the bonus made unconditional (2 red), the attacker's own threat no longer required (1 red); in `threatPreview.ts` — hostility filter dropped (1 red), authored reach ignored (1 red), the `flanked` flag ignored (4 red), a square-less token rounded into a cell (1 red), the size default made fatal (13 red), the reach-weapon band ignored (1 red). Two mutations were neutral and are recorded as such rather than claimed: `resolveFlanking`'s `ally.id === attacker.id` guard (two squares of one footprint can only bracket a space that footprint covers, and P02 never counts a creature's own squares as threatened — the guard is a belt on that rule, and the Huge-straddling test asserts both paths) and the seam's per-token threat memoization (bookkeeping, not behaviour).

**Evidence.** Unit **1670 passed / 3 skipped** across 152 files (+49: 27 flanking, 16 seam, 6 app-surface); typecheck and lint green; build **2,260,417 raw / 650,644 gzip** (+7,215 B raw, budget 6 MB); `rules.js` **133.1 kB unchanged** — the flanking modules are tactical and are not part of the mass-battles rules entry. Chromium e2e **97/97** (5.8 m), up from 92/92 with five new specs (`e2e/pf1e_flanking.spec.ts`): opposite-border flanking resolved from the live scene and its actor documents, a crowd on one side flanking nobody, a Large creature flanked across its four squares, a Tiny creature threatening nothing and helping nobody, and hostility narrowing the report. The browser had to be rebuilt first — this sandbox lost its Chromium and only the npm registry is reachable, so `@sparticuz/chromium@152.0.0` supplied the binary and the three missing shared objects (`libnspr4`, `libnss3`, `libnssutil3` — 44 versioned symbols) were compiled locally as stubs; `webrtc.spec.ts`'s DTLS loopback and the TLS specs still pass, so the stubs are not standing in for crypto Chromium actually uses, and nothing about this is committed — it is an environment artifact, recorded here so the 97/97 is readable. Prettier: the five new files formatted, and `e2eHook.ts` (clean at HEAD) formatted with my additions; no unrelated reformatting. **Still open (P04's remainders):** cover (corner-based soft/partial/standard/improved/total), concealment's non-stacking miss chances, invisibility and denied Dex, helplessness and coup de grâce, higher ground; the canvas overlay that draws `threatRects`; a position-aware tactical consumer, so `PF1eActorSheet.svelte`'s hand-ticked `resolveFlanking` checkbox can become a derived fact with a manual override; and the strategic switch described above, behind P01's deploy spacing.

## D-182 — 2026-09-12 — P01 closed, M04/P04 second slice: the strategic FLANKED bit is AoN 183's line test, on the scene's own grid

**Decision.** D-181 named P01's deploy-spacing remainder as the prerequisite for replacing `envelopment.ts`'s invented "≥2 attackers in contact ⇒ flanked" rule with the real one. That prerequisite is now met and the rule is switched: `TurnChannel` deploys formations at the **scene's** grid distance and the sim's spatial hash is built at that same scale, so one model lands per square; `envelopment.ts` is rewritten around `markPF1eFlanking`, which clears and recomputes every living model's FLANKED bit once per turn through `flanking.ts`'s `resolveFlanking` (AoN 183, unchanged, never re-derived here). The old engine — `calculatePF1eEnvelopment`, `contactPairs`, `flankingModels`, `envelopedDefenders`, and the `isFlanked` plumbing it fed into `resolvePF1eAttacks` — is deleted, not kept beside the new one. **P01 is closed**; **M04 stays unchecked** for its remaining two clauses (envelopment movement, non-SRD bonus documentation), and **P04 stays unchecked** for cover, concealment, invisibility/denied Dex, helplessness and higher ground.

**What landed.**
- **P01, deploy spacing (the named blocker).** `core/rules.ts`'s `sceneCellFeet(distance)` is now the single canonical feet-per-square derivation, living with the `RulesGridContext` it describes (finite and > 0, else the standard 5-ft square) so the host needs no system-package import, and `geometry.cellAt(x, y, cellFeet)` the single "which square is this point in" conversion. `TurnChannel` derives it once per start (`cellFeet()`), hands it to `deploySnapshot` as `spacing`, and fills `ctx.grid.distance` with the same value (the army preview's `RulesContext` builder in `src/ui/armies/armyModel.ts` uses the same helper, so the two `RulesContext` producers a session has cannot disagree either) — so the deployer, the movement budget, reach, the hash and the rules context cannot disagree about what a square is. A scene with a missing or non-positive `distance` falls back to 5 ft on both sides of the boundary, never to the deployer's legacy 4-ft literal. The 4-ft default survives only for callers with no scene (the mass-battle-basic reference and the deployer's own tests), named as such in `DeployOptions.spacing`'s doc.
- **P01, hash scale.** `massBattlePf1e.ts` built `new SpatialGrid(5)` — a second, independent scale constant next to `ctx.grid.distance`. The module now builds (and rebuilds, when a scene's distance changes) the hash at `cellFeet`, so `queryPoint` radii in feet and the grid's own buckets are the same scale at any scene setting. The leadership aura's 30 ft radius needs no conversion: it is an absolute rules distance and has been feet since D-172's `/5` repair.
- **M04, the rule.** `markPF1eFlanking({pool, grid, cellFeet, factionByUnitIdx, reachSquaresByUnitIdx, sizeByUnitIdx?, isEnemy?})` runs once per turn after movement and before any engagement resolves, and returns `{flankedDefenders, pairs}`. Every model's bit is cleared first (dead models included, so a model killed while flanked cannot report a stale state), then each living model's square is tested: candidates are living **enemies** whose P02 threatened set covers the defender's square — per-unit reach from the bound leader actor (D-180), Table 8-4's can't-flank exclusion through `sizeByUnitIdx`, the threatening-ally requirement through `threatenedCells`, and the decision itself through `resolveFlanking`. Enemy means "different faction" (`factionByUnitIdx`); a caller with a different relation passes `isEnemy`, exactly as the tactical seam takes it. The bit is `1 << 2`, still the documented §2.13 alias with core `pinned`; this module allocates nothing new. `resolvePF1eAttacks` needed no change — it already reads `PF1eCondition.FLANKED` off the defender's status (combatEngine.ts:271), so the per-model bit *is* the bonus, and a defender flanked by two different units is flanked regardless of which engagement resolves it. Nothing about the +2 moved or became a new bonus.
- **The bug my own fixtures found.** The first version queried candidates with a Euclidean radius of `reach × cellFeet`. AoN 102's threatened squares include the **diagonals**, and a diagonal neighbour's centre is `reach × √2` cells away (7.07 ft for a Medium creature's 1-square reach), so the query returned nothing for every corner configuration — the pass missed exactly the flank D-181's line test exists to accept (opposite corners). The radius is now `ceil(reach × √2) × cellFeet`; the exact test stays the threatened set, the query is only a bound. The same bound error existed in the deleted `calculatePF1eEnvelopment` (its default 5-ft `queryPoint` could not see a diagonal contact at 7.07 ft either), so this is a defect the switchover removes rather than introduces. The scale fixtures had encoded the old rule's answer, which is why they, and not a 4-ft-spacing scenario, are what failed.

**Verification.** `tests/packages/pf1eEnvelopment.test.ts` was rewritten around AoN 183 (4 tests → 9): opposite borders flank and same-side attackers do not; opposite **corners** flank (the case the query bound had missed); the threatening-ally requirement is read through reach (a 10-ft pair flanks only when the unit's leader actor says Large, the same layout not flanking at Medium); 0-ft reach and sub-square sizes cannot flank; same-faction models never flank each other; the pass clears a bit the layout no longer supports and never leaves one on a dead model; two models sharing one square are collinear and do not flank (the degenerate 4-ft-spacing case, named rather than decided); a defender flanked by two different enemy units is recorded once with its deciding pair; and a 10,000-model line-vs-line pass returns zero flanked defenders well inside a 2 s bound. `tests/packages/massBattlePf1e.test.ts`'s two envelopment fixtures were rewritten against the new rule: opposite-border flanking is set in round 1, cleared in round 2 when the attackers step to one side, set again in round 3, and cleared in round 4 when they leave reach — with the old rule's false positive (two adjacent same-side attackers) pinned as its own red test. `tests/sim/deploy.test.ts` gains the deployer's half of the P01 contract (`spacing: 10` lands line files 10 ft apart; the default stays 4 ft for scene-less callers), and `tests/host/turnChannel.test.ts` gains the channel-level one: a 10-ft scene deploys one model per 10-ft square and reports `rulesCtx().grid.distance === 10`. The shared derivation itself is pinned in `tests/core/rules.test.ts` (authored distance wins; `undefined`/`null`/`0`/negative/`NaN`/`Infinity`/a string/a foreign object all degrade to the 5-ft square, never to the deployer's 4-ft legacy), and `cellAt`'s doc-comment cases in `tests/packages/pf1eGeometry.test.ts` (including the floor-vs-truncate case west of the origin and re-bucketing the same points at a 10-ft cell). Mutation-tested by construction: the fixtures that encoded the heuristic went red the moment the rule changed (2 mass-battle tests), and the corner fixture went red against the pre-fix query bound.

**Evidence.** Unit **1684 passed / 3 skipped** across 153 files (+14 over D-181's 1670: +5 envelopment, +1 mass-battle, +1 deploy, +1 channel, +3 shared-scale, +3 `cellAt`); typecheck and lint green. Build **2,260,603 raw / 650,690 gzip** (+186/+46 B; budget 6 MB, `pnpm size` OK). `pnpm build:systems`: `pf1e-mass-battles` **rules.js 148.3 kB** (+15.2 kB) / **45.8 kB zip** (+5.2 kB) — the strategic entry now bundles `flanking.ts` and its geometry helpers through their legitimate consumer, where D-181 could report them tactical-only; `pf1e-core` unchanged at 3.3 kB. **Not run: any browser test.** This sandbox has no Chromium and the Playwright CDN is unreachable (`npx playwright install chromium` fails); D-179/D-181's `@sparticuz/chromium` workaround was not re-attempted. The change is Node-proven only, and nothing here should be reported as browser-verified.

**Still open.** M04: envelopment movement and the non-SRD bonus documentation. P04: cover (corner-based soft/partial/standard/improved/total), concealment's non-stacking miss chances, invisibility and denied Dex, helplessness and coup de grâce, higher ground; the canvas overlay that draws `threatPreview.ts`'s `threatRects`; and a position-aware tactical consumer so `PF1eActorSheet.svelte`'s hand-ticked `resolveFlanking` checkbox can become a derived fact with a manual override. M03: the §2.13 bit-allocation collision (FLANKED aliases `pinned`) is untouched. Documented, not fixed: nothing enforces one-model-per-square at the pool level — if a caller ever authors coordinates that are not one-per-square, the pass reports the collinear case as "not flanking" rather than inventing an answer, which is the same choice D-181 recorded for `flanking.ts` and the reason the shared square has its own fixture.

## D-183 — 2026-09-12 — the AoO budget is one per round (plus the Dexterity bonus with Combat Reflexes), not one-plus-Dex-for-everyone

**Decision.** `rulesTables.attacksOfOpportunityPerRound` was wrong, and the error was in the **code**, not in the A.10 table it cites. The old formula was `1 + (dexMod > 0 ? 1 : 0) + (combatReflexes ? max(0, dexMod) : 0)`, i.e. **every character with a positive Dexterity modifier got two attacks of opportunity per round** and Combat Reflexes added a third on top of that (Dex 16 → 5/round, where the rules give 4). The engine now computes:

- no Combat Reflexes → **1**, whatever the Dexterity modifier is (the feat entry's own Normal line: "A character without this feat can make only one attack of opportunity per round");
- Combat Reflexes → **1 + Dexterity modifier**, clamped at a minimum of 1.

This closes the Gap List's A.10 deviation. It changes three consumers, all in one commit: the shared table (`rulesTables.ts`), the strategic per-unit default (`schema.ts`'s `maxAoos`, now `raw.maxAoos ?? 1`) with authored `stats.maxAoos` accepted as-is by `deploySeed.ts` (authoring still wins), and the tactical derivation's flat-footed clause (`actor.ts`'s `canTakeAoO` and its `explain.aoo` readout).

**R02 transcription (re-verified 2026-09-12).**
- **AoN Rules ID 102 — "Attacks of Opportunity" (CRB p.180):** "An attack of opportunity is a single melee attack, and most characters can only make **one per round**. … If you have the Combat Reflexes feat, you can **add your Dexterity bonus to the number of attacks of opportunity you can make in a round**. This feat does not let you make more than one attack for a given opportunity, but if the same opponent provokes two attacks of opportunity from you, you could make two separate attacks of opportunity (since each one represents a different opportunity)."
- **AoN feat "Combat Reflexes" (CRB p.119):** "You may make a number of additional attacks of opportunity per round equal to your Dexterity bonus. With this feat, you may also make attacks of opportunity while flat-footed. **Normal:** A character without this feat can make only one attack of opportunity per round and can't make attacks of opportunity while flat-footed."
- **AoN Rules ID 135 — "Total Defense" (CRB p.185):** "You can't make attacks of opportunity while using total defense." Already carried by the condition payload; cited here because it is the other half of the flat-footed clause's family.

**The two readings, named rather than buried.**
1. **The feat's "+1 base".** "Add your Dexterity bonus **to the number**" and "additional … per round" both read the Dexterity bonus as on top of the one-per-round that everyone has, so a Dex 16 fighter gets 1 + 3 = 4. The alternative reading — that the feat *replaces* the base with the Dexterity bonus — gives 3 and would leave a Dex-10 Combat Reflexes character unable to take any opportunity at all, which the same feat's Normal line rules out. The printed worked examples (a Dex 16 character with the feat makes four attacks of opportunity in a round) agree with reading 1.
2. **The clamp at 1.** No rule describes a Dexterity *penalty* reducing the one opportunity every character has, and "most characters can only make one per round" is the general statement — so `max(1, 1 + dexMod)` keeps the base rather than letting a −2 Dexterity modifier take a character below the rule's own floor. This is a documented reading, not a transcription: the printed text is silent on negative Dexterity modifiers, and the clamp is the choice that never removes an opportunity the base rule grants.
3. **Authored data wins.** `stats.maxAoos` on a unit's stats block is ingested unchanged (a finite value, floored at 0) rather than re-derived: a creature whose printed stat block carries a different number (a monster, an NPC with a feat outside the shipped set) is authoritative for its own budget.

**Verification.** `tests/packages/pf1eRulesTables.test.ts`'s AoO describe was rewritten against the transcription: without the feat all four fixtures — Dex −1, 0, 1 and 3 — return **1** (the old formula returned 2 for the positive modifiers), and with the feat the cases are −1 → 1 (the clamp), 0 → 1, 3 → 4 and 5 → 6. `tests/packages/pf1eActor.test.ts` was corrected against the same texts (2 → 1, 4 → 3, 6 → 5) and gained the flat-footed test: the Flat-Footed condition alone gives `canTakeAoO === false` and the readout reads "none while flat-footed", while Combat Reflexes lifts exactly that denial and the readout drops the clause. Mutation checks (fresh backups, `grep -c MUTATION` = 0, backups `diff`-verified identical after restore): removing the clamp (`1 + dexMod`) reddens 1 test; removing the feat's flat-footed exception reddens 1 test.

**Evidence.** Full suite **1705 passed / 3 skipped** across 154 files (D-182: 1684/3 across 153, +1 skipped file is the new sim-level AoO spec); typecheck and lint green. Build `dist/index.html` **2,260,604 raw / 650,683 gzip** (D-182: 2,260,603 / 650,690 — the budget change itself is a one-byte difference; the queue's own growth is D-184's). `pnpm size` OK. **Not run: any browser test** — this sandbox still has no Chromium and the Playwright CDN is unreachable (D-182's record stands); this is Node-proven only.

**Still open.** The AoO *economy* is now correct in both scales; the interrupt **queue** that spends it is D-184. P06's remaining clauses are recorded there and in the TODO.

## D-184 — 2026-09-12 — P06 first slice: an authoritative interrupt queue, and the strategic sim resolves movement AoOs itself

**Decision.** `src/packages/pf1e/interrupts.ts` is the authoritative queue the P06 acceptance line asks for: a **pure** module that decides whether a provoking action earns an opportunity, from whom, in which square, and in what order it resolves — no dice, no pool, no UI, no writes. The strategic sim is its first real consumer, and it now resolves movement attacks of opportunity **as rules, not as prompts**: each unit's march is walked square by square, the squares it leaves are tested against every enemy model's threatened set, the queue is drained *before* the formation translation is committed, and the budget is spent on the model that actually strikes. `resetTurnAoOs` — callerless since it was written — is now wired to the one moment the rules name: the start of the turn.

**What the module owns (and what it deliberately does not).**
- **The trigger table is not retranscribed.** `actionTrigger(actionId)` reads Table 7-2 out of `actions.ts`'s existing `PF1E_ACTIONS` rows, so there is exactly one copy of "what provokes" per action; rows that provoke `"usually"`, `"maybe"` or `"varies"` are **refused by name with the row's own footnote** rather than guessed (aid another's footnote 2 is the worked example in the tests). Movement is a different entry point (`queueMovementAoOs`) because a march provokes on the squares it leaves, which is not an action row's fact.
- **One opportunity per (reactor, action).** AoN 102: "Moving out of more than one square threatened by the same opponent in the same round doesn't count as more than one opportunity for that opponent." The dedupe unit is the *action* id, so a march that leaves three squares a fighter threatens provokes once from that fighter, while the same fighter may still react to a second, separate action (the same sentence's "if the same opponent provokes two attacks of opportunity from you, you could make two separate attacks of opportunity").
- **The exclusions**, each with its own named refusal via `aooRefusal`: flat-footed without Combat Reflexes (and D-183's exception with it), total defense ("You can't make attacks of opportunity while using total defense", CRB p.185), a caster mid-spell ("While casting a spell, you don't threaten any squares around you", CRB p.187), a creature that threatens nothing, an incapacitated creature, and an exhausted budget (`no opportunities left (n/m)`). Reasons are strings the caller logs, so a spent budget and a legal-but-skipped reaction never look alike.
- **Withdraw exempts the square the withdrawer started in — and only it** (CRB p.188: "The square you start out in is not considered threatened by any opponent you can see … If, during the process of withdrawing, you move out of a threatened square (other than the one you started in), enemies get attacks of opportunity as normal"), pinned by a fixture in which the exempt start square is threatened by two enemies and the *next* square is still threatened by one.
- **The walk is `cellsAlongSegment`** (D-182's Bresenham grid walk) rather than the continuous displacement, so the interrupted squares are squares, and the phantom "grazed" corner of a diagonal never provokes.
- **Ordering is a named convention, not transcribed text.** The rules say an opportunity "interrupts" the flow and resolves immediately; they say nothing about two reactors threatening the same square. `orderInterrupts` keeps the caller's own insertion order by default and accepts an `initiativeOf` callback for tables that resolve by initiative (higher first, ties in insertion order). The choice is written down where a table can see it and override it.
- **Damage rides the interrupt.** The resolution records the attack's damage so the caller can feed the concentration check the rules demand of a damaged caster (`10 + damage + spell level` — already `pf1eCastFlow.ts`'s), instead of this module computing a second concentration formula. The queue is turn-local, deterministic and replayable: `resolveNextInterrupt` pops, `clearInterrupts` drops a finished turn.

**What the strategic sim does with it.** In `resolveTurn`, after the per-unit reach/size derivation and before the move sub-phase: `buildUnitProfiles` + `seedPF1ePool` now run at the **top** of the turn (they used to run after movement, but the march's opportunities need the registry and a fresh `aooUsed` column — a deliberate reorder; `seedPF1ePool` already writes `aooUsed` to 0 per model, "your attacks of opportunity refresh at the start of your turn"), then `resetTurnAoOs(pool, livingModelIndices(pool, units))` names that refresh for the models units actually cover. Threat comes from `threatenedCells` over each model's own footprint and reach (D-180's per-size reach, the same function the tactical layer reaches), so "does leaving this square provoke?" has one answer per scale. Reactors are **enemies on the flanking pass's own relation** (a different faction, M04/D-182), and a unit's threat set is the union of its living models' — a formation threatens what its members threaten, and one member spends its own budget. Each queue entry resolves immediately: the reactor's `aooUsed` is incremented first, then `resolvePF1eAttacks` makes the attack, then the event is emitted with the provoker, the trigger kind, the square and the damage. A refused reaction emits `opportunity-refused` with the reason. The formation translation is written **after** the queue is drained, which is what makes "the opportunity interrupts the march" a property of the order of writes rather than a claim in a comment.

**Named limitations of this slice.** (1) The sim has no visibility model, so the withdraw exemption is applied to every enemy — "any opponent you can see" is treated as "every opponent", which is the common case, and the code says so. (2) The 5-foot step and its provoke immunity are not modelled because the strategic scale has no step action; the trigger table has no step row either, which is the same fact. (3) Only *movement* is queued at this scale: a strategic unit's other orders do not yet consult the queue, and casting's provocation path remains `spells.ts`'s defensive-casting check. (4) Nothing in the **tactical** layer calls the queue yet — `combatState.useAttackOfOpportunity` still spends a caller-supplied budget, and the tactical Ops path (movement Op → threatened check → queue → spend → resolve) is the next slice; that is why **P06 stays unchecked**.

**Verification.** 16 new tests, all derived from the quoted rule texts before the module was run. `tests/packages/pf1eInterrupts.test.ts` (11, pure module): the one-opportunity-per-opponent sentence as a fixture (a march out of three threatened squares → one queue entry, recorded at the **first** left square the reactor threatens), a second reactor's square being its own, two different actions as two opportunities while a repeat of one action is refused, a walk that leaves no square provoking nothing, the withdraw slice in both directions, every named refusal, the trigger table reading `actions.ts` by action id (including the "usually/maybe" refusal), and ordering/draining/clearing. `tests/packages/pf1eStrategicAoO.test.ts` (5, through `createMassBattlePf1e`): the march provokes and the reactor's column shows 1 while the mover's shows 0 (and the mover still reaches its destination), one march past two of the same unit's threatened squares provokes **once**, the budget refreshes and is spent again on the next turn (still 1, not 2), a march away from the threat provokes nothing, and the withdraw fixture above at the sim level — where the adjacent enemy that only threatened the start square spends 0 and the unit threatening the next square spends 1. The fixtures found a real bug in the code: the reacting model was selected by a condition that could not hold, so a two-model unit always spent the *last* threatening model's budget instead of the first — caught by the test asserting the column of the model that threatened, fixed by tracking the first threatening member explicitly. Mutation checks (fresh backups, `grep -c MUTATION` = 0, backups `diff`-verified identical after restore): dropping the withdraw slice reddens 2 tests, dropping the dedupe reddens 1, removing the Combat-Reflexes flat-footed exception reddens 1, removing the budget clamp reddens 1.

**Evidence.** Full suite **1705 passed / 3 skipped** across 154 files (+16 tests over D-182's 1684/3, plus the `pf1eActor` readout repair); typecheck and lint green. Build `dist/index.html` **2,260,604 raw / 650,683 gzip** (D-182: 2,260,603 / 650,690; within the 6 MB budget, `pnpm size` OK). `pnpm build:systems`: `pf1e-mass-battles` **rules.js 164.9 kB** (was 148.3) / **51.0 kB zip** (was 45.8) — the strategic entry bundles the queue, its trigger-table reader and the geometry walk through their legitimate consumer; `pf1e-core` unchanged at 3.3 kB. The 10k scale gate still passes in **2.35 s** (was 2.33 s): one grid walk, one threat-set build per enemy pair and a handful of attacks per marching unit at most. **Not run: any browser test** — no Chromium in this sandbox, the Playwright CDN is unreachable, and this is Node-proven only; `e2e/` was not extended.

**Still open (P06).** The tactical consumer (Ops-path queueing for movement and actions, and the prompt that is *backed by* the queue rather than standing in for it; `combatState.ts` already resets the budget on the owner's turn but no Ops flow drives it), maneuver/casting damage effects on a provoked reaction, and ready-before-trigger ordering (P07's, per the TODO). P06 therefore stays unchecked in the TODO with this slice recorded as the queue's first half. Ranged touch attacks that provoke even after defensive casting (AoN 133) have their trigger constructor (`rangedTouchTrigger`) but no caller yet — the tactical attack flow is where they land.

## D-185 — 2026-09-12 — P06 second slice: the tactical scene runs the same queue, and the encounter's AoO ledger gets one vocabulary

**Decision.** The tactical scale now answers "does this move provoke?" with the *same* queue the strategic sim uses (D-184), fed by the same scene data the flanking overlay already reads, and it is asked **before the move Op exists**. Four pieces landed: `packages/pf1e/tacticalOpportunity.ts` is the pure scene seam (`cellsAlongSegment` → each token's `threatenedCells` → `interrupts.queueMovementAoOs`); the canvas controller gained `onTokenMove`, asked inside `pointerUp` before the `tokens` update is built, whose `"cancel"` return suppresses the Op and restores the token — so the ordering guarantee is the controller's, not a convention; `ui/combat/actionBudget.ts` gained the encounter-side budget and spend (`attackOfOpportunityBudget`, `spendAttackOfOpportunityAuthorized` — the first consumer of the long-reserved `"aoo"` deny token); and `e2eHook` gained `pf1eMoveToken` / `pf1eOpportunity` so a browser spec can drive the same facts through real Ops. `PF1eDerived` gained `combatReflexes`, because the two facts the feat changes (the budget and the flat-footed exception) are asked separately and only one of them was derivable from `aooPerRound`. `App.svelte` wires the hook: the GM's drag now reports the queue (`reactors[].line`, refusals included) in the notification surface, with its hostility assumption named when the scene's dispositions do not settle it.

**Why a scene seam rather than a call inside the canvas controller.** The canvas knows tokens and world coordinates; the encounter knows combatants and ledgers; the rules know neither. `pf1eMovementOpportunities` takes the scene (grid + tokens with their actor-derived size/shape), the mover's destination and a `{used, max}` ledger map, and returns the walk, the left squares as world rects (the highlight draw list), every reactor with its line, the refusals, and the queue. Nothing in it reads a document, so the unit suite can pin the rules and the app suite can pin the wiring — which is exactly how the canvas hook and the App wiring then landed: the controller asks it once, and the App supplies the scene.

**What is authoritative now, and what is not.** The verdict is a *function of the scene*, computed before the Op: `CanvasController.pointerUp` asks `onTokenMove` with the snapped target and submits only if the answer is not `"cancel"` (unit-pinned: the hook sees zero submitted ops, and a cancel leaves the store untouched and the render restored to the committed position). The e2e surface proves a token that really moved through a real `tokens` update op produces the verdict the rules call for. The ledger spend is authorized (`spendAttackOfOpportunityAuthorized`: permission → the queue's own eligibility → `useAttackOfOpportunity` → one `combats` update op), and every refusal string is `interrupts.aooRefusal`'s — the same function the sim calls and the same one the App shows. What is **not** yet wired: the *table decision*. The App reports the queue but does not offer the reaction — there is no panel control that resolves the attack and calls the spend, so the GM reads the line and resolves it by hand. That is the remaining half of the tactical consumer, and P06 stays unchecked until it lands.

**The four rules the fixtures pin, each with its source.**
- **One opportunity per opponent, in the square it left.** AoN 102's "moving out of more than one square threatened by the same opponent in the same round doesn't count as more than one opportunity for that opponent" — the fighter at (3,1) threatened three of the goblin's five left squares and the queue holds exactly one entry, at the *first* of them.
- **A withdraw exempts the start square and nothing else** (CRB p.188). The fixture is discriminating by construction: an enemy that threatens *only* the start square loses its attack, and an enemy that threatens a later square keeps it.
- **Flat-footed, two ways.** The effect-driven case reaches the refusal through the derivation (`canTakeAoO`, D-183's exception fold), and the round-structural case (`isFlatFootedByRound`: surprise, or no turn yet) through the new `combatReflexes` flag — because the derivation cannot see the round structure. Combat Reflexes lifts both.
- **Reach decides it, from authored data.** A Large creature's 2-square reach reaches a square a Medium creature's cannot, with both placed identically; in the app suite the size travels actor document → `deriveFromDocuments` → `threatenedCells`.

**Named limitations (unchanged from D-184 where they are shared).** (1) No visibility model: "any opponent you can see" is read as every opponent, so a withdraw exempts the start square for every reactor. (2) A multi-square mover is walked between its **centres**, so trailing-footprint squares are not tested; the module reports that as a named default instead of guessing (a footprint-aware walk is P05's). (3) Hostility is the caller's fact, and its absence is a named default — not a silent "everyone is an enemy". (4) Only *movement* is decided: ranged attacks, casting and standing up still provoke only where their own flows say so (the sheet's cast flow narrates the provoke; the queue has no tactical caller for it yet).

**Verification.** 23 new tests. `tests/packages/pf1eTacticalOpportunity.test.ts` (12, pure): the walk and its left squares, one-per-opponent with the recorded square, a non-threatening creature, the ledger refusal (with its line), a ledger with budget left, the **diagonal** case in both directions (a creature threatening only the grazed corner does *not* react; one threatening the square actually left does), the withdraw pair, hostility stated vs unstated, a no-op move, the multi-square default, and the two refusals. `tests/app/pf1eOpportunitySurface.test.ts` (5, real booted `HostApp` through real ops): move-then-verdict with the committed position, the pre-commit verdict (the token never moves), the fixed expectation that the fighter's first threatened square is (2,0) — the fixture found my own comment wrong — withdraw + spent ledger, the Medium-vs-Large discrimination, and the missing-mover refusal. `tests/ui/actionBudget.test.ts` gained 5: the budget is the derivation's number (1 without the feat whatever the Dex; 3 with Combat Reflexes at Dex 14), round-structural flat-footed refused in the queue's own words and lifted by the feat, the authorized spend writing `aooUsed`/`aooMax` with the second spend refused, permission/lookup refusals before any write, and the effect denial in both spellings (`flags.cannotAoO` through the derivation, `denies: ["aoo"]` through the effect gate). `tests/canvas/interactions.test.ts` gained the ordering test (the hook is asked with the snapped target while `submitted` is still empty; a `"cancel"` submits nothing and restores the render). Mutation checks, all red, all restored from fresh backups with `diff` verified identical: the withdraw slice dropped (2 red), the ledger filter dropped (2 red), the hostility filter dropped (1 red), the derivation refusal ignored (1 red), round flat-footedness ignored (1 red), the effects not passed to the derivation (1 red — every condition silently invisible), and the controller's cancel honoured-then-removed (1 red) and the hook call removed (1 red). `e2e/pf1e_opportunity.spec.ts` adds 5 browser tests collected by `playwright test --list` (**306 tests in 38 files**, was 291/37), **not executed** — this sandbox has no Chromium and the Playwright CDN is unreachable (D-182's record stands); they are authored to be executable, not reported as passing.

**Evidence.** Unit **1728 passed / 3 skipped** across 156 files (+23 tests, +2 files over D-184's 1705/154); typecheck and lint green; touched-file Prettier (the two new test files, `interrupts.ts`, `tacticalOpportunity.ts`, `actionBudget.ts`, `actor.ts`, `effectOps.ts`, `interactions/index.ts`, `e2eHook.ts`, the new spec). `App.svelte` is not Prettier-parseable in this repo's toolchain (no Svelte parser is configured — the base file is unchecked for the same reason), so its formatting is by hand, matching the surrounding file. Build `dist/index.html` **2,268,375 raw / 653,512 gzip** (+7,771 / +2,829 over D-184's 2,260,604/650,683; budget 6 MB, `pnpm size` OK). `pnpm build:systems`: `pf1e-mass-battles` **rules.js 165.0 kB** (was 164.9) / **51.0 kB zip** — only the shared `cannotTakeAoO`/`combatReflexes` additions reach that entry; the tactical seam is in the app bundle through `App.svelte` and `e2eHook`, which is where its consumers live. `pf1e-core` unchanged at 3.3 kB. 10k scale gate 2.43 s.

**Still open (P06).** The table-side prompt that resolves the queued reaction and spends the ledger (the App reports the queue today); action triggers at the tactical scale (ranged attack in reach, casting — `rangedTouchTrigger` exists but no flow consumes it); maneuver damage effects on a provoked reaction (P05); and ready-before-trigger ordering (P07's). P06 stays unchecked.

## D-186 — 2026-09-12 — P06: the app resolves the movement attacks of opportunity, unless the world says otherwise

**Decision.** D-185 built the queue and reported it; the table still rolled the attack and told the app it had happened. This slice closes that: a drag that provokes is now **held**, the queued attacks are resolved through the sheet's own resolve flow *before the mover leaves the square*, the reactors' ledgers are spent, and then the move commits — with no GM input. It is a **replicated world option**, `autoResolveAoos`, **on unless a world explicitly turns it off**, because whether an attack already happened is a fact both sides of the table must agree on: a GM-local preference would let a player's client disagree with the host.

**The four rules the design is built on, each with its source.**
- *The attack is resolved before the mover leaves the square.* AoN 102: "If an attack of opportunity is provoked, immediately resolve the attack of opportunity, then continue with … the current turn." This is why the canvas holds the move instead of moving and then reacting: D-185's `onTokenMove` gained `move.commit` — **the same Op the controller would have submitted, deferred until the caller says so** (idempotent, always the snapped target the hook was asked about). A listener that cancels and never commits leaves the token exactly where it started, so cancellation stays a real cancellation; the auto-resolve path calls `commit()` once the last attack is resolved and the ledger is written.
- *"An attack of opportunity is a single melee attack … at your normal attack bonus."* A reactor whose every authored line is **ranged** forgoes the opportunity: it is reported as a skip with its reason, **no attack is rolled and no budget is spent** — the refusal is not narrated as a miss, because no attack was made.
- *One attack per round, spent by reacting.* The budget is spent on a **miss** as well as a hit: "you can only make one attack of opportunity per round" is the cost of reacting, not of connecting. The spend is `spendAttackOfOpportunityAuthorized` — permission → the queue's own `aooRefusal` wording → `useAttackOfOpportunity` → one `combats` update op (D-185's path, unchanged).
- *Flat-footed until your first turn.* The provoker is defended against as flat-footed when the encounter's round structure says it has not acted yet (`isFlatFootedByRound`), which is the one defense fact the queue's geometry cannot supply.

**Where it lives, and why there.** `src/ui/combat/pf1eAooFlow.ts` is the flow: `resolveMovementOpportunities` walks the queue in resolution order (initiative from the encounter, ties in the queue's own insertion order — D-184's convention), resolves each attack through `resolveAttackFlow` (so the roll, the threat confirmation, the damage, the mitigation, the HP write and the **public chat card** are the same code path and the same card a sheet attack uses, labelled `— attack of opportunity`), then spends. `planHeldMove` is the **synchronous decision** the canvas handler needs before it can hold or commit: auto-resolve when the option is on *and* there is an encounter to spend against, otherwise report the queue's lines (D-185's behaviour, plus a named note when the option asked for auto-resolution and there was no encounter). Keeping that decision out of the Svelte file is what makes the toggle testable without a browser. `src/packages/pf1e/aooSettings.ts` reads the option (`!== false`, the polarity `advanceClockOnRoundOf` uses; a non-boolean reads as the default rather than silently disabling the feature). `App.svelte` wires it — ask, hold, resolve, report, commit — and `SettingsPanel.svelte` gained the checkbox (`data-world-auto-aoo`) beside the other rules options, writing through `worldSettingsOps` like every other world option.

**What is authoritative now, and what is not.** Authoritative: the queue (D-185), the attack (the sheet's resolution, every die from the host's roll protocol), the ledger (the encounter's), the option (the replicated settings document). Not: cover, concealment, prone and the other situational modifiers — the queue knows the square, not what the provoker is standing in, and inventing a bonus here would be a second rules layer (P04's open list). Also not wired: the **manual prompt**. With the option off the app reports the lines and the GM rolls by hand — there is no dialog that offers the reaction and rolls it on demand. That is deliberate (it is what makes auto-resolution worth having), but it is the remaining half of "the table's choice", and P06 stays unchecked.

**Verification.** 30 new tests. `tests/ui/pf1eAooFlow.test.ts` (17): the option's default/authoring reads; a hit through the sheet's flow with the exact ops (card, HP write, ledger) and its line; a miss that still spends; an exhausted ledger reporting `aooRefusal`'s own words and writing nothing; a reactor that is not a combatant resolving but not spending; **no encounter meaning no auto-resolution** with the caller told; a ranged-only reactor skipping without spending; **initiative order, not insertion order**; a not-yet-acted provoker defended flat-footed (AC 14, not 16); the Verify option routing both rolls through the commit-reveal path; a token with no actor document skipped by name; a resolver without permission still reporting the attack it could not write (card says "HP write rejected", ledger names its reason); and the three planner cases (on+encounter holds; off reports the lines and names the assumption; on without an encounter says so instead of going quiet) plus the report's entry/skip/assumption order. `tests/app/pf1eOpportunitySurface.test.ts` gained 2 against a real booted `HostApp`: the whole pipeline through `pf1eOpportunityResolve` — real encounter ops, real host rolls, the ledger landed in the store, the resolution card in the messages store, and the invariant `damage === hpBefore − hpAfter` — and the no-encounter path. `tests/canvas/interactions.test.ts` gained 2: a cancel that commits later, exactly once (idempotent, and the committed Op is the one the hook was asked about), and the plain path where nothing defers. `e2e/pf1e_opportunity.spec.ts` gained 4 browser tests (the option's default/round-trip through `worldSettingsOps`, the resolved pipeline with the ledger and the card, the spent ledger and the no-encounter refusal, and the ranged-only archer) — collected by `playwright test --list` (**318 tests in 38 files**, was 306/38), **not executed**: this sandbox has no Chromium and the Playwright CDN is unreachable (D-182's record stands). Mutation checks, all red, all restored from fresh backups with `diff` verified identical: the ledger spend removed (2 red), the melee filter dropped (1), the initiative ordering replaced by the queue's order (1), the flat-footed defense dropped (1), the no-encounter short-circuit removed (1), the option's default flipped to off (1), the option ignored by the planner (1), the no-encounter note dropped (1), and the skip lines dropped from the report (1).

**Evidence.** Unit **1749 passed / 3 skipped** across 157 files (+21 tests over D-185's 1728/156); typecheck and lint green; touched-file Prettier clean (`aooSettings.ts`, `pf1eAooFlow.ts`, `e2eHook.ts`, `interactions/index.ts`, the three test files, the spec). `App.svelte` and `SettingsPanel.svelte` remain outside Prettier's reach in this repo's toolchain (no Svelte parser is configured — the same is true of the base files), so their formatting is by hand, matching the surrounding code. Build `dist/index.html` **2,278,996 raw / 656,830 gzip** (+10,621 / +3,318 over D-185's 2,268,375/653,512; budget 6 MB, `pnpm size` OK). `pnpm build:systems`: `pf1e-mass-battles` **rules.js 165.0 kB / 51.0 kB zip** — unchanged: the flow is a UI-side consumer and the option is a core settings read, so the strategic rules entry is untouched by this slice. 10k scale gate 4.81 s under the full-suite load (run alone: 3.40 s; D-185 measured 2.43 s, D-184 2.19 s — the gate's budget is unchanged and it passes; the variance tracks the sandbox's load, not a code change, and the scale test's own budgets are untouched).

## D-187 — 2026-09-12 — P06: the manual prompt — the table takes the attacks it wants, one creature at a time

**Decision.** D-186 made auto-resolution the default; this slice is the other half — the worlds that turn it off get a real **prompt**, not a log line. A drag that provokes is now held in *both* modes: the GM is asked per reactor ("Strike" / "Let it pass"), and the move is submitted when the last creature has been answered — or immediately when the GM forgoes the lot. The queue already decided that these creatures *may* react (D-185); the prompt decides what the table actually does, and every "Strike" runs the same resolution the automatic path runs, narrowed to that reactor's interrupts, spending that reactor's ledger.

**Why the state machine is its own pure module.** `src/ui/combat/pf1eReactionPrompt.ts` holds rows, settledness and the per-reactor narrowing as data in / data out (`openReaction`, `pendingRows`, `decideReactor`, `forgoReaction`, `isSettled`, `opportunityForReactor`, `forgoLines`, `pendingReactionKey`). A prompt whose rows and constraints live in a component is a prompt whose bugs only a human dragging a token will find; keeping it pure means the interesting questions — does answering one creature leave the others pending? does a second click double-count? does a row resolve only its own interrupts? — are unit tests. The component then only holds the current value, calls the flow on "Strike", and commits when the machine says settled.

**The rules the prompt is built on.** *"You may make an attack of opportunity"* (AoN 102) — the reaction is **optional**, so "Let it pass" answers for every row at once and spends nothing: a table that wants none of it needs one click, not one per creature. *The attack resolves before the mover leaves the square* — so the prompt holds the move: `pendingReaction` carries the pending queue and `pendingCommit` is the same deferred Op D-186 added to `onTokenMove`, submitted only once the prompt settles. *The budget is per round and per combatant* — so a strike spends through `spendAttackOfOpportunityAuthorized` exactly as the automatic path does, hit or miss, and a reactor whose ledger refuses is reported with `aooRefusal`'s own words. A third answer exists because the table needs it: **"Stay put"** drops the held move entirely — the token keeps its committed square and nothing was spent.

**Named limits.** (1) The prompt holds one move at a time: `pendingReaction` is a single value, and a second drag while a prompt is open replaces it (the first move is dropped un-committed — its token never moved, so nothing is inconsistent, but the GM's first decision is lost). (2) A scene change (a switch, an undo) drops the prompt rather than resolving against another scene, and says so. (3) Striking resolves the *whole* of that reactor's queued interrupts for the move, not one interrupt at a time: the queue dedupes per (reactor, action) so this is one attack in practice, but a caller that queued several for one reactor gets them all. (4) There is no "strike with a different attack line" — the flow picks the reactor's first melee line ("a single melee attack", D-186). (5) The prompt is GM-side: players see the resolution cards, not the question.

**Verification.** 17 new tests. `tests/ui/pf1eReactionPrompt.test.ts` (6): rows are the seam's reactors in the seam's order with their budgets; answering one leaves the others pending and settling drops the rows (and a second click is idempotent); a row covers only its own reactor's interrupts while the scene's own facts travel with the narrowed verdict; a reactor the queue deduped away is never asked about and does not block settling; forgo answers everyone with the seam's wording and answers nobody twice; an empty queue is settled from the start. `tests/ui/pf1eAooFlow.test.ts` gained the planner distinction (off **with** an encounter now holds and asks; off **without** one still reports, since nothing could be spent). `tests/app/pf1eOpportunitySurface.test.ts` gained a real two-reactor sequence on a booted host: the first strike moves only that creature's ledger, the second resolves against the hit points the first left behind (`hpBefore` of the second equals `hpAfter` of the first), and the machine settles only when both rows are answered. `e2e/pf1e_opportunity.spec.ts` gained 3 browser tests that drive a **real canvas drag** (the stage's `fitRect(2000×1500)` camera, the projection the sheet specs already use): the move is held (the token is still on its square) while the prompt shows the fighter's line, striking spends the ledger and only then moves the token, "let it pass" moves it with no spend and logs the refusal, and "stay put" leaves everything untouched — collected by `playwright test --list` (**327 tests in 38 files**, was 318/38), **not executed** (no Chromium in this sandbox — D-182's record stands). Mutation checks, all red, all restored from fresh backups with `diff` verified identical: decided rows ignored (2 red), forgo answering only the first reactor (1), a row covering the whole queue (1), settledness as "any" instead of "every" (2), and the prompt mode never triggering (1).

**A process note, recorded because it cost time.** The mutation backup for `pf1eAooFlow.ts` was taken *before* the planner gained its `mode` field, and restoring it after the last mutation silently reverted that edit; the focused suite caught it (4 red) and the edit was reapplied. Backups must be taken immediately before the mutation they undo — the trap this repo has hit before with patch anchors.

**Evidence.** Unit **1757 passed / 3 skipped** across 158 files (+8 tests, +1 file over D-186's 1749/157); typecheck and lint green; touched-file Prettier clean. `App.svelte` remains outside Prettier's reach in this toolchain (no Svelte parser configured), so its markup and styles are by hand, matching the file. Build `dist/index.html` **2,283,277 raw / 658,013 gzip** (+4,281 / +1,183 over D-186's 2,278,996/656,830; budget 6 MB, `pnpm size` OK). `pnpm build:systems`: `pf1e-mass-battles` **rules.js 165.0 kB / 51.0 kB zip** — unchanged: the prompt is app-side UI over the same rules. 10k scale gate 2.48 s.

## D-188 — 2026-09-12 — P06: one decision at a time — a second provoking drag is refused, never substituted

**Decision.** The prompt (D-187) holds one move, and the auto-resolver (D-186) resolves one queue; this slice closes the gap between them with an explicit *busy* state. `planHeldMove` gains a `held` input — `"prompt"` while a manual prompt is open, `"resolving"` while an auto-resolution's rolls are in flight, `null` otherwise — and, when `held` is set and the base plan would have been `"auto"` or `"prompt"`, returns a new `"busy"` plan instead. The app maps that to `"cancel"` (the mover stays on its committed square), leaving the open decision exactly as it was. Report-only moves (no encounter, nothing to spend) are never refused: there is no decision to protect. The busy reason is a concrete line, not a code — *"an attack of opportunity is already pending — answer it before another move provokes"* / *"…already being resolved — try the move again when it is done"* — so the log tells the GM *why* the second drag did nothing.

**Why `resolvingAoos` is not reactive.** The auto-resolution flag is read only inside the drag handler, never rendered; making it `$state` would only buy a re-render nobody reads and risk a stale-render's value inside the handler. It is a plain `let`, set true before `resolveMovementOpportunities(…)` and cleared in `.finally()`.

**Verification.** 5 new tests in `tests/ui/pf1eAooFlow.test.ts`: a held `"prompt"` forces `"busy"` with the prompt reason; a held `"resolving"` forces `"busy"` with the resolving reason; a report-only move is never refused; `held: null` returns the base plan; and every base plan now carries `busyReason: null`. The browser spec `e2e/pf1e_opportunity.spec.ts` gained a three-token `busyScene`: the goblin's drag provokes only the fighter, and a second drag (the fighter stepping down a row, which would provoke goblin2) while the first prompt is open is refused — the goblin stays on `(50,50)`, the first prompt still names only the fighter, a notification says *"already pending"*, and striking still moves the goblin to `x = 450`. **Executed** (not merely collected) against the Chromium workaround — see D-189.

**Evidence.** Unit **1764 passed / 3 skipped** across 158 files (+7 tests over D-187's 1757, from the 5 planner tests and 2 token-snap tests); typecheck and lint green; build `dist/index.html` **2,284,254 raw / 658,387 gzip** (budget 6 MB, `pnpm size` OK). See D-189 for the browser-suite numbers, which now include this test at 14/14.

## D-189 — 2026-09-12 — Executed Chromium: the P06 browser suite runs, and the first execution repaired four authored-but-unexecuted defects plus two real bugs

**The workaround, confirmed.** D-119 and D-182 recorded that Playwright's CDN and the Debian mirrors are unreachable in this sandbox, and that `@sparticuz/chromium@152.0.0` (npm, reachable) could supply a binary. That route is now **proven end to end**, and the exact recipe is worth pinning: install the package somewhere outside the repo (`npm i @sparticuz/chromium@152.0.0`), inflate its `chromium.br` → a binary (use the package's own `build/lambdafs.js` `inflate`), inflate `al2023.tar.br` → `/tmp/al2023/lib`, then run with

```
LD_LIBRARY_PATH=/tmp/al2023/lib \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/chromium \
pnpm exec playwright test e2e/pf1e_opportunity.spec.ts --project=chromium --workers=1
```

The binary is Chromium 152.0.7977.0; every library resolves from the AL2023 dir (`ldd` shows nothing missing — no locally compiled stubs were needed this time, unlike D-181's note). `playwright.config.ts` already honours `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for the chromium project, so no config change was required. Firefox/WebKit remain unexecuted (D-082).

**What the first real execution found.** `pf1e_opportunity.spec.ts` had been authored across D-186/D-187/D-188 as *collected, not executed*. Running it exposed four spec defects and two genuine product bugs:

1. *Wrong surface.* `reaction` and `notifications` are installed on the **gm** surface (`installGmFogE2e`), but the spec's `reactionPrompt` helper and two `notifications` reads hit the **app** surface — `app.reaction is not a function`. Fixed in `e2e/lib.ts` (the `surfaceCall`/`waitForSurface`/`surfaceCallArg` unions now include `"gm"`, plus a `gmCall` export) and in the spec (helpers read `gm`).
2. *One test authored two scenes.* The app persists a world across `page.goto`, so a second `sceneWith` in the same test re-used the first scene's tokens (the Large ogre never landed; a leftover Medium guard answered instead). Split into two single-scene tests — each Playwright test already gets a fresh context.
3. *The prompt showed `used: null / max: null`.* `onTokenMove` built the queue without the encounter's ledgers, so `pf1eMovementOpportunities` could neither display a reactor's budget nor refuse a spent one. `App.svelte` now reads `combatantForToken` + `attackOfOpportunityBudget` for the active encounter and hands the seam a token-id → `{used, max}` map; the D-187 rows now show `0/1` and the seam refuses reactors that already spent their one opportunity.
4. *Token drags snapped centres to intersections.* The canvas's `dragTarget` used `snapPoint`, which snaps square-grid points to grid **intersections** (correct for rulers/pings, wrong for a token whose `x`/`y` is its **centre** — `tokenRect` halves `width`/`height`). A drag to cell (4,0) therefore landed the centre on the corner (500,100), and `cellsAlongSegment` cut a diagonal through (3,1), queueing a phantom goblin2 reactor and failing the D-188 refusal test. New `snapTokenCenter` (square → nearest cell centre, hex → hex centre — which hex already did — gridless → unchanged) is now what `dragTarget` uses; `snapPoint` stays for rulers/pings.

**Verification.** `e2e/pf1e_opportunity.spec.ts` **14/14 passed** in Chromium (was 9/13 collected-not-run, then 11/14 after the surface split and before the two product fixes). New unit tests: `snapTokenCenter` in `tests/canvas/grids.test.ts` (2), and `tests/canvas/interactions.test.ts`'s drag-target test re-pinned to cell-centre snapping with its four controller-level drag expectations updated accordingly. Full unit suite **1764 passed / 3 skipped, 158 files**; typecheck and lint green; `pnpm build` 2.46 s → 2,284,254 raw / 658,387 gzip (budget 6 MB, OK).

## D-190 — 2026-09-12 — P06: tactical action triggers — casting and ranged-touch provokes run the movement queue

**Decision.** P06's queue had been consumed by movement (D-184/D-185) but `actionTrigger` and `rangedTouchTrigger` had no tactical caller. This slice gives non-movement provokes the same seam, and — the seam-shape decision — it is **App-level and pure, mirroring the move seam** rather than a cast-flow input. `src/packages/pf1e/actionOpportunity.ts` exports `pf1eActionOpportunities(input)`: it reads the trigger out of Table 7-2 via `actionTrigger` (a `no` row such as total defense, an unknown action, and a `usually`/`maybe`/`varies` row are each refused *by name* — the table's own note is the product's language, never a guess), or takes `rangedTouchTrigger`'s kind when the caller states it (AoN 133: a ranged touch provokes even from a defensively cast spell). It then tests the provoker's **occupied** squares — not a walked path — against each reactor's `threatenedCells` (the same `pf1eThreatModel` composition the movement seam, the flanking overlay and the sheet read), applies the ledger filter with `aooRefusal`'s own wording, and queues through `queueAoOs`.

**Why the provoker's square rides the interrupt.** AoN 102 resolves the attack before the action continues, so the provoker is struck where it stood. The movement interrupt already carried `left`; action interrupts now carry `at` — a new field on `PF1eAoOTrigger` (`src/packages/pf1e/interrupts.ts`) — set per reactor to the square that reactor actually threatens (a multi-square caster flanked from two sides records two honest squares). That keeps the queue self-describing: a resolver needs no geometry of its own, which is what lets the movement resolver and the action resolver share one core.

**Why the resolver is shared, not forked.** `resolveMovementOpportunities` in `src/ui/combat/pf1eAooFlow.ts` was a loop over `input.opportunity.queued`; nothing else in it was movement-specific except the logged square (`trigger.left`). The loop is now `resolveQueuedInterrupts` — order the queue (initiative, ties in insertion order), roll each reaction through the sheet's own `resolveAttackFlow` (same roll protocol, threat/damage/mitigation/HP write, same public card), spend the reactor's ledger hit-or-miss, report — and both `resolveMovementOpportunities` and the new `resolveActionOpportunities` delegate to it, differing only in the square (`trigger.left ?? trigger.at ?? null`). The entry/result types were renamed `OpportunityResolution{Entry}` to stop pretending an action AoO is a movement AoO; `resolutionLines` reads the renamed type. The one-per-round, melee-only, flat-footed-until-first-turn rules are unchanged because they are shared now, not duplicated.

**What is wired now, and what is named as next.** The first consumer is the app's e2e surface (`e2eHook.ts`): `pf1eActionOpportunity` and `pf1eActionOpportunityResolve` mirror the movement surfaces, driving the pure seam and the resolver against a **real booted host** (real ops, real rolls, a real ledger spend). That makes `actionTrigger`/`rangedTouchTrigger` live end to end. The product-UI cast path is the *next* slice, and the seam is shaped so that slice is thin: the cast and attack flows are sheet-scoped (actor documents + the linked combat) and carry no scene-token geometry, so the sheet will build the opportunity by calling `pf1eActionOpportunities` with `client.store` scene facts — exactly the call `App.svelte`'s `onTokenMove` already makes for movement — and then report or resolve it. Casting-defensively and the quickened swift-cast exemption stay the caller's (C03a's gate and the flow's swift path already own them); this seam queues every eligible reactor and never invents an exemption the rules do not state.

**Verification.** 18 new tests, all hand-derived from the rule text. `tests/packages/pf1eActionOpportunity.test.ts` (10): a cast in a threatened square queues the reactor with `trigger.at` at the caster's square and the world-rect highlight list; a `no` row refuses by name (`ok: true` — a decision, not a scene failure); an unknown action and a `maybe` row refuse with the table's own words; the ranged-touch trigger is its own kind; a reactor that does not threaten the caster's square never reacts; a spent ledger refuses with `aooRefusal`'s wording and the reactor's line says *forgoes*; hostility filters (`isEnemy`) and the absent-hostility default is named; a missing provoker refuses by name; a cast and its ranged touch are two distinct `actionId`s so a Combat Reflexes reactor is offered both (AoN 102's two opportunities); `actionProvokeLines` reads reactors and refusals and names the assumption. `tests/packages/pf1eInterrupts.test.ts` +1: an interrupt keeps its `at` square and a ranged-touch states its kind. `tests/ui/pf1eAooFlow.test.ts` +3: a cast trigger resolves through the shared core and reports the **occupied** square (`{x:0,y:0}`, not a walked-out one) with the exact card/HP/ledger ops; no encounter → `needsEncounter` with the caller told; a ranged-only reactor skips without spending. `tests/app/pf1eOpportunitySurface.test.ts` +4 on a real booted `HostApp`: a cast queues the reactor reading size off the authored actor document; a `no` row refuses and a ranged touch is its own kind; a non-threatening reactor is not queued; and the resolve pipeline rolls through the host, writes HP, spends the ledger and satisfies `damage === hpBefore − hpAfter`. `e2e/pf1e_opportunity.spec.ts` +2 browser tests, **executed** (not merely collected) through the D-189 Chromium workaround: a cast in a threatened square queues the reactor in the occupied square, and a `no` row refuses by name while a ranged touch is its own kind — the whole spec now runs **16/16 passed (15.5 s)**.

**Evidence.** Unit **1782 passed / 3 skipped** across 159 files (+18 tests, +1 file); typecheck and lint green; build `dist/index.html` **2,295.05 kB / gzip 666.22 kB**; `pnpm size` **2,295,058 bytes (2.189 MB) raw / 660,936 bytes (0.630 MB) gzip** — within the 6 MB raw budget. No strategic-rules change: the seam and resolver are app-side consumers of the existing queue, so `pf1e-mass-battles` rules output is untouched.

## D-191 — 2026-09-12 — P06: the cast provoke is wired to the action seam, and the AoO budget gates before the die

**Decision.** D-190 left the seam App-level and named the cast path as the next slice; this slice closes it. `src/ui/combat/pf1eCastProvoke.ts` is the sheet-scoped glue: `castProvokes(input)` decides which triggers one declared cast earns — Table 7-2's `cast-spell` unless the cast is swift/free (a quickened spell is a swift action, AoN 158) or cast defensively (the C03a check *replaces* the opportunity), plus AoN 133's ranged-touch *regardless of defensiveness* — and `resolveCastProvokes(...)` reads the active scene and the actor documents out of the store, builds the action opportunity through `pf1eActionOpportunities` with the encounter's per-combatant ledgers, and either auto-resolves it (`resolveActionOpportunities`) or returns the report lines. The module returns `{ lines, damage }` and stays pure of Svelte: the sheet calls it, then threads `damage` into the cast gate's `injured` declaration — `concentrationDc` turns that into exactly `10 + damage + level` (AoN 133) — and appends `lines` to the cast warning.

**Why two provokes share one queue.** A ranged-touch spell provokes twice (cast + touch, two distinct opportunities — AoN 102's "…each time" reading). `pf1eActionOpportunities` gained an optional `queue` input so the second call appends to the first call's queue instead of starting fresh, keeping the per-(reactor, action) dedupe honest across the two distinct `actionId`s. And the resolver gained the **pre-roll budget gate**: a reactor whose ledger is already spent is `skipped` with `aooRefusal`'s own wording (`no opportunities left (1/1)`) *before any d20 is rolled*. That is what makes "one attack of opportunity per round" a gate and not a post-hoc ledger refusal: the first provoke's spend is already reflected in the combat the second provoke reads, so a 1/round reactor that would otherwise be queued twice is refused on the second entry with no attack made and nothing written.

**What moved in the seat.** `PF1eActorSheet.svelte`'s `castAtTarget()` now builds `castProvokes(...)` from the cast fields it already owns, and when the caster is a linked combatant token, calls `resolveCastProvokes` with the world option (`autoResolveAoosOf(worldSettingsFrom(settings))`) and the linked combat, feeding any provoke damage into the concentration declarations and appending the provoke lines to the cast warning. The app's e2e surface gained `pf1eCastProvoke`, which drives the same glue against a real booted host so a browser proves the store-read path and the shared queue, not a re-implementation.

**Semantics changed, not just added.** The pre-roll gate replaced the D-186 behaviour for an already-exhausted reactor: it is now *skipped before the roll* rather than rolled and then refused on the ledger write. The D-186 e2e assertion that expected an entry carrying `ledgerError` ("the ledger was not written") now expects the skip, and the movement-path unit test that asserted the old shape was replaced by the gate test. (The App's movement path already filters exhausted reactors out of the queue, so that path is unaffected in practice — the gate only ever fires on a stale or shared queue.)

**Verification.** `tests/ui/pf1eCastProvoke.test.ts` (11): `castProvokes` — standard/full-round/longer provokes, swift/free/quickened and defensively provoke nothing, a ranged touch provokes even when defensive, a melee touch adds no trigger of its own; `provokeDamageTaken` sums only the caster's damage; and `resolveCastProvokes` — an auto-resolved provoke rolls through the host and returns the caster's damage; a non-threatened caster reports nothing; no encounter reports, never resolves; and the cast + its ranged touch share one queue so a 1/round reactor rolls exactly one attack. `tests/ui/pf1eAooFlow.test.ts` adjusted for the gate: the two-provoke test now asserts one attack die was rolled, and the Combat Reflexes test authors the feat on the **actor** (the budget derives `aooPerRound` from it — D-183 — not from the ledger flag). `e2e/pf1e_opportunity.spec.ts` +3 browser tests, **executed**: a cast auto-resolves before the spell lands (real roll, HP moves, ledger spent, damage = HP lost); the cast and its ranged touch share one queue (1/round reactor refused on the second, `no opportunities left (1/1)`); and a swift cast provokes and spends nothing — the whole spec now runs **19/19 passed (17.0 s)**.

**Evidence.** Unit **1795 passed / 3 skipped** across 160 files (+13 tests, +1 file); typecheck and lint green; build `dist/index.html` **2,298.77 kB / gzip 667.53 kB**; `pnpm size` **2,298,773 bytes (2.192 MB) raw / 662,064 bytes (0.631 MB) gzip** — within the 6 MB raw budget.

## D-192 — 2026-09-12 — P06: the ranged-attack provoke — and the cast glue generalises to the action provoke

**Decision.** D-191 closed the cast path; the other half of Table 7-2's action triggers is the **ranged attack** (`attack-ranged`: yes — shooting while threatened draws an attack of opportunity, resolved before the shot). Because the resolver D-191 built was already generic (it takes a list of `{ actionId } | { trigger }` and reads the scene out of the store), the slice was a generalisation, not a fork: `src/ui/combat/pf1eCastProvoke.ts` became `src/ui/combat/pf1eActionProvoke.ts`, `resolveCastProvokes` became `resolveActionProvokes`, and the cast-specific types were renamed `PF1eActionProvoke`/`ActionProvokeClient`/`ActionProvokeResolution`. `castProvokes` stays (it is the cast's "which provokes" decision), and a new `rangedAttackProvokes()` returns exactly `[{ actionId: "attack-ranged" }]` — a melee line is the `attack-melee` row (provokes: no), so no helper is needed there, and the unarmed provoke stays the resolver's own P6 note, not this slice's.

**What moved in the seat.** `PF1eActorSheet.svelte`'s `resolveVsTarget` and `resolveManyshotVsTarget` now resolve the provoke *before* the attack when the line is ranged: the sheet's `provokerTokenId()` (the linked combatant's scene token, the same lookup the cast path uses) feeds `resolveActionProvokes`, and the provoke lines surface in a new `resolveWarning` note next to `resolveError` — the shot still goes through whatever the reactor's strike did (no concentration check for a mundane attack), exactly as the rules want. The cast path was refactored onto the same `provokerTokenId()` helper rather than re-deriving the combatant inline. The app's e2e surface `pf1eCastProvoke` became `pf1eActionProvoke`, taking either an explicit Table 7-2 `actionId` or cast facts.

**Verification.** `tests/ui/pf1eActionProvoke.test.ts` (renamed) +2: `rangedAttackProvokes` returns the one `attack-ranged` provoke, and a ranged attack resolves through the row and returns the shooter's damage. `e2e/pf1e_opportunity.spec.ts` +1 browser test, **executed**: a ranged attack provokes on the `attack-ranged` row and auto-resolves before the shot (real roll, HP moves, ledger spent) — the whole spec now runs **20/20 passed (20.7 s)**.

**Evidence.** Unit **1797 passed / 3 skipped** across 160 files (+2 tests, file renamed); typecheck and lint green; build `dist/index.html` **2,299.59 kB / gzip 667.69 kB**; `pnpm size` **2,299,596 bytes (2.193 MB) raw / 662,234 bytes (0.632 MB) gzip** — within the 6 MB raw budget.

## D-193 — 2026-09-12 — P07: delay & ready as pure transitions — initiative, triggers, and the exploit guards

**Decision.** P07 ("delay/ready execution and UI: triggers, interrupt resolution, initiative adjustment, unused/lost actions and re-ready; prevent extra-turn/action exploits") is large enough to split. This first slice lands the **state and legality** of both actions as pure `(combat) → combat` transitions, leaving the CombatPanel buttons and the live trigger-evaluation UX for the next slice. The Gap List §4 item 11 named the hole precisely: `core/combat.ts:176 delayCombatant()` only flags a combatant as skipped, there is no ready at all, and `orderInterrupts` has no ready-vs-AoO precedence. All three are now closed at the model layer.

**The module.** `src/packages/pf1e/readyDelay.ts` (new, pure — no dice, no Pixi, exactly like `combatState.ts`):
- `delayTo(combat, combatantId, initiative)` — the current combatant's initiative *permanently* becomes the chosen lower count, the order re-sorts, and `combat.turn` points at whoever acts next. Refused by name when not current, when the count is not lower, not a whole number, or does not actually move the combatant later; refused during the surprise round (single action only) and before the encounter starts.
- `readyCombatant(combat, combatantId, { action, trigger })` — spends the standard action (the ready itself does not provoke, AoN 201) and stores `flags.pf1e.ready`; the prepared action is restricted to standard/move/swift/free (never full-round), and a second ready on the same combatant is refused.
- `resolveReady(combat, readiedId, triggererId)` — the readied combatant's initiative becomes `triggerer.initiative + 1` (immediately ahead), the ready is spent, `combat.turn` points at the readied combatant so the action resolves *now*, and the prepared action is returned for the caller to execute. Refused on an initiative collision that would leave the combatant anywhere but immediately ahead (ties are the table's to break, so the model refuses rather than silently misplacing).
- `findReadied(combat, event)` — the trigger-evaluation helper: matches by trigger kind and an optional `targetId` scope; a `custom` trigger is GM-judged, as the SRD leaves it ("the trigger… is whatever you specify").

**State round-trip.** `readCombatantState`/`PF1eCombatantState` gained `ready` (defensive `readReady`, degrading to null on a half-written flag — the same contract as `readActionLedger`), so every existing writer (`withCombatantState`, now exported) round-trips it instead of clobbering it. `pf1eNextTurn` clears an unspent ready when the combatant's next turn starts (`ready.sinceRound < core.combat.round`): the trigger never came, the action is lost, and re-ready is allowed — the checklist's "unused/lost actions and re-ready".

**Interrupt resolution.** `interrupts.ts` grew a second `PF1eInterruptKind` — `"readied-action"` — plus `queueReadiedAction` and the ready-before-AoO ranking in `orderInterrupts` (the rank is applied first, so a readied action can never be overtaken by an opportunity the triggered action then provokes). This is the "ready-before-trigger ordering" P06 left open.

**Exploit prevention, by construction.** Core's `combat.turn` indexes the sorted order; both transitions re-sort and re-point the turn so no combatant is revisited in the round it left. The test "the delayer is visited exactly once" walks the whole round and asserts the wrap hands the turn back to the *next* combatant, never the delayer twice.

**Named as next, not hidden.** Effect-duration ticking at the moment of a delay (the delayer's turn ends, so its durations should tick) is not re-implemented here — `delayTo` emits `combat:turn:end` for semantics but the tick itself stays core's; the UI slice will route a delay through the same tick `nextTurn` performs. The CombatPanel wiring (a real "Delay"/"Ready" control instead of the metadata-only "Mark delayed" button) and the live trigger-evaluation prompt are the next slice.

**Verification.** `tests/packages/pf1eReadyDelay.test.ts` (24): delay changes initiative permanently and hands the turn to the next actor; the delayer is visited exactly once with the round wrapping back to the next actor; every refusal asserted by its exact string (not current, not lower, non-integer, no-move-later, surprise, not started). Ready spends the standard action and stores the trigger; full-round/`start-full-round` prepared actions, a spent standard, a second ready and a non-current combatant all refuse by name. `resolveReady` moves the combatant immediately ahead, spends the ready, points the turn, refuses collisions/self-interruption/defeated. `findReadied` matches by kind and honours the `targetId` scope. `pf1eNextTurn` loses a carried-over ready at the next turn and keeps a same-round ready. Interrupt ordering: a queued readied action ranks before a higher-initiative AoO, and one ready per combatant dedupes.

**Evidence.** Unit **1821 passed / 3 skipped** across 161 files (+24 tests, +1 file); typecheck and lint green; build `dist/index.html` **2,300.39 kB / gzip 667.90 kB**; `pnpm size` **2,300,398 bytes (2.194 MB) raw / 662,429 bytes (0.632 MB) gzip** — within the 6 MB raw budget. No strategic-rules change; the ready state lives entirely under `combatant.flags.pf1e`, so the mass-battle rules output is untouched.

## D-194 — 2026-09-12 — P07: delay & ready in the combat tracker — the controls, the duration tick, and the browser proof

**Decision.** D-193 landed the pure transitions; this slice wires them into the product and closes the two items D-193 named. `CombatPanel.svelte` now has real Delay / Ready / Fire-ready controls on the current combatant's row (the metadata-only "Mark delayed" button stays, but only for non-PF1e encounters, where core's marker is still the right behaviour — the `e2e/combat.spec.ts` round-wrap test still passes on it). The handlers call `delayTo`/`readyCombatant`/`resolveReady` and route the result through the same `push` every other tracker control uses, so a refusal surfaces as the panel error verbatim and a success writes the same `combats` update op.

**The duration tick.** A combatant that delays ends its turn on the spot, so its effect durations must tick. `src/core/combat.ts` exports `endTurnEffects(combat, ownerId)` — the existing `tickEffects` core, repackaged so a caller can end one turn without advancing the round — and `delayTo` now applies it to the delayer and appends `combat:effect:expire` for each expiry, alongside the existing `combat:turn:end`/`combat:combatant:delay` hooks. Because `ReadyDelayTransition` is now literally core's `CombatTransition` (it gained `expired`), the tracker's `push` accepts a delay unchanged.

**The UI shape.** The ready/delay forms are inline row forms, not a modal — one form at a time, cancelled by clicking the same button again. Delay prefills `initiative − 1` and the GM edits it; Ready takes an action kind (standard/move/swift/free), a trigger kind (attack/move/cast/custom), an optional target and a free-text note; Fire-ready takes the combatant to interrupt (pre-filled with the current actor). A `readied` badge shows on a combatant carrying `flags.pf1e.ready`, and firing sets a status line ("…'s readied standard action fires — resolve it now") so the GM knows to execute the returned action through the normal flow. This is the "live trigger-evaluation prompt" D-193 deferred, in the tracker's own idiom: the GM is the trigger-evaluator (the SRD leaves the trigger to the table), and the rules enforce everything else.

**Verification.** `tests/packages/pf1eReadyDelay.test.ts` +1: a delay ticks only the delayer's timed effect (2 → 1) and leaves an untimed effect and every other combatant's flags untouched. `e2e/pf1e_ready_delay.spec.ts` (new, **executed** in Chromium): two bestiary tokens, hand-set initiatives (20/10), then — Delay drops the infantry to 5 and the cavalry acts next; Ready spends the cavalry's standard (the budget chip flips to "Std ✓") and shows the `readied` badge; Next turn; Fire-ready moves the cavalry to 5+1, puts it ahead of the infantry in the order, clears the badge, and shows the fired note. `e2e/combat.spec.ts` (3), `e2e/sheets.spec.ts` (10) and `e2e/pf1e_opportunity.spec.ts` (20) all still pass — the tracker and the interrupt-ordering change are regression-clean.

**Evidence.** Unit **1822 passed / 3 skipped** across 161 files (+1 test); typecheck and lint green; build `dist/index.html` **2,309.28 kB / gzip 670.23 kB**; `pnpm size` **2,309,283 bytes (2.202 MB) raw / 664,716 bytes (0.634 MB) gzip** — within the 6 MB raw budget. No strategic-rules change; the controls are app-side over the existing queue and the `flags.pf1e.ready` state.

## D-195 — 2026-09-13 — P07: the fired readied action resolves through the sheet's own attack flow

**Decision.** D-194's fire-ready control reordered initiative and handed the GM a status note; this slice closes the loop the note named, so "the readied action resolves just before the trigger" is a fact rather than a suggestion. `src/ui/combat/pf1eReadyAction.ts` (new) is the orchestration — `resolveReadiedAction(input)` calls the pure `resolveReady` first (reorder + spend the ready + `combat:combatant:ready:resolve` hook), then, when the prepared action is a **standard attack**, resolves it against the triggerer through the sheet's own `resolveAttackFlow` (the same resolver the sheet and the attacks-of-opportunity path use): the combatant's **primary melee attack** (`meleeLine`, now exported from `pf1eAooFlow.ts` — a readied attack is a single attack), the attack labelled `"— readied action"`, the provoker **defending normally** (a ready does not impose flat-footedness — that state is surprise/first-turn, not "was readied against"), and **no budget spent** (the standard action was already paid at `readyCombatant`). The resolver returns `{ combat, hooks, lines, damage, resolved }` and the panel pushes the reordered combat; the HP write happens inside `resolveAttackFlow` before the caller finalizes the reorder, exactly as the AoO resolver does.

**The hand-offs.** Every path that cannot actually resolve reports by **name** and leaves the reorder standing (the combatant is current, so the GM finishes it through the normal flow): a move/swift/free ready ("…'s readied move action fires — resolve it now (trigger: …)"), a missing scene/token/actor document, and a ranged-only combatant (a readied attack resolves as the primary *melee* attack, so it is never silently given a melee strike). `CombatPanel.svelte`'s `doFireReady` awaits the resolver, surfaces `outcome.error`, and writes `firedNote` — the resolved case reads "…'s readied standard action fires — <attack line>", the hand-offs keep the D-194 line shape.

**The trigger matcher, surfaced.** D-193's `findReadied` finally has a product consumer. The fire form (opened by "Fire ready" on a readied combatant's row) now declares the trigger **event** the way the SRD's "the trigger is whatever you specify" works: a kind (attack/move/cast/custom, prefilled from the stored ready's own trigger) plus the combatant to interrupt. The form runs `findReadied(combat, { kind, triggererId })` live and shows the verdict before the GM confirms — "✓ …'s readied standard action matches this attack trigger — it fires just before X" (`data-fire-match`) or "✗ …'s readied standard action is armed for cast, not this attack event" (`data-fire-mismatch`), plus any *other* readied combatants the same event matches. Firing stays the GM's call (the SRD leaves the trigger to the table), but the matcher's answer is now visible and asserted in the browser.

**Verification.** `tests/ui/pf1eReadyAction.test.ts` (new, 4 tests) drives the resolver against scripted rolls with the `pf1eActionProvoke` fixture shape: a hit rolls, writes HP, spends the ready and reorders; a move ready reorders without rolling; a ranged-only ready is handed off by name; and a combatant with no readied action is refused. The e2e surface gained `pf1eReadyFire` (authors a standard-attack ready scoped to the triggerer through `withCombatantState`, then runs the resolver against a real booted host and submits the reordered combat), and `e2e/pf1e_ready_fire.spec.ts` (new, **executed** in Chromium) proves the resolution end to end: a real d20, the HP write (`damage = hpBefore − hpAfter`, the same invariant the D-186 AoO spec asserts), a public card labelled "— readied action", the ready cleared, and the initiative at triggerer+1; a second test proves the ranged-only hand-off. `e2e/pf1e_ready_delay.spec.ts` now asserts the tracker's fired note in its resolution shape **and** the fire form's match → mismatch → match surface.

**Evidence.** Unit **1826 passed / 3 skipped** across 162 files (+4 tests); typecheck and lint green; build `dist/index.html` **2,315.62 kB / gzip 672.40 kB**; `pnpm size` **2,315,627 bytes (2.208 MB) raw / 666,931 bytes (0.636 MB) gzip** — within the 6 MB raw budget. e2e `pf1e_ready_delay` (1), `pf1e_ready_fire` (2), `combat` (3), `sheets` (10), `pf1e_opportunity` (20) all pass in Chromium. No strategic-rules change: the resolver is app-side over `resolveReady` + `resolveAttackFlow`.
## D-196 — 2026-09-13 — P04: positional defenses through the resolver — cover, concealment, the pair seam, and AoN 181's AoO exclusion

**Decision.** P04's remainder lands as three layers, each pure and separately tested. (1) `pf1e/positional.ts` (new) is the geometry: AoN 181's **cover** measured corner-line by corner-line (all 16 attacker-corner→defender-corner lines per square pair, the attacker's best square deciding per "Big Creatures and Cover"), with proper crossings, wall-endpoints-strictly-inside and collinear overlaps blocking while a wall that merely *touches* a line's own endpoint does not ("crosses" is not "starts on"); creatures block as **soft** cover at range or for non-adjacent melee (a reach weapon uses the ranged rules, AoN 181) and never produce total cover; low obstacles (half-height walls) cover within 30 ft unless the attacker stands closer to them than the target; and the grades fold as partial +2 / soft +4 / standard +4 / improved +8 / total = refusal ("You can't make an attack against a target that has total cover"). **Concealment** (AoN 182) is the non-stacking collapsed miss chance with `concealmentGrade`. AoN 181/182 are transcribed verbatim into the module header — the code is the citation. (2) `resolve.ts` threads it: `PF1eResolveAttackInput.positional` (`{cover?, concealment?}`) folds the cover grade into the effective AC (`COVER_AC_BONUS`, `total` refuses before the AC comparison), and a live miss chance on a **hit** demands `concealmentDie` (the d% face, 1–100): `die ≤ percent` is a miss with zero damage and unchanged HP — including on a natural 20 or a confirmed critical, because the nat-20 rule speaks to the attack roll versus AC while the miss chance is a separate roll (rationale documented at the fold). `prepareAttack` returns `needsConcealmentRoll {percent,label}|null` so the flow rolls the d% *before* the damage formula. (3) `threatPreview.ts` gained `pf1ePairPosition` — the one-call pair seam (distance, adjacency, reach with refusals, flanking via the model, cover, concealment) the sheet and the tests share.

**AoN 181's AoO exclusion, wired both ways.** "You can't execute an attack of opportunity against an opponent with cover" is now enforced where the queues are built: `tacticalOpportunity.ts` (movement) and `actionOpportunity.ts` (actions) each take `coverWalls` (the scene's sight-blocking segments; **absent is a named default** in `defaults`, never a silent queue-through) and refuse a reactor whose strike carries cover (`kind ≠ none`) with the quoted rule string — the reactor is reported (`forgoes the attack of opportunity — …`) and **not queued**. Defender cells are the seam's own fact: the single left square for movement, all occupied squares for an action; adjacent strikes measure walls only, a >1-square (reach-weapon) strike uses the ranged rules including creatures. Both real callers pass the walls: `App.svelte`'s `onTokenMove` and `pf1eActionProvoke.ts` via `sightSegments(scene.walls)`, as do the `e2eHook` movement/action surfaces (so a spec sees the app's own verdict).

**The position-aware sheet consumer (P04's named remainder).** `ui/sheets/pf1eResolvePosition.ts` (new, pure) reads the active scene (`activeSceneOf` — App.svelte's own lookup as a function), links actor→token, builds threat facts from the linked actors' derivations, and asks the pair seam for the report: `{ok, reason, defense, flanked, hostilityAssumed}` — every unreadable state (no scene, an unplaced pair, an unreadable grid) is a **named** reason, never a guess, and hostility follows the movement seam's contract (the scene's dispositions when every token names one, else a named assumption). `PF1eActorSheet.svelte`'s hand-ticked `Flanking +2` checkbox became the planned **tri-state selects**: Flanking auto/yes/no (auto = the scene's word, folded for melee lines only) and Cover auto/none/partial/soft/standard/improved (auto = the geometry's grade; `partial`/`improved` are AoN 181's GM-discretion grades the corner lines cannot see, so they are hand-set only), plus a derived hint line (`data-pf1e-resolve-position`) that states the pair's facts — "flanked (+2 melee); standard cover; 20% concealment (d% on a hit, AoN 182)" — or the named reason the position could not be read. `pf1eResolveFlow.ts` threads `positional` end to end: total cover refuses **before any die is rolled**, a live hit behind a miss chance rolls its own public `1d100` (the card's chip) before the damage formula, and Manyshot folds the same defenses into every arrow (`PF1eManyshotArrow.concealmentDie`, threaded through both the evolving-state and authoritative compositions).

**Verification.** New/extended suites: `tests/packages/pf1ePositional.test.ts` (23 — the geometry layer, incl. the cover-grading pitfalls: creatures-block-all ≠ total, endpoint-touch, own-cell exclusion, interior-length creature blocking), `tests/packages/pf1ePositionalResolve.test.ts` (16 — cover AC fold, total refusal, d% paths incl. confirmed-crit concealment miss and the missing-die refusal, A.14 prone/higher-ground/helpless with the ranged flag, Manyshot positional threading), `tests/packages/pf1eThreatPreview.test.ts` (+6 pair-seam tests, 22 total), `tests/packages/pf1eTacticalOpportunity.test.ts` (+3, 15 total: cover refusal, clear-lane queue, the named default), `tests/packages/pf1eActionOpportunity.test.ts` (+2, 12 total), `tests/ui/pf1eResolvePosition.test.ts` (new, 10 — lookup contract, flank/cover/total/ranged reads, named failures, hint honesty), `tests/ui/pf1eResolveFlow.test.ts` (+4, 13 total — cover fold + card note, the d% roll's formula order, the let-it-stand d%, total-cover pre-roll refusal); `tests/app/pf1eOpportunitySurface.test.ts` re-pinned for the surfaces' cover facts (12).

**Evidence.** Unit **1890 passed / 3 skipped** across 165 files (+64 tests vs D-195's 1826); typecheck and lint green; build `dist/index.html` **2,329.79 kB / gzip 676.67 kB**; `pnpm size` **2,329,792 bytes (2.222 MB) raw / 671,202 bytes (0.640 MB) gzip** — within the 6 MB raw budget. No strategic-rules change (the mass-battle cover skips remain their own seam). **Remaining for P02/P04:** the threat-overlay canvas layer (the `threatRects` draw list exists; the layer and its trigger do not), `meleeReachLegality`'s consumer, and bestiary `size` authoring — D-197.
## D-197 — 2026-09-13 — P02 closed: the threatened-square overlay, the reach refusal gate, and bestiary size authoring

**Decision.** P02's three named remainders land, and the item closes. (1) **The overlay.** `src/canvas/layers/ThreatOverlayLayer.ts` (new) is the structural twin of D-154's area preview: it draws a red-tinted fill over each threatened cell plus a white ring on the threatening token's footprint, keyed on the draw lists and the zoom bucket, cleared by `sync([], null, …)`. It imports nothing from the package — core canvas stays system-agnostic — and rides the **controls holder** via `stage.getThreatOverlayLayer()` (local selection UI, not a replicated document, so the §9 layer stack above tokens is untouched). The **trigger is the real selection path**: `CanvasController`'s pointerdown selection fires `onSelectionChange`, which calls App's `syncPF1eThreatOverlay` — exactly one selected token draws **its own** entry's `threatRects` (the model's own draw list, never recomputed), no selection / a multi-selection / a token not on the scene clears, and `refresh()` re-syncs on every store update so a moved token re-reads its threatened squares. The e2e surface gained `pf1eThreatOverlayState` (`{tokenId, rectsDrawn, originDrawn}`), and `e2e/pf1e_threat_overlay.spec.ts` (new, **executed** in Chromium) drives real mouse clicks: select → 8 rects for a Medium fighter (cross-checked against `pf1eThreat`'s own count), switch selection, click empty space → clear, and a Large tall creature's 10-ft reach beside a Tiny creature's zero (Table 8-4 through the real derivation).

**The reach refusal gate.** P02's deferred `meleeReachLegality` consumer: `pf1eResolvePositionReport` now carries the pair seam's `reach {canStrike, refusals}` (null for ranged lines — range increments are that seam's), and `PF1eActorSheet.svelte`'s Attack button **refuses before any die is rolled** when a melee line's target stands beyond its reach, with the seam's own sentence ("the target is 10 ft away — the attack line reaches 5 ft"); the hint line says "out of reach (…)" and only the readable-position path gates — without scene facts the hand-set flow stands, exactly as the pre-P02 sheet did. The Manyshot flow is ranged-only and needs no gate.

**Pack content.** `systems/pf1e-core/packs/bestiary.json` authors `size` on all six records — **Large** for Heavy Cavalry, Troll Vanguard and Clay Golem, **Medium** for Heavy Infantry, Siege Bombard and Paladin Hero — so an imported bestiary creature placed on a scene carries its real footprint and reach (Large tall: 2×2 cells, 10 ft) instead of the named Medium default. The three Large blocks keep their published `sizeMod`, which the derivation already honours as the attack/AC *and* CMB/CMD override (the recorded A.4 strategic deviation), so **no published stat moves**: the pack↔profile no-drift pin, the published-AC pin and the pack↔code parity suite all pass unchanged (`compilePF1eProfile` reads only the numeric fields it knows; `size` is a sheet-side fact).

**Verification.** `tests/ui/pf1eResolvePosition.test.ts` +1 (11 total — the reach read: in reach, out of reach with the named gap, null at range); the bestiary suites re-run green (`pf1ePackage` 30, `pf1eActor` 40, sheet model/details/attack editor 106 across five files). `e2e/pf1e_threat_overlay.spec.ts` 2/2 executed; `pf1e_opportunity` (20), `pf1e_flanking` (5), `sheets` (10) and the **full Chromium e2e 122/122** re-verified after the sheet changes (the one-off `pf1e_join`/`pf1e_mass_battles`/`sheets` failures in interim runs were the build-order trap — `vite build` wipes `dist/packages/*.zip`, so `build:systems` must follow it, which is what `pnpm test:e2e` does).

**Evidence.** Unit **1891 passed / 3 skipped** across 165 files; typecheck and lint green; build `dist/index.html` **2,331,984 bytes (2.224 MB) raw / 671,616 bytes (0.641 MB) gzip** — within the 6 MB raw budget. P02 is checked off: footprints and Table 8-4 (D-180), threatened squares + the draw list (D-181), the overlay and its selection trigger, the reach gate and pack `size` (this slice). A04's `shootingIntoMeleePenalty` facts remain A04's own item. **Next: D-198 (P03 movement.ts) → D-199 (P05 maneuvers) → D-200 (positional on provoked AoOs).**
## D-198 — 2026-09-13 — P03: movement legality and cost — the pure seam and the drag gate

**Decision.** `src/packages/pf1e/movement.ts` (new, pure) prices and judges the **straight walk a drag describes** — the same `cellsAlongSegment` line the AoO seam walks — against Gap List A.7's transcription: **5-10-5** diagonals (the running parity counter AoN 175 states, per-step: orthogonal 1, diagonals alternating 1-2), **difficult terrain ×2** per entered square (double-doubled ×4 — multipliers stack, not replace), **squeeze ×2** per entered square (the −4 attack/−4 AC halves stay `tactical.ts`'s situational parts; a scene authors no corridor widths to detect squeezing from, so it is a declared cost), **the mode budgets** (walk = speed as a move action, run ×4, withdraw ×2, charge ×2 with a ≥10-ft floor and no difficult terrain — CRB p.188), **the 5-foot step's own rules** (exactly 1 square, barred by any other movement this turn and by difficult terrain, CRB p.189 — terrain named *before* the overspend so a 1-square step into rough ground is refused by the terrain rule, not misreported as a cost), **A.7's minimum movement** (a full-round 5 ft when a reduced speed would otherwise bar all movement — flagged `minimumMovement`, provoking, never a 5-foot step), **move-blocking walls** (§9's move axis via the new `moveSegments`, `wallSight`'s `sightSegments` twin; a crossing wall refuses because routing around is pathfinding, a different action), **pass-through** (allies yes, enemies no, the default blocks everyone until the caller states an alliance), and **legal ending squares** (the destination footprint — `tokenCells` at the destination, so a Large mover's real 2×2 is judged — may overlap nobody's space; an occupier at the destination is the *ending* rule's fact, not pass-through's). Every unstated fact is a **named default** (mode, speed, walls, terrain, alliance), and an unreadable grid or a missing mover refuses by name.

**The drag gate.** `App.svelte`'s `onTokenMove` now asks `pf1eMovePlan` **before the opportunity queue** — an illegal walk never provokes and never commits (the controller's own `"cancel"` contract restores the square): the refusal is the notification's line ("Goblin can't move there — the walk costs 40 ft but a move action moves 30 ft"), the minimum-movement lift is an info note, and the mover's speed is its **derived** `speedFt` (authored `landSpeedFt`/`speedFt`, the derivation's named 30-ft default when absent). The gate is scoped to **PF1e actors** (`isPF1eActor`): a systemless token's drag owns no speed and no action economy, so non-PF1e content stays free — pinned by the ephemera roof-fade spec, which drags a bootstrap token seven squares and must keep working. A drag is a walk; run/withdraw/charge and the 5-foot step are the seam's modes with no drag UI declaring them yet (that declaration is the action-economy item's own scope), and withdraw's first-5-ft exemption stays the AoO seam's `withdraw` flag.

**Verification.** `tests/packages/pf1eMovement.test.ts` (new, 19): the mode table and `moveBlocked`'s door semantics; 5-10-5 orthogonal/diagonal/mixed pricing and the stay-put case; difficult ×2/×4; squeeze ×2; a Large mover's 2-square shift at 10 ft with its real destination footprint; the overspend refusal; run/withdraw/charge budgets; charge's floor and terrain bar; minimum movement (allowed at 5 ft, refused at 10); the 5-foot step's three refusals; the wall crossing; the ending rule incl. the ally-at-destination distinction; pass-through (default blocks, allies pass, enemies don't); the five named defaults; unreadable grid and missing mover. `e2e/pf1e_movement.spec.ts` (new, **executed** in Chromium, 3): a 40-ft drag against the 30-ft default is refused before it commits (token square unchanged, the named cost in notifications), an occupied destination refuses with the ending rule's line, and a legal 10-ft walk commits through the ordinary op path. One pre-existing fixture corrected by the new rule: D-188's "second provoking drag" stepped onto goblin2's square — now an illegal ending move — and was re-pointed at a legal provoking step with a comment naming why.

**Evidence.** Unit **1910 passed / 3 skipped** across 166 files (+19); typecheck and lint green; build `dist/index.html` **2,337,126 bytes (2.229 MB) raw / 673,441 bytes (0.642 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **125/125** (the D-197 baseline re-verified 122/122 from a clean tree first). P03 is checked off: the rules and their drag-gate consumer exist and are tested; the mode-declaration UI (run/charge/withdraw/5-ft-step as declared actions) and scene terrain authoring remain the action-economy and content items' own scope, named in the TODO. **Next: D-199 (P05 maneuvers).**
## D-199 — 2026-09-13 — P05 first slice: the manœuvre check (CMB vs CMD) and sunder

**Decision.** `src/packages/pf1e/maneuvers.ts` (new, pure) is the shared check layer every A.9 manœuvre resolves through. The CMB/CMD *numbers* stay the derivation's (`rulesTables.cmbFrom`/`cmdFrom` already encode the formulas, Tiny's Dex substitution and CMD's transferable AC bonus types — pinned here through the composition); this module owns the **check**: the caller's die against the defender's CMD with A.9's states and penalties folded in — immobilised/unconscious ⇒ auto-success; stunned ⇒ +4 on the roll (the margin keeps its sign for the aftermath consumers); nat 20 auto-succeeds **except escaping bonds**, nat 1 auto-fails; manœuvres are attack rolls, so summed attack penalties apply and a live concealment miss chance rolls its own d% (≤ chance ⇒ the manœuvre misses, the same AoN 182 contract the attack resolver pins — the missing face is a named refusal); **the penalized-AoO rule**: damage the provoked attack of opportunity dealt comes back as `aooDamageTaken` and subtracts from the roll (the provoke itself is the reported fact `provokes` — no Improved X ⇒ true — for the existing interrupt machinery to queue); and **A.9's size limit** — bull rush/trip/drag/reposition/overrun/grapple need a target no more than one category larger (`sizeSteps` on the ladder), with the appendix's "listed exceptions" a caller-stated waiver (`sizeLimitWaived`), never an invented feat. **Sunder** is the first composed consumer: a successful check feeds the caller-rolled damage through `items.ts`'s existing arithmetic (hardness first, then HP; past half ⇒ broken; ≤ 0 ⇒ the attacker's destroy-or-leave-at-1-HP choice point), a miss leaves the item untouched, and an item without a hit-point budget refuses by name. Every per-manœuver aftermath (bull rush's push distance, trip's fall, grapple's options, feint/aid-another) is deliberately **not** here — `margin` is the fact those consumers will read.

**Verification.** `tests/packages/pf1eManeuvers.test.ts` (new, 14): the kind table and A.9's size-limited six; the plain roll's total/margin; the derivation composition (Tiny's Dex CMB, CMD's transferables, flat-footed losing Dex); the size limit (refused at two categories, legal at one, waivable, disarm unlimited); the auto-success states; the natural faces incl. escaping bonds; attack penalties and the penalized-AoO rule; the provoke fact; concealment (miss, stand, no-d%-needed, named refusal); the die-domain refusals; sunder (broken past half, the destroy choice point, hardness absorbing, the untouched miss, the unbudgeted item).

**Evidence.** Unit **1924 passed / 3 skipped** across 167 files (+14); typecheck and lint green; build `dist/index.html` **2,337,126 bytes (2.229 MB) raw / 673,441 bytes (0.642 MB) gzip** — within the 6 MB raw budget. P05 stays unchecked: the nine remaining manœuvres' aftermaths, grapple's option tree, feint/aid-another, the legality facts (free hands, reach, legs) and the sheet/tracker consumer that rolls the die and feeds the provoked AoO's damage back are the next slices (the check layer they need is now in place).
## D-200 — 2026-09-13 — P06 closure: the provoked strike folds the pair's own facts

**Decision.** The provoked-AoO resolver (`resolveQueuedInterrupts`, the shared core of `pf1eAooFlow.ts`) no longer rolls in a positional vacuum: when the caller passes the **scene**, each queued strike reads the reactor→provoker pair through `pf1eResolvePositionReport` — the *same* pair seam the sheet's resolve panel reads (D-197) — and folds what it finds into the sheet's own `resolveAttackFlow`: **flanking's +2** (a helper directly opposite the provoker, dispositions explicit), the **cover/concealment defense payload** (+4/+2 AC, d% — defense-in-depth: the queue seams already refuse a covered strike per AoN 181's own exclusion, so this prices exactly the queues a caller built without `coverWalls`, or hand-built), and the **provoker's prone state** (+4 for the melee strike, A.14 — standing up from prone is the flagship provoking action, and the provoker is still in the square it stood in because the move is held). A scene the caller did not pass, or a pair the seam cannot read, folds nothing — the pre-D-200 behaviour, never a guess, the same honest absence the sheet's hand-set selects fall back to. Both resolution inputs (`Movement`/`Action`) gained the optional `scene`, and every caller passes it: the App's prompt path and auto path, the e2e surfaces (`pf1eOpportunity`/`pf1eActionProvoke` resolvers), and the sheet's action-provoke glue. The module header's named limitation (3) — "the attack carries no situational modifiers of its own" — is lifted and rewritten as the fold's contract.

**P06 is closed.** Every checklist item is now implemented and tested: the AoO trigger table (Table 7-2 via `actionTrigger`, D-184/D-190), verified budgets with owner-turn reset (D-183's correction, the sim's `resetTurnAoOs`, `combatState`'s turn-end reset), one opportunity per triggering action (D-184), the exclusions (`aooRefusal`'s named set, the withdraw exemption, AoN 181's cover exclusion — D-196), damage effects on **casting** (D-191 feeds `10 + damage + level` into the cast gate) and on **maneuvers** (D-199's penalized-AoO `aooDamageTaken` — the rule; the consumer that feeds it rides with P05's maneuver UI, since no maneuver action exists in the product yet), ready-before-trigger ordering (D-193's queue rank; P07 itself closed at D-195), and now the situational modifiers on the provoked attack. "UI prompts alone are not completion" was answered structurally in D-183/D-185: the strategic sim and the tactical Ops path both drain the queue before committing.

**Verification.** 5 new tests in `tests/ui/pf1eAooFlow.test.ts` (33 total in the file): the prone provoker struck at +4 (attackTotal 24 = 11 + 9 + 4, recomputed from the die face as the flow's own contract pins), the directly-opposite helper's flank +2 (22), standard cover pricing a hand-built queue (AC 16 → 20, the tie still hitting), the no-scene/unreadable-pair absence folds (20 vs 16 — no guess), and the action trigger folding through the shared core.

**Evidence.** Unit **1929 passed / 3 skipped** across 167 files (+5); typecheck and lint green; build `dist/index.html` **2,337,574 bytes (2.229 MB) raw / 673,734 bytes (0.643 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **125/125**. **Next: D-201 (mounted).**
## D-201 — 2026-09-13 — P08 first slice: mounted combat rules + the linkage and the sheet's fold

**Decision.** `src/packages/pf1e/mounted.ts` (new, pure) transcribes Gap List A.11 as rules with every die the caller's and every fact (mount size, speed, training, saddle, how far it moved) a caller fact: **the higher-ground bonus** (+1 on melee attacks vs a foe *smaller than the mount* that is *on foot* — verified CRB p.202 — encoded as the situational `higherGround` flag the resolver already limits to melee lines, since the verified text names it the higher-ground bonus; a mounted foe never takes it); **the full-attack bar** (mount moved > 5 ft ⇒ one melee attack at the end of the move, exactly 5 ft keeps the full attack); **the ranged penalties** (−4 while the mount doubles its speed, −8 while it runs, nothing at half movement — and unlike melee, the full attack stays allowed); **`LANCE_CHARGE_MULTIPLIER = 2`** (the ×3 spirited-charge and every other feat effect stays a caller fact, matching `rollData.ts`'s documented `extraMultipliers` seam); **the casting DCs** (mount moved both before and after the cast ⇒ 10 + SL; a running mount ⇒ 15 + SL, running winning; null ⇒ the ordinary rules own the cast); **the Ride checks** (untrained mount control DC 20, fail ⇒ the move becomes full-round and the round is lost; guide with knees DC 5; stay in saddle DC 15); and **the unconscious rider** (≤ 50 stays mounted, ≤ 75 in a military saddle, else falls 1d6; a bad d100 face refuses by name). The structural facts — the mount acts on the rider's initiative, shares its space, a Large mount occupies 2×2 — belong to the combat/scene consumers and are named in the header. `mountLinkageOf` normalizes the authored `system.pf1e.mount` block (`actorId`/`combatTrained`/`saddle`), the P08 TODO's "linkage" phrase made concrete.

**The consumer.** Two: the **linkage editor** and the **resolve fold**. `pf1eSheetModel`'s `DetailEdit` gained a `mount` kind — a self-ride is refused by name, a null id idempotently removes the block, otherwise the whole triple is written through the same allowlisted op path every sheet edit uses — and `PF1eActorSheet.svelte`'s combat tab gained the Mount block: a select of the other PF1e actors, a combat-trained checkbox and a saddle select (75% stay-mounted noted inline) that appear with the linkage. The resolve fold: when the rider's linked mount is larger than the on-foot resolve target, `situational.higherGround` folds into both resolve paths (single and Manyshot), with a `data-pf1e-mounted-bonus` hint line naming the rule — the same surface pattern as D-197's `resolvePositionHint`.

**Verification.** `tests/packages/pf1eMounted.test.ts` (new, 10): linkage normalization; the higher-ground cases (smaller on foot yes, equal/mounted/unreadable no); the full-attack bar at 0/5/30 ft; the −4/−8/none ranged table; the lance multiplier; the three casting-DC cases incl. running winning; the three Ride checks' pass/fail edges; the saddle chance at 50/51/75/76 and the bad-face refusals. `tests/ui/pf1eSheetModel.test.ts` +3: the triple write, the idempotent clear, the self-ride refusal. `e2e/pf1e_mounted.spec.ts` (new, **executed**): a compendium of Medium rider + Large warhorse + Medium on-foot dummy imports, the linkage authors through the sheet's own editor, the +1 hint appears with the target picked and disappears when unlinked. One pre-existing test bug fixed by the diagnosis: A06b's HP-line regex `/→ \d+ HP/` did not admit a negative after-value, so a high-damage crit (12 → −3) failed it — now `-?\d+`, and the test passed 15 consecutive isolated runs where it had failed ~1 in 5.

**Evidence.** Unit **1942 passed / 3 skipped** across 168 files (+13); typecheck and lint green; build `dist/index.html` **2,340,491 bytes (2.232 MB) raw / 674,616 bytes (0.643 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **126/126**. P08 stays open: the tactical consumers (the movement gate's Ride checks for an untrained mount, the melee full-attack bar in the attack flows, the ranged penalties, the mounted cast DC into `pf1eCastFlow`, the shared-space/initiative combat wiring, falling riders) are the next slices.
## D-202 — 2026-09-13 — P09 first slice: firearms misfire, explosion and clearing

**Decision.** `src/packages/pf1e/firearms.ts` (new, pure) encodes the verified misfire rules (Gap List §2.9b, UC p.135) with the clearing texts **re-verified before encoding**: the "DC 10 + ?" generic clear the Gap List hedged on does **not exist** — the named clears are the gunslinger's **Quick Clear** deed (a *standard action* removing a misfire-inflicted broken condition, requiring ≥ 1 grit; spending 1 grit makes it a *move action*) and the **Gunsmithing** feat (1 hour to repair a broken firearm), both pinned in `MISFIRE_CLEARS`. The module owns: `effectiveMisfireValue` (the authored minimum, +4 broken — **+2 with Gun Training** — plus the nonproficient loader's +4 for the shots they load); `pf1eMisfireVerdict` — the check reads the **natural die face** (never a total, never a confirmation roll), **a natural 20 never misfires** (the exact gate the strategic engine lacked, §2.9b defect (f)), a misfire is an automatic miss, the first misfire of a sound gun **breaks** it (the escalation named), and a second misfire of a broken **early** firearm **explodes** — a burst from a chosen corner dealing the weapon's damage, **DC 12 Reflex half**, a nonmagical gun destroyed / a magical one wrecked — while **advanced firearms never explode** and the 11th-level **Expert Loading** deed can spend 1 grit to avert the explosion (the gun keeps its broken condition). The burst geometry, the save rolls, grit and the weapon-state writes are caller-owned; the ammo gate (`firearmShotAmmo`) encodes §2.9's "a weapon with no ammunition is impossible to attack with". Touch windows, max increments, the broken −2s and the load-action cost stay where they already live (`tactical.ts`, `weapons.ts`).

**The consumer chain.** Authored attack lines gain a `firearm` block (`generation`/`misfireMinimum`/`magical`) plus `broken`; the derivation carries them onto `PF1eDerivedAttack.misfire` (absent or 0 ⇒ never misfires; an out-of-range minimum is a named issue, never a guess). `pf1eResolveAttack` folds the check **first** — before the hit/miss branches, so a misfire is a forced miss that cannot threaten — and returns the verdict (`misfire` on the success arm) for the caller's weapon-state write. `resolveAttackFlow` builds the facts from the line + the caller's feat list (Gun Training read off `feats`) and exposes per-shot caller facts (`misfireExtras`: the loader's nonproficiency, Expert Loading); the resolution card carries the verdict's notes verbatim.

**Verification.** `tests/packages/pf1eFirearms.test.ts` (new, 10): the escalation table (2/6/4/6/10, 0 never); nat-20 immunity at value 20; the first misfire's auto-miss + broken + the named +4; Gun Training's +2 note; the explosion (mundane destroyed, magical wrecked, DC 12 half); Expert Loading's aversion; the advanced no-explode case; the bad-die refusal; the clears table (no generic clear); the ammo gate. `tests/packages/pf1eResolve.test.ts` +4: a misfire forces a miss on a would-be hit (no threat, no confirmation die needed, no HP move); nat-20 at value 20 resolves normally; a misfired 19 within the threat range does not threaten; the exploding second misfire reports save + destruction. `tests/packages/pf1eActor.test.ts` +2: the carried facts (incl. broken + advanced/magical) and the never/invalid-minimum cases. `e2e/pf1e_firearms.spec.ts` (new, **executed**): a musketeer with a **broken** early musket (authored minimum 20 ⇒ effective 24) resolves against a dummy through the sheet's own panel — a bounded retry loop (the host's real d20; every non-20 misfires) asserts the card's misfire value 24, the auto-miss, the explosion, DC 12 Reflex half, the destruction, and that the target's HP never moves.

**Evidence.** Unit **1958 passed / 3 skipped** across 169 files (+16); typecheck and lint green; build `dist/index.html` **2,343,277 bytes (2.235 MB) raw / 675,549 bytes (0.644 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **127/127**. P09 stays open: the tactical consumers (the ammo gate in the attack path, the weapon-state write of `broken`/destroyed after a misfire, the explosion's burst resolution and Reflex saves, grit), the load-provoke trigger through the action seam, the strategic engine's weapon-owned state columns (M01's mirror), and the misfire-value display on the sheet panel are the next slices.
## D-203 — 2026-09-13 — H01 first slice: the injury and death verdicts

**Decision.** `src/packages/pf1e/injury.ts` (new, pure) owns every verdict A.13 states, with each die the caller's: **`injuryStateOf`** — the lethal ladder (healthy; **disabled** at exactly 0 HP; **dying** below 0; **dead when negative HP reaches the Con score**, conScore 0 never auto-killing), whose notes are the exact card strings `resolve.ts` was already printing; **`nonlethalStateOf`** — A.13's thresholds (exactly equal to current HP staggers, exceeding knocks out; the lethal state dominates); **`disabledAfterAction`** — the disabled economy (a single move **or** standard, never both, never full-round; swift/free are never the "single action"; the standard or any strenuous act costs 1 HP *after* it completes, at −1 and dying, no check involved — verified AoN ID 164/166); **`stabilizationCheck`** — the DC 10 Constitution check with a **penalty equal to negative HP** (nat 20 automatic; a failure loses 1 HP more), the same roll serving the stable character's **hourly wake** check (`purpose: "wake"`); **`healFirstAid`** — another creature's DC 15 Heal check stabilizes the dying; and **`coupDeGraceVerdict`** — the full-round auto-crit's aftermath (if the damage did not kill, a **mandatory** Fortitude save at DC 10 + damage dealt or death — no natural-20 mercy at high damage; a crit-immune creature takes no critical damage and need not save; the damage-killed case is the caller's HP arithmetic, named `killedByDamage`, making the save moot). The *state* of a dying creature (rounds, who aided) and the turn/hour ticks that drive it are D-204's bookkeeping; delivering the coup (its provoke, the adjacency/weapon legality) is the caller's.

**The refactor.** `resolve.ts`'s condition annotations now come from `injuryStateOf`/`nonlethalStateOf` instead of its own inline ladder — behavior-preserving (all 26 existing resolve tests, which pin the strings, pass unchanged), so the thresholds live in exactly one place and the e2e cards (A06b's "unconscious and dying" line among them) flow from the module.

**Verification.** `tests/packages/pf1eInjury.test.ts` (new, 10): the ladder incl. exactly-at-Con and conScore 0; the annotation strings; the nonlethal thresholds incl. the lethal-domination cases; the disabled economy (move free, standard → −1, full-round refused, second action refused, swift/free pass-through); the stabilization check (DC 10 + penalty at −5 HP exactly made/failed, nat 20 at −19, the bad-face refusal); the wake check's naming; first aid's DC 15 edge; the coup de grâce (DC 30 at 20 damage saved at Fort 22, a natural 20 + 8 still dying vs DC 30, the damage-killed moot case, the missing save face's named refusal, crit immunity waiving damage and save).

**Evidence.** Unit **1968 passed / 3 skipped** across 170 files (+10); typecheck and lint green; build `dist/index.html` **2,343,673 bytes (2.235 MB) raw / 675,660 bytes (0.644 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **127/127**. H01 stays open: the dying/stable state machine and its turn/hour ticks (D-204), the GM/player UI for stabilization checks and first aid, natural recovery beyond the hourly wake (H03's healing owns rest), and the helpless-target coup UI.
## D-204 — 2026-09-13 — H04 negative levels + natural recovery, and the dying round's obligation

**Decision.** Two new pure modules, both transcribed from re-verified primaries. `src/packages/pf1e/negativeLevels.ts` — AoN Rules ID 427 (CRB p.562) and the Energy Drain UMR: per negative level a cumulative **−1 on attack rolls, saving throws, skill checks, ability checks, combat maneuver checks and CMD** (−0 normalized so cards never print "-0"), **current and total HP each reduce by 5**, **one level lower for level-dependent variables** (the derivation folds it into caster level — "spellcasters do not lose any prepared spells or slots"), **death when levels equal or exceed total Hit Dice** (only when `hitDice` is authored — never guessed), and the two removal rhythms as named kinds: **temporary** levels get a *new save each day* at the causing effect's DC; **energy-drain** levels get *one* Fort save after 24 hours (DC = 10 + ½ racial HD + Cha mod, a separate save per level) whose failure makes the level **permanent**; permanent drain (raise-dead style) allows no save — restoration-class magic is a caller fact. `src/packages/pf1e/recovery.ts` — AoN Rules ID 170 (CRB p.191): natural HP healing is **1/level per night of rest, 2× level for complete bed rest**; ability damage returns at **1 point per affected score per night, 2 per day of bed rest** (drain never heals naturally), with the Heal skill's long-term care doubling both. The derivation folds the authored `system.pf1e.negativeLevels` (`temporary`/`permanent`, whole-number-validated like `hitDice`) into every statistic the verified text lists — attack lines, all three saves, CMB, both CMD arms, hp and hpMax, caster level — and pushes `dead` onto the conditions at the Hit-Dice threshold; initiative is deliberately untouched (AoN 427 does not list it). And `pf1eNextTurn` gained the **dying round's obligation**: with actor documents supplied, the combatant whose turn starts and whose linked actor is below 0 HP — neither dead-at-negative-Con nor carrying an authored "Stable" condition — is reported in `dyingChecks` with the derivation's effective Con modifier, the exact facts `injury.ts`'s `stabilizationCheck` consumes; the transition rolls no die (the UI that drives the turn asks the host and writes the outcome).

**Verification.** `tests/packages/pf1eNegativeLevels.test.ts` (new, 7): count normalization incl. the named invalid cases; the penalty table at 0/2/negative; death at and past HD, never at HD 0; the energy-drain DC formula; both removal rhythms incl. the becomes-permanent difference and the bad-die refusal. `tests/packages/pf1eRecovery.test.ts` (new, 2): both rate tables incl. the long-term-care doubling. `tests/packages/pf1eActor.test.ts` +3: the fold (−2 on a two-level drain across attacks/saves/CMB/CMD, hp/hpMax 30 → 20, caster level 6 → 4, initiative unchanged, the named default line), death at authored HD 6 with 6 levels but not 5, and the invalid count's named normalization refusal. `tests/packages/pf1eCombatState.test.ts` +2: the obligation emitted (hp −3, Con 14 ⇒ conMod +2) and the stable/dead/disabled/unlinked/no-actors cases emitting nothing.

**Evidence.** Unit **1980 passed / 3 skipped** across 172 files (+12); typecheck and lint green; build `dist/index.html` **2,345,884 bytes (2.237 MB) raw / 676,395 bytes (0.645 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **127/127**. H04's remaining: the energy-drain *infliction* path (the attack that bestows levels — awaiting the undead/drain content), the 24-hour clock UI, restoration spell wiring (C03's spell work), and ability burn/massive damage (explicit optional follow-ups). H01's remaining: the CombatPanel surface that rolls `dyingChecks` and writes the outcome — D-205.
## D-205 — 2026-09-13 — H01: the CombatPanel surface that rolls the dying check and writes the outcome

**Decision.** D-204's `dyingChecks` report now has its consumer. `src/ui/combat/pf1eDyingTick.ts` (new, pure) plans the write for one check: a **success** adds the `Stable` condition to the actor's authored `system.pf1e.conditions` (idempotent, case-insensitive, author's list preserved — no op when already present), which `pf1eNextTurn`'s own gate reads back so **a stabilized creature owes nothing on its later turns**; a **failure** writes `hpAfter` (the −1 loss) as an update op, annotated with `injuryStateOf`'s death line when the loss reached negative Constitution. The plan's note is the card line: `${name} — ${verdict.note}` (plus the death annotation). `CombatPanel.svelte` drives it: `advanceTurn` passes the world's actors into the transition and, per reported check, rolls **`1d20 + conMod` publicly** (`client.roll`, flavor "dying stabilization check (DC 10, penalty for negative HP)"), resolves the message through `awaitRollMessage`/`dieFaceOf`, verdicts via `stabilizationCheck`, and submits the plan's ops — with named fallback notes when the roll never arrives or the actor vanished mid-flight. The status line `data-dying-note` (joined " · ") sits beside the fired-marker note. Two e2e surfaces join the hook: **`pf1eAuthorActor`** (shallow-merge an authored `system.pf1e` patch onto a placed actor — the e2e counterpart of the sheet's editors) and **`pf1eActorSystem`** (read one actor's block back).

**Verification.** `tests/ui/pf1eDyingTick.test.ts` (new, 2): the success's idempotent Stable op (an already-stable actor plans no op) and the failure's hp write with the death annotation past negative Con. `e2e/pf1e_dying.spec.ts` (new): two placed tokens, the dying hero authored Con 35/hp −3 — **even a natural 1 clears the DC (1 + 12 = 13 ≥ 10 + 3)**, so the outcome is deterministic under the host's real d20 — the goblin leads round 1, one "next turn" starts the hero's: the public roll card appears in chat, the status line carries the verdict, the actor carries `Stable` at hp −3, and wrapping the round produces **no second card** (the Stable gate). The spec sets initiative by hand (no `#combat-init`): the initial roll's retained active slot depends on its random dice, and the fills alone keep the flow deterministic — the goblin is placed first so it holds the opening slot through both edits.

**Evidence.** Unit **1982 passed / 3 skipped** across 173 files (+2); typecheck and lint green; build `dist/index.html` **2,348,530 bytes (2.240 MB) raw / 674,713 bytes (0.643 MB) gzip** — within the 6 MB raw budget; full Chromium e2e **128/128** (the dying spec ran 10/10 standalone). H01's remaining: rest-based recovery UI (H03), the first-aid/coup-delivery surfaces, and the helpless-target coup UI.
