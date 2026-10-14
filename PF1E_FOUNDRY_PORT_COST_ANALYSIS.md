# PF1e ⇄ Foundry — three cost questions, measured (2026-10-14)

Companion to `AIS_PF1E_MODULE_READINESS.md` (which says *what* is lacking). This document answers
three quantitative questions the owner asked, with measurements where measurement is possible and
labelled arithmetic where it is not:

- **(a)** How much of the 6 MiB main file can be freed by moving the current native PF1e
  implementation into the world zip?
- **(b)** How many lines of change to AIS, its adapter and the core would make them able to *run*
  the five Foundry PF1e repositories (pf1 system, pf-content, pf1e-archetypes, statblock-library,
  SBC)?
- **(c)** How extensive is the rework if instead the *modules* are reworked to run on ArenaStar,
  reusing their code (not a clean-room rewrite)?

Everything marked **measured** was produced by the scripts in `tools/analysis/` (new in this
slice) against `main` @ `c049376` and the pf1 mirror `gabrieldosprazeres/foundryvtt-pathfinder1`
@ `681929d1`; the commands are in Appendix C. Everything marked **estimate** is surface × unit
cost, with the unit costs taken from code that already exists in this repository, and the
arithmetic shown so it can be disputed line by line.

---

## 0. The three answers

| Question | Answer | Confidence |
|---|---|---|
| **(a)** Space freed by moving native PF1e to the world zip | **Ceiling 757 KB (13.3 % of `index.html`): 732,893 B of JS + ≈24 KB of CSS.** Headroom would go from 592,560 B (579 KiB) to ≈1,349,000 B (1.29 MiB). But **99.7 % of those bytes (730,408 B, 115 of 118 files) are reachable from the *player* shell**, which today loads no packages at all. Without a GM→player package-delivery path, only **≈ 28 KB** moves for free (the already-duplicated strategic ruleset + 2.5 KB of GM-only code); with the import UI gated to the GM shell, **≈ 77 KB**. The full 757 KB requires (1) a player-side package runtime, (2) a UI-component package contract for the 311 KB of Svelte, and (3) cutting 146 import edges / 183 symbols from 27 host files — and the host-side code that (b) or (c) need would put **≈160–310 KB back** into the main file. | measured bytes; estimated glue |
| **(b)** LOC to make AIS/adapter/core run the five repositories | **≈ 23–45 k lines of product code** (host core 8–16 k in the main file; Foundry-framework runtime 15–27 k, which can live in the world zip) **plus 16–41 k of tests** at this repo's measured test ratio → **≈ 39–86 k lines**. The pf1 system accounts for ≈ 95 % of it; the other four add 0.7–1.7 k on top. Must be the **trusted in-page tier**, not the sandbox iframe: pf1 makes 558 synchronous `game.i18n.localize` calls, 119 synchronous `settings.get` calls, and its actor documents average 35 KB (max 94 KB) against a 64 KB RPC cap. | estimate on measured surface |
| **(c)** Rework the modules to run on ArenaStar, reusing their code | **pf1: 10–17 k of its 62.6 k lines modified (16–27 %), ≈ 2.7 k dropped, 7–13 k of new shim code, plus the same 7–14 k host-core slot as (b)** → **≈ 25–49 k lines of product code** (with SBC and statblock-library), tests on top, GPLv3 fork tracking 12 upstream releases in the last 13 months. **SBC: 7.2 k LOC (MIT), 10–20 % edits** if pf1's data model is kept, 30–40 % if it must write ArenaStar actors. statblock-library: ≈ 200 LOC of sheet, rest is data. pf-content / archetypes: zero code. | estimate on measured density |

Reading the three together: **(b) and (c) cost the same order of magnitude** because both need the
same host-side "foreign system" slot (document store, projection, UI hosting, packaging, player
delivery), and (c)'s shims are roughly half of (b)'s facade. They differ in what you get — (b) runs
*upstream* pf1 and its whole ecosystem unchanged behind an acceptance suite pf1 already ships; (c)
produces a maintained fork that can ship value directory by directory. And **(a) is not a
prerequisite for either**: the main file has room for the host-core part of (b)/(c) only if the
native PF1e code leaves or something else does.

---

## 1. Inputs (measured)

### 1.1 The main file

`dist/index.html` = **5,698,896 B** (gate: 6,291,456 B; headroom **592,560 B**). Composition
(measured on the file): `<script>` 5,232,860 B · `<style>` 459,348 B (of which 211,373 B are
base64 `woff2` fonts) · markup 1.7 KB. The attribution build (same inputs, no inliner, with source
map) produces a JS chunk of 5,236,560 B — within 0.1 % of the inlined script — and attributes it
as follows:

| Bucket | Bytes | Share of JS |
|---|---:|---:|
| app: UI (Svelte, non-PF1e) | 997,986 | 19.1 % |
| app: core | 777,857 | 14.9 % |
| vendor: `three` (3D dice) | 581,534 | 11.1 % |
| vendor: PixiJS | 549,343 | 10.5 % |
| app: host / client / net / storage / workers | 526,821 | 10.1 % |
| unmapped (inlined worker sources, helpers) | 363,431 | 6.9 % |
| **PF1e: tactical logic** (`src/packages/pf1e`, 70 files, excl. `import/`) | **348,022** | **6.6 %** |
| app: shell (`App`, `JoinApp`, boot, `e2eHook` 74 KB, `agentBridge`) | 341,807 | 6.5 % |
| **PF1e: UI** (38 `src/ui/**` files named `pf1e*` / `PF1e*`) | **310,713** | **5.9 %** |
| app: canvas | 136,790 | 2.6 % |
| vendor: other (msgpack, fflate, noble, fontawesome, idb…) | 94,893 | 1.8 % |
| app: dice / audio / sim / packages (AIS, loaders) | 71,938 | 1.4 % |
| vendor: Svelte runtime | 61,268 | 1.2 % |
| **PF1e: importers** (`src/packages/pf1e/import`, 7 files) | **49,003** | **0.9 %** |
| **PF1e: strategic ruleset** (`src/packages/massBattlePf1e.ts`) | **25,155** | **0.5 %** |

