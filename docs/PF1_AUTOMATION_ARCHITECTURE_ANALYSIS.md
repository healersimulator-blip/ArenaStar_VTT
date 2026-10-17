# ArenaStar architecture reassessment: native automation first

2026-10-18. Supersedes the earlier version of this analysis. Documentation only;
this does not implement or certify the proposed architecture.

## Decision and governing priorities

The priorities are lexicographic, not three equally weighted objectives:

1. Lightweight VTT, extensive automation, dependable action Undo/Revert.
2. Strategic mode: many models assembled into units, with bounded autonomous
   attacks, formation recovery, hazard response and other standing behaviors.
3. Compatibility with modules written for Foundry.

**Recommendation: native-first, with an independently implemented PF1 rules
package, native authoritative action coordination and a deterministic strategic
simulation. Keep Foundry compatibility as an optional, explicitly bounded
provider—not the foundation of the first two features.**

Here native reimplementation means behavior/specification-driven development,
not copying upstream classes or reconstructing the Foundry environment inside
native PF1. Upstream PF1 can inform behavioral specifications and parity tests;
rules sources are needed to resolve disagreements. Formal clean-room claims
would require a documented process and separation not established in this work.

An add-on over Foundry PF1 remains useful for compatibility mode and can provide
broader upstream character behavior sooner. It is not the preferred main engine
under the clarified priorities. Unchanged-module execution is now a third-priority
capability, not a constraint that silently determines the other two features.

## What inspection of this checkout establishes

Existing assets worth building on:

- `src/core/action.ts`: structured actions, per-target outcomes, pending checks
  and presentation context.
- `src/core/actionRevert.ts`: shadow-store inverse capture, post-image conflict
  checks and pending grouped receipts.
- `src/packages/pf1e/conditionApplications.ts`: stable, source-specific condition
  applications and removal policies.
- `src/packages/pf1e/areaPreview.ts` and `targeting.ts`: native targeting geometry.
- `src/core/rules.ts`: pure RulesModule contract with injected randomness and
  no DOM/I/O dependencies in the simulation rules.
- `src/core/strategic.ts`: per-model state in columnar typed arrays, explicitly
  not one document/operation stream per model.
- `src/sim/runner.ts`: seeded resolution, pre-turn snapshots, deltas and reports.
- `src/workers/simWorkerClient.ts`: worker execution and CPU limits.
- `src/host/simBridge.ts`: checkpoint recovery and pre-turn pool restoration.
- `src/packages/massBattlePf1e.ts`: PF1 simulation integration and standing-doctrine
  order synthesis for uncommanded units; explicit orders take precedence.

These are foundations, not proof of complete automation. In particular:

- Native cast orchestration remains substantially in `src/ui/sheets/pf1eCastFlow.ts`;
  some paths submit messages and mechanics separately. Move authoritative
  orchestration out of UI, rather than expanding that pattern.
- Native spell-effect vocabulary and import mappings are incomplete. Inspecting
  files/tests is not a quantitative PF1 coverage audit.
- Existing doctrine code does not establish complete rank-reforming or intelligent
  hazard avoidance. Those require explicit policies, implementation and tests.
- Pool restoration/replay is not proof that every associated document, condition,
  clock, order and FX is restored consistently.
- The current Foundry ActiveEffect-to-FX bridge is not a semantic casting adapter;
  its run associations are in memory, and its successful demonstration does not
  establish a player-shared casting workflow.

## Why the priority order changes the answer

### Priority 1: automation and Revert favor native action ownership

A complete action includes validation, targeting, resource costs, rolls, effects,
messages and lifecycle. Reliable Revert requires knowing which state changes it
owns. A native engine can make that relationship explicit before committing.

An upstream add-on can implement this too, but must contain asynchronous document
writes and hook side effects, correlate them, identify completion, handle partial
failure and adapt permissions. That cost is warranted when upstream fidelity is
primary; here it should not define the default execution architecture.

Lightweight means bounded CPU/memory/network behavior and optional runtime
loading, not merely a small download or fewer files. No current numerical
performance superiority is claimed without profiling.

### Priority 2: strategic autonomy makes the native choice stronger

Large units should not require a Foundry Actor instance, sheet lifecycle, hook
chain or network write for every simulated soldier's decision.

The existing ModelPool/worker/delta design is a better fit: prepared unit profiles,
compact model state, batched calculations, spatial queries and bounded reports.
Share native mechanical primitives between tactical and strategic execution,
but do not route every bulk attack through tactical UI/document controllers.

Two executors are appropriate: tactical actions and strategic batch resolution.
They need shared semantics, identifiers and coordinated history—not identical
storage, one huge generic interpreter or a document per model.

