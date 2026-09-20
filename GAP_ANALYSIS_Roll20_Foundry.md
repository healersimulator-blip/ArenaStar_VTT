# Gap Analysis — ArenaStar_VTT vs. Roll20 & Foundry VTT (Pathfinder 1e focus)

**Date:** 2026-09-20 — **verification pass over the 2026-09-19 original** · **Base:** `arena/01a0bc2f-arenastar-vtt` @ `13962e8`
**Status key:** ✅ closed · 🟡 partial (the remainder is named) · ⛔ open · 🏛 architectural (a design bet, not a gap) · **NEW** = added by the 2026-09-20 pass.

**This pass re-verified every gap against the code at the stated commit.** The competitor
inventories (§2–§3) and the citations (§6) were not re-researched and stand as written; what
changed is *our* side of every comparison, because D-253…D-256 landed between the two passes:
a 28-pack content converter (25,376 entries), skills + character builder, the canvas rail with
layers / fog brushes / lighting placement / map pins, and a `.svelte` typecheck gate.

What the pass found, in one paragraph: **five gaps closed by shipped work** — G-01 (skills,
D-254), G-17 (firearms/TWF), G-23 (initiative editing), G-25 (fog brushes, D-256), G-28 (drawing
shapes, D-256). **Seven moved from "nothing" to "catalog/data landed, mechanics or distribution
still open"** — G-05, G-06, G-07 (converted magic-item / feat / spell catalogs), G-09 (races +
racial traits), G-15 (familiars + companions), G-18 (content scale; distribution is now the
blocker), G-41 (help window). **Two moved the other way and are corrections to the original
pass:** G-11 (traps/haunts/maladies) and G-14 (3PP/Mythic) claimed converted content that the
28-pack table in D-253 does not contain, so both are now plain **open**. **One gap was created by
our own D-256 rail**: G-43 — a placed "door" is written *open* and its axes hardcoded, so the
kind selector is cosmetic to the engine (flagged in G-27 too). **Two more gaps are new**: G-44
(the converted content is unreachable from a fresh clone) and G-45 (compendium UX at 20k entries).
Every entry below carries a file path or a test as its evidence, so the next pass can re-check it
mechanically.

**Follow-up (same day):** **D-257** closed the G-43 lifecycle and G-27 — kinds now write
honest restriction axes, doors are placed closed and toggle on a click, locked doors ignore
clicks, `Alt`-click deletes a wall, and the GM overlay that draws them is finally synced. Only
wall reshaping (drag an endpoint / change a placed wall's kind) remains of G-43. **D-258** then
closed **G-44** — the pins moved into `tools/content/sources.json`, `pnpm content:fetch` makes
them reproducible from a fresh clone, `pnpm content:package` produces the installable,
checksummed artifact, and the licences are visible in the app (Help → *Licences & credits*), so
"the content landed" is now a claim a person outside this machine can act on. The one deliberate
hand-off is the release upload (no tags exist in the repo yet).

**Purpose:** answer "what do Roll20 and Foundry VTT offer — especially their Pathfinder 1e
character sheet / module / ruleset — that ArenaStar_VTT does not have?"
**Method:** repo audit (code in `src/`, `systems/`, plus the repo's own tracking docs
`PLAN.md`, `ROADMAP.md`, `PF1e_Unified_TODO.md`, `PF1e_ImplementationPlan.md`,
`PF1e_Combat_Fidelity_GapList.md`) + external research on Roll20 (help center, community wiki,
PF sheet threads) and Foundry VTT (release notes, PF1e system wiki, package directory,
ecosystem module pages). External claims carry citations in §6.

**Read with:** `PF1e_Unified_TODO.md` — several gaps below are items already tracked there
(deferred backlog L01–L07, ROADMAP follow-ups). This document does not duplicate that work plan;
it is the *competitor-parity* view: what a PF1e table coming from Roll20 or Foundry expects to
find, item by item.

**Severity scale:**
- **High** — a PF1e table cannot realistically run without it, or it is the main reason users
  choose the competitor.
- **Med** — expected by regulars; tables cope, power users hit walls.
- **Low** — polish / power-user / ecosystem expectations.
- **Arch** — an architectural difference of this project's design (serverless, single file,
  GM-tab-as-host), not a missing feature; listed so it isn't mistaken for one.

---

## 1. What we already have (verified against code/docs, 2026-09-20)

Short snapshot so the gap list below is trustworthy. Full detail in the linked tracking docs.

**Platform**
- Serverless single-file VTT: GM tab = authoritative host; players join over WebRTC data
  channels with manual/MQTT/Nostr/WebSocket/WebTorrent-tracker signaling, TURN credentials,
  peer relay, assistant-GM failover (`PLAN.md` M1–M4).
- Persistence: IndexedDB + OPFS, world files (.zip) with export/import/restore, undo/redo
  (OpLog), turn-level undo, after-action replay from checkpoints.
- Canvas (PixiJS): square/hex(4)/gridless grids; walls with sight/light/sound/move
  restrictions + doors; additive lighting with darkness level and colored ambient; per-user
  **explored fog of war** (persistent, token-hiding, GM god-view) plus the **manual Hide/Reveal
  mask** (D-256); templates (cone/circle/ray/rect); drawings (freehand/poly/rect/**ellipse**/
  **line**/text, styles); tiles with occlusion; pings; waypoint ruler; ruler broadcasting;
  animated token movement; 3D dice (three.js); 100k-model instanced layer with LOD.
