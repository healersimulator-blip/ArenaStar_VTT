# Hosted Strategic Room (pilot)

An opt-in PF1e simultaneous battle for a GM and two factions of commanders. It is a separate Node/PostgreSQL authority and web entry point; the single-file browser-hosted game is still the default. **Product direction: strategic mode is the full VTT operating at formation scale, not a reduced battle service.** The service boundary exists for durability, privacy, reconnects and dense simulation; current scenario/order omissions are pilot gaps, not intended exclusions from scenes, actors, items, spells, effects, geometry, vision, reactions, authored content or campaign reconciliation. See the [canonical design](../../docs/STRATEGIC_FULL_VTT_DESIGN.md). **The 500-slot and 50,000-model configuration limits are not a qualified player capacity.** Start with a small invited group. See the [implementation plan and diagnostics](../../docs/STRATEGIC_500_IMPLEMENTATION_PLAN.md#5-pilot-verification) and [wire contract](../../PROTOCOL.md#hosted-strategic-room-opt-in).

## Start a local room

Use Node 22+, pnpm 10, and a dedicated PostgreSQL database. Run from the repo root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build:strategic
export DATABASE_URL='postgres://strategic@localhost/strategic_pilot'  # your test database
export STRATEGIC_ROOM='crossing-pilot'
app=services/strategic-room/dist/server/main.mjs
node "$app" migrate
# Fresh room: 2 commanders, 5 units each. Treat the output as credentials.
umask 077
mkdir -p test-results
node "$app" demo 2 5 mixed >test-results/strategic-invites.json
node "$app" serve
```

Open `http://127.0.0.1:8788/`. Give each person the URL and **only their own** one-time invite (`gm`, `commander-1`, `commander-2`). Open separate browser profiles for multiple seats on one machine. Invites expire in 30 minutes; once claimed, the browser's stored identity lets it rejoin without the invite. Reloading or restarting the service doesn't change the seat. Clearing browser storage can lose access to that identity. To provision known browser public keys in advance, pass a JSON object mapping slot ID to public key as the final `demo` or `import` argument.

Commanders draft orders for their assigned units and submit a batch to get a private accepted revision. The GM closes orders manually, or sets a server deadline when opening the next turn. Only accepted orders are frozen. A small status label shows closing, resolving and applying; the previous battlefield remains visible while results load. Details and report pages are on demand. If resolution pauses, **Retry frozen turn** uses the same saved inputs. A GM can revoke a commander; this closes that seat's session and invalidates its HTTPS access, and removes any still-unfrozen orders. There is no live reassignment UI in the pilot.

## Scenario files and legacy extraction

`node "$app" import scenario.json [public-keys.json]` creates a new room (using `STRATEGIC_ROOM`); it won't overwrite an existing one. The accepted `arenastar-strategic-scenario-v1` format is an allowlist:

- Root: `format`, `name`, unsigned 32-bit `seed`, `bounds: { minX, minY, maxX, maxY }` in feet, optional projected `walls` and `terrain`, `factions`, `commanders`.
- `walls` contains bounded battlefield-foot segments `{ x1, y1, x2, y2, restriction }`; the low four restriction bits are move/sight/sound/light. `terrain.difficultCells` contains unique bounded `{ col, row }` cells and uses the shared PF1e double-cost movement rule.
- Exactly two `factions: { id, name, color }[]`, with `color` as `#rrggbb`. Between 2 and 500 distinct `commanders: { id, factionId, units }[]`, with at least one on each side; `gm` is reserved.
- Each commander has 1–10 `units: { id, name, anchor: { x, y }, strength, weapon }[]`. IDs are unique, names at most 64 characters, strength 1–100 and weapon `melee` or `shot`. Total strength ≤50,000. Line infantry deploys on a 5-ft grid with standardized pilot stats. Deployed formations must not overlap or exceed the map bounds (5–4,096 ft per axis within codec 2). During a march, the entire company stops short of another company’s starting cells or reserved path. Simultaneous conflicts use deployment order, not submission time. **March blocked** in the turn report means the order was accepted but could not be completed; there is no automatic detour.

A browser-world ZIP is **not** a hosted save. For a fresh deployment, extract its `documents.json` locally and pick the scene and army slots explicitly:

```json
{
  "sceneId": "field",
  "name": "Northern Crossing",
  "seed": 4242,
  "bounds": { "minX": 0, "minY": 0, "maxX": 4000, "maxY": 4000 },
  "slots": { "commander-1": "army-blue", "commander-2": "army-red" }
}
```

```sh
unzip -p existing-world.zip documents.json >documents.json
node "$app" extract documents.json layout.json fresh-scenario.json
node "$app" import fresh-scenario.json >test-results/strategic-invites.json
```

Use a new room ID for the import. **Full-VTT campaign launch (`CampaignBattle.svelte`) vs CLI legacy extractor:** launching from the main VTT (`Multiplayer battle…`) projects the signed `arenastar-battle-projection-v1` dependency graph—authored backgrounds and 1–64 stitched map panels (up to `5,000 × 5,000` squares), walls, interactive doors (`closed`/`open`/`locked`), difficult terrain, darkness, point lights, vision (`normal`/`lowLight`/`darkvision`), elevated `raised`/`stairs` regions, measured templates, derived PF1e actor combat stats & active effects, 7 shared PF1e spells (`entangle`, `burning-entanglement`, `black-tentacles`, `fireball`, `burning-hands`, `lightning-bolt`, `cone-of-cold`), charge-tracked consumables (`heal`, `bless`, `haste`, `shield`), readied reactions, entitlement-filtered journals (`<secret>` stripped for players), roll tables, playlists, and declarative macros—and reconciles casualties, unit positions, expended spell slots, item charges, conditions, door states, and darkness back to the campaign `DocumentStore` as a conflict-checked, single-step undoable transaction. Arbitrary JavaScript `script` macros remain disabled in hosted rooms pending a sandboxed execution policy and surface an explicit diagnostic. The standalone CLI `extract` subcommand remains a minimal offline converter for basic `documents.json` scenarios.

## Operate the pilot

- **Transport:** Put the service behind a same-origin HTTPS reverse proxy; forward WebSocket upgrades for `/api/strategic/socket`. Set `STRATEGIC_ORIGINS` to the exact public origin(s), e.g. `https://battle.example.org`. `PORT` defaults to `8788`; keep that plain HTTP listener and the database on a private network. Loopback HTTP is for development. Use a proxy with WebSocket idle timeouts above the 15 s heartbeat, and don't log headers, invite codes, request bodies or private views. Don't cache API responses. Configure ingress and connection limits on the proxy independently of the room limits.
- **Authority:** Run one writer per room. `/healthz` is ready only while the instance holds its PostgreSQL lease and has loaded the committed battlefield. A lease loss closes sessions; restart with the **same built artifact** and database. The room pins the SHA-256 of the worker bundle. Starting with a mismatched worker is refused; don't edit pins or reuse legacy snapshots. If the process died during resolution, the successor uses the stored freeze. After a committed publish, rejoin fetches the committed version, not a second resolution.
- **Monitoring:** `STRATEGIC_METRICS=1` emits structured order queue and durable ACK times, freeze load, worker, projection and commit times, artifact sizes, phase notification and WebSocket buffer high-water data. Pair that with proxy/database metrics and client-apply and frame-time measurements; the main process does not measure when a browser paints. Alert on pauses, lease loss, queue pressure, repeated `429`/`503` and apply time. If a room is unhealthy, stop distributing invitations or take its ingress offline; preserve the durable room and resume on a compatible build instead of transferring it to a peer host.
- **Backups:** Back up the dedicated database (e.g. `pg_dump --format=custom` to restricted storage) and archive the matching `dist` service artifact; rehearse `pg_restore` to a separate empty database and verify phase, accepted orders, report version and rejoin before a pilot. Don't run old and restored copies as the same public room. The export command, `node "$app" export latest-checkpoint.json`, writes a new mode-0600 `arenastar-strategic-checkpoint-v1` file containing the last _committed_ codec-2 pool, unit state, scenario and raw report. It does **not** contain memberships, active orders, or a frozen job, and is not a database backup or a browser-world ZIP. Keep it private. `import` accepts the scenario schema only, not a live checkpoint export.

## Verify and measure

With a disposable PostgreSQL db and a Playwright Chromium installation:

```sh
export STRATEGIC_TEST_DATABASE_URL="$DATABASE_URL"
corepack pnpm exec vitest run tests/strategicRoom tests/core/turnProgress.test.ts
corepack pnpm test:e2e:strategic
corepack pnpm bench:strategic smoke
corepack pnpm bench:strategic matrix 1
corepack pnpm bench:strategic decode
```

`decode` builds one 5,000-marker compact baseline and times a single decode plus its parts (gzip
inflate, label parse, marker objects), so a hosted `viewApplyP95` can be attributed to the codec
rather than to the machine running the generator.

A fresh benchmark room needs fresh invites. The latter two direct-runner commands need no database. For actual signed WebSocket plus HTTP clients:

```sh
# Create and serve a fresh demo with matching units, slot count, and workload first.
STRATEGIC_LOAD_SPREAD_MS=1800 STRATEGIC_LOAD_RECONNECT=50 \
  corepack pnpm bench:strategic hosted https://battle.example.org \
  test-results/strategic-invites.json 1 mixed 500
```

A cold compact view carries a gzip marker table behind private JSON metadata. A warm browser can request smaller, exact marker changes from its own immediately preceding publication; changed visibility/labels that cannot be expressed in the patch get a full view. No old pools or global roster IDs are used. Plain JSON and the existing compact full view remain available. Set `STRATEGIC_LOAD_FULL_VIEWS=1` to force the original full-view baseline in the generator; `markerChangesApplied` counts actual patches, not requests. The generator reports `viewApplyP95` (publication notice to decoded view, not paint), `noticeApplyP95` relative to each socket's own head notice, and the default view payload. A `409`, `429` or transport failure is retried within the shared attempt budget and counted in `viewRetries`; `viewFailed` counts peers left without the newer view, and `defaultPayloadBytesP95` sums the default
WS payload and HTTP body of a turn. None of these figures is a browser paint measurement, and
loopback runs on a shared sandbox are not capacity qualification.

Arguments: `origin invites-file turns workload [commanders]`. Without the reconnect flag, no reconnects are injected; with it, the specified final group reconnects once the close has begun. `STRATEGIC_LOAD_SPREAD_MS` spreads a turn's submissions over that interval; the harness GM then closes manually. This is not a deadline-skew test. Never point the generator at an active game. The logs separate ACK, notification, rejoin and baseline-parse latency, and report WebSocket and HTTP result traffic. They don't cover rendering, WAN behavior, or optional region and report fetches unless separately tested. A final `summary` line reports the worst turn of the run, which is what a per-turn gate should be judged on.

Two optional probes are off by default:

- `STRATEGIC_LOAD_SLOW=1` pauses the last player's TCP transport just before close on the final turn. It reports `stalledPeerShedMs` (until that session's own bearer is refused), `stalledPeerRejoinMs` for the same identity rejoining, and keeps the healthy cohort's percentiles separate. Healthy peers must stay within their normal bounds; the stalled session is expendable.
- The Chromium case records frame intervals while it drives the battlefield (drag, wheel zoom, keyboard pan) and again while the turn's result applies. `STRATEGIC_FRAME_PROFILE=reference` turns those numbers into the §4 ≤33 ms p95 assertion; without it they are reported as `diagnostic-non-qualifying`. Chromium's accessibility-tree walk, which a headless shell runs over the whole DOM, dominates the apply window on this sandbox, so do not read its absolute apply-frame figures as a browser's.
- `STRATEGIC_LOAD_DECODE_SAMPLE=n` fully decodes only `n` of the 500 clients' published baselines; the rest deliberately request full snapshots and check their headers and metadata without decoding their marker tables. Use `0` for a like-for-like end-to-end comparison of update modes. A single process hosting 500 clients shares CPU and garbage collection across all of them; its decode timings are not individual browser performance. Leaving it at 0 decodes all 500 and reports `viewDecodeMsP95` / `viewDecodeMsSum` so the generator's own CPU share is visible rather than silently inflating `viewApplyP95`.