### Priority 3: preserve compatibility without making it universal authority

Retain AIS/Foundry execution as optional infrastructure. A module can have useful
content, sheets, UI tools or automation, with different support requirements.
Compatibility should state the implemented API surface and tested versions.

An opaque module may write state without exposing sufficient semantic context
for full automation or Revert. Report that limitation or refuse its execution in
strict-reversible mode. Do not silently promise native guarantees for arbitrary
module behavior, and do not label converted data as unchanged module execution.

## Recommended architecture

```
Native UI / optional compatible UI
                |
    authenticated intents and targeting sessions
                |
    host authority + action coordinator + history
         /                         \
 tactical rules evaluator      strategic executor
 native PF1 / other rules      worker, pool, policies
         \                         /
  coordinated commits, effect ownership, checkpoints
                |
 committed outcome events + audience-safe projections
                |
     native FX, chat, replicated presentation

Optional Foundry provider -> same authority/history boundary
                           (declared capabilities only)
```

PF1 remains a rules package, not kernel logic. The core understands actions,
permissions, causal history and presentation contracts, not Entangle's DC rules.

A compatibility provider must not simultaneously apply the same mechanics as the
native provider. Choose one owner for each action and state domain. Do not run
parallel authoritative native/upstream character calculations with ongoing
bidirectional synchronization.

### Independently implement behavior, not runtime machinery

Build source-checked behavioral specifications for modifiers, derived values,
resources, saves, resistance, damage, conditions and special interactions. Reuse
native components where correct; implement missing behavior independently.

Use deterministic differential tests against pinned upstream fixtures as parity
checks, not as the only source of truth. Upstream bugs must not automatically
become native rules. Preserve source provenance and versioned expectations.

Content importing is a separate project: preserve structured formulas, units,
save definitions, source identity and supported automation descriptors. A feat
or archetype that can be displayed is not necessarily mechanically supported.
Unknown mechanics must remain explicitly unsupported/manual, not inferred from
prose and presented as automated.

### One action lifecycle, two execution scales

Persist an action ID, initiator, source item/ability identity, relevant revisions,
resource expenditure, targets, rolled results and owned effects. Validate on the
host. A player's valid cast authorizes a controlled resolution—not arbitrary
writes to enemy actors or broad GM execution rights.

Targeting is an uncommitted session. The Wizard may author the reticule's look,
but rules determine legal placement and the host revalidates confirmation.
Cancellation spends nothing. Use separate presentation phases for targeting,
cast commitment, per-target outcome, effect start and effect end.

A pending save or reaction needs a durable state machine; it is not a database
transaction left open indefinitely. Transition retries must be idempotent.
FX is derived presentation: missing assets must not invalidate valid mechanics.

Portable FX bindings need source identity separate from owned item/action IDs.
A GM publishes the binding with explicit use/view rights; player imports retain
source identity while resolving anchors from their own cast. Names or hard-coded
GM actor/item IDs alone are insufficient.

### Strategic autonomy is bounded decision-making

Prefer deterministic policy/state machines and utility scoring to an LLM or
arbitrary macro per model per tick. Typical policies: engage, hold, advance,
recover formation, withdraw from a known hazard, retreat/rout and obey an explicit
order. Specify when safety or morale overrides a command rather than assuming
one universal precedence.

Every autonomous choice should generate an attributable order/decision with its
reason and tick. Respect faction knowledge; avoidance must not reveal hidden
hazards. Add hysteresis/cooldowns to prevent oscillating between reform/attack
or escape/return every tick.

Use cached profiles, incremental spatial/hazard indexes, local neighbor queries,
budgeted pathfinding, deterministic tie-breaking and bounded event aggregation.
Formation recovery and hazard escape need shared movement budgets, collisions,
cohesion and morale rules, not independent scripts pulling tokens in different
directions. Large per-model pairwise scans need profiling and replacement where
necessary; native code alone is not a performance guarantee.

Explicitly choose whether strategic combat preserves individual PF1 resolution
or uses a documented aggregate approximation. Sharing mechanical primitives does
not guarantee identical outcomes across different resolution scales. Any
approximation must be visible in the rules mode, tested and kept out of claims
of exact tactical parity; batch execution alone need not imply approximation.

### Revert must cover documents and simulation state

Use two compatible mechanisms:

- Tactical actions: captured inverses plus post-image/path conflict checks.
- Strategic resolution: checkpoints and deterministic replay of accepted orders
  and decisions, with stable rules versions, randomness and execution ordering.

Coordinate them through one host-owned history boundary. A strategic spell that
changes hero resources and unit-pool state must not leave half its effects after
failure, crash or rewind. Use a recoverable commit protocol linking the relevant
pool/checkpoint version and document receipt; an ordinary document transaction
alone does not provide that guarantee.

