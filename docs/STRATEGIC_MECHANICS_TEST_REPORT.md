# What the strategic battle actually does — local verification, 2026-11-19

> **Historical verification report.** Statements below describe the tested build on that date, not
> strategic mode's intended product boundary. **Strategic mode should be the full VTT operating at
> formation scale, not a reduced battle service.** See
> [STRATEGIC_FULL_VTT_DESIGN.md](STRATEGIC_FULL_VTT_DESIGN.md). Later work added frozen hosted spell
> hazards; regular PF1e casting and the complete campaign projection remain integration gaps.

## Follow-up: publication latency at 500 players

All 500 commanders reconstructed both mixed-combat results in each run (5,000 units, 50,000 starting models, plus one GM; 10 reconnects per turn). Timings below run from **each commander’s own publication notice to its decoded view**, not from GM close to browser paint. The 3.85 s result below was measured under contention; the first row here is the fairer isolated control.

| Same-host HTTP/WS + PostgreSQL, isolated | Turn 1 p95 | Turn 2 p95 | HTTP retries | Failed views |
|---|---:|---:|---:|---:|
| Before, full compact snapshots | 2.28 s | 1.99 s | 199 | 0 |
| Final build, forced full snapshots | 2.25 s | 1.89 s | 173 | 0 |
| Final build, first changeset run | 0.90 s | 0.56 s | 0 | 0 |
| Final build, second changeset run | 0.98 s | 0.60 s | 0 | 0 |

The same authorized session can now reconstruct its next marker list from the previous one: copy unchanged runs, replace only changed coordinates, and omit vanished markers. A newly visible marker, changed labels, wrong or absent base, or a patch no smaller than a snapshot takes the full-view path. The edge prepares the change list once per fog cohort, not per commander. During a publication burst, eligible sessions may briefly wait for a bulk slot instead of retrying; the limit on concurrent work and the DB membership check are unchanged. Client points use double fields from deployment, avoiding a large first-contact conversion when integer coordinates become fractional centroids.

The two repeats applied 2,000 actual changesets in total, not sampled headers. The per-turn p95 default payload was 44,450 and 25,871 bytes versus 47,801 and 46,129 before. Both repeats met the **2 s notice-to-decoded-view diagnostic target**. They do **not** establish cold-start latency, WAN latency, frame rate, or 500-browser capacity; GM close-to-notice still took up to 3.81 s p95. [Per-turn evidence and reproduction command](../performance/strategic/evidence/2026-11-19-marker-latency.json).

**Regression checks:** 6,080 unit and integration tests passed with PostgreSQL enabled (12 skipped). All three campaign/hosted Chromium tests passed, including a 50k-model view whose reconstructed marker list and private metadata exactly matched a separately fetched full snapshot. TypeScript, Svelte, focused lint, production builds and the single-file size gate passed.

## Collision and mechanics fix verification

- **Hosted collisions:** each frozen turn reserves living models’ starting 5-ft cells, then reserves the cells swept by whole formations in deployment order, independent of packet arrival. A blocked march stops as a unit at the last clear increment; the commander sees **March blocked** in their private report, without a blocker ID. Paths do not swap or cross another march's trail in the same turn. This is conservative grid occupancy, not continuous body physics or automatic rerouting. In tightly packed ranks, an accepted order may make little or no progress. Give companies lanes or stagger their turns.
- **Local PF1e envelopment:** the nearest excess file takes the defender’s forward flank corner, then farther files step toward its rear, not back toward the attacker. The four-heading contact and opt-out tests still apply. This remains an abstract doctrine manoeuvre, not the standalone reference’s complete perimeter planner.
- **Reference hazards:** the radial clamp has a deterministic direction even at the origin; an anchor’s proposed step and its alternatives are tested against the entire segment of each active harmful burst. Entering a second zone is not excused just because the anchor starts inside a different one. Both formerly expected-failure Chromium cases now require success.
- **Scope:** the hosted order vocabulary has not changed. This patch fixes collisions there; it does not enable doctrine, reform orders, or spell hazards in hosted play. The hosted worker is rules-pinned: finish existing active battles with their existing build; use the rebuilt service for new battles.

