# STATUS ASSESSMENT — ArenaStar_VTT @ `19c821a` (branch `arena/01a0c234-arenastar-vtt`)

**Date:** 2026-09-21 · **Assessor:** Arena agent (independent re-verification pass, not a re-run of the authors' numbers)
**Method:** all gates below were **executed in this checkout** after `pnpm install --frozen-lockfile`.
Where a claim could not be re-executed here, it is marked **[claimed]** with the document that records it,
never silently repeated as fact.

---

## 0. Executed evidence (this checkout, 2026-09-21)

The table below is the **snapshot as it was taken** — `main` @ `19c821a`, before the compendium/statblock
slices. The same gates re-run later the same day on the G-45 tree are in §3.6 (D-266) and on the G-08 tree
in §3.7 (D-267); each of those sections states its own numbers rather than editing this one.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` (`tsc --noEmit` + `scripts/checkSvelte.mjs`) | **pass** — 44 components, **0 blocking**, 1 advisory (`ReplayPanel.svelte:29`, pre-existing) |
| Lint | `pnpm lint` | **pass**, 0 errors |
| Unit/integration | `pnpm test` (vitest) | **244 files → 242 passed / 2 skipped; 2,818 tests → 2,809 passed / 9 skipped** (73.7 s) |
| Build | `pnpm build` | **pass** — `dist/index.html` 2,957,981 B raw / 847,978 B gzip, single self-contained file (2 inline `<script>`, no external loads) |
| Size gate | `pnpm size` | **OK** — 2.821 MB raw, inside the 6 MB budget |
| System packages | `pnpm build:systems` | **pass** — `pf1e-core-1.0.0.zip` (25.6 kB), `pf1e-mass-battles-1.0.0.zip` (78.5 kB, `rules.js` 262.9 kB); `mass-battle-basic` skipped (data-less by design) |
| Starter worlds | `pnpm build:worlds` | **pass** — `pf1e-mass-battles-starter-1.0.0.zip` (108.1 kB); tester world **skipped** with a note (no content dir) |
| Content source state | `pnpm content:fetch --check` | **2 pinned sources missing** (git-ignored vendor checkouts; needs a ~262 MB network fetch) |
| **Chromium e2e** | `pnpm test:e2e` | *Initially* **NOT RUN** — no browser binary present and the Playwright CDN download fails in this sandbox. **Run later the same day on the `19c821a` + G-45 tree** with a Chromium obtained from the npm registry (`@sparticuz/chromium`, launched via the config's `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override): **186 chromium tests → 183 passed / 3 failed (11.0 m, `--workers=2` on 2 cores)**, the three being the load-sensitive fog/parity specs, all green standalone — full breakdown in D-266 and §3.6 below; the previously recorded run was **184 tests, 183 passed / 1 failed** (`e2e/fog_player.spec.ts:41`, a known load-sensitive spec that is 2/2 standalone). |

Skips are all environment/content gates, not hidden failures: `webrtc` (3), `contentPackage` (3),
`testerRealZip` (1 — the spec that only runs with the pinned vendor checkout), dense-army bench (2).

## 1. What the project is, in one paragraph

A **serverless, browser-only, Foundry-class VTT that ships as one self-contained `index.html`**: the GM's
tab is the authoritative host, persister and relay; players join by link/code over WebRTC with Nostr / MQTT /
WebSocket / manual signaling. Svelte 5 + PixiJS 8 + three.js, built by Vite into a single file with a 6 MB
raw budget. It carries **two scales**: tactical PF1e play (7 sidebar tabs, sheets, combat tracker, casting,
inventory, compendium, fog of war) and **strategic mass battles** (10k+ models, deterministic seeded sim in a
worker, turn engine, orders, logistics, reports, replay). Campaign state is **one world file per campaign**
(format 2, ruleset + content packs embedded), and content is a **28-pack / 25,376-entry PF1e conversion**
that never enters the app body.

**Size of the thing:** 84.8k lines TS across 304 files + 23.5k lines in 44 Svelte components in `src/`;
69.5k lines in 244 unit-test files; 14.7k lines in 67 Playwright specs (184 tests); 3 system packages;
`tools/` content converter + adoption pipeline; `DECISIONS.md` holds **232 distinct decisions (D-001…D-264)**
and `DEVIATIONS.md` records **zero live spec deviations**. Only three `TODO` strings exist in `src/`, all
referring to the tracking document — there is no unfinished-code marker debt.

