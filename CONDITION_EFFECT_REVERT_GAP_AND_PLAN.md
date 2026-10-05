# Condition & effect Revert — capability gap, dependency map and implementation plan

**Status:** analysis + plan, written 2026-10-05 against `main` `167c4e6` (D-405 / PR #37). Nothing
in §4 is implemented. No `DECISIONS.md` entry is written until a slice lands (operating rule 1 and
this repo's "no fake claims" convention); the decision points that need a ruling first are listed in
§6. The one landed artifact is Phase 0's characterization test,
`tests/host/effectRevertScope.test.ts` — 4 tests that pin today's behaviour so every later slice has
a red→green target.

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
and is proven to work (§1.3); the producers simply never hand it a condition.

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
| **G-A8** | **Afflictions (poison, disease) have no model at all.** "poison" exists only as an effect _source type_ and in mitigation prose; `trample` has no tactical implementation (deferred to P6 in the stat-block adapter) while the strategic profile resolves it in the pool.                                                                                     | `effects.ts:128,412`; `mitigation.ts:24,26,360,622`; `statBlock.ts:25–26`; `schema.ts:139–141,237–239,381–383`; `combatEngine.ts:671–700`                | new producers will need the same "apply → expire → revert" contract; building them first would repeat G-A1 three more times                                                                                           |

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

**Consequence for the plan:** the only home that supports fine-grained, revert-friendly removal today
is the **id-keyed record** — which is exactly the shape the combatant home already uses. Any slice
that wants surgical condition reverts should either (a) accept whole-array granularity and lean on the
ledger's _per-path_ gate, or (b) move/duplicate condition state into an id-keyed record. Option (b) is
a core-document contract change (`actor.effects` is listed in D-012's embedded collections) and must
be decided, not smuggled in.

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
combat)`), the GM Revert is host-gated to `role === "GM"`, receipts are private (never projected),
and the module/script tiers cannot reach effects at all. **Nothing in this plan needs a new
authority path** — it needs producers to route existing authorized ops through existing audited
envelopes. That also keeps D-405's boundary intact: the action card reports, the receipt/ledger
reverts, and FX still cannot write.

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

| Family                                                                 | Exists today                                                                                                                                        | Missing for "applied → expired → revertible"                                                                                                                       | Plan phase        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **Bull rush / drag / reposition**                                      | full CMB/CMD check + aftermath notes (`maneuvers.ts`, D-199/D-208)                                                                                  | the forced move is not a world write: planner returns `ops: []` and the push is a separate drag, so there is no atomic action and no receipt                       | 7                 |
| **Trip / overrun**                                                     | prone write on the margin rule                                                                                                                      | envelope only (ledger or audit)                                                                                                                                    | 1                 |
| **Dirty trick**                                                        | six named conditions; duration (`1 + ⌊margin/5⌋`, Greater `1d4 + ⌊…⌋`) computed and dropped; removal rule is a note                                 | envelope, then duration persistence + expiry                                                                                                                       | 1, then 3–4       |
| **Grapple family** (initial/maintain/pin/tie-up/escape/release/damage) | replacement semantics (`Pinned` replaces `Grappled`) written as whole-array diffs; damage is note-only                                              | envelope for every branch; a decision on whether damage belongs to the same card                                                                                   | 1 (+2 for reroll) |
| **Disarm / steal / sunder**                                            | check + notes; item writes are the sheet's own editor                                                                                               | item-write integration (out of scope for this plan; named so it is not mistaken for done)                                                                          | —                 |
| **Trample**                                                            | strategic: profile fields + pool resolution (`schema.ts`, `combatEngine.ts:671–700`); tactical: none, explicitly deferred in the stat-block adapter | tactical resolution (Reflex half, damage, move-through) **and** the envelope; strategic side keeps checkpoint undo, unaffected                                     | 7                 |
| **Poison / disease**                                                   | source-type enum + mitigation prose only (`effects.ts:128,412`)                                                                                     | a payload (onset, frequency, save DC, cure), an infliction producer (attack rider, trap, automation), a scheduler (turn tick and/or clock sweep), and the envelope | 6                 |
| **Spells**                                                             | damage/SR/save/HP pipeline; 71/75 entries descriptive; the deferred effect row is explicitly pending (`ACTION_SYSTEM.md:141`)                       | a host-verifiable continuation that can commit buff/debuff **effects** and conditions in the same intent as the card, with inverse capture                         | 5                 |
| **Concentration / pending casts**                                      | pending-save/concentration flow writes a linked action row and HP                                                                                   | the resolution envelope must carry the continuation's effect ops too (otherwise the gap reappears one level deeper)                                                | 5                 |

---

## 4. Implementation plan

Phases are ordered by _dependency_, not by size. **Phases 1–2 close the gap the question is actually
about** (a named revert for conditions that exist today). Phases 3–4 make conditions that carry
durations behave like state with a lifecycle, so the revert decision has something sane to interact
with. Phases 5–7 extend the frozen contract to the producer families the question names — spells,
afflictions, movement maneuvers and trample. Phase 8 is surfaces and documentation. Phase 5 is the
largest single slice; phases 6 and 7 each start with a _transcription_ task, because neither poison
nor tactical trample has verified rule text in this repo yet.

Conventions every phase follows:

- The mechanism is reused, never duplicated: an action gets a receipt (`commitOps` with an audit) or a
  ledger (`system.rollLedger`) — never a third revert path.
- Producers keep their pure planners; the flow only decides _which envelope_ carries the ops.
- Every refusal is named (the repo's convention, e.g. "ledger stale — effects changed since"), and
  every phase ends with the standard gates in Appendix A.
- Docs land with the slice, not after it: the item line in `PF1e_Unified_TODO.md`, a `DECISIONS.md`
  entry per slice, and `ACTION_SYSTEM.md` where the authority story changes.

### Phase 0 — Characterization and contract freeze _(partly landed)_

**Landed:** `tests/host/effectRevertScope.test.ts` (4 tests) pins the four behaviours in §1.3 — ordinary
intent + Undo; audited envelope + named Revert; the library path both ways; whole-document staleness
refusing an unrelated HP edit.

**Remaining:** record the rulings in §6 (R1–R5) as `DECISIONS.md` entries, because phases 1–7 branch on
them. Two of them (R1, R4) are load-bearing: getting them wrong means re-doing Phases 1–3.

**Acceptance.** Test file green in `pnpm test`; the decisions exist with alternatives and consequences;
no production code touched. **No e2e** (nothing user-visible changes).

### Phase 1 — Give the existing condition producers a revert envelope

_Closes G-A1 and G-A2's first half. This is the direct answer to "can a GM revert entangled/grappled/sickened"._

**1a. Maneuvers.** `pf1eManeuverFlow.ts` `post()` (`:399`) currently posts the card and the condition ops
as two separate envelopes. Submit them as **one** transaction (audited envelope or ledger card per R1),
built from the same `plan.ops` array, with the card's `system.action` recording the maneuver outcome.
Every branch keeps its existing ops: trip/overrun prone, dirty trick's condition set, the whole grapple
family (initial, maintain, pin, tie-up, escape/break/reverse, release).

_Invariants to pin:_ one seq, one transaction — a refused commit posts **no** card and writes **no**
condition (no orphan card, no half-applied maneuver); the ops in the card/receipt are byte-equal to
the ops submitted; `plan.ops` stays the single source.

**1b. Dying tick and first aid.** `pf1eDyingTick.ts:61` and `pf1eFirstAid.ts:52` write home A `Stable`
(two sites in `CombatPanel.svelte:529,690`). Same envelope treatment — these are small, batch them with 1a.

**1c. Effects tab.** `PF1eActorSheet.svelte:2082` (combatant home) and `:2092` (actor home) apply/edit/remove
through `effectOps.ts` with plain `client.submit`. The combatant home is already id-keyed, so its removal is a
legal `-=flags.core.effects.<id>` diff; the actor home is a wholesale array diff (G-A3).

**Acceptance criteria.**

| #   | Given / When / Then                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | GM trips a target through the sheet → the World actions panel offers the maneuver with Revert; pressing it restores the exact previous `system.pf1e.conditions` array                       |
| 1.2 | the same for a dirty trick (Entangled/Blinded/Shaken per the margin), a grapple initial check (both combatants), and an escape (both lose Grappled/Pinned)                                  |
| 1.3 | a player-triggered maneuver is revertible by the GM and _not_ by the player (the panel is absent; the host refuses a forged intent with the existing GM-only refusal)                       |
| 1.4 | an unrelated later HP edit on the same actor → Revert refuses with the named staleness reason and leaves both state and receipt untouched (the §1.3 case-4 behaviour, now on a public path) |
| 1.5 | an AoO-damaged trip that fails writes **no** condition and posts no revertible condition entry                                                                                              |
| 1.6 | Undo still works on the same write (no regression of the global path)                                                                                                                       |

**Tests.** `tests/ui/pf1eManeuverFlow.test.ts` (envelope shape, one-transaction invariant, every branch
table); `tests/ui/pf1eDyingTick.test.ts` + `pf1eFirstAid.test.ts` (envelope); `tests/host/sync.test.ts`
under `durable GM Revert for world actions` — a new case "reverting a maneuver envelope restores the
condition list" plus the stale-refusal case; `e2e/action_revert.spec.ts` grows from 3 to 5 specs (trip →
chip disappears after Revert; player maneuver → GM-only panel).

**Risk.** Merging the two submits changes op ordering on the wire; the card create must be validated in
the same preflight as the condition ops (D-405's card contract and the chat-visibility preflight are the
two consumers to re-run).

### Phase 2 — F01 ledger coverage for condition ops

_Closes G-A2's second half: the roll card's own Revert/Reroll for condition-bearing actions (F01's
promised clause)._

**2a. Ledger-bearing condition cards.** The maneuvers built in Phase 1 also attach
`system.rollLedger` (`buildRollLedger` + `captureLedgerInverses` before submit), with `turnNumber` from
`tacticalLedgerTurn` and `ledgerOps` = the condition ops. Then the card advertises Revert within the
2-round window and Reroll where a recompute is possible.

**2b. Reroll semantics.** `planDamageDeltaReroll` refuses non-HP ledgers by name today (correctly). Options
for condition-bearing ledgers, per family: **(i)** keep the refusal (Revert only, manual re-roll);
**(ii)** revert-then-apply-manual; **(iii)** semantic recompute — the flow already _has_ a pure planner
that takes the die, so a reroll can re-run `planTrip`/`planDirtyTrick`/`planGrapple*` with the new face
and swap the ops. Recommend **(iii) only where a planner is die-parameterised** (trip, overrun, dirty
trick, grapple checks — all are), and (i) as the default elsewhere, with the refusal string naming the
family. This keeps the ledger honest: it never fabricates an effect, it re-derives one.

**Acceptance criteria.**

| #   | Given / When / Then                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | a trip card rerolled from hit to miss removes the prone condition and the ledger records both dies                                                              |
| 2.2 | a dirty trick card rerolled to a larger margin replaces the condition with the new margin's set (no union of old and new)                                       |
| 2.3 | a reroll outside the 2-round window refuses with the existing window string; a revert past the window still works from the receipt if R1 chose the receipt path |
| 2.4 | a ledger Reroll on a family with no recompute contract refuses **by name** and still offers Revert                                                              |
| 2.5 | pruning leaves the card's text/history intact after the window (`pruneOpsForWindow`)                                                                            |

**Tests.** `tests/packages/rollLedger.test.ts` — the "non-HP ledger is refused by name" case is
deliberately rewritten (it is the red test for 2b); add condition swap, margin replacement, window, and
prune cases. `tests/host/sync.test.ts` roll-revert path; `e2e/roll_ledger.spec.ts` condition card spec.

**Decision dependency:** R1 (does the maneuver get receipt, ledger, or both — the phase-1 card may need
both anyway) and R2 (per-path vs whole-document staleness for array homes).

### Phase 3 — Timed conditions in the names-only home

_Closes G-A5 (durations computed and dropped) and part of G-A4._

Today a dirty-trick condition never expires: `maneuvers.ts:578–620` computes `durationRounds`
(1 + ⌊margin/5⌋, Greater 1d4 + ⌊…⌋) and the removal rule, and the planner throws it away. Options:

- **A — keep names-only** and let the GM remove it by hand (`conditionSetOps`); cheapest, honest, but the
  tracker will lie about a 2-round Blind.
- **B — compact timed entries**: allow `system.pf1e.conditions` entries to be `string | { name; rounds?;
sourceId?; note? }`, with a read-normalizer so every existing consumer keeps working (`actor.ts:1509`,
  badges, automation filters, action-deny) and writers emit objects only for timed state. This is the same
  read-normalization discipline as `worldClock` (`:204`).
- **C — route maneuver conditions through home B** (payload effects with `ttl`), reserving names-only for
  untimed state. Reuses the expiry machinery wholesale, but the effects array is a wholesale diff, so
  unrelated effect edits make the ledger path stale more often, and grapple replacement semantics move
  into payload space.

Recommend **B**, with C as the long-term target only if R4 wants one home; the normalizer is a small pure
function that Phase 4 and the spells phase both reuse.

**Slices.** 3a — normalizer + writer for trip/overrun ("prone until your next turn") and dirty trick
(duration + removal rule); 3b — readers (derivation, denies, badges show `(2 rounds)`); 3c — the maneuver
card spells out the duration and the trigger that ends it; 3d — grapple's replacement semantics stay
atomic inside one array write (Pinned replaces Grappled, never both).

**Acceptance.** Applying a Greater dirty trick stores `rounds: 1d4+⌊margin/5⌋`; every existing
reader/report still sees the name; a names-only legacy array round-trips unchanged through every path
(no migration, no version bump — the P0 rule); the card states the exact expiry trigger.

**Tests.** `tests/packages/pf1eConditions.test.ts` (normalizer table, legacy passthrough),
`pf1eManeuverFlow` duration cases, `pf1eActor` derivation with mixed entries, sync round-trip.

### Phase 4 — Expiry scheduler (turn tick + world clock)

_Closes the other half of G-A4/G-A5; makes reverts and expiry interact deterministically._

**4a. Turn tick.** Extend the combatant effect tick (`core/combat.ts:291` `tickEffects`) or the flow that
calls it with the same call for timed **condition entries**: decrement at the owner's turn end, expire at
0, and report the expiry (badge + chat note). Precedent and shape: `duration: null` persists; sustain vs
lapse semantics already exist for effects (`combatState.ts`).

**4b. World clock.** `pf1eClockSweepOps` (`worldClock.ts:204`) already sweeps effect durations on time
advance — teach it the normalized timed entries so a condition with a minute/hour basis expires on the
same boundary.

**4c. Revert interaction (R3).** Decide and pin: reverting a card whose condition has **already expired**
(or been replaced by a later grapple) is refused as stale; the plan should surface _which_ later write
blocked it rather than only "changed after this run" — even if the refusal stays fail-closed.

**Acceptance.** Trip → advance to the end of the victim's turn → prone expires with a visible note; a
1-minute poisoned-by-proxy effect expires when the clock crosses the boundary; no expiry fires twice
(idempotent re-entry); a revert after expiry refuses with a reason that names expiry as the blocker;
strategic mirror unchanged (a tactical expiry never silently rewrites the pool).

**Tests.** `tests/packages/pf1eTurnBoundaries.test.ts` (tick ladder, expire-once, null-persists),
`pf1eWorldClock.test.ts` (minute/hour boundaries with timed entries), `tests/core/combat` equivalents;
e2e: apply → advance → chip disappears; revert-after-expiry refusal reason.

### Phase 5 — Spells: the host-verifiable effect continuation

_Closes G-A7. The largest slice; must not start before R1/R4 are recorded._

`ACTION_SYSTEM.md:141–143` is the contract this phase implements, and `:172` already lists it as a next
extension: a host-owned continuation that re-derives defenses/resistances on the host before applying
HP/effects. `pf1eCastFlow.ts`'s deferred-save row (`:1531–1539`) currently says exactly that no condition
is inferred — this phase gives that row an executor.

**5a. Contract.** A cast intent whose card carries the effect ops, host-verified end-to-end: target in
the resolved area, save outcome from the host roll record, SR/injury/regen interactions, condition
immunity (`conditionRefusalFor`), source kind `spell`, effect payload built by a **pure** planner
(`src/packages/pf1e/spellEffects.ts`, new) that maps a spell + outcome + margin to `EffectRequest`s — no
invented numbers, every entry citing its verified text as `pf1eConditionPayload` does.

**5b. Commit.** The effect ops join the same envelope as the damage/HP/slot writes (the cast flow already
commits HP through `pf1eSheetEdit`, `:709`), so the card is revertible and (where the planner is
die-parameterised) rerollable under Phases 1–2's rules. The action row's final state resolves from
`pending` to `resolved` in the same commit — no dangling pending row.

**5c. Deferred saves, touch, concentration, charges.** The pending/concentration/touch continuations
(`:1711/:2193/:2340/:2475/:2689`) resolve through the same executor when their roll lands; the timeline
ordering (roll → effect commit) is the host's, not the client's.

**5d. Pack upgrades.** Only after the executor exists: upgrade spell entries from `descriptive` to
`automated` in small, verified batches (Entangle, Grease, Haste/Bless-style buffs first — each already
has a `condition`/keyword trace in the pack), each with its SRD citation. 71 descriptive entries stay
descriptive until their batch lands; the `automationNote` is the honest backlog marker.

**Acceptance.** Entangle on a failed save applies a real payload effect in the same envelope as the card,
the target's AC/speed derivation changes, the card is revertible by the GM and the revert restores the
prior effects array; a successful save applies nothing; a mind-affecting debuff on an immune target is
refused by name; a deferred save resolved by the player's roll commits the effect exactly once; a
`descriptive` entry still shows the "no automation" note and writes nothing (D-405's honest-cards rule).

**Tests.** `tests/ui/pf1eCastFlow.test.ts` (op-carrying save, success/fail/immune, deferred resolution,
exactly-once); new `tests/packages/pf1eSpellEffects.test.ts` (fixture-cited mapping); host revert test over
a cast card; `e2e/pf1e_cast_flow.spec.ts` extension + a revert spec; size gate (this phase is the one most
likely to add UI, so the 6 MB budget is checked per PR).

### Phase 6 — Afflictions: poison (and disease, if scoped)

_Closes G-A8's poison half. **Starts with a transcription task**, because the repo has no verified poison
rule text: `PF1e_Unified_TODO.md` has zero `poison`/`disease` hits and the code has only the source-type
label. The honest plan is R02 discipline first: transcribe onset/frequency/save/cure from the canonical
text into a fixture, then encode._

**6a. Payload.** A new effect payload kind `affliction` (or a `flags.pf1e.affliction` block) carrying
onset, frequency (rounds), save DC/type, cure condition, and track effects; `effectOps`' source kind
`poison` (`effects.ts:128,412`) is already reserved for it.
**6b. Infliction.** An authored `poison` block on attack lines (rider on a hit — the attack flow already
owns the rider seam), a new automation step in the closed action set (the reference audited producer),
and a GM sheet control for traps. Each infliction is **one audited action**.
**6c. Cadence.** Frequency saves resolve on the owner's turn boundary through Phase 4's scheduler or the
clock sweep, applying the track's damage/conditions and logging a card; cure/neutralize removes the
payload and any conditions it owns.
**6d. Revert semantics (R5).** An affliction is a state machine: the honest scope is "revert the
infliction event and the ops it committed", not "unwind every later save". Later frequency-save damages
are later actions with their own receipts. The plan pins this in the docs so nobody promises time travel.

**Acceptance.** A poisoned target's first frequency save fires on schedule with a named card; the
infliction action is revertible within its receipt; the cure is revertible; no damage double-applies;
`source.kind: "poison"` is carried on every op; an onset-delayed poison applies nothing before its onset.

**Tests.** new `tests/packages/pf1eAffliction.test.ts` (fixture-cited onset/frequency/cure), flow tests,
host revert, `e2e/pf1e_poison.spec.ts`.

### Phase 7 — Movement maneuvers and tactical trample

_Closes G-A6 and the tactical half of G-A8's trample._

**7a. Atomic forced movement.** Bull rush / drag / reposition become real world writes: token position
ops (the same path the drag tool uses) + card + any condition ops in one envelope, so Revert restores
positions too. Requires a verified movement write path from the flow (today the flow returns notes and
"the caller's map concern" moves the token separately).
**7b. Tactical trample.** Only after 7a: consume the authored `trample*` fields (currently routed to P6
by `statBlock.ts:25–27`), model the move-through, the target's Reflex save for half, damage to each
target in the path, and commit damage + position + card in one audited action. Reconcile the stat-block
deferral text in the same PR (and note that the firearm entries at `:26–28` now understate P09's landed
work — an import-advisory string, not a rule).
**7c. Alternatively re-defer explicitly.** If trample is still out of scope, the phase's deliverable is
the honest re-deferral: update the deferral text and `PF1e_Unified_TODO.md`, so "not modelled" does not
read as "not present".

**Acceptance.** A bull rush card's push + prone is one revertible action (Revert restores both position
and condition); a trample either behaves the same way (save, damage, path) or is re-deferred with the
docs updated; a movement-during-revert race refuses deterministically (the M08 precedent).

**Tests.** pure trample planner cases; movement-race test; `e2e` bull-rush replay.

### Phase 8 — Surfaces, agents and documentation

**8a. Surfaces.** Wherever a GM looks for an action, Revert must be reachable: the World actions panel
(exists), the maneuver/cast/roll cards (a Revert affordance on the card that owns a ledger or a receipt —
the ActionCard gets one only if R1 chose it), and a "conditions" line in the RollCard breakdown.
Player-visible: the condition and its duration, never a Revert control.
**8b. Read tools.** `src/core/agents/readTools.ts` exposes active conditions with source/duration so an
agent can answer "what is on the goblin".
**8c. Docs.** `PF1e_Unified_TODO.md`'s F01 clause becomes checkable (add the acceptance line the
dashboard can see); `ACTION_SYSTEM.md` gains a pointer from the pending row to the executor; the
`statBlock.ts` deferral map is reconciled; `DECISIONS.md` gets the per-slice entries; `DEVIATIONS.md`
untouched unless a rule's _meaning_ changes (this plan changes no rule).

**Acceptance.** A GM can find and press Revert for a maneuver without reading docs; the coverage
dashboard (`node scripts/coverage.mjs --check`) passes with the new item; no doc claims coverage the
tests do not back.

### Sequencing summary

| Phase | Closes             | Depends on                | Size (relative) | Touches                                                  |
| ----- | ------------------ | ------------------------- | --------------- | -------------------------------------------------------- |
| 0     | —                  | —                         | S (landed)      | tests + DECISIONS                                        |
| 1     | G-A1, half of G-A2 | R1                        | M               | maneuver/dying/first-aid flows, sync tests, e2e          |
| 2     | G-A2               | R1, R2, phase 1           | M               | rollLedger, RollCard, host roll-revert                   |
| 3     | G-A5               | R4                        | M               | conditions normalizer, planners, readers                 |
| 4     | G-A4               | phase 3, R3               | M               | core/combat tick, worldClock                             |
| 5     | G-A7               | phases 1–3, R4            | **L**           | cast flow, pending cast, new pure planner, pack upgrades |
| 6     | G-A8 (poison)      | phases 4–5, R5            | L               | new affliction module + data + UI                        |
| 7     | G-A6, trample      | phases 1–4, transcription | M               | movement writes, trample, statBlock                      |
| 8     | —                  | all                       | S               | UI, read tools, docs                                     |

Interlocks: 1 and 2 are one design; 3 must precede 4 (nothing to tick otherwise) and should precede 5
(payload durations); 5 must precede 6c (the executor and cadence share the commit shape); 7a's movement
write is a prerequisite for 7b but not for anything else.

---

## 5. Explicit non-goals

- **No new revert mechanism.** Receipts and the ledger already exist and are proven; this plan only feeds
  them. A third mechanism (per-condition undo, a condition trash bin) is not proposed.
- **No rule changes and no `DEVIATIONS.md` entries.** Every slice is an authority/pipeline change; the
  numbers come from the already-verified modules (`maneuvers.ts`, `conditions.ts`, `firearms.ts`, …).
  Where a rule is not verified yet (poison, trample), the phase starts with transcription, not encoding.
- **No unsticking of the 2-round window or the prune.** F01's contract is explicit: the ledger prunes, it
  does not become a 50-round time machine. Long-lived undo stays the receipt path.
- **No player-facing Revert.** The host's GM-only gate is a security property, not a policy default to
  relax; delegated _rerolls_ stay the player-facing verb (F01).
- **No FX writes.** D-405's boundary holds: FX render and anchor, never mutate.
- **No core document shape changes smuggled in.** `actor.effects` / `system.pf1e.conditions` shapes change
  only if R4 decides it, in a slice that owns the migration story (and per P0: no version bump invented).
- **No reversal of the strategic scale.** Mass battles keep checkpoint/pool undo; this plan never makes a
  tactical revert rewrite pool columns (M08's hero overlay remains the only bridge, on its own schedule).
- **No item/economy/consumable ledger coverage** beyond what a condition-bearing action needs (F01's
  `ledgerOps` may include them where a flow already writes them; nothing new is promised).
- **No compendium/import undo.** Bulk imports are not per-action edits.

---

## 6. Decisions needed before the branching phases

R1 and R4 gate Phases 1–5. Each is written as a `DECISIONS.md` entry when ruled on.

**R1 — Which envelope carries a condition action?**
(a) _Audited receipt only_ (`commitOps` + `newActionAudit`): out-of-band, no window, GM-only, survives
pruning, invisible to players; the maneuver card stays a report. (b) _F01 ledger only_: the card owns the
ops, Revert/Reroll live on the card, 2-round window, players see the card. (c) _Both_: the receipt is the
durable undo; the ledger is the in-window UX. — **Recommendation: (c)**, matching the attack flow (which
already has a receipt path for world actions and a ledger for cards) and F01's own model; the cost is one
extra preflight per action. Decision must also state which of receipt/ledger is authoritative when both
exist (recommend: the receipt is the truth, the ledger is pruned UX; a card revert that cannot recompute
falls back to the receipt when the window has passed).

**R2 — Staleness semantics for array homes.**
(a) _Keep fail-closed_ (today): any later write to the document blocks the receipt, any later write to the
path blocks the ledger; safest, but a stray HP edit blocks a grapple revert. (b) _Per-path for the ledger,
whole-doc for the receipt_ (current, keep). (c) _Impact-aware carve-outs_: treat condition ops as an
independent path and let an HP-only change pass — requires the ledger to record the condition array's
post-image separately (it already records per-path post-images) and works only for the ledger. —
**Recommendation: (b) as the contract, plus the one carve-out (c) for the ledger**, and for the receipt
keep whole-document (it is the last-ditch mechanism; false refusals there are recoverable by hand, false
successes are not).

**R3 — Reverting an already-expired or replaced condition.**
(a) _Refuse as stale_ (today's machinery, fail-closed). (b) _Allow the whole-document restore_ when the
post-image mismatch is exactly the expiry the revert would also undo — powerful, but it reverses later
world decisions and breaks the "no new dependents" guarantee's spirit. (c) _Refuse, but with a reason that
names the blocking change_ ("stale: the condition expired at turn 7"). — **Recommendation: (a) + (c)**:
same behavior, better diagnosis; no silent time travel.

**R4 — How do timed conditions live in the names-only home?**
(a) names-only, manual removal; (b) compact timed entries with a read-normalizer (Phase 3's
recommendation); (c) route maneuver conditions into payload effects (`actor.effects`/combatant record) and
reserve names-only for untimed state. **Recommendation: (b) now, (c) only if/when the effects array gains
per-element addressing** — otherwise (c) makes the ledger's staleness more brittle (whole-array diff) and
moves grapple bookkeeping into payload space for no reader benefit.

**R5 — What does "revert a poison" mean?**
(a) _Event undo only_: the infliction action and its immediate ops; frequency-save damage is later actions.
(b) _Unwind the track_: the receipt also reverses every cadence write since (needs those writes to be
children of the receipt — a much larger contract). **Recommendation: (a)**, with an explicit "cure
affliction" action (itself revertible) as the user-facing fix for a bad poison.

**R6 — Do Phases 5–7 belong in the near-term plan, and who owns the P6/P7 overlap?**
Trample's tactical fields are routed to P6 by `statBlock.ts:25–27`, firearms deferral text is stale vs P09
(D-202/D-215/D-218/D-219), and the spell continuation is listed in `ACTION_SYSTEM.md:172`. —
**Recommendation:** land Phases 0–2 (the asked-for revert) as the next PRs; then decide 5 vs 6 vs 7 by the
usual source-of-truth priority (P6's own remaining items are already closed per `PF1e_Unified_TODO.md`
§8 — mounted/firearm consumers are the live tails), and fix the stat-block/doc texts regardless of which
phase follows, so the docs stop implying the gap is only the fields' consumers.

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
| condition library                | `src/packages/pf1e/conditions.ts` (`pf1eConditionPayload:511`, `pf1eConditionRequest:521`, refusal)                                                          | the only verified condition source                                    |
| effect ops                       | `src/packages/pf1e/effectOps.ts:124,290`                                                                                                                     | actor vs combatant homes, `MAX_EFFECTS`                               |
| effect payloads                  | `src/packages/pf1e/effects.ts:128,412`                                                                                                                       | source kinds incl. `poison`                                           |
| pure maneuver rules              | `src/packages/pf1e/maneuvers.ts:578` (`pf1eDirtyTrick`)                                                                                                      | duration/removal text that G-A5 drops                                 |
| combat tick                      | `src/core/combat.ts:291` (`tickEffects`)                                                                                                                     | Phase 4a's hook                                                       |
| world clock                      | `src/packages/pf1e/worldClock.ts:204` (`pf1eClockSweepOps`)                                                                                                  | Phase 4b's hook                                                       |
| ledger                           | `src/packages/pf1e/rollLedger.ts` (`buildRollLedger:80`, `captureLedgerInverses:150`, `ledgerStaleReason:178`, `planDamageDeltaReroll:237`, `revertOps:302`) | F01's contract                                                        |
| receipts                         | `src/core/actionRevert.ts:38,103`; `src/host/sync.ts:2808,3258`                                                                                              | the durable mechanism                                                 |
| roll ledger builder in the UI    | `src/ui/sheets/pf1eResolveFlow.ts`                                                                                                                           | the only ledger producer today                                        |
| cast flow                        | `src/ui/sheets/pf1eCastFlow.ts:547–736` (`runSpellEffect`), `:1531–1539` (pending row)                                                                       | Phase 5's target                                                      |
| module API                       | `src/core/moduleApi.ts`                                                                                                                                      | no condition method; keep it that way (modules propose, hosts commit) |
| sheet edit allowlist             | `src/ui/sheets/pf1eSheetModel.ts:222` (`pf1eSheetEdit`)                                                                                                      | numeric-only; not a condition seam                                    |
| action card                      | `src/core/action.ts:120` (`conditions` report), `src/ui/chat/ActionCard.svelte`                                                                              | report-only per D-405                                                 |
