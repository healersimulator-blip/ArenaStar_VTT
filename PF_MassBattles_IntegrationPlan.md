# Pathfinder 1e Full System & Mass Battles Module — Integrated Architecture & Implementation Plan

**Target System:** `ArenaStar_VTT` Serverless Virtual Tabletop  
**Add-on Module Suite:** `pf1e-core` (Full System Engine) + `pf1e-mass-battles` (Strategic Mass Combat Add-on)  
**Rule Set:** Pathfinder 1st Edition (PF1e) Official Rules (SRD) with dual-scale tactical-to-mass-battle resolution.

---

## 1. Executive Summary & Long-Term Vision

To evolve `ArenaStar_VTT` from a strategic mass-battle platform into a complete Pathfinder 1e Virtual Tabletop, the system architecture supports a **dual-scale ecosystem**:
1. **`pf1e-core` Module:** Implements full Pathfinder 1e character sheets, feats, skills, class abilities, spellbooks, condition tracking, stealth vs. perception vision checks, and tactical d20 grid combat.
2. **`pf1e-mass-battles` Add-on Module:** Extends `pf1e-core` into 10,000+ model strategic army engagements by compiling PF1e actor sheets into columnar model profiles with vectorized attack routines, spatial envelopment, AOE spell avoidance, and **direct player-controlled Hero participation inside mass battles**.

This document outlines the complete integration plan, detailing how full PF1e rules (classes, feats, spells, stealth/perception, and player heroes) seamlessly bridge with `ArenaStar_VTT`'s high-density worker simulation engine.

---

## 2. Modular Ecosystem Architecture