---

## 2. Completion status by tracking artifact

### 2.1 Spec milestones (§19) — `PLAN.md`: **complete**
M0 setup ✅ · contracts ✅ · **M1 MVP ✅** (D-066) · **M2 strategic + Fog ✅** (D-082) · **M3 ecosystem ✅**
(package loader, sandboxed iframe RPC, trusted in-page execution, compendia, migrations, 3D dice,
commit-reveal, realtime sim, reports, logistics, hero attachment, replay, scene linking, FSA export) ·
**M4 resilience/scale ✅** (peer relay, assistant-GM failover, TURN, tiled maps, voice/video mesh, PWA,
100k-model LOD stress). `PLAN.md` shows 143 ticked / 9 unticked, and **4 of the 9 unticked are stale
duplicates** (see §3.2).

### 2.2 ROADMAP: **all 19 deferred features delivered**
Every checkbox is ticked (3D dice, commit-reveal, extra signaling adapters, realtime mode, replay browser,
scene linking, FSA, peer relay, failover, TURN, tiled maps, voice/video, PWA, 100k stress, Firefox/WebKit
projects). **Open work lives in the prose follow-up sections**, not the checkboxes: world-file follow-ups
(multi-scene sim, per-scene ruleset, seeded starter worlds, retire the in-world *Activate* button), fog
follow-ups (light sources as sight bounds beyond the landed gate, host-side token withholding, GM brushes,
fog-layer gating of notes/effects, per-player GM preview), plus QR code, wasm, fonts, and the M1 carry-overs.

### 2.3 Gap-closure program (v2) — `GAP_CLOSURE_ImplementationPlan.md`
**7 of the 12 numbered items done outright — Wave 1 complete — 2.3 two-thirds done, critical path complete.**

| Wave | Item | State |
|---|---|---|
| 1.1 | Content delivery to a GM (G-44) | ✅ D-258 |
| 1.2 | Door/wall lifecycle + window (G-43/G-27) | ✅ D-257 — **tail open:** drag an endpoint, change a placed wall's kind |
| 1.3 | Inventory, items, encumbrance (G-03/G-04/G-05 tail) | ✅ D-259 |
| 1.4 | **Compendium scale UX (G-45)** | ✅ D-266 — index-backed search (parity-proved against the reference scan), windowed rows, facet filters + sorts + detail pane, parsed-pack memo; 20k entries: 8 keystrokes 3.6-6.8 ms (worst 4.4 ms) vs a 16 ms budget, 5.36 MB index vs 8 MB |
| 2.1 | Sight bounded by lighting (G-24) | ✅ D-260 (G-32 decided; G-26 light richness open) |
| 2.2 | Table flow: HP bars, quickbar, chat apply (G-22/G-10a/G-10b/G-20) | ✅ D-261 |
| 2.3 | GM view-as (G-25 tail) ✅ D-262 · onboarding/help (G-41 tail) ✅ D-263 · **i18n (G-38)** | ❌ i18n open — `src/ui/i18n/index.ts` is still `export {}` |
| 3.1 | Character import — Roll20/Foundry/Hero Lab (G-39) | ✅ D-264 — **tail open:** `.por` zip extraction, prepared spell lists |
| 3.2 | **Statblock import (G-08)** | ✅ **D-267** — a pasted stat block becomes a bestiary actor through the D-264 import front door (published AC/saves authored as totals; the printed attack bonuses and skill totals refused and reported, because this app derives them), read by label so section headings, `;`-clauses and PDF-wrapped prose all survive; **Stat block** box in the Sheets panel's Actors tab; unit **25**, e2e `statblock_import.spec.ts` **1/1** |
| 3.3 | **Non-combat resolution (G-11/G-21)** | ❌ open (also no converted traps/haunts/maladies) |
| 3.4 | **Breadth content (G-14/G-15/G-16)** | ❌ open (Mythic/3PP, companion progression, PFS) |
| 3.5 | **Polish (G-29/G-31/G-40)** | ❌ open (soundboard/TTS, views/bookmarks/video backgrounds, themes/dark mode) |
| — | Opportunistic track (FX engine, module ecosystem docs G-36, scripting G-37, adventure pipeline G-19) | not started; G-36 is now "docs + one exemplar module + install path", not architecture |

