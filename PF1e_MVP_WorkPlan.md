# Pathfinder 1e Mass Battles MVP — Execution Work Plan

**Target Application:** `ArenaStar_VTT`  
**Package Scope:** `packages/pf1e-core` + `packages/pf1e-mass-battles`  
**Goal:** Deliver a fully functional MVP module for Pathfinder 1e Mass Combat simulation with complete feature parity to `Combat_Resolver_5`, including per-model d20 attack routines, DR/SR, enveloping, spell avoidance, player hero participation, and detailed combat analytics.

> **Status 2026-09-08** (branch `arena/01a07ced-arenastar-vtt`, PR #4): Tasks 1–5 are delivered (spatial
> grid in `src/core/spatialGrid.ts`, `PF1E_MODEL_SCHEMA` + profile compile, per-model PF1e attacks with
> AC/DR/SR, envelopment, spell avoidance/saves in the sim), Task 9 is delivered (`pnpm build:systems`
> emits the manifest-verified packages + `pf1e-core` seed packs), and Task 10 is delivered as a Node gate
> (`tests/packages/pf1eMassBattleScale.test.ts`: 10k models, 66.00 B/model, p95 ≈ 45–50 ms) with a
> browser half that asserts the shipped zips. Task 6 is **partly** done (six analytics fields declared and
> never incremented; `exportAnalyticsToCsv` unquoted; `generateReport()` uncalled by the module) and
> Task 7's hero bridge has **no in-repo producer** for `isHeroUnit`. Task 8's components exist but are not
> mounted in `WindowHost` (only `e2eHook.ts` can open `ArmyWindow`). Those remainders, plus everything at
> tactical (hero) scale, are sequenced in `PF1e_ImplementationPlan.md` — this file is kept for the
> parity matrix it verified against `Combat_Resolver_5`.

---

## 1. Feature Parity Matrix: `Combat_Resolver_5` ⇄ `ArenaStar_VTT`

| `Combat_Resolver_5` Feature | MVP Module Implementation (`pf1e-mass-battles`) | Target Component Path |
| :--- | :--- | :--- |
| **PF1e d20 Attack Routines** | Iterative attacks (`+11/+6/+1`), AC/Touch/Flat-Footed checks, Critical Threat & Confirm rolls. | `src/packages/pf1e/combatEngine.ts` |
| **Defensive Mitigation** | Damage Reduction (DR/magic, DR/slashing), Energy Resistance, Spell Resistance (SR) checks. | `src/packages/pf1e/combatEngine.ts` |
| **Spatial Envelopment** | Outer perimeter model contact detection, flank vectors, +2 Flanking / +4 Envelopment (Flat-Footed) modifiers. | `src/packages/pf1e/envelopment.ts` |
| **Spell Scatter & Avoidance** | AOE templates (Circle, Cone, Line), 5ft Reflex scatter step, Reflex saves vs Spell DC, Evasion/Improved Evasion. | `src/packages/pf1e/spells.ts` |
| **Player Hero Control** | Interactive player token control (`leaderTokenId`), bi-directional state sync, Leadership Auras, Overkill Cleave carryover. | `src/packages/pf1e/heroBridge.ts` |
| **Battle Analysis & Metrics** | Hits/misses, damage done/received, damage healed, kills/casualties, crits, saves passed/failed, DR/SR absorbed. | `src/packages/pf1e/analytics.ts` |
| **Analytics UI & CSV Export** | Interactive Battle Analysis tab in Army Window, per-model breakdown table, and RFC-4180 CSV export. | `src/ui/armies/PF1eBattleAnalysis.svelte` |

---

## 2. Granular Task Breakdown & Execution Plan

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PF1e MVP MODULE WORK PLAN PHASES                       │
├───────────────────────────────┬─────────────────────────────────────────────┤
│ Phase 1: Core Math & Storage  │ Tasks 1–2: Spatial Grid & ModelPool Schema  │
│ Phase 2: Mass Battle Rules    │ Tasks 3–5: Combat, Envelopment & Spells     │
│ Phase 3: Hero & Analytics     │ Tasks 6–7: Battle Analytics & Hero Bridge   │
│ Phase 4: UI & Packaging       │ Tasks 8–10: Svelte UI, Compendia & E2E Test │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

