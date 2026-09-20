# Implementation Plan — Closing the Roll20/Foundry Gaps (v2)

**Date:** 2026-09-20 · **Base:** `arena/01a0bc2f-arenastar-vtt` @ `13962e8`
**Supersedes:** v1 of 2026-09-19 (`8ce5097`). v1's Phase 0/1 and two of its Phase-2 items were
**executed** between the two dates; §0 records that, and the rest of this file plans only what is
left. Gap statuses are from the same-day verification pass in `GAP_ANALYSIS_Roll20_Foundry.md`
(G-01…G-45).
**Reads with:** `GAP_ANALYSIS_Roll20_Foundry.md` (statuses + evidence), `DECISIONS.md`
(D-248…D-256, D-112, D-113, D-249, D-252), `PF1e_Unified_TODO.md` (L01–L07 backlog),
`ROADMAP.md`, `TOOLBAR_PARITY_PLAN.md`.

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

### 1.1 Content delivery to a GM — **G-44** · S–M · **highest value in the plan**

**Problem (verified).** The 25,376 converted entries and the full-content tester world exist only
as `dist/**` products whose input (`tools/content/vendor/`, 262 MB of upstream checkouts) is
git-ignored: `ls dist/content` → absent, `dist/worlds` holds the starter only, and
`scripts/buildStarterWorlds.mjs` skips the tester world with a note when content is missing. A GM
who clones the repo cannot obtain the content the parity story now depends on.

**Work.**
1. `pnpm content:fetch` — a scripted, pinned checkout of the upstream mirrors into
   `tools/content/vendor/`, then `content:convert` → `build:systems` → `build:worlds`. The clone
   commands and the pinned commit hashes exist today only as prose in
   `tools/adopt/INVENTORY.md`/`tools/convert/README.md`; the script makes them repeatable (and
   fails loudly with the offline alternative when a mirror is unreachable). One documented command
   from a fresh clone to a full-content world zip.
2. Publish the built artifacts as **release assets** (the tester world zip, stage packs) with
   checksums, so a GM without the toolchain downloads one file; README quickstart gains the two
   paths (fetch-and-build, download-and-open).
3. OGL/CREDITS surface: `LEGAL.md` + `OGL.txt`/`CREDITS.md` inside every content zip (already
   written by the converter) **and** an in-app "Licenses & credits" entry in the Help window
   (G-41's panel is already there), so attribution is visible to players, not just inside a zip.
4. Icon/art policy decision (v1 risk 3) folds in here, because it changes the artifact's size and
   its CREDITS story: adopt system icons with attribution, generate neutral category glyphs, or
   hybrid (recommended).

**Acceptance.** From a clean clone with network: the documented command produces
`dist/worlds/pf1e-mass-battles-tester-<v>.zip`; the zip opens in the app, lists the 28 packs, and
drag-imports a spell/feat/item/class; `pnpm build` leaves `dist/index.html` under the 6 MB gate
(content untouched in the app body). `tests/scripts/testerRealZip.test.ts` — which self-skips via
`describe.skipIf(!existsSync(zipPath))` today — must **run, not skip**, and pass on the produced
zip ("real tester zip (real converted content)"), because a skipped test is exactly how this gap
stayed invisible.

### 1.2 Door & wall lifecycle + window primitive — **G-43 / G-27** · S · *fixes a shipped defect*

**Problem (verified).** `src/app/App.svelte:257-275` writes `door: 1` (i.e. **open**) for a placed
"door" and hardcodes `move: 1, sight: 1`, so the rail's wall/door choice only changes a label and
the door dot colour (`src/canvas/layers/WallsLayer.ts:59`). Nothing in the app mutates `door`
after creation, and there is no window primitive.

**Work.**
1. Map the rail's kinds to honest documents: *wall* → `door: 0` (closed state is irrelevant for a
   solid wall: keep `sight/move/sound/light = 1`); *door* → `door: 0` (closed) with the
   conditional axes, so an open/close toggle means something; *window* → `sight: 2` (permits),
   `light: 2` (permits), `move: 1` (blocks), `sound: 1` — the existing restriction axes already
   express it, no document change.
2. Door interaction: click/`D` on a door dot toggles `door` 0 ⇄ 1 (update op), lock via
   modifier; the GM-only Walls layer already renders the three states.
3. Wall editing: select a wall (GM layer) → delete / drag endpoint / change kind, replacing
   "erase last placement" as the only correction path. Reuse the existing op + selection
   plumbing; no new document types.

**Acceptance.** e2e: place a door → it blocks sight while closed (vision polygon shrinks), toggling
it opens the line of sight (`e2e` reads the vision result, the pattern
`e2e/vision.spec.ts:30` already uses for an open doorway); place a window → sight and light pass,
movement does not (`moveSegments` still contains it); delete and re-place a wall from the UI.
Unit: the kind→document mapping table.

### 1.3 Inventory, items & encumbrance — **G-03 / G-04 / G-05 tail** · M–L

**Problem.** No `encumbrance`/`carryingCapacity` anywhere in `src/`; items are authored actor
fields; converted equipment/magic packs have no sheet surface.

