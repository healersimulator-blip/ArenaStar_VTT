# Condition & effect Revert — capability gap, dependency map and implementation plan

**Status:** Implementation in progress (2026-10-05) on `arena/01a10b30-arenastar-vtt`.
- **Phase 0:** Landed characterization tests in `tests/host/effectRevertScope.test.ts`. R1–R7 decisions resolved.
- **Phase 1:** Landed canonical id-keyed condition applications (`actor.system.pf1e.conditionApplications`), mechanics integration with `PF1E_CONDITIONS` including Deafened, source tracking, and non-destructive legacy array reconciliation.
- **Phase 2 & Phase 6:** Landed host-authoritative manual condition actions (`pf1e.condition`, `0x54`/`0x55`), host-owned condition Revert receipts, and Core PF1e poison state machine (`pf1e.poison`, `0x52`/`0x53`) covering exposure saves, multiple-dose stacking, DC scaling, duration extensions (with round-down per dose), consecutive vs nonconsecutive cure streaks, onset, Delay Poison pausing, and neutralizations. Generic client Ops directly mutating condition applications or poison state are rejected by the host.

**Revision summary:** separates undoability from rules execution; makes the canonical condition
instance/mechanics layer a prerequisite; removes the incorrect timed-Prone proposal; and expands
Phase 6 into a host-authoritative PF1e Core poison/save/dose state machine. It does not claim that the
current condition library or any poison behavior is complete.

**Question this answers.** After PR #37 shipped the Action System (D-405), the question was whether a
GM can revert a condition the way they can revert hit points — `entangled`, `grappled`, `sickened`,
`prone`. The answer is **not yet, and not because revert is limited to HP**: the three revert
mechanisms are field-agnostic and _would_ restore a condition list or an effect document. What is
missing is that **no producer ever puts a condition/effect op into an envelope that a revert
mechanism owns**. HP is revertible because the HP writers happen to be the only writers that carry a
receipt or a ledger — not because revert examines the field.

This document is the gap (§1–§2), the full dependency map for the system that must change —
including the producers the question names: spells, poison, bull rush, trample (§3) — and a phased
plan (§4) with explicit non-goals (§5) and the decisions that need a call (§6).

**Read with:** `ACTION_SYSTEM.md` (the durable-fact/authority boundary this plan must not cross),
`PF1e_Unified_TODO.md` §13 F01 (the ledger contract this plan completes — see §1.4),
`GAP_ANALYSIS_Roll20_Foundry.md` (competitor-parity view; this is _not_ one of its G-items),
`DECISIONS.md` D-012 (array diff semantics), D-142/D-144 (effect apply path and the condition
library), D-405 (what an action card may and may not carry).

