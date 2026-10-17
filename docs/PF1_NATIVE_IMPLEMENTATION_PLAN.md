# Plan: independent native rules + native simulation + optional Foundry provider

**Date:** 2026-10-18  
**Status:** proposed implementation backlog with acceptance gates; not completed work.  
**Basis:** [measured native gap audit](PF1_NATIVE_CAPABILITY_GAP_AUDIT.md), [architecture analysis](PF1_AUTOMATION_ARCHITECTURE_ANALYSIS.md), [UI implementation guide](UI_IMPLEMENTATION_AND_REWORK_GUIDE.md).

## 1. Decision and scope

Build on the substantial native PF1 implementation. Independently specify and
implement missing behavior using these references:

| Reference | Use in native-first development | Do not assume |
|---|---|---|
| PF1 system | Character derivation, resource/action semantics, formulas, data relationships and differential fixtures | Its runtime classes belong in the native engine or every upstream result is rules-correct |
| PF Content | Expanded corpus and examples of item/feat/buff/ability mechanics | Importing descriptions automatically implements mechanics |
| PF1 Archetypes | Catalogue, feature associations and progression examples | Its manually assembled archetypes are complete executable specifications |
| Statblock Library | Stratified real-world parsing/fidelity corpus, provenance and search UX | Journals are already playable actors |
| SBC | Behavioral specification for extraction, parsing, lookup, ambiguity, validation and conversion review | Archived SBC runs against current PF1, or its correction strategy should be copied verbatim |

Priorities are ordered: **(1) lightweight automated/reversible VTT, (2) strategic
units/autonomy, (3) compatible Foundry execution.** UI usability is a release gate
for the first two, not a later cosmetic phase.

This is independent reimplementation, not wholesale transplantation. Preserve
existing working arithmetic and simulation. Do not claim formal clean-room
separation: upstream source has already been inspected. Record implementation
provenance and obtain licensing review where needed; independently written code
does not grant redistribution rights to upstream content/artwork.

### Explicit non-goals for the initial delivery

- Implement every PF1 feat, archetype, prestige class and spell at once.
- Maintain two simultaneously authoritative native/Foundry copies of an actor.
- Execute arbitrary content scripts in the native rules engine.
- Guarantee Revert for every opaque compatible module.
- Implement an LLM or a full document actor per simulated model per tick.
- Rebrand the existing GM-script Entangle fixture as the completed native player workflow.

## 2. Target boundaries and contracts

```text
Native sheets / contextual actions / library / compatible interfaces
                         |
           interaction sessions and authenticated intents
                         |
      Host action coordinator: authorization, revisions, idempotency
                   /                         \
     Native PF1 action planner         Optional Foundry provider
     (independent rules/data)          (versioned capability profile)
                   |
         Tactical commit / strategic batch + coordinated journal
                         |
     effect ownership + lifecycle + receipts/checkpoints + projections
                         |
             native FX / results / action history
```

Strategic workers consume compiled native profiles and bounded model state.
They share suitable mechanical primitives with tactical rules; they do not
execute tactical UI flows, arbitrary Foundry hooks or one RPC per attack.

Proposed contracts—names illustrative, not APIs already shipped:

- **AbilityDefinition:** stable source identity, rules revision, costs, targeting,
  checks, supported effect descriptors and explicit unsupported mechanics.
- **ActionIntent:** request ID, provider, actor/owned ability, chosen options and
  targeting declaration. It carries requests, not trusted derived answers.
- **ResolutionState:** action/target IDs, host-owned rolls, revisions, pending
  decisions and completed mechanical transitions.
- **ResolutionPlan:** validated state changes, effect instances, result facts,
  dependencies and presentation events. Native plans are data, not callbacks.
- **EffectInstance:** source action/ability, recipients, area association, stacking,
  duration/recurrence/escape policy and owned persistent FX references.
- **ProviderCapabilities:** supported commands, source schema/runtime version,
  automation limitations, capture/recovery and Revert guarantees.