Use a fresh database for a qualification-style run: repeated runs accumulate report rows (hundreds of thousands after a few 50-turn runs), and autovacuum on that history moved first-turn ACK p95 from about 50 ms to 512 ms in one local run. That was test history, not a code regression, but it changes the measurement.

## Launch inside a campaign (no second world file)

`campaign` serves the normal VTT at `/`, an authenticated provisioning endpoint and a scene-scoped battlefield at `/battle/<id>/`. One running process owns one deployment slot and one live battle at a time. Start it **once**, not once per scene. Node 22+, pnpm 10, a dedicated PostgreSQL database and the two builds are required:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build && corepack pnpm build:strategic
# Set DATABASE_URL to the dedicated database. Supply STRATEGIC_LAUNCH_KEY from your
# secret manager (random, >=32 characters); give it only to authorized campaign GMs.
export STRATEGIC_ROOM=campaign-slot-1
node services/strategic-room/dist/server/main.mjs campaign
```

Open `http://127.0.0.1:8788/` for local testing. For remote players use the same HTTPS deployment origin for the campaign and battle. Set `STRATEGIC_ORIGINS` to that exact origin, proxy **both** HTTP and WebSocket upgrades (including `/battle/<id>/api/strategic/socket`), and keep the listener and database private. Do not log request bodies, headers or invite responses. Keep the launch key stable through an active battle. `campaign` runs the additive database migration on startup. A downloaded HTML or generic static site does not collect the GM launch key. Browser storage is origin-specific: open the campaign on the deployment origin, not a separate world per battle.

