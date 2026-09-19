# Gap Analysis — ArenaStar_VTT vs. Roll20 & Foundry VTT (Pathfinder 1e focus)

**Date:** 2026-09-19 · **Base:** `arena/01a0ba36-arenastar-vtt` @ `8ce5097`
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

## 1. What we already have (verified against code/docs, 2026-09-19)

Short snapshot so the gap list below is trustworthy. Full detail in the linked tracking docs.

**Platform**
- Serverless single-file VTT: GM tab = authoritative host; players join over WebRTC data
  channels with manual/MQTT/Nostr/WebSocket/WebTorrent-tracker signaling, TURN credentials,
  peer relay, assistant-GM failover (`PLAN.md` M1–M4).
- Persistence: IndexedDB + OPFS, world files (.zip) with export/import/restore, undo/redo
  (OpLog), turn-level undo, after-action replay from checkpoints.
- Canvas (PixiJS): square/hex(4)/gridless grids; walls with sight/light/sound/move
  restrictions + doors; additive lighting with darkness level and colored ambient; per-user
  **explored fog of war** (persistent, token-hiding, GM god-view); templates (cone/circle/
  ray/rect); drawings (freehand/poly/rect/text); tiles with occlusion; pings; waypoint ruler;
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

**PF1e content shipped:** 75 spells (4 automated, 71 descriptive-only), 40 bestiary actors,
6 class starter tables, 8 equipment rows, 33 feats (`systems/pf1e-core`).

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

Format: **G-## — name** · severity · Roll20 / Foundry / Us. "Us" is what the repo
verifiably has today. Cross-references to existing internal tracking are given where they
exist, so this list plugs into rather than duplicates the work plans.

### A. PF1e character sheet & character construction

- **G-01 — No skills system.** **High.**
  R20: full 15-skill grid, ranks, class-skill checkboxes, Take 10/20, custom rolls,
  skill points, buffable skills. FVTT: full skills tab with ranks/class skills/skill
  points and skill-check rolls. Us: none — `stealthPerception.ts` covers Stealth/
  Perception as combat-adjacent checks only. *(Internal: L04 "non-combat skills";
  P1 sheet has no skills tab.)*
- **G-02 — No character creation / leveling workflow.** **High.**
  R20: multiclass (up to 5 classes), BAB/save/HD progression auto, fractional ranks,
  XP → next level, Hero Lab import. FVTT: drag-and-drop race + one class item per level
  (features auto-added), level-up flow (roll HP, add features), custom classes. Us:
  actors are hand-authored or taken from the 6 class starter tables (data rows); no XP,
  no level-up, no multiclass, no point buy/ability generation. *(Internal: L01/L04.)*
- **G-03 — No inventory, encumbrance, currency.** **High.**
  R20: inventory with sub-type tabs, worn-equipment slots, prices, weight, Str-based
  carrying capacity (Muleback Cords, dwarf rules). FVTT: item documents with containers,
  charges, currency, encumbrance (weight/Bulk), equipped state. Us: no inventory surface;
  weapons/armor live as authored fields on the sheet for combat math; the 8-pack
  equipment rows are data only. *(Internal: L01 "inventory/encumbrance/loot".)*
- **G-04 — Items are not first-class automatable documents.** **Med-High.**
  FVTT: item sheets (weapon/armor/feat/spell/consumable/resource) whose "changes" modify
  the actor automatically; charges decrement; drag-and-drop everywhere. R20: compendium
  drag-and-drop auto-fills weapons/armor/spells/gear onto the sheet. Us: `ItemDocument`
  exists in core but the PF1e module keeps equipment as authored actor fields; no item
  sheet, no item→attack auto-link, no charges, no item-based effect changes.
- **G-05 — No magic items.** **Med.**
  FVTT: ≈4,200 magic items (PF-Content) + item-hints/aura modules; crafting supported by
  content. R20: magic gear in the equipment compendium. Us: nothing (no magic items,
  no pricing/crafting, no identify). *(Internal: L04.)*