For autonomous resolution, the initial supported undo boundary should be the
last completed turn/tick batch. Earlier changes require rewind/replay or an
explicitly managed history branch. Do not promise that one unit's old attack can
be removed independently after later targeting, morale and movement depended on
it. Seeded randomness and per-unit streams do not remove those dependencies.

Checkpoints/replay inputs must cover all causally relevant state: orders,
autonomy policy state, timers, hazards, effects, resources and randomness—not only
positions and HP. UI after-action replay must be distinguished from changing the
live authoritative world.

Revert cancels pending work and reconciles persistent FX by action/effect ID.
Redo reuses recorded resolution rather than secretly rerolling. Already heard
sound and disclosed secrets cannot be undone; define that boundary explicitly.

## Reassessment of the three implementation routes

| Route | Main VTT automation/Revert | Strategic mode | Foundry compatibility | Verdict |
|---|---|---|---|---|
| Native independent rules + optional compatibility | Best design fit; completeness still costly | Fits existing worker/pool architecture | Explicit separate provider/import boundaries | Recommended |
| Foundry PF1 + primary automation add-on | Faster upstream coverage; substantial action capture work | Still needs separate native bulk engine and semantic bridge | Strongest starting point within adapter coverage | Useful compatibility mode, not default foundation |
| Wholesale upstream runtime transplantation | Retains dependencies or creates a maintained fork | Poor hot-loop fit | Fork can drift from upstream | Do not pursue |

Native costs remain serious: character progression edge cases, feats/archetypes,
spell semantics, imports, correctness and regression maintenance. This decision
is about alignment with ranked goals, not a claim that native is universally
quicker or already complete.

## Sequence of work and acceptance criteria

1. Audit native capability coverage and actual performance. Separate proven,
   partial and missing behavior for tactical actions, strategic decisions,
   cross-mode effects, history and imports. Define budgets on stated hardware
   and model counts; measure p95 latency, peak memory and network traffic.
2. Establish host-owned action lifecycle/commit boundaries; consolidate native
   orchestration out of UI. Specify player publication and portable FX identity.
3. Complete a tactical vertical slice: GM-published compendium-derived Entangle,
   real player cast, Wizard reticule/animation, independent saves, source-specific
   conditions, overlap, expiry, reconnect and Revert. Automate supported rules;
   label unsupported ones. Repeat with damage and delayed-resolution actions.
4. Connect the strategic history boundary. Demonstrate units engaging, reforming
   after losses and responding to known hazards, with explicit decisions and no
   double spending/acting. A hero's area spell must affect the appropriate models
   and rewind consistently with the hero's resource/condition state.
5. Verify deterministic replay under the declared execution contract and test
   crashes/retries at commit boundaries. Test untrusted players and secret-state
   projection as well as GM-only happy paths.
6. Extend compatibility incrementally. Declare modules/versions and capabilities;
   isolate their runtime costs and unsupported writes. Compatibility work must
   not redesign the native hot loop or weaken Revert/security promises.

Do not defer all compatibility testing to the end: use a small ongoing suite to
keep the provider boundary viable. But it must not monopolize the feature roadmap
or block shipping a useful native engine merely because arbitrary Foundry modules
cannot run yet.

## Licensing and implementation discipline

Independent behavior implementation and literal code adaptation have different
provenance. Do not claim a formal clean room without the required process.
Upstream GPL obligations require review if code is copied/adapted; independently
written code is not permission to redistribute upstream packs or artwork without
their separate notices/permissions. Retain content provenance and get appropriate
licensing review rather than assuming architecture alone settles it.

## Final conclusion

Build ArenaStar as a lightweight native automation/simulation platform that can
also host compatible Foundry modules—not as a Foundry compatibility platform
whose primary features must be retrofitted around arbitrary module execution.

## UI implementation standard

See [UI implementation and rework guide](UI_IMPLEMENTATION_AND_REWORK_GUIDE.md)
for the Foundry V14/Roll20 reference patterns, interaction contracts, rework
sequence and usability acceptance gates that accompany this architecture.

## Measured audit and implementation backlog

The [native capability-gap audit](PF1_NATIVE_CAPABILITY_GAP_AUDIT.md) adds a
reproducible five-reference inventory, current native mapper/import probes and
focused regression evidence. The [implementation plan](PF1_NATIVE_IMPLEMENTATION_PLAN.md)
turns its gaps into ordered work packages and acceptance gates. Its measured
runtime findings take precedence over architectural possibilities described here;
for example, a declared expiry type is not an implemented native expiry scheduler.
