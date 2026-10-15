# Five PF1e Foundry repositories vs. ArenaStar's AIS + adapter — readiness and gaps

**Date:** 2026-10-14 · **Scope:** a feasibility slice, not a compatibility certification (proposal §10
defines what "compatible" would mean; nothing here reaches that bar). Companion documents:
`FOUNDRY_AIS_ADAPTER_PROPOSAL.md` (§7.4 systems, §9 phases P0–P6, §10 verification),
`AUTOMATION_INTERCONNECT_DESIGN.md` (§15–§16), `AIS_FOUNDRY_FEASIBILITY.md` (what D-462 actually
loads), `tools/adopt/INVENTORY.md` (licence facts, rows 1–3 and 16–18), `tools/convert/README.md`
(the data route).

The five repositories the question named:

| # | Repository | Pinned at (this reading) | What it actually is |
|---|---|---|---|
| 1 | `gitlab.com/foundryvtt_pathfinder1e/foundryvtt-pathfinder1` | master `2e5f71ad` (2026-10-14); code read from the GitHub mirror `gabrieldosprazeres/foundryvtt-pathfinder1@681929d1` already pinned in `tools/content/sources.json` | The **pf1 game system** (`system.json`, id `pf1`, version **11.11**, Foundry **14.361+** at master) — not a module |
| 2 | `gitlab.com/foundryvtt_pathfinder1e/pf1-content` | main `c66bf333`, module **11.4.0** (Foundry 12–13, pf1 ≥ 11) | A **content module**: 35 compendium packs, one 300-line entry script |
| 3 | `gitlab.com/Tryss_Farron/pf1e-archetypes` | main `92ddcb60`, module **11.0.1** (Foundry 12, pf1 ≥ 11) | A **content module**: 5 packs (1,268 archetypes, 4,824 archetype features, 119 prestige classes, 1,308 prestige features, buffs), a 16-line entry script |
| 4 | `gitlab.com/foundryvtt_pathfinder1e/pf1-statblock-library` | main `8e97cbde`, module **0.8.0** (Foundry 11–13, pf1 9–11, requires #5) | A **content module**: ≈10,000 statblocks as HTML `JournalEntry` pages in ≈48 packs, plus one custom page sheet with an *Import* button |
| 5 | `gitlab.com/foundryvtt_pathfinder1e/pf1-statblock-converter` ("SBC") | master `d9f4d1ac`, module **6.0.3** (Foundry 12–13, pf1 11–11.9, `socket: true`) | A **code module**: text statblock → pf1 `Actor` with embedded Items, through a Handlebars `ApplicationV2`, compendium fuzzy-matching, settings, sockets and file storage |

## 0. Verdict in one table

Readiness scale used throughout: **A** = the upstream code runs unchanged under the AIS adapter
(proposal §10 "verified unchanged-code subset"); **B** = runs with a bounded new adapter profile or
recipe; **C** = the *data* is usable through the converter, no upstream code runs; **D** = the
*behaviour* is re-implemented natively (clean-room / licence-compatible transcription); **E** = the
upstream *code* is not a candidate for the adapter — it will not run as an AIS guest, by design of
the adapter. **E says nothing about the value of the repository**; that is rated in the next column.

> **Terminology.** "pf1 system" below always means the *Foundry VTT package* `pf1` — the
> JavaScript implementation of Pathfinder 1e for Foundry. It never means Pathfinder 1e the game.
> PF1e is ArenaStar's native base system (`src/packages/pf1e`, 79 files / 36 k LOC, plus sheets,
> combat, builder, 188 unit-test files and 72 e2e specs) — **with partial depth**: the repo's own
> backlog leaves class progression/feature automation, broader class and feat mechanics, the full
> spell catalog with metamagic, non-combat skills and crafting/pricing open (`PF1e_Unified_TODO.md`
> L01–L07). Foundry's `pf1` package has all of that and a decade of polish; the question is not
> whether it has something to offer (it has a great deal) but **in what form it can be received**:
> by *running* its code under the adapter (§3.1a sizes that), by using it as a *test oracle*, or by
> consuming its *data*, which carries most of its mechanics (`changes[]`, `actions[]`, class
> associations). The E in row 1 answers only the first form, and only for the adapter *as proposed*.