- **G-06 — Feat/feature catalog scale & automation.** **Med.**
  Us: 33 feats, several with real automation (Power Attack, Deadly Aim, Combat Expertise,
  Fighting Defensively, Point-Blank, Manyshot, Cleave…). Missing: catalog scale
  (FVTT 3,300; R20 full list), and the class-feature automations players expect:
  Sneak Attack, Smite Evil, **Rage (resource)**, Two-Weapon Fighting, Clustered Shots,
  school spell feats, leadership/commander. *(Internal: L02. Note R01/R02: TWF and Charge
  modifiers were explicitly "transcribe before fixtures" — TWF is still open.)*
- **G-07 — Spell catalog & casting-variant scale.** **Med.**
  Us: 75 spells (4 automated / 71 descriptive-only) + solid slot/spellbook/targeting/save/
  concentration machinery. Missing: Core-rulebook-scale catalog (PF1 core alone is
  several hundred spells; R20/FVTT compendia carry thousands incl. 3PP), **spell points**
  (psionicist/occultist), **metamagic** (no picker/adjustment support), consumables
  auto-generated from spells (potions/wands/scrolls with charges). *(Internal: L04.)*
- **G-08 — No monster/NPC statblock import.** **Med.**
  R20: NPC/monster statblock parser (bestiary drag → parsed NPC sheet). FVTT: PF1 Bestiary
  module + statblock converter module. Us: 40 hand-compiled bestiary actors; no parser
  from text/PDF for the ~thousands of remaining Bestiary entries.
- **G-09 — No race catalog / racial traits.** **Med.**
  FVTT: race items + ≈2,000 traits/1,200 racial traits as automatable items. R20: race +
  trait fields on the sheet. Us: race is an authored string/field on the sheet; no trait
  items, no catalog.
- **G-10 — Sheet UX gaps.** **Med/Low.**
  - **Token HP bars** (FVTT token bars; R20 token HP): we render condition badges
    (`tokenBadges.ts`) but no HP/resource bar on hero tokens. **Med.**
  - **Player quickbar for own character** (R20 drag-to-quickbar; FVTT quickbar): we have
    core macros (slots 1–5) but no per-character one-click action bar for players. **Med.**
  - **Per-character settings** (R20 sheet Settings page: NPC mode, compact mode, rule
    toggles). **Low.**
  - **Sheet notes / freeform description** (both). **Low.**
  - **Alternate sheets / themes / dark mode** (FVTT alt-sheet modules, 3 themes + dark;
    R20 expanded/compact mode). **Low.** *(Internal: L07.)*

### B. PF1e rules coverage & automation (beyond combat)

- **G-11 — No non-combat resolution.** **Med.**
  Exploration, social, knowledge/lore checks, traps, diseases, madness, haunts, curses:
  FVTT has them as content + condition automation; R20 sheets track diseases/etc. Us:
  nothing outside the combat loop. *(Internal: L04/L06.)*
- **G-12 — No polymorph / temporary-stat swapping.** **Low-Med.**
  FVTT: automated polymorpher module (stat block swap with revert). Us: none.
- **G-13 — House-rule systems absent.** **Low-Med.**
  Massive damage, ability burn, grouped initiative, facing, knockback, mounted overrun,
  pursuit: available as R20/FVTT module options. *(Internal: L05 — intentionally deferred.)*
- **G-14 — 3PP / Mythic content absent.** **Low.**
  FVTT: Mythic rulebook content in PF-Content, 3PP modules. R20: Mythic Adventures +
  Ultimate Psionics support on the official sheet. *(Internal: L06.)*
- **G-15 — Familiar/companion ecosystem.** **Low.**
  FVTT: 177 familiars, 209 animal companions, eidolon forms as items. Us: companion
  support at the tactical sheet level (D-214), no catalog/evolution content.
- **G-16 — PFS (Pathfinder Society) campaign rules.** **Low.**
  FVTT: dedicated PFS module (session limits, experience awards, organization). Us: none.
- **G-17 — Firearms misfire/clearing & Two-Weapon Fighting tables.** **Med.**
  Explicitly untranscribed in our own reconciliation (R01/R02); R20 sheet has TWF
  examples built in, FVTT sets it up via conditional modifiers. *(Internal: open.)*

### C. Content & compendium scale