### 2.4 Gap list `G-01…G-45` — the true count
- **Closed and correctly recorded:** G-01, G-02, G-17, G-23, G-25, G-27, G-28, G-39, G-41, G-44.
- **Closed in code but NOT updated in the gap document** at audit time (7 rows — fixed by D-265,
  §3.1): G-03, G-04, G-05 (sheet surface), G-10a/G-10b, G-20, G-22, G-24.
- **Closed after this snapshot:** **G-08** statblock import (**D-267**, §3.7) — the §2 row above carries
  the evidence, and G-08's row in `GAP_ANALYSIS_Roll20_Foundry.md` now reads *Closed*.
- **Genuinely open:** G-06/G-07 tails (sneak attack, rage, smite, metamagic, spell points), G-09 tail,
  G-10 tails (per-character settings, notes tab, alt sheets), G-11, G-12, G-13, G-14, G-15 tail, G-16, G-18
  (**bestiary 1c not converted** — the largest data hole), G-19, G-21, G-26, G-29, G-30, G-31, G-32, G-36,
  G-37, G-38, G-40, G-42, G-43 tail.
- **Architectural bets, not gaps:** G-33 accounts/multi-device, G-34 mobile apps, G-35 marketplace.

### 2.5 PF1e backlog — `PF1e_Unified_TODO.md`: 83 ticked / 8 open
Open: **V07b** (make strategic-flanking query density-independent), **L01** (half-closed by D-259 — class
progression, item-use automation, crafting/pricing remain), **L02** combat mechanics, **L03** advanced hero
interactions, **L04** full spell/metamagic + non-combat skills, **L05** house rules, **L06** 3PP/vehicles/
siege, **L07** optional sidebar polish. `DEVIATIONS.md` is empty of live deviations — a strong signal.

### 2.6 PF1e MVP parity plan (`PF1e_MVP_WorkPlan.md`)
Tasks 1–5 and 9–10 delivered; **Task 6 (analytics) partly** (six fields declared but never incremented,
unquoted CSV, `generateReport()` uncalled), **Task 7 (hero bridge)** lacks an in-repo producer for
`isHeroUnit`, **Task 8 (Svelte ArmyWindow/BattleAnalysis)** exists (`PF1eBattleAnalysis.svelte`, 151 lines)
but the plan note says it is not mounted in `WindowHost`. This is the oldest document in the repo
(2026-09-08) and its remainders are the least-tracked — worth folding into `PF1e_Unified_TODO` or closing.

---

## 3. Findings — where the documents and the code disagree

### 3.1 Gap-document drift — ✅ **RESYNCED 2026-09-21 (D-265)**
`GAP_ANALYSIS_Roll20_Foundry.md` §4 carried the **2026-09-20** verdicts for gaps that
**D-259/D-260/D-261 shipped on 2026-09-21**, while the closure plan already marked them done. The
findings below were re-verified in this pass and then fixed in the documents (D-265): the eight rows
were rewritten with the decision and the file/test that closes each, §5's tier list was struck
through and a new **§5.1 "What is actually left"** states the open set cheapest-first, the closure
plan gained a **Status 2026-09-21** line plus the two done-markers its own table was missing, and
`PLAN.md`'s four stale rows were resolved (FSA ticked, Token HUD split from settings, sidebar tabs
narrowed, join-dialog wording). What the pass found:

