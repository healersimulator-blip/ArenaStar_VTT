# PR #55 follow-up fixes and sandbox qualification workaround — 2026-11-20

Branch: `arena/2ef4481d-arenastar-vtt`, based on `9d58441c2b8eb8298cac55ca1b7326c0d30561e6` (`main`). This document is the current state after the merged PR #55 review in [`REVIEW_PR55_2026-11-20.md`](../REVIEW_PR55_2026-11-20.md). The original review remains a historical record of the PR as merged; this follow-up implements its findings and adds a reproducible, explicitly bounded qualification ladder.

## Verdict

**Functional review findings 1–6 are fixed and covered by new regression tests.** All database-gated unit tests, the full Vitest suite, both production builds, the single-file size gate, touched-file lint, and the three Chromium hosted/campaign E2E specs pass.

**Full production qualification still cannot be met inside this sandbox.** The workaround is a two-part gate:

1. run local, reproducible **surrogate diagnostics** — 500 virtual protocol clients over loopback TLS/WSS with synthetic request delay/loss, repeated short battles, and a CPU-throttled Chromium frame surrogate; and
2. keep a clearly itemised **external runner** requirement for real WAN paths, 500 browser renderers, long soak/multi-host recovery, and the published reference-laptop frame test.

Local surrogate numbers are useful regression evidence, not a production capacity claim.

## Fixes by finding

### 1. Durable, version-keyed seat control

