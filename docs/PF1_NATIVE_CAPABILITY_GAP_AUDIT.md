# Native Pathfinder 1e capability-gap audit

**Date:** 2026-10-18  
**Branch:** `arena/73e2f72c-arenastar-vtt`  
**Purpose:** compare the existing native implementation with five upstream references; identify work for a native-first product. This is not certification of complete PF1 parity.

**Companion:** [implementation plan](PF1_NATIVE_IMPLEMENTATION_PLAN.md) · [UI guide](UI_IMPLEMENTATION_AND_REWORK_GUIDE.md) · [machine-readable inventory](research/PF1_NATIVE_REFERENCE_INVENTORY.json).

## 1. Executive finding

**Keep and consolidate the native implementation; do not replace it or transplant the Foundry runtime.** There is substantial tested native arithmetic, combat, targeting, conditions, import, history and strategic infrastructure. The largest gaps are content-to-mechanics binding, complete character progression, persistent spell semantics, UI orchestration and coordinated cross-mode history.

Five important distinctions:

1. Native implementation breadth is much greater than its small bundled catalogue, but an imported record is not automatically executable.
2. Most of the named upstream packages are content collections, not automation engines.
3. The archetype reference explicitly leaves significant assembly and mechanical work to users. Copying its data will not implement archetypes.
4. Statblock Library contains journals; SBC resolves and constructs actors. Native currently has a narrower text importer, not an equivalent end-to-end library/converter pipeline.
5. Generic Revert/checkpoint machinery exists, but does not establish that every action, timed effect and mixed tactical/strategic operation participates correctly.

No overall parity percentage is justified: content overlaps, rules have unequal complexity, and syntax acceptance is not semantic equivalence.

## 2. Scope, provenance and evidence strength

### Sources actually inspected

All five archives were fetched again through reachable pinned GitHub mirrors and their receipt hashes verified. Original upstream URLs and full commits are in `tools/content/foundry-fixtures.json`; archive hashes are preserved in the inventory.

| Reference | Inspected version / commit prefix | Declared packs | Counted source records |
|---|---|---:|---:|
| PF1 system | 11.11 / `fc067cd7` | 21 | 11,114 |
| PF Content | 0.3.4 / `baf5232c` | 36 | 21,524 |
| PF1 Archetypes | 0.2.7 / `3da8c10b` | 4 | 7,285 |
| Statblock Library | 0.2.9 / `877283f2` | 44 | 10,271 |
| Statblock Converter | 4.0.3 / `77af8755` | 0 | Runtime/parser package, not a content pack |

These are historical mirrors, **not acceptance of current GitLab releases**. SBC's README identifies the archived release as Foundry V10/PF1 0.82.2-era. It must not be assumed compatible with PF1 11.11 simply because both archives are available.

Counts cover declared source packs, excluding YAML folder documents. They are source records, not deduplicated unique rules or proven playable entries. Legacy JSON-lines records and YAML documents are counted; embedded item changes are excluded from the modifier experiment below. No declared source pack was missing in these archives. This does **not** mean the current executable starter includes them all.

### Newly executed evidence

- `node scripts/auditPf1NativeCapabilities.mjs`: complete declared-pack inventory; hashes checked; current native item-change mapper exercised on root document changes.
- Native import front door admitted **15/15** PF1 basic-monster source actors. Every import produced warnings (3–7 lines); admission is not derived-stat or combat parity.
- Focused existing regression suite: **237 passed, 3 skipped, 13 files**. Areas: native actor/builder, item changes, character/statblock import, spell profiles/payloads, condition applications, targeting, host condition rider/Revert and strategic checkpoint/golden tests.
- The three skipped cases are an existing external-character fixture group looking for legacy vendor checkout paths. The new inventory's separate 15-actor probe reads the fetched archive directly. Do not report the skipped tests as passing.

Evidence labels below:

- **T:** relevant existing unit/integration tests passed in this audit.
- **S:** current implementation/source inspected; not an end-to-end claim.
- **H:** earlier documented browser evidence, not rerun during this audit.
- **U:** behavior not established by this audit; needs an acceptance gate.

No browser usability session, full-source differential parity suite, current-GitLab comparison or large-scale benchmark was performed here. Earlier Fireball/Entangle compatibility browser results remain bounded evidence, not native completeness.

### Source/version split discovered

`tools/content/sources.json` pins native content conversion to PF1 `681929d1…`, while `tools/content/foundry-fixtures.json` pins executable compatibility fixtures to `fc067cd7…`. Both identify PF1 sources, but are different snapshots. They must not be treated as one parity baseline. The native content fetch also only declares two sources; archetypes, statblocks and SBC are absent from that intake manifest.