- **G-18 — Content scale is 2–3 orders of magnitude below the competitors.** **High.**
  Us: 75 spells / 40 monsters / 6 class starters / 8 equipment / 33 feats.
  R20: licensed Paizo compendium (full weapons, armor, gear, spells, feats, monsters).
  FVTT: PF1 core data files + PF-Content (≈4,200 magic items, ≈2,000 gear, ≈3,300 feats,
  ≈2,000+ traits, 894 class abilities, 147 UMR, familiars/companions/eidolons, 333
  weapon qualities, traps/haunts/madness/curses/diseases/deities/poisons, rules
  compendium + GM quick reference) + Bestiary module (thousands of monsters).
  Note: our package format is capable of carrying this (manifest + packs), the gap is the
  *data*, and much of it is licensing-adjacent (Paizo content) rather than engineering.
- **G-19 — No adventure/module content support.** **Med.**
  Both platforms sell/import Paizo adventures (maps, tokens, journals, encounters).
  Us: world files carry campaign state but there is no adventure-content pipeline.

### D. Combat & table flow

- **G-20 — Chat-card apply buttons for arbitrary rolls.** **Med.**
  FVTT: damage/heal buttons on chat cards. R20: roll templates auto-apply HP. Us: our
  resolve flows write HP authoritatively (stronger for PF1e), but an arbitrary GM roll
  cannot be "applied" to a token from chat.
- **G-21 — Condition-automation tails.** **Low-Med.**
  We implement the major ones natively (dying ticks, fast healing/regen, temp HP,
  condition library, durations). Missing ecosystem-level behaviors: blind-movement
  Acrobatics check, confused behavior messages, auto-prone chains, concealment
  total/normal prompt. *(Internal: P4/L07 tails.)*
- **G-22 — Player-side table surface is thin.** **Med.**
  Us: player sidebar = chat + sheet only. R20/FVTT players get their own sidebar with
  sheet, quickbar, macros, combat tracker visibility. *(Internal: L07 "player-sidebar
  parity".)*
- **G-23 — Initiative micro-controls.** **Low.**
  R20: dice engine can set/increment/decrement initiative values; fine-grained manual
  editing. Us: roll for selected tokens, reroll, defeat/delay — no direct number edit.

### E. Canvas, scene & map tools

- **G-24 — Sight is not bounded by lighting.** **High.**
  Our lighting renders (additive, darkness, ambient color) but vision ignores light:
  "tokens see through darkness" — sight is limited only by walls/doors/optional range.
  R20: dynamic lighting = line-of-sight (token light sources, night vision). FVTT:
  best-in-class lighting with real LOS and per-token vision. This is the single biggest
  *platform* gap vs. both. *(Internal: ROADMAP fog follow-up — known, open.)*
- **G-25 — Fog-of-war GM tools.** **Med.**
  We have per-user explored fog + token gating + GM god view (ahead of R20 free tier).
  Missing: manual GM brushes (reveal-all / hide-all / paint), GM "view as player X".
  Both competitors have manual reveal tools and per-player views. *(Internal: ROADMAP
  fog follow-ups.)*
- **G-26 — Light source animation & richness.** **Low.**
  FVTT: 13 animated light types (torch flicker, domes…), darkness sources, priorities.
  Us: static lights.
- **G-27 — Windows / wall variety.** **Low.**
  FVTT: doors **and windows** (light passes, sight configurable). Us: doors with
  sight/light/sound/move restriction; no window primitive.
- **G-28 — Drawing shape set.** **Low.**
  FVTT: freehand/straight/rectangle/ellipse/text. Us: freehand/poly/rect/text (no
  straight-segment and ellipse tools).
- **G-29 — Soundboard & audio streaming (TTS).** **Med.**
  R20: soundboard (core) + audio streaming (file/TTS). FVTT: playlists (core); ambient/
  position-dependent sound via modules. Us: playlists only.
- **G-30 — Screen sharing.** **Low (R20 parity only).** R20 has it core; FVTT via module.
  Us: none (video/voice mesh ≤ 6 exists).
- **G-31 — Views/bookmarks on a map; scene background video.** **Low.**
  R20 "Views"; FVTT video backgrounds + module bookmarks. Us: images only, no bookmarks.
- **G-32 — Host-side token hiding (anti-cheat fog).** **Low (known limitation).**
  Our D-251 token gating is client-side (position still reaches the player replica).
  Not a competitor feature, listed for completeness. *(Internal: ROADMAP fog follow-up.)*

### F. Communication & collaboration

- **G-33 — User accounts & multi-device worlds.** **Arch (design difference).**
  R20: accounts + cloud campaigns. FVTT: self-hosted server, user accounts, persistent
  worlds, per-player permissions, second-GM logins. Us: browser-only, GM tab is the
  world; "accounts" are join codes/permissions. Consequences: no world sync between a
  GM's devices, no persistent hosted world. This is the core architectural bet of the
  project (see README), not a bug — but it bounds collaboration features.
- **G-34 — Dedicated mobile apps.** **Arch/Low.**
  R20: iPad/Android apps. FVTT: PWA + browser. Us: PWA only.
- **G-35 — Marketplace / distribution.** **Arch.**
  R20 marketplace (Paizo modules, maps, tokens, sheets); FVTT module/content directory.
  Us: local world-file/package zips only — no store, no one-click install, no Paizo
  licensed content channel.

### G. Ecosystem & extensibility

- **G-36 — Module ecosystem (not API).** **High (strategic).**
  The API is in place (sandboxed iframe `game.*` + trusted in-page, Hooks, settings,
  chat, token intents) and is genuinely Foundry-like in shape. What is missing is the
  *ecosystem*: hundreds of community PF1e modules (alt sheets, item hints, loot sheets,
  PFS, bestiary, buff/condition/metamagic/polymorph automation, statblock converter,
  buff activator, spellbook generator). A GM coming from either platform expects
  "install a module and it just works".
- **G-37 — Campaign-wide scripting (R20 API scripts).** **Med.**
  R20's campaign-level JavaScript API enables huge companion scripts (the PF
  Companion-Script ecosystem). Us: module API is package-scoped; no campaign-wide script
  surface.