The PF1e implementation is split into two mutually compatible modules following `ArenaStar_VTT`'s §12 package specification:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ArenaStar_VTT CORE                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
┌──────────────────────────────────────┐┌─────────────────────────────────────┐
│          pf1e-core MODULE            ││     pf1e-mass-battles ADD-ON        │
├──────────────────────────────────────┤├─────────────────────────────────────┤
│ • Full PF1e Sheet & Modifiers        ││ • Columnar ModelPool Extension      │
│ • Feats, Skills & Class Features     ││ • Vectorized Mass Attack Resolver   │
│ • Stealth vs. Perception Grid Engine ││ • Spatial Envelopment Geometry      │
│ • 0–9 Spellbook & Buff Stacking      ││ • Mass AOE Avoidance & Scatter      │
│ • Active Effects & Condition Engine  ││ • Player Hero ⇄ Mass Battle Bridge  │
└──────────────────────────────────────┘└─────────────────────────────────────┘
```

---

## 3. Dual-Scale Data Model: Tactical Actor ⇄ Strategic Mass Unit

To prevent memory bloat while preserving mechanical depth, the system uses a **Template-Instance Compaction Pattern**:

```
TACTICAL SCALE (Individual Actor / Player Hero)   STRATEGIC SCALE (10,000 Models)
┌──────────────────────────────────────────────┐  ┌─────────────────────────────┐
│ Document: Actor (coll: "actors")             │  │ ModelPool (Columnar Arrays) │
├──────────────────────────────────────────────┤  ├─────────────────────────────┤
│ • Full Sheet (STR, DEX, CON...)              │  │ • x, y: Float32Array        │
│ • Feat Array [Power Attack, Cleave...]       │  │ • hp, hpMax: Uint16Array    │
│ • Skills {Perception: +14, Stealth: +12}     │  │ • status: Uint32Bitfield    │
│ • Spells & Slots [Fireball, Haste...]        │ ──► • profileIdx: Uint16Array   │
│ • Active Effects, Buffs & Conditions         │  │   (Points to PF1e Template) │
│ • Direct Player Control Token (`leaderToken`)│  │ • heroSlotBit: Bit 31 Set   │
└──────────────────────────────────────────────┘  └─────────────────────────────┘
```

1. **Tactical Scale (Individual Player Heroes & Monsters):** Characters, Bosses, and Commanders are stored as full `ActorDocument`s in `ArenaStar_VTT`'s `actors` collection with rich nested structures (abilities, feats, skills, equipment, spells).
2. **Strategic Scale (Mass Formations & Units):** Mass units store a single `profileIdx` on each model in `ModelPool`. The `profileIdx` maps to a compiled PF1e Unit Profile containing pre-computed attack matrices, AC tiers, saving throw bonuses, and passive feat flags.

---

## 4. Deep Mechanics Specifications

### 4.1 Player Hero Participation in Mass Battles
High-level player characters (Heroes) participate directly in mass battles alongside thousands of army models without losing individual control or sheet depth:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       HERO IN MASS BATTLE ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   PLAYER UI (Tactical Control)               WORKER SIM ENGINE (SimWorker)  │
│  ┌───────────────────────────┐                 ┌─────────────────────────┐  │
│  │ Player Moves Hero Token   │                 │ ModelPool Index [Hero]  │  │
│  │ Casts Spell / Uses Feats  │ ──────────────► │ Position: Sync (x, y)   │  │
│  │ Full d20 Sheet Roll       │ Client Sync Op  │ Auras: Broadcast 30ft   │  │
│  └───────────────────────────┘                 └─────────────────────────┘  │
│                ▲                                            │               │
│                │                                            ▼               │
│                │            Host State Commit            ┌───────────────┐  │
│                └──────────────────────────────────────── │ Hero HP Loss /│  │
│                           Document Update Op             │ Conditions    │  │
│                                                          └───────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Bi-Directional State Synchronization (`leaderTokenId`):**
  - The Hero token (`TokenDocument`) on the canvas remains fully interactive under player control.
  - When the player drags their Hero token or casts a spell, `ClientSync.submit()` sends standard update Ops.
  - `TurnChannel.syncHeroTokens()` maps the Hero's exact `(x, y)` position and active conditions into the worker's `ModelPool` before each simulation step.
  - If the Hero takes damage or receives a condition during the mass battle, the host commits an update Op back to the Hero's `ActorDocument` / `TokenDocument`, updating the player's sheet in real time.
- **Leadership & Command Auras:**
  - Paladin *Aura of Courage*, Bard *Inspire Courage*, Marshal *Rallying Cry*, and Commander Feats query surrounding models within radius (30ft / 60ft) via `SpatialGrid`.
  - Nearby friendly grunts receive morale bonuses to Attack, Damage, and Saving Throws.
- **Heroic Overkill & Cleave Carryover:**
  - When a high-level Hero strikes a mass formation (e.g., dealing 52 damage with a critical hit against a 6 HP grunt), overkill damage carries over into adjacent model slots within reach, simulating legendary heroic cleaves through enemy ranks.
- **Rank Shielding & Bodyguards:**
  - Grunt models in the Hero's assigned unit can absorb incoming hits intended for the Hero using the *In Harm's Way* feat or formation shield reaction rules.
- **Heroic Duels & Direct Targeting:**
  - Hostile commanders, monsters, or spellcasters can target the player Hero directly within the formation using full d20 attack rolls against the Hero's exact AC breakdown.

### 4.2 Stealth, Perception & Vision Engine
Pathfinder 1e features nuanced stealth, concealment, and sensory rules that integrate directly into `ArenaStar_VTT`'s `DetectionGrid` (`src/host/detection.ts`):

- **Stealth vs. Perception Checks:**
  $$\text{Perception DC} = \text{Stealth Roll} + \left(\frac{\text{Distance (ft)}}{10}\right) + \text{Cover/Concealment Bonus} + \text{Environmental Modifiers}$$
  (The hider's side gains the cover/concealment bonus — e.g. **+10 Stealth behind improved cover**, per the Stealth skill/A.8; invisibility adds +20 moving / +40 stationary — CRB Invisibility. Cover never lowers the DC.)
- **Sensory Modes & Vision Masks:**
  - **Normal / Low-Light / Darkvision (60ft/120ft):** Modifies cell vision range and darkness occlusion in `LightingLayer`.
  - **Scent (30ft / 60ft upwind):** Detects presence of hidden models within radius regardless of LOS.
  - **Tremorsense:** Bypasses Stealth and Invisibility for ground-bound models.
  - **Blindsight / True Seeing:** Ignores Concealment (20% Blur, 50% Total Invisibility).
- **Mass Stealth Formations:** Units in stealth march calculate average unit stealth or use the lowest model stealth roll. Hostile units failing Perception checks suffer Flat-Footed AC during initial ambush round.

### 4.3 Feats, Class Features & Buff Stacking Engine
Full PF1e rules enforce non-stacking typed bonuses (Alchemical, Armor, Enhancement, Morale, Luck, Sacred, Size, Dodge):

- **Typed Bonus Evaluator:**
  $$\text{Net Modifier} = \sum \max(\text{Bonuses by Type}) + \sum \text{All Dodge Bonuses} + \sum \text{All Penalties}$$
- **Key Feat Implementations:**
  - *Power Attack / Deadly Aim:* Scaled trade-off (Attack Bonus penalty for Damage increase based on BAB).
  - *Cleave / Great Cleave:* SRD Cleave (CRB p.119) is a **standard action**: one attack at full BAB, then — if it hits — one additional attack at full BAB against a foe adjacent to the first, at a −2 AC penalty until your next turn; it is not triggered by dropping a target, and overkill damage never carries over (D-130).
  - *Precise Shot / Clustered Shots:* Ignores melee cover penalties and combines DR reduction for full-attack series.
  - *Spell Focus / Greater Spell Focus:* Increases spell DC by +1/+2 per school.
- **Class Feature Drivers:**
  - *Sneak Attack (+1d6 to +10d6):* Triggers automatically when target is Flanked or Flat-Footed.
  - *Smite Evil:* Adds Charisma to Attack, Paladin Level to Damage, and bypasses all DR against evil targets.
  - *Rage:* Temporary +2 Attack/Damage, +2 Will saves, +2 HP/level, -2 AC.

### 4.4 Full Spellcasting & Mass AOE Scaling
- **Tactical Spellcasting:** Full spell slot tracking (Levels 0–9), caster level checks, Concentration checks (`d20 + CL + Ability Mod >= DC`), and Metamagic (Empower, Maximize, Widen, Quicken).
- **Mass Combat AOE Scaling:**
  - Spells cast into strategic formations map directly to AOE templates (Circle, Cone, Line).
  - **No scatter phase:** models inside the template resolve SR and their save in their square (the invented 5-ft scatter step is removed — D-130, DEVIATIONS D-1).
  - **Saving Throw Resolution:** Vectorized Reflex/Fort/Will saves against `10 + Spell Level + Caster Ability Mod + Feat Mods`.
  - **Evasion / Improved Evasion:** Applied per-model during save resolution.

### 4.5 Condition Bitmask Packing
In `ModelPool`, model condition states are packed into a 32-bit integer `Uint32Array` (`status` column):

| Bit | Condition | Mechanical Effect in Simulation |
| :---: | :--- | :--- |
| `0` | **Dead** | Model removed from active combat; slot freed during turn compaction. |
| `1` | **Hidden / Stealthed** | Requires Perception check to target; gains total concealment. |
| `2` | **Flanked** | Attacker gets +2 AB; Rogue Sneak Attack applies. |
| `3` | **Prone** | -4 AC against melee, +4 AC against ranged; -4 on melee attack rolls; ranged weapons unusable except crossbow/shuriken (no penalty with those). |
| `4` | **Shaken / Frightened** | -2 penalty on Attack Rolls, Saving Throws, Skill Checks, and Ability Checks. |
| `5` | **Sickened** | -2 penalty on Attack Rolls, Weapon Damage Rolls, Saving Throws, and Skill Checks. |
| `6` | **Grappled / Pinned** | Grappled: cannot move, -4 Dex (may lower AC), -2 attack/CMB rolls, no AoOs, no two-hand actions, spells need a DC 10 + grappler's CMB + spell level concentration check. Pinned (separate severity): additionally denied Dex to AC, -4 AC vs melee. Neither is flat-footed. |
| `7` | **Blinded** | Loses DEX to AC, -2 AC penalty, 50% miss chance on all attacks. |
| `8` | **Invisible** | +2 Attack Bonus against sighted targets, targets lose DEX to AC; +20 Stealth while moving / +40 while stationary. |
| `9` | **Entangled** | Half speed, -2 Attack Bonus, -4 DEX. |
| `10` | **Stunned / Dazed** | Stunned: cannot take actions, drops held items, loses DEX to AC, -2 AC. Dazed (milder): cannot take actions but keeps items and takes no AC penalty. |
| `11` | **Hasted** | +1 Attack Bonus, +1 AC (Dodge), +1 extra attack on full attack, +30ft speed. |
| `31` | **Is Hero / Commander** | Model slot maps directly to an active Player Hero `ActorDocument`. |

---

## 5. Architectural Alignment: Existing ArenaStar_VTT Features (Used As-Is)

`ArenaStar_VTT` provides the entire substrate needed for both tactical individual play and mass strategic simulation:

| ArenaStar_VTT Feature | Location | Role in Full PF1e Integration |
| :--- | :--- | :--- |
| **`DocumentStore` & `actors` Collection** | `src/core/store.ts`, `src/core/documents.ts` | Stores full PF1e individual character/monster sheets and equipment items. |
| **`can()` Permission Engine** | `src/core/permissions.ts` | Enforces player ownership over character sheets, spellbooks, and token actions. |
| **Formula Evaluator & Dice Parser** | `src/dice/engine.ts`, `src/dice/bulk.ts` | Evaluates complex PF1e formulas (e.g., `1d20 + @attributes.bab + @str.mod + @size.mod`). |
| **`TurnChannel.syncHeroTokens()`** | `src/host/turnChannel.ts` | Bi-directional synchronization between Player Hero Tokens and `ModelPool`. |
| **`SimWorker` & Worker Sandbox** | `src/sim/runner.ts`, `sim.worker.ts` | Runs the PF1e mass combat resolution and spell avoidance scatter off the main thread. |
| **`DetectionGrid` Vision System** | `src/host/detection.ts` | Evaluates LOS, fog of war, and faction vision sharing. |
| **Spatial Hash (`ModelSpatialHash`)** | `src/canvas/spatial/index.ts` | O(1) proximity lookups for aura effects, threat ranges, and AOE spell targets. |
| **Compendia Engine** | `src/core/compendium.ts` | Houses PF1e Bestiaries, Spellbooks, Feat Databases, and Equipment lists. |
| **3D Dice Overlay** | `src/dice/dice3d.ts` | Visual 3D dice rolls for critical confirmations, heroic attacks, and spell saves. |

---

## 6. Gap Analysis & Required Developments

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     pf1e-core & pf1e-mass-battles                       │
├──────────────────────────────────┬──────────────────────────────────────┤
│ NEW SYSTEM LOGIC                 │ NEW DATA & UI COMPONENTS             │
├──────────────────────────────────┼──────────────────────────────────────┤
│ 1. Formula & Stat Aggregator     │ 1. Full PF1e Svelte Character Sheet  │
│ 2. Stealth/Perception Spatial    │ 2. Active Effect Stacking Inspector │
│ 3. Hero Overkill & Aura Engine   │ 3. Spellbook & Preparation Interface │
│ 4. Spatial Grid Helper Core      │ 4. PF1e Compendium Dataset (SRD)     │
└──────────────────────────────────┴──────────────────────────────────────┘
```