- Tabletop: combat tracker (initiative/rounds/delay/effect durations), chat (whispers,
  ooc, `roll`/`gmroll`/`selfroll`/`blindroll`, safe markdown, **commit-reveal verifiable
  dice**), roll tables, folders, journals with `<secret>`, playlists + audio, window manager,
  permissions UI, macros with hotbar (slots 1–5), scene nav, player list.
- Ecosystem plumbing: manifest-zip packages (system/data), compendium with ranked search +
  drag-import, versioned migrations, sandboxed module API (iframe RPC `game.*`, Hooks,
  `canvas.tokens`, `ChatMessage.create`, `ui.notifications`, settings) with trusted in-page
  opt-in.
- Strategic mass battle (unique): deterministic 10k-model sim in a sandboxed worker,
  checkpoints, replay, order UI, Army Window, analytics + CSV, logistics, hero bridge,
  strategic↔tactical scene links, realtime mode, faction fog.

**PF1e (tactical, hero level)**
- Actor sheet with tabs: summary / attributes / combat / weapons / armor / features / spells /
  effects / monster / details; authored fields + derived readouts (AC breakdown, saves,
  CMB/CMD, initiative, speeds) derived on read, never persisted.
- Full initiative flow (Dex tie-break, surprise round), action economy, ready/delay.
- Attack flow: iterative attacks, criticals, range/splash legality, flanking (AoN 183),
  cover/concealment (AoN 181/182 corner-ray), prone, higher ground, mounted (incl. lance),
  firearms (grit/deeds, touch window, explosion), manyshot, Power Attack / Deadly Aim /
  Combat Expertise / Fighting Defensively / Point-Blank as documented options, maneuvers
  (trip/grapple/bull rush/disarm, etc.), AoO with cover exclusions, reach gate,
  shooting-into-melee.
- Damage: DR/ER/SR mitigation, nonlethal + temp-HP stacking, healing/fast healing/regeneration
  with suppression, ability damage/drain, negative levels/energy drain.
- Spellcasting: spell slots + spellbook, area targeting with canvas preview, per-token save
  prompts (incl. pending player rolls), concentration (full Table 9-1), multi-round casting,
  touch spells + held charges, defensive casting.
- Conditions/effects: condition library, durations with a **world clock**, turn-boundary
  expiry, token badges.
- Injury/death: disabled/dying/stable/dead ladder, stabilization, first aid, coup de grâce,
  rest/recovery planner.
- Strategic: 10k-model PF1e battles with per-model AC/DR/SR, envelopment, spells, doctrine/
  envelop/army-initiative (simultaneous) modes, analytics CSV, hero participation, mid-battle
  joiners.

**PF1e content shipped (re-verified 2026-09-20).** In git, hand-authored: 75 spells (4
automated), 40 bestiary actors, 6 class starter tables, 8 equipment rows, 33 feats
(`systems/pf1e-core`). **Converted (D-253, `tools/convert/`, `pnpm content:convert`):** 28 packs
/ 25,376 entries — spells-core 3,028 · feats 3,541 · class-abilities 4,727 · wondrous 3,008 ·
items 1,474 · traits 1,915 · racial-traits 1,214 · magic 790 · rules 591+10 · technology 534 ·
goods-services 531 · artifacts 409 · companions 209 · familiars 175 · basic-npcs 15 · roll-tables
19 and more — plus the `pf1e-mass-battles-tester` world zip that embeds ruleset + content side
by side. Both are **build artifacts, not repo files**: `tools/content/vendor/` is git-ignored
(262 MB) and `dist/` is produced by the build — the gap this used to be is closed by **G-44 /
D-258**: `pnpm content:fetch` reproduces the inputs from the pinned commits and
`pnpm content:package` writes the downloadable artifact with checksums.

**Landed since the original pass (D-248…D-256), so §4's statuses reflect it:**
- **Content pipeline + world-file packaging (D-248/D-249/D-253):** `tools/convert/`
  (`pnpm content:convert`) maps Foundry PF1 sources into 28 data packs / 25,376 entries; the
  world zip (format 2) embeds ruleset + content packs side by side and is uncapped in size; the
  compendium entry cap now applies to the app-body origin only
  (`COMPENDIUM_MAX_ENTRIES = 2_000` vs `COMPENDIUM_WORLD_SANITY_MAX_ENTRIES = 1_000_000`,
  `src/core/compendium.ts:22-81`).
- **Sheet (D-254):** skills system + Skills tab, character builder/leveling wizard, compendium
  feat/spell pickers with prerequisite checks.
- **Canvas rail (D-255/D-256):** Roll20's tool inventory in both shells — layers, draw shapes
  with styles, in-canvas text editor, measure snap/broadcast/recall/AoE, dice tray, wall/door/
  light placement, map pins with a player/GM text split and a visibility flag, fog mask brushes,
  zoom in/out/fit, turn order, settings and help windows. The wall/door semantics of that tool
  are flagged in **G-43** below.
- **Process:** `scripts/checkSvelte.mjs` runs inside `pnpm typecheck` (39 components, 0 blocking),
  closing the hole that let `.svelte` defects ship unseen.