| Row | Doc still says | Code today (verified) |
|---|---|---|
| G-03 | "⛔ **Open** … no `encumbrance`/`carryingCapacity` anywhere in `src/`" | `src/packages/pf1e/inventory.ts` (768 L): `carryingCapacityOf`, `loadLevelFor`, `encumbranceReadout`; 79 references |
| G-04 | "🟡 Partial … Missing: an Items tab and an item sheet window, a charges ledger, containers, currency, encumbrance, item→attack link, `changes[]`" | `PF1eItemsTab` + `PF1eItemWindow` + `consumables.ts` + `itemChanges.ts` (D-259) |
| G-05 | "🟡 … any sheet surface that makes them more than a description" | Item window `changes[]` preview + applied/not-applied reasons (D-259) |
| G-10a | "⛔ **verified absent** (no `hpBar`/bar code)" | `src/packages/pf1e/tokenHpBars.ts` + stage drawing + world setting; 63 refs; `e2e/token_hp.spec.ts` |
| G-10b | "⛔ verified absent (no `quickbar`)" | `src/ui/quickbar/{model,run,QuickbarRow.svelte}` mounted in both shells; `e2e/quickbar.spec.ts` |
| G-20 | "⛔ **Open** … no apply/heal intent" | `roll.apply` 0x34 + `rollApply.ts` + `RollApplyRow.svelte`; `e2e/roll_apply.spec.ts` |
| G-22 | "Still missing: a player quickbar / macro bar (G-10b)" | landed with D-261 |
| G-24 | "⛔ **Open (re-verified)** … nothing reads darkness or light state" | `src/canvas/vision/darkness.ts` (275 L), `docs`-level gate + `e2e/fog_lighting.spec.ts` |

The document's own evidence convention (§6 of the plan) says the gap analysis "gets its status characters
updated in the same commit that closes a gap, so the two documents cannot drift" — for these eight rows it
didn't happen (row-level sync *did* happen for G-25/G-27/G-39/G-41/G-44, and the header carried a
"Follow-up (later)" note for D-262/D-263 — a partial sync, not neglect). Two consequences, both now
repaired: the counted "remaining work" was inflated, and §5's prioritization told a reader to start with
G-03 and G-24, both of which are done.

**What the resync changed (D-265), all re-verified against the code before writing:** the eight rows
above + G-25's heading (its body already recorded D-262) + G-32 (kept open, but restated as D-260's
*explicit decision* rather than an unaddressed limitation) + G-42's stale "174 specs" → **184**
(D-264, same number in the closure plan's §6) + the doc header re-sync note + §4's format line + §5's
struck-through tier list + new §5.1; the closure plan's status line, its §4 table (1.1 → D-258, 1.3
→ D-259, 1.2's wall-reshaping tail) and its critical-path paragraph (**1.1 → 1.3 → 2.2 → 3.1 is
complete**; 1.4 is the only Wave-1 item left); and `PLAN.md`'s four rows plus a note that the
*Continuous / cross-cutting* boxes are standing per-unit gates recorded per decision. Deliberately
untouched: the competitor inventories/citations (§2–§3, §6), gap numbering, `PF1e_Unified_TODO.md`
(already in sync, and `scripts/coverage.mjs` parses its checkboxes), and no Prettier reformat — these
docs are hand-formatted and were already not Prettier-clean at the base commit, so reformatting would
have buried a 60-line status fix inside a 1,500-line reflow. Gates re-run on the change: lint 0,
typecheck 0 blocking, `pnpm test` 2,809 passed / 9 skipped, `pnpm build` 2,957,981 B raw / 847,978 B
gzip, `pnpm size` OK — documentation-only, so identical to D-264's numbers.

### 3.2 `PLAN.md` stale checkboxes — ✅ **RESOLVED (D-265)**
Four of the nine unticked items were not open work; each is now resolved in `PLAN.md` to what exists:
- **File System Access "save to folder"** — *was* unticked while implemented: `exportWorldToFolder` in
  `src/host/worldFile.ts` + `tests/host/folderExport.test.ts`, already ticked in the M3 section (D-100)
  and in ROADMAP. **Now ticked.**
- **Sidebar tabs** — substantively landed: 7 tabs (`chat, combat, journals, tables, playlists, actors,
  compendia`) + scene nav + player list, with the item shape landing as the sheet's Items tab (D-259).
  **Now ticked narrowly**, with the residual tab *shape* work (Scenes/Items as tabs, a player-side tab
  set) left in ROADMAP rather than implied as missing function.
- **"Token HUD; basic world/client settings"** — **split**: the settings half is ticked (D-079 plus the
  D-259/D-260/D-261 world settings); the token HUD stays open with its verbs named (no floating HUD is
  built).
- **GM join-approval dialog + ban list UI** — genuinely open (auto-approve covers M1); wording tightened
  to state exactly which half ships.
- The remaining four are standing process items (PROTOCOL doc test, size gate, perf benchmarks, §16 review
  per unit); PLAN now says so — they are re-checked in every slice and recorded in that slice's decision
  entry, and three of them are enforced by `pnpm test` / `pnpm size`.