### 6.1 Extracted Pure Spatial Grid (`src/core/spatialGrid.ts`)
- **Gap:** `ModelSpatialHash` currently depends on canvas/PIXI environments.
- **Development:** Extract pure grid math into `src/core/spatialGrid.ts` so both the worker simulation thread (`SimWorker`) and canvas layers share exact cell hashing for Perception checks, Scent radii, Leadership Auras, and AOE spell scattering.

### 6.2 Full PF1e Character Sheet Component (`src/ui/sheets/PF1eActorSheet.svelte`)
- **Development:** Build a Svelte 5 rune-based tabbed sheet:
  - **Summary:** HP, AC Breakdown, BAB, Saves, Initiative, Speed.
  - **Attributes:** Ability scores, temp modifiers, point buy calculator.
  - **Combat & Feats:** Weapons, attacks, armor, feat list with toggles (e.g. Power Attack toggle).
  - **Skills:** Full 35 PF1e skills with rank allocation, class skill bonuses, and armor check penalties.
  - **Spells:** Spellbook by level (0–9), slots used, DC calculation, preparation list.
  - **Inventory:** Carried weight, encumbrance, magic items, gear.

### 6.3 PF1e Formula & Active Effect Aggregator (`src/packages/pf1e/effects.ts`)
- **Development:** Engine that resolves `@` path references against actor sheets, applies typed bonus stacking rules, and outputs final combat matrices (e.g., `Melee AB`, `Touch AC`, `Fort Save`).