## 3. Measured catalogue and modifier gaps

### Bundled native content (not all converted external content)

| Native catalogue | Actual entries | Qualification |
|---|---:|---|
| Spells | 75 | Four declare mass-battle automation; 71 descriptive |
| Feats | 33 | 18 declare automation; 15 descriptive |
| Classes pack | 6 | Builder separately contains 11 core-class definitions |
| Bestiary | 40 | Does not represent the 10,271-journal statblock corpus |
| Equipment | 8 | Not equivalent to all imported/convertible inventory |
| Poisons | 4 | Not evidence for every upstream malady |

The four automated strategic spell entries are Fireball, Burning Hands, Cone of Cold and Lightning Bolt. The authored tactical condition-spell catalogue has **one profile: Entangle**. Generic native damage/casting machinery exists beyond that profile; conversely, the 75 spell descriptions must not be counted as 75 complete tactical implementations. Some old comments still say 40 spells; measured files take precedence.

### Current native `itemChangesToMods` experiment

Keyed change objects were normalized to arrays as the native inventory reader does. Root source-document changes were then passed to the **actual native mapper**, without executing upstream scripts.

| Corpus | Change entries | Accepted mods | Refused entries | Warning notes |
|---|---:|---:|---:|---:|
| PF1 system | 2,088 | 1,257 | 831 | 27 |
| PF Content | 451 | 114 | 337 | 0 |
| Archetypes | 12 | 0 | 12 | 0 |

PF1 refusals: 483 unmapped targets, 270 nonnumeric formulas and 78 `set` entries. Content refusals: 224 unmapped targets, 97 nonnumeric formulas, 15 `set`, one missing target. Archetypes: five unmapped and seven nonnumeric.

**Limits:** first-refusal categories are not independent measures of all problems in an entry. Accepted means the mapper emitted a mod, not that stacking/context/activation is correct. Embedded actor items, scripted mechanics, associations and action-local bonuses are outside this experiment. Content records overlap across packs.

**Concrete correctness risk:** `src/packages/pf1e/itemChanges.ts` falls back to untyped for unknown bonus types, with a note. This can change stacking semantics. Its 27 system-corpus notes must be reviewed; warning-and-apply should not silently qualify as supported automation. Dynamic formulas are currently refused here. `set` refusal is an intentional safety boundary, not a request to implement arbitrary path writes.

## 4. Capability matrix

| Capability / upstream role | Native state and evidence | Gap / decision |
|---|---|---|
| Derived stats and typed bonuses — PF1 | `actor.ts`, `effects.ts`, tables; actor tests **T** | Strong foundation, no full class/item/condition differential corpus. Unknown types/formulas need safe handling. |
| Character building / leveling — PF1 | `builder.ts`: seven races, 11 core classes, progression aggregation **T** | Generic class-feature grants, choices, prestige advancement and archetype replacement not established. Six packaged classes and 11 builder definitions are different surfaces. |
| Attacks, damage, mitigation, maneuvers — PF1 | Native combat/mitigation/maneuver modules **S**; selected actor coverage **T** | Broad code exists; full upstream action variants and player workflow equivalence **U**. Do not rewrite working primitives. |
| Concentration, preparation, slots, SR, pending casts — PF1 | Dedicated native modules and cast flow **S** | Need one host-owned lifecycle and content-driven configuration; coverage of every spellbook/casting variant **U**. |
| Spell outcomes and persistent areas — PF1 + pack descriptions | One tactical condition profile; four strategic damage payloads **T/S** | Entangle area, partial outcome, recurrence, escape and effect-end lifecycle incomplete as a complete native ability. |
| Source-specific conditions / Revert | `conditionApplications.ts`, host condition action/rider validation **T/S** | Good identity/receipt base. Timed removal is explicitly rejected: `condition removal kind "expiry" has no host sweep yet`. A TypeScript expiry variant is not runtime support. |
| Feats / expanded items — Content | Selected name-based feat mechanics and numeric typed item mappings **T/S** | Most content has no executable native descriptor; prerequisites, choices, scaling, toggles and contextual effects need explicit support. |
| Archetype / prestige progression — Archetypes | Search found no dedicated native archetype application engine **S** | Missing explicit replacement/alteration/conflict/grant model. Generic class import is not archetype application. |
| Text statblock import — Converter role | Four-format import front door; 25 statblock tests **T** | Spell lists/SLAs, contextual attacks, special abilities and gear resolution are incomplete compared with SBC's parser/resolver responsibilities. |
| Library journal → playable actor — Library + SBC | Library discovery/UUID retrieval documented **H**; native text importer **T** | Native safe HTML extraction, resolver, preview/correction and one-step actor creation chain not established. |
| Imported actor fidelity — PF1/Content | 15/15 current basic monsters admitted; import readers and reports **T/S** | Foundry reader omits class/race/buff semantics and prepared spell lists. Admission does not preserve all mechanics. |
| Native rules UI | Existing sheet, spellbook and action flows **S** | Human usability/cancellation gate **U**. Rework to UI guide; do not certify from test globals or a rendered sheet. |
| Portable GM-published ability/FX → player use | Native item/spell bindings and effect-owned host FX path **S** | Stable source identity, publication roles, phase binding and full multi-client workflow **U**. Hard-coded instance IDs/name matching insufficient. |
| Action Revert | Inverse receipts, conflict guards, public condition/rider paths **T/S** | Audit all producers and pending transitions. Separate UI submits and unaudited paths prevent an all-actions claim. |
| Strategic simulation | Pure rules worker, typed model pool, PRNG, deltas/checkpoints **T/S** | Proven golden scenario is 120 models/10 turns, not a large-scale performance certification. |
| Autonomous behavior | Standing doctrine synthesizes advance/attack for unordered units **S** | Robust rank recovery, known-hazard response, arbitration/hysteresis and explanation not established. |
| Morale / leadership | Save-aura path **S** | PF1 strategic source explicitly leaves routed/morale metadata without break/rout rules; aura is not full morale or all leadership bonuses. |
| Tactical ↔ strategic effects / history | Shared mechanical primitives and hero/profile bridges **S** | One spell changing hero resources and pool state needs recoverable coordinated commit/rewind; universal guarantee **U**. |
| Optional Foundry execution | AIS adapter/catalogue/UI/document bridge; bounded earlier real PF1 casting **H/S** | Keep distinct from native conversion. Full five-package SBC execution and arbitrary module Revert **U**. |

