# Adoption / transfer inventory (P-1)

One row per candidate we may transfer from Foundry or elsewhere. `legalStatus` is set by
**Legal, case-by-case** — every row starts `pending`. The license column is a **verified
fact at a pinned commit hash**, recorded as input to each case, not a verdict.

`legalStatus`: `pending` → `approved` | `negotiated` | `rejected`.

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

> **Not located** (recorded so we stop re-searching): Zenvy "PF1 Spell Animation" module —
> three searches, exact slug not indexed. Treat as unavailable.

## How a row moves

1. **pending** → open an **adoption card** in `DECISIONS.md` (P-2) with the source citation
   (repo + commit + file/line, or AoN rule ID) and the behavior spec.
2. **Legal** decides the case → `approved` / `negotiated` / `rejected` (recorded on the
   card with the case reference). A negotiated deal can change the transfer approach.
3. Implement against the **conformance corpora** (P-4); nothing ships until its corpus
   passes (V-gate) **and** its legal case is closed.