PF1e-named code in the bundle: **732,893 B** (14.0 % of JS, 12.9 % of the file). PF1e Svelte
`<style>` blocks are 9.5 % of all component CSS source → ≈ 23,700 B of the built stylesheet.
Minified density of this codebase: **20.1 B per non-blank line** (3,585,895 mapped bytes /
178,751 LOC) — used below to convert LOC into main-file bytes.

Largest PF1e files: `PF1eActorSheet.svelte` 82,670 · `pf1eCastFlow.ts` 47,183 · `afflictions.ts`
30,801 · `actor.ts` 26,296 · `massBattlePf1e.ts` 25,155 · `pf1eResolveFlow.ts` 22,827 ·
`import/statblock.ts` 17,495 · `maneuvers.ts` 15,265 · `PF1eCharacterBuilderModal.svelte` 14,194.

### 1.2 How the native PF1e is welded in (measured import graph)

- 118 PF1e-named files; **host → PF1e: 146 import edges (13 type-only) from 27 host files,
  importing 58 PF1e files and 183 distinct symbols.** `host/sync.ts` alone imports 75 symbols over
  21 edges; `App.svelte` 29; `CombatPanel.svelte` 26; `agentBridge.ts` 19; `e2eHook.ts` 39.
- **PF1e → host: 264 edges, 110 symbols from 39 host files** (`core/documents.ts` 48 edges,
  `core/ops.ts` 25, `core/result.ts` 23, `core/worldSettings.ts` 16, `core/ownership.ts` 13,
  `client/sync.ts` 9 …).
- **Reachability** (static graph, `import type` ignored): from the player shell
  (`joinBoot.ts` + `JoinApp.svelte`) **115 of 118 files / 730,408 B** are reachable; GM-shell-only:
  **2 files / 2,485 B** (`tokenBadges.ts`, `pf1eReactionPrompt.ts`); unreachable from either: 1
  (`rulesEntry.ts`, the package entry, 0 B). The importers (49 KB) reach the player shell through
  `SheetPanel.svelte`'s import box and `agentBridge.ts`.
- PF1e code also lives *inside* shared host files without "pf1e" in their names: `host/sync.ts`
  has 302 lines mentioning pf1e, `e2eHook.ts` 171, `App.svelte` 87, `CombatPanel.svelte` 80,
  `quickbar/model.ts` 78, `JoinApp.svelte` 46, `agentBridge.ts` 30. Not byte-attributable; bounded
  below.
- At the time of this measurement the player shell loaded **no** packages: `packageLoader` /
  `trustedModule` / `aisModule*` had 0 references in `JoinApp.svelte` and `joinBoot.ts`; package
  loading existed only in `hostBoot.ts`, `worldRecipe.ts`, `host/worldFile.ts`, `host/zipKind.ts`.
  **Superseded by D-468** (same day): the player shell now runs GM-shared AIS modules delivered in
  `ais.profile` (`src/app/playerAisRuntime.ts`); the "player-side package runtime" this analysis
  asks for in T2/T3 exists for AIS archives, not yet for Svelte component packages.

### 1.3 The pf1 system package (measured on the mirror)

| Metric | Value |
|---|---:|
| `module/` JavaScript, non-blank non-comment LOC | **62,573** product (334 files) + **3,568** tests (24 Quench files) = 66,141 (102,928 raw lines) |
| Minified bundle (Vite lib build of `module/pf1.mjs`, `fuzzysort` external) | **1,606,325 B** (372,634 B gzip) |
| Handlebars templates / partials | 185 files, 582,401 B / 66 partials |
| Stylesheets | 220 files, 297,710 B, 12,550 lines |
| Localisation `lang/en.json` | 144,642 B, 2,819 keys (7 languages, 817,850 B) |
| Pack sources | 11,315 YAML files, **21,818,121 B** in 21 packs |
| Icons (Paizo CUP art) | 1,764 files, 69,895,573 B |
| Framework references in `module/` | **4,643 call sites, 7.4 per 100 LOC** |
| Coupling-density histogram (refs / 100 LOC) | <1: 114 files / 11,356 LOC · 1–3: 27 / 3,349 · 3–6: 50 / 9,612 · 6–10: 64 / 21,162 · >10: 79 / 17,094 |
| Release cadence | 11.0 (2025-02-03) → 11.11 (2026-03-09): **12 releases in 13 months** |

Per-directory (LOC · refs/100 LOC): `applications` 20,770 · 7.5 — `models` 12,803 · 6.5 —
`registry` 6,752 · 0.8 — `documents` 5,185 · 10.7 — `config.mjs` 3,645 · 0.1 — `utils` 3,208 · 7.0
— `components` 1,965 · 12.0 — `migration.mjs`+`migration/` 2,449 · 10 — `canvas` 1,509 · 14.6 —
`chat` 1,382 · 12.7 — `pf1.mjs` 785 · 21.7 — `dice` 717 · 12.4 — `settings.mjs` 599 · 24.0 —
bootstrap leftovers (`socket`, `hotbar`, `calendar`, `compendium-directory`, `tours`, `hmr`,
`dev-mode`, `pre-localization`, `patch-core`, `modules`, `registries`) 686.

**Framework surface pf1 depends on** (distinct members · uses; full lists via
`tools/analysis/foundryApiInventory.mjs`):