**Before/after, same fresh-scene march:** after turn five the old worker had 16,502 excess occupants. The fixed worker had **zero** at deployment and after **each of five turns**. The audit decoded all 50,000 models in each saved checkpoint and checked stable IDs, 10×10 offsets, ranges and displacement. Companies moving at least some distance on turns 1–5: **500, 3, 4, 5, 6**. The low later counts reflect the deliberately packed orders and the no-swap policy; the fix is not masking overlap by deleting bodies.

| Final worker, 500 commanders + GM | Turns | Accepted / refused order batches | Worst durable ACK p95 | Worst close → notice p95 | Worst notice → fully decoded view p95 | View retries / final failures |
|---|---:|---:|---:|---:|---:|---:|
| 500 × 100-model fresh companies, march | 5 | 2500 / 0 | 145 ms | 2.93 s | 1.21 s | 587 / 0 |
| 5000 × 10-model units, mixed combat | 2 | 1000 / 0 | 97 ms | 4.72 s | 3.85 s | 410 / 0 |

All players fully decoded all published baselines; 10 reconnected per turn. This is a shared two-CPU HTTP/WS loopback run concurrent with other regression work. The mixed run is **over** the proposed 2 s notice-to-apply budget. The three-context 50k Chromium diagnostic observed 16.8 ms pan/zoom vs 33.3 ms publish/apply frame p95 (33 ms reference target). No production latency or frame-rate qualification is claimed. [Per-turn measurements and occupancy audit](../performance/strategic/evidence/2026-11-19-collision-fix.json). The commands at the bottom reproduce the runs (use `STRATEGIC_LOAD_DECODE_SAMPLE=0` and `500 10 2 mixed` for the second row).

**Restart handling:** broader tests exposed a separate PostgreSQL race: returning from close could precede the server's release of its advisory lock. Graceful shutdown and a failed pin check now await unlock on the owning session before disconnecting. The pin and single-writer fence remain enforced. A regression claims the room with the correct worker immediately after rejecting the wrong worker, without sleep/retry.

**Final regression:** real PostgreSQL enabled, 6,077 Vitest tests passed, 12 skipped. All eight standalone reference Chromium cases passed without expected failures. Campaign and hosted Chromium tests passed on the final service, including the blocked-march report after a restart. The shipped PF1e package browser checks, TypeScript, targeted lint, builds and single-file size gate passed.

## Initial investigation (before fixes; historical measurements)

**GM decision:** use the hosted campaign battle for fixed infantry formations, marches, hold, melee and ranged orders. Do not plan an encounter that depends on flank wrapping, closing holes after casualties, or steering around spell zones in that mode. The tests below exercise three different engines/configurations, not three interchangeable ways of reaching the same rules. No combat rule was changed for this run.

| Mechanic | GM-launched hosted battle | Local PF1e strategic resolver | Standalone `Examples/combat_resolver_5.html` |
|---|---|---|---|
| Ranks on deployment and march | Nine strengths from 1 to 100, including 9/10/11 and 19/20/21. Ten files per full rank, five feet between occupied slots. All living models retained their offsets on a 20-ft march; opposing models held. A legal endpoint for the leading model was refused when a rear rank would exceed the map by 1/16 ft. | Deployment also supports column and wedge. Its march translates the formation; it is not per-model steering. | Models have individual file/rank slots and pursue their slot positions. |
| Envelopment | Off. Hosted rules input sets `envelop: false` and does not enable doctrine. The command parser refuses an envelop order. | With doctrine on: a seven-file line vs three files moved exactly four excess models, on their own sides. Central and defending files held. Verified on four headings, at 4 ft, exactly 10 ft and 1/16 ft outside the contact band. Opt-out/hold and default-off cases are separate tests. | In the 9-file vs 3-file fixture, outer models held their goals at `(100,80)` / `(100,120)` across a gap. On contact they aimed for `(115,92)` / `(115,108)` beyond the defender's front at `x=105`. This checks chosen stations, not a guarantee that a soldier can reach the goal this action. |
| Casualties / reforming | Five successive melee turns at each of three seeds, rerun from cloned frozen inputs. Same checkpoint hash and report rows; unique surviving IDs stayed in the correct unit range and location, and losses balanced. Compaction is **not** closing the hole. No reform order. | Frontage set at deploy; mid-battle formation orders rejected. | A dead front soldier promoted only following soldiers of that file. Under an ordered reform the anchor advanced 15 instead of 30 ft; after an actual `stepRound`, the promoted soldier moved to within half a square of the front slot. |
| Hazards | No scenario terrain, walls or harmful areas in this pilot. Tested the scenario allowlist rather than claiming an empty field proves avoidance. | A march pays extra for difficult cells; an illegal charge is refused and a movement-blocking wall clips a path. These are path **costs/limits**, not autonomous detours. | Tested live vs inactive Burning Entanglement and Black Tentacles; a traced model skirted a burst, reached the far side and returned to a goal once released. Two edge cases below still fail. |