**PF1e rules anchors used in this revision:** [Conditions, CRB p.565](https://aonprd.com/Rules.aspx?ID=413),
[Trip/Overrun, CRB p.201](https://aonprd.com/Rules.aspx?ID=44),
[Dirty Trick, APG p.321](https://aonprd.com/Rules.aspx?ID=441),
[Grapple, CRB p.199](https://aonprd.com/Rules.aspx?ID=191),
[Afflictions, CRB p.555](https://aonprd.com/Rules.aspx?ID=417),
[Poison, CRB p.557](https://aonprd.com/Rules.aspx?ID=420), and Paizo’s
[PF1e poison FAQ](https://paizo.com/blog/i-drank-what-an-faq-on-poison) (initial-save, timing and
multiple-dose clarifications). The default poison implementation in this plan is Core Rulebook PF1e,
not the optional Pathfinder Unchained progression-track variant.

---

## 0. Verdict in one screen

|                                            | Global Undo/Redo (`Ctrl+Z`)                       | Named **GM Revert** (World actions panel)                                                              | Roll-card **Revert** (F01 ledger)                                                                 |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Unit                                       | newest OpLog envelope, LIFO                       | one `actionReceipts` document = every op of the audited transaction                                    | one chat card's `ledgerOps`                                                                       |
| Restores conditions?                       | **yes** — a condition write is an ordinary op     | **yes, by construction** — the receipt stores exact inverse ops, field-agnostic                        | **yes, by construction** — same, per card                                                         |
| Does any condition/effect producer use it? | n/a (every op is undoable)                        | **no** — only Tagger rules, scripts, prefabs, summon/dismiss, active zones, damage/healing are audited | **no** — only `pf1eResolveFlow`'s attack/Manyshot/explosion cards, and they carry HP/temp-HP only |
| Granularity of its staleness gate          | none                                              | whole document (SHA-256 post-image)                                                                    | per recorded diff path                                                                            |
| Verdict for a mis-applied `Entangled`      | works, until something newer is on the undo stack | not offered: there is no receipt to press                                                              | not offered: there is no ledger card                                                              |

So the user-visible summary is: **`Ctrl+Z` is the only way to undo a condition today, and only while
it is the newest undoable change.** The machinery for a _named, per-action_ condition revert exists
and is proven to work (§1.3); the producers simply never hand it a condition. Separately, a reversible
name is not proof that its PF1e modifiers/actions are mechanically active; Phase 1 now closes that
rules-resolution gap before Phase 2 wires producers to Revert.

---

## 1. What exists today (verified, not inferred)

### 1.1 The three revert mechanisms

| Mechanism                     | Code                                                                                                                                                                                                                                         | Gate                                                                                                                                                                                                        | Named refusals                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global undo/redo              | `src/core/undo.ts`, `HostSync.undo()` at `src/host/sync.ts:6972`, redo at `:6985`, "undo only if it is yours" at `:7005`                                                                                                                     | none beyond the LIFO stack; GM (or the author, via `undo.last`)                                                                                                                                             | "nothing to undo", "the change to undo is no longer in the log", "the last undoable change was not yours"                                                                                                                                                                                      |
| Named GM Revert               | `src/core/actionRevert.ts` (`extendActionReceipt` `:38`, `actionStaleReason` `:103`), host handler `HostSync.handleActionRevert` `src/host/sync.ts:3258`, UI `src/ui/chat/ActionRevertPanel.svelte`                                          | GM only (host-checks `role === "GM"`), rate-limited, receipt must be `ready` (or a settled `pending`), every recorded post-image must still match, no new dependents, no chat eviction caused by the revert | "Only a GM can Revert world actions", "Action is missing or already reverted", "Action is still running; try again after it finishes", "Action is stale: `<coll>/<id>` changed after this run", "Action has new dependent documents; Revert refused", "Revert would evict later chat; refused" |
| Roll-card Revert (and Reroll) | `src/packages/pf1e/rollLedger.ts` (`rerollOps` `:271`, `revertOps` `:302`, `ledgerStaleReason` `:178`, `DELTA_HP_PATHS` `:215`), host handler `handleRollRevert` `src/host/sync.ts:6752` (dispatch `:973`), UI `src/ui/chat/RollCard.svelte` | GM (or the delegated player for a reroll), 2-round window, per-path post-values must match, pre-images must exist                                                                                           | "revert window closed or already reverted", "only GM can revert", "ledger stale — effects changed since", "ledger has no pre-images — revert is impossible by design"                                                                                                                          |

Receipts live in their own private collection (`actionReceipts`), are never projected to players, and
are capped at 4 096 inverse ops / 1 000 000 bytes (`MAX_ACTION_RECEIPT_OPS` /
`MAX_ACTION_RECEIPT_BYTES`). The ledger lives on the card (`MessageDocument.system.rollLedger`) and
is pruned after the 2-round window. Both store **exact inverse ops captured from a shadow preflight**
(`commitOps` at `src/host/sync.ts:2808` builds them for audited envelopes; `captureLedgerInverses` for
cards) — an update op is a whole-value diff, so restoring a `system.pf1e.conditions` array or an
`actor.effects` array is mechanically the same as restoring `system.pf1e.hp`.

### 1.2 The two homes a condition can live in

| Home                                                    | Shape                                                                                  | Written by                                                                                                                                                                                                                  | Ticked / expired by                                                                                                | Read by                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A — `actor.system.pf1e.conditions`                      | `string[]` of names, **no metadata** (no duration, no source, no id)                   | `src/ui/combat/pf1eManeuver.ts` `conditionOps` `:47` / `conditionSetOps` `:61` (trip, overrun, dirty trick, grapple, maintain, pin, tie-up, escape, release), `pf1eDyingTick.ts:61` (Stable), `pf1eFirstAid.ts:52` (Stable) | nothing automatic — by construction "conditions are state, not timers" (`src/packages/pf1e/conditions.ts:514–520`) | `actor.ts` derivation union `:1509`; badges; action-deny legality; automation filters; agents/MCP reads |
| B — `actor.effects`                                     | `EffectDocument[]` with `flags.pf1e` payload (mods, denies, flags, `ttl`, `condition`) | `effectOps.ts:124` `pf1eApplyActorEffect` (Effects tab → `PF1eActorSheet.svelte:2092`; the 27-condition library and the custom editor)                                                                                      | `worldClock.pf1eClockSweepOps` `src/packages/pf1e/worldClock.ts:204` for clock-counted `ttl`                       | same union; `resolveTacticalEffects`                                                                    |
| B′ — `combatant.flags.core.effects{id: EffectDocument}` | **id-keyed record** (not an array)                                                     | `effectOps.ts:290` `pf1eApplyCombatantEffect`                                                                                                                                                                               | `core/combat.ts:291` `tickEffects` at that combatant's turn end (`duration: null` persists)                        | same union via `combinedTacticalEffects`                                                                |

Names also surface in combat annotations (`combatState.ts`), HP-adjacent state (dying/stable gates),
and the action card's bounded `conditions: { applied, removed }` **text** (`src/core/action.ts:120`,
rejected outright on a pending target at `:284–285`) — but that field is a report, not a write: D-405
guarantees a client-authored card never changes HP, conditions, inventory or permissions.

**Rules-execution caveat (new G-A9):** Home A is not mechanically equivalent to Home B today.
`derivePF1eActor` resolves numeric modifiers/flags/denials from `input.effects`; it appends authored
Home-A names to the derived condition-name list afterward. It does not call `pf1eConditionPayload`
for every string in `system.pf1e.conditions`. A maneuver can therefore write a visible `Prone` or
`Entangled` label without automatically applying the library payload; only the consumers that
explicitly inspect that name get its effect. The existing condition library is also a supported
subset: `pf1eDirtyTrick` permits **Deafened**, but `PF1E_CONDITIONS` has no Deafened definition.
Phases 1–2 below now require mechanics and state to agree, not merely a reversible label.

### 1.3 The evidence (Phase 0, landed)

`tests/host/effectRevertScope.test.ts` (4 tests, passing) drives the real `HostSync` over the
in-memory transport:

1. an ordinary condition intent (`{ "system.pf1e.conditions": ["Prone","Sickened"] }`) → `host.undo()`
   restores `["Prone"]`;
2. the same write inside a host-audited envelope → `client.actionRevert(id)` restores `["Prone"]` and
   flips the receipt to `reverted`;
3. the shipped library path (`pf1eConditionRequest("Entangled")` → `pf1eApplyActorEffect`, a
   whole-array `effects` diff) → Undo removes the effect; the identical ops inside an audited
   envelope are removed by the named Revert;
4. a later _unrelated_ HP edit on the same actor → the Revert is refused with
   `"Action is stale: actors/victim changed after this run"`; receipt stays `ready`, conditions
   untouched.

Cases 2 and 4 reach `HostSync`'s audit plumbing through a narrow private cast, deliberately: **no
public producer can construct that envelope today**, which is the finding. Phase 1 replaces those
cases with public-path tests over a real maneuver card.

Reproduce: `corepack pnpm exec vitest run tests/host/effectRevertScope.test.ts`
(environment notes in Appendix A).

These tests prove the inverse machinery, not that Home-A condition names invoke their PF1e payloads;
that separate derivation gap is recorded in G-A9 and Phase 1.

The two revert _surfaces_ were **executed** in the same pass (Chromium 153 over
`file://dist/index.html`, `--workers=1`): `e2e/action_revert.spec.ts` 3/3 (GM Revert restores a
trap's HP/temp HP/chat, a reviewed script's world tags, and a player-tile click's damage, without
exposing receipts), `e2e/roll_ledger.spec.ts` 3/3 (settings + highlight layer, and the delegated
player reroll) — all 6 pass. Those specs cover HP/tags/ledger UX, **not** conditions: that
absence is exactly this document's gap, and Phase 1 adds the missing specs to the same files.

### 1.4 An honest reading of the F01 contract

This is not a new feature request that nobody wrote down. **F01 already promises it**, twice:

- the user story (`PF1e_Unified_TODO.md:1468`): "**Revert** removes _all_ effects of that card as if it
  never happened (damage healed, `prone` condition removed, fireball's `burning` expired, a model
  that died from that card's damage is back alive at its pre-card HP)"; and for Reroll, "condition Ops
  are swapped";
- the data model (`:1492`): "`ledgerOps: Op[]; // exact Ops submitted for this card (HP, tempHP,
  **conditions**, ledger state, spell slots)**";
- and in code: `rollLedger.ts:3–4` — "Every tactical roll that writes HP/conditions is also a chat card
  that owns its ledgerOps (the exact Ops the host committed)".

What shipped is the HP half. `planDamageDeltaReroll` refuses a non-HP ledger **by name** ("card writes
more than HP — reroll cannot recompute it; revert and roll manually",
`tests/packages/rollLedger.test.ts` "non-HP ledger is refused by name"), and no flow builds a
condition ledger at all. The refusal is the honest half — the engine refuses rather than fabricating
an effect it cannot recompute — but the promised coverage is not there. F01's box is `[x]` because
its _HP_ acceptance ran; its condition clause never did. That is the gap this document closes, plus
the producer work (spells, afflictions, movement maneuvers) that would otherwise re-open it later.

---

## 2. The capability gap, itemized

| #        | Gap                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                 | Blast radius                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-A1** | **No condition/effect producer owns a revert envelope.** The six flows that write conditions today submit plain intents; the one producer class that _is_ audited (automation active zones) has no condition-apply step at all (its `condition` step is a filter, `src/core/automation.ts:107`).                                                              | §3.2 producer table; `pf1eManeuverFlow.ts:399–415` posts the card and the ops as **two separate envelopes**                                              | every named revert surface reports "nothing to revert" for a condition                                                                                                                                                |
| **G-A2** | **F01's condition clause is unmet.** `ledgerOps` has never carried a condition/effect op; Reroll refuses non-HP ledgers by name; no maneuver/dying/first-aid card is a ledger card.                                                                                                                                                                           | §1.4                                                                                                                                                     | the "roll card = undo surface" promise is half-true; a dirty-trick card cannot be reverted or rerolled                                                                                                                |
| **G-A3** | **Write granularity is coarse by construction.** FlatDiff cannot delete an array element (`src/core/diff.ts:10`, D-012), so any add/remove rewrites the whole `conditions` / `effects` array. A per-path staleness gate is therefore effectively whole-array for those homes; unrelated damage on the same actor also blocks a receipt (whole-document gate). | §1.3 case 4; `tests/packages/rollLedger.test.ts` staleness suite                                                                                         | "revert the grapple" can be refused by an unrelated HP write; surgical reverts are impossible without a shape change                                                                                                  |
| **G-A4** | **Two parallel condition homes with different capabilities and no shared authoring.** Names-only (`string[]`, no duration, no UI to add one by hand) vs payload effects (durations, denies, immunity, editor). Maneuvers write home A; the Effects tab writes home B; the derivation unions them.                                                             | `actor.ts:1509`, `PF1eEffectsTab.svelte`, `effectOps.ts`                                                                                                 | a GM's "apply condition" and a maneuver's "trip" produce structurally different state with different expiry behaviour                                                                                                 |
| **G-A5** | **Maneuver durations are computed and discarded.** `pf1eDirtyTrick` returns `durationRounds` and the removal rule ("move action"), but the planner writes only the name — nothing expires, nothing records when it should.                                                                                                                                    | `src/packages/pf1e/maneuvers.ts:578–620`, `pf1eManeuver.ts:146–160`                                                                                      | conditions accumulate until a human edits them; a Revert has no "expiry" peer to interact with                                                                                                                        |
| **G-A6** | **Movement maneuvers are not world writes at all.** Bull rush / drag / reposition return note-only plans; the push is "the caller's map concern" (a separate drag). Trip/overrun's prone is a write.                                                                                                                                                          | `pf1eManeuver.ts:108–119, 161–182`                                                                                                                       | there is nothing atomic to revert: the card and the map move can diverge silently                                                                                                                                     |
| **G-A7** | **Spell outcomes never touch conditions or effects.** `runSpellEffect` writes HP, the SR round-ledger and slots; a deferred save creates an explicit pending "spell effect" row that says _no damage or condition is inferred_. 71 of the 75 shipped spell entries are `automation: "descriptive"`.                                                           | `pf1eCastFlow.ts:547–736`; deferred row `:1531–1539` (`:1537` “no damage or condition is inferred from the card”); `systems/pf1e-core/packs/spells.json` | the largest producer family is absent, so the revert contract must be frozen before it arrives (`ACTION_SYSTEM.md:141–143` names the missing host-owned continuation, and `:172` makes it an explicit next extension) |
| **G-A8** | **Afflictions (poison, disease) have no model at all.** "poison" exists only as an effect _source type_ and in mitigation prose. Separately, `trample` has no tactical implementation (Phase 7); the strategic profile resolves it in the pool.                                                                                                  | `effects.ts:128,412`; `mitigation.ts:24,26,360,622`; `statBlock.ts:25–26`; `schema.ts:139–141,237–239,381–383`; `combatEngine.ts:671–700`                | new producers will need the same "apply → expire → revert" contract; building them first would repeat G-A1 three more times                                                                                           |

Additional rules-review gaps that the first table did not separate:

- **G-A9 — condition labels are not a canonical mechanical resolver.** Home-A names are appended to the readout, while the derivation resolves condition mechanics from effect payloads. The condition library is incomplete for a condition the Dirty Trick planner already allows (`Deafened`). Phase 1 must close this before a Revert test can be called a rules test.
- **G-A10 — no condition-application identity or source lifecycle.** A `string[]` cannot distinguish simultaneous applications, track the specific source/action that expires or is removed, or represent a grapple relationship. Name-level deduplication/removal can erase a still-live source.
- **G-A11 — the proposed ledger path has a privacy and durable-revert conflict.** `RollLedger` stores raw `ledgerOps`/`ledgerInverses` on `MessageDocument.system`; normal public message projection does not strip them. A receipt also hashes the whole message post-image, so ledger edits/pruning make the receipt stale. Phase 3 must fix both before promising player-visible card controls or receipt fallback after the ledger window.

---

## 3. Dependency map

### 3.1 Storage, shape and write granularity

| State                | Home                                            | Shape                        | Can a remove be expressed per element?                  |
| -------------------- | ----------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| condition names      | `actor.system.pf1e.conditions`                  | array of strings             | no — whole-array replace (`-=` on an index is rejected) |
| effects (actor)      | `actor.effects`                                 | embedded `EffectDocument[]`  | no (array element deletion unsupported, D-012)          |
| effects (combat)     | `combatant.flags.core.effects`                  | **id-keyed record**          | **yes** — `-=flags.core.effects.<id>` is a legal diff   |
| ability damage/drain | `system.pf1e.abilitiesDamage`, `abilitiesDrain` | keyed record                 | yes                                                     |
| negative levels      | `system.pf1e.negativeLevels`                    | scalar/record                | yes                                                     |
| temporary HP         | `system.pf1e.tempHpSources`                     | keyed record                 | yes                                                     |
| item state           | `actor.items[i].system.*` (broken, hp)          | array element + object field | field yes, element no                                   |
| action record        | `message.system.action.targets[].conditions`    | bounded names, report-only   | n/a (never a write)                                     |

**Consequence for the plan:** the condition array and actor-effects array are both coarse whole-value
writes; the combatant effect record is already id-keyed. New source-bound condition applications
should therefore live in a separately keyed map (proposed: `system.pf1e.conditionApplications[id]`),
not by turning the legacy string array into an undocumented string/object union. The legacy
`system.pf1e.conditions: string[]` remains readable; new writers use the keyed map after every reader
has a normalizer. This is an explicit persisted-document contract change and must be decided, typed,
validated, projected and round-tripped before it is written. Do not duplicate a condition's mechanical
payload in multiple homes.

### 3.2 Producer inventory (who writes what, through which envelope)

| Producer                                                                                    | Writes                                                                                                            | Envelope today                                                               | Named revert today?                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maneuver flow — trip, overrun, dirty trick, grapple, maintain, pin, tie-up, escape, release | home A condition names (whole-array)                                                                              | card envelope + ops envelope, **both plain** (`pf1eManeuverFlow.ts:399–415`) | no                                                                                                                                                |
| Dying tick (CombatPanel)                                                                    | home A `Stable`, HP                                                                                               | plain (`CombatPanel.svelte:529`)                                             | no (Undo only)                                                                                                                                    |
| First aid (CombatPanel)                                                                     | home A `Stable`                                                                                                   | plain (`CombatPanel.svelte:690`)                                             | no                                                                                                                                                |
| Effects tab — apply/edit/remove/suppress (actor home)                                       | home B whole array                                                                                                | plain (`PF1eActorSheet.svelte:2082,2092,2147`)                               | no                                                                                                                                                |
| Effects tab — combatant home                                                                | home B′ (id-keyed)                                                                                                | plain (`effectOps.ts:290`)                                                   | no                                                                                                                                                |
| Coup de grâce, rest, energy drain, negative levels, temp-HP panel                           | HP / ability / negative levels / temp HP                                                                          | plain                                                                        | no                                                                                                                                                |
| Attack / Manyshot / firearm explosion (`pf1eResolveFlow`)                                   | HP, temp HP, `attacks[i].broken`, grit                                                                            | **F01 ledger on the card**                                                   | yes for HP/temp HP; attacker-side writes (broken/grit) are in the same envelope but their reroll is a **named refusal** (`planDamageDeltaReroll`) |
| `roll.apply` (Damage/Healing verb on a card)                                                | HP, temp HP, card flags                                                                                           | **audited envelope** (`sync.ts:6748`)                                        | **yes**                                                                                                                                           |
| Automation active-zone steps                                                                | HP (`hurtHeal`), move, rotate, delete, visibility, doors, tags, chat, game time, lighting, tile image, roll table | **audited envelope** (`sync.ts:5027`)                                        | **yes** — this is the reference implementation of "a producer that already does it right"                                                         |
| Reviewed scripts                                                                            | chat, tags, fx instances, macros, prefabs, summons (`SCRIPT_GRANTS`, `scriptMacros.ts:11`)                        | **audited envelope**, at-most-once guard                                     | **yes**                                                                                                                                           |
| Tagger rule expansion                                                                       | tags                                                                                                              | **audited envelope** (`sync.ts:3221`)                                        | **yes**                                                                                                                                           |
| Prefabs, summon/dismiss                                                                     | placeables, tokens                                                                                                | **audited envelope** (`sync.ts:4309,4411,4442`)                              | **yes**                                                                                                                                           |
| Module API (sandboxed iframe or trusted page)                                               | `tokens.list`, `tokens.move`, `chat.create`, settings, hooks (`moduleApi.ts`)                                     | host intents                                                                 | n/a — **cannot write conditions at all**                                                                                                          |
| FX (timelines, bindings, instances)                                                         | presentation only                                                                                                 | n/a by contract (D-405: FX can render/anchor, never mutate)                  | n/a                                                                                                                                               |
| Compendium / character import                                                               | whole documents                                                                                                   | bundled ops                                                                  | n/a (bulk import, not a per-action edit)                                                                                                          |

Rule of thumb this table exposes: **revert coverage tracks the envelope, not the field.** Everything
audited is revertible; nothing else is.

### 3.3 Revert machinery matrix (what a future producer must satisfy)

| Requirement                                                         | Where enforced                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| exact inverse ops exist (including repeated writes to one document) | `extendActionReceipt` shadow preflight (`actionRevert.ts:38`), `commitOps` (`sync.ts:2834`)                                                        |
| post-images recorded at commit time, not recomputed later           | `actionDocHash` / `receipt.after`                                                                                                                  |
| refusal when the world moved on                                     | `actionStaleReason` (whole-document) / `ledgerStaleReason` (per path)                                                                              |
| pending/async groups are not revertible mid-flight                  | `ActionAudit.pendingUntil` (`actionRevert.ts:23`), `activeActionReceipts` (`sync.ts:3242`), "Action is still running; try again after it finishes" |
| revert must not cascade into NEW dependents                         | `attachedDeletionOps` + `boundFxDeletionOps` closure check (`sync.ts:3307`)                                                                        |
| revert must not evict later chat                                    | preflight `trimmed` check (`sync.ts:3334`)                                                                                                         |
| one commit path, one seq, projection per role                       | `commitOps` (`sync.ts:2808`)                                                                                                                       |
| receipts are GM-only and never replicated to players                | `tests/host/sync.test.ts:8546–8552`                                                                                                                |
| bounded storage                                                     | 4096 ops / 1 MB per receipt; ledger pruned after the 2-round window                                                                                |

### 3.4 Spontaneous mutation — everything that changes a condition _behind_ a revert's back

| Mutator                                                                          | Home                        | Effect on a future revert                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tickEffects` at the owner's turn end (`core/combat.ts:291`)                     | B′                          | writes the same `combatants` document → whole-document staleness for a receipt; same-path staleness for a ledger       |
| `pf1eClockSweepOps` on world-clock advance (`worldClock.ts:204`)                 | B                           | same, on the actor document                                                                                            |
| concentration lapse / sustained-spell end (`combatState.ts`)                     | B/B′                        | same                                                                                                                   |
| temp-HP source expiry                                                            | `system.pf1e.tempHpSources` | unrelated path for a ledger; blocks a receipt                                                                          |
| action-card pending window (two rounds) and ledger pruning                       | composite                   | a revert after the window needs the receipt path, not the ledger                                                       |
| chat retention eviction                                                          | messages                    | explicitly tolerated for a single delete (`missingActionMessageDeletes`)                                               |
| strategic hero overlay / mass-battle `pfCondition` column (M03/D-226, M08/D-229) | strategic pool              | a tactical condition edit does not automatically reach the pool; the hero overlay synchronizes at defined moments only |

**This is the design fork the plan must resolve, not an edge case:** a condition that expires naturally
is a _later write to the same path_, so both gates refuse the revert — fail-closed and honest, but the
GM gets no partial undo and no explanation beyond "stale". §6 Q3 asks for the ruling.

### 3.5 Consumers that must not desync

`actor.ts` derivation union (`:1509`) → AC, attacks, saves, CMB/CMD, speed, action-deny tokens
(`actions.ts`, `spendAction`), skill mods; token badges and HP bars; `interrupts.ts` (flat-footed);
`combatState.ts` (dying/stable gates, `pf1eNextTurn` obligations); the CombatPanel condition readouts;
the Effects tab list; automation `condition`/`attributes` filters; agent/MCP read tools
(`src/core/agents/readTools.ts`); `ActionFxContext`'s verified-only projection (D-405); strategic
`heroBridge`/overlay. A revert that restores the document correctly re-derives all of these — the
recompute path is structural, not listener-based — except the strategic pool, which synchronizes on
its own schedule.

### 3.6 Authority, projection and privacy

Writes stay host-authorized (`can(user, "update", actor)`; combatant home: `can(user, "update",
combat)`), and Revert stays host-gated to `role === "GM"`. The host—not a client—constructs audit
receipts and validates poison-save outcomes. The module/script tiers cannot write condition or poison
state; D-405 action cards remain bounded reports and FX remains presentation-only.

**Ledger warning:** private `actionReceipts` are not projected, but F01 ledgers are embedded in public
chat messages. `src/core/projection.ts` currently passes ordinary visible messages through as full
documents/updates; a ledger containing exact condition/effect-array inverse ops can therefore disclose
state. Before adding condition ledgers, either move inverse data to the private host receipt and expose
only a safe summary/opaque receipt ID, or implement and test an explicit player projection that strips
all inverse/forward ops and pre-images. The receipt's post-image check also currently hashes the whole
message; later host ledger updates or pruning must not make an otherwise-valid durable receipt stale.
A card revert and a receipt revert must be one host transaction and one authoritative state, not two
independent inverse copies. `ChatPanel` prioritizes `ActionCard` for structured messages, so its
ledger/Revert controls must be implemented there rather than assumed to appear through `RollCard`.

### 3.7 Tests, coverage and docs to touch

| Surface          | Where                                                                                                                                         | What the plan adds                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| characterization | `tests/host/effectRevertScope.test.ts` **(landed, Phase 0)**                                                                                  | pins today's four behaviours                                                        |
| ledger unit      | `tests/packages/rollLedger.test.ts` (staleness, reroll refusals, ops, pruning)                                                                | condition/effect-carrying ledger cases                                              |
| producer unit    | `tests/ui/pf1eManeuverFlow.test.ts`, `pf1eDyingTick.test.ts`, `pf1eFirstAid.test.ts`, `tests/packages/pf1eEffectOps.test.ts`                  | envelope shape + inverse capture per flow                                           |
| host integration | `tests/host/sync.test.ts` "durable GM Revert for world actions" (`:8510`+)                                                                    | revert of a maneuver card's conditions, stale-actor refusal, unrelated-edit refusal |
| browser          | `e2e/action_revert.spec.ts` (3 specs), `e2e/roll_ledger.spec.ts`                                                                              | trip/dirty-trick → Revert restores the condition; player-triggered maneuver         |
| dashboard        | `scripts/coverage.mjs`, `node scripts/coverage.mjs --check`                                                                                   | the new checklist item is picked up automatically from `PF1e_Unified_TODO.md`       |
| docs             | `DECISIONS.md` per landed slice; `DEVIATIONS.md` **only if** a rule's meaning changes (this plan changes no rule — it is an authority/UX gap) | —                                                                                   |

### 3.8 The families the question names — what each needs from this contract

| Family | Exists today | Missing for a rules-correct, reversible action | Plan phase |
| --- | --- | --- | --- |
| **Trip / overrun** | success writes a `Prone` name | canonical mechanical condition instance + atomic receipt. Prone has **no general turn timer**; it remains until the creature stands or another rule changes it | 1–2 |
| **Dirty trick** | six permitted names; correct 1 + margin / Greater d4 + margin duration is calculated but discarded | canonical payload (including Deafened), evaluated duration, source/action identity, move/standard-action early removal, expiry at the correct boundary, atomic receipt | 1, 2, 4 |
| **Grapple family** | name-level `Grappled`/`Pinned` replacements | per-grapple relationship IDs; break/release only the matching relationship; preserve unrelated grapples; include required pull to adjacent space on a nonadjacent initial grapple; pinned escape remains legal | 1–2 |
| **Bull rush / drag / reposition** | check + notes; movement is a separate map action | host-planned, collision/wall/zone-validated token movement + card + any condition ops in one receipt | 7 |
| **Poison** | `source.kind: "poison"` only | initial exposure save, onset, periodic saves, 1/2/N-save cure rules (consecutive or not), dose stacks, DC/duration adjustment, source-bound effects, and per-event Revert | 6 |
| **Disease** | no model | separate source-verified disease profile; do not assume poison cadence/dose rules are disease rules | explicitly deferred unless separately scoped |
| **Spells** | damage/SR/save/HP pipeline; descriptive pack entries and explicit pending effect row | host-verifiable continuation that commits per-target conditions/effects with the action, preserving spell duration and resistance/immunity rules | 5 |
| **Trample** | strategic profile/pool resolution; no tactical resolution | identify and transcribe the intended PF1e trample rule before coding; then movement, target choice/save, damage and the action receipt | 7 |
| **Disarm / steal / sunder** | check + notes; item writes are a separate sheet concern | item transaction/revert integration is outside this condition plan; do not imply the item consequence is atomic | out of scope |

## 4. Revised implementation plan

### Status — 2026-10-05 (D-406)

| Phase | Status | What landed / what remains |
| --- | --- | --- |
| 0 | **Landed (characterization)** | `effectRevertScope.test.ts`; R1–R7 decided in §6. |
| 1 | **Landed** | Canonical keyed `conditionApplications` with source/removal, legacy-name normalization, one mechanical resolution; `stealthPerception`/`actions` consumers read the payload flags. |
| 2 | **Split — 2a landed, 2b remaining** | 2a: manual condition apply/remove through one host envelope with a receipt, a chat record and the generic-op policy (own manual tags only, GM audit line). 2b: trip/overrun, Dirty Trick, grapple branches, Dying/Stable, first aid still write the legacy path. |
| 3 | **Remaining** | No card-level Revert control; the GM Revert panel works for every audited action today. |
| 4 | **Remaining — one trap closed** | `removal: {kind:"expiry"}` is *refused by name* until the sweep exists (D-407 note below), so nothing promises an expiry nobody consumes (see D-406). |
| 5 | **Partial** | The pending-rider continuation (host re-derivation + evidence) exists for poison; generic spell-effect continuation is still deliberately pending. |
| 6 | **Landed (core)** | Affliction engine, host saves/cadence/dose/DC, Delay/Neutralize, rider delivery on landed interactions, player-deferred saves, Revert, pack data + read surface + browser spec. Remaining: a `creature-derived` fixture (formula path is unit-tested only) and card-level Revert UX (Phase 3). |
| 7 | **Remaining** | Forced movement/trample untouched. |
| 8 | **Partial** | `condition.read` + `ACTION_SYSTEM.md`/`PROTOCOL.md`/`DECISIONS.md`/this status; coverage dashboard and `DEVIATIONS.md` pass still to be re-run with the next slice. |

Phase 2's original body is kept below and split as **2a** (condition producers, landed) and **2b**
(maneuver/health producers, remaining) so a reader cannot mistake the header for the whole phase.

The dependency order is now explicit: first make condition state mechanically real and source-aware;
then route producers through one host-owned transaction; then expose a privacy-safe ledger view. Only
after those contracts are stable do we add expiry, spells, poison cadence and tactical movement. The
plan does not equate “reversible string in chat” with “PF1e condition implemented.”

Conventions for every phase:

- The host creates the audit identity and commits the action card, rules state and mechanical Ops
  atomically. A client cannot submit an `ActionAudit`, trusted save result, DC or dose count.
- `conditionApplications`/affliction instances own source and expiry state. Their derived effects are
  recomputed from the versioned rules definition; action cards report, and never apply, mechanics.
- One private receipt is authoritative for inverse Ops. A card-level control delegates to that host
  receipt; it never carries a second, player-readable copy of pre-images.
- A later expiry/save/replacement is a later world event. Revert refuses rather than time-travelling
  over that event, with a useful refusal reason.
- Every rules number is tied to a source fixture; unsupported entries are visibly refused/reported,
  not silently represented as a condition label.

### Phase 0 — Characterization and contract freeze _(partly landed)_

**Landed:** `tests/host/effectRevertScope.test.ts` (4 characterization tests) pins ordinary Undo,
named Revert, the effect-library path and whole-document stale refusal. Keep these tests; they show what
the rollback machinery does, not that every condition currently receives its mechanics.

**Remaining before production work:** decide R1–R7 in §6 and add characterization for (a) legacy
Home-A labels versus effect-derived mechanics, (b) the Pinned escape action, (c) Deafened’s absence
from the supported definition table, (d) public projection of `rollLedger`, and (e) receipt staleness
after a card ledger update/prune. Record baseline behavior honestly; do not weaken assertions to make a
later implementation pass.

**Acceptance:** focused tests green; R1–R7 and their alternatives/consequences recorded in this plan
(no `DECISIONS.md` implementation entry yet); no production code changed. No browser e2e is needed in
this phase.

### Phase 1 — Canonical condition instances and mechanical resolution

**1a. Persisted shape and compatibility.** Add a validated, id-keyed
`actor.system.pf1e.conditionApplications` map. Each new application has a stable ID, canonical
condition key, host-owned source (`actionId`, source kind/ID and optional relationship/group ID), and
an explicit duration/removal policy or `none`. It is an instance, not a unique name. Retain legacy
`system.pf1e.conditions: string[]` as a read-compatible legacy input; normalize it to permanent,
source-unknown applications for reads without destructively rewriting old worlds. New writers stop
adding strings. Add the schema/type/validation/export-import/replica round-trip story before emitting
map entries; path deletion must be addressable by application ID.

Do not count lifetime exposures as active condition instances. When the same condition is supplied by
multiple sources, retain each source instance; derive the effective rule result from all live sources
and the PF1e interaction rule. A conflict is explicit and condition-specific (for example, Pinned and
Grappled do not stack; fear effects do not simply sum); do not apply a global “latest wins” policy.

**1b. One rules-resolution path.** Extend the tactical derivation so active application instances
resolve through the same validated `PF1E_CONDITIONS` payload/stacking path as other PF1e effects,
exactly once. Keep the displayed condition-name list as a projection of active instances plus legacy
names; it is not a second mechanical source. Ensure the Effects tab’s condition entry point creates a
condition application rather than a conflicting second copy in `actor.effects`; non-condition buffs
remain ordinary effects. Unknown/unsupported legacy labels stay visible with an issue; a new operation
cannot claim success for an unsupported condition.

Complete the specific condition subset required by these producers, including Deafened because Dirty
Trick allows it. Add the missing initiative, sound-based Perception, opposed Perception and verbal
spell-failure consequences through their correct consumers. Audit action exceptions before putting
`denies` in a payload: a pinned creature must still be able to attempt its escape; a prone creature’s
crossbow exception must not be mistaken for permission to use every ranged weapon. State which other
catalogue entries remain out of scope; do not call the 27-entry library a complete PF1e condition
catalogue.

**Acceptance/tests:** applying `Prone`, `Grappled`, `Pinned`, `Shaken`, `Entangled` and `Deafened`
changes the expected derived/action behavior; removing one source leaves a second source in force;
Pinned escape and Dirty Trick early removal remain legal; Pinned replaces the target’s Grappled
application without removing the grappler’s; legacy strings still round-trip and derive once; unknown
legacy names are not fabricated into rules. Add unit tests for mixed legacy/new data and source
removal, plus a sheet/host integration path.

### Phase 2 — Atomic host transactions for existing producers and named Revert

**2a (landed, D-406):** manual condition apply/remove already commits one envelope — conditions,
chat record and private receipt — with the generic-op policy above; its Revert path is exercised in
`tests/host/pf1eConditionAction.test.ts`. **2b (remaining):** the maneuver/health producers below.

This is the first user-visible rollback slice. Replace the current two-submit maneuver path with a
typed host-owned action intent. The client sends the requested maneuver and bounded context; the host
re-reads current actors/encounter, revalidates the check inputs/ownership/visibility, builds the
condition-instance and movement Ops, normalizes the D-405 action record, creates the audit itself and
commits all changes in one `commitOps` envelope. Never accept client-created audit metadata.

Route trip/overrun, Dirty Trick, all grapple branches, Dying/Stable transitions, first aid, and manual
condition apply/edit/remove through that path. A successful initial grapple that starts nonadjacent
must include the required target move to an adjacent open space in the same transaction; a failed
check/no adjacent space commits neither grapple condition nor movement. A failed/rejected action posts
no misleading card. Releasing/escaping clears only the relevant grapple relationship. Keep prone until
stood up; Phase 4 must not add an automatic Prone expiry.

**Acceptance:** GM Revert restores the exact prior mechanical state (including affected sources and
movement) for a trip, Dirty Trick, initial grapple/pin/escape, and first-aid/dying action; re-derivation
matches the pre-action actor; player-triggered actions are revertible only by the GM; malformed/forged
requests are rejected atomically; staleness follows R2 (same-instance edits refuse, unrelated paths do
not spuriously block a keyed application); global Undo still works.

**Tests:** pure planner table for every outcome; HostSync integration for exact receipt contents and
one-sequence atomicity; no orphan action card on refusal; same-condition-instance stale case and an
unrelated HP-path edit allowed under R2 (legacy array writes remain whole-array stale); grapple
relationship/multiple-grappler cases; player/GM permission matrix; Chromium `action_revert` and the
relevant maneuver acceptance specs. Phase 2 proves reversible mechanics only for the supported
condition slice from Phase 1.

### Phase 3 — F01 card UX backed by the private receipt

Do not attach the current raw `ledgerOps`/`ledgerInverses` to a public chat message. Change the ledger
contract for these actions to carry only safe roll/action summary, window/status and an opaque receipt
ID. The host resolves that ID and performs the same receipt transaction used by the World actions
panel. It is one inverse store, not a receipt plus an independent copy of the inverse. Update
`PF1e_Unified_TODO.md`/F01 to state this authority explicitly if its old inline-ops wording must change.

Before enabling card controls, fix the receipt/message coupling: a durable receipt must survive the
host’s own ledger status update and two-round prune, while still refusing any unrecognized mutation.
Use an explicit host-owned mutable-presentation-field allowlist or a separate append-only action-card
reference that is not part of the mechanical post-image hash. Do not simply ignore the whole message
hash. Revert, reroll status and card status update in one host commit; a card-level Revert delegates to
the receipt and cannot double-apply it. Ensure `ActionCard.svelte` renders the safe controls when
`ChatPanel` selects it ahead of legacy `RollCard`.

Initially ship **Revert**, not semantic condition Reroll. Add a family-specific Reroll only when the
host can rederive from the original verified check context and prove every affected input/document is
unchanged; a planner accepting a new die face alone is insufficient. For a reroll that changes a trip
from hit to miss, remove only that action’s Prone application; for a changed Dirty Trick margin,
replace that application/duration, never union outcomes.

**Acceptance/tests:** no inverse/pre-image or hidden effect leaks in GM/player snapshots, live diffs or
player-authored views; card Revert and World actions Revert reach one host path; two consecutive presses
cannot apply twice; Revert still works after ledger pruning/card-control changes; an edit to the same
application/receipt path refuses while unrelated paths follow R2; ActionCard controls render in a real
public message; unsupported rerolls refuse by family name.

### Phase 4 — Source-correct duration and expiry scheduler

A condition has no universal duration merely because it has a name. Only an application whose source
rule says it expires receives a timer. Persist the actual evaluated duration (including the Greater
Dirty Trick d4 face), time unit and start/expiry boundary—not a formula string and not only prose.

Round-duration effects must expire at the PF1e rule boundary anchored to application (initiative
count/turn boundary), not unconditionally at the affected creature’s turn end. Minutes/hours/days use
the replicated world clock with one expiry authority; a duration must not be both decremented by a
turn tick and independently expired by a clock sweep. If the present combat model cannot represent the
required initiative boundary, decide and document that limitation before adding the timer; do not
silently substitute a target-turn-end house rule.

Dirty Trick records both its duration and early-removal rule: target spends a move action normally or
a standard action with Greater Dirty Trick. The host validates and commits that action, removing only
the corresponding application. Prone does not auto-expire; grapple applications end on their own
validated release/escape/replacement events; Fatigued/Exhausted and health-state conditions use their
own rest/health rules, not a generic round TTL.

Expiry is an idempotent host event that removes one application ID, emits an expiry reason/card or
log, and leaves unrelated applications intact. It is later than the originating action: after expiry
or replacement, the original Revert refuses as stale with a reason such as `condition expired at
round/clock boundary ...`; no time travel. Keep tactical condition state separate from the strategic
pool/hero overlay.

**Acceptance/tests:** application after/before the target’s initiative has the correct full duration;
Dirty Trick expires at the correct anchored boundary and can be removed early with the correct action
cost; Prone survives turn/round advancement until stood up; two same-name applications expire
independently; turn and world-clock entry points cannot double-tick; stale Revert identifies expiry;
replay/re-entry expires once.

### Phase 5 — Host-verifiable spell effect continuation

Use `ACTION_SYSTEM.md` as the authority boundary: one verified target/check resolution commits the
per-target action transition and its exact condition/effect Ops atomically. The host resolves target,
area, source actor/item, save, SR, immunity/resistance and outcome from current state and host-owned
roll evidence; it never trusts a client-supplied success, DC or condition list. `ActionCard.conditions`
remains report-only. A condition application stores the spell/action source and the spell-defined
duration/expiry rule.

Start with a small cited spell set, including a multi-target/area case and a save-negates versus
save-partial distinction. Deferred player saves, touch/concentration, charges and expiry must enter
the same per-target executor exactly once. Do not upgrade a descriptive compendium entry to automated
until a pure rules fixture and host/browser acceptance exist. Do not promise generic PF1e spell
continuations from one Entangle example.

### Phase 6 — Core PF1e poison application, saves, stacking and Revert

This phase is required for the poison behavior requested by the user. Its default is the **Core
Rulebook affliction/poison system**, not a generic condition TTL and not the optional Unchained
progression track. Start with an exact transcription/fixtures from CRB pp.555–557 and the selected
poison entries before implementing a producer. The schema must represent each fact below; no
“assume Fort/one save/one dose” shortcut.

**6a. Immutable poison definition (source data).** A versioned profile contains:

- poison identity and rules citation;
- delivery route (`injury`, `contact`, `ingested`, `inhaled`; any special exposure trigger/volume);
- initial exposure save ability and DC source (fixed stat-block DC or a host-derived formula such as
  a creature poison DC), with the unadjusted `baseDC` kept separately;
- onset (including none) and the first-effect/first-periodic-save boundary;
- frequency interval and finite number of intervals or an explicit unbounded/once-only schedule;
- effect on each failed ongoing save (HP/ability damage, condition application, and whether effects
  accumulate, replace, or are initial/secondary as the poison entry specifies);
- cure policy: `successesRequired: N` **and** `consecutive: true|false`, plus any source-verified
  magic/other cure. Preserve the entry’s wording: `Cure 2 saves` and `Cure 2 consecutive saves` are
  distinct profiles; do not infer the flag from the number alone;
- Core poison dose-stacking policy and supported target-side immunity/prevention/pausing interactions.
  The host checks immunity; *delay poison* pauses active courses and queues new exposure saves in
  order; *neutralize poison* is a validated cure. If any interaction is deferred, expose that support
  boundary instead of silently applying the baseline poison flow;
- An Unchained track is a separate opt-in rules variant and is not inferred from a CRB poison
  definition.

**6b. Authoritative course, dose batches and exposure DC.** Store poison as a target-owned, id-keyed
affliction course, not `conditions: ["Poisoned"]`. Keep an exact poison-definition identity (source,
version and mechanics—not just a display name), target, active dose count, onset/frequency/end
boundaries, cure progress, last resolved attempt ID, source-owned active effect IDs, and state (`onset`,
`active`, `cured`, `expired`). Preserve each dose-event record and its source/action, source actor/item/
ability, delivery route, timestamp, dose count, initial-save DC/result and receipt ID so several
attackers or items can contribute doses without losing provenance. Similar entries with different save DC
or frequency are separate afflictions even if their names match (Paizo FAQ §7). Distinct poison
identities never share doses, DCs, schedules or cure counters. Active dose count excludes successful
initial saves and doses whose course was cured or ran its frequency to completion.

The dose/DC calculation must distinguish the **ongoing save** from the **save to resist a new
exposure**. If `n` doses are currently active, an ongoing save uses `baseDC + 2 × (n − 1)` (one dose
is the base DC). A new exposure bringing `m` doses of the same poison is resisted at the DC for the
candidate combined stack, `baseDC + 2 × max(0, n + m − 1)`. Injury/contact exposure contributes at
most one dose per qualifying exposure; simultaneous ingested/inhaled exposure can deliver multiple
doses and uses the single higher-DC initial save required by the Paizo FAQ. If that save succeeds,
none of the candidate doses are added, there is no dose-duration extension or effect from that
exposure, and any pre-existing course/cure progress remains unchanged. If it fails, add all `m`
doses; the ongoing DC is then `baseDC + 2 × (n + m − 1)`. This captures the FAQ’s rule that the new
exposure save is increased by currently active doses, while the failed new dose increases subsequent
saves too. Do not roll one independent save per dose in a simultaneous inhaled/ingested batch.

On a failed initial save, each additional dose extends the original total frequency duration by half
that original duration; this applies only when the initial save against the new dose/batch fails. For
an unpoisoned target exposed to `m` simultaneous doses, the first dose establishes the base course and
`m − 1` doses add extensions; if a course already has `n > 0` doses, all `m` failed new doses extend
its end. Extend from the current course end, do not restart or shorten elapsed duration. Keep the
original base duration so repeated exposures do not compound from an already-extended value. The CRB
three-dose Medium spider venom example remains a required fixture: base DC 14/frequency 1 round for
4 rounds becomes DC 18 for 8 rounds, and one successful cure ends all three doses. Preserve a
fractional half-duration if the scheduler can represent it; otherwise **round down the per-dose
extension** in the poison’s frequency unit (`floor(baseDuration / 2)` for each additional dose). For
example, a 5-round base adds 2 rounds per additional dose. A later failed dose joins the exact poison
course and changes DC/end time, but does not silently restart its already-running onset or frequency
schedule; preserve each exposure timestamp so any source-specific onset exception is explicit and
tested.

Exposure saves never count as successful cure saves. A successful later exposure save explicitly
leaves the existing course and cure progress unchanged. **Any failed save against the same poison
identity resets an existing consecutive-cure streak**, including a failed initial save against a newly
added dose; it does not erase successes for a nonconsecutive cure. A different poison identity does
not affect this course’s cure progress.

**6c. Initial effects, onset and scheduled saves.** Implement the PF1e event order, not a generic
“failed save → add Poisoned label” shortcut:

1. **Exposure/initial save.** The host validates the delivery and dose batch, computes the initial DC
   above, and resolves one source-authorized initial save. Success resists only that exposure and
   creates no dose. Failure contracts/adds the dose batch. With **no onset and a frequency**, the
   target suffers the poison’s effect for that failed exposure save immediately (once for a
   simultaneous multi-dose save), then enters the periodic schedule. With an **onset and a frequency**,
   a failed initial save causes no effect yet; a new course enters onset and begins additional saves
   only after it elapses. Adding a dose to an already-running same-poison course does not restart its
   onset/frequency schedule. If the profile has **no frequency**, apply its one-time effect exactly
   once immediately on contraction, or after onset if present, then end it as specified by the Core
   affliction rules; do not apply the initial-failure effect a second time.
2. **Ongoing/frequency save.** At every source-defined frequency, resolve one save for the active
   poison course—not one per stacked dose. For `1/round`, make it at the affected creature’s turn
   (at any point during that turn); if the creature delays, resolve it immediately rather than
   delaying the poison save (Paizo FAQ §3). Other frequency units and onset use the profile’s
   replicated world/combat clock boundary. Host re-reads the target’s current save bonus, exact active
   dose count and poison definition; computes the DC; validates the roller/commit-reveal result; and
   re-reads state after async work. A stable `(poisonInstanceId, attemptIndex)` makes resolution
   idempotent. A successful periodic save applies no poison effect and advances cure progress. A failed
   periodic save applies exactly the profile-defined effect once (including initial/secondary effects,
   accumulation/replacement rules); it resets cure progress only as specified by the cure policy.
3. **Cure/end.** `successesRequired: N` plus `consecutive: true|false` represents one success, multiple
   consecutive successes and multiple nonconsecutive successes without conflating them. For a
   consecutive cure, a failed cure save resets the streak; for a nonconsecutive cure, it does not erase
   earned successes. Cure success ends all active doses of that exact poison course and stops every
   future save. A source-verified magic cure such as *neutralize poison* uses its own host-validated
   operation and is atomic with course/effect removal. A finite frequency also ends the course when
   its stated duration runs out. Do not heal HP/ability damage already caused: CRB affliction rules
   leave that damage to be healed normally after cure. Remove only source-owned ongoing condition/effect
   instances that the poison entry says end with it.

Keep the cure counter semantics explicit for exposure versus periodic attempts. In particular, the
Paizo FAQ says a successful save against a new dose does not count toward curing the poison already in
the target; it is not a scheduled cure save. Do not let a generic “save succeeded” handler advance it.
The affliction definition must state whether special initial/secondary effects change on later failures.
For timed onset/frequency, preserve due times and finite remaining occurrences so a dose addition,
delay action, clock sweep or replay cannot double-tick or reset the wrong boundary. While *delay
poison* is active, pause existing courses without banking missed periodic saves; record new exposure
events in order without resolving their initial saves. When it ends, resolve those initial saves in
order, recalculating the active dose stack after each result, then resume the source-defined frequency
schedule. This is a typed poison interaction, not a generic timestamp shift.

A pending save may use the existing player-pending-roll UI, but it needs a poison-specific host
adapter: action/target/attempt identity, save ability, current dose-adjusted DC, and outcome are
host-derived; the client cannot author the cure counter, dose count or effect Ops. Each resolved
attempt, immediate damage/condition Ops and poison-course update commit in one host envelope with one
visible action/roll card. Exposure, periodic save, magic cure and source-owned condition removal are
separate typed intents, not generic client-supplied document Ops.

**6d. Revert semantics (R5).** Each failed exposure/dose-addition (including its immediate effect,
if any) is an audited event; each periodic save/effect is a later audited event; cure/neutralize is
another event. Revert of an exposure restores only that exposure’s immediate dose/course change and
its immediate effect Ops, and is allowed only while its post-image is still current. A later save,
dose, cure or expiry makes it stale and must be named—not silently rewound. Reverting a periodic-save
card restores that one attempt’s state and its exact immediate effects, subject to the same stale gate.
Reverting a cure can restore the active course only if no later event depends on it; it never heals
damage from earlier saves. This is event undo, not retroactive reversal of an entire timeline.

**6e. Acceptance and fixtures.** `tests/packages/pf1eAffliction.test.ts` plus host integration and
`e2e/pf1e_poison.spec.ts` must cover:

- exposure-save success (no new dose/effect/extension) and failure; no-onset immediate effect; onset
  suppressing effects until its first post-onset failed save; one-shot/no-frequency affliction;
- `Greenblood oil` (DC 13, 1/round for 4 rounds, 1 Con damage, Cure 1 save) from the Paizo FAQ;
  `Giant Octopus` poison (DC 19, 1/round for 6 rounds, 1d3 Strength damage, Cure 2 saves) from
  [Archives of Nethys](https://aonprd.com/MonsterDisplay.aspx?ItemName=Giant%20Octopus), with the
  unqualified two-save cure represented as nonconsecutive; `Wyvern` poison (DC 17, 1/round for 6
  rounds, 1d4 Con damage, Cure 2 consecutive saves) from
  [Archives of Nethys](https://aonprd.com/MonsterDisplay.aspx?ItemName=Wyvern);
- one-success cure; two consecutive successes with a failure resetting the count; a Giant Octopus
  success/failure/success sequence curing after the second success; successful exposure save neither
  advances nor erases cure progress; failed same-poison re-exposure resetting an existing consecutive
  streak; another poison identity leaving that streak untouched;
- ongoing saves at exact onset/frequency boundaries, including a delayed turn; finite frequency ends
  uncured; duplicate/replayed attempt applies no second save/effect/cure;
- repeated injury/contact exposures: DC for the new initial save rises by +2 per active dose; success
  does not extend/add a dose; failure adds the dose, applies the effect once, raises subsequent DC by
  +2, resets a consecutive cure streak and extends by half the original duration; three active spider
  doses yield DC 18/eight rounds; an odd-duration fixture confirms per-dose round-down;
- simultaneous multi-dose ingestion/inhalation: one initial save at the higher candidate-stack DC;
  failure adds all doses and one effect for that failed save; success resists all; cure ends every dose;
- different definitions with the same display name but different DC/frequency remain separate; distinct
  poison IDs never share DC/cure/duration state; poison entries with initial/secondary effects advance
  the right effect; source-owned temporary conditions end only when the definition says so;
- HP/ability damage remains after cure; poison immunity blocks exposure/effects; *delay poison* pauses
  an active cadence without backfilled saves and resolves queued exposures in order exactly once;
  supported *neutralize poison* path is atomic;
  bad/forged DC, dose count, cure progress, outcome and duplicate attempt ID are rejected;
- Revert exposure before a later tick; refusal after a subsequent tick; Revert one tick without
  changing another poison; rollback/replay and combat/world-clock race cases.

### Phase 7 — Atomic forced movement and tactical trample

Bull rush/drag/reposition become validated world-position Ops (existing host movement, walls/zones,
speed and permission policy) plus card and any condition Ops in one receipt. The successful initial
grapple’s required pull-to-adjacent movement is handled in Phase 2, not left as a separate drag.

For trample, first decide which PF1e source is intended (monster special ability versus a feat/mounted
action); they are not interchangeable. Transcribe movement, eligible targets/size, target choice,
attack/save, damage and path interaction from that source before coding. Do not encode “Reflex half”
from memory as the entire trample rule. If the source/rules scope is not funded, explicitly re-defer
it and correct the import advisory. Strategic mass-battle trample/checkpoint undo remains untouched.

**Acceptance/tests:** Revert restores exactly prior positions and condition instances; host rejects
movement through invalid terrain/space; action/card/state are atomic; tests cover the chosen sourced
trample rule or verify the explicit re-deferral.

### Phase 8 — Surfaces, agents and documentation

GM Revert remains GM-only and reachable from the World actions panel and the relevant ActionCard.
Players see only condition/effect name, source information permitted by projection, duration/removal
rule and the normal save result—not Revert controls, raw ledger Ops, private pre-images or hidden
conditions. Read tools expose active condition/poison instance, source and due/expiry information
without leaking evidence/seeds. `PF1e_Unified_TODO.md`, `ACTION_SYSTEM.md`, the spell/poison pack
status, coverage dashboard, `DECISIONS.md`, source deferral notes and `DEVIATIONS.md` are updated with
evidence; any explicit house-rule/Unchained behavior is named rather than silently substituted.

**Acceptance:** a GM can find/revert supported actions; a player-visible card has no raw inverses;
source/duration/save state is readable; the coverage dashboard passes; docs distinguish implemented,
source-verified, deferred and descriptive behavior.

### Sequencing summary

| Phase | Purpose | Depends on | Touches |
| --- | --- | --- | --- |
| 0 | Characterization + R1–R7 decisions | — | tests/docs only; characterization portion landed |
| 1 | Condition instance schema + mechanics/legacy resolver | 0, R4 | `actor.ts`, conditions/effects, documents, validation, readers |
| 2 | Existing producers in one host-audited transaction | 1, R1–R3 | maneuvers, Dying/first aid, HostSync, receipts, E2E |
| 3 | F01 card UX through private receipt | 2, R1–R3 | roll ledger, projection, ActionCard, host revert |
| 4 | Source-correct expiry and early removal | 1, R3–R4 | combat boundaries, world clock, condition applications |
| 5 | Host-verified spell continuation | 1, 2, 4 | cast flow, pending rolls, pure spell effect data |
| 6 | Core poison exposure/save/dose/cure/revert | 1, 2, 4, R5, R7 | affliction store, poison data, scheduler, host save path |
| 7 | Forced movement + sourced tactical trample | 1–2, transcription | movement host path, trample, statblock advisories |
| 8 | UX/read tools/docs/coverage | relevant prior phase | UI, agents, docs |

Interlocks: Phase 1 precedes every new condition writer. Phase 2 precedes any claim that a producer
is named-Revertable. Phase 3 can ship card-level Revert UX only after raw ledger data is private and
receipt/card staleness is solved. Phase 4 uses the Phase 1 application IDs; it does not expire
conditions that have no source-defined timer. Phase 6 depends on the condition, host-receipt and
scheduler foundations (Phases 1, 2 and 4), not the generic card ledger (Phase 3) or spell catalog
(Phase 5); poison card-level Revert waits for Phase 3. Dedicated host-verified poison adapters for
*delay poison* and *neutralize poison* are part of Phase 6; broader spell automation remains Phase 5.
Phase 7 movement is separate from the condition rules work.

---

## 5. Explicit non-goals

- **No third revert mechanism.** Use the existing host receipt as the only inverse source. The card is
  a safe presentation/UX alias; it never stores a second inverse or has separate authority.
- **No undocumented PF1e variants.** The default is Core Rulebook PF1e. Unchained poison progression
  tracks or house-rule mechanics require an explicit world/ruleset choice and their own fixtures.
- **No claim of a complete condition catalog.** Implement the named subset with tests; refuse or
  visibly mark unsupported mechanical conditions instead of creating cosmetic conditions that appear
  rules-supported.
- **No generic duration for all conditions.** A source application gets only its source-defined
  duration/removal condition. In particular Prone is not “until next turn.”
- **No player-facing Revert.** The host’s GM-only gate remains a security property. A player may roll a
  delegated save/reroll only through an explicitly authorized host flow.
- **No FX writes.** FX render/anchor only; never mutate HP, conditions, poison state or permissions.
- **No schema change by accident.** The keyed application/affliction collections and legacy reader
  path are explicit persisted-contract work with validation, export/import and compatibility tests.
- **No lifetime poison exposure counter.** Dose adjustment applies only to active doses of the same
  poison course; successful initial saves, unrelated poisons, and cured/expired courses do not inflate
  future DCs.
- **No retroactive healing when poison ends.** Curing a poison ends its future effects; previously
  committed HP/ability damage is healed normally unless another explicit healing action does so.
- **No rollback of the strategic mass-battle pool.** Strategic checkpoint undo and the hero bridge
  retain their existing contracts.
- **No item/economy/import undo** beyond the exact operation required by a supported poison/maneuver
  producer.

---

## 6. Decisions needed before the branching phases

R1–R4 gate Phases 1–4; R5 and R7 gate poison; R6 scopes later breadth. Record each decision before the
implementation slice that depends on it.

**Decision record (D-406, 2026-10-05):** R1 = (a) private `actionReceipts` as the single inverse
source, with the card (when it exists) delegating; R2 = (b) per-path for keyed applications, legacy
arrays whole-document; R3 = (c) refuse and report the later event; R4 = (c) separate keyed
`conditionApplications` with legacy normalization, persisted under `system.pf1e` and validated on
every host write (the persisted-schema decision this item required); R5 = (a) per-exposure events;
R6 = keep the phase order, poison before trample; R7 unchanged (resolved). Each decision is embodied
by tests in the same files named in §4's status table; DECISIONS.md D-406 records the whole package.

**R1 — Which store is authoritative for Revert?**
(a) Audited `actionReceipts` only; (b) F01 ledger only; (c) both as independent copies. **Recommend a
private receipt as the single inverse source**; card controls hold an opaque receipt ID and delegate to
the same host handler. This best matches durable GM Revert and avoids a second authority. If F01
requires a two-round card window, the host enforces that window before delegating; after it, the World
actions panel remains available. Never serialize inverse Ops/pre-images on a public message.

The decision must also define the action card’s lifecycle. Recommend an append-only public report
marked `reverted`, with presentation metadata outside the receipt’s mechanical post-image hash. If
keeping a message ref in the receipt, specify a narrow host-owned mutable-field rebase/allowlist so
ledger updates/pruning do not invalidate the receipt but arbitrary edits still do. Prove the 2-round
prune/fallback case in HostSync tests before claiming it works.

**R2 — Staleness granularity.**
(a) Whole document for every receipt; (b) per-path/instance for condition operations; (c) impact-aware
merge. Recommend fail-closed per-application-ID path for new keyed condition records and whole-document
for legacy arrays. An unrelated HP edit should not block a ledger alias for a different application
ID, but editing/removing/replacing that same instance must make Revert stale. Never overwrite a newer
condition or poison course.

**R3 — Expired/replaced state.**
(a) Restore it anyway; (b) refuse silently as generic stale; (c) refuse and report the later host event.
Recommend (c): no time travel, with the condition instance/poison attempt and expiry/replacement reason
named. Preserve ordinary fail-closed post-image checks.

**R4 — Condition persistence and mechanics.**
(a) Continue writing names only; (b) change `conditions` to a union of strings/objects; (c) add a
separate keyed `conditionApplications` record and normalize legacy names into the resolver. Recommend
(c): new state is source-aware and path-addressable; old string arrays remain readable, no writer emits
new strings after migration, and the resolver applies mechanics exactly once. This requires an
explicit persisted-schema/version/compatibility decision, not an implicit type widening.

**R5 — Meaning of “Revert poison.”**
(a) Revert one exposure/dose event and its immediate Ops; (b) unwind every later periodic save/damage
as a poison-wide time machine. Recommend (a): each exposure, scheduled save and cure is its own
idempotent audited event. A later save/dose makes the earlier receipt stale. Reverting a cure can
restore the course only if no later event depends on it; prior damage is never silently healed.

**R6 — Breadth sequencing and trample source.**
Keep Phases 0–4 as the immediate condition/revert foundation. Poison is then an independent sourced
rules slice, not blocked on automating all 75 spell entries. Trample needs a decision on monster
special ability versus mounted/feat rules before it is scheduled; the tactical and strategic versions
remain distinct.

**R7 — Poison rules contract, timing and variant (resolved).**
Use PF1e Core affliction/poison rules plus the Paizo poison FAQ; do not silently use or mix in
Unchained progression tracks. `Cure` encodes a positive `successesRequired` plus a `consecutive`
flag; preserve whether the exact source says `N saves` or `N consecutive saves` (Greenblood Oil,
Giant Octopus and Wyvern pin one-save, unqualified two-save and explicitly consecutive two-save
handling). Exposure saves are separate from frequency/cure saves: a successful exposure adds no dose,
effect, duration or cure success. The Core FAQ’s active-dose DC, failed-exposure extension,
simultaneous ingested/inhaled save, no-onset effect timing and turn-delay rule are encoded above.
Cure requirements do not change with dose count; one completed cure ends all same-poison doses.

**Confirmed rulings:** any failed save against the same poison identity—including a failed initial
save to resist a new dose—resets a consecutive-cure streak; it does not erase nonconsecutive cure
successes, and a different poison identity does not affect the streak. When half of the original
frequency duration is fractional and the scheduler cannot represent the fraction, round down each
additional-dose extension separately (`floor(baseDuration / 2)`). Disease is a separate future rules
profile, not an alias for poison.

---

## Appendix A — Environment and verification gates

The sandbox notes below are the working recipe (D-222 is the canonical entry); `node_modules/` and `dist/`
are snapshot-excluded, so a fresh session reinstalls/rebuilds first.

```bash
corepack enable pnpm                      # there is no pnpm shim
corepack pnpm install --prefer-offline     # ~4 s
```

Per-slice gates, in the repo's order of strictness:

```bash
corepack pnpm exec vitest run <touched test files>            # focused, while iterating
corepack pnpm exec vitest run tests/host/sync.test.ts -t "<revert case name>"
corepack pnpm exec vitest run tests/packages/pf1eAffliction.test.ts
corepack pnpm test                                            # full suite (baseline 335 files / 4,960 tests)
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm build && corepack pnpm size                     # single-file ≤ 6 MB raw budget
node scripts/coverage.mjs --check                             # after checklist items change
```

Browser acceptance is Playwright over `file://dist/index.html` (chromium); the CDN is unreachable in this
sandbox, so the `@sparticuz/chromium` recipe is the way in (extract libs to `/tmp/al2023/lib/lib`, set
`LD_LIBRARY_PATH`, then `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/chromium PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1
corepack pnpm exec playwright test e2e/<spec> --project=chromium`). Firefox/WebKit stay deferred per
D-119/D-153.

Each phase's evidence line follows the repo convention: test count delta, the full-suite number,
typecheck/lint/build/size values, and the executed e2e names — no claim without the command that shows it.

## Appendix B — Seams an implementer will touch

| Seam                             | File                                                                                                                                                         | Why it matters here                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| submit path for maneuver actions | `src/ui/combat/pf1eManeuverFlow.ts:399` (`post`)                                                                                                             | the two-envelope split that G-A1 is about                             |
| plan shapes                      | `src/ui/combat/pf1eManeuver.ts` `conditionOps:47`, `conditionSetOps:61`, planners `:94–395`                                                                  | carries the ops; must stay pure                                       |
| condition library                | `src/packages/pf1e/conditions.ts` (`pf1eConditionPayload:511`, `pf1eConditionRequest:521`, refusal)                                                          | definitions/payloads; add Deafened and explicit supported-subset tests |
| condition applications           | proposed `actor.system.pf1e.conditionApplications[id]` + `src/packages/pf1e/actor.ts` derivation                                                         | canonical source-aware state; legacy `conditions: string[]` reader     |
| poison profile/course            | proposed `src/packages/pf1e/afflictions.ts` + host save handler                                                                                           | exposure, dose/DC, cadence, cure and attempt identity                  |
| effect ops                       | `src/packages/pf1e/effectOps.ts:124,290`                                                                                                                     | actor vs combatant homes, `MAX_EFFECTS`                               |
| effect payloads                  | `src/packages/pf1e/effects.ts:128,412`                                                                                                                       | source kinds incl. `poison`                                           |
| pure maneuver rules              | `src/packages/pf1e/maneuvers.ts:578` (`pf1eDirtyTrick`)                                                                                                      | duration/removal text that G-A5 drops                                 |
| combat tick                      | `src/core/combat.ts:291` (`tickEffects`)                                                                                                                     | Phase 4 scheduler hook                                                |
| world clock                      | `src/packages/pf1e/worldClock.ts:204` (`pf1eClockSweepOps`)                                                                                                  | Phase 4 scheduler hook                                                |
| ledger                           | `src/packages/pf1e/rollLedger.ts` (`buildRollLedger:80`, `captureLedgerInverses:150`, `ledgerStaleReason:178`, `planDamageDeltaReroll:237`, `revertOps:302`) | F01's contract                                                        |
| receipts                         | `src/core/actionRevert.ts:38,103`; `src/host/sync.ts:2808,3258`                                                                                              | the durable mechanism                                                 |
| roll ledger builder in the UI    | `src/ui/sheets/pf1eResolveFlow.ts`                                                                                                                           | the only ledger producer today                                        |
| cast flow                        | `src/ui/sheets/pf1eCastFlow.ts:547–736` (`runSpellEffect`), `:1531–1539` (pending row)                                                                       | Phase 5's target                                                      |
| module API                       | `src/core/moduleApi.ts`                                                                                                                                      | no condition method; keep it that way (modules propose, hosts commit) |
| sheet edit allowlist             | `src/ui/sheets/pf1eSheetModel.ts:222` (`pf1eSheetEdit`)                                                                                                      | numeric-only; not a condition seam                                    |
| action card                      | `src/core/action.ts:120` (`conditions` report), `src/ui/chat/ActionCard.svelte`                                                                              | report-only per D-405                                                 |