| # | Repo | AIS/adapter today | Best route | Already in place | What is lacking (summary; detail in §3–§4) |
|---|---|---|---|---|---|
| 1 | pf1 system (Foundry's `pf1` *code package*) | **E** for the code *under the adapter as proposed* — P0–P6 never reach system execution (proposal §7.4/§9); the package is written against Foundry **core** (125 distinct `foundry.*` APIs, see §3.1a), not against a hook facade. Making it a target is a Foundry-core-compatible runtime: a separate project the owner can open, sized in §3.1a | **C** for packs + **D** for rules (INVENTORY row 2, clean-room T1–T6) | 13 of 24 system packs converted (D-253); the native PF1e sheet/rules exist in-repo | 11 system packs not converted (incl. `class-abilities`, 4,710 entries — the largest pack); no plan to run 103 k LOC of GPLv3 system code, and none should be made |
| 2 | pf1-content | **E** for the script (it only redirects UUIDs and registers sources with the pf1 registry); irrelevant to the value | **C** | 15 packs converted from a **2023 pin** (`baileymh/pf1e-content@baf5232c`) | 21 of today's 35 packs never converted; upstream layout/renames drifted since the pin; actors arrive without their embedded items |
| 3 | pf1e-archetypes | **E** for the script (SBC integration only) | **C**, then a product decision on archetype UX (**D**) | Nothing — not pinned, not converted | New source + YAML walker; `@Embed` enricher reduction; `links.supplements` consumer; archetype/prestige affordance in the builder |
| 4 | statblock-library | **E** for the sheet (a `JournalPageSheet` subclass + `DocumentSheetConfig.registerSheet` + jQuery + SBC's `api.openSBCDialog`); none of that exists in the adapter | **C** for the text + **D** for the one feature (Import) — the native `importStatblock()` (D-267) already exists | The journal mapper, the compendium reader (proven at 25,376 entries, D-266), the native statblock reader | New source; `.yml` walker; custom page subtype rule; an "Import as actor" action behind the compendium reader; opt-in packaging (size), licence posture (Paizo CUP) |
| 5 | SBC | **E/B-far** — needs documents, compendia, settings, DOM apps, sockets, file storage, multi-module hooks and the pf1 data model: proposal phases **P3–P6**, none started | **D** — extend the native importer; use SBC's **MIT** parsers/fixtures as the oracle | `src/packages/pf1e/import/statblock.ts` (992 LOC) + `foundry.ts` (614 LOC) + import front door (D-264/D-267) | Compendium entity linking (feats/spells/gear/class levels), spell lists & SLAs, skills, gear → inventory, templates, art, error-highlighting UI; conformance corpus |

**Bottom line.** Four of the five are *content*; the AIS adapter is the wrong tool for them and
no adapter work would make them more useful. The fifth (SBC) cannot run under AIS in the
foreseeable future because its output is a *pf1-system actor*, which ArenaStar does not host and
will not emulate. The practical investments are therefore (i) the converter — new sources, the
missing packs, actor items, enrichers; (ii) the native importer — parity with SBC's parsing
knowledge; (iii) one small product affordance (statblock journal → actor). AIS/adapter gaps are
recorded in §4.1 so that a future "content-aware guest" profile has a concrete specification, but
nothing in these five repositories justifies building that profile now.

## 1. Method and what was not done

- Read via GitLab raw/tree pages: each repo's README, `module.json`/`system.json`, entry scripts
  (`pf-content.js`, `pf-archetypes.js`, `scripts/welcome-screen.mjs` + `scripts/statblock-page.mjs`,
  `scripts/sbc.mjs` + `sbcInput.js` + `sbcCompendium.js` + `sbcParser.js`), one source entry per
  data repo (an archetype YAML, a statblock YAML), the system's `docs/other/MODULE_DEV.md`, and the
  LICENSE files. The pf1 system code was inventoried from the pinned GitHub mirror with a sparse
  checkout of `module/`, `public/`, `docs/`, `tools/` (`git clone --filter=blob:none`).
- Compared against the AIS surface as it exists on `main` (D-460…D-463): the kernel's 17
  capabilities, the bridge's 16 RPC methods, the adapter profile `foundry-v13-scene-tags-fx`, the
  package limits, and the data pipeline (`tools/content`, `tools/convert`, `scripts/buildContentPackage.mjs`).
- **Not done:** no module was executed anywhere (there is no licensed Foundry reference build in
  this environment — proposal P0's own gate); no converter run against the three new repos (no
  pins exist yet; GitLab is not reachable from the sandbox's build shell, only from the page
  fetcher); no size/memory measurement of a hypothetical statblock package. Every number below is
  from files read, not from a run. Where a statement would require a run it is marked **verify**.

## 2. The ArenaStar surface the assessment is made against

Facts, with the file that proves each (unchanged since the AIS state report):

- **Kernel** `src/core/automationInterconnect.ts`: capabilities `scene.read.visible`, `action.observe`,
  `module.storage.read/write`, `chat.post`, `ui.notify`, `ui.interaction`, `event.emit`,
  `actor.inventory.read/consume`, `scene.token.light.manage`, `scene.tags.read/write`, `fx.play`,
  `runtime.execute`, `package.resources.read`, `ui.theme`. **No** capability names a compendium, a
  document collection, actor/item creation, settings, files or sockets.
- **Bridge/services** `src/packages/aisModuleIframe.ts` + `aisModuleHandlers.ts`: the method/
  capability vocabulary is `chat.post`, `fx.list/play/stop`, `module.event`, `module.storage.*`, `scene.read.visible`,
  `scene.tags.*`, `scene.token.light.*`. The **only write paths** are token light (+ item consume),
  scene tags, chat and module storage.
- **Adapter** `modules/ais-foundry-v13/runtime/adapter.js` (307 LOC, profile
  `foundry-v13-scene-tags-fx`): provides `Hooks`, a frozen `game` (`version "13"`, `user`,
  `modules` = the guest itself + a `sequencer` substitute, `scenes.get` for the active scene only,
  `keybindings.register` recorded not dispatched), `canvas.scene/tokens`, `foundry.utils`
  (`getProperty/setProperty/mergeObject/isNewerVersion/deepClone/randomID`), `CONST` (one key),
  `Sequence`/`Sequencer` over native FX. It **throws** on `game.actors`, `game.settings.*`,
  `Dialog`, `$`, `Actor`, `canvas.app`, all-scene iteration, and any document field other than
  tags. There is no `CONFIG`, no `game.packs`, no `fromUuid`, no `Application`, no `renderTemplate`,
  no `ui.notifications`, no `game.socket`, no `FilePicker`, no `pf1` namespace.
- **Guest loading**: a single IIFE rebundle produced by `scripts/buildAisDemo.mjs`; packages carry
  text resources only (scripts ≤ 1 MiB, UTF-8 resources ≤ 2 MiB/file, 8 MiB total; no binary, no
  VFS, no ES-module graph loader). GM tab and, since D-468, player shells: the host delivers the
  GM-approved shared set (`ais.profile`), each player consents per device and hash, and the same
  kernel handlers run over the player's replica with ownership as the only authority.
- **Data route**: `tools/content/sources.json` (two GitHub mirrors, exact commits, data-only usage)
  → `pnpm content:fetch` → `tools/convert/index.mjs` (28 packs: 13 pf1-system YAML + 15
  pf1e-content JSON; mappers for spell/feat/class/item/actor/roll table/journal; drop policy:
  `_id/_key/_stats`, `img`, `flags`, `items[]`/`effects[]`, `scriptCalls`) → `dist/content/pf1e`
  (25,376 entries, D-253) → `scripts/buildContentPackage.mjs` zip → Settings → *Strategic ruleset &
  content* import; the compendium reader is virtualised and indexed (D-266). Compendia are read on
  the **host** (`CompendiaPanel` takes `HostPackages`; `JoinApp` has none).
- **Native importers** (`src/packages/pf1e/import/`): Foundry PF1e actor JSON (`foundry.ts`, 614 LOC,
  maps embedded items), Hero Lab XML, Roll20 JSON, and pasted **statblock text** (`statblock.ts`,
  992 LOC, label-based clause reader; D-267) behind one front door (`index.ts`).

## 3. Per-repository analysis

### 3.1 `foundryvtt-pathfinder1` — Foundry's `pf1` package (the Foundry implementation of PF1e)

**Identity.** `public/system.json`: id `pf1`, version 11.11, `compatibility.minimum 14.361`
(mirror) / `14.368` (master), `maximum 14`; `esmodules: ["pf1.mjs"]`; `socket: true`; `grid`
5 ft; 24 packs (Actor, Item, ActiveEffect, Macro, RollTable, JournalEntry); `documentTypes`:
Actor `character|npc|vehicle|haunt|trap`, Item `class|race|feat|attack|spell|weapon|equipment|
implant|consumable|loot|container|buff|ammo|skill|spellcasting`, ActiveEffect `buff`, ChatMessage
`check|item|action|damage`. `relationships.recommends` names repos 2, 4 and 5 — the five are one
ecosystem. Licence: **GPLv3** (`LICENSE.txt`) for code, **OGL 1.0a** (`OGL.txt`) for content,
Paizo Community Use Policy (README). INVENTORY rows 2–3, `legalStatus: pending`.

**Footprint (mirror `681929d1`, `module/`).** 358 JS files, **102,928 LOC**. Emits **49**
system hooks (`pf1PreAttackRoll`, `pf1ApplyDamage`, `pf1PrepareDerivedActorData`,
`pf1RegisterSources`, …), listens to ~20 core hooks; **51** `game.settings.register` calls;
**69** Application/sheet classes; document subclasses `ActorPF`, `ItemPF`, `ChatMessagePF`,
`CombatPF`, `CombatantPF`, `TokenDocumentPF`, `ActiveEffectPF`; canvas subclasses `TokenPF`,
`MeasuredTemplatePF`, `TemplateLayerPF`, `TokenHUDPF`, `TokenRulerPF`; ≥ 10 `DataModel`s;
`game.socket` emit ×3 / on ×1; no libWrapper/socketlib. It replaces `CONFIG.ui.chat/actors/
items/combat` and `CONFIG.Item.collection` at init. Packs are authored as **11,315 YAML files**
(`class-abilities` 4,710, `spells` 3,037, `items` 1,124, `weapons-and-ammo` 508, `feats` 390,
`technology` 289, `ultimate-equipment` 269, `template-abilities` 239, `buffs` 207,
`monster-templates` 198, `races` 82, `armors-and-shields` 75, `monster-abilities` 49, `classes`
49, `roll-tables` 24, `basic-monsters` 15, `racial-hd` 13, `companion-features` 11, `rules` 10,
`macros` 9, `mythic-paths` 6) and compiled to LevelDB by its Vite build.

**AIS/adapter today: E — for the code under the adapter as proposed, not for PF1e.** PF1e is
ArenaStar's base system, implemented natively with the depth gaps listed in §0's terminology note.
What the adapter cannot do, in any phase the proposal describes, is load Foundry's `pf1.mjs` and
its 358 files as a *guest* and let it provide the rules. Everything that package is — document
data models, derived-data preparation, 69 applications, canvas subclasses, settings, sockets, chat
message types — is on the adapter's explicit "unsupported" list, and the proposal (§7.4) scopes it
out (scopes, not forbids — the owner decides whether to open that project; §3.1a gives the numbers): "Full Foundry system
execution is a separate project and not proposed here." Nothing changes that verdict; a system is
also the one thing that could not be loaded as a *guest* of an adapter that pretends to be its
host. The system additionally targets Foundry **v14** APIs at master (`foundry.canvas.placeables.*`,
`renderChatMessageHTML`), while the adapter profile is a v13 subset.

**What is in place.** 13 packs converted (stage 1a). The native PF1e sheet, derivation
(`derivePF1eActor`), skills/builder (D-254), inventory (D-259), conditions and combat are the
project's own clean-room implementation — INVENTORY row 2's transfer approach already decided
"logic via clean-room transcription", not transfer.

**Lacking (data route).** `class-abilities` (4,710 — the single largest pack in the ecosystem and
the one the builder's class-feature lists would want), `monster-templates` (198),
`template-abilities` (239), `monster-abilities` (49), `racial-hd` (13), `companion-features` (11),
`mythic-paths` (6), `skills-core/background/consolidated`, `effects` (an ActiveEffect pack — no
target collection exists), `macros` (dropped by policy, correctly). See C-03.

**Useful by-product.** The 49-hook taxonomy is the best available reference for the *names and
stages* of PF1 action events if AIS ever grows the P6 "PF1 action/effect/roll services"
(`pf1PreActorRollSave` → `pf1ActorRollSave`, `pf1PreAttackRoll` → `pf1AttackRoll`,
`pf1PreDamageRoll`, `pf1ApplyDamage`, `pf1ToggleActorBuff/Condition`, `pf1ActorRest`). Reading hook
names is not code transfer.

### 3.1a If the `pf1` package were made the adapter's target — what that costs, measured

> The line-count and byte answers (main-file space, LOC for a runtime, LOC for a module
> rework) are in `PF1E_FOUNDRY_PORT_COST_ANALYSIS.md`; this section keeps the surface inventory.

The proposal calls full system execution "a separate project". That is a scoping statement, not
a prohibition, so here is the project's size from the mirror (`681929d1`, `module/` only), so the
decision can be taken on numbers:

| What `pf1` is written against | Distinct uses in `module/` | What the adapter has today |
|---|---:|---|
| `foundry.<namespace>.<Class>` (abstract DataModel/TypeDataModel, documents, applications.api, applications.handlebars, applications.ux, dice.terms, canvas.*, helpers) | **125** | — |
| `foundry.utils.*` helpers | 26 | 6 |
| `foundry.data.fields.*` field types (schemas for 20 `TypeDataModel` subclasses; 108 `prepare*Data` sites) | 19 | — |
| `game.*` services (`i18n settings user packs system time items combat users scenes actors tooltip messages dice clipboard socket …`) | 25 | `modules`, `scenes.get` (active only), `keybindings.register` (recorded) |
| `CONFIG.*` registries | 21 | — |
| `canvas.*` members (placeables, perception, `DetectionMode` subclasses) | 30 | — |
| `ui.*` | 9 | — |
| Handlebars templates / `HandlebarsApplicationMixin` subclasses | 185 / 33 | — (AIS UI is CSS-token theming) |
| Roll engine (`RollPF`, `d20roll`, `damage-roll`, custom terms + functions over `foundry.dice.terms`) | 1 subsystem | native dice only, no Foundry `Roll` |
| Document CRUD (`create/update/deleteDocuments`, `…EmbeddedDocuments`) — socket-backed DB writes | 50 sites | none (AIS has no document writes) |
| Source size | 4.4 MB `module/` + 1.1 MB templates | app budget: 6 MiB total, 579 KiB headroom |

**Who provides what** (the layering, stated precisely, because the first draft of this section
blurred it):

| Layer | Provides | Knows PF1e? |
|---|---|---|
| Foundry **core** (proprietary client + server) | The generic framework: `Document` classes and CRUD/embedded/lifecycle semantics, `DataModel` + field types, `Roll` and dice terms, `ApplicationV2` + Handlebars + core helpers, compendium collections, settings, i18n, sockets, canvas placeables, `Hooks`, `CONFIG`/`CONST` registries | **No.** Nothing PF1e-specific lives here |
| **`pf1` system** | *All* of PF1e: 20 `TypeDataModel` schemas (actor/item/spellbook/attack…), the rules engine (108 `prepare*Data` sites: BAB, saves, AC composition, CMB/CMD, skills, `changes` stacking by bonus type, size, encumbrance, spell slots), `actions`, buffs/conditions, `RollPF`/`d20roll`/`damage-roll`, 69 sheets and dialogs, 185 templates, chat cards, registries, and its own 24 packs | **Yes — all of it** |
| `pf-content`, `pf1e-archetypes`, `pf1-statblock-library` | More data in `pf1`'s schema (plus one journal sheet) | Data only |
| SBC | A tool that produces `pf1` actors from text | Writes `pf1`'s schema |

Three consequences follow, independent of any document's opinion:

1. **What has to be built is Foundry's *framework*, not PF1e.** `pf1` *is* the PF1e rules engine —
   but it is written against Foundry core's framework APIs (the 125 `foundry.*` uses above, ~21
   core hooks: `init setup ready canvasReady renderChatMessageHTML createItem updateItem hotbarDrop
   controlToken chatMessage updateWorldTime render*…`), and Foundry's client is proprietary and
   cannot be embedded. So "run `pf1`" = a clean-room, Foundry-framework-compatible runtime. Because
   Foundry core is generic VTT plumbing, part of that runtime is a **facade over plumbing ArenaStar
   already has** — `Hooks` (adapter), settings storage, i18n, the compendium reader (entries are
   already free-form `data: Record<string, unknown>`, `src/core/compendium.ts:51`), chat, combat
   tracker, the window host, dice evaluation, scenes/tokens, persistence and replication,
   permissions — and part is **genuinely new and must match Foundry's semantics exactly**, because
   `pf1` is written against them: the `DataModel`/fields framework (19 field types, 20 models); the
   `Document` class hierarchy with CRUD, embedded collections and lifecycle, over a **generic
   system-owned document store** (ArenaStar has no slot where a plugin defines actor schemas — its
   native `RulesModule` contract in `src/core/rules.ts` is the strategic-sim one,
   `validateOrder/resolveTurn/tick/detection`, and tactical PF1e is hard-wired host code); the
   Foundry `Roll` class hierarchy and grammar (`pf1` subclasses the terms); `ApplicationV2` +
   Handlebars with the core helpers its templates use (`localize` ×1,411, `checked`,
   `selectOptions`, `disabled`, `numberFormat`, `formInput`, `formGroup`), form binding and
   `TextEditor` enrichers; `CONFIG`/`CONST`; and the canvas placeable API (5 `pf1` subclasses —
   stubbable in a first slice at the price of "unchanged"). No honest line count exists for the
   new part: the reference is proprietary and there is no open reimplementation to measure.
   **Acceptance gate, if the project is opened:** `pf1`'s own 21 Quench test batches running
   green under the runtime — a real certification, stronger than proposal §10 — and, because
   repos 2–5 are `pf1`-schema data and an SBC that writes `pf1` actors, they would load with it.
2. **Two world models.** If it ran, `pf1` would produce pf1 documents replicated by Foundry's
   socket DB semantics; ArenaStar's world is a typed 74-message host-authoritative protocol with
   its own actor model. Either the two are reconciled permanently (a bidirectional mapping for
   every mechanic `pf1` owns) or ArenaStar's actor model is replaced by `pf1`'s — at which point
   the product is a Foundry re-implementation hosting `pf1`. A legitimate product; not the one in
   the spec, and not one that fits one 6 MiB file.
3. **Licence is a different question from INVENTORY row 2.** Row 2's clean-room rule forbids
   copying GPLv3 code *into* ArenaStar. Running GPLv3 code as a separately-installed guest is a
   plugin / combined-work question that this document does not settle; it is for the owner.

**Three forms in which `pf1` can still be the target** (not mutually exclusive):

| Form | What it gives | What it costs | Verdict |
|---|---|---|---|
| **Oracle** — `pf1`-prepared actor JSON as test fixtures for `derivePF1eActor` and the combat kernel | SRD-correct expected numbers for every class/feature/buff combination, with `pf1` as the reference | Export fixtures *from* a live Foundry + `pf1` session (no runtime needed); a fixture-loader test. Running `pf1`'s preparation headless instead would need the core stub above | **Cheap, recommended**; the fixture content is derived numbers, not `pf1` code |
| **Data as the mechanics carrier** — `changes[]`, `actions[]`, `links.classAssociations`, `learnedAt`, `contextNotes` already present in the YAML packs | Feature automation (4,710 class abilities), spell attack/damage/save automation (3,037 spells), buff stacking — i.e. L01/L02/L04 — with `pf1`'s schema as the target *format* | Converter already carries `actions`/`learnedAt`/`changes` raw; `src/packages/pf1e/itemChanges.ts` (D-259) already evaluates pf1-shaped `changes[]`. Work = extend the evaluator + the converter mappers per field | **Highest leverage**; OGL/CUP data, documented semantics |
| **Runtime** — `pf1` code executing under a Foundry-core-compatible runtime | Everything `pf1` does, unchanged | Consequences 1–3 above | Separate project; owner's call |

### 3.2 `pf1-content` — the content module

**Identity.** `module.json` 11.4.0: `relationships.systems[pf1 ≥ 11]`, Foundry 12–13, **35 packs**
(Item ×23, Actor ×5 — `pf-companions`, `pf-eidolon-forms`, `pf-familiars`, `pf-merchants`,
`pf-traps-and-haunts`; RollTable ×3; JournalEntry ×4 — `pf-deities`, `gm-quick-reference`,
`harrow-deck`, `pf-rules`). Licence: `LICENSE.md` + `OGL.txt` + `Legal.txt`; INVENTORY row 1
records OGL 1.0a content + GPLv3 code at the pinned mirror; Paizo CUP notice in the README.

**Footprint.** `pf-content.js` is three hooks: `init` → `CONFIG.compendium.uuidRedirects` for two
renamed packs (`pf-elephant → pf-third-party`, `pf-magic → pf-magic-items`); `ready` → unless SBC
5.x is active, push 23 pack ids into `sbc.loadCustomCompendiums`; `pf1RegisterSources` → register
dozens of book records (Frog God Games, PFS scenarios, …) with the system's source registry. None of it is
the module's value; all of it is unsupported by the adapter (`CONFIG`, `game.modules.get`,
system registries). **E for the script, and it does not matter.**

**What is in place.** 15 packs converted (stage 1b) from `baileymh/pf1e-content@baf5232c`
(main, **2023-09-05**): feats, wondrous, items, magic, class-abilities, traits, racial-traits,
goods-services, special-qualities, technology, artifacts, buffs, rules, companions, familiars.

**Lacking.**
- **Pin drift (C-02).** The pinned layout is `src/packs/<pack>/*.json`; upstream main is
  `src/<pack>/…` (the `packs/` level is gone — `src/packs/pf-buffs` "did not exist on main"),
  two packs were renamed, `pf-technology` moved into the system (so the 1b `technology` spec
  would find nothing), and 21 packs are new or were never specified: `pf-merchants`,
  `pf-eidolon-forms`, `pf-eidolon-evolutions`, `pf-traps-and-haunts`, `pf-companion-features`,
  `pf-universal-monster-rules`, `pf-cursed-items`, `pf-intelligent-items`, `pf-scaling-items`,
  `pf-encounter-tables`, `pf-magic-tables`, `pf-tables`, `pf-deities`,
  `gm-quick-reference`, `harrow-deck`, `pf-35-content`, `pf-collab-content`, `pf-society`,
  `pf-third-party` (renamed), `pf-maladies`, `pf-occult-rituals`. Re-pinning means a new mirror
  commit (or a GitLab pin — see C-10) and a walker that accepts the new layout and, probably,
  YAML (**verify**: the sibling repos by the same maintainers are per-entry YAML with
  `_stats.coreVersion: '13.351'`; the pinned pf1-content is per-entry JSON).
- **Actors lose their items (C-04).** `pf-companions`/`pf-familiars` (and, once added,
  `pf-merchants`, `pf-eidolon-forms`) are converted with `items[]` dropped, so a converted
  companion has abilities and hp but no attacks, feats or gear. `foundry.ts` already maps the same
  item shapes for a single actor; the converter's `mapActor` should call the same mapping.
- **Actor types with no native equivalent (C-08).** `pf-traps-and-haunts` are pf1 `trap`/`haunt`
  actors; `pf-merchants` are `npc` + loot-sheet flags. No mapper, no sheet; a journal fallback
  (description text) is the honest minimum.
- **Changes/formulas.** The README is explicit that most entries carry descriptions, not
  mechanical `changes`; the converter drops `changes` into `system.foundry` where whitelisted.
  Nothing on the ArenaStar side consumes pf1 Changes — that is the clean-room rules boundary, not a
  converter bug.

### 3.3 `pf1e-archetypes` — archetypes and prestige classes

**Identity.** `module.json` 11.0.1, `esmodules: ["./pf-archetypes.js"]`, pf1 ≥ 11, Foundry 12;
5 Item packs (`pf-archetypes`, `pf-arch-features`, `pf-arch-buffs`, `pf-prestige-classes`,
`pf-prestige-features`). Licence: **GPLv3** `LICENSE` + `OGL.txt` + `Legal.txt`; README: Paizo
CUP, plus artwork from the Paizo *Community Use Package: PACG Class Deck Icons* (CUP terms, not
freely redistributable). Last commit 9 months ago. Not in INVENTORY until now (row 16).

**Footprint.** 16 lines: `ready` → unless SBC 5.x is active, push four pack ids into
`sbc.loadCustomCompendiums`. **E for the script; irrelevant.**

**Data shape (read: `src/pf-archetypes/alchemist/alchemist-aerochemist.*.yaml`).** Per-entry
YAML, Foundry v13 document (`_key: '!items!…'`, `_stats.coreVersion '13.351'`), `type: feat`,
`system.subType: misc`, `system.associations.classes: [Alchemist]`, `system.tags`,
`system.sources[{id, pages}]`, `system.links.supplements[{level, uuid}]` pointing at
`Compendium.pf1e-archetypes.pf-arch-features.Item.<id>`, and a description whose feature list is
`@Embed[Compendium.… inline=true]{Label}` enrichers. Prestige classes are `type: class` with HD,
saves, class skills and linked features (README). The README is candid that archetypes have "no
hd, hp, saves" and features carry "no changes or attacks".

**What is in place.** `mapFeat` and `mapClass` exist; `htmlToMarkdown` reduces
`@UUID`/`@Compendium`/`@Source`; `foundryCarry` keeps `links`/`sources` raw for classes.

**Lacking.**
- **C-01** a third source id + a YAML walker not keyed on `spec.src === "pf1-system"` (the walker
  is the only YAML path today), accepting `src/<pack>/<class>/*.yaml`.
- **C-05** `@Embed[...]{label}` is not reduced — converted descriptions would show the raw
  enricher text. One more alternative in the existing regex; but the deeper loss is that every
  cross-reference becomes a label and the feature → archetype relationship is gone. A UUID → pack
  slug map across converted packs would keep them as in-app links.
- **C-06** `links.supplements` (features by level) is the only structured relationship in this
  data and the thing that makes an archetype usable; it is carried raw for `class` only and
  consumed by nothing. Whether the character builder (D-254) should consume it is a **product
  decision (N-03)**: an "archetype" affordance = swap base class features by level.
- `mapClass` computes a 20-level BAB/save table; prestige classes are 10-level — **verify** the
  mapper reads `system.levels` rather than assuming 20.
- Images: all `img` paths are into `systems/pf1/icons/…` or CUP class-deck icons; the converter
  drops `img` (correct both technically and legally).

### 3.4 `pf1-statblock-library` — ≈10,000 statblocks as journal pages

**Identity.** `module.json` 0.8.0, Foundry 11–13, pf1 9–11, `relationships.modules`
→ SBC; `esmodules: ["scripts/welcome-screen.mjs"]`; `documentTypes.JournalEntryPage.statblock`;
≈48 JournalEntry packs (22 APs, 6 bestiary volumes, 12 modules, 3 Frog God Games modules, PFS,
NPC/campaign-setting books). Licence: **GPLv3** `LICENSE`; README Paizo CUP notice; **no OGL
notice located** in the tree listing read (**verify**). The content is Paizo AP/PFS/Bestiary
statblock text including tactics prose and named NPCs — the Product-Identity-adjacent part of
Paizo publications, shipped under the CUP's non-commercial terms (L-01). Not in INVENTORY until
now (row 17).

**Footprint.** `scripts/statblock-page.mjs`: `class JournalStatblockPageSheet extends
JournalPageSheet` — Handlebars templates (`loadTemplates`), `TextEditor.enrichHTML`, ProseMirror
collaborative editing, `showdown`, jQuery `html.find(".importStatblock").click(...)`; the
*Import* button turns the page HTML into text (`</p>` → newline, `innerText`) and calls
`game.modules.get("pf1-statblock-converter").api.openSBCDialog(text, uuid)` (or pokes
`#sbcInput` through jQuery on older SBC). `welcome-screen.mjs` registers the sheet
(`DocumentSheetConfig.registerSheet(JournalEntryPage, …)`) and contains a dead
Foundry-Workshop welcome prompt (`game.settings`, `Dialog`). **E — the adapter has no
JournalEntryPage documents, no sheet registry, no templates, no jQuery, no module API bus.** It
also does not matter: the sheet exists only to hand text to SBC.

**Data shape (read: `src/sb-we-be-goblins/Goblin_Chief_Effigy__CR_5__*.yml`).** Per-entry
`.yml`, Foundry v13 `JournalEntry` with two pages: `type: statblock-library.statblock`,
`text.format: 1` (HTML) holding the full statblock (`<p><strong>AC </strong>14, touch 8, …`,
sections DEFENSE/OFFENSE/TACTICS/STATISTICS/SPECIAL ABILITIES), and a `type: image` cover page
whose `src` is a `systems/pf1/icons/…` path. Names carry CR or class levels (`Goblin Chief Effigy
(CR 5)`, `Chuffy Lickwound (rogue 3)`), which is what makes the library searchable.

**What is in place.** `mapJournal` (pages → markdown), the compendium reader at scale, and —
decisively — `importStatblock(text)` / `looksLikeStatblock(text)` in
`src/packages/pf1e/import/statblock.ts`, which reads exactly this kind of labelled text.

**Lacking.**
- **C-01/C-07** a fourth source; a `.yml` walker; a rule for the custom page subtype
  (`statblock-library.statblock` must be treated as text, `image` pages dropped with a count);
  the HTML → markdown step must keep one clause per line (`</p>` → `\n\n` already; `<hr />`
  section breaks too) so that the native reader's label parser sees the same text the library's
  own Import button produces.
- **N-01 — the feature.** An *Import as actor* action on a compendium/journal entry that
  `looksLikeStatblock()` → `importStatblock()` → the D-264 import front door (which already
  creates the actor and reports unmapped fields). Small; it replicates the module's only
  behaviour with no AIS involved.
- **C-09 — scale and packaging.** ≈10,000 entries × ~3–5 KB HTML ≈ 30–50 MB of source, perhaps
  25–40 MB of markdown, 5–8 MB gzipped (**verify by running**). D-252 allows package zips of any
  size and D-266 proved the reader at 25,376 entries, but body memory in the GM tab at +30–40 MB
  of strings is unmeasured; it must ship as its **own opt-in package**, never inside the default
  tester world, and the compendium parse cache (`compendiumCache.ts`, per package record) should
  be checked for a pack-granular lazy path. Compendia are GM-only (host `CompendiaPanel`), so no
  player-side cost today.
- **L-01 — licence posture.** Statblock text from APs/PFS under Paizo CUP: non-commercial,
  attribution, "not published, endorsed, or specifically approved by Paizo". Any ArenaStar
  distribution of such a package inherits that; it is a Legal case (D-252 posture), recorded in
  INVENTORY row 17, not decided here.

### 3.5 `pf1-statblock-converter` (SBC) — the one real code module

**Identity.** `module.json` 6.0.3, Foundry 12–13, pf1 11–11.9, `socket: true`, `esmodules:
["sbc.mjs"]`, `styles`, two Item packs (`mythic-rank-and-features`, `spell-components`), en/es,
`relationships.modules` → repos 2, 3, 4. Licence: **MIT** (2020 Lavaeolous) — the only
permissively licensed code among the five. Paizo CUP notice. Not in INVENTORY until now (row 18).

**Footprint (read: `sbc.mjs`, `sbcInput.js`, `sbcCompendium.js`, `sbcParser.js`, tree).**
- Lifecycle: `Hooks.once("setup"|"init"|"ready")`, `renderActorDirectory` (injects a button into
  the sidebar DOM), custom hooks `sbc.reset`, `sbc.loadCustomCompendiums`, `sbc.ready`,
  `sbc.actorImported`; system hooks `pf1RegisterMaterials` (registers "silver" in
  `pf1.registry`); `game.modules.get(id).api = { openSBCDialog }` as the module-to-module API.
- Settings: `game.settings.register` world + client (file storage source `data|s3`, folder, S3
  bucket via `FilePicker.browse("s3")`, custom compendium list, migration version, debug, auto-
  convert, input delay, Babele dialog), plus `ModuleManagement.CONFIG_SETTING`.
- Sockets: `game.socket.on/emit("module.pf1-statblock-converter")` so a non-GM can ask a GM to
  delete the work-in-progress actor.
- Compendia: `game.packs` keys filtered by prefix (`pf1.`, `pf1e-archetypes`, `pf-content`,
  `pf1-statblock-converter`), `compendium.getIndex()` with `system.subType`,
  `system.associations.classes`, `system.tags` index fields, Babele `flags.babele.originalName`,
  `pf1.utils.createTag`, word-permutation fuzzy matching, `fromUuid`.
- Documents: creates a WIP `Actor` in a hidden `Folder`, builds embedded Items of pf1 types
  (attack/feat/spell/weapon/equipment/class/buff with `changes`), deletes on cancel; migrates
  actors and packs on version bump; token/actor art upload (`FilePicker`, drag-drop, image
  mapping) and prototype-token data.
- UI: `foundry.applications.api.ApplicationV2` + `HandlebarsApplicationMixin`, `PARTS`
  templates, `renderTemplate` (v12) / `foundry.applications.handlebars.renderTemplate` (v13),
  progress bar, error highlights, preview; `ui.notifications`; `game.i18n`; Foundry prototype
  extensions (`String.prototype.capitalize`).
- Parsing: `scripts/Parsers/{BaseData,Defense,Misc,Offense,Statistics,Universal}`,
  `scripts/Process/{base,defense,description,ecology,offense,special-ability,statistics,tactics}-data.js`,
  `scripts/Content/` (image mapping, metamagic), `sbcRegex.js`, `sbcValidation.js`, `sbcConfig.js`
  (line starters/categories, source-superscript scrubbing), a `tests/` directory (jest).
- Optional integrations: Roll Bonuses PF1 (pre-configured feat bonuses), Babele, The Forge.

**AIS/adapter today: E (B is far).** *(Written before D-476…D-479; compendium reads, settings and
the module bus now exist — see the struck rows in §4.1 — which moves the kernel but not the
verdict: the data model and DOM families below are the ones that decide it.)* Every family above
maps to an unbuilt or explicitly excluded part of the proposal: documents and compendia
(~~no AIS capability at all~~ reads since D-477; creates/updates still R-02), settings (~~P4~~
D-476), DOM applications (§7.3 — recipes only, P4), sockets/player side (D-468 for the player
side; no raw sockets by design), file storage (binary resources not even in packages — P1
leftover, R-07), module-to-module API bus (~~R-05~~ D-478) and system registries (R-08),
ES-module import graphs and prototype extensions (R-09), and
the staged prepare/commit path any "create actor with 40 embedded items" would need (P3). Even
with all of that, the actor SBC produces is a **pf1-system document** — only meaningful inside
the pf1 data model and derived-data pipeline that §3.1 rules out. Running SBC unchanged is
therefore not a reachable target, and "partially running" it would produce actors ArenaStar
cannot play.

**What is in place.** The native statblock reader (D-267) covers the labelled core — name/CR/
size/type/alignment, Init, senses, AC/touch/flat-footed as published totals, hp + HD, saves,
speed, melee/ranged attack lines decomposed into dice + flat bonus (natural weapons recognised),
abilities, Base Atk/CMB/CMD, special attacks/qualities/languages/treasure into
`system.pf1e.creature`, and a report of every field left behind in the source's words. The import
front door creates the actor and places a token. 25 unit tests + 1 e2e spec.

**Lacking (N-02), relative to SBC's 6.x behaviour.**
1. **Compendium entity linking** — feats, spells, gear, class levels, special abilities and
   templates matched by name against the converted packs (SBC's `findInCompendia`: exact
   match ignoring punctuation/case first, then word-order permutations ≤ 7, class/race filters
   from `associations.classes`/`tags`). ArenaStar's compendium index (`compendiumIndex.ts`) is the
   natural matcher; unmatched names must stay in the report, not be invented (house rule 1).
2. **Spellbooks and SLAs** — "Spells Prepared/Known (CL 5th; concentration +8)" blocks and
   "Spell-Like Abilities" lines → prepared slots / SLA items; today reported, not imported.
3. **Skills with ranks** — SBC back-solves ranks from printed totals; the native reader
   deliberately imports neither (house rule 2) — a product decision whether to derive ranks.
4. **Gear → inventory items** (quantity, masterwork/enhancement parsing, ammo), **class levels →
   class items**, **templates** (advanced, giant, …), **PC vs NPC** actor type, **DR/SR/immunities**
   as structured fields, prototype token size from creature size.
5. **UI**: error highlighting per input line, preview, auto-convert on paste, art drop. The
   D-264 front door has a report; it has no per-line highlighting.
6. **Conformance corpus**: SBC's `tests/` (MIT) and the statblock library's 10,000 texts are an
   oracle that does not exist for the native reader today — the project's P-4 rule is that
   nothing ships without its corpus.

Because SBC is MIT, its regexes, line-category tables, source-superscript scrubbing list and
fixtures may be transcribed into `statblock.ts` with attribution — the one place in these five
repositories where code transfer is cheap and legally clean (still a `pending` INVENTORY row until
Legal closes it).

## 4. Consolidated gap list

Classification: **[AIS]** kernel/bridge, **[ADAPTER]** profile/facade, **[LOADER]** package/guest
loading, **[CONVERTER]** data route, **[PRODUCT]** native feature, **[LEGAL]**. "Needed by" names
the repositories; "plan" maps to `FOUNDRY_AIS_ADAPTER_PROPOSAL.md` §9 phases or design §15.

### 4.1 AIS / adapter gaps — recorded, not recommended for action now

None of these is worth building for the five repositories in question (four need no code to run;
the fifth needs the pf1 system). They are the concrete specification a future "content-aware
guest" profile would need, and they confirm the AIS state report's conclusion that P3 is the next
kernel slice.

| ID | Gap | Needed by | Plan | Severity if a content/tool guest were ever in scope |
|---|---|---|---|---|
| R-01 | ~~No compendium/document **read** surface~~ **Closed by D-477 (2026-10-15):** `compendium.list / search / get` behind `compendium.read` (GM device only; bounded hits, 48 KiB entries, copies). Still absent, by design: `fromUuid`-style cross-package UUIDs and `uuidRedirects` — an adapter maps `Compendium.<pkg>.<pack>.<Type>.<id>` onto `<packageId>/<packFile>` + entry id | 2, 4, 5 | done (kernel); adapter mapping when a content guest is in scope | — |
| R-02 | No document **create/update/delete** beyond tags and light: `Actor.create`, `createEmbeddedDocuments("Item")`, `Folder`, `actor.delete()`, prototype token | 5 | P3 (prepare/commit) is the prerequisite; §5.3 "narrow intents" argues for an `actor.import` intent carrying the app's own `ImportedCharacter`, not pf1 documents | High |
| R-03 | ~~No settings service~~ **Closed by D-476 (2026-10-15):** manifest `interconnect.settings[]` (register), `settings.list / get / set` (get/set), `scope: world | device` (world vs client), `module.settings.changed` (onChange), shell forms in both shells (config UI). An adapter maps `game.settings.register` onto the manifest schema at package-conversion time, not at runtime | 4 (dead code), 5 | done (kernel) | — |
| R-04 | No application/DOM surface: `Application`/`ApplicationV2` + `HandlebarsApplicationMixin`, `renderTemplate`/`loadTemplates`, `Dialog`, jQuery, `ui.notifications`, `DocumentSheetConfig.registerSheet`, sidebar DOM injection (`renderActorDirectory`), ProseMirror/`TextEditor.enrichHTML` | 4, 5 | §7.3 — never raw DOM; P4 "supported HUD/settings/dialog recipe" | High for 5; the proposal's answer is recipes, not emulation |
| R-05 | ~~No module-to-module bus~~ **Closed by D-478 (2026-10-15):** `modules.list` + `modules.invoke` behind `modules.invoke`, allowed only toward a module named in the caller's `interconnect.requires` (the "declared dependency" of P5), depth ≤ 8, target runs with the device's authority and its own grant. Cross-guest custom events already existed (`emits` + `action.observe`). System registries (`pf1RegisterSources`) remain R-08 territory | 2, 3, 4, 5 | done (kernel) | — |
| R-06 | No sockets / player side (`game.socket`, `socket: true`, GM-relay patterns) | 5 | P5 | Medium |
| R-07 | No file storage: `FilePicker.browse/upload`, S3, drag-drop art, `CONST.IMAGE_FILE_EXTENSIONS`; packages carry no binary resources | 5 | P1 leftover (binary-safe resources/VFS) | Medium |
| R-08 | No `CONFIG`, `game.system`, `pf1.*` namespace (`pf1.utils.createTag`, `pf1.registry`, `pf1.config`), `CONST` beyond one key | 2, 5 | §7.4 — by design, never emulate the system | Low (by design) |
| R-09 | Loader runs one IIFE rebundle; no ES-module graph (`import … from "./x.js"`), no `esmodules[]`/`styles[]`/`languages[]` manifest handling, no Foundry prototype extensions (`String.prototype.capitalize`, `Collection`) | 2, 3, 4, 5 (all are ESM entries) | P0 "ordered scripts, static imports"; P1 schema | Medium — even a trivial content-module script needs an ESM loader |
| R-10 | Foundry release ZIPs ship **LevelDB** packs; AIS packages are text-only; the data route reads repo sources instead | 1–4 | P1 (binary VFS) if ever release artifacts are to be consumed; the converter avoids it | Low — the source route is better anyway |
| R-11 | Adapter profile is v13-shaped; the system is on v14 and SBC branches on `game.version` 12/13 (`renderTemplate` moved) | 1, 5 | P0 version matrix | Low |

### 4.2 Converter (data route) gaps — recommended

| ID | Gap | Needed by | Size | Notes |
|---|---|---|---|---|
| C-01 | New source ids (archetypes, statblock-library, current pf1-content) in `tools/content/sources.json`; a YAML/`.yml` walker not keyed on `spec.src === "pf1-system"`; nested `src/<pack>/<group>/*` layouts | 2, 3, 4 | S | `walkYaml` already recurses; the dispatch is the only coupling |
| C-02 | pf1-content **re-pin**: 2023 JSON layout vs 11.4.0 `src/<pack>/…`; renames (`pf-magic → pf-magic-items`, `pf-elephant → pf-third-party`); `pf-technology` moved to the system; 21 unconverted packs | 2 | S–M | Needs a new mirror commit or a GitLab pin (C-10); pack specs for the 21 |
| C-03 | pf1-system packs not converted: `class-abilities` (4,710), `monster-templates`, `template-abilities`, `monster-abilities`, `racial-hd`, `companion-features`, `mythic-paths`, `skills-*`; `effects` has no target collection | 1 | S for the Item packs; design question for `effects` | `class-abilities` is the one the builder would consume |
| C-04 | Actor `items[]` dropped → NPC/companion/familiar/merchant packs have no attacks/feats/spells/gear | 1, 2, 4 (if statblocks are ever pre-converted) | M | Reuse the item mapping of `src/packages/pf1e/import/foundry.ts` from `tools/convert/mappers.mjs` (one mapping, two callers) |
| C-05 | Enrichers: `@Embed[...]{label}` not reduced; `@UUID`/`@Compendium` reduced to labels — cross-references lost; no UUID → converted-slug map | 2, 3 | S (regex) / M (link map) | The link map needs pack ids to be stable across packages |
| C-06 | `links.supplements` (features by level), `associations.classes`, `tags` carried raw (class only) / dropped; no facets in the reader | 3, 1 | S to carry; M to consume (see N-03) | |
| C-07 | Journal custom page subtypes (`statblock-library.statblock`), `image` pages with `systems/pf1/…` src; line-structure-preserving HTML → text for statblock pages | 4 | S | Keep `</p>`/`<hr>` → line breaks so `looksLikeStatblock()` sees clauses |
| C-08 | pf1 `trap`/`haunt`/`vehicle` actors and loot-sheet merchants have no native mapper or sheet | 2 | design | Journal fallback is the honest minimum |
| C-09 | Scale/packaging for ≈10k statblocks (~30–50 MB source): separate opt-in package; body memory unmeasured; pack-granular lazy parse (**verify**) | 4 | S to package; M if lazy parse is needed | D-266 budget test at 20k entries measured names, not bodies |
| C-10 | Source retrieval: all pins are GitHub mirrors; `fetch.mjs` is plain `git`, but D-253 recorded GitLab-only sources as blocked in the build environment of the time; GitLab announced new rate limits effective 2026-10-19 | 2, 3, 4 | S | Prefer pinned tarball hashes or a mirror the project controls; record the choice in `sources.json` |

### 4.3 Native / product gaps — the useful work

| ID | Gap | Replaces | Size | Depends on |
|---|---|---|---|---|
| N-01 | *Import as actor* on a compendium/journal entry that `looksLikeStatblock()` → `importStatblock()` → D-264 front door | statblock-library's Import button | S | C-07 (for the library) — but works today on any pasted/journal text |
| N-02 | Native statblock importer parity with SBC: compendium entity linking via `compendiumIndex`; spell lists & SLAs; gear → inventory; class levels; templates; PC/NPC; DR/SR; per-line error highlighting; SBC's MIT fixtures as conformance corpus | SBC | M–L (incremental; each sub-item is its own slice) | converted packs present; INVENTORY row 18 case for transcription |
| N-03 | Archetype / prestige class affordance in the builder consuming `links.supplements` | pf1e-archetypes in Foundry (which also needs "assembly", per its README) | M–L; product decision | C-01, C-05, C-06 |
| N-04 | PF1 action event names for a future AIS P6 surface, taken from the system's 49-hook taxonomy | — (design input) | — | none |
| N-05 | Merchant/loot sheet for `pf-merchants` | pf1 loot sheet module | M; product decision | C-02, C-04 |

### 4.4 Legal inputs (facts for the case files; no verdicts)

| ID | Fact | Where recorded |
|---|---|---|
| L-01 | All five carry the Paizo Community Use Policy notice (non-commercial, attribution, non-endorsement). Repos 1–4 are GPLv3 for code with OGL 1.0a notices for content (OGL notice **not located** for #4 in this pass — verify); SBC is MIT. The data-only route keeps GPL code out of the app bundle; whether per-entry YAML/JSON "content" files are OGL content or GPL program data is exactly the question INVENTORY rows 1–3 already pose, now extended to rows 16–17 | `tools/adopt/INVENTORY.md` rows 1–3, 16–18 |
| L-02 | pf1e-archetypes ships PACG class-deck icons under the Paizo Community Use **Package** terms; the converter drops `img` | row 16 |
| L-03 | statblock-library text is AP/PFS/Bestiary product text incl. named NPCs and tactics prose; any ArenaStar-distributed package inherits CUP's non-commercial clause and must stay opt-in with notices | row 17 |
| L-04 | SBC (MIT) parsing tables/fixtures may be transcribed with attribution; still a `pending` case until closed | row 18 |

## 5. What not to do

1. **Do not load Foundry's `pf1` code package under the adapter** or anywhere else in the app:
   103 k LOC of GPLv3, Foundry v14 APIs, canvas and document subclasses, and a 6 MiB app budget
   with 579 KiB of headroom. The project's standing boundary (INVENTORY row 2: *data via converter,
   logic via clean-room transcription*) is the current decision; §3.1a sizes the alternative so it
   can be reopened on numbers rather than on this document's say-so. This is not a statement about
   PF1e support — PF1e is the native base system, and the same repository remains its primary data
   source and the best available oracle for the native rules.
2. **Do not build a "compendium read" adapter profile to make pf1-content / archetypes /
   statblock-library "load".** Their scripts do nothing a user would notice; their value is data,
   and the converter already turns that data into packs the native reader browses faster than
   Foundry does.
3. **Do not try to run SBC partially.** A statblock parser that cannot create a pf1 actor has no
   output; a parser that creates ArenaStar actors is the native importer, which exists.
4. **Do not pre-convert the 10,000 statblocks into actors at build time.** The native reader
   reports what it cannot map per block; a silent 10,000-actor pack would hide those reports.
   Import on demand (N-01) keeps the report in front of the GM.
5. **Do not put the statblock package into the default tester world** until C-09 is measured.

## 6. Recommended sequence (bounded slices, each with its own D-entry and evidence)

| Order | Slice | Covers | Acceptance evidence |
|---|---|---|---|
| 1 | **Converter: three new sources + generic YAML walker + `@Embed` reduction + journal subtype rule** | C-01, C-05 (regex), C-07, C-10 | `tests/scripts/contentConverter.test.ts` fixtures from one real entry per new source; `REPORT.md` in/out/dropped counts per pack; `sources.json` pins reviewed |
| 2 | **Product: *Import as actor* from a journal/compendium entry** | N-01 | one e2e spec in a capped batch (paste-free path: open entry → Import → token placed), `looksLikeStatblock` negative case |
| 3 | **Converter: pf1-content re-pin + the 21 missing packs + the 11 missing system packs** | C-02, C-03 | `REPORT.md` totals; `testerRealZip`-style import test; size table in the D-entry |
| 4 | **Packaging: statblock-library as an opt-in package; measure** | C-09 | measured zip size, parse time and heap at 10k entries on the two-CPU baseline; decision on lazy parse |
| 5 | **Converter: actor `items[]` via the shared item mapping** | C-04 | converted goblin/companion has attacks/feats/gear; same golden as `foundry.ts` |
| 6 | **Native importer: SBC corpus + compendium linking** (first of the N-02 sub-slices) | N-02 (1, 6) | SBC's MIT fixtures replayed; unmatched names appear in the report; no invented fields |
| 7 | **Builder: archetypes/prestige** | N-03, C-06 | product decision first |
| — | **AIS/adapter** | R-01…R-11 | R-01/R-03/R-05 closed by D-476…D-478 (2026-10-15) as generic kernel features; R-02 partially (settings documents are the first module-authored documents), R-04/R-06/R-07/R-09/R-10/R-11 open, R-08 excluded by design |

## 7. Open questions for the owner

1. Is the project willing to distribute Paizo CUP statblock text (L-03) at all, even opt-in? If
   not, slices 1 and 4 still make sense for archetypes and pf1-content, and N-01 still works on
   pasted text, but the library stays a user-side import (a GM can import the Foundry module's
   own pack export through the existing front door — **verify** that path accepts a JournalEntry
   export).
2. Re-pin pf1-content to upstream GitLab 11.4.0 or to a newer GitHub mirror? (C-10)
3. Should the native importer derive skill ranks from printed totals (SBC does; the D-267 house
   rule says no)? This decides half of N-02 item 3.
4. Is an archetype affordance in the builder wanted (N-03), or is "archetype features as
   compendium feats you add by hand" — the Foundry module's own level of support — enough?

## Appendix A — API footprint per repository (what each would ask of a host)

| Family | pf1 system | pf1-content | pf1e-archetypes | statblock-library | SBC |
|---|---|---|---|---|---|
| Lifecycle hooks | init/setup/ready + ~20 core + 49 own | init, ready, `pf1RegisterSources` | ready | init | setup, init, ready, `renderActorDirectory`, `pf1RegisterMaterials`, own `sbc.*` |
| Documents | defines Actor/Item/ChatMessage/Combat/Combatant/TokenDocument/ActiveEffect subclasses + DataModels | — | — | `JournalEntryPage` subtype `statblock` | `Actor.create/delete`, embedded Items (pf1 types), `Folder`, migrations |
| Compendia | 24 packs (LevelDB at release) | 35 packs; `CONFIG.compendium.uuidRedirects` | 5 packs | ≈48 packs | 2 packs; `game.packs` index + fuzzy search; `fromUuid` |
| Settings | 51 | — | — | (dead code) | ~10 world/client incl. S3 |
| UI | 69 Applications/sheets; replaces `CONFIG.ui.*` | — | — | `JournalPageSheet` subclass, Handlebars, jQuery, ProseMirror | `ApplicationV2`+Handlebars, sidebar button, notifications, i18n |
| Canvas | Token/Template/Layer/HUD/Ruler subclasses | — | — | — | prototype token data only |
| Sockets | `socket: true` (3 emit / 1 on) | — | — | — | `socket: true` (GM-relay delete) |
| Files | icons under `systems/pf1/icons` | `assets/` | CUP icons | cover images → `systems/pf1/icons` | `FilePicker` browse/upload, drag-drop art |
| Module bus | registries (`pf1.registry`), `pf1.*` API | SBC hook | SBC hook | `game.modules.get(sbc).api.openSBCDialog` | exposes `api.openSBCDialog`; consumes Roll Bonuses PF1, Babele |
| Foundry version | 14.361+ | 12–13 | 12 | 11–13 | 12–13 (branches on `game.version`) |
| Adapter support today | none (by design) | none needed | none needed | none (sheet) / data route | none |

## Appendix B — Sources read (2026-10-14)

- System: repo page, `README.md`, `docs/other/MODULE_DEV.md`, `public/system.json` (master and
  mirror); mirror `681929d1` sparse checkout of `module/`, `public/`, `docs/`, `tools/` for the
  counts in §3.1 (`grep` over hooks, settings, classes, sockets; `git ls-tree` over `packs/`).
- pf1-content: repo page (README both chunks), `module.json`, `pf-content.js`, `src/` tree.
- pf1e-archetypes: repo page (README), `module.json`, `pf-archetypes.js`, `LICENSE`, `src/`
  trees, `src/pf-archetypes/alchemist/alchemist-aerochemist.uTnOISYxDAiLwxSH.yaml`.
- pf1-statblock-library: repo page, `README.md`, `module.json`, `LICENSE`,
  `scripts/welcome-screen.mjs`, `scripts/statblock-page.mjs`, `src/` trees,
  `src/sb-we-be-goblins/Goblin_Chief_Effigy__CR_5__LeizU6ANUA3CHxlD.yml`.
- SBC: repo page, `README.md`, `module.json`, `LICENSE`, `scripts/` + `scripts/Parsers/` +
  `scripts/Process/` trees, `scripts/sbc.mjs`, `scripts/sbcInput.js`, `scripts/sbcCompendium.js`,
  `scripts/sbcParser.js` (first chunk).
- ArenaStar: the files named in §2; `tools/convert/{README.md,index.mjs,mappers.mjs,packs.mjs}`;
  `tools/content/sources.json`; `src/packages/pf1e/import/{statblock,foundry}.ts`;
  `modules/ais-foundry-v13/{README.md,runtime/adapter.js}`; DECISIONS D-252/D-253/D-266/D-267.