---

### Task 1: Spatial Grid Core Extraction
- **Objective:** Extract pure, environment-agnostic spatial grid hashing from `src/canvas/spatial/index.ts` into `src/core/spatialGrid.ts`.
- **Target File:** `src/core/spatialGrid.ts`
- **Key Functions:**
  - `SpatialGrid.insert(id, x, y)`
  - `SpatialGrid.queryRadius(x, y, radius): number[]`
  - `SpatialGrid.queryRect(rect): number[]`
- **Acceptance Criteria:** Node-compatible, zero DOM dependencies, tested in `tests/core/spatialGrid.test.ts`.

---

### Task 2: ModelPool Schema & PF1e Profile Compaction
- **Objective:** Define PF1e model schema extensions and unit profile compilation.
- **Target File:** `src/packages/pf1e/schema.ts`
- **Model Columns Added:**
  - `ac` (u8), `touchAc` (u8), `fort` (i8), `ref` (i8), `will` (i8), `sr` (u8), `drType` (u8), `drVal` (u8), `profileIdx` (u16), `status` (u32 bitfield).
- **Acceptance Criteria:** `ModelPool` allocates columns dynamically based on `manifest.json` schema; unit profile lookup table packs complex sheets into 16-bit templates.

---

### Task 3: PF1e Vectorized Combat & Attack Resolver
- **Objective:** Implement authoritative Pathfinder 1e d20 attack, critical hit, DR, and SR resolution loop for mass formations.
- **Target File:** `src/packages/pf1e/combatEngine.ts`
- **Resolution Pipeline:**
  1. For each attacking model, iterate BAB attack routine (`+11/+6/+1`).
  2. Draw d20 from seeded `BulkDice` PRNG sub-stream (`rng.fork(hash)`).
  3. Compare vs target AC (or Touch/Flat-Footed AC).
  4. Check Critical Threat range (e.g. 19-20); roll confirmation if threatened.
  5. Roll damage, subtract DR (if non-matching weapon type) or Energy Resistance.
  6. Apply remaining damage to target model `hp`; mark Bit 0 (Dead) if `hp <= 0`.
- **Acceptance Criteria:** 100% compliant with PF1e SRD attack formulas; verified in `tests/packages/pf1eCombat.test.ts`.

---

### Task 4: Spatial Envelopment & Flanking Geometry Engine
- **Objective:** Calculate model contact perimeters, flank wrapping, and tactical modifiers.
- **Target File:** `src/packages/pf1e/envelopment.ts`
- **Algorithm:**
  1. Query `SpatialGrid` for opposing models within reach ($5\text{ ft}$ or $10\text{ ft}$).
  2. Identify unengaged outer flank models when unit frontages differ.
  3. Vector outer models around the enemy flank.
  4. Set Bit 2 (`Flanked`) on target models (+2 attacker AB) or apply Total Envelopment (+4 AB, Flat-Footed AC).
- **Acceptance Criteria:** Envelopment vectors update model coordinates; verified in `tests/packages/pf1eEnvelopment.test.ts`.

---

### Task 5: AOE Spell Avoidance & Scatter Engine
- **Objective:** Implement spell scatter, Reflex saves, and Evasion mitigation.
- **Target File:** `src/packages/pf1e/spells.ts`
- **Avoidance Pipeline:**
  1. For spell orders (Circle, Cone, Line), identify models inside template.
  2. Models with active awareness take a $5\text{ ft}$ Reflex scatter step away from epicenter.
  3. Models remaining in template roll Reflex save (`d20 + Ref Bonus`) vs Spell DC.
  4. Apply Evasion (0 on pass / full on fail) and Improved Evasion (0 on pass / half on fail).
- **Acceptance Criteria:** Scatter vectors update model coordinates; damage applied accurately; verified in `tests/packages/pf1eSpells.test.ts`.

---

