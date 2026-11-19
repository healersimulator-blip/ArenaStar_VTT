# Hosted Strategic Room (pilot)

An opt-in PF1e simultaneous battle for a GM and two factions of commanders. It is a separate Node/PostgreSQL service and web entry point; the single-file browser-hosted game is still the default. **The 500-slot and 50,000-model configuration limits are not a qualified player capacity.** Start with a small invited group. See the [implementation plan and diagnostics](../../docs/STRATEGIC_500_IMPLEMENTATION_PLAN.md#5-pilot-verification) and [wire contract](../../PROTOCOL.md#hosted-strategic-room-opt-in).

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

- Root: `format`, `name`, unsigned 32-bit `seed`, `bounds: { minX, minY, maxX, maxY }` in feet, `factions`, `commanders`.
- Exactly two `factions: { id, name, color }[]`, with `color` as `#rrggbb`. Between 2 and 500 distinct `commanders: { id, factionId, units }[]`, with at least one on each side; `gm` is reserved.
- Each commander has 1–10 `units: { id, name, anchor: { x, y }, strength, weapon }[]`. IDs are unique, names at most 64 characters, strength 1–100 and weapon `melee` or `shot`. Total strength ≤50,000. Line infantry deploys on a 5-ft grid with standardized pilot stats. Deployed formations must not overlap or exceed the map bounds (5–4,096 ft per axis within codec 2).

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

Use a new room ID for the import. The extractor takes only selected unit names, IDs, strengths, weapons and anchors, plus faction labels. It requires a 5-ft square strategic scene, unique assigned armies, and anchored line infantry. It rejects walls, levels, authored terrain, alliances, heroes, squads and doctrine. It does not migrate packages, assets, identities, orders, combat stats, checkpoints, fog history or the full world. Hosted realtime, spell and tactical actions, and seamless authority handoff are not provided.

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

The browser fetches markers as one gzip member behind the private JSON metadata when it advertises the compact view type; the plain JSON view remains for older clients. The generator reports `viewApplyP95` (publication notice to decoded view, not paint), `noticeApplyP95` relative to each socket's own head notice, and the default view payload. A `409`, `429` or transport failure is retried within the shared attempt budget and counted in `viewRetries`; `viewFailed` counts peers left without the newer view, and `defaultPayloadBytesP95` sums the default
WS payload and HTTP body of a turn. None of these figures is a browser paint measurement, and
loopback runs on a shared sandbox are not capacity qualification.

Arguments: `origin invites-file turns workload [commanders]`. Without the reconnect flag, no reconnects are injected; with it, the specified final group reconnects once the close has begun. `STRATEGIC_LOAD_SPREAD_MS` spreads a turn's submissions over that interval; the harness GM then closes manually. This is not a deadline-skew test. Never point the generator at an active game. The logs separate ACK, notification, rejoin and baseline-parse latency, and report WebSocket and HTTP result traffic. They don't cover rendering, WAN behavior, or optional region and report fetches unless separately tested. A final `summary` line reports the worst turn of the run, which is what a per-turn gate should be judged on.

Two optional probes are off by default:

- `STRATEGIC_LOAD_SLOW=1` pauses the last player's TCP transport just before close on the final turn. It reports `stalledPeerShedMs` (until that session's own bearer is refused), `stalledPeerRejoinMs` for the same identity rejoining, and keeps the healthy cohort's percentiles separate. Healthy peers must stay within their normal bounds; the stalled session is expendable.
- The Chromium case records frame intervals while it drives the battlefield (drag, wheel zoom, keyboard pan) and again while the turn's result applies. `STRATEGIC_FRAME_PROFILE=reference` turns those numbers into the §4 ≤33 ms p95 assertion; without it they are reported as `diagnostic-non-qualifying`. Chromium's accessibility-tree walk, which a headless shell runs over the whole DOM, dominates the apply window on this sandbox, so do not read its absolute apply-frame figures as a browser's.
- `STRATEGIC_LOAD_DECODE_SAMPLE=n` fully decodes only `n` of the 500 clients' published baselines; the rest fetch the same response and validate its prefix (status, content type, epoch, metadata head, non-empty marker table). One process hosting 500 clients cannot decode them like 500 browsers: a single decode of the 5,000-marker field measures about 3.3 ms, but 500 concurrent inflates on two shared CPUs need about 1.8 s of wall time. Leaving it at 0 decodes all 500 and reports `viewDecodeMsP95` / `viewDecodeMsSum` so the generator's own CPU share is visible rather than silently inflating `viewApplyP95`.

Use a fresh database for a qualification-style run: repeated runs accumulate report rows (hundreds of thousands after a few 50-turn runs), and autovacuum on that history moved first-turn ACK p95 from about 50 ms to 512 ms in one local run. That was test history, not a code regression, but it changes the measurement.