| Family | Distinct | Uses | Heaviest members |
|---|---:|---:|---|
| `foundry.<ns>.<Class>` (non-utils) | 86 | 409 | `data.fields` 48, `applications.api` 38, `applications.handlebars.renderTemplate` 32, `DialogV2` 28, `abstract.DataModel` 23, `abstract.Document` 15, `ux.FormDataExtended` 13, `CompendiumCollection` 11, `perception.DetectionMode` 11, `dice.terms.Die` 10 |
| `foundry.utils.*` | 25 | 663 | `isEmpty` 134, `logCompatibilityWarning` 126, `deepClone` 88, `setProperty` 84, `getProperty` 59, `mergeObject` 51, `expandObject` 30, `randomID` 30, `Collection` 22 |
| `fields.<Type>` | 19 | 991 | `StringField` 288, `NumberField` 206, `SchemaField` 163, `BooleanField` 162, `SetField` 46, `TypedObjectField` 22, `HTMLField` 19, `EmbeddedDataField` 18, `ArrayField` 16 |
| `game.<service>.<member>` | 71 | 1,216 | `i18n.localize` **558**, `i18n.format` 174, `settings.get` **119**, `user.isGM` 51, `settings.register` 51, `packs.get` 22, `settings.set` 17 |
| `CONFIG.<X>.<y>` | 60 (21 roots) | 222 | `ux.TextEditor` 48, `Item.typeLabels` 20, `Item.dataModels` 14, `time.roundTime` 10, `Canvas.detectionModes` 9, `MeasuredTemplate.defaults` 8 |
| `canvas.<x>[.<y>]` | 59 | 144 | `perception.DetectionMode` 11, `scene` 10, `perception.update` 8, `tokens.controlled` 7, `dimensions.distancePixels` 5, `grid.isHexagonal` 4, `geometry.Ray` 4 |
| `ui.<x>` | 15 | 146 | `notifications.{warn,error,info,success}` 114, `windows`, `actors`, `chat.render` |
| `CONST.<X>` | 13 | 71 | `TOKEN_DISPOSITIONS`, `DOCUMENT_OWNERSHIP_LEVELS`, `GRID_TYPES`, `MEASURED_TEMPLATE_TYPES`, `DICE_ROLL_MODES`, `CHAT_MESSAGE_STYLES` |
| Document CRUD sites | — | 342 | `update` 184, `createEmbeddedDocuments`/`updateEmbeddedDocuments`/`deleteEmbeddedDocuments`, `createDocuments` |
| Document instance API | 40 | 1,919 | `uuid` 200, `update` 184, `toObject` 131, `getRollData` 97, `isOwner` 65, flags 35, `fromUuid` 95 |
| Core hooks listened | 21 | 31 | `ready setup canvasReady renderChatMessageHTML renderCompendiumDirectory createItem updateItem hotbarDrop controlToken chatMessage updateWorldTime render*` |
| Application lifecycle members | 36 | 662 | `_prepareContext` 138, `_onClose` 64, `_initializeApplicationOptions` 56, `_onRender` 55, `_preparePartContext` 43, `_onChangeForm` 32, `_configureRenderParts` 22, `_onDrop` 20; V1 remnants `getData` 9 / `activateListeners` 9 / `_updateObject` 5 |
| Core Handlebars helpers used by templates | 9 | 1,927 | `localize` 1,408, `checked` 162, `selectOptions` 122, `disabled` 89, `numberFormat` 53, `formInput` 53, `formGroup` 37, `concat`, `radioBoxes` |
| Core CSS conventions in templates | — | — | `form-group` 294, `form-fields` 269, `flexrow` 143, `tabs` 125, `tab` 108, `item-list` 41, `flexcol` 44; **173 distinct Font Awesome classes** |
| Foundry prototype extensions | 12 | 102 | `Math.clamp` 35, `findSplice` 22, `Math.normalizeDegrees` 8, `partition` 7, `intersects` 6, `first` 5, `filterJoin` 5, `capitalize` 5, `equals` 4 |
| Class hierarchy | — | — | 20 `TypeDataModel` subclasses, 108 `prepare*Data` sites, 33 `HandlebarsApplicationMixin` subclasses, 7 document subclasses, 5 canvas subclasses (3 `DetectionMode`) |
| Pack entry size (YAML) | — | — | `basic-monsters` avg **34,626 B / max 93,927 B**; `monster-templates` avg 5,203; `spells` avg 1,944 / max 18,835 |

### 1.4 The other four (measured where a checkout exists)