### Unestablished long-tail coverage

Native inventory, health/temp-HP, affliction, skill and specialized combat modules also exist, but this focused run does not certify all of their content interactions. Companion/eidolon progression, mythic paths, monster templates, technological items, rituals, traps/haunts, kingdom-building documents and complete roll-table behavior require separate capability-ledger entries and scenarios. They are **unestablished**, not automatically absent and not supported merely because a source pack converts. This is a prioritized architecture/capability audit, not an exhaustive rule-by-rule PF1 equivalence proof.

## 5. Package-by-package conclusions

### PF1 system: behavioral reference, not a replacement kernel

Inspect `module/documents/actor`, item/action models, change handling, roll data and data preparation in the pinned archive. Native already independently implements many corresponding primitives; the task is gap closure and explicit behavioral fixtures, not a blanket rewrite.

Prioritize authoritative action orchestration, dynamic/contextual modifier semantics, actual source-driven casting and class/feature progression. Compare deterministic inputs/results, then arbitrate discrepancies using cited PF1 rules rather than assuming upstream is infallible.

### PF Content: corpus and declarative-mechanics backlog

The pinned manifest declares no runtime scripts. Its value is items, feats, buffs, abilities, reference material and other documents. It does not confer automation merely by being loaded. The pinned Archetypes manifest also has no runtime scripts: neither package supplies a standalone replacement for the native character/action UI. Their usable interfaces depend on the host/system; SBC supplies a separate conversion workflow. Borrow those interaction patterns without assuming the data packages solve UI by themselves.

`tools/convert/mappers.mjs` carries portions of actions, changes and associations under `system.foundry`; preserving those fields is not the same as consuming them. `itemChanges.ts` only maps a bounded subset. Native needs a supported descriptor registry with per-entry capability reports, not execution of arbitrary pack JavaScript.

### Archetypes: model replacement/grants, do not infer from prose

The pinned README explicitly says archetype classes/features are not fully implemented, lack changes/attacks, omit some repeated tiers and require assembly. Prestige features likewise need manual adjustment and do not automatically advance base casting.

Measured four-pack records: 1,268 archetypes; 4,589 archetype features; 119 prestige classes; 1,309 prestige features. These differ from README headline counts; use the inventory for this snapshot.

Native needs explicit replaced/altered features, conflict rules, level schedules, choices, prerequisites, resource progression and spellcasting advancement. The module is a useful catalogue/link reference, not a complete oracle for those mechanics.

### Statblock Library: a searchable source corpus

