# Implementation Plan — Closing the Roll20/Foundry Gaps (v2)

**Date:** 2026-09-20 · **Base:** `arena/01a0bc2f-arenastar-vtt` @ `13962e8`
**Supersedes:** v1 of 2026-09-19 (`8ce5097`). v1's Phase 0/1 and two of its Phase-2 items were
**executed** between the two dates; §0 records that, and the rest of this file plans only what is
left. Gap statuses are from the same-day verification pass in `GAP_ANALYSIS_Roll20_Foundry.md`
(G-01…G-45).
**Reads with:** `GAP_ANALYSIS_Roll20_Foundry.md` (statuses + evidence), `DECISIONS.md`
(D-248…D-256, D-112, D-113, D-249, D-252), `PF1e_Unified_TODO.md` (L01–L07 backlog),
`ROADMAP.md`, `TOOLBAR_PARITY_PLAN.md`.

**Status 2026-09-21 @ `19c821a` (re-synced by D-265; D-266 and D-267 added):** of the twelve numbered
items, **eight are done** — 1.1 (D-258), 1.2 (D-257), 1.3 (D-259), **1.4 (D-266)**, 2.1 (D-260),
2.2 (D-261), 3.1 (D-264), **3.2 (D-267)** — and **2.3 is two of its three tails done** (G-25
remainder, D-262 view-as; G-41 remainder, D-263 onboarding), leaving **G-38** (i18n) open. **The
critical path 1.1 → 1.3 → 2.2 → 3.1 is complete, Wave 1 is complete, and Wave 3 has opened (3.1, 3.2
done).** The open set is four numbered items — 2.3's G-38, 3.3 (G-11/G-21), 3.4 (G-14/G-15/G-16),
3.5 (G-29/G-31/G-40) — plus the tails named in the done rows (wall reshaping, lighting richness,
the `.por` archive, 3.5-era stat blocks and swarm/spell-like automation). The gap analysis carries the
same re-sync (`GAP_ANALYSIS_Roll20_Foundry.md` §4, re-synced 2026-09-21).

**How to read this plan.** Three waves, value-per-day first and dependencies second, then an
**opportunistic track** that is explicitly *not* gap closure. Every item names the gap it closes,
what already exists that it builds on, and the evidence that declares it done. Anything not here is
closed (§0), an architectural bet (§0.1), an opportunistic bet (§5), or deliberately out of scope
(§7.8).

---

## 0. What already landed — do not re-plan

| v1 item | Status | Decision | Consequence for this plan |
|---|---|---|---|
| Phase 0 feasibility spike (clone sources, 500-entry sample, go/no-go) | **Done** | D-253 | The open questions it existed to answer (can Foundry content be converted, at what size) are answered with numbers in `DECISIONS.md`. No new spike needed. |
| Phase 1a/1b content conversion (pf1 system packs + `pf1e-content`) | **Done** | D-253 | 28 packs / 25,376 entries; `pnpm content:convert`. Remaining content work is **bestiary (1c)** and **distribution** (G-44). |
| Compendium entry cap → app-body-origin only | **Done** | D-252/D-253 | `COMPENDIUM_MAX_ENTRIES = 2_000` (app origin) vs `COMPENDIUM_WORLD_SANITY_MAX_ENTRIES = 1_000_000` (world origin), `src/core/compendium.ts:22-81`. Do not re-open; the *scale UX* is still open (G-45). |
| World-file packaging (format 2, ruleset + content embedded, uncapped) | **Done** | D-248/D-249 | Delivery model unchanged; the missing piece is the GM-side fetch path (G-44). |
| Phase 2.1 skills (G-01) and 2.2 builder/leveling (G-02) | **Done** | D-254 | Superseded by the audit: only the `PF1E_MOD_KEYS` widening and per-level drag remain, and both ride the inventory slice. |
| Phase 3.2 fog GM brushes (G-25) | **Done** | D-256 | `src/core/fogMask.ts` + both shells + token gating. Remaining: "view as player X" (Wave 2.3). |
| Rail / toolbar parity work (not in v1) | **Done** | D-255/D-256 | Layers, draw shapes, measure options, dice tray, wall/light placement, pins, help window. Its wall/door semantics are **defective** — Wave 1.2 / G-43. |
| `.svelte` typecheck gate (not in v1) | **Done** | D-256 | `scripts/checkSvelte.mjs` inside `pnpm typecheck`; 39 components, 0 blocking. |
| **Wave 1.2** door/wall lifecycle + window (G-43/G-27) | **Done** | D-257 | Kinds map to honest axes (`src/canvas/vision/wallKinds.ts`), doors are placed closed, a click toggles them, locked ignores clicks, `Alt`-click deletes, and the GM overlay is drawn. Remaining G-43 tail: endpoint reshaping / kind change after placement. |
| **Wave 1.1** content delivery to a GM (G-44) | **Done** | D-258 | `tools/content/sources.json` (the pins, as data) + `pnpm content:fetch` (idempotent, verifies HEAD == pin, names the offline alternative) + `pnpm content:package` (the installable zip + `dist/release/SHA256SUMS`) + `LEGAL.md` and the Help window's *Licences & credits*. A fresh clone reaches a full-content world zip with one documented command, and `tests/scripts/testerRealZip.test.ts` **runs** instead of skipping. Hand-off: attaching the zips to a release page (no tags exist yet). |
| Adoption/transfer pipeline **scaffolding** (v1 §5.5 P-1…P-3) | **Partly done** | D-253 | `tools/adopt/INVENTORY.md` (10 candidates, licenses verified at pinned commits, `legalStatus: pending`) + `tools/adopt/README.md` (the P-1…P-6 flow). What is *not* built: the `fx.json` validator/loader, the C3 playback corpus and the C4 module-API conformance modules — see §5. |
| Content-mapping documentation (v1 §2.2/§2.3) | **Superseded** | D-253 | `tools/convert/README.md` documents the landed pipeline (28 packs, drop policy, source-shape detection) better than the plan's preview did; the v1 text stays in git history. |
| `changes[]` as the item-automation mechanic (v1 §2.3) | **Rejected — do not revive** | D-112 | The project decision keeps `EffectDocument` untouched and PF1e on a **closed typed mod list** with bonus-type stacking (`src/packages/pf1e/effects.ts`); "path overwrite" changes cannot express "+2 morale to AC". The converter keeps Foundry `changes[]` raw under `system.foundry` for reference; **nothing evaluates them**, and Wave 1.3 must not start. |