Compatible execution may need capture rather than a pure precomputed plan.
It may not claim the native plan guarantees unless all participating writes are
contained and correlated. One provider owns an action and the affected actor's
mechanical model; cross-provider interactions require an explicit supported
bridge, otherwise refuse them with a useful explanation.

## 3. Work packages and gates

Effort bands are relative: **S** bounded integration, **M** multi-component slice,
**L** subsystem work, **XL** ongoing corpus coverage. They are not calendar promises.
All packages need UI/error/security tests relevant to their surface.

### M0 — Reproducible references and capability ledger

**Closes:** G01; enables all later phases. **Effort:** M.

- **REF-01:** introduce one source lock model with explicit native-behavior,
  content and compatibility profiles. Start parity fixtures from the inspected
  `fc067cd7…` snapshot; retain the existing `681929d1…` converter pin as a named
  legacy profile until deliberately rebased. Do not silently change generated
  content or assert the snapshots are equivalent.
- **REF-02:** add all five references to the intake/provenance workflow. Keep
  archives and extracted fixtures ignored, hash-checked and fetched on demand.
  Separate actual versions from module identity and original source URLs.
- **REF-03:** fix required-fixture discovery so archive and checkout tests agree
  on fixture locations. Required CI jobs fail on missing reference inputs;
  optional developer jobs may skip but report why.
- **REF-04:** produce a machine-readable per-entry capability ledger:
  reference/display, converted fields, supported mechanics, unsupported reasons,
  tactical/strategic availability, tests and version. Add schema migration rules
  and collision/duplicate handling using source identity, not just names.
- **REF-05:** add license/notice checks to publication. Do not redistribute a
  corpus automatically because it is publicly downloadable.

**Gate:** a fresh checkout reproduces the inventory; every record has a traceable
source/version; no required real-source job silently skips. The legacy pin
mismatch is visible and deliberate. No percentage of full PF1 parity is inferred
from record count or catalogue admission.

### M1 — Authoritative action lifecycle and safe UI interaction

**Closes:** G02/G03; begins G05. **Effort:** L.

- **ACT-01:** characterize existing cast, roll/apply, condition, maneuver, slot,
  consumable, movement and reviewed-script producers. Record which writes share
  receipts and which escape action ownership. Preserve current tests as baselines.
- **ACT-02:** extract reusable planning from `pf1eCastFlow.ts` into native package/
  application modules. Host validation owns caster, costs, rolls, target legality
  and public intents. Avoid moving all UI code into the already-large `HostSync`.
- **ACT-03:** persist pending resolution states and idempotency keys. Define
  commitment points: preview spends nothing; interrupted/lost casts follow
  explicit PF1 expenditure rules. Late or duplicate saves cannot reapply effects.
- **ACT-04:** group causally related writes into action history/receipts, including
  delayed transitions. Define cancellation, failure and conflict semantics before
  adding new producers. Revert invalidates pending work; redo uses stored results.
- **UI-01:** implement shared interaction-session ownership, visible Cancel,
  Escape hierarchy, cleanup, tool restoration, retargeting and pan/zoom behavior.
- **UI-02:** deliver the approved character/action/targeting/result layout from
  the UI guide. Common options must be inventoried; unsupported options are
  disclosed, not silently omitted. UI sends intents instead of editing derived stats.

**Gate:** one real player casts, cancels, retries, waits for a save, receives a
result and requests authorized Revert. Test disconnect, duplicate confirmation,
resource change during targeting, unauthorized target writes and conflicting
later changes. Human walkthrough without console is mandatory.

### M2 — Typed modifier/content semantics and portable presentation

**Closes:** G04/G05. **Depends:** M0; action integration on M1. **Effort:** L.

- **SEM-01:** remove warning-and-apply semantic fallbacks for unsupported bonus
  types. Preserve raw source data and report unsupported mechanics explicitly.
  Regression-test the 27 warning cases and each refusal category in the audit.
- **SEM-02:** use/extend a single bounded expression evaluator for native formulas:
  allowlisted variables/functions, units, dependency graph, cycle detection and
  execution budgets. No `eval` and no arbitrary path-write language.