- **G-38 — Localizations.** **Med.**
  R20 and FVTT ship official translations (FVTT: EN/DE/ES/FR/IT/…; R20: multilingual
  UI). Us: `src/ui/i18n/` is an empty barrel — not started.
- **G-39 — No character/world import from the other platforms.** **Med.**
  R20 imports HeroLab and (via character manager) Foundry; FVTT has importers
  (beyond20, statblock converter). Us: nothing — a PF1e table migrating in from
  Roll20/Foundry must rebuild every character by hand. A high-friction on-ramp gap.

### H. UX & platform completeness

- **G-40 — Visual polish / theming.** **Low.**
  Themes, dark mode, portraits/frames, dice/token animations: both competitors (and their
  module ecosystems) are far ahead. *(Internal: L07.)*
- **G-41 — In-app help, onboarding, docs links.** **Low.** Both have in-app guides.
- **G-42 — Firefox/WebKit acceptance of the shipped app.** **Med (quality, not feature).**
  The suite is Chromium-accepted only; the cross-browser matrix is an open, explicitly
  deferred acceptance item. *(Internal: D-082/D-222 precedent.)*

---

## 5. Suggested prioritization (competitor-parity view)

**Tier 1 — "a PF1e table can't realistically play" gaps**
1. G-24 sight bounded by lighting (platform; already scoped in ROADMAP)
2. G-01 skills system (sheet)
3. G-02 character creation/leveling workflow (sheet)
4. G-03 inventory + encumbrance + currency (sheet)
5. G-18 content scale (data/packaging problem more than code problem)

**Tier 2 — "regulars will notice immediately"**
6. G-25 fog GM tools (brushes, view-as) · G-22 player sidebar parity (quickbar, tracker)
7. G-10a token HP bars + G-10b player quickbar
8. G-06 feat/class-feature automation (Sneak Attack, Smite, Rage, TWF) + G-17 TWF/misfire
9. G-07 spell catalog scale + spell points + metamagic
10. G-08 statblock import + G-39 import from Roll20/Foundry/HeroLab
11. G-38 localizations

**Tier 3 — "power users / ecosystem"**
12. G-36 module ecosystem enablement (docs, hub, exemplar modules)
13. G-05 magic items + G-04 item-document automation
14. G-11 non-combat resolution · G-12 polymorph · G-13 house rules (opt-in)
15. G-29 soundboard/TTS · G-26 light animation · G-30 screen share · G-31 views
16. G-42 cross-browser acceptance (quality gate)

Deliberately **not** in the plan (Arch items, design choices): G-33 accounts/server,
G-34 mobile apps, G-35 marketplace — each would contradict the serverless single-file
identity; revisit only by explicit scope decision.

---

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