**Still standing from v1 (unchanged user decisions — not re-litigated here):**
1. **Two size domains.** App body = `dist/index.html`, constrained by the `pnpm size` 6 MB raw
   gate and the 2,000-entry app-origin compendium cap. World zip = any size; the canonical
   artifact. Content and FX lazy-load from the world zip; nothing content-shaped enters the app
   body.
2. **Legal posture: case-by-case, owned by Legal, nothing ships without its case closed.** This
   plan records license facts and keeps each case cheap; it decides none. The v1 license table
   (this file's own §1.1 before this rewrite) lives in `tools/adopt/INVENTORY.md` as the
   maintained version — 10 candidates with license verified at a pinned commit — and git history
   keeps the original: `git show HEAD:GAP_CLOSURE_ImplementationPlan.md`.
3. **Git hygiene.** `tools/**/vendor/` and `dist/**` stay out of git; world zips are release
   artifacts; the 10k-file / 128 MB patchset caps are respected by construction.
4. **Gates.** `pnpm typecheck` (tsc + `checkSvelte`), `pnpm lint`, `pnpm test`, `pnpm build` →
   `build:systems` → `build:worlds`, `pnpm size`, chromium e2e. No wave is "done" without them.

---

### 0.1 Out of scope by design — architectural bets, not gaps to close

These sit in the gap list because competitors have them; they are **not** this plan's work, and
they are the first things to cut when a slice runs long. Each contradicts the serverless
single-file identity, and each would be re-opened only by an explicit scope decision:

- **G-33 accounts & multi-device worlds** — the GM tab *is* the host; sync, persistence and
  ownership are built around that. A server tier is a different product.
- **G-34 dedicated mobile apps** — PWA only; `G-42` (browser matrix) is the quality question here.
- **G-35 marketplace/distribution** — the content pack format (§1.1) is the *local* distribution
  mechanism; a marketplace needs accounts (G-33) and a legal/paid posture (v1 risk 5).
- **G-13 house rules** and third-party-licensed content — L-items in `PF1e_Unified_TODO.md`; they
  become plan items only when promoted by a decision.

## 1. Wave 1 — close the loops already opened

No new architecture. Each item unblocks something that already exists but cannot be reached,
trusted, or used.

### 1.1 Content delivery to a GM — **G-44** · S–M · **highest value in the plan** — ✅ **done (D-258)**

**Problem (verified at the audit).** The 25,376 converted entries and the full-content tester world
existed only as `dist/**` products whose input (`tools/content/vendor/`, 262 MB of upstream
checkouts) is git-ignored: `ls dist/content` → absent, `dist/worlds` held the starter only, and
`scripts/buildStarterWorlds.mjs` skipped the tester world with a note when content is missing. A GM
who cloned the repo could not obtain the content the parity story now depends on.

**Result — every step below was executed, not planned (D-258).**
1. ~~`pnpm content:fetch` — a scripted, pinned checkout~~ **done.** `tools/content/sources.json`
   holds each source as data (repo, exact commit, sparse paths, required dirs, licence fact) and
   `tools/content/fetch.mjs` materialises it: blobless + sparse clone, idempotent, verifying
   `HEAD == pin` **and** that every required path exists and is non-empty, failing with the offline
   alternative named. `--check` reports state without changing it; `--dest` / `--only` / `--force`
   cover the rest. The vendor→converter and converter→worlds hops are bridged by
   `VTT_CONTENT_VENDOR` / `VTT_CONTENT_DIR` rather than hard-coded paths, and `pnpm test:e2e` now
   re-runs the conversion (`--allow-missing`, one explicit flag, printing its skip) instead of
   letting a `pnpm build` quietly cost the content specs their coverage.
2. ~~Publish the built artifacts (release assets) with checksums~~ **built and checksummed.**
   `pnpm content:package` emits `dist/packages/pf1e-content-1.0.0.zip` (8,084,502 B) — exactly the
   shape the app's own importer installs — plus `dist/release/SHA256SUMS` over it and the world
   zips. The bytes are reproducible (sorted walk, fixed 1980-01-02 zip mtime), which is what makes
   a published checksum verifiable by whoever rebuilds. README's *Content: two ways in* documents
   both paths; the release upload itself is a maintainer step (the repo has no tags yet).
3. ~~OGL/CREDITS surface~~ **done.** `LEGAL.md` is the repo's legal posture; the converter already
   ships `OGL.txt` + `CREDITS.md` inside the package; `src/core/credits.ts` inlines
   `tools/content/sources.json` at build time and the Help window's *Licences & credits* section
   (`[data-credits]`) names each source, its pinned commit and its licence — attribution a player
   reads without opening a zip.
4. **Icon/art policy — decided (v1 risk 4).** Nothing upstream ships: the converter drops `img` and
   counts it per pack in `REPORT.md`, entries carry no icon path, and the app draws its own glyphs.
   No generated art was added in this slice — it would change artifact size and the CREDITS story
   for no user-visible gain today.

**Acceptance — met.** From a clean clone the documented commands produce
`dist/worlds/pf1e-mass-battles-tester-1.0.0.zip` (8,185,999 B) carrying `OGL.txt` + `CREDITS.md` in
15.9 s after an 11.9 s fetch — and the clean clone's `SHA256SUMS` is **byte-identical** to the one
built here (two independent builds, `sha256sum -c` 3/3 OK);
`tests/scripts/testerRealZip.test.ts` (the test that used to self-skip and hide this gap) **runs
and passes**; `e2e/content_world.spec.ts` opens the real zip through the start screen, finds
≥ 28 packs / ≥ 25,376 entries in the compendium reader and imports a spell and a feat into an actor
sheet through the UI; `pnpm build` leaves `dist/index.html` at 2,823,986 B raw / 806,350 B gzip,
far inside the 6 MB gate.

### 1.2 Door & wall lifecycle + window primitive — **G-43 / G-27** · S · *fixes a shipped defect*

**Problem (verified).** `src/app/App.svelte:257-275` writes `door: 1` (i.e. **open**) for a placed
"door" and hardcodes `move: 1, sight: 1`, so the rail's wall/door choice only changes a label and
the door dot colour (`src/canvas/layers/WallsLayer.ts:59`). Nothing in the app mutates `door`
after creation, and there is no window primitive.

**Work.**
1. ~~Map the rail's kinds to honest documents~~ **done (D-257)**: *wall* → `0` on every axis
   (unconditional — a door state must never open a wall); *door* → conditional `1` on every
   axis, placed `door: 0` (closed) unless the rail says open/locked; *window* → `sight: 2`,
   `light: 2`, `move: 0`, `sound: 2` — the existing restriction axes express it, no document
   change, and `wallKindOf()` recovers the kind for worlds written before D-257.
2. ~~Door interaction~~ **done (D-257)**: a click on the door dot toggles closed ⇄ open; a
   locked door ignores the click; the GM overlay that draws the dot is synced onto the GM Info
   layer and redraws on replica changes and camera moves.
3. **Wall editing — partially done (D-257)**: `Alt`-click deletes a wall (beyond "erase last").
   Still open: drag an endpoint, change a placed wall's kind.

**Acceptance.** e2e: place a door → it blocks sight while closed (vision polygon shrinks), toggling
it opens the line of sight (`e2e` reads the vision result, the pattern
`e2e/vision.spec.ts:30` already uses for an open doorway); place a window → sight and light pass,
movement does not (`moveSegments` still contains it); delete and re-place a wall from the UI.
Unit: the kind→document mapping table.

### 1.3 Inventory, items & encumbrance — **G-03 / G-04 / G-05 tail** · M–L · ✅ **done (D-259)**

**Problem.** No `encumbrance`/`carryingCapacity` anywhere in `src/`; items are authored actor
fields; converted equipment/magic packs have no sheet surface.

**Result — every step below was built and executed, not planned (D-259).** Three new pure
rules modules (`src/packages/pf1e/inventory.ts`, `itemChanges.ts`, `consumables.ts`) plus the
Items tab and item window; the numbers live in the package, the pixels in the sheet.

1. ~~**Items tab** on the actor sheet over `ActorDocument.items`~~ **done.** `PF1eItemsTab`
   renders rows (category, name, quantity-aware weight, price, `uses` ledger, armor line,
   equipped toggle, ±1, use/recharge, **Attack**, carry/stow, container select), nested
   containers one level deep (a dangling container id is named, never hidden), the
   pp/gp/sp/cp block, and the load readout. It also carries the missing verb that makes a
   converted pack reachable: the world `items` collection (what a compendium *Item* import
   writes) is listed as a picker, and **Add** embeds a copy on the actor through one ordinary
   `create` op with a parent (the item's `_id` is kept, so the item-window id is stable, and a
   collision is refused with a reason).
2. ~~**Item sheet window** (`WindowHost` kind `item`)~~ **done.** `PF1eItemWindow` (`kind:
   "item"`, id `pf1e-item:<actor>:<item>`, 420×520) shows the description through the existing
   markdown renderer, a properties list, the **`changes` preview** (applied vs. kept-but-not-
   applied, each with its reason), the weapon line ("1d8 · crit 19–20/×2 · heavy blade") and the
   cast panel.
3. ~~**Encumbrance**: Str capacity, load thresholds, dwarf rule + Muleback-style Str bonus as a
   world setting~~ **done.** Table 7-4 (with the size and quadruped multipliers and Tremendous
   Strength), Table 7-5 (max Dex, ACP, run), the reduced-speed table 5–120 ft and the "worse of
   armor and load, do not stack" sentence are `inventory.ts`, transcribed row-for-row in the
   unit test. World settings `encumbranceRule` (`weight`/`off`) and
   `encumbranceCapacityStrBonus`; dwarf **Slow and Steady** from either an actor trait or a worn
   item; capacity-only Strength from a Muleback-style item flag.
4. ~~**Item → attack linkage**; consumables generated from a spell with charges~~ **done.**
   "Attack" writes a real `PF1eAttackEntry` (tagged `itemId`) into `system.pf1e.attacks`, which
   the sheet's existing attack editor reads unchanged. `planConsumable` generates a wand (50
   charges, CL 5, no recharge), staff (10, rechargeable), scroll and potion (single use) from an
   authored spell, with the item's **own** save DC (`10 + level + the minimum ability modifier`)
   and its own caster level; the charge decrement is written by the existing cast flow as an
   embedded-document op, so the cast card and the ledger cannot drift.