- **SEM-03:** create independently specified typed descriptors for conditional
  bonuses, granted choices/actions/resources and supported overrides. Translate
  a Foundry `set` only when a safe explicit native mechanic exists. Never lift
  that safety boundary merely to reduce the refusal count.
- **SEM-04:** connect supported item/feat/buff descriptors to native derivation,
  activation, scaling and prerequisites. Keep import syntax, semantic support
  and gameplay verification as separate ledger fields.
- **PUB-01:** preserve package/pack/document identity across library entries,
  owned items and player copies. Support named revision/migration decisions and
  per-item overrides without confusing the source and instance.
- **FX-01:** publish declarative ability-to-Wizard bindings with use/view/edit
  rights and distinct preview/cast/outcome/effect-end phases. No hard-coded GM
  actor/item IDs. Reconcile persistent visuals from authoritative ownership.

**Gate:** GM shares a supported upstream-derived ability/item and its FX binding;
player imports and uses it without scripting. Verify stacking, scaling,
permissions, unpublished-binding rejection, missing art and reconnect. Syntax
acceptance metrics are retained but never substituted for semantic gates.

### M3 — Complete tactical spell/effect vertical slices

**Closes:** G06; exercises M1/M2 end to end. **Effort:** L.

- **SPELL-01:** independently specify full native Entangle from rule sources:
  geometry/eligibility, initial and recurring saves, successful-save consequences,
  movement/terrain, break-free actions, duration and overlapping instances.
  Distinguish environmental requirements and GM rulings from computable facts.
- **EFFECT-01:** implement actual accepted expiry/removal policies and a host
  lifecycle scheduler. The current `expiry` rejection must become supported
  behavior with turn/clock boundary tests, not just a validator relaxation.
- **EFFECT-02:** event-driven area membership, recurrence and escape actions use
  action/target/effect IDs. Do not retest saves per render frame or wall-clock
  animation tick. Handle turn changes, disabled effects, deletion and reload.
- **SPELL-02:** express existing damage spells through the shared ability/action
  contract. Add representative touch, delayed, resistance, buff/debuff and healing
  cases before broad catalogue claims.
- **FX-02:** prove the authored reticule, actual spell animation and effect
  lifecycle through the native Wizard and player controls. Text-only proof cues
  may remain diagnostics; they do not satisfy finished visual acceptance.

**Gate:** GM plus two independent player sessions; real library-derived ability;
one target passes and another fails; cancel spends nothing; target modifiers
and movement follow actual outcomes; overlapping spells remain independent;
escape/expiry/remove stop only owned effects/FX; reload and Revert are safe.
No claim of complete Entangle until the specified rule/UI matrix is green.

### M4 — Character progression, archetypes and prestige classes

**Closes:** G07; expands PF1/Content parity. **Depends:** M0/M2, receipts on M1.
**Effort:** L for framework; XL for catalogue coverage.

- **CHAR-01:** native source-addressable grants/choices for class, race, feat,
  item and archetype features. Keep baseline components separate from derived
  totals. Model per-level resources and spellcasting progression explicitly.
- **ARCH-01:** author explicit archetype replacement/alteration schedules and
  stacking conflicts. Module associations/description are evidence, not an
  automatic prose-to-rules compiler.
- **ARCH-02:** application preview shows gained/lost/altered features and choices.
  Apply/level/respec use receipts. Removing a grant must not remove the same
  feature/resource supplied by another source.
- **PRC-01:** prerequisites, prestige progression and chosen base-class casting
  advancement are explicit native rules. Do not infer them from an imported
  class item or assume upstream already automates them.
- **CHAR-02:** build a source-checked fixture ladder: core single-class, multiclass,
  archetype with replacement, conflicting archetypes, scaling feature, prestige
  advancement, race/buff/item interaction. Expand only against named gates.

**Gate:** level and respec a representative character through UI; compare derived
values to documented expected components and pinned upstream where applicable;
show unresolved rules clearly; revert without destroying independent grants.
Catalogues must expose verified/partial/reference-only status per entry.

### M5 — Independent native statblock/library conversion pipeline

**Closes:** G08. **Depends:** M0; M2/M4 for richer resolved mechanics. **Effort:** L.

