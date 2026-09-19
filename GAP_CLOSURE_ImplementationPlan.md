# Implementation Plan — Closing the Roll20/Foundry Gaps

**Date:** 2026-09-19 · **Base:** `arena/01a0ba36-arenastar-vtt` @ `8ce5097`
**Closes/feeds:** `GAP_ANALYSIS_Roll20_Foundry.md` (G-01…G-42), Tier 1 + Tier 2 first.
**Reads with:** `PF1e_Unified_TODO.md` (L01–L07 deferred backlog), `ROADMAP.md` (fog follow-ups),
`DECISIONS.md` (D-112 effect constraint, D-113 data contract, §12 package contracts).

**Size domains (decision, user 2026-09-19, per the world-file packaging that landed in
PR #24 / D-248–D-249):** there are exactly two domains.
1. **App body** = `dist/index.html` (all app code + the PF1e *tactical* rules compiled in
   as trusted in-repo code). Constrained by the `pnpm size` **6 MB raw gate** (verified:
   `scripts/size.mjs` reads only `dist/index.html`) and the **2,000-entry compendium cap**
   (`src/core/compendium.ts`) — both are app-body guards.
2. **World zip** = the self-contained campaign file (format 2): `world.json` (+
   `rules.active`) + `packages.json` + **`packages/<id>/…` — the strategic *ruleset*
   (manifest + `rules.js` + its packs) and the *content packs* embedded side by side** —
   plus documents/oplog, fog, checkpoints, reports, assets. **Everything inside the world
   zip — ruleset included — may be any size.** A package zip alone is an *ingredient* the
   New-world wizard / "New world with it…" / Settings content-adder consumes; the
   canonical artifact is the world file ("starter worlds … are the same file the
   New-world wizard would have produced from the two packages" — D-249).

Consequences applied throughout this plan: the 2,000-entry guard does not apply to
world-zip packages — ruleset or content (§2.5.1); world-file growth is a UX note, not a
gate (§2.5.5); the app body itself is untouched by all of Phase 1/6 (§7).

Three things this plan must answer, in order:
1. How to close the gap list in a sequence that respects the existing architecture
   (serverless single file app ≤ 6 MB, GM-tab host, trusted-in-repo tactical rules,
   data-only content packs inside world zips, ≤200 B/model strategic budget untouched).
2. **Can we adapt Foundry's PF-Content as a standalone module?** — Yes: the
   engineering is ready (§2). **This is a transfer pipeline** — each asset's legal
   status is a **case-by-case decision by the legal people**; the plan records the
   license facts and carries a `legalStatus` per item, and pre-adjudicates nothing.
3. **Can we transfer Foundry scripts and spell/attack animations?** — The pipeline
   transfers; per-asset legal status is case-by-case (most Foundry *code* is GPL or
   unlicensed — the pipeline records that and the typical postures: clean-room
   re-implementation, MIT adoption with attribution, negotiated permission, skip).
   Animations: engine is original; assets arrive by three routes (§6.3). Foundry's
   *PF1e* animation ecosystem is nearly empty, so original assets are also a
   differentiator. To make transfer **robust — repeatable, auditable,
   regression-protected** — Phases 5/6 run on the **transfer pipeline** in §5.5.

---

## 1. Phase 0 — Feasibility spike & transfer-pipeline foundation

**This plan is a transfer pipeline.** Engineering builds the pipeline; **legal status of
each transferred asset is decided case-by-case by the legal people** — in deals, not in
this document. The pipeline's job regarding legal: record verified license facts per
asset, carry a `legalStatus` field per item (pending → approved / negotiated /
rejected), and make each case cheap to decide and cheap to audit. Nothing below is a
legal verdict; it is input for the cases.

### 1.1 License facts (verified against repos, 2026-09-19 — input to case-by-case review)

| Asset | License (verified) | Posture options (for Legal's case) |
|---|---|---|
| Paizo PF1e rules text / item / monster **data** (as shipped in pf1 system, pf1e-content, pf1e-archetypes — all ship `OGL.txt`) | **Open Game License 1.0a** | Standard case: ship with OGL notice + CREDITS. Note for any future paid-distribution case: OGL content may not be sold. |
| `foundryvtt-pathfinder1` system **code** (module/*.mjs, sheets, roll logic) | **GPL-3.0** (project page: "software … GNUv3 … game content … OGL 1.0a") | Clean-room re-implementation of the logic (keeps the case minimal), or a licensing deal for specific module units if we want the code itself. |
| `baileymh/pf1e-content` **code/conversion scripts** | **GPL-3.0** (`LICENSE.md`) | The **data** (per-entry JSON, §2.1) is the OGL case above; the scripts are a separate GPL case. |
| `jackkerouac/animated-spell-effects` (450+ transparent top-down .webm spell FX) | **GPL-3.0** (repo LICENSE) | Permission/negotiation case (the author is reachable), or original assets (§6.3). |
| `Feu-Secret/Tokenmagic` (FX engine for tokens/tiles/templates) | **GPL-3.0** | Behavior re-implementation (our FX engine does not need it), or a deal. |
| `Autumn225/universal-animations` (item→animation mapping, school/damage color matrix, hit/miss/crit variants) | **MIT** | Standard case: adopt with attribution (license header + NOTICE entry). |
| `magnusnordstrom/animated-token`, `magnusnordstrom/particle-effects`, `SvenWerlen/fvtt-data-toolbox` | **No LICENSE file** (all rights reserved by default) | Ask the authors (case), or don't use; writing our own is cheap for the small pieces we'd need. |
| JB2A Animated Assets | Free tier: custom terms; paid tier: subscription | User-supplied via `fx.json` provenance, or a deal. |
| **Our own repo** | **No LICENSE file today** | Project/legal item (§1.2.1) — tracked, non-blocking for pipeline construction. |

### 1.2 Items tracked (none block pipeline construction)

0. **Per-asset legal status is case-by-case, owned by Legal.** Each inventory row and
   adoption card carries `legalStatus`; an asset ships only with its case closed
   (approved / negotiated / rejected-by-us). **Engineering default posture while a case
   is pending** (posture, not a legal rule): no third-party code committed without a
   sign-off record; clean-room re-implementation preferred for GPL-derived logic (keeps
   cases small and fast); OGL data packaged with OGL notice + CREDITS as standard.
1. **License for ArenaStar_VTT** (currently unlicensed). Project/legal item; needed
   before attributing third-party code in the repo or accepting community contributions
   — not needed to build the pipeline. Recommendation for the case: permissive code
   license + OGL notice alongside for content; document in `README.md` + `LEGAL.md`.
2. **Icon/art policy.** OGL data entries reference `systems/pf1/icons/…` paths (Paizo
   Community-Use artwork). No size gate applies (world zips are uncapped), so this is a
   *preference/weight* decision: (a) ship the system's icon set with Paizo attribution,
   (b) generate our own category glyphs (spell schools, item types) + neutral monster
   icons, (c) hybrid (recommended: system icons where the pack already has them, our
   category glyphs as fallback). Per-entry monster artwork: include from source where
   present; fallback generated from statblocks on demand.
3. **3PP content gate.** Elephant-in-the-Room, Kingdom Building, 3.5 content: separate
   opt-in packs flagged `thirdParty: true` (L06 convention) or exclude — scope decision.
4. **Bestiary source & size.** The official PF1 Bestiary module lives on GitLab
   (release zip); measure total size and per-entry shape in the spike (§2.2). If it ships
   only packed `.db` files (no per-entry JSON), the converter gains a `.db` decoder
   (Foundry compendium pack format; write our own — reusing data-toolbox would be a
   legal case; writing it is a day).

### 1.3 Feasibility spike (1–2 days, output = go/no-go + numbers)

- Clone/fetch three sources (pf1e-content per-entry JSON; pf1 system release zip with
  `packs/`; PF1 Bestiary release zip). Record: total entries, raw JSON bytes, zipped bytes,
  entries with embedded data-URI images, entries carrying `scriptCalls`.
- Convert a **500-entry sample** of `pf-feats` with a draft of the converter (§2.3),
  build a data-only package zip, import it in a booted world over `file://`, drag-import
  5 entries, assert derived values. Measure: import time, memory, compendium search latency.
- Deliver: `tools/content/REPORT.md` with sizes, drop-report, and the exact go/no-go
  against our constraints (package zip size, compendium index memory, 6 MB single file
  untouched).

---

## 2. Phase 1 — PF-Content as a standalone module (the content pipeline)

**Question answered:** yes — a data-only §12 package, built by an offline converter,
installed by `build:worlds` into the full-content PF1e starter **world zip** (uncapped),
also importable standalone via the existing "Open file (.zip)" / New-world-with-it flow.
Nothing in the 6 MB app body (`index.html`) changes; content is the same class of package
artifact as the shipped `systems/*` zips, kept **out of git** per the repo's ignore
convention.

### 2.1 Source shape (verified)

`baileymh/pf1e-content` keeps the *source of truth* as **one JSON file per entry** under
`src/packs/<pack>/<Name>-<id>.json` (21,775 files, ~119 MB raw JSON; packed `.db` files are
Foundry's IndexedDB derivative — we don't need them). 34 packs:

| pack | entries | | pack | entries |
|---|---|---|---|---|
| pf-class-abilities | 4,727 | | pf-magic | 790 |
| pf-feats | 3,541 | | pf-goods-services | 531 |
| pf-wondrous | 3,008 | | pf-artifacts | 409 |
| pf-traits | 1,915 | | pf-deities | 464 |
| pf-racial-traits | 1,214 | | pf-eidolon-evolutions | 109 |
| pf-items | 1,474 | | pf-maladies / occult-rituals / traps-haunts / UMR | 101 / 77 / 88 / 147 |
| pf-familiars / pf-companions | 175 / 209 | | pf-rules / gm-quick-reference / tables | 895 / 25 / 28 |

Plus the **pf1 system's own packs** (from its release): `spells` (core), `classes`
(with per-level feature progression), `races`, `feats`, `items`, `weapons-and-ammo`,
`armors-and-shields`, `ultimate-equipment`, `buffs`, `rules`, `roll-tables`,
`basic-monsters`, `monster-templates`, `mythic-paths`, `technology`, `companion-features`.
And the **PF1 Bestiary module** (monsters) — size TBD in the spike.

Sample entry shape (pf-feats/Aberrant-Tumor, verified): `name`, `type: "feat"`, `img`,
`system.description.{value,chat,unidentified}` (HTML), `system.tags` (PFS + book tags),
`system.actions[]` (attack actions), `system.uses` (charges), `system.changes[]`
(path+mode+priority stat changes), `system.flags.{boolean,dictionary}` (e.g.
`loseDexToAC`), `system.scriptCalls[]` (module-API calls), `system.classSkills`,
`system.abilityType`, `system.duration`, `system.links.children` (nested features),
`system.unchainedAction`.

### 2.2 Architecture

```
tools/content/                      (Node, dev-only, NOT shipped, git-ignored outputs)
  fetch.sh / fetch.mjs              clone sources into tools/content/vendor/ (git-ignored)
  convert/
    index.mjs                       orchestration: pack → entry mapping, drop report
    mapFeat.mjs mapSpell.mjs mapItem.mjs mapClass.mjs mapRace.mjs
    mapCompanion.mjs mapCreature.mjs mapTable.mjs mapJournal.mjs
    html.mjs                        HTML → safe format (decision §2.4)
    report.mjs                      field drop report + OGL attribution rollup
  build-content.mjs                 → dist/content/pf1e-core-full-<ver>.zip etc.
```

- Emits **data-only packages** (`manifest.json` `type: "data"`, packs/*, optional
  assets/) through the same zip/manifest machinery as `build:systems` — add
  `pnpm build:content` to package.json. Output goes to `dist/content/` (git-ignored),
  never into `systems/` (which stays hand-authored and in git).
- **Delivery model (world-file packaging that landed in PR #24, D-248/D-249):** the
  **world file is the only canonical artifact** — format 2 embeds the strategic
  ruleset and every content pack side by side under `packages/<id>/…` (indexed by
  `packages.json`, pinned by `world.json.rules.active`); world zips are **uncapped in
  size**. A package zip alone is an *ingredient*: the start screen's sniffing
  **Open file (.zip)** offers it as **New world with it…** (opens the wizard pre-loaded),
  and in-world **Settings → Strategic ruleset & content** adds content packs to a fresh
  campaign (the section pins once a checkpoint exists — D-249).
- Build paths (all existing machinery, zero new writer code):
  - The starter writer (`scripts/buildStarterWorlds.mjs`) already embeds the ruleset
    **plus every content pack the ruleset declares as a `dependency`** (verified in
    source). So the full-content starter is: drop the converted packs under
    `systems/` + add them to `pf1e-mass-battles`' manifest `dependencies` (and the
    `STARTERS` recipe) → `pnpm build:worlds` emits
    **`pf1e-full-starter-<ver>.zip`** — **any size**, one file, "play a real PF1e
    table". Per D-249 the starter ships *without* documents (the host seeds on first
    boot); pre-placed demo content is the ROADMAP "starter worlds with seed content"
    follow-up, not part of this phase.
  - **Open file (.zip)** → "New world with it…" for a standalone full-content package
    zip (same ingredient path, no build needed);
  - **Settings → Strategic ruleset & content** → add the content pack to an existing
    fresh campaign.
- Versioning: content packs carry their own `version` + `migrations` if the *entry shape*
  changes; world files pin installed package versions (already supported, §12).

### 2.3 Data model mapping (Foundry item → our `CompendiumEntry.data`)

Target collection per source type:

| Foundry type | Our collection | `system` payload (new `kind` field under `system.pf1e`) |
|---|---|---|
| feat | `items` | `kind:"feat"`, description, `classSkills?`, `uses?`, `flags`, `changes[]` |
| spell (core) | `items` | `kind:"spell"`, level, school, components, range, castingTime, duration, save, damage, targets |
| wondrous / magic / artifact | `items` | `kind` per class, price, weight, `uses` (charges), properties, `changes[]`, `actions[]` |
| weapon / armor / ammo / goods | `items` | `kind:"weapon"|"armor"|"item"`, proficiencies, special qualities, price, weight |
| class | `items` | `kind:"class"`, hd, babProgression, goodSaves, spellcasting, `classSkills`, **`levels[]`** (per-level features + chosen-feature prompts) — the data backbone of character building (Phase 2) |
| race | `items` | `kind:"race"`, sizeMod, traits, speeds |
| companion / familiar / eidolon | `actors` | full actor with level progression |
| creature (bestiary) | `actors` | our existing `statBlock` shape (already has monster tab support) + `abilities` as attached items |
| UMR / monster ability / class ability | `items` | `kind:"ability"`, `changes[]`, description |
| trait / racial trait | `items` | `kind:"trait"`, `changes[]` |
| table | `tables` | rows → our roll-table document |
| rule / GM quick reference | `pages` | journal entries (GM reference library in-world) |
| deity | `actors` or `pages` | decision in spike (actors if they carry stats) |

Field-level rules:
- **`changes[]`** (Foundry active effects: `path`, `mode: custom|add|mul|override`,
  `priority`, `value`, `flags`) → **the one mechanics upgrade this pipeline forces**:
  extend the *PF1e effect payload* (`flags.pf1e` — D-112 keeps core `EffectDocument`
  untouched) with a `changes` array evaluated in `derivePF1eActor` after the typed
  `PF1E_MOD` pass. This is what makes 15k OGL items *automate* rather than merely *display*.
  Priority order: typed mods keep existing stacking rules; untyped path-changes apply in
  `priority` order, `override` wins last. Unit-tested with Foundry fixtures.
- **`actions[]`** (attack actions with formulas/iterations/crits) → map onto our existing
  `PF1eAttackEntry` shape (combat tab renders it unchanged); formulas like
  `1d20 + @mod.bab` get a small **roll-token normalization** (Foundry `@mod.*`/`@item.*`
  → our `@dotted.path` dice substitution, which already exists in `src/dice/engine.ts`).
- **`uses`** (charges) → item charge ledger (new, tiny: `{max, value, per}`) — reused by
  consumables and the Phase-2 inventory.
- **`scriptCalls[]`** → **dropped**, counted per entry in the converter report
  (they target Foundry module APIs, e.g. `game.pf1.*`). The report becomes the
  "automation coverage" metric for content (e.g. "31% of feats lost a scriptCall;
  96% of their changes survive").
- **`links.children`** (nested features) → keep as pack-local slug references; the sheet
  renders them indented under the parent (parity with PF1E Alt Sheet Reworked).
- **`tags`** (PFS, book of origin) → `keywords` (searchable; PFS tag feeds future PFS
  module work).
- **Descriptions (HTML)** → see §2.4.

### 2.4 Description rendering (shared with journals, needed by Phase 1)

OGL text is HTML (`<p>`, `<br>`, `<strong>`, tables, blockquotes; rules compendium has
heavy tables). Our renderer is escape-first with a tiny subset. Decision:
- Extend `src/core/markdown.ts` with a **sanitized-HTML allowlist**: after escaping,
  re-accept a fixed tag set (`p, br, strong, b, em, i, u, ul, ol, li, blockquote, h1–h4,
  table, thead, tbody, tr, td, th, a[href^="http"], span`), strip all other tags and every
  attribute except `href` on `a`. Small hand-rolled tokenizer (no new dependency —
  single-file budget).
- The converter normalizes entries' HTML to this subset offline (unknown tags stripped
  there too, with a report line), so runtime cost is zero and the renderer stays trivial.

### 2.5 Scale engineering (the real work)

Per the size-domain decision (§1 top note), **none of these are size *limits*** — the
world zip is uncapped. They are *code + performance* changes so a 20k-entry, ~50 MB
world opens and stays responsive in a browser tab.

1. **`COMPENDIUM_MAX_ENTRIES = 2_000`** (`src/core/compendium.ts`) — today a flat parse
   cap in `parseCompendiumPack`, which `hostBoot.compendia()` applies to every compendium
   pack of every world-scoped package (`packages [worldId, id]` in IDB) — and that
   includes packs shipped by the strategic ruleset itself, not just content packs. It
   would reject pf-feats (3,541), pf-wondrous (3,008), pf-class-abilities (4,727). Under
   the size-domain decision the guard belongs to the **app-body domain only**; everything
   parsed from the world (ruleset packs + content packs, both embedded under
   `packages/<id>/…` in the world zip) is uncapped. Verified premise: **no compendium
   pack is compiled into `index.html` today** (nothing in `src/` reads `systems/**` at
   build or runtime — `spellPacks.ts`), so the change moves the cap from "all parsed
   packs" to "app-body content" with zero behavior loss. Implementation:
   `parseCompendiumPack(raw, { origin: "app" | "world" })` — world origin uncapped
   (with a parser sanity ceiling far above any real pack), app origin keeps 2,000.
   Not a security relaxation: the guard's purpose (app-body DoS surface) is preserved.
2. **Compendium panel scale:** search is currently a ranked in-memory pass per keystroke.
   At ~20k entries: precompute a per-pack index at parse time (prefix/word/contains
   buckets), virtualize the row list (reuse the Army roster windowing — 10k rows @ 60 FPS
   already proven), lazy-parse packs (parse a pack's entries on first open; keep a
   name+keywords index in memory). Target: keystroke search < 16 ms at 20k entries
   (frame-budget test, same pattern as V08).
3. **Package import path:** fflate-decompress a 30–80 MB zip in-tab. Spike (§1.3)
   measures this; if > ~30 s, add progress display + chunked parse (pack-by-pack).
4. **Memory:** 20k entries ≈ 60–120 MB raw JSON. Lazy per-pack parse (above) keeps the
   hot set at the opened pack (~4 MB). IDB `packages` store holds the zip once — fine.
5. **World file growth:** a full-content starter world zip ≈ content + ruleset + fog —
   expected 30–80 MB. **No gate** (world zips are any size by decision); the only follow-
   up is a README line setting expectations (download/extract time) so a 60 MB starter
   doesn't surprise a GM.
6. **Git hygiene:** `tools/content/vendor/` and `dist/content/` git-ignored (repo
   convention: generated artifacts stay out of git; 128 MB patchset cap is real). The
   world zip is a *release artifact / local file*, not a committed repo file.

### 2.6 Staged release (each stage shippable + tested independently)

| Stage | Contents | Closes |
|---|---|---|
| **1a — "PF1e Core"** | pf1 system packs: spells (core), classes (per-level features), races, feats (core), items/weapons/armor (+ultimate-equipment), buffs, rules, roll tables, basic monsters, technology, mythic paths (tagged) | G-07 (catalog), G-09 (races), foundation for G-02/G-03/G-05/G-06 |
| **1b — "PF1e Content"** | pf1e-content: feats 3,541 · wondrous 3,008 · class abilities 4,727 · traits 1,915 · racial traits 1,214 · magic 790 · items 1,474 · artifacts 409 · deities 464 · goods 531 · special qualities 334 · companions 209 · familiars 175 · eidolons · UMR 147 · buffs 220 · malady/rituals/traps/haunts · rules 895 · GM quick reference | G-18 (scale), G-05, G-06 (catalog side), G-11 (traps/disease/madness as *content*; mechanics still open) |
| **1c — "PF1e Bestiary"** | Core + Bestiary 1–3 first, then remainder (size per spike) | G-08, G-18 |
| **1d — "PF1e Optional"** | Elephant-in-the-Room, Kingdom Building, 3.5 (if decision §1.2.3 allows), each a separate opt-in pack flagged thirdParty | L06 convention |

### 2.7 Acceptance (per stage)

- Converter golden: N source entries → N pack entries; field drop report matches
  allowlisted drops; 20 manually spot-checked entries identical in meaning to source
  (fixtures in `tests/content/`).
- OGL notice + CREDITS present in the zip; `LEGAL.md` records the license facts and
  the per-asset legal-status register for this stage's packs.
- E2E (Chromium): import stage zip in booted world → compendium lists/searches all packs →
  drag-import spell/feat/item/class/monster → actor derived stats correct (reuse the
  AC 18/13/15 fixture pattern) → world export round-trips the pack (world file carries it).
- **C1 content-behavior corpus seeded** (§5.5 P-4): the golden items for this stage's
  kinds (a `changes[]` feat, a `uses` consumable, a class with `levels[]`) pass as
  fixtures now and re-run on every later mechanic change — this is what keeps
  15k-item automation honest as the data grows.
- Scale: 20k-entry search < 16 ms, import < 30 s (or with progress), memory hot set ≤ 8 MB.

---

## 3. Phase 2 — Character construction & inventory on the content (G-01/G-02/G-03/G-04)

The sheet work the gap list calls "a table can't play without". Depends on Phase 1a data
(classes with `levels[]`, races, feats, items) and the §2.3 `changes` mechanic.

1. **Skills system (G-01).**
   - Data: `system.pf1e.skills` = 15 skills × `{ranks, classSkill?}`; `classSkills` arrive
     from class items; skill points/level (3 or 4 + Int mod) computed (transcription
     T1, §5).
   - Sheet: Skills tab (grid, Take 10/20 indicators per SRD), skill-check roll flow reusing
     the resolve plumbing (host roll, roll card with modifier chips).
   - Buffable: skill modifiers flow through the typed mod list (`perception`, `stealth`
     exist; extend `PF1E_MOD_KEYS` for the 15 skills — closed list stays the design).
2. **Character builder / leveling (G-02).**
   - Create-actor wizard: race (drag/select) → abilities (point buy OR standard; both are
     pure formulas) → class per level (drag class items; per-level features auto-added
     from `levels[]`; "chosen feature" slots prompt a picker over pack entries — the
     Foundry drag-and-drop workflow, adapted to our op-based sheet).
   - Level-up: XP threshold table (T4), roll HP (or average), add next level's features,
     new feat at odd levels. All through the existing authorized-submit op path (S03
     pattern) so players can do it for owned characters.
   - Multiclass: multiple class items on one actor; BAB/good-save/HP aggregation rules
     (transcription T2).
3. **Inventory & encumbrance (G-03/G-04).**
   - Items tab on the sheet (ItemDocument-backed, embedded in actor — core contract
     already has `ActorDocument.items`): rows = icon/name/qty/price/weight, equipped
     toggle, charges (`uses`), containers (nested), currency (pp/gp/sp/cp).
   - Encumbrance bar: Str-based carrying capacity + Muleback-style Str bonus field +
     dwarf rule as a world setting (transcription T3).
   - Equipment linkage: worn armor → existing AC derivation; weapon item → combat-tab
     attack action ("create attack" parity); consumables (potion/wand/scroll) auto-created
     from a spell (Foundry FAQ parity), charges decrement on use.
   - Item sheet window (description via §2.4 renderer, properties, `changes` preview,
     hint chips — see §5.4 Item Hints parity).
4. **Sheet UX tails (G-10):** per-character settings section, notes field, token HP bar
   (Pixi label under hero token; data already derived), read-only player view unchanged.

**Acceptance:** a GM creates a level-5 two-class fighter with inventory from the Core
pack in < 10 minutes (timed e2e on fixtures: AC/HP/saves/skills/encumbrance all derived
correctly; a feat's `changes[]` visibly moves AC; a wand decrements charges).

---

## 4. Phase 3 — Platform parity: lighting-as-vision & fog tools (G-24/G-25)

Already scoped in `ROADMAP.md` fog follow-ups; kept as a phase for the full picture:
1. **Sight bounded by darkness/light:** per-token vision = sight range ∩ light
   (bright/dim) ∩ LOS polygons (existing `vision.worker.ts` angular sweep). Darkness
   level + light sources already render; gate the *explored-fog reveal* and token
   visibility on light state. Token light/darkvision/low-light-vision settings (Foundry
   FAQ parity).
2. **Fog GM tools:** reveal-all / hide-all / paint brushes (host-side fog ops), GM
   "view as player X" (GM-only fog.get of the stored per-user map — already identified
   as the mechanism in ROADMAP).
3. **Token gating host-side** (ROADMAP item): host runs each player's sight or trusts the
   player's fog.put for position withholding — pick per the §16 review.

Sequencing note: independent of Phases 1–2; can run in parallel once Phase 0 is done.

## 5. Phase 4–6 — "Scripts" and animations

### 5.1 What "transferring Foundry scripts" can mean (and the default handling)

The pipeline transfers; **legal status is case-by-case** (owner: Legal — a negotiated
deal can move any row). The column below is the *default handling* the pipeline proposes
for each license class to keep each case fast; it is a recommendation to Legal, not a
verdict.

| Category | Examples | License class | Default handling (proposed to Legal) |
|---|---|---|---|
| pf1 system code | sheet logic, roll data, chat cards, effect processing | GPL-3.0 | Clean-room transcription of the *logic* (§5.2) — keeps the case minimal; direct code transfer only if Legal secures a deal |
| GPL modules | Tokenmagic, pf1e-content scripts | GPL-3.0 | Re-implement the behavior our FX/rules engine needs; direct transfer only via deal |
| Unlicensed code | data-toolbox, animated-token, particle-effects | none (all rights reserved) | Ask the authors for a grant (case); default otherwise = write the small piece ourselves |
| MIT code | universal-animations (item→FX mapping, color matrices, hit/miss/crit variants) | MIT | Adopt with attribution (header + NOTICE), adapted to our Pixi FX engine (§6) |
| R20 API companion scripts | PF Companion-Script | community | Different platform; our analog is the existing §12 module API — not a port |

### 5.2 Clean-room transcriptions (spec = GPL code + SRD/AoN, output = our pure modules + fixtures)

Same method as the landed PF1e work (transcribe → verify against AoN rule IDs → fixture
tests). Ordered by Phase-2 dependency:

- **T1 — Skill point & check rules** (ranks/level, class skill +1, Take 10/20 conditions).
- **T2 — BAB/save/HP aggregation for multiclass** (best-BAB rule, good-save list, HP min 1).
- **T3 — Encumbrance formulas** (load thresholds, Str bonus, dwarf rule).
- **T4 — XP thresholds & level-up feature scheduling** (from class item `levels[]` schema).
- **T5 — Spell preparation arithmetic** (prepared/known/spontaneous, domain/school slots,
  bonus spells, spell points) — feeds the spellbook tab.
- **T6 — Consumable DC/damage formulas** (potion/wand/scroll from spell level + CL).

Each T = one pure module under `src/packages/pf1e/` + tests; no UI until the Phase-2
consumer exists. This is the pipeline's *default* for GPL-derived logic: we ship our own
code + primary-source fixtures, which keeps each legal case small and fast. If Legal
secures a deal on specific units, direct transfer is available per item — the adoption
card records whichever outcome.

### 5.3 Adopt (MIT): item→animation mapping

`universal-animations` (Autumn225, MIT): the mapping layer — item properties → animation
choice, color matrix by school/damage flavor, hit/miss/crit/save-variant selection,
multi-step sequences (attack → impact → damage). Port the *logic* (not the DOM/Sequencer
glue) into our FX engine's mapping module, keep the MIT header, add `NOTICE.md` entry.

### 5.5 The adoption pipeline (scripts & FX) — turning Phase 5/6 into a process

Phases 1, 5 and 6 above are per-item decisions. To make Foundry script/animation
adoption **robust — repeatable, licensed-auditable, regression-protected** — they run on
one pipeline, which deliberately generalizes the pattern this repo already proves at
scale (PF1e: reconciliation tasks R01–R03 → transcribe against primary sources →
`@srd`-cited fixtures → V01–V11 verification gates → DECISIONS entries).

**P-1. Inventory (the transfer backlog).** `tools/adopt/INVENTORY.md`, maintained in
every Phase 5/6 slice: one row per candidate (pf1 system `module/*.mjs` units; community
modules: Improved Conditions, Nevela suite, Koboldworks, Tokenmagic,
universal-animations, sequencer-style engines) with columns: license **verified at a
commit hash** · **`legalStatus` (pending → approved / negotiated / rejected — set by
Legal, case-by-case)** · target area (data / rule logic / sheet behavior / canvas FX) ·
our consumer (which phase needs it) · transfer approach (transcribe / adapt / port
direct / emulate / skip). Nothing is transferred without an inventory row; nothing ships
without its row closed *and* its legal case closed.

**P-2. Adoption card (per item, in DECISIONS.md).** Source citation (repo + commit +
file/line, *or* AoN rule ID), behavior spec, **legal review record** (case reference,
outcome, sign-off — the `legalStatus` transition per P-3), implementation pointer,
conformance corpus reference (P-4). Same reviewable-slice discipline as
D-239…D-246.

**P-3. Legal review — case-by-case (owner: Legal).** The pipeline's job is to make
each case cheap to decide and cheap to audit: verified license facts per asset (at a
commit hash), provenance recorded, and a `legalStatus` per item. **Legal decides each
asset in its case — including negotiated deals that move any row below.** The table is
the pipeline's proposed *default posture* to keep cases fast; it is an input, not a
verdict.
| Class | Default posture (proposed to Legal, overridable per case) | Provenance mechanism |
|---|---|---|
| OGL 1.0a data | Adopt — ship with OGL notice + CREDITS | `OGL.txt` + CREDITS in the zip; per-entry book tags carried as `keywords` |
| MIT code | Adopt with attribution | License header + `NOTICE.md` entry |
| GPL code (pf1 system, Tokenmagic, pf1e-content scripts, ASE) | Clean-room re-implementation of the logic/behavior (keeps the case minimal and fast); **direct code transfer is on the table whenever Legal secures a deal** — the pipeline records whichever outcome | Adoption card cites repo + commit; for re-implementation, fixtures come from primary sources (SRD/AoN — the R02 standard) |
| Unlicensed (animated-token, particle-effects, data-toolbox) | Ask the authors for a grant (case); default otherwise = don't use / write the small piece ourselves | Grant recorded in the adoption card |
| Paid/custom (JB2A) | User-supplied via `fx.json`, or a deal | Per-asset license + author field (P-5) |

The one **process rule** (project policy, not a legal verdict): **nothing ships without
its case closed** — `legalStatus` set and sign-off recorded on the adoption card. That
is what makes case-by-case auditable instead of ad-hoc. *Engineering default posture
while a case is pending* (so the repo never sits on an open case): no third-party code
committed without a sign-off record; clean-room preferred for GPL-derived logic; OGL
data packaged with notice + CREDITS by default.

**P-4. Conformance corpora (the robustness core — adoption is a *process* because it is
measured and re-run).** All four are V-gate members (run in V10):
- **C1 — Content behavior corpus:** ~50 golden items across kinds (feat with
  `changes[]`, weapon with `actions[]`, consumable with `uses`, class with `levels[]`,
  armor with properties) with hand-verified expected outcomes (derived stats, attack
  resolution, charge decrement). Re-runs on every `changes`-mechanic/resolver change —
  this is what keeps 15k-item automation honest as the data grows.
- **C2 — Rule-logic corpus:** T1–T6 + adopted automation as pure-function fixtures with
  AoN citations, same shape as the existing `@srd` test suite that `scripts/coverage.mjs`
  already audits ("every implemented item carries test evidence").
- **C3 — FX playback corpus:** every FX declared in a shipped pack plays once
  headless; assertions: it renders, it disposes after its duration, frame budget holds
  (V08 pattern). Re-runs on every FX-engine change; also the license/manifest validator's
  acceptance path.
- **C4 — Module-API conformance:** 2–3 "canon" modules (ours, MIT) written against the
  Foundry-style call patterns the P-6 mapping covers; e2e asserts the §12 RPC round-trips
  and hook deliveries. Doubles as the adoption guide for any future community module
  author, and pins the surface so extensions go through a decision, not drift.

**P-5. FX pack manifest v1 (`fx.json` inside a data package).** The contract that makes
third-party *asset* adoption robust instead of ad-hoc:
```
{ "version": 1,
  "assets": [ { "file": "fx/fireball.webm", "license": "MIT", "author": "…" } ],
  "entries": [ { "id": "fireball", "trigger": { "kind": "spell", "school": "evocation" },
                 "asset": "fx/fireball.webm", "kind": "video|sheet", "frames": 24,
                 "durationMs": 900, "palette": "fire", "scale": "template" } ] }
```
- Loader validation: license field present and in the known set (unknown → refuse, same
  posture as the OGL notice), asset file present, trigger validates against
  `fxTables.ts`; assets enter through the existing §7 OPFS hash-addressed asset pipeline
  (lazy-loaded; app body untouched).
- `fxTables.ts` (school/damage → palette/behavior, the MIT-ported mapping) is data, so
  packs can remap triggers without code.

**P-6. `scriptCalls[]` taxonomy → §12 module-API mapping.** Our module surface today
(verified in `src/core/moduleApi.ts`): RPC methods `game.info`, `settings.get/set`,
`tokens.list/move`, `chat.create`, `notify`, `hooks.subscribe`; hooks
`ready/snapshot/turnPhase/turnReport`. The pipeline keeps a mapping table:
Foundry call class (from the converter's drop report) → our surface → verdict:
covered · covered-with-translation · uncovered→drop (manual equivalent documented) ·
uncovered→extension **proposed in the adoption card** (moduleApi whitelist additions go
through §16 review — e.g. FX trigger events and roll-data reads are the two likely
first extensions; both are small and both already have host-side plumbing: `rollLedger`
and the ephemeral FX bus).

**Sequencing:** pipeline scaffolding (inventory skeleton + guardrails as a DECISIONS
entry + C1/C4 seeded + `fx.json` v1 + validator) lands right after Phase 0 — small, and
it turns every later Phase 5/6 slice into a pipeline run instead of an improvisation.

- **Improved Conditions / Nevela suite tails** (blind-movement Acrobatics check, confused
  round messages, auto-prone chains, total/normal concealment prompt) — G-21; these fit
  the existing effect/turn-tick machinery.
- **Koboldworks Item Hints** — hint chips on sheet item rows (save type, enhancement,
  aura, broken status) — pure rendering over our item data; cheap, high perceived polish.
- **Loot Sheet** — loot-container actor type + GM money split + player loot ops — G-03
  tail; medium value for campaigns, defer to Phase 2 tail or cut.
- **Chat-card apply buttons** (G-20) — damage/heal ops from arbitrary rolls, host
  authoritative (we already have the verified-roll plumbing; this is UI + one intent).
- **Player quickbar** (G-10b/G-22) — per-character action slots bound to item actions /
  attack actions; sidebar parity.

---

## 6. Phase 6 — Spell & attack animations (FX)

### 6.1 Finding (why this is an opportunity, not a chase)

Foundry's *PF1e* animation space is thin: the big packs (JB2A) are 5e-centric and
name-matched; generic engines (Sequencer, Token Magic, Automated Animations) are
GPL-licensed and DIY-heavy; reddit threads (2025) confirm "there is no pre-made pack made
for PF1e". Meanwhile our resolve flows already know *everything* an animation needs:
spell cast (school, area, DC, save outcome), attack (hit/miss/crit, weapon property,
damage type), condition applied. **A PF1e-native, rules-driven FX system is a
differentiator both competitors' PF1e ecosystems lack.**

### 6.2 Engine (original, in-repo — `src/canvas/layers/FxLayer.ts` + `src/canvas/fx/`)

- **FX = timed, ephemeral, non-persisted canvas effect** (same class as templates/
  ephemera): three backends, one API:
  1. **Procedural particles** (first, zero assets, zero licensing): sparks, frost
     crystals, arcane glints, poison mist, impact rings, sonic ripples — per damage type
     and school; capped emitters (≤ 8 concurrent), particle budget, offscreen culling.
  2. **Sprite sheets** (top-down, transparent, 8–24 frames): iconic spells (§6.3).
  3. **Video texture** (webm, later): for user-supplied packs; Pixi `VideoTexture`.
- **Triggers** (wired into existing flows, ephemeral broadcast to viewers only):
  - spell cast: area preview resolves → FX over the template area (school palette,
    save-success/failure intensity variants);
  - attack: token-level FX — swing/impact, hit/miss/crit variants, weapon-property FX
    (flaming → flame on hit; frost → on hit), DR absorbed → dampened variant;
  - condition apply: status FX (poison mist, burning) while the effect lives (low-rate
    particle, stops on expiry — the effect system already knows).
- **Mapping module** (MIT port, §5.3): PF1e-native tables —
  school → palette (evocation fire, conjuration light, necromancy green-grey, …),
  damage type → palette/behavior (acid/cold/electricity/fire/poison/sonic; slashing/
  piercing/bludgeoning impact styles), crit → amplified, save success → reduced.
  Tables are data (`src/packages/pf1e/fxTables.ts`) so content packs can override.
- **Budget:** FX inside the V08 frame-budget gate; e2e: cast fireball at 200 actors,
  p95 frame < 16.7 ms (particles), assert disposal after duration (no leaked textures).

### 6.3 Assets (original first, user-supplied second)

1. **Procedural-only release (P6a):** covers all attacks + a school-generic spell FX —
   ships in the single file (code only, ~tens of KB).
2. **Sprite-sheet pack (P6b):** generate top-down transparent keyframe sets for the ~40
   most iconic spells (Fireball, Cone of Cold, Wall of Fire, Lightning Bolt, Haste,
   Holy Smite, Sleep, Grease, …) via image generation + a sprite-packing script
   (`tools/fx/pack-sheets.mjs`, ffmpeg/skimage). Pack ships as a **content package**
   (rides in the **world zip** — uncapped — lazy-loaded per FX; never inlined into the
   6 MB app body). All rights ours.
3. **User-supplied packs (P6c):** the `fx.json` v1 manifest (§5.5 P-5) is the contract —
   versioned, per-asset license + provenance recorded, triggers validated against
   `fxTables.ts`; community can contribute. C3 (playback corpus) is the acceptance path
   for every pack that enters.
4. **Cleared third-party sets:** a negotiated permission (e.g. the 450-webm ASE set)
   enters through the *same* `fx.json` provenance path as everything else — one legal
   case among others, non-blocking, time-boxed.

### 6.4 What "transferring Foundry animations" means here

Each engine and asset is **its own legal case** (P-3); the engineering facts below are
the input to those cases, not the answer to them.

- **Engines (Sequencer/Token Magic/JB2A loader):** GPL/paid/custom — each is a
  candidate for a Legal case, but the *engineering* default is to not take them in:
  our canvas is PixiJS with a layer architecture, and a ~2–3 kLOC FX layer does ~80%
  of what those modules do for PF1e needs without the dependency chain. If a case
  clears a direct port, `fx.json` provenance + C4 make it viable either way.
- **Assets (spell/webm libraries):** every library is a case (some may be cleared by
  deal, some user-supplied, some not used). The pipeline is source-agnostic: any
  outcome lands through the same `fx.json` v1 contract with per-asset license +
  provenance and C3 playback regression (§5.5, §6.3).
- **Mapping logic:** MIT → the default posture is adopt with attribution (§5.3).

---

## 7. Cross-cutting

- **i18n (G-38):** start `src/ui/i18n` properly in the first Phase-2 slice (UI strings
  only; OGL content stays English with a translation *pass* later — foundryvtt-pathfinder1-fr
  proves community translation of this content is a viable follow-up).
- **Testing conventions:** converter goldens (§2.7), T1–T6 fixture tests (AoN-cited),
  frame-budget tests for compendium scale + FX, e2e per stage. Keep the V01–V11 gates
  green throughout (`pnpm test/typecheck/lint/build/size` + Chromium e2e).
- **Budgets (per the size-domain decision, §1 top):** the 6 MB raw gate measures
  `dist/index.html` only — the app body must stay green with zero content/FX inlined
  (content & FX lazy-load from the world zip). The strategic ruleset lives in the
  world zip (uncapped); its **data** budgets are untouched (≤200 B/model; `rules.js`
  stays a git-ignored build product). World zips: no gate, README note only.
- **Docs:** DECISIONS.md entries for each license/contract decision (package entry cap,
  changes-mechanic, FX asset policy, license choice); `LEGAL.md`; README quickstart gains
  the full-content starter world; `GAP_ANALYSIS_Roll20_Foundry.md` gets closure marks as
  phases land.
- **Cross-browser (G-42):** still deferred per standing decision; Chromium-only bar for
  acceptance continues.

## 8. Sequencing & relative effort

| # | Phase | Depends on | Effort | Lands |
|---|---|---|---|---|
| 0 | Feasibility spike + transfer-pipeline foundation (legal case-by-case process stood up; repo LICENSE decision) | — | S (1–2 d) | go/no-go, sizes, decisions |
| 5P | **Transfer-pipeline scaffolding** (§5.5): inventory skeleton + `legalStatus` column, case-by-case process DECISIONS entry, C1+C4 corpora seeded, `fx.json` v1 + loader validator | 0 | S–M | robust, regression-protected transfer process for scripts+FX |
| 1a | Core content pack + entry-cap relaxation + renderer + `changes` mechanic | 0 | M | G-07/09 + foundation |
| 2 | Builder + skills + inventory (+ T1–T4 transcriptions in parallel) | 1a | XL | G-01/02/03/04/10 |
| 1b | Full PF-Content conversion + scale perf | 0 (parallel with 2) | L | G-18, G-05, G-06 catalog |
| 1c | Bestiary | 0 (parallel) | L | G-08 |
| 3 | Lighting-as-vision + fog tools | 0 (parallel) | L | G-24/25 (ROADMAP items) |
| 4 | Table flow: player sidebar, quickbar, chat-apply, token bars | 2 | M | G-20/22/10 |
| 5 | T5/T6 transcriptions + automation tails + item hints | 1a/2 | M | G-21/23 tails |
| 6a | FX engine, procedural particles, triggers | 0 (independent) | M | first "wow" slice |
| 6b | Sprite-sheet pack (iconic spells) | 6a | M | spell FX |
| 6c | User-supplied pack format | 6a | S | ecosystem |

Critical path: **0 → 1a → 2 → 4**. **5P (adoption pipeline) runs immediately after 0**
so every later Phase 5/6 slice is a pipeline run (inventory row → adoption card →
corpus evidence), not an improvisation. Phases 1b/1c, 3, 5, 6a are all parallelizable
against the critical path. First externally-visible "wow" can be 6a (procedural FX on
the existing resolve flows) shipped *before* Phase 2 completes, if useful for morale/
review — and it carries its C3 playback corpus from the first commit.

## 9. Risks & open decisions

1. **No LICENSE in our repo** — does *not* gate the transfer pipeline (third-party
   assets are case-by-case, §5.5 P-3), but it is an open Phase-0 decision for **our
   own code's terms** (community contributions and anyone redistributing the app/world
   need to know them).
2. **Entry-cap change** (§2.5.1) — the 2,000 cap must move from a flat parse guard to
   the app-body domain (verified: no compendium pack is compiled into `index.html`, and
   every parsed pack is world-scoped — ruleset packs and content packs alike, both
   embedded in the world zip per D-248/D-249). Not a security weakening: the guard's
   purpose (app-body DoS surface) is preserved. Record the size-domain decision in
   DECISIONS.md so the cap's intent isn't later "restored" across the board.
3. **Icon/art policy** (Paizo Community-Use vs generated) — now a *weight/preference*
   choice, not a size gate (world zips uncapped). Still decide in the Phase 0 spike
   because it drives the CREDITS story and the starter-world download size.
4. **Bestiary format unknown until spike** (per-entry JSON vs .db only) — if .db only,
   budget a Foundry pack `.db` decoder (original code) into 1c.
5. **OGL no-charge constraint** — fine for the free single-file model; must be re-checked
   if any paid distribution is ever considered (would require stripping OGL content from
   the distribution).
6. **Git/patchset size** — vendor + converted data + content zips stay out of git
   (ignore rules already cover `dist/`); the 10k-entry/128 MB cumulative artifact cap is
   respected by construction.
7. **Scope discipline:** 3PP packs, PFS module, polymorph, house rules (G-13/14/16) stay
   out unless explicitly promoted — they are L-items, not gap-closers.
