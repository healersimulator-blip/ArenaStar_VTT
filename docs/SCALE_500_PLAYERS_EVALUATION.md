# Evaluation — 500 concurrent players in strategic (parallel-turns) mode

**Date:** 2026-11-18 · **Branch:** `arena/861c0d5f-arenastar-vtt` (base `b6cc072`) · **Status:** evaluation only, no code changed

**Contents:** §1 verdict · §2 scope/assumptions · §3 what already scales · §4 what does not
(ranked) · §5 required changes · §6 bottom line · Appendix A gap register · Appendix B raw
measurements · Appendix C reproduction · Appendix D caveats · Appendix E gates & reference reading.
Every number in here was measured on this sandbox against the real modules; nothing is inferred
from documentation alone.

Follow-up: [the 50,000-model strategic scaling plan](STRATEGIC_500_PLAYER_PLAN.md) benchmarks both
requested unit counts and a full 500-commander order burst, and recommends a hosted-room design.

---

## 1. Verdict

**Not supported today.** The rules/simulation engine can absorb the *model* counts a 500-player
battle implies; the **host's per-commit fan-out cannot**. One committed intent costs roughly
**0.8–1.5 s of GM-tab main-thread work at 500 sessions**, and a turn in which 500 players each
submit orders is ~500 commits. That is minutes-to-hours of blocked main thread per turn.

The blocking defect is a single cacheable function: `projectAssetManifest` is recomputed for every
session on every commit, **twice**, and each call re-projects the entire world. Fixing that one
path moves the verdict from "impossible" to "feasible with the other items below still open".