1. In the open campaign, use **Scenes → + → Strategic battlefield** and select it, or select an existing strategic scene. Click **Multiplayer battle…**. Launch before starting a local strategic simulation. The local strategic engine covers the whole world, so local strategic turns are disabled until Finish; ordinary campaign scenes remain available.
2. On an empty battlefield choose 2–500 seats and 1–100 models per seat. The fresh roster is two factions, one line-infantry unit per seat. For a prepared battlefield the panel instead uses its scene-assigned armies, one seat per army, two factions, and the pilot’s supported line infantry, explicit anchors and weapons. Split cross-scene armies in advance. The backend validates the deployment fits. The current pilot shows a schematic map with standardized profiles and withholds campaign documents. This is not the target experience: the full design projects every relevant scene/rules/content dependency, then filters each player's authorized view without replacing authored mechanics.
3. Enter the launch key. The browser signs the request, saves the scene binding, and opens the board **in the same tab**. Under **Commander admission**, give each player the battle URL and **only their own** one-time code. Codes expire after 30 minutes; a claimed seat rejoins with its stored identity. **Recover invites / retry launch** returns still-valid unclaimed invites for the same battle, including a code reissued from the GM roster: the service keeps its digest plus an encrypted short-lived resend copy. A refused command never leaves a displayed code. Codes, signing keys and the provisioning secret are never saved to scene flags.
   The GM's **Commanders** roster lists every seat: rename it, choose which of that seat's units it may order, create a one-time invite for an unclaimed seat, **Kick** a live session, or **Ban** the seat for the rest of the battle. The seat ID and the browser key bound to it are the identity; the name is only a label. A claimed seat cannot be re-invited (that would be a takeover) — kick it to end the current session without revoking it, or ban it, which deactivates the seat, invalidates the bound key and withdraws pending orders. Removing a unit grant also deletes any accepted order for that unit this turn and bumps the commander's revision, so an in-flight batch cannot silently re-add it. The unit list always shows the seat's whole deployment, with a checkbox per unit for its current grant, so a withdrawn unit can be granted back. Kick and ban both ask for a second click in the roster rather than a browser dialog. Every accepted roster or control command bumps the head's `members` generation, which makes each affected browser refetch its authorized view (roster for the GM, assigned units for the commander). The roster is GM-only data inside the authorized view; other field names would need the same per-member redaction test.
   **Scene preload:** the same panel can prepare a scene pack — the map, token art and sounds a player projection already names, minus GM-private and export-restricted media. A joining browser loads it on the Join screen to fill its content-addressed cache before the battle; it grants nothing and changes no host policy. The reader rejects central-directory zip bombs, per-entry overruns and manifest size mismatches before inflating untrusted entries. Because the cache is content-addressed, media already in the pack is served locally at join: no asset chunk request goes over the wire for it (`tests/strategicRoom/scenePreload.test.ts` asserts zero requests for packed bytes, one for unpacked). The service can also host a few fixed battle images at `/api/strategic/scene/<sha256>.webp` (same-origin only, immutable); place them in source `services/strategic-room/web/scene/` as `scene.webp` or `scene/<slot>.webp`, and `build:strategic` copies them to `dist/web/scene/`. The GM view advertises their hashes and sizes and prefetches the relative URLs.
