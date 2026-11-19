# Implementation plan: 500-player strategic mode

**Status:** Opt-in pilot implemented; reference-host qualification and rollout are open.  
**Basis:** [50,000-model research and baseline measurements](STRATEGIC_500_PLAYER_PLAN.md).

## 1. First release

Deliver an opt-in **Hosted Strategic Room** for one shared PF1e battlefield in simultaneous turn-based mode. Qualify **500 connected commanders plus a GM**, each commander responsible for roughly 100 models across 5–10 units. Test both 2,500 × 20 and 5,000 × 10. The simulator keeps all 50,000 models; zoomed-out views are aggregated for presentation only.

The first playable pilot supports two factions, fixed commander assignments, deployment, move/hold/melee/ranged orders, turn close/resolve/next, fog-filtered results, and reconnect. Before publishing a 500-player limit, qualify every advertised mechanic, including walls, terrain, hero actions, spells, or doctrine **if enabled**. Reject unsupported imports or orders with a clear message. Keep legacy browser-hosted worlds unchanged. Continuous realtime, hundreds of separate factions, arbitrary uploaded scripts, full tactical editing inside hosted rooms, and seamless handoff between browser and hosted authority are not part of this release.

## 2. Boundaries and contracts to settle first

```text
GM / commander browser
    ├─ WSS: authenticated commands, private receipts, phase, bounded visible updates
    └─ HTTPS: authorized snapshots, report pages and assets
                         │
          Node room authority — one writer per battle
               ├─ PostgreSQL: orders, freeze records, results, membership
               └─ CPU worker: existing SimRunnerCore + pinned PF1e rules
```

