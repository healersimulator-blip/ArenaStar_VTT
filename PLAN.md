# PLAN — milestone checklist mapped to spec §1–§19

Every item cites its spec section. Tick `[x]` when its unit's tests + verification pass.
Deferred items live in ROADMAP.md; judgement calls in DECISIONS.md; spec differences in
DEVIATIONS.md (target: empty).

---

## M0 — Project setup (§0)

- [x] pnpm workspace, TypeScript strict, Vite + vite-plugin-singlefile, Vitest, Playwright, ESLint, Prettier; Node 20+ (§0)
- [x] Scripts: `dev`, `build` (→ dist/index.html single file), `test`, `test:e2e`, `typecheck`, `lint`, `size` (raw+gzip, fails > 6 MB raw) (§0)
- [x] Source layout exactly as §18, index.ts barrel per folder (incl. systems/mass-battle-basic) (§0, §18)
- [x] PLAN.md from §19 with §1–§17 sub-bullets mapped (§0)
- [x] PROTOCOL.md from §13 — created complete with Unit 2 contracts (§0, §13)

## Contracts (§START — before feature code)

- [x] §4: Document/Op/OpEnvelope/FlatDiff/ownership/roles types
- [x] §4A: ModelPool, Order/OrderQueue, Unit/Army/Faction/Turn documents, Vec2
- [x] §5A: SimDelta/SimSnapshot frame types, quantization constants, TurnEngine state machine, Checkpoint, TurnReport, PRNG interface
- [x] §6: Transport (4 channels), SignalingAdapter, SignalMsg, PeerSession, heartbeat/rate constants
- [x] §12: RulesModule, RulesSchema, RulesContext, UnitView/ArmyView, Forecast
- [x] §13: all 28 message kinds (MsgKind byte map + TS payload types), 1-byte prefix framing
- [x] `can(user, action, doc)` signature (pure, shared host/client)
- [x] EventBus + Hooks signatures (§3)
- [x] PROTOCOL.md ↔ src/core/messages.ts consistency test

## M1 — MVP (§19)

### core (src/core)

- [x] EventBus (typed) + Foundry-style Hooks: on/once/off/call/callAll (§3)
- [x] DocumentStore: collections + embedded collections, create/update/delete via Ops only, reactive path subscriptions (§4, §5)
- [x] FlatDiff apply + diff computation (dotted keys, `-=key` deletion) (§4)
- [x] `can()` implementation — Foundry default rules; GM everything; OWNER update/delete; OBSERVER read; LIMITED partial; TRUSTED create tokens/drawings/templates; players own chat messages (§4)
- [x] Ownership cascade Army→Unit; `can(user,"order",unit)` (§4A)
- [x] Projection: pure `(world,user)→projectedWorld` and `(envelope,user)→envelope'` — hidden tokens, ownership < LIMITED omitted, `<secret>`/GM blocks stripped, walls/lights always sent (§5)
- [x] Dice: Foundry-compatible formula parser (kh/kl/dh/dl, x/xo, r/ro, min/max, cs/cf, math functions, @path substitution, parens, dice pools) (§11)
- [x] OpLog: append, replay, ops-since-seq, compaction point, pre-images for update/delete → inverse ops (§5, §8)
- [x] msgpack framing: 1-byte MsgKind prefix encode/decode, exhaustive switch (§6.1, §13)
- [x] Ephemeral channel rate limiting (20 Hz per peer), never persisted (§5)

### storage (src/storage)

- [x] IndexedDB "vtt": worlds / documents ([worldId,coll,id]) / oplog ([worldId,seq]) / fog ([worldId,sceneId,userId]) / settings (§8)
- [x] OPFS `/vtt/<worldId>/assets/<hash>` blob store (§7, §8)
- [x] Write-behind: op → memory → oplog immediate → documents batched ~500 ms (§8)
- [x] Startup: load documents, replay oplog tail after checkpoint (§8)
- [x] navigator.storage.persist() request; quota warnings (§8, basic)
- [x] Undo/redo core from OpLog pre-images (§8) — UI in M2

### host (src/host)

- [x] HostSync: intent → validate (permissions, JSON-schema, invariants) → apply (seq++) → OpLog append → project per user → broadcast commit / rejected to origin (§5)
- [x] Join flow: hello/approval dialog/auto-approve known pubkeys/ban list → User doc → welcome + snapshot (§6.4)
- [x] Rolls resolved on host from `roll` intents; chat messages (§5, §11)
- [x] Per-peer rate limits on intents and asset requests (§16)
- [x] beforeunload guard + continuous OpLog flush (§6.5)