- **IMPORT-01:** safe journal/HTML/PDF-paste normalization preserving section
  breaks, Unicode numbers and source metadata. Never execute imported scripts.
- **IMPORT-02:** typed intermediate representation for source spans, published
  totals, component facts, attacks, skills, movement/senses, defenses, classes,
  spellbooks/SLAs, gear and special abilities. Preserve unsupported information.
- **IMPORT-03:** deterministic catalogue resolver with exact identities, aliases,
  explicit ambiguous candidates and optional user selection. No silent fuzzy
  substitution. Placeholder entities are visibly incomplete.
- **IMPORT-04:** separate **published-total snapshot** from **component-derived
  character** modes. Preserve attack/skill fidelity where reconstruction is
  incomplete, without double counting. Switching modes requires a preview.
- **IMPORT-05:** conversion review compares source vs derived values, explains
  discrepancies and identifies unresolved mechanics. Actor creation is one
  reviewable action; token vision inheritance is explicit, not guessed from text.
- **IMPORT-06:** add native Library → Convert → Review → Create → Deploy UI;
  keep the compatible Library→SBC path separate. Do not depend on the archived
  converter runtime for ordinary native actor creation.

**Gate:** stratify a manifest of actual corpus records across simple NPCs,
multiclass casters, natural attacks, unusual defenses, SLAs, equipment and complex
formats. Start with a reviewed bounded set (e.g. 50), then expand the denominator.
Verify numbers and representative behavior, not only parse success. Record every
refusal/partial conversion; create and Revert an actor through the real UI.

### M6 — Strategic autonomy and cross-mode history

**Closes:** G09/G10; retains the existing worker/pool engine. **Depends:** M1;
shared area/effect mechanics from M3. **Effort:** L.

- **SIM-01:** compile native profiles by rules/content revision; invalidate caches
  only when relevant source facts change. Preserve bounded per-model columns;
  never instantiate one Foundry actor or emit one document operation per soldier.
- **SIM-02:** add deterministic policy/state machines for engage/advance/hold,
  recover formation, known-hazard withdrawal and explicit order handling.
  Specify command, safety, cohesion and morale precedence with hysteresis.
- **SIM-03:** hazard and formation planners share spatial queries, legal movement
  and action budgets. Respect faction knowledge; decision explanations cannot
  reveal hidden hazards. Bound pathfinding/neighbor work and event output.
- **SIM-04:** choose and document strategic rules variants. Autonomous tactics,
  formation policy and any rout/morale subsystem are product/variant decisions,
  not facts automatically supplied by PF1 or these five modules. Existing morale
  metadata and partial leadership aura do not constitute the subsystem.
- **HIST-01:** recoverable commit journal links document receipt and pool/checkpoint
  versions. Persist intent, staged result and publication status; recover failures
  between storage boundaries without duplicated resources or half-applied effects.
- **HIST-02:** define pre-turn/pre-batch rewind including orders, policy state,
  timers, hazards, effect instances, PRNG inputs and hero resources. Rebuild FX
  from restored state. Earlier revisions require rewind/replay or a managed branch.
- **SIM-05:** label exact vs aggregate resolution modes. Shared primitives do not
  automatically establish identical outcomes across different scales.

**Gate:** several units engage, lose models, reform and escape a known hazard;
explicit orders/policies have predictable precedence. A hero's spell changes
appropriate model state and personal resources exactly once. Replay the same
accepted inputs to equal state hashes; inject crashes/retries around commit
boundaries; rewind both domains and restore only their owned presentation.

### M7 — Lightweight performance and optional compatibility provider

**Closes:** G11/G12. **Depends:** interfaces from M0/M1; benchmark work begins early.
**Effort:** M framework; ongoing per-module compatibility.

- **PERF-01:** measure representative tactical play, catalogue search/import and
  strategic workloads at declared scales (suggest 120/1,000/5,000 models initially).
  Record hardware/browser, p50/p95, memory, checkpoint/delta sizes and input
  responsiveness. Scales are test targets, not current supported-capacity claims.