**Hosted collision finding: a rigid company is not a solid obstacle to another company.** For the GM panel’s fresh-scene layout, we marched 500 companies of 100 for five turns. We decoded all six committed PostgreSQL checkpoints and checked all 50,000 model IDs, unit ranges, 10×10 five-foot slot offsets and per-turn displacement bounds. All held. Initial deployment occupied 50,000 distinct grid cells. After turn five, only **33,498** cells were occupied: **16,502 models beyond the first occupant** across shared squares. This counts models beyond the first per cell, not collision events or pairs. The small two-commander reproduction also confirms two separately legal marches can leave two opposing models at the **same coordinates**. Kept as an explicit expected failure. A GM who needs units to block passage should not rely on this mode yet.

**Envelopment is not reference-identical.** The PF1e rule relocates the excess files on contact as an abstract manoeuvre. In the eastbound fixture the second flank slot is five feet *back toward the attacker* from the defender's corner; the reference aims *deeper along the defender*. Four rotations preserve the local rule, not the reference pattern. Decide which geometry is wanted before porting it to hosted play.

**Two reproduced reference defects (expected failures, not passes):** (1) clamping a goal exactly at the centre of a live burst returns the centre instead of a safe rim point; (2) a 30-ft anchor step with both endpoints safe can clip the edge of a live 40-ft burst. The per-model detour success doesn't prove the swept path of a whole unit is clear. Expected failures mark only the failing behavioral assertions; an unexpected fix is visible to Playwright. Neither defect was observed in hosted play: the requisite hazard is absent there.

### Evidence and reproduction

- Hosted deployment → frozen job → published codec-2 model pool: [`formationTurns.test.ts`](../tests/strategicRoom/formationTurns.test.ts). Local wrap: [`strategicDoctrine.test.ts`](../tests/packages/strategicDoctrine.test.ts). Terrain and walls: [`massBattlePf1e.test.ts`](../tests/packages/massBattlePf1e.test.ts), [`pf1eStride.test.ts`](../tests/packages/pf1eStride.test.ts). Checkpoint/delta determinism: [`strategicGoldenGate.test.ts`](../tests/sim/strategicGoldenGate.test.ts).
- The [reference Chromium spec](../e2e/formation_reference.spec.ts) loads the checked-in HTML via `file://` and executes its functions on seeded battles. Six behavioral passes, two expected failures. Run `corepack pnpm test:e2e:formation-reference`; no database or app build needed.
- With a disposable database and built app/service/packages: `corepack pnpm exec vitest run --maxWorkers=1 --testTimeout=20000` and `corepack pnpm exec playwright test --project=chromium --workers=1 --retries=0 e2e/{campaign_battle,hosted_strategic,pf1e_mass_battles,pf1e_movement}.spec.ts`. Set `STRATEGIC_TEST_DATABASE_URL` to run the DB cases. The tactical movement spec now uses a **joined player**, not a GM override, for the over-budget and occupied-square refusals. The package boot spec asserts the worker, in-page and UI boot results. Neither substitutes for strategic movement tests.

### Run results and limits