### 3.3 No CI — the gate set is manual
There is **no `.github/workflows`** and `gh run list` is empty: 28 merged PRs, zero automated checks. The
project's discipline is strong *and voluntary* — every D-entry records the gates it ran, and the environment
notes (2 cores/4 GB, one load-sensitive fog spec, browser matrix opt-in) are honest, but nothing prevents a
regression from landing. A minimal workflow (typecheck + lint + test + build + size) is the cheapest
durability improvement available.

### 3.4 Environment / reproducibility boundaries (by design, worth stating plainly)
- **Content is not in Git — and that is a boundary, not a defect.** `tools/content/vendor/` is
  git-ignored (262 MB of pinned upstream checkouts), so in a fresh checkout `dist/content` is absent, the
  tester starter world is skipped and the content specs self-skip. `pnpm content:fetch` +
  `content:convert` + `content:package` are the documented path, and **that path was executed here**
  (28 packs / 25,376 entries; both world zips built) — see §3.6.
- **The release hand-off has not happened**: `SHA256SUMS` + the zips are buildable, the README names the
  upload set, but the repo has **no tags and no releases**, so a GM without a toolchain cannot yet download
  the full-content artifact from the repo.
- ~~**e2e is unverifiable in a browser-less sandbox**~~ — **resolved later the same day.** The Playwright
  *CDN* is still unreachable, but a Chromium arrives from the npm registry (`@sparticuz/chromium` + its
  brotli'd system libraries), and the config already had the hook for it
  (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`), so the chromium project now runs here — see §3.6. The
  firefox/webkit projects remain unrunnable (their bundles come only from the CDN).

### 3.5 Confirmed non-issues
- The 9 unit-test skips are all environment/content gates (no silent failures).
- The single `svelte-check` advisory (`ReplayPanel.svelte:29`) is cosmetic and pre-existing.
- No unfinished-code markers in `src/`; the skipped `mass-battle-basic` package is intentionally empty.
- `dist/index.html` is genuinely self-contained (no external script/style/asset loads; the only `http` string
  is Svelte's own error-URL text).

### 3.6 Browser and real-content gates, executed after the G-45 pass

The two things this assessment first could not run were run later the same day, on the `19c821a` + G-45
tree, and both are recorded in full in **D-266**:

- **Chromium e2e.** A Chromium binary from the npm registry (`@sparticuz/chromium` + its brotli'd
  system libraries) plus the config's existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override — the
  project already had the seam; only the download source was blocked. Full chromium project: **186 tests,
  183 passed / 3 failed (11.0 m)** with `--workers=2`; the three failures are `fog_lighting.spec.ts:57`,
  `fog_player.spec.ts:41` and `parity.spec.ts:7`, and **all five fog/parity tests pass standalone**
  (`--workers=1`, 1.3 m) — the same load-sensitive alternators D-256/D-257/D-264 recorded on this
  2-core box, none of them touched by the G-45 slice. The specs this pass added or
  extended were also run individually: `e2e/compendium_scale.spec.ts` (340-entry package: windowing, facets,
  sorts, detail pane, import), `e2e/content_world.spec.ts` (the **real 8 MB converted world**: 25,376-entry
  reader, partial-name search, drag-import of the 3rd ranked hit) and `e2e/starter_compendia.spec.ts` (the
  **hand-authored starter world**, 5 packs / 162 entries, all expectations derived from the shipped zip).
- **Real content.** `pnpm content:fetch` (both pinned checkouts: `pf1-system@681929d`,
  `pf1e-content@baf5232`) → `content:convert` → **28 packs / 25,376 entries** → `build:systems` →
  `build:worlds`: `pf1e-mass-battles-starter-1.0.0.zip` (108.1 kB) and
  `pf1e-mass-battles-tester-1.0.0.zip` (8,013.9 kB). Running the gates against *that* data is what exposed
  the three facet mismatches and the two reader defects D-266 records — which is the argument for fetching
  the content in CI, not only for shipping it.
- **Still unrun here:** the firefox/webkit projects (their bundles come only from the unreachable CDN) and
  CI itself (there is no workflow — §3.3).


### 3.7 Statblock import (G-08) — the third pass, same day

G-08 was the one entry path the project never had, and it closed the same day as the gates above:
`src/packages/pf1e/import/statblock.ts` is the **fourth reader behind the D-264 import front door**, so a
pasted block produces the same `ImportedCharacter` and the check / one-create-op / report path is reused
unchanged — the point of the design, and the alternative (a second import pipeline beside the first)
would have been the wrong one. The Sheets panel's Actors tab gained a **Stat block** box beside
**Import**. Everything below was executed on the frozen tree:

- `tests/packages/pf1eStatblockImport.test.ts` **25/25** — SRD blocks as printed: a goblin warrior
  (published AC 16/13/14, saves +3/+4/−1, `hp 6 (1d10+1)`, two weapon lines, a `Racial Modifiers` line),
  an imp (multi-line spell-like abilities, `DR 5/good or silver`, `SR 12`, mixed speeds with a
  manoeuvrability word, `sting +8 (1d4+1 plus poison)`), a brown bear (`CMB +9 (+13 grapple)`, `CMD 20
  (24 vs. trip)`), a PDF-wrapped ability line, `+12/+7` sequences, an `or`-joined pair, a bat swarm, and
  the refusals (no ability line, a dash-printed score, prose-only, nameless, prose that mentions `AC 15`,
  a header line that is neither the creature's name nor its type line — now *quoted in the report* instead
  of dropped — and the three file formats still winning the sniffer).
- `pnpm test` **248 files (247 passed, 1 skipped) / 2,878 tests → 2,872 passed / 6 skipped** (86.4 s);
  `tsc --noEmit` exit 0; `checkSvelte` **44 components / 0 blocking / 1 advisory**; `pnpm lint` exit 0.
- `pnpm build` **2,997,285 B raw / 860,807 B gzip** and `pnpm size` **OK** (6 MB budget); the content
  pipeline re-run end to end — `content:convert` 28 packs / 25,376 entries, `build:worlds` both zips
  (starter 108.1 kB, tester 8,013.9 kB).
- `e2e/statblock_import.spec.ts` **1/1** in Chromium: paste the block into the box, read the report,
  read the authored `system.pf1e` back through the host surface, see the sheet show `16 / 13 / 14` and
  `3 / 4 / -1`, find both printed attack lines on the combat tab, and confirm a pasted paragraph creates
  no row — zero page errors. The **whole chromium project** then ran on this same tree
  (`--workers=2`): **187 tests → 186 passed / 1 failed (11.2 m)**, the single failure being
  `e2e/fog_player.spec.ts:41`, this box's recorded load-sensitive spec, which passes standalone
  (`fog_lighting` + `fog_player` + `parity` at `--workers=1` → **5/5 in 1.3 m**); `statblock_import`
  passed inside the parallel run.

The decisions themselves (read by label; totals authored as totals; the two derivable figures refused and
reported; prose on the sheet for what has no field; refusals rather than a plausible blank sheet) are in
**D-267**.
---

## 4. Honest bottom line

**Product completeness.** The §19 scope (M0–M4) is **done**: the file boots from `file://` and `https://`,
hosts a world, replicates to players with projection and permissions, persists and recovers from a GM crash,
carries fog-of-war with per-player exploration, packages a campaign as one file, loads sandboxed packages,
rolls verified dice, runs both a tactical PF1e game and a 10k-model strategic simulation, and exports a
starter world in three commands. That is a *shippable* VTT, not a prototype.

**Gap-closure completeness.** Wave 1 (unblock what already exists) is **4 of 4** done (the last item,
G-45, closed in D-266); Wave 2 (platform parity) is **3 of 3**; Wave 3 (breadth/on-ramp) is **2 of 5**
(3.1 D-264, 3.2 D-267). So the parity program is roughly **four-fifths complete**, and the remaining items
are additive rather than architectural: non-combat resolution, three polish slices, monetisation-free
breadth content (Mythic/PFS/companions), and the module-ecosystem docs.

**Biggest real holes, ranked.** 1) Bestiary conversion (G-18) — the content pipeline's missing third; 2)
non-combat resolution (G-11/G-21); 3) module ecosystem docs + exemplar (G-36). *(Two of the three
entries that stood here — compendium scale UX and statblock import — closed in D-266 and D-267.)*