5. ~~**Widening** the closed `PF1E_MOD_KEYS` list (G-01 remainder)~~ **done.** `effectOps`/
   `effects` gained the `skill.<id>` family and `naturalArmor`, with `resistance` added to
   `PF1E_BONUS_TYPES` so a converted cloak's `resist` is a typed bonus rather than a promoted
   untyped one.
6. ~~**Imported items' Foundry `changes[]`** — decide here~~ **decided and built.** The
   **mapped subset** (D-112 forbids a general path-overwrite mechanic, so `set` is refused by
   name): the PF1e system's own targets the corpus actually publishes — `ac`, `aac`, `sac`,
   `nac`, `tac`, `allSavingThrows`/`fort`/`ref`/`will`, `attack`/`mattack`/`rattack`/`wattack`,
   `damage`/`wdamage`, the six ability scores, `landSpeed`, `skill.<code>` — read from both the
   converted shape (`{subTarget, modifier, operator, formula}` under `system.foundry.changes`)
   and the vendored shape (`system.changes`, id-keyed). The C1 corpus is
   `tests/packages/pf1eItemChanges.test.ts`: fixtures copied from the pinned packs (the pack and
   item named per fixture) proving each mapped family reaches `deriveFromActorDocument`, plus the
   refusal cases (`set` by name, an unevaluable formula, an unknown target, an unmapped
   sub-skill, an unknown bonus type promoted with a note). Measured over the 28 converted packs:
   **24,487 items, 248 with a `changes[]` block, 416 changes** — `ac` 38, `allSavingThrows` 29,
   `attack` 28, `str` 19, `skill.per` 13, `ref` 13, `dex` 12, `landSpeed` 12, `wdamage` 12,
   `con` 10 … i.e. the mapping covers the passive majority and drops nothing silently.