- **PERF-02:** budget local UI feedback separately from worker resolution/network
  latency. Retain existing model-memory checks, but measure indexes, history,
  assets and UI too. Optimize measured pairwise/pathfinding hotspots.
- **PROV-01:** define per-world/provider authority and version/capability profiles.
  Lazy-load Foundry runtime where feasible; native-only worlds do not need to
  boot the five reference packages for ordinary play.
- **PROV-02:** build structured upstream action-result/capture integration rather
  than parsing chat prose or treating effect creation as the whole cast.
- **PROV-03:** supported actions receive host correlation, scoped authority,
  durable receipts and recovery. Refuse unsupported writes in strict-reversible
  mode; offer explicit limitations elsewhere without pretending state is native.
- **PROV-04:** keep real-source boot/catalogue/UI/cast regression jobs. Test SBC
  separately against a compatible historical profile before claiming all five
  run together. Do not force an obsolete converter onto PF1 11.11.

**Gate:** native and strategic acceptance run without the Foundry runtime;
compatible profiles state tested versions, actions and guarantees. Test isolated
permissions, unsupported APIs, disabled modules, duplicate hook execution,
secret-state projections and startup/performance overhead.

## 4. Ordering, parallelism and initial release boundary

Critical dependency chain:

```text
M0 -> M1 -> M2 -> M3 -> cross-mode M6
             \-> M4 -> richer M5 imports
M0 -> basic M5 parser/review work (parallel)
M0/M1 -> early performance baselines and optional-provider regression (parallel)
```

M4 need not block a useful native MVP. Release a **named supported subset** with
correct core character arithmetic, common attacks, damage/healing, usable
casting/cancellation, real Revert and honest partial-content status. Demonstrate
strategic attack/reform/hazard behavior at measured scale before advertising the
second feature as complete. Expand character/content coverage incrementally.

First three implementation slices:

1. **Reference lock + audit fixtures:** close G01, preserve current behavior,
   make reference skips visible, and pin capability-ledger inputs.
2. **One reversible player cast + Cancel:** close the highest-risk G02/G03 path,
   including host validation, pending saves and approved UI—not a broad redesign.
3. **Portable published FX + complete Entangle:** close G04–G06 for one real
   ability and carry the same ownership model into strategic area effects.

Do not spend the initial cycle converting tens of thousands of descriptions while
the action/cancel/player-publication boundary remains incomplete. Do not defer
all upstream compatibility validation until the end either; keep a small bounded
regression lane so the optional provider remains viable.

## 5. Acceptance discipline and risk register

Every task records: role, source/rules revision, implemented mechanics, unsupported
behavior, affected producer, UI entry/exit, authority boundary, receipt/checkpoint
scope, fixtures, negative tests and human review status. Follow the UI guide;
console-driven mechanics checks cannot substitute for player workflow acceptance.

| Risk | Mitigation / stop condition |
|---|---|
| Reimplementation changes working native behavior | Characterization tests first; narrow extraction; old/new parity gates |
| Native tests agree with native bugs | Independently sourced expected cases and pinned differential runs; discrepancy adjudication |
| Content appears automated but only its text imported | Per-entry capability ledger; supported descriptors required |
| Modifier translation changes stacking or context | Fail closed for unsupported types/formulas; approved explicit mappings |
| Archetype descriptions omit replacement/scaling details | Source-checked schedules; report unresolved rules instead of guessing |
| SBC-like reconstruction invents missing mechanics | Preserve spans/unknowns; explicit snapshot mode and review |
| Large-unit autonomy leaks knowledge or oscillates | Knowledge-filtered inputs, deterministic policies, hysteresis and logs |
| Rewind leaves hero/pool state inconsistent | Coordinated journal, failure injection and replay tests |
| Compatible modules bypass history | Capability admission and strict write/capture boundary; do not promise arbitrary Revert |
| UI regresses into a developer console | Approved interaction design, cancellation tests, ordinary-control multi-client proof and human gate |
| Code/content licensing conflated | Separate provenance and redistribution review; no automatic clean-room/GPL exemption claims |

Track closure by completed acceptance scenarios, corpus denominators and measured
budgets—not by lines of code, screenshot quality or test count alone.