Proposed placement: `services/strategic-room/` as a Node-only workspace, shared message and validation code in `src/core/strategicRoom/`, and a hosted adapter at the [`Transport`](../src/core/net.ts) boundary. Reuse the codecs, permission helpers, rules hooks, and turn reducer where their contracts fit. **Do not wrap the entire current `HostSync` in a WebSocket server.** [`commitSystem`](../src/host/sync.ts#L1002) is synchronous and the existing [`SimBridge`](../src/host/simBridge.ts) is IndexedDB-backed; neither is the hosted durability boundary. Extract reusable context and result-planning code from [`TurnChannel`](../src/host/turnChannel.ts) rather than making the hosted service import browser boot or duplicate PF1e logic.

### Commands, freeze, and durability

- **Admission:** Bind the existing browser identity to a server-approved room membership (GM or assigned commander for the pilot). Use a short-lived, room-bound join/resume handshake with an origin check. Do not inherit automatic first-time PLAYER approval. Start with one commander per unit; reject overlapping assignments at setup. Check role, room, ownership and rule legality at the authority, including coordinates and any permission-sensitive targets.
- **Order batch:** Add a versioned `orders.submit { turnId, expectedRevision, requestId, unitEdits }` and private accepted/rejected response. Each edit replaces or clears that unit's pending order; other entries are untouched. The service stamps identity and turn. Validate all edits or accept none. Start with a 10-unit cap for commander batches and enforce bounded paths and frame sizes. Use [`can(user, "order", …)`](../src/core/permissions.ts) and `RulesModule.validateOrder` with host state; don't take rules data, permissions or results from clients. The Army UI shows draft, sending, accepted revision, or a named rejection. An exact retry returns the same durable receipt; the same request ID with different data is rejected. Check request identity before revision so a retry of a committed batch doesn't fail just because its old revision is now stale. Private receipts are not room-wide ops.
- **Close:** Put `orders.submit` and `turn.close` through the same ordered command lane. The authority inserts a close barrier at the server deadline or on GM close. Only valid commands admitted before the barrier may commit to that turn; after it, return `turn_closed` rather than moving an old draft into the next turn. Readiness is advisory; send a coalesced count where permitted, not a growing full roster on each click. Hosted sessions get no generic unit-order write path, including whole-army replacements and agent/script routes.
- **Resolve and publish:** In the freeze transaction, persist the accepted revisions, stable turn ID, canonical starting checkpoint, versioned rules/data, seed and all other inputs the worker reads (including terrain and leader context if supported). Then dispatch the worker without holding the database lock. Put the new checkpoint, unit/hero changes, report reference and published version behind **one durable commit** before notifying clients. For the pilot, keep compressed turn artifacts in PostgreSQL; avoid a second storage system until size or retention warrants it. Persist or reconstruct any analytics that would otherwise be lost on worker restart. An old worker or authority generation can't publish a result after ownership changes. On failure, resume the frozen job with the exact recorded inputs or pause it for the GM; don't reopen orders or publish partial effects. A crash after commit but before send is a missed notification, not a second resolution.

### Player views and network limits

- **Share only identical views:** Reuse faction detection work, then compose it with membership, ownership and scene policy. A public/team turn summary may be shared; private orders and detailed ownership information may not. Project typed fields rather than redacting free-form report text after serialization. Report pages must satisfy publication-time visibility policy and current access; no raw report or old authoritative OpLog replay to players.
- **Use a small complete default view:** Give clients own-unit state and authorized battlefield summaries; send detailed models by stable ID only for authorized subscribed regions. Use `enter/update/leave` by ID rather than exposing hidden slots or relying on global pool indices that move after compaction. Keep unit and model updates on the same published turn version. Give each subscription its own delivery cursor and visibility epoch; don't infer packet loss from gaps in a global sequence of private operations. On a gap, version mismatch or permission change, discard the old view and load a freshly authorized baseline. Invalidate stale outbox work on revocation. Camera culling cannot grant access.
- **Separate small messages from bulk data:** Bound WSS frames and application/socket queues per session and per room. Coalesce replaceable presence/readiness _before_ enqueue. If a receiver falls behind on state, stop its incremental stream and resync it; if blocked, disconnect it. A sender that misses a durable receipt can recover it with a retry. Fetch large snapshots, report details and map assets over authorized HTTP, outside the command lane. Prioritize the committed receipt over background view work. Do not expose private blobs by hash alone.

Record these choices and proposed wire version in [`PROTOCOL.md`](../PROTOCOL.md) when PR 0 lands. Use an advertised feature/version handshake; never send new wire or checkpoint formats to a legacy client by accident.

## 3. PR sequence and dependencies

| PR                                            | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Exit condition                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Baseline and test harness**             | Move from the [research probe](../performance/strategic/legacyProbe.ts) to an opt-in `performance/strategic/` harness. Pin fixture seeds and geometry. Repair M2's stale player selector in [`e2e/m2.spec.ts`](../e2e/m2.spec.ts) without changing its assertions or enlarging its timeouts to mask failures. Add repeatable sparse, close-contact, mixed, all-move, and dense-front cases. Record separate rules, codec, persistence, projection and client-apply timing where applicable.             | M2 actually deploys and resolves or exposes a new named failure. Both 50k shapes check decoded bounds, counts and placement. Save raw timings, payload sizes, and parity hashes. Ordinary CI runs small correctness fixtures; full perf runs are opt-in on a named runner.                                                                               |
| **1 — Coordinate safety**                     | Add explicit bounds validation around [`deploy`](../src/sim/deploy.ts) and [`codec`](../src/sim/codec.ts) so unsupported scenes/orders fail instead of clipping. Use a new negotiated hosted codec with wider fixed-point coordinates at the same precision; define practical extents that fit the pool's float precision and visibility grid limits. Keep legacy bytes for valid legacy checkpoints and test fenced migration/readers.                                                                 | Encode/decode and resolve/reload correct beyond the old ±2,048 boundary; no wrap, clipped formation, or v1 reader accepting incompatible data. Golden legacy checkpoints and canonical replay still pass.                                                                                                                                                |
| **2 — Resolver performance**                  | In [`massBattlePf1e.ts`](../src/packages/massBattlePf1e.ts), index unit IDs, squads and leaders; replace per-march whole-enemy threat rebuilds with queries of walked cells and reachable reactors. Preserve start-of-turn geometry, reactor ordering, living-state checks and spent opportunity budgets. In [`runner.ts`](../src/sim/runner.ts), produce analytics once and bucket by army. Optimize exact nearest-anchor doctrine separately if the option will ship.                                 | Old/new output parity (model hashes, stats, events and roll evidence) on in-range fixtures; any intentional rules change reviewed separately. Both shapes finish all-march, mixed and dense cases. Aim for ≤3 s p95 in the worker on the reference host for supported workloads; profile before considering additional workers or a rewrite.             |
| **3 — Order service and atomic turn commits** | Implement typed commands, the phase barrier, durable receipts and generation-guarded publication in a small transport-neutral room core plus a PostgreSQL adapter. Add the browser order adapter behind a hosted flag in [`ArmyWindow`](../src/ui/armies/ArmyWindow.svelte) and existing join/client seams. In the hosted path, orders never trigger legacy world/asset projection. Any fast path for legacy [`broadcastEnvelope`](../src/host/sync.ts#L4458) is separate, with asset revocation tests. | Concurrent close/submit tests (including just before/after deadline), duplicate and stale retries, ownership changes, invalid batches, and restart tests pass against real PostgreSQL. No accepted order or result is lost on restart and no unit update or side effect is committed twice. An order-only burst performs zero world/asset reprojections. |
| **4 — Playable hosted slice**                 | Add the Node worker, WSS admission/reconnect, supported world import, versioned authorized views, report paging and bounded queues. Use the existing Army/Map UI through a hosted view adapter; feed [`ModelLayer`](../src/canvas/layers/ModelLayer/index.ts) only visible region detail and don't force legacy contiguous ranges into the hosted protocol. Start with a generated scenario, then import an allowlisted export from a normal world. Leave P2P boot as the default.                      | GM + two browser commanders can join, submit, resolve, browse results, refresh and continue after a service restart. A non-GM client cannot receive another commander's private state, hidden enemy details or hidden assets, even after revocation or rejoin. A slow peer doesn't stall a healthy one.                                                  |
| **5 — Load, pilot, and launch**               | Add real WSS load clients, reference browser profiles, telemetry and failure injection. Run 100 → 250 → 500 commanders, then test 600 connections for headroom. Ramp through opt-in rooms only. Publish supported scope, metrics and operating runbook.                                                                                                                                                                                                                                                 | Pass the gates below on both shapes before raising the room limit. Record any disabled mechanics or workload ceiling explicitly; don't label a synthetic session run as 500-player support.                                                                                                                                                              |

**Parallel work:** After PR 0 fixes the protocol/fixture assumptions, the resolver track (PRs 1–2) and durable room track (PR 3) can proceed independently. Projection and UI can be developed against recorded fixture views while the room is built. The first integrated demo shouldn't wait for final optimization; qualification does. No sharding inside a battle, native rewrite, or new transport until a measured limit remains after this sequence.

## 4. Verification and rollout gates

Use a published server and browser profile; start with a dedicated 8-vCPU / 16-GiB host with 1-Gbit/s networking, separate generators, and a shaped baseline such as 80 ms RTT, 1% packet loss and 10 Mbit/s downstream. Exercise real TLS and Postgres. Run at least 50 turns per shape per qualification run and repeat cold/warm; publish sample counts and per-workload results, so idle turns don't hide slow movement. Use protocol clients for connection volume and representative real browsers for input, rendering, projection, and reconnect. These are **proposed targets**, not results:

| Gate                         | Required evidence                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders                       | 500 active players submit within the last 2 s; client-to-durable-ACK ≤250 ms p95 / ≤1 s p99. Separately inject known late submissions and duplicates. No silently misplaced, partial or lost acknowledged batches.                                                                                                                       |
| Turns                        | Close to durable result notification ≤5 s p95 / ≤10 s p99 in every declared normal workload; no timeouts in the supported stress matrix. Active view applied ≤2 s p95 after notification. Include all-move, all-visible and dense-front cases plus every advertised rules feature.                                                       |
| Delivery                     | Default push ≤128 KiB p95 per commander per turn (including summary and subscribed updates); report pages and assets measured separately. Measure queue high-water marks, event-loop lag, bandwidth and heap under slow receivers; enforce caps and show no unbounded growth in soak.                                                    |
| Reconnect and crash recovery | 50 rejoining during close reach a usable authorized view ≤5 s p95 without breaking healthy ACK targets. Kill the service before/after accepting an order, during resolve, and after committing a result but before announcing it. Durable receipt history and canonical results survive; no double commit or stale writer.               |
| Client and privacy           | On a reference laptop, p95 frame interval ≤33 ms during pan, zoom and result application. Assert on captured client payloads, not just pixels: foreign orders, hidden IDs/details, unauthorized report rows and asset metadata are absent across reveal, revoke, view changes and rejoin. Run legacy strategic/WebRTC regression suites. |

**Ops:** Instrument `queue → durable ACK` and `close → freeze → resolve → commit → project → apply`, grouped by room and workload, without logging private payloads. Alert on timeouts, queue pressure and failed publication. Maintain tested backup/restore and a GM export of the last committed state. Keep hosted mode feature-flagged; if gates regress, stop new admissions, pause at the last durable version and resume on a compatible service build. Do not fall back a live 500-player battle to a GM browser or imply that a widened checkpoint can be opened by a legacy codec.

**First implementation cut:** PR 0 plus the bounds guard from PR 1. That makes the 50k fixture and deployment failures trustworthy before changing PF1e behavior. Then build the movement index and the db-backed order/freeze path in parallel. The first user-visible checkpoint is a small hosted game that survives a restart, not a room with 500 idle sockets.

## 5. Pilot verification

[Runbook and scenario schema](../services/strategic-room/README.md) · [Wire contract](../PROTOCOL.md#hosted-strategic-room-opt-in)

The pilot takes the separate service route: it reuses the PF1e rules, core runner, codec,
permission checks and unit/seed planning. Its independent room adapter and compact map don't
pull in browser boot, legacy `HostSync`, IndexedDB authority or legacy report/asset fan-out. The
map uses unit summaries, with optional visible-tile detail and a device fallback. The player UI
never receives the raw checkpoint, report or another commander's order batch. The first hosted
release uses per-turn outcome rows; it doesn't expose campaign-wide private analytics. The import
is an offline allowlist for fresh deployment, not a migration of ongoing browser worlds.

- **Turn progress:** The GM gets immediate closing feedback. Both paths show resolving and
  applying as the authoritative turn advances. Hosted clients keep the last visible battlefield and
  can pan/zoom while fetching the newer authorized baseline. Legacy peers keep the applying cue if
  the report phase arrives over ops before the matching sim update. The cue never estimates a
  percentage or blocks the board; reduced-motion mode keeps a static icon and text.
- **Correctness:** Legacy M2 now deploys and resolves over real WebRTC; the realtime regression
  also passes. Codec tests cover refusal/rollback, wide positions, snapshot replay, and delta
  coalescing without legacy format drift. A three-browser hosted Chromium test with PostgreSQL
  and the bundled worker exercises admission, private receipts, delayed apply, reconnect after
  process crashes, reports and revocation. PostgreSQL tests also cover FIFO/deadline fencing,
  rejecting a foreign edit atomically, forced lease-backend loss during a frozen job, takeover,
  build pinning and retry. A committed checkpoint/report export was read back, and its scenario
  was reimported as a new 50,000-model deployment. This is not a live checkpoint restore. These
  tests don't replace the release gates in §4.

### Local diagnostics (not capacity qualification)

Same 2-vCPU / 3.85-GiB Linux sandbox for generator, worker and PostgreSQL 18.6, Node 22.22.3,
base `15aec7a` with pilot changes. `bench:strategic matrix 1`: one cold direct-runner sample per
workload and shape. These times include rules and creation of the legacy sim artifacts, not
the hosted worker hop, durable commit, delivery or renderer.

| Direct-runner fixture (50,000 models each)        | 2,500 units | 5,000 units |
| ------------------------------------------------- | ----------: | ----------: |
| Idle                                              |      1.05 s |      1.01 s |
| Contact                                           |      1.60 s |      1.81 s |
| Mixed                                             |      1.52 s |      1.61 s |
| All march                                         |      1.26 s |      1.35 s |
| Dense                                             |      1.53 s |      1.80 s |
| Doctrine (diagnostic only, not enabled in hosted) |      1.63 s |      2.41 s |

Separate generated mixed hosted rooms used signed clients over loopback **WS/HTTP**, 500 commanders
plus one GM. Submissions were spread over 1.8 s, then closed manually; all 500 batches were accepted
in each turn. Latencies below are percentiles **across clients in that turn**, not across runs.

| Hosted mixed turn                                  | Models at start | Durable ACK p95 / p99 | Close → notice p95 | Notice batch → parsed baseline p95 | Default view body p95 | View failures |
| -------------------------------------------------- | --------------: | --------------------: | -----------------: | ---------------------------------: | --------------------: | ------------: |
| 5 units/commander, round 1, 50 reconnects, JSON    |          50,000 |             6 / 13 ms |             2.94 s |                             2.41 s |               ~457 KB |             0 |
| 10 units/commander, round 1, JSON                  |          50,000 |            11 / 17 ms |             3.59 s |                             4.24 s |               ~418 KB |             0 |
| 10 units/commander, round 2, JSON                  |          43,812 |              3 / 5 ms |             2.93 s |                             3.68 s |               ~354 KB |             0 |
| 5 units/commander, round 1, 50 reconnects, compact |          50,000 |             5 / 13 ms |             2.83 s |                             1.22 s |                ~50 KB |             0 |
| 10 units/commander, round 1, compact               |          50,000 |            23 / 31 ms |             3.43 s |                             1.91 s |                ~47 KB |             0 |
| 10 units/commander, round 2, compact               |          43,812 |              3 / 5 ms |             2.69 s |                             1.55 s |                ~41 KB |             0 |

The 50 reconnects during resolution reached a parsed authorized view in 0.20 s p95 in the compact
run. The compact body is the whole HTTP view response (private metadata plus the gzip marker
member); its bytes are `httpBodyBytesP95` in the harness log, and the earlier peak-run figure in the
plan's history was the uncompressed JSON baseline. A publication fetch delay of up to 240 ms is
included in the compact apply times, which are publication notice to parsed view, not paint. The
5,000-unit first turn spent 2.9 s on the hosted worker path, 0.39 s projecting and 0.23 s committing
(not the direct-runner figure). The compact run spread requests; zero views failed and the shared
retry budget absorbed 93 and 71 retries in the 5-unit/10-unit turns. Both rounds now meet the local
≤2 s apply p95 (1.22/1.91 and 1.55 s), but the previous columnar run reached 2.29 s on the second
round and the harness changed in between, so this is not a stable margin; local variance is wide and
these are diagnostics, not qualification. The earlier all-at-once trial missed the ACK budget
(1.19 s p95); it used the pre-tuning HTTP path and is not a result for the spread submission test.
Raw diagnostic logs go under ignored `test-results/strategic500/`.

Binary x/y (`binary-5`, `binary-10`) cut the same body another ~5 KB and the decoder path, but the
gain at this size is dominated by queueing and worker time, not integer layout; the wire now carries
exact big-endian `f64` pairs so projected positions stay bit-identical. Object-per-marker gzip
(`compact-5`, superseded) was slower to apply than columns (4.04 s at 50 k) despite similar bytes.

**Sustained and slow-consumer probes (local, diagnostic).** Both 50k shapes ran 50 turns on a fresh
database with 500 accepted batches per turn, zero refusals, zero failed views and zero dropped
sessions; the 5-unit shape also reconnected 50 players every turn (2,500 rejoin samples, worst p95
273 ms). Worst turns, percentiles **within a turn** and worst across the 50:

| 50 turns, fresh database, compact     | 5 units/commander (+50 reconnects/turn) | 10 units/commander |
| ------------------------------------- | --------------------------------------: | -----------------: |
| Durable ACK p95 (worst turn)          |                                   55 ms |              81 ms |
| Close → notice p95 (worst turn)       |                                  2.87 s |             3.70 s |
| Notice → parsed view p95 (worst turn) |                                  0.72 s |             0.56 s |
| Default body p95 (worst turn)         |                                 53.5 kB |            47.6 kB |
| Models at start → last turn           |                         50,000 → 32,425 |    50,000 → 32,324 |

Those apply figures are deliberately the _browser-shaped_ ones. One decode of the 5,000-marker field
spends about 2.7–3.3 ms of CPU (1.9–2.3 ms inflating gzip, 0.8 ms parsing labels, 0.1 ms building
objects), so 500 clients decoding inside one process on two shared CPUs need about 1.8 s of wall time:
an unsampled run of the same work reported 1.5–2.3 s for what the codec does in milliseconds per
client. Both runs above decode 10 sampled clients and have the other 490 fetch and validate their own
response prefix. That is not a substitute for measuring browsers — it removes a generator artifact so
the remaining number means what it claims. An earlier 50-turn run without sampling and without a fresh
database showed the other confound: hundreds of thousands of accumulated report rows and autovacuum
moved first-turn ACK p95 from about 50 ms to 512 ms, which was test history, not code.

A stalled reader probe paused one player's transport before close: the room shed that session in 11–21 s
while the healthy cohort kept its normal ACK, close and apply figures, and the same identity rejoined in
15 ms once it was shed. That is faster than a 15-second heartbeat would allow if frames were leaving the
server, so the observed 21 s includes the harness's own 500 ms polling and the pause taking effect
mid-stream; it is a correctness probe, not a timing gate. During the same work the harness itself was
wrong twice: it clamped only a march's centroid to the bounds, so legitimate `Formation would extend
outside the battlefield` refusals (725 over one 50-turn run) looked like order loss, and it treated
frames still buffered on a replaced socket as a sequence break. Both are fixed; an authority `receipt`
should still be the only thing that can report a refused order.

**Client frame pacing (local, diagnostic).** The hosted Chromium case now drives the real battlefield —
pointer drags, wheel zooms and keyboard pans on the 50k-model field — while sampling
`requestAnimationFrame` intervals, and re-samples after the turn has settled. On the 2-vCPU sandbox's
headless shell, pan/zoom p95/p99 was **16.7/16.8 ms** (a steady 60 Hz, ~110 samples) both before and
after applying the turn, in three consecutive runs. The window containing the result apply is not
flat: p95 50–67 ms, p99 133–200 ms, one 77–123 ms long task. A CDP CPU profile of that window attributes it to Chromium's accessibility-tree
walk (`getCSSContent`, `getComputedStyle`, `toAriaNode`, `isElementHiddenForAria`), which shares the
main thread and runs over the whole DOM. `Accessibility.disable` and
`--disable-renderer-accessibility` did not remove it in this headless build, so the number is left
unqualified rather than "fixed" by a flag that measurably did not work. Nothing in the app's own
drawing path was on the hot list.

This is therefore a real measurement of drawing and panning, and a _non-qualifying_ one for apply:
the §4 frame gate is a reference-laptop p95 ≤33 ms, and the test asserts it only under
`STRATEGIC_FRAME_PROFILE=reference`. A real browser on a real laptop exposes no ARIA tree to
Chromium's headless automation unless assistive technology is active, so the sandbox's apply-window
stall is expected to be larger than a player's — but that has not been measured, and the report says
so.

**Open before expanding the pilot:** the compact view met the local apply budget in the latest runs
but with no stable margin on a shared sandbox, so measure real TLS/PG on the reference host with
separate generators, timed last-2-second batches, shaped WAN,
slow consumers and representative browsers, prove the default ≤128 KiB and ≤2 s apply gates over a
full 50-turn run, then run 100 → 250 → 500, both shapes, the supported stress matrix, soak, recovery
and backup/restore; 600-session headroom needs a dedicated
qualification fixture, not additional pilot seats. Report actual peaks and per-workload percentiles,
including frame intervals and visible-tile bytes, before advertising any 500-commander limit.