**Acceptance — met.** `e2e/pf1e_inventory.spec.ts` (1/1, 10.8 s) builds a package whose item
rows are **verbatim copies of the converted pack rows** (Longsword from `weapons-ammo.json`,
Chain Shirt from `armor-shields.json`, Cloak of Resistance +1 from `wondrous.json` — its real
`foundry.changes` block), imports the actor and the four items through the Compendia tab, adds
them from the Items tab's picker, equips the armor (AC `16/12/14`, speed `30 ft`), equips the
cloak (saves `0/2/0` → `1/3/1`, AC unchanged — its all-zero Foundry `armor` block is *not* read
as armor; the item window shows the change as `saves · resistance +1`), carries a 50 lb anvil
(80 lb ⇒ **heavy**: speed `20 ft`, max Dex +1, ACP −6, AC `15/11/14`), makes an attack line from
the weapon item (read back out of `system.pf1e.attacks` with its `itemId`), generates a wand
from the actor's prepared spell, casts it from the item window at the hero, and sees the charge
`50 → 49` **and the whole equipment state** survive `page.reload()`. Unit: T3/T6 transcription
fixtures (`tests/packages/pf1eInventory.test.ts`, 54 tests, every expected number carrying its
AoN/CRB citation) and the C1 corpus above. Two honest notes on the acceptance sentence itself:
the **wand is generated in-app**, because neither vendored corpus ships a spell-trigger wand to
import (of the 28 packs' **24,039 item documents, not one** carries a spell block; `Wand of
misery` is a `loot` cane and `Icicle Wand` a description-only `consumable`) — which is also §1.3
item 4's own wording, "consumables … generated from a spell with charges"; and the spell it holds is *bless* (no save, no damage)
because the cast pipeline's damage grammar is bare `NdM`, so a formula like magic missile's
`1d4+1` is refused before any charge is spent — a pre-existing limit of `pf1eCastFlow`, recorded
here rather than worked around inside the fixture.

### 1.4 Compendium scale UX — **G-45** · S–M · ✅ **done (D-266)**

**Problem.** Ranked full scan per keystroke, id-index only (`src/core/compendium.ts:139-195`),
browse list capped rather than virtualized — at 20k entries this is "type the exact name".

**Result — every step was built and executed (D-266).**

1. ~~**Per-pack buckets at parse time** + name/keywords index in memory, bodies kept lazy~~
   **done.** `src/core/compendiumIndex.ts` (new) interns each pack's name/keyword tokens into flat
   typed-array postings, adds 3-gram postings (so the reference's "name contains term" rung keeps
   working rather than being silently replaced by prefix matching), and exposes `rankIndex`
   (indices, not row objects, so a 25k-row list costs 100 KB/keystroke) and `searchIndex`.
   **Parity is proved, not assumed:** `tests/core/compendiumIndex.test.ts` replays
   `searchCompendia`'s own results over every scorer rung, at every limit, for browse and for the
   explicit sorts. Per-pack parsing became `src/core/compendiumCache.ts` (memo keyed by
   world/package/version/importedAt/file, invalidated on any package write), so a second visit to
   the reader parses nothing.
2. ~~**Windowed row rendering** — a small new component, not a reuse~~ **done, as a reuse.** The
   plan's own `grep` missed it: the army roster already had tested virtualization math, so
   `windowRows` moved to `src/ui/virtual.ts` and `armyModel.ts` re-exports it (its tests unchanged).
   `CompendiaPanel.svelte` now renders a padTop/window/padBottom slice, grows its ranked window
   geometrically on scroll, and the picker (`PF1eCompendiumPicker.svelte`) does the same.
3. ~~**Filters/sort on the index** (level, school, type, pack)~~ **done.** `entryFacetsOf` derives
   kind/level/school from authored fields (nothing invented), `facetOptions` carries counts, and
   the panel's chips + sort control drive `rankIndex`; `PF1eCharacterBuilderModal.svelte` searches
   the same index instead of scanning per keystroke.
4. ~~**Budget test in the shape of V08** — summed keystroke cost at 20k entries < 16 ms, hot-set
   memory ≤ 8 MB~~ **done.** `tests/core/compendiumIndex.test.ts` generates a 20,000-entry corpus
   shaped like the converted packs and measures — **8 keystrokes in 3.6-6.8 ms (worst 4.4 ms) vs 89-113 ms
   for the linear scan it replaced (14-30×), browse of all 20k rows in 1-10 ms, accounted footprint
   5.36 MB** — printing the numbers and asserting the 16 ms/8 MB budgets directly.
   Beyond the plan: a detail pane (`panelModel.ts` — data-derived fields, read-only document
   preview, import), and `searchCompendia` kept as the documented reference the index is tested
   against.

**Acceptance — met and executed (D-266).** The performance test runs in `pnpm test`;
`e2e/compendium_scale.spec.ts` covers windowing/facets/sorts/detail on a 340-entry package,
`e2e/content_world.spec.ts` opens the compendia tab on the full-content world, types a partial
name, and **drag-imports the 3rd ranked hit** (actor + linked token) exactly as written here, and
`e2e/starter_compendia.spec.ts` does the same class of check on the **hand-authored starter world**
the GM downloads — 5 packs / 162 entries, derived from the zip, including the two shapes that broke
classification (a spell with `system.school` and no `spell` keyword, a roll table with `table` as a
string and `rows` as an object). All three were run in Chromium on this tree, not merely written:
that run is what found the collapsed spacers and the duplicate detail-pane keys (D-266).

---

## 2. Wave 2 — platform parity a table feels within a session

### 2.1 Sight bounded by lighting — **G-24** (G-32 decided; G-26 open) · L · *the biggest platform gap* · ✅ **done for G-24 (D-260)**

**Problem (re-verified).** `src/canvas/vision/lights.ts` is render-only; nothing in the vision
worker, `fogVisibleTokenIds` or the fog loop reads darkness/light state, so tokens see through
unlit darkness.

**Result — every step below was built and executed, not planned (D-260).** The document already
carried what this needed (`TokenDocument.vision` as the master gate, `TokenDocument.light` as an
emitted source, `SceneDocument.darkness`/`.lights`), so the slice is the missing **range** and the
light term in the gate, not a new document type.

1. ~~**Model**: add `sight` + `darkvision` to the token's vision settings~~ **done.**
   `src/canvas/vision/darkness.ts` (new, pure — no pixi, no store, no worker) holds the whole
   rule: `tokenVisionOf` / `tokenLightSourceOf` / `sceneLightSources` / `lightLevelAt` /
   `effectiveSightRadiusPx` / `viewerSightRadiusPx` / `withinDarkvision`. Ranges are authored in
   **feet** ("darkvision 60 ft.") and converted through the scene grid (20 px/ft on a 5 ft /
   100 px grid); light radii stay in scene pixels because that is the unit the rail's light tool
   and `LightDocument` already write. `TokenLight.bright` became authorable (absent = half the dim
   radius, the rail's own proportion).
2. ~~**Gate the reveal and the token-visibility set on light state**~~ **done.** `fogViewers`
   carries a per-viewer `radiusPx` and `darkvisionPx`; the client loop hands each viewer **its own**
   radius to the worker, so the angular sweep and `sightSegments` are untouched — what changed is
   the radius the same worker is asked for. `fogVisibleTokenIds` gained the light term (an in-sight
   token must also be lit, or inside some eye's darkvision) and `fogRevealKey` moved with the
   lighting, so a GM's darkness change re-runs the loop with no token moving. The effective radius
   is the plan's own `max(darkvision, min(sight, lit radius))`, where "lit radius" is how far the
   illumination reaching the viewer carries (`dim − distance(viewer, light)`; unbounded under
   ambient light, so a scene that never touches darkness behaves exactly as before).
3. ~~**G-32 decision**~~ **decided here (D-260): lighting stays client-side, positions stay
   replicated, darkvision is advisory.** The boundary this slice enforces is what a player's shell
   *draws, uncovers and lets a click reach* (the D-251 gate, one more term) — not information: a
   replica still holds every token's `x`/`y`, so darkvision is a table-trust boundary like fog
   itself. Host-side withholding is a **replication-layer** change (per-user projection with its own
   late-join/undo/migration story), not a lighting change; the path is now cheap, since the
   explored fog is already host-side and per user (D-250) and `fogVisibleTokenIds` is pure. Recorded
   rather than half-built.
4. **G-26** (light animation, priorities/thresholds) — **still open, as the plan says**: a separate
   slice, no document change. What it needs from here is `sceneLightSources` (colour and alpha
   included) and the render side: `LightingLayer` is built but **never synced by either shell**, so
   the app draws no darkness overlay and no torch glows yet (pre-existing; darkness reaches players
   through the fog cover, whose reach shrinks in the dark). Wall-clipped light polygons are G-26's
   display half too — illumination here is a distance test, deliberately erring toward *too much*
   light (a torch behind a wall still lights the far tile) rather than toward unplayable blackness.

**Acceptance — met.** Unit: `tests/canvas/darkness.test.ts` **19** (light/vision matrix: total
darkness with no darkvision reveals nothing; darkvision reveals within its range independently of
light; bright vs dim radius; a light caps sight while ambient light does not; the scene cap bounds
every sense; the token gate with a light, with darkvision, and without a lighting context — the old
meaning) plus `tests/core/fogExploration.test.ts` **12** (one radius per viewer, the reveal key, the
gate). e2e: `e2e/fog_lighting.spec.ts` **1/1 (29.4 s)** — the fog spec's pattern, watched by a
really joined player: daylight shows the hero, an orc 10 ft. away and a scout 40 ft. out; the GM
slides ambient darkness to 100 % through the Settings window and the player keeps **only their own
token**, with the replica's token count, `tokenPos` and explored map unchanged (and no move op in the
spec at all, so nothing but the lighting can explain the shrink); a six-cell light placed
through the rail (`dim 600 / bright 300`) brings the orc back but not the scout, whose distance is
beyond the light's reach; **"Erase last" takes the light away and the visible set shrinks again with
no token having moved**; ambient light back to 0 % returns all three with nothing placed. The four
specs that had to keep working untouched did: `fog_player` 2/2, `fog`, `vision`, `walls` 1/1 each.

**Honest notes (in D-260, not hidden here).** No lighting *render* yet (above) · a token's
`sight`/`darkvision` are document+data fields with **no editor window** today (the pre-existing
`vision` flag and `TokenDocument.light` are in the same state), so a GM reaches the slice through
the darkness control and the rail's *scene* lights, while a bestiary's darkvision needs the
converter+actor+token-editor tail recorded in D-260 · the gate's light term is provably redundant
with the reveal radius for today's single caller and is kept as the caller contract (the future
host-side gate) and against a stale-polys race.

### 2.2 Table flow — **G-22 / G-10a / G-10b / G-20** · M · ✅ **done (D-261)**

1. ~~**Token HP bars** (Med): Pixi label under the token, driven by the derived HP the sheet
   already computes; world setting for bar visibility (GM only / always / on hover).~~ **done.**
   `src/packages/pf1e/tokenHpBars.ts` is pure and deliberately thin: `tokenHpBarFor` hands back
   *the numbers the sheet already reports* (`deriveFromActorDocument`'s `hp`/`hpMax`, plus temp HP
   and nonlethal when they are non-zero) and `null` when there is no actor or `hpMax < 1`, so a
   bar can never disagree with the sheet it is drawn from. The world setting is the plan's three
   cases — `tokenHpBars: "gm"` (default) / `"all"` / `"hover"` in
   `src/core/worldSettings.ts` — and it replicates like every other world setting, so the GM's
   choice reaches players without a reload. `src/canvas/stage.ts` draws the label under the token
   (`[data-world-token-hp-bars]`) for exactly the tokens the viewer may see: the GM shell bars
   every token the canvas draws and re-bars on selection, the player shell follows the same
   fog-visibility gate D-250/D-251 built, so a bar is not a leak the fog does not have.
   **"hover"** is the stage's own hit-test, not a DOM overlay, so it works at any zoom.
2. ~~**Player quickbar** (Med): per-character action slots bound to item actions / attack actions
   and spells; the core macro hotbar (slots 1–5) is the existing mechanism to generalize.~~
   **done.** The slots are the actor's own data — `flags.pf1e.quickbar` as
   `{slot 1–5, kind: "attack" | "damage" | "item", label, attackIndex, itemId}` — so a binding is
   a document write like any other (one op, host-validated, replicated to the GM, undoable) and
   not client state that dies with the tab. `src/ui/quickbar/model.ts` reads/writes them
   (`quickbarWriteOp` rewrites the whole `flags` subtree, because a flat diff cannot create an
   intermediate path) and builds the candidate list from **the same derivation the sheet reads**
   (`pf1eAttackRollGroups` → attack + damage lines, `pf1eItemView` → castable items), with a note
   that names a binding gone stale. `run.ts` runs a slot through the sheet's own flows —
   `resolveAttackFlow` for an attack against the chosen target, `resolveCastFlow` +
   `consumableCastAuthored` for an item (charges, CL, save DC included), the public roll card for
   a damage line (which the item-3 verb can then land on a token) — so a quickbar press and a
   sheet press cannot diverge. Spells bind **through their item**; the converted corpus ships no
   spell blocks, and inventing a save type for a prepared spell is exactly what D-259 refused.
   `QuickbarRow.svelte` is mounted in both shells: the player's is their own character (the first
   fog-visible token they may `update`), the GM's follows the **selected** token — and the
   world-level macro hotbar keeps its slots 1–5 untouched.
3. ~~**Chat-card apply buttons** (Med): apply/heal intent on arbitrary rolls,
   host-authoritative — the verified-roll plumbing already exists; this is UI + one intent + a
   permission check.~~ **done.** `roll.apply` (`0x34`, ops channel) carries `{messageId, actorId,
   mode: "damage" | "healing"}` and **no amount**: the host re-reads the card's own
   `message.roll.total` from its replica, checks `can(user, "update", actor, "actors")`, refuses a
   replay through `flags.pf1e.applied` (per actor *and* mode) and commits one atomic envelope —
   actor diff + whole `flags` + a `ledgerFollowUp` note — so a rejected follow-up rolls the whole
   application back and the GM's Undo takes it off in one step. `src/packages/pf1e/rollApply.ts`
   is the rules half (`planRollApply`: temp HP first, HP floored at 0; healing caps at `hpMax` and
   strips an equal amount of nonlethal), `RollApplyRow.svelte` the surface, `applyTarget.ts` the
   D-256-style single-selection target rule. Applying in *healing* mode to a card whose own flow
   already wrote HP is deliberately allowed — the modes are the table's intent, not the card's.

**Acceptance — met.** e2e per item, driven through the real UI and read back from the host replica
(the D-255/D-256 pattern): `e2e/token_hp.spec.ts` **1/1 (8.6 s)** — a GM sees `10/10` and `12/12`,
lowers the orc to `4/12` through the *sheet's* combat tab and the bar follows; a really joined
player sees `[]` under the default `"gm"`, their own hero under `"all"`, and the hero (never the
GM's orc) under `"hover"`; `e2e/quickbar.spec.ts` **1/1 (13.7 s)** — the player's picker offers
their greataxe, the bind replicates to the host replica, pressing the damage slot posts the card,
the item-3 verb lands it on their own token (HP 20 → 20 − total), and an attack slot refuses
without a target, then resolves against the GM's orc through `resolveAttackFlow` while the orc's
own HP bar and the orc's *own* slots (a different character, bound by the GM) prove the bar
follows the selection; `e2e/roll_apply.spec.ts` **1/1 (10.2 s)** — GM `/roll 1d4+4`, select the
hero, *Damage* ⇒ `hp 20 − total` with nonlethal untouched and `applied {a-hero: {damage: total}}`
on the card, *Healing* ⇒ `{hp: 20, hpMax: 20, tempHp: 0, nonlethalDamage: 0}`, a player's own card
landing its damage as the player and replicating, a GM-only actor read back as unchanged (`12`),
and an empty-canvas click taking the row away. **D-261** carries the evidence and the deliberate
omissions.

### 2.3 Tails · S

- ~~**GM "view as player X"** (G-25 remainder): the host already keeps explored fog **per user +
  scene** (`src/host/sync.ts:130-140`, D-250) and `e2eHook` already exposes masked
  `fogMaskStrokes()`; the slice is a viewer switch in the fog layer, not new state. The existing
  `viewAsFaction` is the *strategic* mass-battle fog and is *not* this.~~ **done (D-262).** It was
  exactly the viewer switch the note predicted — `core/viewAs.ts` (the picker: players only, never
  the viewer; the identity the preview runs as; §5's withheld-document filter) plus a `viewerKey`
  in `src/client/fogExploration.ts` so a change of viewer **re-enters the scene** (fresh surface,
  that player's stored map, their eyes) and the App pointing the loop, the token gate, the pick
  list and the HP bars at the chosen player. A preview is always the opaque cover, it **reads** the
  previewed player's explored map and never writes it (the transport's `sendFogPng` is a no-op in
  preview mode), and it adds exactly one rule the client-side gate cannot know: the tokens the host
  withheld from that player (§5), applied through the loop's new `visibilityFilter`.
  **Acceptance — met.** `e2e/gm_view_as.spec.ts` **1/1 (26.6 s)**: four tokens including a masked
  one and one the host withholds; the GM's own view draws and bars all four, the joined player's
  replica holds three and their gate shows two, and under the preview the GM's canvas publishes,
  draws *and can click* exactly what that player's own canvas reports — with no bars (the default
  `"gm"` setting gives a player none), the player's own explored map behind an opaque cover, and
  the host's stored bytes for that player unchanged after a flush. Turning it off restores the GM's
  view with nothing placed. Unit: `tests/core/viewAs.test.ts` **11** + three new
  `tests/client/fogExploration.test.ts` cases (the re-entry, the no-op sync, the filter).
- ~~**Onboarding & help** (G-41 remainder): first-run tips, docs links from the Help window.~~
  **done (D-263).** The first-run aid is a **derived checklist** (`src/core/onboarding.ts`), not a
  tracked one: five steps for a GM (map → party → invite → fog → first roll) and three for a
  player (own token → sheet → the world is talking), each ticked from the replica the shell is
  already rendering, each hint naming the control that does it. Rendered by
  `src/ui/onboarding/OnboardingPanel.svelte` at the top of both sidebars (`data-onboarding`, one
  `localStorage` key per role, collapse/reopen, and `[data-onboarding-complete]` when the table is
  up and running); the Help window repeats the same list for the shell's own role plus a "Rules
  reference" section (`[data-help-links]`: d20PFSRD, Archives of Nethys — public pages only, since
  the app's own design documents ship with the repo, not the build).
  **Acceptance — met.** `e2e/onboarding.spec.ts` **1/1 (14.0 s)**: a fresh world shows all five
  steps open, and importing a map, adding a token, opening an invite, switching fog on and rolling
  a die each tick exactly one step; collapsing writes nothing to the world (`seq` unchanged);
  a joined player gets the three player steps — their token ticked because `Add token` grants
  movement (D-061), their sheet not because no character is linked — and no GM step; the Help
  window shows each shell its own list and both links (`href`/`target`/`rel`); and after a reload
  the fold is remembered while the world it describes comes back with every step already ticked.
  Unit: `tests/core/onboarding.test.ts` **9**.
- **i18n extraction** (G-38): start `src/ui/i18n` (UI strings only; OGL content stays English with
  a later translation pass) — schedule when a non-English table is actually in scope.

---

## 3. Wave 3 — breadth and on-ramp

1. ~~**Character import — G-39** (Med–L). Hero Lab XML (R20's path), Foundry actor JSON, Roll20
   sheet export → our actor shape.~~ **done (D-264).** Three readers behind one contract
   (`src/packages/pf1e/import/`: `foundry.ts`, `herolab.ts` — by label, not by path, because the
   format's nesting has moved between versions — `roll20.ts` through an alias table), one output
   shape (`ImportedCharacter`: the `system.pf1e` block `parsePF1eActorSystem` validates + embedded
   items in the shape `resolveInventoryItem` reads), and the attack lines authored by the *sheet's
   own* `attackEntryFromWeapon`, so an imported longsword and a hand-authored one cannot disagree.
   Three rules: never invent a field the source does not state, never author a total this app
   derives (a printed `1d8+4` is decomposed against the export's own Strength and the remainder
   flagged `abilityDamageIncluded`), and report every field left behind in the source's words. The
   front door validates its own product (`characterImportCheck`) and refuses rather than creating a
   sheet that derives blank. The Sheets window's Actors tab imports one file as **one** create op
   and shows the report. Unit: `tests/packages/pf1eCharacterImport.test.ts` **30**; e2e:
   `e2e/pf1e_import.spec.ts` **1/1**.
2. **Statblock import — G-08** (S–M). Pasted text → bestiary actor through the existing actor shape;
   the structured bestiary packs are already the reference for the target fields. **done (D-267)** as
   the **fourth reader** behind the D-264 front door (`src/packages/pf1e/import/statblock.ts` returns
   the same `ImportedCharacter`, so the check/one-create-op/report path is reused unchanged), read by
   label because a paste has no schema: the block's published totals are authored as totals
   (`acTotals` + `acMode: "published"`, `saves` + `savesAsTotal`, `hp (1d10+1)` → `hp`/`hpMax`/`hitDice`)
   while the two figures this app *derives* from what the block states — each line's printed attack
   bonus (including `+12/+7` sequences) and the printed skill totals — are refused and reported in the
   block's own words; a printed damage total is decomposed into `damageDice` + `damageBonus` with
   `abilityDamageIncluded: true`; DR/SR/speeds/reach/crit threat and multiplier land in their existing
   fields; senses, languages, special attacks and qualities and treasure go to `system.pf1e.creature`
   (the Details tab's own monster block) with `fast healing N`/`regeneration N (…)` read out of that
   prose. Refusals keep the house rule that a plausible sheet is worse than an error (prose is not a
   stat block; a nameless block says "paste it from the top"; no playable number creates nothing). The
   Sheets panel's Actors tab gained a **Stat block** box beside **Import**, and a header line that is
   neither the creature's name nor its type line is quoted in the report instead of dropped. Unit
   `tests/packages/pf1eStatblockImport.test.ts` **25**; e2e `e2e/statblock_import.spec.ts` **1/1**.
3. **Non-combat resolution — G-11 / G-21** (M). Specify the mechanics first (traps/haunts,
   maladies, curses — none of it is converted today, so a content pass rides behind a rules pass);
   the condition-automation tails ecosystems ship as modules come with it.
4. **Breadth content — G-14 / G-15 / G-16** (M, data-heavy): Mythic rules (nothing converted —
   needs a license case *and* a pack-table row), companion progression, PFS module — each an opt-in
   decision before it is code.
5. **Polish — G-29 / G-31 / G-40** (M, independent): soundboard/audio streaming, views/bookmarks
   and video backgrounds, themes/dark mode.

---

## 4. Sequencing, dependencies, effort

| Wave | Item | Depends on | Effort | Closes |
|---|---|---|---|---|
| 1.1 | Content fetch + publish + credits | — | S–M | G-44, (G-18 remainder) — **done, D-258** (release upload is the hand-off) |
| 1.2 | Door/wall lifecycle + window | — | S | G-43 (lifecycle), G-27 — **done, D-257** (wall reshaping open) |
| 1.3 | Inventory + items + encumbrance | 1.1 (packs to import) | M–L | G-03, G-04, G-05 tail, G-01 tail — **done, D-259** |
| 1.4 | Compendium scale UX | 1.1 | S–M | G-45 — **done, D-266** |
| 2.1 | Lighting-as-vision | — | L | G-24 — **done, D-260** (G-32 **decided**, D-260; G-26 open) |
| 2.2 | Table flow (HP bars, quickbar, chat apply) | 1.3 for item-bound slots | M | G-22, G-10a, G-10b, G-20 — **done, D-261** |
| 2.3 | Tails (view-as, onboarding, i18n) | 2.1 for view-as | S | G-25 tail (D-262 ✅), G-41 tail (D-263 ✅); G-38 open |
| 3.1 | Character import | 1.3 (item/actor shape stable) | Med–L | G-39 — **done, D-264** (`.por` zip extraction open) |
| 3.2 | Statblock import | — | S–M | G-08 — **done, D-267** |
| 3.3 | Non-combat + condition tails | — | M | G-11, G-21 |
| 3.4 | Breadth content (Mythic/companions/PFS) | 1.1 | M | G-14/15/16 |
| 3.5 | Polish (sound, views, theming) | — | M | G-29/31/40 |

**Critical path: 1.1 → 1.3 → 2.2 → 3.1 — complete as of 2026-09-21** (D-258, D-259, D-261, D-264).
Everything else parallelized as predicted: 1.2 and 1.4 needed nothing, 2.1 was independent of the
content track, 3.2/3.3/3.5 are standalone. Wave 1 was deliberately all "small, unblocks the
already-built" work — it is the cheapest way to make the landed pipeline and sheet real for a GM —
and it is **complete**: 1.4 (G-45, compendium scale UX) closed in D-266 — the last Wave-1 item,
and the cheapest item in the whole plan. Wave 3 then opened the same day with 3.2 (G-08, statblock
import) closed in D-267. What remains is Wave 3's standalone breadth (3.3 non-combat, 3.4 breadth
content, 3.5 polish), the named tails (G-43 wall reshaping, G-26 lighting richness, .por extraction,
i18n/G-38) and the opportunistic track below — no item on the critical path.

**Effort scale:** S ≈ 1–2 days · M ≈ 3–5 · L ≈ 1–2 weeks · XL ≈ 3+ weeks (v1's XL Phase 2 is
already spent).

---

## 5. Opportunistic track (not gap closure)

These are differentiators or ecosystem bets. They are worth doing, and they are **not** parity
work — do not let them take the Wave-1 lane. Each carries its own acceptance criteria when picked
up; none of them blocks a wave above.

- **FX engine (spell/attack animations).** Still the strongest differentiator available (both
  competitors' PF1e animation space is thin). The v1 design stands: original procedural particles
  first (zero assets, zero licensing), then optional sprite/video packs through an `fx.json`
  manifest with per-asset license + provenance. **Simplification vs v1:** the inventory and the
  P-1…P-3 process *already exist* (`tools/adopt/`), so the remaining scaffolding — the `fx.json`
  validator/loader, the C3 playback corpus and the C4 module-API conformance modules — lands
  **with the first pack that actually ships**, not speculatively. Adoption rows move only when a
  concrete adoption is proposed (the curated/default postures in `tools/adopt/README.md` keep each
  case cheap); nothing ships without its case closed.
- **Module ecosystem enablement (G-36).** The API, the §12 package contract and the content
  pipeline already prove the shape; what is missing is documentation + one exemplar module + a way
  to install one. That is a docs-and-packaging slice, not an architecture project.
- **Campaign-wide scripting (G-37)** and the **adventure pipeline (G-19)** — each a decision first
  (scope, permissions), then a slice.
- **3D dice polish, marketplace (G-35), mobile apps (G-34), accounts (G-33)** — arch/identity
  items. Only by explicit scope decision.

**Legal policy & corpora for anything adopted** (unchanged, one page; registry in
`tools/adopt/README.md`): a row in an inventory with the license verified at a commit hash · a `legalStatus` (`pending → approved / negotiated / rejected`) set
case-by-case by Legal · an adoption card in `DECISIONS.md` citing source, behavior spec and the
case outcome · a conformance fixture (C1 content-behavior / C2 rule-logic for the engine work this
plan does; C3 FX playback / C4 module-API when FX or adopted modules land) that keeps the adopted
behavior honest. Nothing ships without its case closed; clean-room re-implementation is the default for GPL-derived logic; OGL data ships
with notice + CREDITS; MIT code is adopted with attribution.

---

## 6. Acceptance & measurement

**Standing gates (every slice).** `pnpm typecheck` (tsc + `scripts/checkSvelte.mjs`, blocking
list must stay 0) · `pnpm lint` · `pnpm test` (vitest) · `pnpm build` → `build:systems` →
`build:worlds` (the build empties `dist/`) · `pnpm size` (6 MB raw, app body only) · chromium e2e
against the rebuilt `dist/index.html`.

**Browser matrix (G-42).** The `firefox`/`webkit` Playwright projects still exist and are opt-in
(`playwright.config.ts`), last exercised at M2 (D-082: webkit 29/29, firefox 20/20 non-RTC, with
firefox RTC blocked by *this sandbox's* ICE/DTLS). A periodic matrix run — not per slice — is the
cheap version of closing G-42, and any real browser bug it finds belongs to the slice that broke it.

**Evidence convention.** Each wave lands as a `DECISIONS.md` entry with the gap IDs it closes, the
executed gate numbers, and the e2e/unit spec names — the pattern D-253…D-256 already use. The gap
analysis gets its status characters updated in the same commit that closes a gap, so the two
documents cannot drift.

**Test-environment reality (this sandbox).** 2 cores, 4 GB: the chromium suite (**184 specs** as of D-264) must run
**serially**; four heavy specs (fog, fog_player, sheets, combat) time out when four browsers plus a
vision worker share the box, and the heaviest fog polls need a 45 s budget. A "full suite" result
should name the one load-sensitive spec that failed and show it green standalone, as D-256 does,
rather than pretending the environment is idle.

**Per-wave acceptance highlights**
- 1.1: ✅ clean-clone → documented command → working full-content world; a booting test over the
  produced zip (executed — D-258).
- 1.2: door toggle changes sight geometry end to end; window passes sight/light, blocks movement.
- 1.3: import → equip → attack → cast → charge decrement, all through the UI, all persisted.
- 1.4: < 16 ms keystroke at 20k entries, virtualized browse, drag-import from a large pack.
- 2.1: darkness gates reveal and token visibility; darkvision restores it; no document change to
  walls required.
- 2.2: HP bar, quickbar slot and chat-apply each asserted against the host replica.

---

## 7. Risks & open decisions

1. **Repo LICENSE still absent** — does not gate third-party adoption (case-by-case), but it does
   gate accepting community contributions and telling anyone what they may do with the app. The
   posture is now **recorded instead of implicit** (`LEGAL.md` §1, restated in the Help window's
   credits section, decision in D-258): no licence published, all rights reserved, no contribution
   grant. Choosing a licence is still open — it is a maintainer decision, and nothing in Wave 1.1
   depends on it.
2. **Upstream content availability** (1.1): the mirrors are third-party GitLab/GitHub repos; pin
   commits and record checksums so a fetch failure is diagnosable, and ship the built artifact so
   a GM is never blocked by an upstream outage.
3. **Bestiary (1c) format** — if the module ships only Foundry `.db` packs, budget our own decoder
   (original code, ~a day). Do not ship a `.db` reader that depends on an unlicensed toolbox.
4. **Icon/art policy** (1.1) — **decided (D-258)**: no upstream art ships (the converter drops
   `img` and counts it per pack in `REPORT.md`; entries carry no icon path; the app draws its own
   glyphs). Revisit only if a slice genuinely needs per-entry art — it changes artifact size *and*
   the CREDITS story.
5. **OGL no-charge constraint** — fine for the free single-file model; must be re-checked if any
   paid distribution is ever considered.
6. **3PP/Mythic gate** (3.4) — opt-in packs flagged `thirdParty` or excluded: still a scope
   decision, still not a blocker.
7. **Scale after conversion** — 20k entries make compendium UX (1.4) and package import times
   user-visible; measure on the real artifact, not fixtures.
8. **Scope discipline** — the opportunistic track must not displace Wave 1. If a slice cannot name
   the gap it closes or the decision it implements, it does not belong in this plan.

---

## 8. What changed from v1, and why

| v1 | v2 | Why |
|---|---|---|
| Phase 0 spike + Phase 1a/1b as the critical path | §0 ledger, closed | Executed by D-253; re-planning them wastes the largest remaining budget line. |
| Content was the finish line | **G-44** added as the first item | The audit found the content exists but is unreachable from a fresh clone — the loop was never closed. |
| "Phase 2 = skills + builder + inventory" (XL) | Only **inventory** remains (1.3) | Skills and the builder landed (D-254); leaving them in the plan inflated it and hid the real remaining size. |
| Fog tools and the rail were open gaps | Closed in §0; wall/door defect promoted to **G-43** (1.2) | D-256 closed the feature and shipped a cosmetic kind selector; fixing it is a day. |
| Phase 6 FX with a transfer/legal pipeline built up front (Phases 5/6 + 5P) | Opportunistic track, process invoked per adoption | The scaffolding was larger than the first deliverable and blocked nothing; the differentiator is the *engine + first pack*, not the paperwork. |
| Nine phases, sequential | Three waves + an opportunistic track, explicit critical path | 1.1→1.3→2.2→3.1 is now visible, and most waves parallelize. |
| Plan implied a healthy CI environment | §6 records the 2-core serial-e2e reality | D-256's full-suite runs showed exactly which specs are load-sensitive; future slices shouldn't rediscover it. |