---

## 7. Technical Challenges & Risk Mitigation

| Challenge | Risk Level | Proposed Mitigation Strategy |
| :--- | :--- | :--- |
| **1. Hero Token & ModelPool Synchronization Races** | **Medium** | Concurrent player token moves during worker resolution could create positional drift. **Mitigation:** Lock Hero position at the moment of `advance()` / tick execution; post-resolution, `syncHeroTokens()` reconciles Hero position and applies damage Ops atomically. |
| **2. Complex PF1e Character Sheet Performance** | **Medium** | PF1e sheets contain hundreds of derived formulas. Evaluating formulas on every frame causes UI lag. **Mitigation:** Use Svelte 5 `$derived` signals with lazy memoization. Formulas re-evaluate only when underlying base attributes or active effects change. |
| **3. 10,000 Model Mass Resolution CPU Timeout** | **High** | Full PF1e rules (iteratives, DR, SR, saves) for 10,000 models could exceed the 5s worker timeout. **Mitigation:** Pre-compile actor sheets into **Unit Profiles** containing pre-calculated hit matrices. Use vectorized probability tables for standard ranks while running full d20 rolls for commanders/heroes. |
| **4. Stealth & Perception Scalability** | **Medium** | Checking Perception vs. Stealth for thousands of models per tick is $O(N \cdot M)$. **Mitigation:** Aggregate stealth checks at the **Unit level** during mass formation movement. Individual Perception checks run only when a model enters a hostile unit's detection radius (`SpatialGrid` bucket query). |