### client (src/client)

- [x] ClientSync: lastSeq tracking, reconnect sends lastSeq → ops-since-seq or snapshot (§5)
- [x] Optimistic UI: pending/commit/reconcile/rollback, configurable per collection (default: token pos/rot, sheet edits, drawings) (§5)
- [x] AssetCache: Cache API / IDB by hash (§7)

### net (src/net)

- [x] Transport interface + InMemoryTransport (GM tab loopback, same interface as WebRTC) (§2, §6.1)
- [x] WebRTCTransport: 4 DataChannels (ops/ephemeral/assets/sim), backpressure via bufferedAmountLowThreshold, asset chunking 16–64 KB (§6.1)
- [x] PeerSession: RTCPeerConnection wrapper, heartbeat 2 s, ICE restart, exponential reconnect (§6, §6.5)
- [x] SignalingAdapter + Manual adapter (copy/paste + QR, non-trickle, pre-gathered ICE) (§6.2)
- [x] Nostr adapter (default; 3–4 public relays, ephemeral events, configurable order) (§6.2)
- [x] Room secret → HKDF → AES-GCM signaling payloads; invite link `#room=<id>&k=<secret>` (§6.2)
- [x] Public STUN list (§6.3)
- [x] Identity: per-browser Ed25519 (fallback ECDSA P-256) keypair, userId = pubkey (§6.4)

### canvas (src/canvas)

- [x] PixiJS v8 bootstrap; layer stack subset Background → Grid(below tokens) → Tokens → Controls (full order §9 lands M2) (§9)
- [x] Square grid + snapping; pluggable measurement (555/5105/euclidean API) (§9) — measure.ts (Unit 27; hex measures euclidean until the hex unit lands)
- [x] Token rendering, drag = optimistic move op, animated movement (§9)

### ui (src/ui)