**Cheapest next actions (highest value per hour).** 1) ~~Resync the drifted gap rows + stale PLAN
checkboxes~~ — **done in this pass (D-265)**; 2) land a minimal CI workflow (§3.3) — the only
durability gap left, and now the cheapest, since the gate set is proven to run in ~2 minutes; 3) tag a
release and attach the packaged content + world zips (§3.4); 4) ~~take **G-45** (the single remaining
Wave-1 item, now stated as the first item of §5.1)~~ — **done in D-266, Wave 1 complete** — then
**G-08** statblock import — **done in D-267**.

**Confidence.** High for everything executed above (unit, typecheck, lint, build, size, package + world
builds — all re-run here on this commit). **Since then also executed here, on this same commit plus the
G-45 slice** (§3.6, D-266): the chromium e2e project, the content pipeline end to end (28 packs / 25,376
entries and both world zips), and real-content unit gates; and again on the **G-08 tree** (§3.7, D-267)
for the statblock reader, its box in the Sheets panel, and the same gate set re-run. **Still unverified here:** the firefox/webkit
matrix (CDN-only bundles) and CI (there is none) — each marked **[claimed]** in the documents that record it.

---

## 5. Addendum 2026-09-22 — the hexcrawl feature is complete (D-268…D-276)

*Sections 0–4 above are the 2026-09-21 snapshot, taken at `19c821a`, and are left exactly as they were
written. This section is what happened next, on the trees that followed it.*