---

## 8. Package Manifest Specifications

### `pf1e-core` Manifest (`manifest.json`)
```json
{
  "id": "pf1e-core",
  "name": "Pathfinder 1e Core System",
  "version": "1.0.0",
  "type": "system",
  "description": "Full Pathfinder 1st Edition system integration including character sheets, feats, skills, spells, stealth/perception, and active effect stacking.",
  "module": {
    "entry": "module.js",
    "trusted": false
  },
  "packs": [
    { "name": "PF1e Spells (0–9)", "type": "items", "file": "packs/spells.json" },
    { "name": "PF1e Feats & Traits", "type": "items", "file": "packs/feats.json" },
    { "name": "PF1e Bestiary", "type": "actors", "file": "packs/bestiary.json" }
  ]
}
```

### `pf1e-mass-battles` Add-on Manifest (`manifest.json`)
```json
{
  "id": "pf1e-mass-battles",
  "name": "Pathfinder 1e Mass Battles Engine",
  "version": "1.0.0",
  "type": "system",
  "dependencies": ["pf1e-core"],
  "description": "Strategic mass combat add-on for PF1e. Compiles PF1e actor sheets into 10,000+ model strategic formations with spatial envelopment, AOE spell scatter, and player hero participation.",
  "rules": {
    "entry": "rules.js",
    "modelColumns": {
      "ac": "u8",
      "touchAc": "u8",
      "fort": "i8",
      "ref": "i8",
      "will": "i8",
      "sr": "u8",
      "drType": "u8",
      "drVal": "u8",
      "profileIdx": "u16"
    }
  }
}
```

---

## 9. Phased Implementation Roadmap

```
Phase 1: pf1e-core Sheet & Formula Engine ──► Phase 2: Stealth, Perception & Vision
                   │                                          │
                   ▼                                          ▼
Phase 3: Full Spellbook & Active Effects  ──► Phase 4: Hero Bridge & Mass Battle Resolver
                   │                                          │
                   └──────────────────┬───────────────────────┘
                                      ▼
                        Phase 5: Packaging & Compendia
```

- **Phase 1 (Tactical Core):** PF1e Svelte character sheet, formula parser integration, typed bonus stacking engine (`src/packages/pf1e/`).
- **Phase 2 (Stealth & Vision):** Extraction of `src/core/spatialGrid.ts`, distance-penalized Perception checks, sensory vision masks (Low-Light, Darkvision, Tremorsense).
- **Phase 3 (Magic & Effects):** Spellbook UI, spell slot tracking, condition bitmask packing (`Uint32Array status`).
- **Phase 4 (Hero Bridge & Mass Resolver):** Bi-directional Hero token sync (`TurnChannel.syncHeroTokens()`), Leadership Auras, Overkill Cleave carryover, worker-side PF1e mass combat engine, spatial envelopment, and AOE spell scatter/avoidance.
- **Phase 5 (Compendia & Verification):** SRD Bestiary, Feat, and Spell compendia zip packaging, 10,000-model performance verification (< 50ms turn resolve).

---

## 10. Verification & Acceptance Criteria

1. **Full PF1e System Compliance:** Complete accuracy for PF1e character sheet calculations, typed bonus stacking, skills, feats, and spell slot management.
2. **Seamless Player Hero Integration:** Player Heroes retain full sheet depth, individual token movement, 3D dice rolls, and tactical spellcasting while participating in 10,000+ model mass battles.
3. **Stealth & Perception Accuracy:** Distance penalties (-1 per 10ft) and vision modes (Darkvision, Scent, Blindsight) accurately determine token visibility.
4. **Mass Battle Performance:** 10,000 models resolve inside `SimWorker` in `< 50ms` per turn using pre-compiled PF1e unit profiles.
5. **VTT Size Budget:** The VTT bundle raw size remains `< 6 MB`, with compendia streaming on-demand from IndexedDB.