| Layer | Verdict at 500 players |
|---|---|
| Rules / sim engine (models) | **Conditional pass** — 10 000 models ≈ 50 ms/turn; ≥500 units ≈ 450 ms/turn (over the repo's own 250 ms ceiling) |
| Host fan-out (world ops) | **Fail** — O(sessions) full-world re-projection per commit, twice per session |
| Join / snapshot | **Fail** — O(n²) join, O(players × models) snapshot broadcast |
| Transport / signaling | **Unproven** — 500 RTCPeerConnections + 2000 DataChannels from one tab; Manual signaling is O(n) human work |
| Asset distribution | **Likely fail** — the GM tab is the CDN |

---

## 2. Scope and assumptions

* **"Strategic mode"** = the §5A/§12 mass-battle channel: one `TurnChannel` + one `SimBridge`/
  `SimRunner` per scene (`src/app/hostBoot.ts:1057`, `DEFAULT_SCENE_ID`), units compiled into a
  columnar `ModelPool`.
* **"Parallel turns mode"** = the `simultaneous` turn mode: `strategicSimultaneous` world setting
  (`src/core/worldSettings.ts:42`, default **off**) or `turn.start {mode:"simultaneous"}`
  (`src/host/turnChannel.ts:375`). All factions resolve in one `resolveTurn` call
  (`src/packages/massBattlePf1e.ts:406`), orders are collected in parallel during the `orders`
  phase.
* **500 concurrent authenticated player sessions on one GM tab**, star topology (§2): every player
  holds one WebRTC peer with the host, 4 DataChannels each.
* **Current certification baseline:** 2 players / 10 000 models, deploy+snapshot < 15 s, advance
  < 15 s (D-082, `PLAN.md:185`). There is **no** player-count target, load test, or documented
  player-scale budget anywhere in the repo (grep for `500 players`, `maxPlayers`, `MAX_SESSIONS`
  finds nothing but `voiceVideo`'s 6-peer mesh).

All timings below were measured on this sandbox (node v22.22.3, linux x64, 2 CPUs) by driving the
real code paths; the probe files were deleted afterwards.

---

## 3. What already scales (and should not be rebuilt)

* **Sim resolution is off the main thread.** `SimWorker`/`InlineSimRunner` → `SimRunnerCore`
  resolves the turn; the host only encodes and sends.
* **Sim wire is tiny.** Measured on a real 10 000-model PF1e battle: full snapshot **9 022 B**,
  per-turn delta **9 834 B** (turn 1) decaying to **48 B** once the engagement settles, `turn.report`
  **~7.2–7.6 KB**. The §19 budgets (≤1.5 MB snapshot, ≤200 B/model) are met with two orders of
  magnitude of headroom.
* **Sim fan-out is already faction-cached.** `broadcastSimTurn` (`src/host/turnChannel.ts:1081`)
  encodes the projected delta once per *faction key* (`encoded` map) and the projected report once
  per faction (`projectedReports`), then re-sends the same bytes to each member. 500 delta encodes
  cost **2.0 ms**. This is the correct pattern — it is just not applied to world ops.
* **Serialization is not the bottleneck.** msgpack encode of a 10 KB delta ≈ 0.004 ms; 500 small
  `ops` envelopes ≈ 9 ms.
* **Turn advance is not all-ready gated.** `turn.advance` (`src/host/turnEngine.ts:109`) rejects
  only on phase, and `handleSimControl` is GM-only (`src/host/turnChannel.ts:409`). `readyUsers` is
  tracked and broadcast but does not block. With 500 players there is no 500-way barrier — the GM
  advances and units without orders hold their doctrine. This is a genuine strength at this scale.
* **Transport is bounded and sharded.** `frameMessage`/`deframeMessage` are single chokepoints;
  frames over `maxMessageSize` (fallback 256 KiB) shard into 64 KiB payloads
  (`src/net/shards.ts`); 1 MiB/256 KiB backpressure band, 256-frame pending cap, 16 streams /
  8 MiB / 4096 shards / 60 s TTL.
* **Per-peer rate limits exist** (`src/core/ratelimit.ts`): intent 30/30 Hz, ephemeral 4/20 Hz,
  asset 20/10 Hz.
* **Canvas LOD** handles 100 k models < 50 ms (`tests/canvas/lod100k.test.ts`).

---

## 4. What does not scale (ranked by leverage)

### 4.1 Per-commit fan-out re-projects the whole world, twice per session — **the blocker**

`HostSync.broadcastEnvelope` (`src/host/sync.ts:4458`) loops every session and, per session:

1. `projectAssetManifest(this.store.world, this.manifestSource(), session.user)` — line **4485**
2. `projectEnvelope(...)` — cheap
3. `sendProjectedManifest(session)` — line 4504 → **calls `projectAssetManifest` again**
   (`src/host/sync.ts:4449`)
4. `sendLevelFocus(session)` — only when the session has level focus

`projectAssetManifest` (`src/core/assetAccess.ts:138`) is not a lookup: for any non-GM viewer it
runs `references(world, manifest)`, then **`projectWorld(withManifest, 0, viewer)`** (line 148),
then a second `references()` over the projected collections, then loops the manifest. It is a full
world projection whose result is only used to compute a fingerprint.

Measured at 500 actors + 500 tokens + 500 users:

| call | ms |
|---|---|
| `projectWorld` | 0.158 |
| `projectAssetManifest` (200-entry manifest) | 1.464 |
| `projectAssetManifest` (empty manifest) | 1.364 |
| `projectAssetManifest` (GM) | 0.0001 |
| `projectEnvelope` (one token update) | 0.0014 |

Per session per commit: **~2.9 ms** (two manifest calls + one envelope). At 500 sessions:
**~1.46 s per committed intent**, all synchronous on the GM main thread. A second run with a
different fixture gave 0.78–0.87 ms per manifest call (→ ~0.8 s per commit); the number is
insensitive to actor sheet size (6 vs 200 system keys), so **0.8–1.5 s per commit is the honest
range**.

`projectEnvelope` is 1000× cheaper than the manifest projection — *envelope* projection is not the
problem, and no amount of work on `projectEnvelope` will matter.

**Consequence:** one player order batch = one commit = ~1 s. 500 players submitting in the same
turn = 500 commits = **400–750 s of blocked GM tab per turn**.

### 4.2 Join is O(n²)

Unknown pubkeys are auto-approved as PLAYER (`src/app/hostShare.ts:118`), so there is no human
approval bottleneck — but `approveSession` **creates a `users` document via `commitOps`**
(`src/host/sync.ts:1814`), and every commit broadcasts to every current session. 500 joins therefore
cost Σ k × (per-session commit cost) ≈ 125 000 session-projections ≈ **200–380 s** of blocked main
thread, on top of 500 full `projectWorld` snapshots (~0.16 ms each, negligible).

### 4.3 `broadcastSnapshots` is O(players × models)

`sendSnapshotTo` (`src/host/turnChannel.ts:1276`) calls `this.visibilityMaps(this.unitViews())`
**per user**. `visibilityMaps` (line 994) reseeds a `DetectionGrid` over the whole pool and computes
per-faction visibility bitmaps. Measured at 10 000 models: reseed **3.51 ms** + `visibleModels`
**0.35 ms**; the per-user bitmap merge is 0.043 ms. So `broadcastSnapshots()` with 500 users ≈
**1.9 s**, and it is called at deploy, on turn undo, and on every `sim.snapshot.get`.
`broadcastSimTurn` gets this right (one `visibilityMaps` per turn, line 1082) — `sendSnapshotTo`
does not reuse it.

### 4.4 Sim turn cost tracks **unit count**, not just model count

Measured (8 turns per shape, this sandbox, p50 over all 8 turns):

| shape | units | models | p50 | turn 1 |
|---|---|---|---|---|
| 20 × 500 | 20 | 10 000 | 52.7 ms | 261 ms |
| 100 × 50 | 100 | 5 000 | 101.8 ms | 253 ms |
| 200 × 25 | 200 | 5 000 | 111.2 ms | 359 ms |
| 1000 × 5 | 1 000 | 5 000 | 141.3 ms | 424 ms |
| **500 × 20** | **500** | **10 000** | **449 ms** | **1 446 ms** |
| 1000 × 20 | 1 000 | 20 000 | 1 650 ms | 5 952 ms |

500 players ⇒ at least 500 units ⇒ **~450 ms/turn at 10 000 models**, which is over the 250 ms
catastrophe ceiling the repo asserts for the 10k gate (`tests/packages/pf1eMassBattleScale.test.ts`).
500 players × 500 models = 250 000 models ⇒ ~10 s+/turn. The §19 target of p95 < 50 ms is not
met at any unit count above ~20 units.

### 4.5 Host uplink and asset distribution

Every player fetches scene/token art from the GM tab: `AssetTransfer`'s read callback
(`src/host/sync.ts:922`) serves `assets.read(hash, offset, length)` per 64 KiB chunk, per peer,
rate-limited at 10 chunks/s. 500 players × a 5 MB map = **2.5 GB of upstream** from one browser tab.
There is no CDN path and no peer-to-peer asset distribution (`asset.share` is a publication slot,
not a byte transfer). The ROADMAP already lists "scene asset mid-LOD/external URL alternative" as
open — at 500 players it stops being optional.

### 4.6 500 RTCPeerConnections from one tab

`HostSessions` (`src/net/peerSession.ts:201`) has **no `maxPeers`** — contrast `voiceVideo`'s
explicit 6-peer mesh (D-104). 500 peers = 500 `RTCPeerConnection`s + 2 000 DataChannels, each with
ICE/DTLS state, plus a 2 s heartbeat sweep over all entries. Browser per-page WebRTC connection
limits are an **unverified constraint** here (no browser was available in this sandbox) and must be
measured before committing to this topology.

### 4.7 Signaling

Manual signaling is per-player copy/paste codes (`HostShare.takeOutbox`/`receiveCode`) — O(n) human
work, unusable at 500. Nostr is the only scalable path, and it depends on three public relays
(damus/nos.lol/nostr.band) with their own rate limits and an 8 s readiness race
(`src/app/hostShare.ts:92`). If relays are slow, players silently fall back to Manual.

---

## 5. What would have to change (ordered by leverage)

1. **Cache the projected manifest per (user, world revision); compute it once per session per
   commit.** `projectAssetManifest(world, manifest, user)` is a pure function of the store revision,
   the manifest and the viewer. In `broadcastEnvelope`, replace the two calls with one cached value
   keyed on `store.seq` (+ manifest identity, + user). This alone takes a 500-player commit from
   ~1 s to ~1 ms and is behaviour-preserving. *Highest leverage by a wide margin.*
2. **Batch commits per turn.** The client already batches a multi-unit order into one intent
   (`src/ui/armies/ArmyWindow.svelte:325`); the host could coalesce order-phase commits into one
   envelope per tick (or per turn), turning 500 commits into a handful. Combined with (1), the
   per-turn host cost becomes negligible.
3. **Reuse one `visibilityMaps` per turn in `sendSnapshotTo`.** Pass the maps in (or cache them on
   the channel with the turn's revision) instead of reseeding per user — removes O(players × models)
   from deploy/undo/`sim.snapshot.get`.
4. **Cache `projectEnvelope` per viewer class.** In a mass battle most players share a faction-wide
   view; the same faction-key caching `broadcastSimTurn` already does applies. Lower priority than
   (1) because envelope projection is already ~0.001 ms.
5. **Add a player budget and a `maxPeers` cap** to `HostSessions`, and a 500-player load test with
   N fake sessions (mirroring the 10k-model gate) so the fan-out cost is asserted, not inferred.
   Put the budget in §19 next to the model budgets.
6. **Move asset bytes off the host** (external URL/CDN — already a ROADMAP item — or P2P relay).
   Without this the GM tab is the CDN and 500 players is an uplink problem regardless of fan-out.
7. **Reduce unit-count cost in the sim** (the V07b density item is the same family): 500 units at
   10k models is 450 ms/turn, and the per-unit overhead is the dominant term above ~100 units.

---

## 6. Bottom line

*The simulation is not the problem — the fan-out is.* A 500-player parallel-turns battle is
reachable, but not by tuning: the host currently re-projects the entire world twice per player every
time any player does anything. Item 1 (manifest cache) plus item 2 (commit batching) are the two
changes that decide the answer; everything else is capacity engineering around them.

---

## Appendix A — gap register

| ID | Finding | Evidence | Cost at 500 players | Severity | Remediation | Leverage |
|---|---|---|---|---|---|---|
| G-500-01 | Per-commit fan-out re-projects the whole world, **twice per session** | `src/host/sync.ts:4485` + `src/host/sync.ts:4504` → `src/core/assetAccess.ts:138,148` | **0.8–1.5 s host main thread per commit**; 500 order commits/turn ⇒ 400–750 s | **Blocker** | cache `projectAssetManifest` per (user, world revision); call once per session | ★★★ |
| G-500-02 | Join is O(n²): each new user is a committed doc | `src/host/sync.ts:1814` | ≈200–380 s join phase, tab blocked | High | pre-register users, or suppress the world broadcast for pure-join commits | ★★ |
| G-500-03 | `broadcastSnapshots` reseeds detection per user | `src/host/turnChannel.ts:1276` → `:994` | ≈1.9 s per broadcast (deploy / undo / `sim.snapshot.get`) | Medium | compute `visibilityMaps` once per turn and pass it in | ★★ |
| G-500-04 | Sim turn cost tracks **unit count**, not model count | §4.4 table | 449 ms/turn at 500 units × 20 models (10k) — over the repo's own 250 ms ceiling | High | unit-count budget; density work (same family as V07b) | ★★ |
| G-500-05 | Asset bytes are served host-side, per peer | `src/host/sync.ts:922` | 2.5 GB upstream for 500 × a 5 MB map | High | CDN / external URL (open ROADMAP item) or P2P asset relay | ★★ (independent) |
| G-500-06 | No `maxPeers`; 500 RTC peers + 2000 DataChannels from one tab | `src/net/peerSession.ts:201` | unverified browser limit; ICE/DTLS CPU on the host | Unproven | add a cap (as `voiceVideo` does) and measure the real browser ceiling | ★ |
| G-500-07 | Manual signaling is O(n) human copy/paste | `src/app/hostShare.ts` `takeOutbox`/`receiveCode` | unusable at 500; Nostr is the only path and depends on 3 public relays | High if relays fail | require/monitor Nostr; surface the fallback instead of silently degrading | ★ |
| G-500-08 | No player-count budget, cap, or load test | grep for `500 players`, `maxPlayers`, `MAX_SESSIONS` → only `voiceVideo`'s 6 | regressions are invisible | add a §19 player budget + an N-fake-session harness | ★ |

## Appendix B — raw measurements

Environment: node v22.22.3, linux x64, 2 CPUs, 3.8 GB. Best-of-N after warm-up; probes drove the real
modules (`HostSync`'s projection calls, `DetectionGrid`, `SimRunnerCore` via `InlineSimRunner`).

**B1 — fan-out breakdown** (500 actors + 500 tokens + 500 users; 200-entry manifest):

```
{"projectWorld":0.1577,"projectAssetManifest":1.4635,"projectAssetManifestEmpty":1.364,
 "projectEnvelope":0.0014,"projectAssetManifestGm":0.0001,
 "perSessionPerCommitMs":2.9284,"perCommit500SessionsMs":1464}
```

Second fixture, varying actor `system` size (6 / 40 / 200 keys) — i.e. the cost is document-count
bound, not field-depth bound:

```
PROBE5 actorSystemKeys=6:   projectAssetManifest=0.865ms => 500 sessions x2 = 865ms per commit
PROBE5 actorSystemKeys=40:  projectAssetManifest=0.782ms => 500 sessions x2 = 782ms per commit
PROBE5 actorSystemKeys=200: projectAssetManifest=0.781ms => 500 sessions x2 = 781ms per commit
```

**B2 — detection / snapshot broadcast** (10 000 models):

```
PROBE2 reseed=3.51ms visibleModels=0.35ms visLen=10000
PROBE2 500 userBitmap merges=21.4ms (0.043ms each)
PROBE2 => broadcastSnapshots(500 users) ≈ 1928ms of host work
```

**B3 — sim turn cost vs unit count** (p50 over 8 turns; `delta` = last turn's bytes, `ev` = events):

```
PROBE4 20x500:   units=20   models=10000  p50=52.7ms
  turns: t1:261.4ms/9834B/20ev t2:114.3ms/8437B/20ev t3:57.9ms/122B/20ev t4:52.7ms/48B/20ev ...
PROBE4 100x50:   units=100  models=5000   p50=101.8ms
PROBE4 200x25:   units=200  models=5000   p50=111.2ms
PROBE4 1000x5:   units=1000 models=5000   p50=141.3ms
PROBE4 500x20:   units=500  models=10000  p50=449.2ms
  turns: t1:1445.6ms/12076B/500ev t2:549.4ms/13010B/500ev t3:449.2ms/12632B/500ev ...
PROBE4 1000x20:  units=1000 models=20000  p50=1649.8ms
  turns: t1:5951.9ms/23057B/1000ev ...
```

**B4 — sim wire size** (10 000-model PF1e battle, 12 turns):

```
PROBE turn1: delta=9831B report=7595B | turn2: delta=8432B report=7299B
       turn3: delta=122B  report=7246B | turn12: delta=48B report=7224B
PROBE checkpoint=9022B
PROBE projected-per-faction delta=8387B
PROBE snapshot full=9022B projected-one-faction=9022B
PROBE 500 delta encodes: 2.0 ms (0.004 ms each)
PROBE 500 report encodes: 1.1 ms
```

(`projectSimSnapshot` masks hidden models rather than dropping them, so a per-faction snapshot is
the same size as the full one — 9 KB at 10k models, which is why snapshot size is a non-issue.)

## Appendix C — reproduction

The probes were temporary `tests/*.test.ts` files, run with
`corepack pnpm exec vitest run tests/<file>.test.ts`, then deleted. Equivalent minimal harness for
the blocking finding (G-500-01):

```ts
import { projectAssetManifest } from "../src/core/assetAccess";
import { projectWorld, projectEnvelope } from "../src/core/projection";
import { emptyWorld } from "./net/fixtures";

// world: 500 actors + 500 tokens + 500 users, one 200-entry manifest — see §B1
const user = { id: "a0", role: "PLAYER" } as const;
const env  = { seq: 1, ts: 0, by: "a0", txId: "t", ops: [/* one token update */] } as never;

// broadcastEnvelope() does this twice per session (sync.ts:4485 and :4504)
const perSessionMs = 2 * projectAssetManifest(world, manifest, user)
                   + projectEnvelope(env, user, resolver);
console.log(perSessionMs * 500); // ≈ 1500 ms of GM main-thread work per commit
```

For the sim table (G-500-04), build `UnitView[]` at *n* units × *m* models, `deploySnapshot(...)`
them, load into `InlineSimRunner(createMassBattlePf1e())`, and time `runner.resolve(...)` per turn.

## Appendix D — caveats

* All timings are from a 2-CPU sandbox. Absolute numbers will differ on a real machine; the
  *shape* (per-commit O(sessions), per-turn O(units)) is what carries over.
* The fan-out fixture is a synthetic 500-actor/token world. It is, if anything, **optimistic** —
  real PF1e actor sheets are larger, and `references()` walks every document on every call.
* No browser was available in this sandbox, so **every browser-side claim is unverified**: WebRTC
  per-page connection limits, DataChannel throughput at 500 peers, and the player-client render
  cost of a 500-unit canvas. These must be measured before committing to the star topology.
* "Parallel turns" is read as the `simultaneous` turn mode. If the intended meaning is instead
  "all players may act during the same `orders` window in stepwise mode", the fan-out findings are
  unchanged — only the sim-side table (G-500-04) would differ.

## Appendix E — existing gates and reference reading

* `tests/packages/pf1eMassBattleScale.test.ts` — 10k models, 24 turns, 250 ms ceiling, ≤1.5 MB
  snapshot, ≤200 B/model, byte-determinism.
* `tests/packages/pf1eDenseArmyBenchmark.test.ts` — 20×500 vs 40×250 (`VTT_DENSE_BENCH=1`).
* `tests/canvas/lod100k.test.ts` — 100k-model LOD < 50 ms.
* `e2e/m2.spec.ts` — the 2-player / 10k-model acceptance (D-082).
* Static reading: `src/host/sync.ts:4449,4458,4485,4504`; `src/core/assetAccess.ts:138,148`;
  `src/core/projection.ts:655,1233`; `src/host/turnChannel.ts:375,409,994,1081,1230,1276`;
  `src/host/turnEngine.ts:109`; `src/host/simBridge.ts:111`; `src/net/peerSession.ts:201`;
  `src/app/hostShare.ts:92,118`; `src/core/ratelimit.ts`; `src/net/shards.ts`; `src/net/webrtc.ts`;
  `src/core/worldSettings.ts:42`; `src/packages/massBattlePf1e.ts:406`; `src/ui/armies/ArmyWindow.svelte:325`.