Its 44 declared packs contain journal statblocks, not ready-made native actors. The archive script hooks journal rendering, locates `.importStatblock`, and feeds text into SBC's `#sbcInput` UI. That is a concrete cross-module UI handoff, not an intrinsic actor-creation API.

Implement native journal extraction/import independently. Preserve paragraphs/section breaks; the existing general `plainText` helper collapses block endings to spaces and is not sufficient evidence for a statblock parser input pipeline. Strip executable markup, preserve source links and show warnings before creating actors.

### SBC: conversion pipeline reference, not gameplay rules authority

Source inspection found distinct parser responsibilities for classes, creature type, senses, resistance, speed, attacks, spellbooks, skills, gear, tactics, ecology and special abilities. `sbcUtils.js` includes compendium resolution, placeholder creation and conversion validation/adjustment.

The native reader intentionally preserves published AC/save totals but reports rather than imports printed attack/skill bonuses; spell-like ability lists and other unsupported data become warnings. That avoids double counting, but can leave materially different playable results.

Native needs a typed intermediate representation, deterministic entity resolution, ambiguity UI, fidelity comparison and explicit published-total vs reconstructed-component modes. A correction or placeholder must be visible and source-attributed; do not silently create compensation buffs just to force totals to match.

## 6. Ranked gaps

| ID | Priority | Gap | Closure evidence required |
|---|---|---|---|
| G01 | P0 | Split source pins / incompatible fixture path contracts | One reference lock and reproducible adapter-specific version profiles; no silently skipped required corpus. |
| G02 | P0 | Action orchestration spans UI, generic writes and separate receipts | Host-owned action lifecycle; retry/crash/permissions/Revert tests through public intents. |
| G03 | P0 | Trapped/undiscoverable UI and missing normal choices | Guide-compliant targeting/cancel/player workflows; human review. |
| G04 | P0 | Modifier semantics unsupported or unsafe fallback | Strict typed translation, bounded formulas, context validation and discrepancy reports. |
| G05 | P1 | Content identity and published binding portability | GM library → player-owned ability → FX → real multi-client cast without ID editing. |
| G06 | P1 | Persistent spell/condition lifecycle incomplete | Area membership, supported recurrence/escape, host expiry, overlaps and owned FX cleanup. |
| G07 | P1 | Class/archetype/prestige feature model missing | Level/replacement/choice/conflict/advancement fixtures and reversible application. |
| G08 | P1 | Native Library→converter pipeline and fidelity gap | Stratified real-source imports with numeric and behavioral comparison; reviewable unresolved fields. |
| G09 | P1 | Autonomous unit policies incomplete | Attack/reform/hazard scenarios with deterministic decisions and command precedence. |
| G10 | P1 | Cross-mode state/rewind coordination unproven | Hero-resource + pool-effect crash/retry/rewind acceptance. |
| G11 | P2 | Large-corpus/large-unit performance not measured | Named hardware/workload p95, memory/wire/asset budgets; regression thresholds. |
| G12 | P2 | Optional provider capabilities not explicit | Tested package/version profiles; strict reversible-mode limits; no competing authority. |

P0/P1 describe implementation risk/order, not a claim that every listed workflow
currently corrupts data. Detailed work packages and dependency gates follow in
the [implementation plan](PF1_NATIVE_IMPLEMENTATION_PLAN.md).

## 7. Reproduction and limitations

```sh
npm ci
npm run fetch:foundry-fixtures
node scripts/auditPf1NativeCapabilities.mjs
```

The script uses Vite only to load native TypeScript readers/mappers; it does not
execute upstream system/module code. It reads archives in place, checks receipt
hashes and writes the inventory deterministically. It does not require extracting
upstream code into tracked files. Downloads remain in ignored vendor storage.

Focused validation command:

```sh
npx vitest run \
  tests/packages/pf1eActor.test.ts tests/packages/pf1eBuilder.test.ts \
  tests/packages/pf1eItemChanges.test.ts tests/packages/pf1eCharacterImport.test.ts \
  tests/packages/pf1eStatblockImport.test.ts tests/packages/pf1eSpellEffect.test.ts \
  tests/packages/pf1eSpellPacks.test.ts tests/packages/pf1eConditionApplications.test.ts \
  tests/packages/pf1eTargeting.test.ts tests/host/pf1eSpellEffectRider.test.ts \
  tests/host/effectRevertScope.test.ts tests/host/simBridge.test.ts \
  tests/sim/strategicGoldenGate.test.ts
```

Archive manifests and README observations here refer to the pinned artifacts,
not current public HEAD. Static findings and small probes cannot establish
whole-game correctness, end-user usability or commercial redistribution rights.