**Work.**
1. **Items tab** on the actor sheet over `ActorDocument.items` (embedded, already in the core
   contract): rows = icon/name/qty/price/weight, equipped toggle, `uses` (charges) ledger
   `{max, value, per}`, containers (nested), currency pp/gp/sp/cp.
2. **Item sheet window** (`WindowHost` kind `item`): description through the existing
   description renderer, properties, `changes` preview, hint chips (Koboldworks parity, cheap).
3. **Encumbrance**: Str-based capacity, load thresholds, dwarf rule + Muleback-style Str bonus as
   a world setting (transcription T3 — all pure formulas, `src/packages/pf1e/`).
4. **Item → attack linkage**: "create attack from this weapon" writes the existing
   `PF1eAttackEntry` (the sheet's attack editor is the consumer, unchanged); consumables
   (potion/wand/scroll) generated from a spell with charges from T6.
5. **Widening**: extend the closed `PF1E_MOD_KEYS` list (`src/packages/pf1e/effects.ts:24`) to the
   skills whose typed mods are still missing (G-01 remainder) — one slice, one test.
6. **Imported items' Foundry `changes[]`** — decide here, not by accident: either map the common
   Foundry paths onto typed mods (`system.attributes.ac.flat` +2 → `ac` +2 untyped; saves, attack,
   damage, ability scores), or ship those items as description-only and say so in the item sheet.
   **D-112 forbids** introducing a general path-overwrite mechanic; the mapped subset becomes the
   C1 fixture set (`tools/adopt/README.md` defines C1 "golden converted items that must derive the
   same stats", seeded from the pipeline, ~50 items). Scope expectation: the mapping covers the
   majority of *passive* items and none of the scripted ones (`scriptCalls` are dropped and
   counted by the converter).

**Acceptance.** e2e: create an actor, import a weapon + a wand from a converted pack, equip, see
AC/encumbrance/speed change, make an attack from the item, cast the wand and watch a charge
decrement and persist across reload. Unit: T3/T6 fixtures with AoN citations; a `changes[]`
fixture from the C1 corpus (see §5) proves item-driven modifiers reach `derivePF1eActor`.

### 1.4 Compendium scale UX — **G-45** · S–M

**Problem.** Ranked full scan per keystroke, id-index only (`src/core/compendium.ts:139-195`),
browse list capped rather than virtualized — at 20k entries this is "type the exact name".

**Work.** (a) Per-pack prefix/word buckets computed **at parse time** and a name+keywords index
kept in memory while the full entry bodies stay lazy per pack; (b) windowed row rendering — there
is no virtualized list in the repo today (`grep` finds none; browse currently renders a capped
list), so this is a small new component, not a reuse; (c) filters/sort (level, school, type, pack)
that operate on the index, not on the rendered rows; (d) a budget test in the shape of
`tests/ui/pf1eFrameBudget.test.ts` (V08): summed keystroke cost at 20k entries under 16 ms, plus a
memory assertion for the hot set (≤ 8 MB).

**Acceptance.** Performance test in `pnpm test`; e2e opens the compendia tab on the full-content
world, types a partial name, and drag-imports the 3rd hit.

---

## 2. Wave 2 — platform parity a table feels within a session

### 2.1 Sight bounded by lighting — **G-24** (+ G-26, G-32 decision) · L · *the biggest platform gap*

**Problem (re-verified).** `src/canvas/vision/lights.ts` is render-only; nothing in the vision
worker, `fogVisibleTokenIds` or the fog loop reads darkness/light state, so tokens see through
unlit darkness.

**Work.** The document already carries what this needs, which keeps the slice small:
`TokenDocument.vision: boolean` (`src/core/documents.ts:66`) is the sight gate the reveal uses
(`src/core/fogExploration.ts:104`), and `TokenDocument.light: TokenLight { radius, color, alpha }`
(`:48`) is already an emitted light source (the D-256 lighting tool writes one). What is missing is
a **vision range** and a darkness/light term.
1. Model: add `sight` range + `darkvision` range to the token's vision settings (extend
   `TokenLight`'s sibling block, not a new document type), keeping `vision: boolean` as the master
   gate; per-scene ambient darkness and per-token lights already exist.
2. Gate the reveal and the token-visibility set on light state — `fogVisibleTokenIds` gains a
   light term; `sightSegments` stays as it is. The vision worker's angular sweep is unchanged; the
   effective radius becomes `max(darkvision, min(sight, lit radius))` per viewer.
3. **G-32 decision** (host-side vs client-side withholding of positions) is the *same* decision as
   this: while lighting is client-side, darkvision is advisory. Take it explicitly here, or record
   why not.
4. **G-26** (light animation, priorities/thresholds) follows once the model exists — separate
   slice, no document change.

**Acceptance.** Unit: light/vision matrix (unlit + no darkvision → nothing new revealed; darkvision
→ reveal within its range; bright vs dim radius). e2e: the fog spec's pattern, with the GM turning
the lights off and the player's `visibleTokenIds` shrinking without any token moving.

### 2.2 Table flow — **G-22 / G-10a / G-10b / G-20** · M

1. **Token HP bars** (Med): Pixi label under the token, driven by the derived HP the sheet already
   computes; world setting for bar visibility (GM only / always / on hover).
2. **Player quickbar** (Med): per-character action slots bound to item actions / attack actions and
   spells; the core macro hotbar (slots 1–5) is the existing mechanism to generalize.
3. **Chat-card apply buttons** (Med): apply/heal intent on arbitrary rolls, host-authoritative —
   the verified-roll plumbing already exists; this is UI + one intent + a permission check.

**Acceptance.** e2e per item, driven through the real UI and read back from the host replica (the
D-255/D-256 pattern).

### 2.3 Tails · S

- **GM "view as player X"** (G-25 remainder): the host already keeps explored fog **per user +
  scene** (`src/host/sync.ts:130-140`, D-250) and `e2eHook` already exposes masked
  `fogMaskStrokes()`; the slice is a viewer switch in the fog layer, not new state. The existing
  `viewAsFaction` is the *strategic* mass-battle fog and is *not* this.
- **Onboarding & help** (G-41 remainder): first-run tips, docs links from the Help window.
- **i18n extraction** (G-38): start `src/ui/i18n` (UI strings only; OGL content stays English with
  a later translation pass) — schedule when a non-English table is actually in scope.

---

## 3. Wave 3 — breadth and on-ramp

1. **Character import — G-39** (Med–L). Hero Lab XML (R20's path), Foundry actor JSON, Roll20 sheet
   export → our actor shape. Pairs with 1.1: a migrating table gets characters *and* content in one
   move, which is the on-ramp both competitors win on today.
2. **Statblock import — G-08** (S–M). Pasted text → bestiary actor through the existing actor
   shape; the structured bestiary packs are already the reference for the target fields.
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
| 1.1 | Content fetch + publish + credits | — | S–M | G-44, (G-18 remainder) |
| 1.2 | Door/wall lifecycle + window | — | S | G-43, G-27 |
| 1.3 | Inventory + items + encumbrance | 1.1 (packs to import) | M–L | G-03, G-04, G-05 tail, G-01 tail |
| 1.4 | Compendium scale UX | 1.1 | S–M | G-45 |
| 2.1 | Lighting-as-vision (+G-32 decision, +G-26) | — | L | G-24, G-26, G-32 |
| 2.2 | Table flow (HP bars, quickbar, chat apply) | 1.3 for item-bound slots | M | G-22, G-10a, G-10b, G-20 |
| 2.3 | Tails (view-as, onboarding, i18n) | 2.1 for view-as | S | G-25 tail, G-41 tail, G-38 |
| 3.1 | Character import | 1.3 (item/actor shape stable) | Med–L | G-39 |
| 3.2 | Statblock import | — | S–M | G-08 |
| 3.3 | Non-combat + condition tails | — | M | G-11, G-21 |
| 3.4 | Breadth content (Mythic/companions/PFS) | 1.1 | M | G-14/15/16 |
| 3.5 | Polish (sound, views, theming) | — | M | G-29/31/40 |

**Critical path: 1.1 → 1.3 → 2.2 → 3.1.** Everything else parallelizes: 1.2 and 1.4 need nothing,
2.1 is independent of the content track, 3.2/3.3/3.5 are standalone. Wave 1 is deliberately all
"small, unblocks the already-built" work — it is the cheapest way to make the landed pipeline and
sheet real for a GM.

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

**Test-environment reality (this sandbox).** 2 cores, 4 GB: the chromium suite (174 specs) must run
**serially**; four heavy specs (fog, fog_player, sheets, combat) time out when four browsers plus a
vision worker share the box, and the heaviest fog polls need a 45 s budget. A "full suite" result
should name the one load-sensitive spec that failed and show it green standalone, as D-256 does,
rather than pretending the environment is idle.

**Per-wave acceptance highlights**
- 1.1: clean-clone → documented command → working full-content world; a booting test over the
  produced zip.
- 1.2: door toggle changes sight geometry end to end; window passes sight/light, blocks movement.
- 1.3: import → equip → attack → cast → charge decrement, all through the UI, all persisted.
- 1.4: < 16 ms keystroke at 20k entries, virtualized browse, drag-import from a large pack.
- 2.1: darkness gates reveal and token visibility; darkvision restores it; no document change to
  walls required.
- 2.2: HP bar, quickbar slot and chat-apply each asserted against the host replica.

---

## 7. Risks & open decisions

1. **Repo LICENSE still absent** — does not gate third-party adoption (case-by-case), but it does
   gate accepting community contributions and telling anyone what they may do with the app. Decide
   in Wave 1.1 (it is the natural moment: credits and attribution land there).
2. **Upstream content availability** (1.1): the mirrors are third-party GitLab/GitHub repos; pin
   commits and record checksums so a fetch failure is diagnosable, and ship the built artifact so
   a GM is never blocked by an upstream outage.
3. **Bestiary (1c) format** — if the module ships only Foundry `.db` packs, budget our own decoder
   (original code, ~a day). Do not ship a `.db` reader that depends on an unlicensed toolbox.
4. **Icon/art policy** (1.1) — attribution vs generated glyphs; affects artifact size and CREDITS.
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
