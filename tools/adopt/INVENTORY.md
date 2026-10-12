# Adoption / transfer inventory (P-1)

One row per candidate we may transfer from Foundry or elsewhere. `legalStatus` is set by
**Legal, case-by-case** — every row starts `pending`. The license column is a **verified
fact at a pinned commit hash**, recorded as input to each case, not a verdict.

`legalStatus`: `pending` → `approved` | `negotiated` | `rejected`.

The two content sources this pipeline has actually fetched are pinned **in code** as well as here:
`tools/content/sources.json` (repo URL + exact commit + sparse paths + the licence fact) is what
`pnpm content:fetch` materialises and what the in-app credits panel shows. Changing a pin is
therefore an edit to that file, reviewed like any other change. Repo-level summary: `LEGAL.md`.

| # | Candidate | Target area | Consumer (phase) | License (verified @ commit) | legalStatus | Transfer approach (default) |
|---|-----------|-------------|------------------|------------------------------|-------------|------------------------------|
| 1 | `baileymh/pf1e-content` | Data (34 packs: feats, items, wondrous, class-abilities, traits, deities, magic, rules, …) | Phase 1b / 1c | OGL 1.0a content + GPLv3 code @ `baf5232c` (main, 2023-09-05) | pending | Adopt **data only** via converter (OGL notice + CREDITS); per-entry source JSON at `src/packs/<pack>/…` is the clean input |
| 2 | `FoundryPF1e/pf1` (system) | Rule logic + sheet behavior + its own data packs (spells, feats, races, classes, items, monsters, rules) | Phase 1a / 2 / 4 | GPLv3 + OGL 1.0a + Paizo Community-Use Policy @ mirror `681929d1` (2026-05-08) | pending | Data via converter; logic via **clean-room transcription** (T1–T6) against SRD/AoN |
| 3 | `FoundryPF1e/pf1` data packs | Data (spells, feats, races, classes, items, monsters, roll-tables, rules, technology) | Phase 1a | OGL 1.0a (system ships them) | pending | Adopt **data only** via converter (OGL notice + CREDITS) |
| 4 | `jackkerouac/animated-spell-effects` | Canvas FX assets (350+ transparent top-down `.webm` spell FX) | Phase 6 | GPL-3.0 @ `436fa96d` (master, 2022-09-27) | pending | Assets by legal case only; default = original generation + user-supplied via `fx.json` (P-5) |
| 5 | `Feu-Secret/Tokenmagic` | Canvas FX engine (Sequencer-style) | Phase 6 | GPL-3.0 @ `0999bb9f` (master, 2026-09-10) | pending | Emulate behavior in our Pixi FxLayer; **no code transfer** (default) |
| 6 | `Autumn225/universal-animations` | Item→FX **mapping logic** (school/damage colors, hit/miss/crit variants) | Phase 6 | MIT @ `59022514` (master, 2026-06-19) | pending | Adopt **logic** with attribution (header + NOTICE.md), adapted to our FX engine |
| 7 | `magnusnordstrom/animated-token` | Canvas FX assets (token webm/sprite-swap) | Phase 6 | **No LICENSE → all rights reserved** (repo 404 / not on public GitHub as of 2026-09-19) | pending | Do not use (default); ask author for a grant (case) |
| 8 | `magnusnordstrom/particle-effects` | Canvas FX (particle engine) | Phase 6 | **No LICENSE → all rights reserved** (repo 404 / not on public GitHub as of 2026-09-19) | pending | Do not use (default); ask author for a grant (case) |
| 9 | `SvenWerlen/fvtt-data-toolbox` | Data tooling (converters) | Phase 1 | **No LICENSE → all rights reserved** @ `e8209a49` (2024-12-23) | pending | Reference only; our converter is original code |
| 10 | JB2A (content + modules) | Data + FX (free tier; Patreon paid assets) | Phase 1b / 6 | Free tier free; **paid assets not redistributable** | pending | User-supplied via `fx.json` provenance (P-5) or a deal |

| 11 | `ironmonk108/monks-wall-enhancement` | Wall authoring and door UX | Multilevel/wall design M1–M5 | GPLv3 LICENSE; README additionally asserts Commons Clause + Foundry EULA @ `79c722aef1cb772885ab28e8a267b5178c06fabe` (manifest 14.01) | pending | **Research only**: pinned source-reading cards; no implementation/assets copied. Independent ArenaStar design examples, not a certified clean-room or approved port. See `docs/research/multilevel/SOURCES.md` |
| 12 | Baileywiki Better Levels | Level builder, audit, Faux Overhead | Multilevel/wall design M0–M5 | **Not verified**: public manifest/product docs 2.0.14 observed 2026-10-10; ZIP retrieval failed, no source/archive pin or license inspected | pending | Documented-behavior reference only; obtain legitimate source archive and license/hash before code-level adoption. No upstream shader or implementation copied |

| 13 | `theripper93/Better-Roofs` | Roof masks and linked occlusion | Multilevel design M2–M3 | MIT, copyright 2023 theripper93 @ V13 `df35cca8c73e7e8d420a81aada7b65c591c06d82`; V14 comparison `83867b4d5b34711e7bec52d91946b1f1f170dbb9` | pending | **Research only**; pinned reading cards, no upstream shader/implementation/assets copied. Original native contracts; any later port needs attribution and adoption approval. See `docs/research/multilevel/RIPPER_PREDECESSORS.md` |
| 14 | `theripper93/Levels` | Elevation queries, fog, transitions, migration | Multilevel design M1–M5 | **No license grant located** in inspected trees/README @ V13 `17d4cfdd674b45e4abf4235416a23f889ba12163` and V14 `230f3ac3d784932f15dad84fb43aa1dc66000b42`; FogManager has additional underlying-code provenance concern | pending | **Research only**, no code redistribution; permission/provenance review required before any adoption. Not evidence of Baileywiki Better Levels internals |
| 15 | `theripper93/Levels` **sample maps** (`Examples/RipperLevels-7.0.3.zip` → `sample-maps/andythebrave/`, the "Ice Beacon" floors) | Art for the D-454 elevation test scene (`Assets/Maps/IceBeacon/*.webp`, 50 % downscales) | Starter-world test content | **No license grant located**; the module README credits the sample maps as "using assets from Forgotten Adventures", and no Forgotten Adventures grant was inspected @ Levels 7.0.3 | **internal testing only** | **Not redistributable as shipped.** The starter world may carry these floors for internal testing only; before any public distribution of that archive, replace `Assets/Maps/IceBeacon/*` with owned or licensed art (the scene works with any square art at 2150 px). Do not adopt FX or code from here.

> **Not located** (recorded so we stop re-searching): Zenvy "PF1 Spell Animation" module —
> three searches, exact slug not indexed. Treat as unavailable.

## How a row moves

1. **pending** → open an **adoption card** in `DECISIONS.md` (P-2) with the source citation
   (repo + commit + file/line, or AoN rule ID) and the behavior spec.
2. **Legal** decides the case → `approved` / `negotiated` / `rejected` (recorded on the
   card with the case reference). A negotiated deal can change the transfer approach.
3. Implement against the **conformance corpora** (P-4); nothing ships until its corpus
   passes (V-gate) **and** its legal case is closed.