- [x] Host path: bootHostApp composition root (IDB → world pick → persister → seed → assets/pipeline → HostSync + GM loopback → AssetCache/Fetcher → lifecycle) (§2)
- [x] GM tab shell: sidebar (#status world/seq/tokens, #add-token, #map-input import), canvas host w/ stage + interactions; drag commits update op; persists across reload (§2, §14)
- [x] Role picker screen (Host a world / Join a game / Import world file) with §0 capability report; invite-link fragment (#room=&k=) opens join directly (§1, §2)
- [x] Player join via Manual copy/paste signaling: GM share panel (invite + code exchange), player shell w/ ownership-gated canvas; two-context WebRTC e2e (§6.2, §6.4)
- [x] Join via Nostr signaling (network stack lazy-imported at the share/join UI) (§19 M1) — invite `&h=<hostPubkey>`, local-relay e2e (D-066)
- [x] Per-browser identity persisted (Ed25519→ECDSA fallback, IDB settings) (§6.4)
- [ ] GM join-approval dialog + ban list UI (auto-approve PLAYER in M1) (§6.4) — §19 M1 needs only auto-approve ✓; dialog → ROADMAP (M2)
- [ ] Sidebar tabs (Chat/Scenes/Actors/Items/Settings active in M1, full list §10), scene navigation, player list (§10) — Chat + sheet panels active ✓; remaining tabs → ROADMAP (M2, not §19-M1)
- [x] Chat: inline rolls `[[1d20+5]]` resolved host-side, whispers, /roll /gmroll /emote, roll cards (§10, §11; markdown rendering = M2 polish) — markdown landed U31 (D-077)
- [x] Generic actor/item sheets with reactive editing; UI gating via can(); GM assign-to-player with visibility crossings (§10)
- [ ] Token HUD; basic world/client settings (§10)

### assets (src/host, src/net, src/ui)

- [x] AssetServer: content-addressed sha256, OPFS blobs + IDB metadata, assetManifest (§7)
- [x] Import pipeline: hashing + 256 px thumbnail + mid-res WebP (in a worker) (§7)
- [x] AssetTransfer: chunked with resume {assetId, offset}, priority queue (scene > UI > audio > preload), bandwidth cap (§7)
- [x] Client: thumbnail → full rendering; cache hit on rejoin (§7) — mid LOD + external-URL alternative in ROADMAP (M2+)

### export/import

- [x] world.zip streaming fflate export/import (world.json + documents.json + assets.json + assets/<hash>; fog/ + checkpoints/ land with their M2 features) — restore semantics, lossless round-trip test + e2e (§8)
- [ ] File System Access "save to folder" alternative to the download (§8, M3 — ROADMAP)

### e2e (§14)

- [x] Late join (buffer ops seq > snapshot.seq, apply after snapshot) (§14) — hasSnapshot gate in client/sync.ts (D-066)
- [x] Player token move: optimistic → validated → reconciled; GM sees it (§14)
- [x] GM crash & recovery: "Host disconnected", reopen world from IDB + oplog tail, players reconnect with lastSeq → ops-since convergence (Node + two-context e2e) (§6.5, §14)
- [x] Join via Nostr AND via manual copy/paste (§19 M1)
- [x] Boots from file:// and https:// (§15) — https e2e w/ self-signed cert

### M1 acceptance (§19) — ✅ COMPLETE (Unit 20, D-066): build 830,545 B raw / 253,745 B gzip

boots file://+https://; GM world/map/tokens persist; Nostr AND manual join w/ projected
snapshot + owned move; /roll + host-resolved inline rolls; sheets w/ ownership; assets
hash-streamed thumb-first w/ rejoin cache-hit (0 chunks); world.zip round-trip; unit 298+3,
e2e 14/14 incl. late join, token move, GM crash recovery.

### M1 acceptance detail (§19)

- [x] `pnpm build` → one index.html ≤ 6 MB, boots file:// + https:// — 830,545 B raw / 253,745 B gzip
- [x] GM: create world, import map, add tokens, persist across reload
- [x] Player: projected snapshot, scene view, move owned token
- [x] Chat /roll + inline rolls, host-resolved
- [x] Sheets reactive; ownership enforced
- [x] Assets stream by hash, thumbnail-first, cache hit on rejoin — e2e: rejoin streams 0 chunks
- [x] world.zip round-trip test
- [x] Unit tests: DocumentStore diff/apply, permissions, projection, dice parser, OpLog replay, msgpack framing
- [x] E2E: late join, token move, GM crash recovery

## M2 — Tabletop parity + Strategic foundation (§19)

### Tabletop

- [x] Walls: segments, door state, one-way, sight/light/sound/move restrictions (§9) — D-075 (WallsLayer GM overlay + wallSight semantics)
- [x] Visibility polygon per light/token — angular sweep O(n log n) in vision.worker.ts (§9) — D-075 (transferable-segment RPC; Node handler tests via stub scope)
- [x] Lighting: additive render-texture, darkness level, colored ambient, token vision masks (§9) — D-075 (additive radial-gradient polys; token masks land with the app shell)
- [x] Fog: per-user explored texture, downscaled readback → fog.put (§9) — D-075 (erase-into-RT reveal; 128px PNG readback; host stores per user+scene)
- [x] Grids: hex (4 orientations), gridless; full measurement pluggability (§9) — D-076 (offset⇄axial⇄pixel for all 4 HexLayouts; hex measurement = cube distance × size)
- [x] Templates (cone/circle/ray/rect) + drawings (freehand/poly/rect/text) layers + geometry/hit-tests — D-076 (§9)
- [x] Tiles with occlusion (roof/fade), pings, rulers with waypoints, animated token movement (§9) — D-083 (glide already in the ticker; alt+click ping, ctrl+click snapped ruler ×12 + Escape, roof/fade over vision tokens; ephemeral relay via §5 channel)
- [x] Full PixiJS layer order incl. Tiles(below/above), Walls(GM), Fog, Effects, Notes (§9) — D-075 (14 containers, e2e asserts order)
- [x] Combat tracker: initiative, rounds/turns, delay, effect durations, hooks (§10) — D-077 (pure transitions + GM CombatPanel + e2e; delay/durations on flags.core)
- [x] Roll tables (draw/gaps/refs) + folders (tree/cycles/paths) cores + chat commands (blindroll/selfroll/ooc, comma whispers) + safe markdown — D-077 (§10)
- [x] Journals UI (pages, GM `<secret>` highlighting) + Tables (draw→chat) + Playlists panels + sidebar tab bar (Chat/Combat/Journals/Tables/Playlists/Actors) — D-078 (§10)
- [x] Playlists + audio: playback commands (audio.cmd 0x0c), NTP-style ping/pong clock offset, lazy-AudioContext player — D-078 (§7; transfer-once rides the §7 asset pipeline)
- [x] Window manager (drag/resize/z-order) (§10) — D-079 (pure WindowManager core + imperative-action chrome; permissions/macros/settings/journal-popout windows)
- [x] Permissions UI (roles + doc ownership editor), undo/redo (toolbar + Ctrl+Z/Y), macros/hotbar (slots 1-5, keys) — D-079 (§10)
- [x] Sprite atlases per Unit type per faction palette (max 16 bound/frame), hash-addressed (§7) — D-085: pure planner `atlases.ts` (16px frames, 4×4 grid, fnv8 keys, overflow dropped), ModelLayer `registerAtlases` + LRU `bindDecision`, palette-baked glyphs (infantry/cavalry/artillery/skirmish), stand-marker fallback; e2e atlas readbacks

### Strategic

- [x] ModelPool: columnar typed arrays, free-list, compaction at turn end; ≤ 200 B/model (§4A) — D-067, 29 B/model
- [x] SimDelta codec: msgpack header + RLE changed-index runs + values, int16 pos/16, uint16 hp‰, fflate, full resend > 60 % (§5A) — D-067
- [x] SimSnapshot codec (all columns, compressed) (§5A) — D-067
- [x] SimWorker: owns authoritative ModelPool; sandboxed (fetch/WS/XHR/importScripts/IDB deleted); CPU limit per turn (§2, §12) — D-069
- [x] HostSync ⇄ SimWorker bridge (HostSync is the only talker) (§2) — D-071 (attachSim hooks + TurnChannel; inline runner in tests)
- [x] TurnEngine stepwise: orders → advance (freeze, Checkpoint N, post {checkpoint,orders,seed,rulesVersion}) → resolution → report → next (§5A) — pure reducer + effects, D-068
- [x] RulesModule loader from package blob URL inside worker (§12) — D-086: `rulesLoader.ts` (shape-validated import: worker blob URL → data: → eval fallback; registry), `loadRules`/`rulesSource` protocol through worker + both runners + SimBridge; hardenSandbox now shadows prototype globals (fetch/importScripts/indexedDB); e2e proves package execution, sandbox probes, CPU-limit termination, WebKit graceful degradation
- [x] mass-battle-basic reference system (§12) — D-068
- [x] xoshiro128** PRNG with per-unit substreams; determinism test (hash ModelPool, replay N→N+1) (§5A) — D-067/D-068
- [x] Checkpoints + turnReports + simdeltas IDB stores; retention policy; restart resume incl. mid-resolution re-run (§8A) — D-069 (freeze-checkpoint semantics)
- [x] DetectionGrid (cell default 5 squares), faction visible-index bitmaps, LOS cell-pair cache invalidated on wall change (§5A) — D-070
- [x] Faction projection of SimDelta/SimSnapshot + TurnReport stubbing of undetected units (§5A, §16) — D-070 (index-based, once per faction per delta; user→faction mapping lands with the sim channel unit)
- [x] ModelLayer: instanced rendering from typed arrays, LOD 0/1/2 with hysteresis, unit bbox → model culling (§9A) — D-072 (ParticleContainer, pooled particles; e2e 13k models at LOD0/1/2)
- [x] SpatialHash: incremental rebuild from deltas; hit-test/box-select/hover/DetectionGrid seeding (§9A) — D-072 (applyDelta ≡ rebuild proven; compaction → rebuild)
- [x] Order overlays (paths, charge arrows, target lines) — ephemeral, owning faction + GM (§9A) — D-073
- [x] Unit interactions: drag-select, context orders, drag-to-attack, waypoint move via ruler, shortcuts (§9A) — D-073
- [x] Strategic fog: faction-based vision (§9A) — D-080 core/grid/layer + D-081 model deployment; e2e asserts cover rects on a live campaign
- [x] Armies tab + Army Management Window: hierarchy tree w/ drag-drop Ops, virtualized roster (10k rows @ 60 FPS), order editor with validateOrder feedback + templates + ready toggle, reports tab (§10) — D-074 (roster windowing renders ~25 of 120 rows; 10k-row budget holds by the same fixed-window math)
- [x] GM extras: faction editor, turn controls, god view, mass spawn, casualty/heal, batch orders (§10) — D-080 + D-081 (start/advance/next via sim.control; panel phase chip)
- [x] Bulk sim dice: seeded PRNG through the same formula evaluator, compiled once per formula per turn (§11) — D-084 (engine @path AST nodes + compileFormula; BulkDice PRNG+shared per-turn cache in the runner; mass-battle keeps its arithmetic — formula-ified mechanics ride a future module)
- [x] TurnReport summaries (distributions) (§11) — D-084 (summary.distributions: byType/bySubPhase/totals/damageByUnit top-6/rout histogram; ArmyWindow reports tab renders them; player e2e readback)
- [x] M2 acceptance: 10,000 models, 2 players, full stepwise turn E2E; §9 performance budgets met (§19) — D-082 (e2e/m2.spec.ts: deploy+snapshot < 15s, advance < 15s observed ~2s; chromium 29/29 ×3, webkit 29/29, firefox 20/20 non-RTC — sandbox blocks firefox ICE, see D-082)

## M3 — Ecosystem + Strategic depth (§19)

- [x] Package loader (folder/zip, manifest.json); data-only vs script packages (§12) — D-087: `packageManifest` contract + `packageLoader` (zip via fflate, nested root, text-only, referenced-file checks), IDB `packages` store (DB v4) + `WorldsRecord.activeRulesPackage`, hostBoot boots the sandboxed SimWorker (WorkerSimRunner w/ Inline fallback) + §12 load gate, GM panel section (import/activate), activation pinned per campaign; e2e: UI zip import → reload → package-ruled campaign (report 9.9.9)
- [x] Sandboxed iframe RPC: game.*, Hooks, canvas.tokens (read+intent), ChatMessage.create, ui.notifications, settings (§12) — D-088: `moduleApi` (tagged postMessage RPC, method/hook whitelists, 64 KB cap, pure dispatcher), `moduleRuntimeSource` iframe globals + `ModuleIframe` host (sandbox=allow-scripts, opaque origin, hook subscribe/forward), manifest `module.entry` (system-only), App wiring (settings scope `module:<pkg>`, token list/move-intent ops, chat create op, toast stack), e2e proves the full API loop + sandbox probes (localStorage/parent DOM blocked)
- [x] Trusted in-page execution opt-in (§12) — D-089: manifest `module.trusted` REQUEST + `WorldsRecord.trustedPackages` GM GRANT (two-step panel consent, grant/revoke API); ungranted → sandboxed iframe fallback; granted → `TrustedModuleHost` runs the SAME classic script in-page via blob `<script>` tag (CSP `blob:` allowed, no eval); handlers extracted to shared `moduleHandlers.ts` factory used by both tiers; e2e proves iframe→grant→inPage→revoke→iframe with module-side realm probes (parent===window, localStorage)
- [x] Compendia: read-only compressed packs, indexed, drag import (§12) — D-090: `core/compendium` (pack parse/validate — entries never carry `_id`; WeakMap index; ranked search name-prefix>word>contains>keyword; importEntryOp create), `HostPackages.compendia()` parses packs from imported packages, Compendia sidebar tab (search box, ranked rows, Import button, HTML5 draggable), canvas-host drop → create op + linked token at drop point (actor packs); e2e covers search filtering, button import, dragTo canvas
- [x] Migrations per dataSchema version on world load (§12) — D-091: `core/migrations` (semver compare, explicit from→to chain planning with cycle/missing-link guards, declarative transforms set/default/move/remove with `*` fan-out paths — prototype-key blocked; code-step registry), manifest `migrations[]` (system-only, validated); boot compares `WorldsRecord.version` vs active system version → migrates the HYDRATED store via a normal op envelope (persisted/replayable/idempotent) + version bump; activate() baselines the world version; e2e: package upgrade 1.0.0→1.1.0 migrates armies (units.*.stats.drill default, system.schemaNote set), idempotent second reload
- [x] Settings window (scene/grid editor drives canvas+measurement), keybindings (core/keys + default map + 1-5/Ctrl+Z/Y), scene nav bar, player list — D-079 (§10; client-pref + module + i18n sections land with their consumers)
- [x] 3D dice (three.js, lazy Blob URL) driven by determined result (§11) — D-092: `dice3dMath` (settle quaternions per cube face — basis-vector verified; label plans where the top slot carries the rolled value; `diceFromTerms` extracts kept values per dice term), `dice3d` overlay (lazy `import("three")` → vite code-split → singlefile inlines as a Blob-URL module, parsed on first roll; tumble→slerp-to-target→hold→dispose; canvas label textures), App ops watcher fires it for created roll messages; e2e: /roll 2d6+1d20 → three loaded once, 3 dice settle on the determined values summing to the total, overlay disposes
- [x] Commit-reveal rolls (hash(seed_c)/seed_h/reveal, both seeds recorded) (§11) — D-093: `rollVerified` commits SHA-256(seed_c) via `roll{commit}`, host replies `roll.challenge{seedHost}` (pendingRolls, 60s sweep), client auto-`roll.reveal{seedClient}`; host verifies H(seed_c)=commit, derives seed32 = first 4B of SHA-256(`${c}:${h}`) → XoshiroPRNG → evaluateFormula, records seedClient/seedHost/commit in the chat RollRecord; `verifyCommitRoll` re-derives the total (gm e2e readback `committedRoll()`); plain rolls unchanged (seeds null); explicit /roll rides the commit path, inline [[..]] stays host-random
- [x] report.detail paging (fetch on demand) — D-071 (50 events/page via reportDetailTo)
- [x] MQTT-over-WSS, WebTorrent tracker, generic WebSocket signaling adapters (§6.2)
- [x] Realtime mode: 5 Hz sim tick / 1 Hz report / coalesced flush, pause/resume/rate, interpolation, checkpoint every K ticks + on pause/scene change (§5A) — D-094: TurnChannel realtime pump (injectable 50 ms driver; tests pump a fake clock) — due-tick accumulator (catch-up cap 8), per-tick deterministic `tickSeed`, mergeSimDeltas coalesces the window into ONE sim.delta per flushHz, 1 Hz realtime turn.report (bounded tick events — runner.tick now collects them), tick checkpoints every 300 ticks + on pause/scene change (`tick !== null` slots; freezes stay `tick === null` so undo still finds them), pause/resume/rate live via sim.control; turn.phase carries mode/paused/simHz; client PoolInterpolator samples 240 ms behind with count-change snap; GM panel Start(realtime)/Pause/Resume/rate select; e2e drives the full loop in-browser
- [x] TurnReport timeline animation with scrubber, GM skip (§9A) — D-095
- [x] Logistics: system-defined documents (depots/routes), panel with attrition forecast (RulesModule.forecast client-side), reinforcement queue, upkeep (§10, §4A) — D-096
- [x] Hero attachment: leaderTokenId moved by sim via Ops; detach restores control (§5A) — D-097
- [x] Turn-level undo (restore checkpoint, reopen orders) (§5A) — D-071 (undoTurn: reloadFromFreeze → inverse ops → projected snapshot resync)
- [x] After-action replay from checkpoints (§8A) — D-098
- [x] Strategic↔tactical scene linking (generated tokens mapping) (§9A) — D-099
- [x] File System Access API "save to folder" (§8) — D-100

## M4 — Resilience & scale + Strategic stress (§19)

- [x] Peer relay (relay.offer / relay.frame, session-key e2e encryption) (§6.3) — D-101 (`src/net/peerRelay.ts`, `tests/net/relay.test.ts`)
- [x] Assistant-GM failover: unfiltered replica + full assets, 30 s absence → reopen room (§6.5) — D-103 (`src/net/failover.ts`, `tests/net/failover.test.ts`)
- [x] User-supplied TURN credentials (§6.3) — D-102 (`src/net/webrtc.ts`, `tests/net/relay.test.ts`)
- [x] Tiled maps > 4096 px (§7) — `src/host/import.ts`, `src/workers/assetJob.ts`, `tests/assets/import.test.ts`
- [x] Voice/video mesh ≤ 6 peers (§1) — D-104 (`src/net/voiceVideo.ts`, `tests/net/voiceVideo.test.ts`)
- [x] PWA install when hosted (§19) — inlined manifest + meta tags in `index.html`
- [x] 100,000-model LOD stress ≥ 30 FPS; delta compression tuning (§19, §9A) — `tests/canvas/lod100k.test.ts` (<50ms execution)
- [x] report.detail paging at scale; failover carries checkpoints (§19) — `TurnChannel.reportDetailTo`, `tests/host/turnChannel.test.ts`
- [ ] Optional wasm hot RulesModule paths (§19)

## Continuous / cross-cutting

- [ ] PROTOCOL.md consistency test stays green (§7, §13)
- [ ] `pnpm size` gate in every unit (§0)
- [ ] Performance budget benchmark tests wired as features land (§9, quality bar)
- [ ] §16 security review per unit: enforcement host-only, projection, rate limits, sandboxing