- **SBC** — current 6.0.3 lives on GitLab (unreachable from this sandbox's shell): ≈ 80 script
  files (`Content/` 18, `Parsers/` 36, `Process/` 8, root 18), jest tests. The last GitHub
  release, **4.0.3 (Foundry v10, 2023)**: **7,151 LOC** in 9 files — `sbcParsers.js` 3,347,
  `sbcContent.js` 1,507, `sbcUtils.js` 942, `sbcConfig.js` 726; framework references are light
  (`game.settings` 33, jQuery 22, `Item.create` 14, `game.packs` 13, `ui.notifications` 5); it
  writes **90 distinct `system.*` paths** of pf1's actor/item schema. 6.0.3 adds ApplicationV2,
  S3 `FilePicker`, sockets and Babele hooks; treat it as 9–12 k LOC (estimate).
- **statblock-library** — 2 scripts (`welcome-screen.mjs`, `statblock-page.mjs`: one
  `JournalPageSheet` subclass, V1 API + jQuery + Handlebars) and ≈ 10,000 journal-page YAML files
  of ≈ 3.5 KB HTML each (≈ 35 MB raw, estimate from the sampled entry).
- **pf1e-archetypes** — a 16-line script; ≈ 7,500 YAML entries in 5 packs (repository page: 1,268 archetypes + 4,824 features + 119 prestige classes + 1,308 prestige features; the buffs pack uncounted).
- **pf-content** — 35 packs; `pf-content.js` is UUID redirects + source registration.

### 1.5 In-repo unit costs (measured; the calibration for every estimate below)

| Analogue | LOC | What it calibrates |
|---|---:|---|
| AIS v1 as shipped: kernel 614 + `ais*.ts` 1,243 + runtime source/package 291 + adapter 293 = **2,441** for 60 facade members + 16 RPC methods | 2,441 | **≈ 32 LOC per facade member / RPC method, all-in** |
| AIS v1 tests: 1,578 unit (7 files) + 662 e2e | 2,240 | tests ≈ **0.92 ×** product for runtime/facade code |
| Repository: `src` 178,751 vs `tests` 118,954 | — | tests ≈ **0.67 ×** product overall |
| `src/dice` (ArenaStar roll grammar + evaluator) | 924 | a roll engine for *one* grammar |
| `src/core/compendium*.ts` | 753 | a compendium store + index for 25k entries |
| `src/core/documents.ts` + `ops.ts` + `ownership.ts` + `permissions.ts` | 801 | document primitives of the typed model |
| `src/host` (authority, sync, persistence, 83 message handlers) | 13,823 | what owning a document model costs end to end |
| `src/ui/windows` | 466 | the window host |
| `src/ui/chat` | 1,870 | chat with cards and roll rows |
| `src/ui/settings` + `core/worldSettings.ts` | 2,615 | settings surface |
| Native PF1e: logic 27,094 + UI 16,155 = **43,249** | 43,249 | what the native route has cost so far |

---

## 2. (a) Space freed by moving native PF1e into the world zip

### 2.1 The ceiling

Remove every PF1e-named byte from the bundle: **732,893 B JS + ≈ 23,700 B CSS = ≈ 756.6 KB =
13.3 % of `index.html`** → file ≈ 4,942,300 B, headroom ≈ **1,349,000 B (1.29 MiB)** instead of
592,560 B. (Raw bytes; the gate is raw. gzip is irrelevant to the gate.)

### 2.2 What that ceiling costs, in tiers

| Tier | Bytes freed | What has to exist first | Why |
|---|---:|---|---|
| **T0 — strategic ruleset** `massBattlePf1e.ts` — **done in D-471, measured −50,252 B** (exclusive deps left with it) | 25,155 (est.) | Nothing new: the same code is already compiled to `systems/pf1e-mass-battles/rules.js` and loaded through `world.activeRulesPackage` (the §12 "supported path"). Cut three static imports (`host/turnChannel.ts`, `ui/armies/armyModel.ts`, `packages/pf1e/rulesEntry.ts`; `e2eHook.ts` already uses `import()`) and route them through the loaded package. | Shipped twice today. |
| **T1 — GM-only code** | 2,485 today; **≈ 51,500** if the import box in `SheetPanel.svelte` and the import tools in `agentBridge.ts` are gated to the GM shell (the 7 importer files, 49,003 B, are player-reachable only through those two) | Trusted-module tier (exists, `src/packages/trustedModule.ts`) + a host-side registry so `SheetPanel`/`agentBridge`/Settings resolve importers at runtime instead of importing them. ≈ 200–400 LOC. | Players never import statblocks. |
| **T2 — tactical logic needed by players** (`src/packages/pf1e` minus importers: 70 files, 348,022 B) | 348,022 | **(i)** a player-side package runtime — today zero: GM→player package transfer over the data channel, caching, consent/CSP, a `TrustedModuleHost` in `JoinApp`; **(ii)** a "tactical system package" contract replacing the **146 import edges / 183 symbols from 27 host files** (75 symbols in `host/sync.ts`) with a registry/dispatch interface; **(iii)** pure-data tables (`afflictions`, `conditions`, `maneuvers`, `poisonCatalogue`, `skills`, `feats`, `builder`, `spellPacks`, `rulesTables` ≈ 90 KB) could instead move to packs, but their consumers read them synchronously at import time, so they need an async-availability pass. | Everything the sheet, cast/resolve flows, combat state and conditions need runs in the player tab too. |
| **T3 — PF1e UI** (38 Svelte/TS files, 310,713 B + ≈ 24 KB CSS) | ≈ 334,000 | All of T2's prerequisites **plus** a UI-component package contract: compiled Svelte 5 components in a runtime-loaded package sharing the host's Svelte runtime (externalised `svelte/internal/client`), with `WindowHost` mounting foreign components. No such contract exists; AIS UI modules are CSS-token themes only (`AIS_UI_MODULES.md`). | The 82 KB actor sheet and the flows are Svelte. |
| **T4 — PF1e code inside shared host files** (`sync.ts`, `App.svelte`, `CombatPanel`, `quickbar`, `agentBridge`, `JoinApp`, `initiative`, `campaignCodexEconomy`) | **≈ 40–90 KB (estimate)** | The T2 dispatch interface is exactly this code; some of it stays as dispatch glue. Bounds: 3 % of `sync.ts` lines mention pf1e (≈ 8 KB) but the eight 500-line windows that hold 76 % of the mentions are 38 % of the file (≈ 95 KB upper bound); other files scaled the same way. | Not separable by attribution; it is the weld. |

**Net answer.** Free today with no new contract: **≈ 28 KB** (T0 + T1-as-is). With a GM-only gate
on importing: **≈ 77 KB**. The remaining **≈ 680 KB** is reachable only after a player-side package
runtime and a component package contract exist — which are themselves new main-file code — and the
dispatch interface that replaces 183 symbols is not free either.

### 2.3 What (b) or (c) would put back

The host-core part of either route (§3.2 H1–H5, §4.3) is **7.9–15.6 k LOC** that must be in the
main file (players need the store mirror, the projection and the UI hosting). At the measured
20.1 B/LOC that is **≈ 160–310 KB**. So:

- native PF1e stays and a foreign-system slot is added: **+160–310 KB against 579 KiB of
  headroom** — fits, barely, and leaves little for anything else;
- native PF1e moves out (full T0–T4) and the slot is added: **net −450 to −600 KB**.

For scale, the non-PF1e levers in the same file: `three` **581 KB** (3D dice; larger than all
PF1e logic), `e2eHook.ts` **74 KB** shipped in production, `core/agents/*` ≈ 100 KB, base64 fonts
211 KB (subsetting is on the ROADMAP).

---

## 3. (b) Making AIS, the adapter and the core able to *run* the five repositories

### 3.1 Architecture the numbers assume

1. **Trusted in-page tier, not the sandbox iframe.** The facade and pf1 run in the host page
   (`TrustedModuleHost` already installs `game/Hooks/canvas/ChatMessage/ui` globals before
   execution). Reason, measured: pf1 performs synchronous reads at **558 `i18n.localize`, 174
   `i18n.format`, 119 `settings.get`, 51 `user.isGM`** sites and reads documents synchronously
   everywhere; its actors average **35 KB and reach 94 KB** of YAML, against AIS limits of **64 KB
   per RPC, 120 requests/s, 30 commands/s, 16 KB per command**. A sandboxed variant needs a
   complete in-iframe document mirror plus a limits redesign — add **4–8 k LOC** and an unmeasured
   performance risk (derivation runs on every mirrored change).
2. **Two layers.** A **host core** (in `index.html`: the generic foreign-document store, native
   projection, UI/chat/combat hosting, packaging, player delivery) and a **runtime package** (in
   the world zip: the Foundry-framework-shaped facade — DataModel, Documents, Roll, Applications,
   `game`, `CONFIG`, canvas facade). Foundry's own client is proprietary, so the runtime is a
   clean-room re-implementation of the *API shape*, not of Foundry code; Handlebars (MIT), jQuery
   (MIT, for V1 sheets) and Font Awesome Free ship inside the package.
3. **Acceptance gate for free:** pf1's 24 Quench test files (21 `registerBatch` suites, 3,568 LOC)
   behind a ~150-LOC `quench` shim.

### 3.2 Host core — lines in the main file (estimate on measured surface)

| ID | Deliverable | Measured surface it serves | Analogue | Product LOC |
|---|---|---|---|---:|
| H1 | Foreign-document store: Actor (+ embedded Item, ActiveEffect), Item, ChatMessage, Combat/Combatant, Folder, Macro, RollTable, JournalEntry/Page, User; CRUD with pre/post hooks; ids/uuids; `-=` deletion keys; ownership mapping; world-file persistence; new protocol messages; client mirror | 342 CRUD sites, 40 document members / 1,919 uses, 13 document types | `documents+ops+ownership+permissions` 801 for the typed model; `host` 13,823 end to end | **3,000–5,500** |
| H2 | Native projection of foreign actors (HP/AC/initiative/size/vision/disposition) so tokens, tracker, targeting and bars keep working | `CONST.TOKEN_DISPOSITIONS` 14, tracker/`combat` 19, `tokens.controlled` 7 | `core/combat.ts` + combat UI 5,676 | **600–1,200** |
| H3 | UI hosting: HTML application windows in `WindowHost` (drag/resize/z/minimise, shadow-DOM CSS isolation); HTML chat cards + listeners + `renderChatMessageHTML`; combat hooks + foreign initiative provider; settings scopes/menus; directory/sidebar facades (`ui.actors/items/compendium`, three `get*ContextOptions` hooks, `renderCompendiumDirectory`); canvas hooks (control/target/template/token effects/`DetectionMode`) | 69 Applications, `ui.*` 146, 21 core hooks, `canvas.*` 144 | `ui/windows` 466, `ui/chat` 1,870, settings 2,615 | **2,100–4,500** |
| H4 | Packaging: raw pf1-schema packs served through the compendium store with `getIndex({fields})`/`getDocument`; multi-file trusted runtime (scripts + templates + lang + css + fonts as resources); limits (script ≤ 1 MiB, 8 MiB total) raised or a new package kind; integrity hashes; §16 review | 21 packs / 21.8 MB YAML; bundle 1.61 MB | `compendium*.ts` 753, `packageLoader` 149 | **700–1,400** |
| H5 | Player shell: GM→player package delivery (protocol, chunking, cache, consent, CSP), `TrustedModuleHost` in `JoinApp`, client mirror hookup | 0 today | AIS host side 2,441 | **1,500–3,000** |
| | **Host core subtotal** | | | **7,900–15,600** → **≈ 160–310 KB** in `index.html` |

### 3.3 Runtime package — lines in the world zip (estimate on measured surface)

| ID | Deliverable | Measured surface | Unit cost | Product LOC |
|---|---|---|---|---:|
| R1 | `foundry.utils` (25) + `Collection` + 12 prototype extensions + `CONST` (13 keys) | 663 + 102 + 71 uses | 20–40 LOC/fn | **700–1,200** |
| R2 | `DataModel`/`TypeDataModel` + 19 field types: initial/clean/validate/`updateSource`/`toObject`/`migrateData`/schema introspection/`-=` semantics; pf1's `FormulaField` extends `StringField` | 20 models, 991 field uses, 108 `prepare*Data` sites | 60–120 LOC/field + 600–1,000 base | **1,800–3,200** |
| R3 | `Document`/`ClientDocument` hierarchy (13 types) over H1: lifecycle order (`prepareBaseData → prepareEmbeddedDocuments → prepareDerivedData`), `_preCreate/_preUpdate/_onUpdate…` → hooks, `update()` dot-path diff, embedded collections, flags, `uuid`/`fromUuid(Sync)`, ownership tests, `sheet` getter, `getRollData`, `clone` | 40 members / 1,919 uses | 32 LOC/member (measured) × fidelity ×2–3 | **2,500–4,500** |
| R4 | `Hooks` (exists): 21 core events + document hook family + `render*` for apps | 31 listeners | — | **200–400** |
| R5 | `Roll`: Foundry grammar + term classes (`Die`, `NumericTerm`, `OperatorTerm`, `ParentheticalTerm`, `FunctionTerm`, `PoolTerm`), modifiers, `@data` resolution, `parse/fromTerms/simplifyTerms/safeEval/replaceFormulaData`, `evaluate` options, `toMessage`, tooltip, `toJSON/fromData`, `CONFIG.Dice.*` | pf1 subclasses `Roll`; `foundry.dice.terms` 38 uses; `RollPF` 85 | `src/dice` 924 × 2–3.5 | **1,800–3,200** |
| R6 | `ApplicationV2` + `HandlebarsApplicationMixin` (PARTS/TABS/actions/forms/drag-drop/position), `DocumentSheetV2`/`ActorSheetV2`/`ItemSheetV2`, `DialogV2`, V1 `Application`/`FormApplication`/`DocumentSheet` subset + jQuery wrapper (pf1's 23 V1 uses; statblock-library's sheet), `ux` (`FormDataExtended`, `ContextMenu`, `DragDrop`, `Tabs`, `SearchFilter`), `TextEditor.enrichHTML` with `@UUID @Compendium @Embed [[/roll]]`, `renderTemplate/loadTemplates`, 9 core helpers, ProseMirror substitute, core CSS conventions, Font Awesome | 36 lifecycle members / 662 uses, 185 templates / 66 partials, 1,927 helper uses, 173 icon classes | no analogue; by member list | **3,500–6,500** JS + **800–1,500** CSS |
| R7 | `game.*`: settings (register/get/set/registerMenu), i18n (lang JSON 2,819 keys), user/users, packs (`CompendiumCollection`), world collections, time ↔ `worldClock`, combat, socket → event bus, tooltip, clipboard, keyboard, modules, system, release | 71 member pairs / 1,216 uses | 32 LOC/member × 0.7–1.2 | **1,500–2,800** |
| R8 | `CONFIG` (21 roots / 60 paths) with host consumers for `documentClass`/`dataModels`/`sheetClasses`/`statusEffects`/`detectionModes`/`Dice` | 222 uses | — | **300–600** |
| R9 | `canvas.*` facade + placeable classes (`Token`, `MeasuredTemplate`, `TokenHUD`, `TokenRuler`, `DetectionMode`), `grid.measurePath/isHexagonal`, `dimensions.distancePixels`, `perception.update`, `geometry.Ray`, `stage.on/off` | 59 members / 144 uses, 5 subclasses | — | **1,500–3,000** (stub subset 400–800, losing templates/effects/vision) |
| R10 | `ChatMessage` behaviours: rolls, roll modes (whisper/blind/self), `renderChatMessageHTML`, `chatMessage` command hook, styles | `ChatMessage` 5 model subclasses, 7 `chat/` files | `ui/chat` 1,870 | **500–1,000** |
| R11 | `ui.notifications` (4) and directory objects, `AudioHelper`, `FilePicker` (SBC; S3 → storage stub), `Color`, `Semaphore`, `Draggable`, `DocumentSheetConfig.registerSheet`, `SortingHelpers` | 146 + misc | 32 LOC/member | **500–1,000** |
| | **Runtime subtotal** | | | **14,800–27,400** JS + 0.8–1.5 k CSS |

### 3.4 The other four, on top of pf1

| Repository | Extra beyond §3.2–3.3 | LOC |
|---|---|---:|
| pf-content | none (`pf1RegisterSources` is pf1's; `sbc.loadCustomCompendiums` fires into nothing if SBC is absent) | 0 |
| pf1e-archetypes | none | 0 |
| pf1-statblock-library | custom `JournalEntryPage` type registration (`CONFIG.JournalEntryPage.dataModels`), V1 `JournalPageSheet` path if R6's V1 subset is minimal, jQuery bundled | **300–700** |
| SBC | `renderActorDirectory` must render real DOM for its button injection; `FilePicker` S3 stub; `Folder.create`; `game.socket` relay; `getIndex({fields})` with pf1 index fields; `String.prototype.capitalize`; Babele / Roll Bonuses hooks (skip) | **400–1,000** |

### 3.5 Total (b)

| | Product LOC | Tests (0.67–0.92 ×) | Total |
|---|---:|---:|---:|
| Host core (main file) | 7,900–15,600 | 5,300–14,400 | 13,200–30,000 |
| Runtime package (world zip) | 14,800–27,400 (+ CSS) | 9,900–25,200 | 24,700–52,600 |
| Four more repositories | 700–1,700 | 500–1,600 | 1,200–3,300 |
| **All** | **23,400–44,700** | **15,700–41,200** | **≈ 39,000–86,000** |

Sandbox-iframe variant: add 4–8 k product (+ tests) and a limits redesign.

**What the number does not include:** performance work (pf1 re-derives whole actors on change;
10k-statblock worlds), the §16 security review of a trusted multi-megabyte guest, clean-room
discipline for the CSS/forms conventions, Paizo CUP decisions for icons/statblocks, and the
GPLv3 question for a runtime-loaded guest (a plugin / combined-work question this document does
not settle). For scale: all of AIS v1 to date is 2,441 product LOC; the native PF1e is 43,249.

---

## 4. (c) Reworking the modules to run on ArenaStar, reusing their code

### 4.1 Method

The coupling-density histogram (§1.3) is the basis: near-pure code ports verbatim behind thin
shims; framework-bound code has its glue rewritten and its rule bodies kept; UI keeps its
Handlebars templates behind a minimal application shim rather than being rewritten in Svelte
(the owner's constraint: reuse their code). Edit fractions are per-tier estimates; the LOC they
apply to are measured.

### 4.2 pf1 — per area

| Area | LOC | refs/100 | Strategy | Lines touched | New shim/glue |
|---|---:|---:|---|---:|---:|
| `config.mjs`, `const.mjs`, `registries.mjs` | 3,743 | 0.1 | verbatim | ≤ 75 (≤ 2 %) | — |
| `registry/` (sources 3,567, materials 1,163, conditions 802, skill actions 626 …); `RegistryEntry` ×10 extend a DataModel, `Registry` extends `Collection` | 6,752 | 0.8 | verbatim on utils + Collection + DataModel shims | 200–340 (3–5 %) | counted below |
| `models/` (69 files; 991 field declarations) | 12,803 | 6.5 | verbatim on a fields/DataModel shim; edit i18n/CONFIG/utils sites | 640–1,280 (5–10 %) | DataModel shim **1,800–3,200** |
| `utils/` (`apply-changes` 699 @ 0.3) | 3,208 | 7.0 | mostly verbatim; edit dialog/ui bits | 320–640 (10–20 %) | utils shim **500–900** |
| `documents/` (actor 2,561, item 1,631) | 5,185 | 10.7 | keep `prepare*`, roll data, change application; rewrite lifecycle/CRUD glue onto the ArenaStar store | 1,560–2,590 (30–50 %) | Document-lite **1,500–3,000** |
| `components/` (action-use 1,427) | 1,965 | 12.0 | keep attack/damage maths; rewrite chat/template/target glue | 690–1,080 (35–55 %) | — |
| `dice/` | 717 | 12.4 | re-implement `RollPF`/`d20roll`/`damage-roll` on ArenaStar dice **or** keep behind a Roll-lite shim | 430–645 (60–90 %) | Roll-lite **800–1,500** (if kept) |
| `chat/` (text-enrichers 1,070) | 1,382 | 12.7 | enrichers → native enricher hooks; cards → HTML cards | 550–830 (40–60 %) | — |
| `canvas/` | 1,509 | 14.6 | rewrite against the ArenaStar canvas (or drop templates/vision/HUD initially) | 900–1,360 (60–90 %) | — |
| `applications/` (160 files, 185 templates, 66 partials) | 20,770 | 7.5 | keep templates; Application-lite shim; edit each app's lifecycle/DOM glue | 3,100–5,200 (15–25 %) | App shim + 9 helpers + CSS **2,000–3,500** |
| bootstrap: `pf1.mjs`, `settings.mjs`, `socket`, `hotbar`, `compendium-directory`, `calendar`, `pre-localization`, `patch-core`, `modules` | 1,718 | 21–100 | rewrite for the ArenaStar package lifecycle | 1,030–1,550 (60–90 %) | `game`/`CONFIG`/i18n/settings/Hooks glue **800–1,500** |
| `migration.mjs` + `migration/` | 2,449 | 10.4 | **drop** (Foundry-version data migrations) | 0 | — |
| `tours/`, `hmr`, `dev-mode` | 300 | — | drop | 0 | — |
| `test/` (24 Quench files) | 3,568 | 6.4 | convert to vitest as the acceptance suite | 710–1,430 (20–40 %) | quench shim 100–200 |
| **Totals** | **62,573 + 3,568** | | | **10,100–16,900 modified (16–27 %)**, ≈ 2,750 dropped | **7,000–13,000 new** |

### 4.3 Host side for (c)

The same slot as §3.2 is still required — the module has to store pf1-shaped actors somewhere,
project them to tokens and the tracker, open its sheets in windows, ship its packs, and reach the
player tab. Only the *fidelity* burden is gone (the module calls ArenaStar-shaped APIs directly, so
the store need not emulate Foundry's diff/`-=`/hook order precisely): **7,000–14,000 LOC**
(≈ 140–280 KB in the main file).

### 4.4 The other four under (c)

| Repository | Work | LOC |
|---|---|---:|
| SBC (MIT) | parsers/content tables port near-verbatim (framework refs: `settings` 33, jQuery 22, `Item.create` 14, `packs` 13 at 4.0.3); UI modal, settings, `FilePicker`, socket rewritten. **If the ported pf1 keeps its schema:** 10–20 % of 7.2 k (4.0.3) / 9–12 k (6.0.3). **If it must write ArenaStar actors:** the 8 `Process/*-data.js` writers (90 `system.*` paths) are rewritten, 30–40 % | 700–2,400 / 2,700–4,800 |
| statblock-library (GPLv3) | sheet ≈ 200 LOC trivial; data needs a journal-page type or conversion to actors through `importStatblock()` (D-267) | 200–500 |
| pf1e-archetypes, pf-content | zero code; data in pf1's schema loads through the (c) pf1 packs path | 0 |

### 4.5 Total (c) and its standing costs

| | LOC |
|---|---:|
| pf1 lines modified | 10,100–16,900 |
| new shims/glue inside the module | 7,000–13,000 |
| host-core slot | 7,000–14,000 |
| SBC + statblock-library | 900–5,300 |
| **Product** | **25,000–49,000** |
| Tests (converted Quench 3.6 k + new at 0.5–0.8 ×) | 14,000–40,000 |

Standing costs that (b) does not have: a **GPLv3 fork** (the port is a derivative work; INVENTORY
row 2's clean-room rule would be superseded by an explicit decision) diverged on 16–27 % of its
lines, against an upstream that shipped **12 releases in 13 months**; every upstream fix in
`documents/`, `applications/` or the bootstrap lands on rewritten code. Costs that (b) has and
(c) does not: nothing is usable until the framework is near-complete (pf1's `init` touches every
family), whereas (c) can ship the rules core (`models` + `documents` + `utils` + `registry`,
≈ 28 k LOC at ≤ 10 % edits) before any sheet exists.

---

## 5. Side by side

| | (b) run upstream under a Foundry-shaped runtime | (c) rework the modules | native continuation (reference) |
|---|---:|---:|---:|
| Product LOC | 23–45 k | 25–49 k | spent so far: 43.2 k; L01–L07 open, unsized |
| Of which in the main file | 8–16 k (≈ 160–310 KB) | 7–14 k (≈ 140–280 KB) | all of it (757 KB today) |
| Tests | 16–41 k | 14–40 k | 0.67 × |
| First usable milestone | late (framework must be near-complete) | early (rules core first) | continuous |
| Upstream tracking | unchanged upstream; version-pinned certification | fork, 12 releases/13 months | n/a |
| Licence posture | runtime-loaded GPLv3 guest (plugin question) | GPLv3 derivative module (fork) | clean-room |
| Ecosystem | all pf1-schema modules load | pf1-schema *data* loads; code modules need their own port | converter route |
| Acceptance | pf1's 21 Quench batches | converted Quench batches | SRD-tagged tests |

---

## 6. Uncertainty, and the spike that collapses it

The ranges are ±40–50 % because the two biggest items — R6 (Applications) in (b), and
`documents/` + `applications/` edit fractions in (c) — have no in-repo analogue. One spike sizes
both: **port pf1's `test/actor-basics.test.mjs` (plus `actor-utils.mjs`) to vitest, stub the
framework until it passes, and count the stub.** `actor-basics` exercises `createTestActor`,
compendium item grants, `getRollData`, sheet rendering and initiative — i.e. R2, R3, R5, R7 and a
corner of R6. The count of stub lines per passing assertion is the missing unit cost; a week of
work replaces half the estimates above with measurements. Second cheapest: build the T1 gate
(§2.2) and measure the real byte delta with `tools/analysis/bundleAttribution.mjs`.

---

## Appendix A — PF1e-named files in the bundle (bytes, top 30 of 118)

| Bytes | File | Bytes | File |
|---:|---|---:|---|
| 82,670 | `ui/sheets/PF1eActorSheet.svelte` | 10,567 | `ui/sheets/PF1eItemsTab.svelte` |
| 47,183 | `ui/sheets/pf1eCastFlow.ts` | 10,449 | `packages/pf1e/combatState.ts` |
| 30,801 | `packages/pf1e/afflictions.ts` | 10,008 | `ui/sheets/pf1eEffectEditorModel.ts` |
| 26,296 | `packages/pf1e/actor.ts` | 9,591 | `ui/sheets/PF1eItemWindow.svelte` |
| 25,155 | `packages/massBattlePf1e.ts` | 9,528 | `packages/pf1e/import/foundry.ts` |
| 22,827 | `ui/sheets/pf1eResolveFlow.ts` | 9,289 | `ui/sheets/pf1eSheetModel.ts` |
| 17,495 | `packages/pf1e/import/statblock.ts` | 9,085 | `packages/pf1e/import/herolab.ts` |
| 15,265 | `packages/pf1e/maneuvers.ts` | 8,997 | `ui/combat/pf1eAidFeintFlow.ts` |
| 14,194 | `ui/sheets/PF1eCharacterBuilderModal.svelte` | 8,801 | `packages/pf1e/inventory.ts` |
| 13,146 | `ui/combat/pf1eManeuverFlow.ts` | 8,784 | `packages/pf1e/effects.ts` |
| 12,917 | `packages/pf1e/conditions.ts` | 8,343 | `packages/pf1e/pendingRoll.ts` |
| 12,449 | `packages/pf1e/schema.ts` | 7,980 | `packages/pf1e/resolve.ts` |
| 10,609 | `packages/pf1e/actions.ts` | 7,867 | `packages/pf1e/concentration.ts` |
| 7,379 | `packages/pf1e/import/roll20.ts` | 7,080 | `ui/combat/pf1eAooFlow.ts` |
| 6,817 | `ui/sheets/PF1eEffectEditor.svelte` | 6,772 | `ui/sheets/pf1eItemsTab.ts` |

## Appendix B — pf1 runtime payload if shipped in a world zip

| Component | Bytes | Note |
|---|---:|---|
| `pf1.min.js` (Vite lib build, `fuzzysort` external) | 1,606,325 | exceeds the AIS script cap (1 MiB) |
| templates (185 `.hbs`) | 582,401 | or pre-compiled at package build |
| stylesheets | 297,710 | assumes Foundry core CSS conventions (R6) |
| `lang/en.json` | 144,642 | 2,819 keys |
| Handlebars + jQuery + Font Awesome Free (webfont + css) | ≈ 270,000–380,000 | MIT / MIT / OFL+CC-BY+MIT |
| **Runtime total** | **≈ 2.9–3.0 MB raw** | ≈ 0.7 MB zipped; AIS total cap is 8 MiB |
| packs (21, YAML) | 21,818,121 | content-package route, not the runtime |
| icons (1,764) | 69,895,573 | Paizo CUP; optional |

## Appendix C — Reproduce

```sh
# (a) byte attribution + coupling
corepack pnpm exec vite build --config tools/analysis/vite.attribution.config.ts
node tools/analysis/bundleAttribution.mjs --top 20      # writes dist/analyze/attribution.json
node tools/analysis/pf1eCoupling.mjs                     # host↔PF1e edges, shell reachability

# (b)/(c) Foundry framework surface and coupling density of a Foundry package
git clone --filter=blob:none --no-checkout https://github.com/gabrieldosprazeres/foundryvtt-pathfinder1 /tmp/pf1mirror
git -C /tmp/pf1mirror sparse-checkout set module public lang css && git -C /tmp/pf1mirror checkout 681929d1
node tools/analysis/foundryApiInventory.mjs --dir /tmp/pf1mirror/module --exclude test
```

LOC throughout = non-blank, non-comment lines. Bundle bytes = minified bytes of the production
chunk attributed through its source map. In-repo LOC figures: `src` 178,751, `tests` 118,954,
`src/packages/pf1e` 27,094, PF1e UI 16,155, AIS v1 2,441 product / 2,240 tests.