- `services/strategic-room/schema.sql` adds `strategic_members.control_units jsonb` as the canonical per-seat control and `strategic_versions.control jsonb` as a publication snapshot. SQL `NULL` means unrestricted (the seat's own deployment); `[]` means an explicit no-unit allowlist.
- Legacy non-empty `strategic_control` rows are backfilled into `control_units`; the legacy table remains a mirror for compatibility. A lost explicit `[]` cannot be reconstructed from sparse legacy rows and must be re-applied by the GM. New publications store their own resolved control snapshot.
- `PostgresRoom.roster()` reads canonical control and no longer coalesces an explicit empty allowlist back to the deployment. `PostgresRoom.grants()` returns `null` for unrestricted seats, `[]` for explicitly none.
- `StrategicAuthority.open()` hydrates the live view from `liveControl()`, while `version()` returns the immutable snapshot stored with that version. `member.update`, `member.revoke`, and publication capture grants within the authority's serialization lane, so edits made during a resolution belong to the publication that actually commits.
- `BattleView` distinguishes missing control (own deployment), `null` (live-view reset to own deployment), and `[]` (explicit no units). Order validation uses the same effective allowlist as the scoped view.

Regression tests in `tests/strategicRoom/postgres.test.ts` cover: one seat's grant not disabling another after restart; explicit empty allowlist persistence after restart; a later grant edit not rewriting an older publication; invite generation bump; and revoke clearing both canonical and legacy grant rows.

### 2. Recoverable/reissued invitations

- New `services/strategic-room/src/invite.ts` provides SHA-256 digesting and AES-256-GCM sealed, room-bound invite resend copies. `PostgresRoom` stores the digest plus `invite_cipher`; the GM roster decrypts and verifies the cipher before returning a code.
- `member.invite` seals the accepted code, bumps the `members` generation, and returns the code in the GM's accepted receipt and subsequent roster view. The UI no longer displays a locally generated UUID before server acceptance; it renders only a code returned by an accepted roster view.
- `admit()` clears the cipher when a code is claimed. `campaign.ts` retry launch returns sealed/verified codes, including a reissued GM code rather than the original HMAC code, and seals verified legacy HMAC invites for later retries.
- `PROTOCOL.md` and `services/strategic-room/README.md` now describe recoverable invites and the generation bump.

New `tests/strategicRoom/campaignInvite.test.ts` exercises a real PostgreSQL reissued invite followed by retry launch. `tests/strategicRoom/postgres.test.ts` checks accepted receipt, roster recovery, one-time admission, generation bump, and revoke cleanup.

### 3. Battle art endpoint, build, and client wiring

- `services/strategic-room/web/scene/scene.webp` is a tiny 170-byte WebP generated with ImageMagick (`convert`); Python `PIL` was unavailable.
- `services/strategic-room/build.mjs` copies source `web/scene/` into `dist/web/scene/` after Vite empties the output directory. Both source and built server layouts now resolve `../web/scene/`.
- `server.ts` no longer requires an `Origin` header on a same-origin GET/image fetch. It rejects an explicit foreign origin or `Sec-Fetch-Site: cross-site`, serves known SHA-256 hashes with immutable caching, and advertises a relative URL that works both at `/` and under `/battle/<id>/`.
- `HostedRoom.svelte` prefetches GM-only advertised image assets with `new Image()` and a `SvelteSet` de-duplication cache.
- `tests/strategicRoom/edge.test.ts` asserts a real `200 image/webp` response, immutable cache header, byte equality, and foreign/cross-site/unknown hash `404`. `e2e/hosted_strategic.spec.ts` asserts the GM browser actually issues the advertised relative media request and that it returns `200`.

### 4. Scene-pack decompression bounds

`src/client/scenePack.ts` now preflights both the classic-ZIP central directory and every matching local header before `unzipSync` allocates inflated bytes. It rejects ZIP64, data descriptors, unsupported compression methods, duplicate or missing entries, too many entries, malformed directories, local/central size or name disagreements, per-entry overruns, and cumulative uncompressed size over `MAX_PACK_BYTES`, including unlisted entries. After decoding it requires the returned entry set and each byte count to equal the preflighted directory, then accounts for every inflated byte, verifies manifest `entry.size` against actual bytes, and verifies each asset path against its SHA-256 content hash. `parseScenePackManifest` rejects asset sizes over the cap. `tests/strategicRoom/scenePreload.test.ts` adds manifest-size mismatch, unlisted zip-bomb, and forged local/central header disagreement regression cases.

### 5. Membership generation and revoke semantics

`member.invite` now calls `setMembers()`, and `member.revoke` clears `control_units`, deletes legacy `strategic_control` rows, and returns a live control reset. `PROTOCOL.md` and the service README were corrected. The new `postgres.test.ts` case asserts the generation increase and both grant representations disappearing on revoke.

### 6. Fairness and refetch storms

- `BulkReads.enter()` no longer grants a direct read while a waiter is already queued. `wait()` uses the same queued-aware availability check. A focused test covers the rare race where a slot has freed before the queued wake-up installs itself.
- `server.ts` makes a same-version full `STRATEGIC_VIEW_TYPE` `/view` refetch wait-eligible. A 500-seat roster/control generation change no longer forces all clients into immediate 429 retries for a metadata-only refetch.

## Validation executed

All commands below ran on this branch with a disposable PostgreSQL 18.7 database at `postgresql://user@127.0.0.1:55432/vtt_fix`, created from `@embedded-postgres/linux-x64@18.7.0-beta.19`, and Chromium 153 r1243 installed by `corepack pnpm e2e:browser`. The final numbers include the additional ZIP local/central-header consistency hardening.

| Check | Result |
| --- | --- |
| `corepack pnpm typecheck` | Clean; `checkSvelte` 104 components, 0 blocking, 3 advisory warnings. |
| Touched-file ESLint | Clean on all 24 touched/new `.ts`, `.mjs`, `.svelte` files. Full `corepack pnpm lint` remains red with 355 pre-existing errors in untouched files; that is not attributable to this follow-up. |
| `STRATEGIC_TEST_DATABASE_URL=... corepack pnpm exec vitest run tests/strategicRoom --maxWorkers=1` | 9 files / **63 tests passed** (10.84 s). |
| `STRATEGIC_TEST_DATABASE_URL=... corepack pnpm test` | 465 files passed, 2 skipped; **6,102 tests passed**, 12 skipped (209.86 s). |
| Chromium hosted/campaign E2E | **3 passed** (55.4 s), including the new media-prefetch assertion. |
| `corepack pnpm build` | OK; `dist/index.html` 6,162,314 bytes. |
| `corepack pnpm size` | Raw 5.877 MB (6,162,314 bytes), gzip 2.063 MB (2,163,023 bytes); within 6 MB raw budget. |
| `corepack pnpm build:strategic` | OK; `dist/web/scene/scene.webp` present, 170 bytes. |
| `git diff --check` | Clean. |

## Sandbox qualification workaround

### What was added

- `package.json`: `qualify:strategic:sandbox`.
- `performance/strategic/wanTlsProxy.mjs`: loopback self-signed HTTPS/WSS proxy with configurable one-way request delay, jitter, and connection-loss drop. It terminates TLS and forwards HTTP/WebSocket upgrades to the local campaign service.
- `performance/strategic/frameSurrogate.mjs`: Chromium 153 CPU-throttled synthetic 50k-marker apply in `requestAnimationFrame` chunks.
- `performance/strategic/sandboxQualification.mjs`: bounded harness that starts the TLS proxy, runs `localCampaign.mjs`/`hostedLoad.ts` for one or more short battles, evaluates the documented p95 budgets, runs the frame surrogate, and writes machine-readable evidence with explicit `fullQualification: false`.
- `performance/strategic/localCampaign.mjs`: optional `STRATEGIC_TEST_ORIGIN` and `STRATEGIC_TEST_SERVICE_PORT` so clients can use the proxy origin while the service binds a different loopback port.
- `performance/strategic/hostedLoad.ts`: allows the self-signed certificate only when `NODE_TLS_REJECT_UNAUTHORIZED=0` is explicitly set for this local diagnostic.

Reproduce after both builds and Chromium installation:

```sh
export STRATEGIC_TEST_DATABASE_URL='postgresql://user@127.0.0.1:55432/vtt_fix'
export NODE_TLS_REJECT_UNAUTHORIZED=0   # local self-signed proxy only
export STRATEGIC_LOAD_DECODE_SAMPLE=10
corepack pnpm build
corepack pnpm build:strategic
corepack pnpm e2e:browser

# 500 seats, 10 units/seat (50k models), 2 turns, 40 +/- 10 ms request delay, TLS/WSS.
corepack pnpm qualify:strategic:sandbox 500 10 2 1 idle 40 0 4 \
  performance/strategic/evidence/2026-11-20-sandbox-500-idle-changesets.json

# Full-baseline control for the same run.
STRATEGIC_LOAD_FULL_VIEWS=1 corepack pnpm qualify:strategic:sandbox 500 10 2 1 idle 40 0 4 \
  performance/strategic/evidence/2026-11-20-sandbox-500-idle-full.json
```

Arguments are `[seats] [unitsPerSeat] [turnsPerLoop] [loops] [workload] [wanDelayMs] [wanLossPct] [cpuRate] [evidencePath]`. The harness uses `STRATEGIC_LOAD_DECODE_SAMPLE=10` by default in these runs: ten peers fully decode the published baseline while all 500 still fetch and validate response heads. `loops > 1` repeats fresh short battles as a bounded soak surrogate:

```sh
corepack pnpm qualify:strategic:sandbox 20 1 2 3 march 40 0 4 \
  performance/strategic/evidence/2026-11-20-sandbox-soak-retry.json
```

### Executed surrogate results

All 500-seat runs connected **501 sockets** (500 commanders + GM), used **50,000 models**, ran two turns with 10 reconnecting peers, and traversed local HTTPS/WSS with 40 ms ± 10 ms request delay. Machine: Node 22.22.3, Linux 6.1.158+, 2 vCPUs, ~3,940 MiB RAM, PostgreSQL on loopback. Budgets come from the existing plan: close-to-durable publish p95 ≤ 5,000 ms, apply-after-publish p95 ≤ 2,000 ms, frame interval p95 ≤ 33 ms.

| Evidence | Workload / views | Patches applied | Close p95 | Apply p95 | Frame p95 | View failures | Surrogate budgets |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| [`...-500-idle-full.json`](../performance/strategic/evidence/2026-11-20-sandbox-500-idle-full.json) | idle, full views | 0 | 2,703 ms | 1,329 ms | 16.8 ms | 0 | all within |
| [`...-500-idle-changesets.json`](../performance/strategic/evidence/2026-11-20-sandbox-500-idle-changesets.json) | idle, changesets | 20 | 2,593 ms | 1,549 ms | 16.7 ms | 0 | all within |
| [`...-500-full.json`](../performance/strategic/evidence/2026-11-20-sandbox-500-full.json) | march, full views | 0 | 3,404 ms | 1,649 ms | 16.7 ms | 0 | all within |
| [`...-500-changesets.json`](../performance/strategic/evidence/2026-11-20-sandbox-500-changesets.json) | march, changesets | 0 | 3,319 ms | 2,040 ms | 16.8 ms | 0 | apply p95 over 2 s |

A separate bounded retry/soak surrogate in [`...-soak-retry.json`](../performance/strategic/evidence/2026-11-20-sandbox-soak-retry.json) ran **3 loops** of 20 seats × 2 turns over the same TLS/WSS proxy. Each loop connected 21 sockets, exercised 10 reconnects per turn, and applied 30 marker patches overall. Worst close p95 was **427 ms**, worst apply p95 **274 ms**, frame p95 **16.7 ms**, with **zero view failures or retries**. This is evidence that repeated fresh battles and reconnect storms are stable in the sandbox; it is not a 50-turn warm soak or multi-host failover.

The march changeset run applied zero marker patches because the 5,000-unit moved-marker change set exceeded the compact patch budget and fell back to full baselines; the idle run applied 20 patches (10 fully decoding peers × 2 turns). The PR body's exact full/changeset p95 figures (2.25/1.89 s vs 0.90/0.56 s) were **not reproduced**: this environment adds a TLS proxy and synthetic delay, has only two vCPUs, and uses Node protocol clients. In the idle comparison, changesets improved close p95 but not apply p95. Treat all four 500-seat rows as regression-scale evidence, not a capacity pass.

Optional loss smoke: a 4-seat, 1-turn run at 1% injected connection loss completed with zero view failures; a 4-seat run at 2% loss dropped a launch connection and exited with a harness error; a 20-seat, 2-turn run at 0.5% loss dropped one view and tripped the load gate. These runs demonstrate that the loss knob injects real failures, not that the launch/fixture path is production-loss-tolerant. Real loss testing needs production-like retry, packet-level scheduling, and an external network emulator.

The frame surrogate reported p95 ≈16.7–16.8 ms for a synthetic 50k marker table under 4× Chromium CPU throttling. This is not the production VTT renderer and not the published reference laptop.

### What still requires an external runner

| Missing qualification | Why this sandbox cannot close it | Workable external gate |
| --- | --- | --- |
| 500 representative browser clients / human capacity | 2 vCPUs and ~3.8 GiB RAM; `hostedLoad.ts` uses headless Node WS/HTTP peers, not 500 renderers. Three Chromium E2E contexts only prove browser round-trip. | Distribute 500 real Chromium contexts across several hosts, keep the GM UI open, collect frame/renderer memory and p95 publish/apply, and run with production TLS. |
| Real WAN/TLS/loss | Self-signed loopback certificate, one host, request-level delay/loss; no RTT/congestion/routing/bandwidth caps or production CA chain. | At least two regional hosts or a WAN emulator (`tc netem`/commercial equivalent) with ~80 ms RTT, jitter, loss, bandwidth caps, production certs, and 600-connection headroom. |
| 50+ turn cold/warm soak and multi-host recovery | The 3-loop `sandboxQualification.mjs` surrogate runs serial fresh 2-turn battles, not one long-lived battle or authority failover; `run.mjs hosted` retains a 4 h mode that was not executed. | Long-running deployment with durable PostgreSQL, authority failover/restarts, reconnect storms, clock/lease monitoring, and 50+ turns without unbounded memory/generation growth. |
| Reference-laptop frame test | Chromium CPU throttling on a Xeon sandbox with synthetic marker arrays; no production rendering or reference hardware. | Published reference laptop, production single-file build, 50k-model scene, and a ≤33 ms p95 frame-interval assertion over a representative pan/zoom/apply script. |

The practical workaround is therefore: use `qualify:strategic:sandbox` as an opt-in CI/regression diagnostic with explicit budget fields and evidence JSON, and require the external runner table above before declaring 500-seat/WAN/soak/reference-laptop capacity qualified. No local loopback result should be relabelled as production qualification.

## Generated evidence files

- `performance/strategic/evidence/2026-11-20-sandbox-500-full.json`
- `performance/strategic/evidence/2026-11-20-sandbox-500-changesets.json`
- `performance/strategic/evidence/2026-11-20-sandbox-500-idle-full.json`
- `performance/strategic/evidence/2026-11-20-sandbox-500-idle-changesets.json`
- `performance/strategic/evidence/2026-11-20-sandbox-soak-retry.json`

Each file records machine metadata, configuration, condensed connected/turn/summary reports, p95 budget observations, frame surrogate output, surrogate limitations, and the external requirements still outstanding.