- Full serial Vitest with real PostgreSQL: **6,072 passed, 12 skipped**, 212 s. That run included the 10k-model 24-turn gate, ten-turn golden replay, all 14 new hosted formation checks and the new rotated doctrine cases. The subsequently added minimal collision reproduction ran separately: 14 passed + 1 expected failure in the formation file. Nothing silently converts this known failure to a pass.
- `VTT_DENSE_BENCH=1`: 5/5 passed in isolation. With 3 warm-up turns discarded and 12 measured, p95 was **75.8 ms** (20 × 500) and **70.8 ms** (40 × 250), below the 250 ms regression ceiling but **not** the 50 ms target.
- Chromium: campaign launch/play/restart/resume/finish passed; 8/8 passed across hosted-room, shipped PF1e packages and tactical movement in the corrected no-retry run. The 50k browser diagnostic (three real browser contexts, not 500) measured pan/zoom frame p95 **16.7 ms** but publish/apply frame p95 **50 ms** vs a 33 ms reference target. This sandbox is not the reference laptop.
- Initial runs exposed test issues rather than rule changes: the new reference spec needed batch registration; the package boot gained two fields; and two old tactical refusal tests dragged as GM. Under concurrent load, the Svelte source scan exceeded the default 5 s test timeout and the 50k browser function check was still resolving at 5 s. Reruns used an explicit bounded functional wait, without relaxing frame or benchmark thresholds. The fresh-layout generator now validates membership against the launched roster rather than assuming demo unit ID prefixes.

## Campaign launch and transport load

Fresh signed GM launch via `/api/campaign/launch` → scoped `/battle/<id>` WS + HTTP → PostgreSQL order receipts → worker resolution → publication → signed finish. No direct injection of orders/checkpoints. One GM in addition to the commander count. Each turn all commanders fetched their initial view and sent one order batch over a 1.8-s spread; ten disconnected/rejoined around resolution. Duplicate-receipt replay and late-order fencing checked each turn. [Per-turn measurements, including retries](../performance/strategic/evidence/2026-11-19-campaign-loopback.json).

| Commanders × units/seat | Starting models; work; turns | Full post-publish decodes/turn | Worst durable ACK p95 | Worst close → report notice p95¹ | Worst notice → checked view p95² | View retries / final failures |
|---|---|---:|---:|---:|---:|---:|
| 100 × 10 | 10,000; mixed; 2 | 10 | 8 ms | 1.64 s | 0.24 s | 0 / 0 |
| 250 × 5 | 25,000; contact; 2 | 10 | 30 ms | 2.14 s | 0.40 s | 0 / 0 |
| 500 × 10 | 50,000; mixed; 3 | 10 | 37 ms | 4.09 s | 0.61 s | 129 / 0 |
| 500 × 5 | 50,000; dense melee; 3 | **500** | 28 ms | 2.72 s | **1.69 s** | 314 / 0 |
| 500 × 1 (GM fresh layout) | 50,000 throughout; march; 5 | **500** | 32 ms | 2.31 s | 0.74 s | 354 / 0 |

¹ From issuing GM close to the new report head, excluding reconnects. ² Includes the generator's publication jitter, HTTP fetch/retry and result validation. For the sampled runs, everyone fetched the body but only the sample inflated the full published marker table; the remaining clients validated version/epoch/prefix. For dense melee and the fresh companies **every** client decoded. This is not frame presentation time. Worst per-turn percentiles, not pooled averages. Battle sizes decrease as casualties accumulate; e.g. dense began successive turns with 50,000 / 30,223 / 18,416 models.

Across these fifteen turns: **6,200 accepted batches**, zero refused batches, 150 exercised reconnects. Retries under load are real; zero final failures is not zero congestion. Loopback HTTP/WS only, 2 vCPUs / 3.8 GiB shared by the database, server, worker and generator; other regression work overlapped some measurements. No 500 browser renderers, WAN latency/loss, TLS, multi-host recovery, long-duration soak or reference hardware. This is evidence for a pilot, **not** qualification for a 500-human event.

```sh
corepack pnpm build && corepack pnpm build:strategic && corepack pnpm build:systems
# Set STRATEGIC_TEST_DATABASE_URL to your disposable local PostgreSQL URL first.
node performance/strategic/localCampaign.mjs 100 10 2 mixed
node performance/strategic/localCampaign.mjs 250 5 2 contact
node performance/strategic/localCampaign.mjs 500 10 3 mixed
STRATEGIC_LOAD_DECODE_SAMPLE=0 node performance/strategic/localCampaign.mjs 500 5 3 dense
STRATEGIC_LOAD_DECODE_SAMPLE=0 node performance/strategic/localCampaign.mjs 500 1 5 march
```

The wrapper creates a unique slot and secret, starts a local campaign server, and finishes the battle. It retains the ended test rows; discard the test database afterwards. The GM UI itself is exercised in `e2e/campaign_battle.spec.ts`, including restart and resume. For release gates see [the implementation plan](STRATEGIC_500_IMPLEMENTATION_PLAN.md).