### Task 6: Battle Analytics & Detailed Combat Reporter (`Combat_Resolver_5` Parity)
- **Objective:** Collect detailed per-model and per-unit combat metrics during resolution.
- **Target File:** `src/packages/pf1e/analytics.ts`
- **Metrics Tracked in `TurnReport.summary`:**
  - **Hits & Misses:** `totalAttacks`, `hits`, `misses`, `hitPercentage`.
  - **Damage Metrics:** `damageDealt`, `damageTaken`, `overkillDamage`.
  - **Healing & Regeneration:** `damageHealed`, `regenerationTicks`, `channelEnergyHealed`.
  - **Casualties & Kills:** `killsCount`, `deathsCount`, `modelsRemaining`.
  - **Critical Hits:** `critThreats`, `critsConfirmed`.
  - **Defensive Statistics:** `drAbsorbed`, `srBlocked`, `savesPassed`, `savesFailed`.
- **Acceptance Criteria:** Detailed analytics populated after every turn resolution; verified in `tests/packages/pf1eAnalytics.test.ts`.

---

### Task 7: Player Hero Integration & Sync Bridge
- **Objective:** Connect interactive player Hero tokens (`leaderTokenId`) to the `SimWorker` mass combat engine.
- **Target File:** `src/packages/pf1e/heroBridge.ts`
- **Features:**
  - Bi-directional position & state sync between `TokenDocument` and `ModelPool`.
  - Leadership Auras (Paladin *Aura of Courage*, Bard *Inspire Courage*) broadcasting morale bonuses to friendly models within $30\text{ ft}$.
  - Overkill Cleave carryover: Hero excess damage spills over into adjacent enemy model slots.
- **Acceptance Criteria:** Hero moves on canvas update `ModelPool`; damage in mass battle updates `ActorDocument` / `TokenDocument` via host Ops.

---

### Task 8: Svelte UI Components & Battle Analysis Inspector
- **Objective:** Create interactive UI panels for PF1e Actor Sheets and Battle Analytics.
- **Target Files:**
  - `src/ui/sheets/PF1eActorSheet.svelte` (Tabbed character sheet: Summary, Attributes, Combat, Skills, Spells, Inventory).
  - `src/ui/armies/PF1eBattleAnalysis.svelte` (Battle analysis dashboard displaying hits, damage, kills, heals, DR absorbed, and CSV export).
- **Acceptance Criteria:** Rendered inside Army Window; reactive updates using Svelte 5 runes.

---

### Task 9: Package Manifests & SRD Compendia
- **Objective:** Package the PF1e module suite into §12 compliant archives.
- **Target Files:**
  - `systems/pf1e-core/manifest.json` + `packs/spells.json`, `packs/feats.json`, `packs/bestiary.json`.
  - `systems/pf1e-mass-battles/manifest.json`.
- **Acceptance Criteria:** Importable via `HostPackages.importZip()`; compendia searchable in Compendia sidebar panel.

---

### Task 10: E2E Integration Suite & Performance Benchmark
- **Objective:** Validate the complete MVP module end-to-end under realistic load.
- **Target File:** `e2e/pf1e_mass_battles.spec.ts`
- **Scenarios Tested:**
  1. 2-Player WebRTC session with 10,000 models executing PF1e mass battle turns.
  2. Player Hero token moving on canvas, casting *Fireball* (triggering spell scatter), and cleaving through an enemy rank.
  3. Battle Analysis panel readback verifying exact hit, damage, heal, and kill counts.
  4. Performance assertion: 10,000-model turn resolution completes in `< 50ms` inside `SimWorker`.

---

## 3. Verification & Acceptance Definition

1. **`Combat_Resolver_5` Parity:** Battle analysis metrics (hits, damage, heals, kills, crits, DR/SR) match or exceed `Combat_Resolver_5` capabilities.
2. **Performance Gate:** 10,000-model resolution completes in `< 50ms` in worker thread; VTT single-file bundle size remains `< 6 MB`.
3. **Test Suite Health:** All unit tests (`pnpm test`), typechecks (`pnpm typecheck`), and linter (`pnpm lint`) pass clean.