**What shipped.** The hexcrawl feature of `HEXCRAWL_SCENE_SPEC_AND_PLAN.md` — Phases 0 through 7,
decisions D-268…D-276. A scene type for overland play: a map with a hex/square/gridless grid the GM
paints terrain onto, encounter tables that fire on entering / moving / exploring / fighting (automatic,
GM-prompted, or by hand), a party that walks a route the GM draws at the terrain's price while the
**world clock** pays for it and the hexes keep the hours spent in them, and hidden features that give
themselves up by the GM's hand, a Perception DC, time spent, or a dice roll — announcing themselves in
the chat when they do. PR #29 merged it with Phase 6's acceptance spec red; the slices after it closed
Phase 6 (four defects, all of them invisible to a unit test) and finished Phase 7 (help sheet, the
`Shift+H` key, the panel hint, one strings table, and these three documents).

**Where it sits in the counts in §2.** Nowhere, and that is the point: **this was never a gap row.**
Neither Roll20 nor Foundry ships an overland hexcrawl as a first-class scene type, so there is nothing
to reach parity with. `GAP_ANALYSIS_Roll20_Foundry.md` §5.1 now says so under "Built here, not parity —
do not schedule as gap closure". What the feature *reuses* (fog, the world clock, compendium packs,
scene copy, the op pipeline) is already counted in the rows above.

**Gates executed on the closing tree.**

| Gate | Result |
|---|---|
| `pnpm test` | **261 files / 3 100 tests passed** (2 files, 12 tests skipped) |
| `pnpm typecheck` | tsc clean; svelte check **50 components, 0 blocking**, 1 advisory (`ReplayPanel.svelte:29`) |
| `pnpm lint` | 0 problems |
| `pnpm size` | **3 142 538 B raw / 904 019 B gzip** — inside the 6 MB raw budget |
| `playwright test --project=chromium`, hexcrawl specs | **11 passed** across `hexcrawl_scene`, `hexcrawl_tables`, `hexcrawl_encounters`, `hexcrawl_fog`, `hexcrawl_travel`, `hexcrawl_help` |

**Two browser failures that are not this feature's**, both recorded with the evidence that says so:
`hexcrawl_fog`'s "closing a hex takes the document away again" step failed once in a nine-spec run and
**passes standalone (41.8 s)** — the two-peer propagation class §3.6 already documents — and
`webrtc.spec.ts`'s PixiJS layer-order test fails on the pristine `0a48ced` tree in this sandbox as well
(checked by stashing the diff and rebuilding), i.e. a WebGL limitation of the headless Chromium here.

**Still unverified here, unchanged from §3.4:** the firefox/webkit matrix and CI (there is none). The
browser runs above use the npm-sourced Chromium through the config's
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override, because this sandbox cannot reach the Playwright CDN.