4. Scene navigation or closing the GM panel doesn't stop the service. Return to the scene and choose **Resume multiplayer battle**. Restart with the same slot, database, launch key and pinned worker to resume. If launch loses its response, retry on the same scene; do not create another battle. A copied scene or a new world ID does not inherit the binding.
5. **Finish battle** closes admission and keeps the last committed result in Postgres. The scene records the battle ID, version and (if published) aggregate survivor/final-turn loss counts; it does **not** write unit stats or expose private orders. Finishing without publishing a turn records version zero. After Finish the slot can host another scene.

**Constrained verification:** set `STRATEGIC_TEST_DATABASE_URL` to a disposable real PostgreSQL database, run both builds above, then `corepack pnpm exec vitest run tests/strategicRoom --maxWorkers=1` and `corepack pnpm test:e2e:campaign` serially. Use `corepack pnpm e2e:browser` for registry-only Chromium. The campaign E2E uses one GM and two commander identities, a non-default scene, a lost launch response, rejoin, restart, scene navigation and Finish. The 500-seat/50k-model deployment test checks data and geometry, **not 500 connected humans or WAN capacity**. For a bounded sandbox surrogate ladder, run `corepack pnpm qualify:strategic:sandbox` after both builds and Chromium installation; see [`docs/PR55_FOLLOWUP_VALIDATION.md`](../../docs/PR55_FOLLOWUP_VALIDATION.md). It is explicitly not production qualification.

For a disposable local **campaign-path** load run (fresh GM and commander credentials, real sockets and database), use `node performance/strategic/localCampaign.mjs 100 10 2 mixed` with `STRATEGIC_TEST_DATABASE_URL` after both builds. The harness binds the campaign listener to loopback with `STRATEGIC_BIND_ADDRESS`. See the [mechanics and load report](../../docs/STRATEGIC_MECHANICS_TEST_REPORT.md) for reproduction, both 50k army shapes and limitations.