**Where we are ahead of both competitors** (context for prioritization): serverless
single-file deploy (no server, no accounts), verifiable commit-reveal dice, true
turn-level undo + deterministic replay, and the entire strategic mass-battle layer — none of
which exists in Roll20 or Foundry.

---

## 2. What Roll20 offers (platform + Pathfinder 1e sheet)

**PF1e sheet** (official "Pathfinder by Roll20" + the actively maintained community sheet;
both documented on the Roll20 wiki [1][2][3], sheet thread [4]):

- Tabbed sheet: Main (six abilities, at-a-glance), Combat (defenses/AC breakdown, attacks,
  HP/HD, saves, initiative), Skills (full 15-skill grid, ranks, class-skill checkboxes,
  Take 10/Take 20, custom rolls; optional Unchained skill systems), Spells (one spellbook
  per casting class, prepared/spontaneous, slots per level, spell points, custom spell
  level, 3PP spheres), Items (inventory with sub-type tabs, worn-equipment slots, AC items,
  gear & encumbrance with Str-based carrying capacity, money), Feats, Traits, Features /
  Special Abilities (monster rules with Ex/Sp/Su + DC), Notes (custom macros/rolls),
  Settings (per-sheet configuration toggles).
- Auto-calculation by sheet workers: abilities, buffs, conditions, skills, max HP, saves,
  attack/damage modifiers; multi-class up to 5 class levels with BAB/save/HD progression,
  fractional ranks, XP & next level.
- Buff system: repeatable buff rows with **stacking rules**, durations, buffable skills/saves.
- Roll buttons for abilities, HP/HD, initiative, saves, concentration, skills, attacks,
  spells, feats, special abilities — each drag-droppable onto the macro quick bar; PF roll
  templates (e.g. `pf_attack`) with automatic HP application.
- Compendium drag-and-drop: weapons, armor, gear, spells, feats, monsters (licensed Paizo
  content in the Roll20 compendium); **NPC/monster statblock parser** (drag bestiary
  statblock → parse into NPC sheet).
- Import: **Hero Lab** (XML→JSON), character builder, character vault.
- Optional support: Pathfinder Unchained, Mythic Adventures, Ultimate Psionics.
- **API companion script** (community JS, campaign-wide): auto-initiative, auto damage
  application, token/character sync and much more [4].

**Platform** [5][6][7]:
- Pages/maps with layers (GM layer, token/object layer, text layer); grid config.
- **Dynamic lighting** (legacy + updated): per-token light sources, night vision, colored
  light, line-of-sight blocking by DL lines; subscription feature.
- **Fog of war**: manual GM reveal + **Advanced FoW** (per-token, per-player revealed map,
  dim-light reveal) [5][6].
- Tokens: states (condition icons), per-token visibility (invisibility), token settings
  (sight, light, night vision), HP bar.
- Templates (circle/cone/line/square/ray/rect), drawings (freehand/straight/rect/ellipse/
  text), ruler, pings.
- Initiative tracker with ready/delay; dice engine with rich modifiers (kh/kl, min/max,
  rerolls, roll tables).
- Chat: whispers, roll modes, macros + macro quick bar, **API macros (JavaScript)**.
- **Soundboard, audio streaming (TTS/file), video chat, screen sharing**, journal, tables.
- Marketplace (paid Paizo modules/maps/tokens/sheets), mobile apps (iPad/Android),
  character vault, views/bookmarks, campaign export.

---

## 3. What Foundry VTT offers (platform + Pathfinder 1e system + ecosystem)

**PF1e system** (the community "Pathfinder 1e for Foundry VTT" system, `pf1`; wiki FAQ [8],
ecosystem pages [9]–[14]):

- **Drag-and-drop character creation**: race item, one class item **per level** (each class
  level carries its features), feats, spells, class features, traits — dragged from
  compendia; multiclassing by dragging several class levels; custom classes supported [11][13].
- Level-up flow: XP tracking, roll-or-enter HP on level up, features added per level [11].
- Derived stats: abilities, HP, AC (natural/armor/shield/Dex/size/misc), saves with good-save
  automation, BAB, attack bonuses, CMB/CMD, speed, initiative; **full skill grid** with
  ranks, class skills, skill points, size modifiers.
- **Inventory as item documents**: containers, **charges** (potions/wands/scrolls),
  **currency**, encumbrance (weight or Bulk), equipped state, item properties/special
  qualities (333 weapon/armor qualities in PF-Content), drag-and-drop item management [11].
- **Spellbooks** per class: prepared/known/spontaneous, caster level, DC, domain/specialist
  slots, bonus spells, spell points; consumables (wand/scroll/potion) auto-created by
  dragging a spell [8]; metamagic via ecosystem picker [14].
- **Effects system**: durations (rounds→hours), per-turn decrement, stacking, condition→
  modifier automation, token status icons; ecosystem modules automate grapple, dying
  checks, blind movement, confusion, etc. [12][14].
- **Conditional modifiers**: on-attack toggles in the attack dialog (sneak attack,
  flanking, weapon properties…) with bonus-type stacking rules [8].
- Combat tab + **quickbar** of actions; attack actions with full-attack iterative attacks.
- **Token bars** (HP, resources), token light/sight incl. darkvision/low-light vision setup [8].
- Chat cards with **apply damage / apply healing buttons** (DR handling with caveats),
  inline rolls, roll tooltips listing every modifier component [8].
- Content: PF1 **Bestiary module** (monsters + statblock import), PF-Content (≈4,200 magic
  items, ≈2,000 gear, ≈3,300 feats, ≈2,000 traits + 1,200 racial traits, 894 class
  abilities, 147 UMR, 177 familiars, 209 animal companions + eidolons, traps/haunts/
  madness/curses/diseases/deities/poisons, rules compendium + GM quick reference) [9];
  **PFS module** (Pathfinder Society campaign rules); alternate-sheet modules, loot sheets
  (with shopkeepers & money splitting), item hints, buff/condition/metamagic/polymorph
  automation modules [10][12][13][14].

**Platform** [15][16]:
- Documents with per-document ownership/permissions: actors, items, scenes, chat, macros,
  playlists, journals, tables, folders; compendium data packs; world zip export/import.
- **Best-in-class WebGL lighting**: ambient + token light sources, 13 light animations
  (torch flicker, domes, black hole…), darkness sources, priority/thresholds, quadtree LOS,
  animated vision, global illumination [15][16].
- **Persistent per-user fog of war** with vision-based reveal; walls/doors/**windows**;
  tiles + regions with visibility.
- Tokens: bars, status effects, light, size/animation; templates, drawings (incl. ellipse),
  notes, audio.
- Combat tracker with initiative control; rich dice engine with roll-data substitution,
  roll tooltips; chat with whispers/roll modes/inline rolls/HTML cards.
- Playlists + audio; **video chat (WebRTC / Jitsi)**; journals; tables; settings +
  keybindings; **official language packs** (EN/DE/ES/FR/IT/…); PWA; **self-hosted server**
  with user accounts, per-player permissions, persistent worlds.

---

## 4. The gap list

Format: **G-## — name** · severity · **status** (verified 2026-09-20 against `13962e8`).
"Us" is what the repo verifiably has today, with the file or test that proves it. Severities
are unchanged from the original pass; where the verification pass found the *shape* of the
remaining work is different from what the original assumed, that is called out.

### A. PF1e character sheet & character construction

- **G-01 — Skills.** High · ✅ **Closed (D-254).**
  `src/packages/pf1e/skills.ts` — the 35 standard skills (incl. Knowledge/Craft/Perform/
  Profession specializations), trained-only and ACP flags, Foundry abbreviation normalization;
  `derivePF1eSkill` folds ability mod + ranks + class-skill bonus + ACP + custom + effects +
  negative levels; `src/ui/sheets/PF1eSkillsTab.svelte` renders the grid with All/Trained/Class
  filters, search and Take 10/20 rolls. **Remainder (small):** `PF1E_MOD_KEYS`
  (`src/packages/pf1e/effects.ts:24`) still lists only `perception`/`stealth`; the other skills
  take effect contributions through `skill.<id>` paths only. Fold this into the next sheet slice
  rather than re-opening the gap.

- **G-02 — Character creation / leveling.** High · ✅ **Closed in substance (D-254).**
  `PF1eCharacterBuilderModal.svelte`: race step (7 core races, flexible +2), class+level step
  (11 classes, HD/BAB/good saves/skill points), ability step (point-buy 10/15/20/25 + standard
  array), and `aggregateClassProgression` for multiclass BAB/save/HP aggregation.
  `PF1eCompendiumPicker.svelte` adds feats (with prerequisite validation) and prepares spells
  from active packs. **Remainders:** no XP→level automation on the sheet (XP is an authored
  field), no custom classes (Foundry's "drag a class per level" for homebrew), and the
  level-up flow is a wizard run, not an incremental per-level drag. *(Internal: L01.)*

- **G-03 — Inventory, encumbrance, currency.** High · ⛔ **Open.**
  Verified: no `encumbrance` / `carryingCapacity` anywhere in `src/`. Weapons and armor remain
  authored fields that feed combat math; the converted equipment packs are data with no sheet
  surface. This is the largest remaining "a table can't play without it" sheet gap.
  *(Internal: L01.)*

- **G-04 — Items as first-class automatable documents.** Med-High · 🟡 **Partial.**
  We have: `ItemDocument` in core, `ActorDocument.items` (embedded), typed equipment descriptors
  with the item arithmetic that needs no actor (`src/packages/pf1e/items.ts`: hardness before
  object HP, broken at < ½ HP, armor/shield slots, authored shape per D-113 — derive on read),
  item/actor effect editing (`PF1eEffectEditor.svelte`, typed `PF1E_MOD_KEYS`), attack authoring
  (`PF1eAttackEditor.svelte` + `pf1eResolveFlow.ts`), spellbook/cast flow
  (`pf1eSpellbook.ts`, `pf1eCastFlow.ts`) and compendium import. Missing: an Items tab and an
  item sheet window, a charges (`uses`) ledger, containers, currency, encumbrance (G-03), an
  item→attack link ("create attack from this weapon"), and evaluation of imported items' Foundry
  `changes[]` (D-112 rules out a general path-overwrite mechanic, so the mapped subset has to be
  chosen deliberately). Consumable-from-spell generation depends on this.

- **G-05 — Magic items.** Med · 🟡 **Data landed, mechanics open.**
  The converter ships `magic-items` (790), `wondrous` (3,008) and `artifacts` (409) — pack ids from
  D-253's 28-pack table, sources `pf-magic`/`pf-wondrous`/`pf-artifacts` — so the *catalog* half is
  done. Still open: pricing/crafting, identify, item hints/auras, and any sheet surface that makes
  them more than a description + typed mods (see G-04).

- **G-06 — Feat / class-feature catalog & automation.** Med · 🟡 **Catalog closed, automation partial.**
  Catalog: 3,541 feats + 4,727 class abilities converted. Automation today: Power Attack, Deadly
  Aim, Combat Expertise, Fighting Defensively, Point-Blank, Manyshot, Cleave, and the whole PF1e
  combat engine (flanking/cover/concealment/mounted/firearms). Still missing the ones players ask
  for by name. Precisely: **precision damage is a supported damage type** (extra damage lines,
  rolled once, never multiplied — `src/packages/pf1e/tactical.ts:919`, `schema.ts:168`), but
  nothing *derives* sneak-attack dice from class level + flanking/denied-Dex; "rage" exists only
  as a **stacking group name** (`rulesTables.ts:356`, `effects.ts:143`), not as a rounds-per-day
  resource; and there is no `smite`, Clustered Shots, school-feat interaction or leadership
  automation (word-boundary greps, 2026-09-20). *(Internal: L02.)*

- **G-07 — Spell catalog & casting variants.** Med · 🟡 **Catalog closed, variants open.**
  Catalog: `spells-core` 3,028 entries (D-253) on top of the 75 hand-authored/automated ones.
  Open: **metamagic** (only the spontaneous-caster full-round *casting-time* rule exists —
  `src/packages/pf1e/concentration.ts:542`; no picker, no level adjustment, no slot arithmetic),
  **spell points**, and consumables auto-created from a spell (potion/wand/scroll with charges).
  *(Internal: L04.)*

- **G-08 — Monster/NPC statblock import.** Med · ⛔ **Open.**
  Verified: no `statblock` code in `src/` or `tools/`. We ship 40 hand-compiled bestiary actors in
  git and have a *structured*-content path (bestiary packs → `actors`, converter already maps
  creatures), but nothing turns a pasted statblock (R20's parser, Foundry's converter module) into
  a sheet. Note the cheap half is now cheap: a text parser + the existing actor shape, no new
  mechanics.

- **G-09 — Race catalog / racial traits.** Med · 🟡 **Partial.**
  Races: `races` pack (80) converted + the builder's race step. Racial traits: 1,214 converted but
  they arrive as items/descriptions — nothing applies them to an actor or gates them by race.

- **G-10 — Sheet UX tails.** Med/Low · 🟡 **Partial.**
  - **Token HP bars** — ⛔ verified absent (no `hpBar`/bar code; `tokenBadges.ts` renders condition
    chips only). **Med.**
  - **Player quickbar** (own-character one-click actions) — ⛔ verified absent (no `quickbar`);
    core macros with hotbar slots 1–5 exist. **Med.**
  - **Per-character settings** (NPC/compact/rule toggles) — ⛔ open. **Low.**
  - **Sheet notes / description** — 🟡 the details editor (`PF1eDetailsEditor.svelte`) covers
    authored fields; a freeform notes block is not a first-class tab. **Low.**
  - **Alt sheets / themes / dark mode** — ⛔ open (see G-40). **Low.**

### B. PF1e rules coverage & automation (beyond combat)

- **G-11 — Non-combat resolution.** Med · ⛔ **Open (corrected — no content either).**
  Verified against the 28-pack list in D-253: there is **no** traps/haunts, maladies or
  occult-ritual pack (the closest converted material is the `rules` reference journals, 591 + 10
  documents). So nothing is converted *and* nothing at runtime resolves a trap, a disease, a haunt
  or a curse. Resolution mechanics are the larger half of this gap; content can follow the same
  converter path when the mechanics are specified. *(Internal: L04.)*
- **G-12 — Polymorph / temporary stat swapping.** Low-Med · ⛔ **Open.**
- **G-13 — House-rule systems.** Low-Med · ⛔ **Open (intentionally deferred, L05).**
- **G-14 — 3PP / Mythic content.** Low · ⛔ **Open (corrected).**
  Verified: nothing Mythic and nothing 3PP is converted — the 28 packs are the pf1 core set plus
  the pf1e-content expansion, with `technology-core` (274) + `technology` (260) the only
  non-medieval material. No Mythic tiers/power, and the 3PP opt-in gate (`flags.pf1e.thirdParty`,
  L06) is still an open scope decision, so an adoption would need both a license case and a pack
  in the pack table.
- **G-15 — Familiar/companion ecosystem.** Low · 🟡 **Data landed.**
  175 familiars + 209 companions converted; companion support at the sheet level (D-214). No
  evolution/level-progression automation for them.
- **G-16 — PFS campaign rules.** Low · ⛔ **Open.**
- **G-17 — Firearms misfire/clearing & TWF.** Med · ✅ **Closed.**
  Misfire/grit/deeds live in `src/packages/pf1e/combatEngine.ts` with `e2e/pf1e_firearms.spec.ts`;
  TWF penalties are transcribed as `twfPenalties` (`src/packages/pf1e/rulesTables.ts:512`) and
  consumed by the tactical builder (`tactical.ts`, `twoWeaponStyle` derived from the off-hand
  weapon). **Remainder (ergonomic only):** the sheet's resolve flow exposes Power Attack as a
  toggle but no one-click "full attack with two weapons" entry.

### C. Content & compendium scale

- **G-18 — Content scale.** High · 🟡 **Pipeline closed, distribution + bestiary open.**
  28 packs / 25,376 converted entries (D-253) is the same order of magnitude as PF-Content, and
  the packaging decision (D-248/D-249) makes world zips uncapped, so nothing structural blocks
  parity. Two things remain: **the Bestiary module (1c)** is not converted, and — since D-258
  closed **G-44** — the delivery path is no longer one of them (`pnpm content:fetch` from a fresh
  clone, or the packaged artifact; the release upload is the only hand-off). This was the gap most
  likely to be *mistaken* for closed: the data existed and a GM could not fetch it.
- **G-19 — Adventure/module content support.** Med · ⛔ **Open.** No adventure pipeline
  (encounters + maps + journals + tokens as one importable thing).

### D. Combat & table flow

- **G-20 — Chat-card apply buttons for arbitrary rolls.** Med · ⛔ **Open.**
  Resolve flows write HP authoritatively, and commit–reveal rolls are verifiable, but a plain
  `/roll` on a card cannot be applied to a token from chat (no apply/heal intent; verified: the
  only `data-apply-*` in the UI is AC-conversion, unrelated).
- **G-21 — Condition-automation tails.** Low-Med · 🟡 **Partial.** Missing the ecosystem
  behaviours: blind-movement Acrobatics check, confused-round messages, auto-prone chains,
  total/normal concealment prompt. *(Internal: L02/P4.)*
- **G-22 — Player-side table surface.** Med · 🟡 **Much improved (D-255/D-256).** The player shell
  now has the full Roll20 rail (draw/text/measure/dice + zoom/fit/help), the Turn order window
  (`src/app/JoinApp.svelte:191-197`, `kind: "combat"`), fog masks, map pins and the help panel. Still
  missing: a player quickbar / macro bar (G-10b) and per-character action shortcuts.
- **G-23 — Initiative micro-controls.** Low · ✅ **Closed.** `CombatPanel.svelte:1160` renders a
  numeric initiative input per combatant (`setInit`), with the recorded-roll receipt and the
  hidden-combatant concealment rule alongside it.

### E. Canvas, scene & map tools

- **G-24 — Sight is not bounded by lighting.** High · ⛔ **Open (re-verified).**
  `src/canvas/vision/lights.ts` is render-only (color parsing, viewport rejection, gradient
  stops) and `LightingLayer` consumes only those; nothing in `fogVisibleTokenIds`
  (`src/core/fogExploration.ts`), the vision worker or the fog loop reads darkness or light state.
  Still the single biggest *platform* gap. *(Internal: ROADMAP fog follow-up.)*
- **G-25 — Fog-of-war GM tools.** Med · ✅ **Closed for brushes (D-256).**
  `src/core/fogMask.ts` (ordered hide/reveal paint log in `flags.core.fogMask`, bounded, later
  strokes win), replayed on both shells by `FogLayer.applyManualMask`, replicated as a scene flag,
  hide-all/reveal-all from the rail, and token gating via `maskHiddenTokenIds` (a player's own
  token is never swallowed). **Remainder:** GM "view as player X" — the existing `viewAsFaction`
  is the *strategic* faction fog, not a per-player fog view. *(Internal: ROADMAP follow-up.)*
- **G-26 — Light source animation & richness.** Low · ⛔ **Open.** Static lights; no flicker,
  domes, darkness sources, priorities/thresholds.
- **G-27 — Windows / wall variety.** Low · ✅ **Closed (D-257).**
  A **window** is now a first-class kind (`sight: 2`, `light: 2`, `move: 0`, `sound: 2` —
  expressible with D-009's existing axes, no new document field), drawn as a cyan double line on
  the GM overlay, and proven in `e2e/walls.spec.ts`: the sight polygon passes a window while
  `moveSegments` still contains it. One-way sight refinement remains D-075's open question (the
  axis is authored, the vision worker treats a one-way sight wall as blocking from both sides).
- **G-28 — Drawing shape set.** Low · ✅ **Closed (D-256).** Freehand, polygon, rectangle,
  **ellipse** (Alt-drag), **line/straight segment**, text with an in-canvas editor, and stroke/
  fill/width style swatches (`src/canvas/tools/drawing.ts`, `CanvasToolbar.svelte`,
  `e2e/canvas_rail.spec.ts` "draw shapes … Alt-ellipse").
- **G-29 — Soundboard & audio streaming (TTS).** Med · ⛔ **Open.** Playlists + audio exist.
- **G-30 — Screen sharing.** Low · ⛔ **Open** (voice/video mesh ≤ 6 exists; no `getDisplayMedia`).
- **G-31 — Views/bookmarks; scene background video.** Low · ⛔ **Open** (images only, no
  bookmarks, no video backgrounds).
- **G-32 — Host-side token hiding (anti-cheat fog).** Low · ⛔ **Open (known limitation).**
  D-251/D-256 token gating is client-side; positions still reach the player replica.
  *(Internal: ROADMAP follow-up.)*

### F. Communication & collaboration

- **G-33 — User accounts & multi-device worlds.** 🏛 **Arch (design bet, unchanged).**
- **G-34 — Dedicated mobile apps.** 🏛 **Arch/Low (PWA only, unchanged).**
- **G-35 — Marketplace / distribution.** 🏛 **Arch (unchanged)** — note that the content pipeline
  (G-44) is the first *mechanism* that could feed a local, non-marketplace distribution path.

### G. Ecosystem & extensibility

- **G-36 — Module ecosystem (not API).** High (strategic) · 🟡 **Partial.**
  The API surface is real (`src/core/moduleApi.ts`: `game.info`, `settings.get/set`,
  `tokens.list/move`, `chat.create`, `notify`, `hooks.subscribe`; trusted in-page opt-in) and the
  §12 package contract is proven by the content pipeline — but there is no module hub, no exemplar
  module in the repo, no authoring docs, and no third-party module has ever run. The ecosystem is
  a documentation + packaging problem now, not an API problem.
- **G-37 — Campaign-wide scripting (R20 API scripts).** Med · ⛔ **Open** (module API is
  package-scoped; no campaign-scope script surface).
- **G-38 — Localizations.** Med · ⛔ **Open.** `src/ui/i18n/index.ts` is still the empty barrel
  (`export {}`).
- **G-39 — Import from Roll20 / Foundry / Hero Lab.** Med · 🟡 **Partial (content only).**
  The build-time converter imports Foundry *content* packs; there is no **character** import:
  Hero Lab XML (R20), Foundry actor JSON, Roll20 sheet export. Verified absent (`herolab`: no
  hits in `src/` or `tools/`). High-friction on-ramp gap that pairs naturally with G-44.

### H. UX & platform completeness

- **G-40 — Visual polish / theming.** Low · ⛔ **Open** (no themes/dark mode; themed modules only).
- **G-41 — In-app help, onboarding, docs links.** Low · 🟡 **Partial (D-256).**
  `src/ui/canvas/HelpPanel.svelte` renders the live key bindings per role from
  `src/core/keys.ts` and opens from the rail's Help button (`e2e/canvas_rail.spec.ts` asserts the
  window). Still missing: first-run onboarding, contextual tips, docs links.
- **G-42 — Firefox/WebKit acceptance of the shipped app.** Med (quality) · 🟡 **Partial.**
  Day-to-day the suite runs the `chromium` project (174 specs); `playwright.config.ts` still
  defines opt-in `firefox`/`webkit` projects, and the M2 acceptance run (D-082) executed webkit
  29/29 and firefox 20/20 non-RTC (firefox RTC was blocked by the sandbox's ICE/DTLS, not by the
  app). So the matrix exists as precedent and is one flag away — it is simply not a standing gate.

### I. Gaps found by the 2026-09-20 pass

- **G-43 — Door & wall lifecycle (NEW in this pass, closed by D-257).** Med · 🟡 **Partial — lifecycle done, reshaping open.**
  The finding: a placed "door" was written *open* (`door: 1`) with `move/sight` hardcoded `1`,
  so the kind selector changed only a label and a dot colour, and no mutation site for `door`
  existed outside creation. D-257 fixed the whole lifecycle: kinds map to honest axes
  (`src/canvas/vision/wallKinds.ts`), a door is placed **closed** (or open/locked on request),
  a click toggles it closed ⇄ open, a locked door ignores clicks, `Alt`-click deletes a wall,
  and the GM overlay that draws the door dot (and therefore the click target) is finally synced
  (`WallsLayer` on the GM Info layer, redrawn on replica changes and camera moves).
  **Remaining:** drag a placed wall's endpoint and change its kind after placement (both are
  edits of an existing segment; the overlay now gives them a surface to live on).
- **G-44 — Content delivery to a GM (NEW).** High · ✅ **Closed by D-258.**
  The 25,376 converted entries and the full-content starter world were **build products with an
  unreproducible input**: `tools/content/vendor/` (262 MB of upstream checkouts) is git-ignored,
  `dist/content` was not in the tree (verified: `ls dist/content` → absent, `dist/worlds` held
  only `pf1e-mass-battles-starter-1.0.0.zip`), `scripts/buildStarterWorlds.mjs` *skipped* the
  tester world with a note when the content directory was missing, and the OGL notice/CREDITS
  surface lived only inside a zip. D-258 closed the loop with the three pieces the entry asked
  for: **`tools/content/sources.json`** holds the pins (repo, exact commit, sparse paths,
  required dirs, licence fact) as data; **`pnpm content:fetch`** (`tools/content/fetch.mjs`)
  materialises them idempotently and *verifies* (`HEAD == pin`, required paths present and
  non-empty) while naming the offline alternative on failure — `--check`, `--dest`, `--only`,
  `--force` cover the rest; **`pnpm content:package`** writes the installable
  `dist/packages/pf1e-content-1.0.0.zip` (8,084,502 B, byte-reproducible) plus
  `dist/release/SHA256SUMS` over it and the world zips; and attribution is a surface a player can
  read (`LEGAL.md`, `src/core/credits.ts`, Help → *Licences & credits*). The test that used to
  self-skip — `tests/scripts/testerRealZip.test.ts` — now runs, and `e2e/content_world.spec.ts`
  opens the real 8 MB zip through the start screen and imports converted entries.
  **Remaining (hand-off, not a gap):** attaching the built zips to a release page; the repo has no
  tags yet and README names the upload set.
- **G-45 — Compendium scale UX (NEW).** Med.
  Search is a ranked full scan of every entry per keystroke (`src/core/compendium.ts:139-195`
  builds only an id index), and browse mode caps the rendered list (the sheets spec notes "at
  most 50 rows"). At the 20k-entry scale the content pipeline just unlocked, that is
  "type the exact name" rather than "browse like Foundry". The plan's §2.5.2 targets (precomputed
  buckets, virtualized rows, lazy per-pack parse, < 16 ms keystroke) were never implemented.

---

## 5. Suggested prioritization (re-scored on the verified statuses)

The 2026-09-19 tiers were written when the content pipeline, the builder and the rail did not
exist. Re-scored by "what is left", in the order the closure plan sequences it — **value per day
first, dependencies second**, market-differentiating (non-parity) work last:

**Wave 1 — close the loops we already opened** (no new architecture; each item unblocks something
that already exists)
1. ~~**G-44** content delivery (a landed pipeline nobody can fetch) + OGL/CREDITS surface~~ —
   ✅ done by D-258 (fetch script, packaged artifact + checksums, `LEGAL.md` and in-app credits).
2. ~~**G-43 / G-27** door & wall lifecycle + window primitive~~ — ✅ done by D-257 (wall
   reshaping remains, tracked in G-43).
3. **G-03 / G-04** inventory + encumbrance + currency + item surface (the last Tier-1 sheet gap).
4. **G-45** compendium scale UX (makes the 25k entries usable, not just present).

**Wave 2 — platform parity a table feels within a session**
5. **G-24** sight bounded by lighting (+ **G-26** light richness once the model exists; **G-32**
   host-side token withholding is the same decision).
6. **G-22 / G-10a / G-10b** table flow: player quickbar, token HP bars, chat-card apply buttons
   (**G-20**).
7. **G-25 tail** GM "view as player X"; **G-41 tail** onboarding; **G-38** UI-string extraction if a
   non-English table is in scope.

**Wave 3 — breadth and on-ramp**
8. **G-08** statblock import · **G-39** character import from Roll20/Foundry/Hero Lab (the
   migration story — pairs with G-44's artifact).
9. **G-11 / G-21** non-combat resolution + condition tails · **G-12** polymorph · **G-16** PFS.
10. **G-29** soundboard/TTS · **G-31** views/bookmarks/video backgrounds · **G-40** theming ·
    **G-14 / G-15** breadth content (Mythic rules, companion progression).

**Opportunistic / differentiator track (not parity — do not schedule as gap closure)**
FX engine (spell/attack animations), 3D dice polish, module-ecosystem enablement (**G-36**
docs + one exemplar module), campaign-wide scripting (**G-37**), adventure pipeline (**G-19**),
marketplace (**G-35**).

**Deliberately not in the plan (architectural bets):** G-33 accounts/server, G-34 mobile apps,
G-35 marketplace — each contradicts the serverless single-file identity; revisit only by explicit
scope decision. **G-13** (house rules) and 3PP content remain L-items until promoted.

## 6. Sources

Roll20
- [1] Pathfinder Character Sheet (official) — wiki.roll20.net/Pathfinder_Character_Sheet
- [2] Pathfinder Community Sheet — wiki.roll20.net/Pathfinder_Community_Sheet (page updated 2025-11-30)
- [3] Pathfinder by Roll20 (sheet tabs, roll buttons, AC items, encumbrance) — wiki.roll20.net/Pathfinder_by_Roll20
- [4] [PF] Pathfinder Sheet Thread 6 — app.roll20.net/forum/post/4735667 (companion script, statblock parser, Hero Lab import, buffs, TWF, spell options)
- [5] Fog of War (Classic VTT) — help.roll20.net article 360037774513
- [6] Advanced Fog of War — help.roll20.net article 360037774493; Dynamic Lighting — pages.roll20.net/dynamic-lighting
- [7] VTT comparison chart (Roll20 feature list: dice, API, views, soundboard, video) — battlegroundsgames.com/vtt-comparison-chart

Foundry VTT
- [8] Pathfinder 1e for Foundry VTT — FAQ wiki (GitLab, foundryvtt_pathfinder1e/foundryvtt-pathfinder1): conditional modifiers, spellbook settings/domain slots, consumables from spells, sneak attack/TWF setup, apply-damage chat cards, darkvision/low-light vision, level-up HP rolling
- [9] Pathfinder 1e Content (baileymh) — foundryvtt.com/packages/pf-content/ (item/feat/trait/class-ability/UMR/familiar counts, traps/haunts/madness, rules compendium)
- [10] Loot Sheet NPC Pathfinder 1 — foundryvtt.com/packages/lootsheetnpcpf1/ (loot, shopkeepers, scrolls, money split)
- [11] r/FoundryVTT "I am about to rip my hair out learning this with PF1E" (2021) — drag-and-drop character creation, class-per-level, level-up HP
- [12] PF1 Improved Conditions — foundryvtt.com/packages/pf1-improved-conditions (condition automation, surprise round, buff automation)
- [13] PF1E Alt Sheet Reworked — foundryvtt.com/packages/pf1-altsheet-reworked (alt sheet themes, inventory containers, nested features)
- [14] Nevela's Automation Suite — github.com/Nevela-0/Nevelas-Automation-Suite (condition/damage automation, metamagic picker)
- [15] Foundry VTT Release 0.7.5 notes — foundryvtt.com/releases/7.83 (lighting/fog redesign, 13 light animations, active effects)
- [16] Foundry Lighting System overview — deepwiki.com/foundryvtt/foundryvtt/3.3-lighting-system (ambient/darkness sources, thresholds, persistence)
