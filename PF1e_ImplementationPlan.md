# Pathfinder 1e Module — Implementation Plan

**Date:** 2026-09-08 · **Branch:** `arena/01a07ced-arenastar-vtt` (PR #4 head `90fc5a1`)
**Scope:** the whole PF1e module — tactical (hero-level) play **and** the strategic mass-battle sim.
**Reads together with:**

| Document | Role | Status |
|---|---|---|
| `PF1e_Combat_Fidelity_GapList.md` | *what is wrong/missing per SRD rule*, with the verified numbers in Appendix A | authoritative for rules detail; §1.1–1.5, 1.8, 2.1–2.3 closed on this branch |
| `PF1e_MVP_WorkPlan.md` | the **strategic** MVP (Combat_Resolver_5 parity: per-model attacks, DR/SR, envelopment, analytics) | largely delivered by the three PR sets on this branch; still valid for §5/§6 of itself (hero bridge, CSV/analysis UI) |
| `PF_MassBattles_IntegrationPlan.md` | how a package plugs into the sim/worker pipeline (§5A, §11, §12) | platform doc, unchanged |
| this file | **sequencing and design contracts for reaching "a GM can run a PF1e session"** | new |

This plan does not restate the SRD. Where a rule's numbers matter it cites
`PF1e_Combat_Fidelity_GapList.md` **Appendix A.n**, which holds the values verified against the
d20pfsrd Combat chapter.

---

## 0. Where we actually are (audit, 2026-09-08)

Strategic scale works and is gated: a deployed 10 000-model PF1e battle compiles profiles, seeds
every model, resolves attacks against real ACs from a forked PRNG, ships as a real `systems/*`
package (`pnpm build:systems` → zips that activate in a booted world), and is covered by
`tests/packages/pf1eMassBattleScale.test.ts` (p50 ≈ 30 ms/turn, `bytesPerModel` 66.00).

Tactical scale is a **VTT with PF1e content parked next to it**, not a PF1e ruleset:

| Capability | Reality |
|---|---|
| Initiative | tracker + delay + defeat + effect badges work (`src/core/combat.ts`, 11 tests); "Roll init" is a **flat `1d20` for all tokens of the active scene**, `actorId: null`, no Dex tie-break, no context menu on tokens (right button = pan, `src/canvas/interactions/index.ts:199`) |
| Sheets | `src/ui/sheets/SheetPanel.svelte` is a generic key/value document editor; `PF1eActorSheet.svelte` is an **orphan with zero importers** and 8 hand-typed numbers; `system.pf1e.*` (what the bestiary pack writes) is **read by nothing** |
| Attacks from sheet | the faithful math exists (`combatEngine.ts`: `resolvePF1eAttacks`, `resolveTargetAc`, `isDrBypassed`, CMB, AoO, trample, healing) but its only caller is `massBattlePf1e.ts`, and its input is `{pool, attackers: number[], defenders: number[]}` — not per-actor |
| Effects/conditions | `EffectDocument = {changes: [{path, value}], disabled}` (`src/core/documents.ts:151`): no mode, no stacking group, no duration semantics — and **`changes` has no consumer**: nothing applies an effect anywhere in the app |
| Timers | `tickEffects` decrements `flags.core.duration` at the **owner's turn end** and expires at 0 (tested). Outside combat nothing ticks: there is **no world clock** (no `gameTime`/`worldSettings` producer — every `RulesContext` caller passes `worldSettings: {}`) |
| Spells / AoE | strategic only (`src/packages/pf1e/spells.ts`, per-model, fireball radius hardcoded 15 ft vs pack's 20 — recorded deviation). Tactically there is no area tool, no per-token save prompt, no damage application |
| Replication | `rollData` already rides the chat-roll wire (`src/host/sync.ts:795`) and the dice engine substitutes `@dotted.path` (`src/dice/engine.ts:57`) — the plumbing for "roll from sheet with actor data" exists, no UI populates it |

**Consequence:** the cheapest path is not "more rules code" — the rules code exists. It is **three
data contracts + one application pass**, then wiring the existing UI surfaces to them.

---

## 1. Definition of done: five table-top scenarios, executed as tests

A phase is not done when code lands; it is done when its scenario runs green. Scenarios are written
as vitest against pure modules (logic) + a Playwright spec (table flow) where a human click matters.

1. **S1 — "Fighter vs Goblin"** (P1–P3): GM drags a `heavy-infantry` bestiary entry onto the canvas,
   selects the token + a PC token, right-clicks → *Roll initiative (2 tokens)*; the tracker shows
   `1d20 + Dex + Imp. Init`, ties broken by **total initiative modifier** (Improved Initiative counts),
   then reroll; if only some combatants are aware, the surprise round comes first and only the
   aware ones act (one standard or move action each; unaware combatants don't act and are
   flat-footed). Clicking *Attack* on the PC's
   sheet rolls `1d20+7` vs the goblin's **touch/flat-footed/normal AC as appropriate**, confirms a crit
   on a threat, applies the weapon's damage with the grip's Str multiplier (two-handed longsword
   `1d8 + 3×1.5 → 1d8+4`), never below 1, and writes hp onto the actor.
2. **S2 — "Bull's Strength for 8 minutes"** (P4): GM creates the buff (`+4 enhancement Str`,
   `1 min/level` at CL 8 — the spell's real magnitude and duration, CRB p.250; with 6-second
   rounds the badge shows 80), drags it onto a token; the sheet's Str and its derived damage
   **change**, and the initiative order does **not** (a Str buff never rewrites an initiative
   result; only delay/ready reorder mid-combat, A.1); it ticks on the creature's turn end, and when
   it expires every derived number reverts.
3. **S3 — "Fireball into a cluster"** (P5): GM picks burst 20 ft on the grid; every token in the area
   is listed with cover/concealment applied, each rolls a Reflex save (`1d20+ref vs DC 15`),
   takes `½` on success (round down, no minimum) with DR/ER respected, a character with
   **Evasion takes 0** on a successful save (Improved Evasion: half even on a failure), and SR
   is checked **without** a nat-20 auto-success.
4. **S4 — "Trip the mage, then cast defensively"** (P6): an opponent takes a trip CMB vs CMD, the
   prone condition lands as a real modifier (`−4 melee attacks, ranged unusable except
   crossbow/shuriken; −4 AC melee / +4 AC ranged`,
   stand = move action that provokes), the mage casts defensively with a
   concentration check `DC 15 + 2 × spell level` (no AoO), and if injured while casting the
   check is `10 + damage taken + spell level`; failure burns the spell.
5. **S5 — "Dying and stable"** (P7): damage past 0 starts the staggered → dying → stable track —
   at 0 you're staggered and a standard action costs 1 HP after the act; dying means a DC 10
   Con check each round with a penalty equal to your negative HP total (nat 20 auto-stabilizes,
   failure loses 1 HP), a DC 15 Heal first aid can stabilize you, and a coup de grâce whose
   target survives the auto-crit damage must still make the mandatory Fort save (DC 10 + damage
   dealt) or die.

Anything a phase's scenario cannot express is a scope bug, not a follow-up.

---

## 2. Locked decisions (from the Gap List §10 answers; do not re-litigate)

1. **Two independent implementations.** Tactical PF1e and strategic PF1e each implement the Combat
   chapter. They share **data and tables** (`schema.ts` profile compile, Appendix A numbers,
   `pf1e-core` packs), never a resolution kernel. Do not plan a "shared engine" PR.
2. **No changes to core `EffectDocument`/`ActorDocument` shape** (`src/core/documents.ts`). Every PF1e
   semantic lives under `system.pf1e` or `flags.pf1e`. Other modules must be unaffected — that is the
   review criterion, not a nicety.
3. **In-repo first, package second.** Rules logic lives in `src/packages/pf1e/`, reached through the
   trusted seam; `systems/pf1e-mass-battles` stays the shipped package. The tactical half does **not**
   need the iframe module API (`MODULE_METHODS` is 8 calls, `MODULE_HOOKS` 4 events — it cannot drive
   sheets), so no `module.js` work is planned.
4. **No new ModelPool columns without a §19 budget check.** `bytesPerModel` is asserted in the scale
   gate at ≤ 200 B (now 66.00); strategic additions must re-measure, not assume.
5. **PR discipline** (this is what made PR #1–#3 reviewable): one PR = one phase slice, no new rules
   surface outside it, every PR ships its own test and a Gap List/DECISIONS line. Docs and code in the
   same PR; no drive-by refactors of platform files.

---

## 3. The three contracts everything depends on

These are the only *new abstractions* in this plan. Lock them in one PR (P0) before any UI work, because
sheet, tracker, effects, and rolls all read them.

### 3.1 Actor data — `actor.system.pf1e` (authored) + derived, never stored

Single source of truth for a PC or a monster. Authored numbers are typed by the user/CR; everything
derivable is computed on read.

```
system.pf1e = {
  abilities: { str, dex, con, int, wis, cha },        // scores
  hp:        { max, current, nonlethal, temp, abilityDamage },
  ac:        { armor, shield, natural, dodge, misc }, // + derived: normal / touch / flatFooted
  attack:    { bab, rangedTouch: false,
               weapons: [{ name, toHitBonus, damage: {dice, sides, critRange, critMult},
                           type: "slashing"|"bludgeoning"|"piercing"|"…",
                           range: null | { incremental: feet },
                           twoHanded, light, masterwork, natural }] },
  cmb:       { bonus /* derived: BAB + Str + size */ },
  cmd:       { bonus /* derived: 10 + BAB + Str + Dex + size + misc */ },
  saves:     { fort, ref, will },                     // base; + derived from abilities/effects
  initiative:{ misc /* Imp. Init, Improved Initiative is a feat → misc */ },
  dr:        [{ amount, bypass: ("magic"|"lawful"|"good"|"silver"|"cold iron"|"adamantine"|"alignment")[] }],
  er:        [{ energy: "fire"|…, amount }],
  sr:        null | number,
  size:      "Fine"|"Diminutive"|"Tiny"|"Small"|"Medium"|"Large"|"Huge"|"Gargantuan"|"Colossal",
  speed:     { feet, land, all: false },
  feats:     [{ name, notes }],
  traits:    [{ name }],
  senses:    { perceptionMisc },
  spellcasting: {
    casterLevel, keyAbility: "wis"|"int"|"cha", focus,
    perDay: { [level 0..9]: number }, knownOrPrepared: [{ name, level, saveDcBonus, damage, area,
      effect: "spellEffect-ref" }],
  },
  creature:  null | { cr, type: "humanoid"|…, alignment, init, senses, languages, sq,
                      treasure, specialAttacks }      // monster-only tab
}
```

* `src/packages/pf1e/actor.ts` (new): `derivePF1eActor(actor, activeEffects) → PF1eDerived` —
  pure, node-tested, and the **only** place Appendix A tables are applied at tactical scale. Exposes
  `{ acNormal, acTouch, acFlatFooted, initiative, saves, cmb, cmd, attacks: [{ toHit, damage,
  critRange, critMult }], speed, dr, er, sr, conditions }`.
* Sizing: reuse the ability-modifier and size tables from `schema.ts:compilePF1eProfile`'s inputs;
  do not re-encode them per call site.
* **No derived number is ever written to the document.** That rule is what makes effect expiry free.
* `systems/pf1e-core/packs/bestiary.json` already writes `system.pf1e` (bab/strMod/ac/touchAc/weapon)
  → P0 extends the pack to the full shape (6 entries) and keeps `tests/packages/pf1ePacks.test.ts`'s
  "pack ↔ engine table" equality test, so packs and code cannot drift.

### 3.2 Effects — `EffectDocument` stays as-is; PF1e semantics in `flags.pf1e`

`changes: [{path, value}]` cannot express "+2 morale to AC", so it is **not** used as the mechanic.
An effect is a `changes`-free container whose payload lives in `flags.pf1e`:

```
effect = { type: "effect", changes: [], disabled: false,
  name: "Bull's strength", icon: "…",
  flags: { core:  { duration: 8 },                     // ← the ticking authority (unchanged)
           pf1e: {
             bonuses:  [{ key: "ability.str", value: 4, type: "enhancement", stack: "str" }],
             penalties:[{ key: "ac", value: -4, type: "circumstance" }],   // prone
             denies:   ["full-attack"],                                   // e.g. confused
             boosts:   [{ key: "damage", value: 1, kind: "dice", sides: 6 }], // energy
             condition: "enlightened" | null,           // immune-to-mind-affecting support
             concentration: false, sustained: false,
             ttl: { unit: "rounds"|"minutes"|"hours"|"days", perLevel: false, endsOn: "own-turn" },
             source:  { kind: "spell", id: "bulls-strength", level: 2, dc: null }
           } } }
```

* `src/packages/pf1e/effects.ts` (new): `applyBonuses(base, effects)` implementing PF1e's stacking
  rules (same-typed bonuses don't stack, different types do; untyped dodge and misc do;
  `enhancement`/`penalty` on the same key net), plus `effectsAffecting(target, predicate)`.
* Ordering (armor → shield → Dex(capped) → size → natural → misc → dodge → deflection → …) lives in
  `derivePF1eActor`, so the sheet, the roll builder and the tracker cannot disagree.
* **Ticking stays in `core/combat.ts`** (`tickEffects`, `flags.core.duration`) — we do not fork the
  timer, we only add semantics + a round-boundary variant (P4) behind `ttl.endsOn`.
* Authoring UI is a PF1e panel (not a core change): the existing `#pkg-file`-style pattern in
  `src/ui/armies/GmExtrasPanel.svelte` and the key/value editor in `SheetPanel` show the idiom.

### 3.3 Encounter state — `flags.pf1e` on `CombatDocument` + combatants

The tracker knows nothing about PF1e round structure. Use the sanctioned FlagStore extension point
(`core/combat.ts` header documents it) instead of new fields:

```
combat.flags.pf1e = { surprise: true, surpriseSurprise: [combatantIds], roundUnit: "6s",
                      clock: { round: 0, minute: 0 },        // ← P4, drives minute/level durations
                      heldActions: [{ combatantId, trigger: "on-move" | "on-attack" | readiedAttack:
                                     {formula, targetId}, spentTurn: n }] }
combatant.flags.pf1e = { aoosRemaining: 1, readied: null, flatFootedUntil: "own-turn" }
```

* `src/packages/pf1e/combatState.ts` (new) wraps the pure core transitions: `pf1eNextTurn(combat)`
  calls `nextTurn(combat)`, then resets `aoosRemaining`, drains `heldActions` in initiative order,
  and advances `clock` on round wrap. All round-structure rules live here; `core/combat.ts` is not
  modified — other modules keep their current behavior.
* The AoO window is an app-level event (`token moved while adjacent`) → `src/canvas/interactions`
  already emits drags; P6 hooks the drop to `combatState` before submitting the token position update,
  so the interrupt is a real interrupt and not a UI suggestion.

---

## 4. Phases

Effort is in focused days for one engineer, matching the Gap List's M-scale. Each phase lists the
Gap List rows it closes, its acceptance scenario, and what it must **not** touch.

### P0 — Contracts (2–3 d) → unlocks everything
* `src/packages/pf1e/rulesTables.ts` (the SRD tables both scales read), `actor.ts` (schema +
  `derivePF1eActor`), `statBlock.ts` (the pack's totals/mods ⇄ the sheet's components), `effects.ts`
  (`resolveEffects` — the stacking resolver, named for what it does rather than `applyBonuses`, since
  it applies nothing), `combatState.ts` (round structure under `combat.flags.pf1e`), all pure and
  node-tested.
* `worldSettings` made real (D-113 revised this: **not** on `WorldsRecord`, which is local and
  un-replicated): a `src/core/worldSettings.ts` reader/writer over the existing `settings` collection,
  one document `_id="world-settings"`, `ownership.default = LIMITED` so players see the clock their
  durations tick against. Plumbed into the `RulesContext` producers that used to pass `{}`
  (`src/app/App.svelte`, `src/host/turnChannel.ts`, `src/ui/armies/armyModel.ts`, plus
  `src/ui/logistics/LogisticsPanel.svelte` which the audit had not counted), with a "Rules options"
  group in `SettingsPanel` for `secondsPerRound` / `advanceClockOnRound` / `detectionMultiplier`.
  The rules-behaviour toggles (crit confirmation, auto-roll saves, spell scatter) land **with the rules
  that read them** — P3, P4 and P5 — rather than as options that do nothing yet.
* **No** `systems/*/manifest.json` bump and no declarative `migrations` step (D-113): nothing persisted
  needs converting — the packs already ship `data.system.pf1e`, and the orphan sheet that wrote the flat
  `system.ac`/`system.bab` shape was never mounted, so there is no data at risk. A version bump would
  only churn the zip names and the §12 manifest tests. The parity guarantee is instead a test that
  derives the *shipped bestiary JSON* through the tactical reader, so content and code cannot drift.
  If a real migration is ever needed, the step shape is `{ from, to, transforms }` with
  `set|default|move|rename` (`src/core/migrations.ts:58`), not `ops`.
* **Accept:** unit tests for every derived field with the exact Appendix A fixture (`A.2`, `A.9`,
  `A.14`); `derivePF1eActor` is idempotent and writes nothing; the rules-context producers read the
  settings document instead of a literal `{}` (the sim-worker probe in `src/app/e2eHook.ts` has no store
  by design and stays empty, with a comment saying so).
* **Must not touch:** `src/core/documents.ts`, `EffectDocument`, `src/sim/*` schema.

### P1 — Sheets that are not orphans (3–4 d) → closes Gap List §1.7, §4.1
* Mount the PF1e sheet: `WindowHost.svelte` gains a `sheet` window kind (the `{:else if win.kind}` chain)
  opened by double-clicking a token that has `actorId`, and from `SheetPanel`'s actor rows.
* Rewrite `PF1eActorSheet.svelte` against `system.pf1e` + `derivePF1eActor`: Abilities (6 scores →
  mods shown), HP bar w/ temp + nonlethal + ability damage, AC breakdown rows, attacks list, saves,
  CMB/CMD, DR/ER/SR, speed, feats/traits, and a **monster tab** (CR/type/alignment/senses/special
  attacks) rendered only when `system.pf1e.creature` exists.
* Replace the orphan's `store.applyEnvelope({txId: \`tx-${Date.now()}\`, seq: store.seq + 1})` direct
  write with `client.submit([...])` — that envelope fabricates a seq and, on a **player** client,
  bypasses the §4 intent path and its permission check. (Verified: no other component writes this way.)
* Compendium → actor parity: bestiary entries keep importing as actors by drag (`App.svelte:439-482`
  already links `token.actorId`) and now render.
* **Accept:** S1's "drag bestiary entry" half; a component-less test that the sheet's derived panel
  equals `derivePF1eActor`; e2e: `e2e/sheets.spec.ts` extended with a PF1e row (double-click → window
  shows AC 18/13/15 for the fixture actor).
* **Not:** no roll buttons yet (P3), no effect editor (P4).

### P2 — Initiative, selection, and the token menu (2–3 d) → closes §3.1, §4.2 (partly)
* `src/canvas/interactions/index.ts`: add a `contextmenu` path (right-button currently = pan; keep
  shift/middle pan) with a DOM menu anchored at the cursor, fed by the **selection set** the marquee
  already builds (`:283-291`). Menu items: *Roll initiative (n)*, *Add to combat / Remove*,
  *Mark hidden*, *Target with spell* (P5), *Apply effect* (P4).
* `CombatPanel.beginCombat`: create combatants from **selected tokens** when a selection exists, else
  all current-scene tokens, and set `actorId: token.actorId`. **D-124 delivers the selected-token
  tracker path** (creation, add/remove, partial initiative, scene/deletion guards). Existing
  encounter Start does not rebuild its roster. The token context menu itself remains open.
* `rollInitiative` → actor-derived initiative per combatant (**public path delivered D-122**).
  Tie policy correction (CRB p.178): compare total initiative modifiers, then roll remaining
  ties, not just `derived.initDex`; **public PF1e tie handling delivered D-123** (recorded
  subgroup roll-offs and persisted equal-total order). `applyInitiative` keeps its
  "values pre-rolled by caller" contract so `core/combat.ts` still needs no PF1e knowledge.
* Surprise round: `combatState.startWithSurprise` (only combatants that started the battle aware of
  their opponents act, each with one standard or move action plus free actions; unaware combatants
  don't act and are flat-footed until they do; then
  normal order) — Appendix A.1.
* Multi-encounter: `beginCombat` today reads `store.getAll("combats")[0]` (single encounter). Add a
  minimal encounter list (create/activate) in `CombatPanel`; keep one *active* combat so the existing
  transitions are untouched.
* Hidden NPC rolls: reuse `src/dice/commitReveal.ts` so GM rolls are verifiable and not shown raw.
* **Accept:** S1's initiative half; tests for tie-break, selection-scoped roll, surprise order, and
  "delay re-joins at the top of the next round" — the original marker bug was: `nextTurn`'s round-wrap
  loop originally tested `"delayed" in c.flags` while the writer uses `flags.core.delayed`.
  **D-120 repaired this generic marker cleanup with core and browser regression tests.**
  Previously non-starting combatants stayed marked until their individual turn start, not
  forever. This is generic compatibility behavior, not PF1e delay/resume scheduling; that
  rule still requires explicit initiative changes and cross-round handling.

### P3 — Attacks and damage from the sheet (4–6 d) → closes §3.2, §3.4, §4.7 (tactical half)
* `src/packages/pf1e/tactical.ts` (new): `attackRoll({attacker, defender, mode, situational})` and
  `damageRoll({weapon, attacker, defender, isCrit})`, applying the full modifier stack of A.2/A.3/A.4
  (BAB, Str ×1.5/×½, size, WB, TWF — SRD Two-Weapon Fighting table, not yet transcribed in
  Appendix A, cite the SRD page when fixtures are written, flanking +2, fatigue/exhaustion,
  charge +2 attack/−2 AC (a charging bull rush also takes +2 on the CMB), cover `+4/+2`, improved cover +8/+4, total cover = no attack,
  concealment 20/50 % non-stacking, invisible = total concealment (50 % miss) + denied Dex,
  A.8), threat → **confirm** roll at full
  bonus, min 1 damage, nonlethal/lethal swap, and precision damage immunity.
  It reads `PF1eDerived`, **not** a `ModelPool`. The strategic loops in `combatEngine.ts` stay as they
  are (decision 2); only the tables/rule constants are shared, and `rulesTables.ts` (P0) is that shared
  layer — `schema.ts` keeps its own compile, so the seam is data, never a kernel.
* Sheet buttons → `{type:"roll"}` message with `rollData` (already on the wire, `sync.ts:795`) so the
  result posts to chat with the breakdown line ("+11 = BAB 6 + Str 3 + 2 charge"), and a *Verify* chip
  using `verifyCommitRoll` where the GM opted in.
* Actor hp writes: `update` op on `system.pf1e.hp` through the ordinary op path (players see it),
  with dying/stable bookkeeping deferred to P7 — but write the field shape now so P7 is additive.
* Full attack iteration (BAB +6/+1), AoO opportunity **prompt** (the interrupt itself is P6),
  ranged touch vs touch AC, splash `1d8` + grid-intersection AC (A.12) for weapons.
* **Accept:** S1 in full; per-rule tests named after the SRD heading (see §6), including the three
  discriminating fixtures from the Gap List (AC 22/16/17 breakdown; flanked 16+0+2 = 18 vs AC 19 miss,
  17 ⇒ 19 hit; `1d6 − 10` ⇒ 1 nonlethal, DR bypassed, 2 > hp ⇒ unconscious).
* **Not:** no maneuvers (P6), no spell DCs (P5), no conditions applied from hits (P4 keeps that link).

### P4 — Buffs, conditions, custom authoring, real timers (5–7 d) → closes §3.3, §4.3, part of §5
* Effect store: `actor.effects` (embedded items, `parent` chain — the ref format already used for
  tokens) and, for combat-timed effects, `combatant.flags.core.effects` as `core/combat.ts` expects,
  written by a PF1e helper so the **badge + tick** path is reused verbatim.
* Effect editor window (`src/ui/sheets/PF1eEffectEditor.svelte`, new): name/icon, bonus rows with
  typed `key/type/stack`, denies, boosts, condition picker from the SRD list, and duration with unit +
  `perLevel` + `endsOn` — producing the `flags.pf1e` object above. Custom buffs are first-class: the
  editor does not offer a closed enum for `key`.
* Two-way application: `derivePF1eActor(actor, effects)` is already the consumer (P0). Add
  `recomputeOnCombatEvent` so a change re-sorts initiative when Dex changes mid-combat (documented
  PF1e behavior: initiative is a check, but Dex penalties apply — cite A.1).
* Timers: keep owner-turn-end decrement as the default (`endsOn: "own-turn"`); add `"round-start"` for
  effects the SRD measures in whole rounds, and make `clock` (P0) drive `minutes/level` and
  `hours/level` effects outside combat, including "1 min/level ⇒ 10 rounds" — the world clock lives in
  `worldSettings`/world record, advanced by a `▶ round` control in the tracker and by a
  `+ 10 minutes` button when combat is not running.
* Concentration & maintained: `sustained: true` effects require a standard action, failing which they
  drop (`combatState.heldActions`-style check on turn end).
* Condition library: encode the SRD conditions that change math — flat-footed, prone, stunned,
  dazzled, blinded, grappled, pinned, exhausted/fatigued, sickened, nausea, frightened, panicked,
  dazed, disabled, dying, stable, unconscious, paralyzed, petrified, confused (denies), invisible
  (total concealment: 50 % miss to attackers + denied Dex), plus the "mind-affecting immune" hook.
* Token visuals: `src/canvas/tokens.ts` renders `derived.conditionIcons` under the token (the layer
  currently draws no badges — verified).
* **Accept:** S2 in full + an expiry-revert test proving `derivePF1eActor` returns the base object
  after the last tick, and a test that a `+2 enhancement` and `+2 insight` to the same key both count
  while two `+2 enhancement` do not.

### P5 — Spellcasting & targeting (5–8 d) → closes §4.8, §4.9, part of §5
* Targeting tool in the canvas: burst/radius, cone, line, emanation; snap-to-grid using the scene's
  `distance`/`units` and the 5-10-5 diagonal rule (A.7) — measure with the existing
  `snapPoint`/`measure.ts` helpers, and highlight tokens in the area *before* committing.
* Save resolution: for each affected actor, `1d20 + save vs DC (10 + spell level + key mod + focus)`;
  SR `1d20 + CL vs SR` **with no nat-20 auto-success** (A.16 — verified deviation in the sim); Evasion
  halves on a successful save, no half for effects with "no save" row; concentration for casting
  defensively (A.16); AoO for casting in a threatened square (the prompt from P3, resolved here).
* Spell data: extend `systems/pf1e-core/packs/spells.json` from 4 → ~40 of the most-used spells, with
  `system.tactical` alongside the existing `system.massBattle` block, and keep the pack↔engine parity
  test. Each entry carries `school/descriptors/components/castingTime/range/target/area/duration/
  savingThrow/spellResistance`, so the *text* is right there when the mechanical fields are absent
  (`savingThrow: "Reflex half"` parses into the save row).
* Fireball radius **20 ft from the pack** — delete or honor the sim's hardcoded 15 (Gap List §5).
* Decide the invented **spell scatter** (`spells.ts:153-160` shoves every model in the area, which has no
  core rule) — delete it, or file it in `DEVIATIONS.md`, which still reads "None." while both this and
  the 15 ft radius are live deviations. A deviation nobody recorded is a bug with documentation debt.
* Per-class casting (prep vs spontaneous, slots, bonus spells from high key ability) as **data +
  validation warnings**, not enforcement: the sheet shows slots and flags overuse rather than blocking.
* **Accept:** S3, plus a targeted test that cover improves the Reflex DC outcome (`+2 Reflex` under
  standard cover, A.8) and that total cover blocks the area entirely (A.8).

### P6 — Maneuvers, AoO interrupts, movement, mounted (4–6 d) → closes §3.5, §3.6, §4.4
* CMB/CMD with legality per maneuver and the full aftermath table (A.9): trip → prone (−4 to hit, +2
  to be hit, stand = move-provoking), grapple (both grappled: no AoOs, −4 Dex, −2 attack/CMB
  rolls, no two-hand actions; pinned denies Dex; neither is flat-footed — verified condition
  text), bull-rush
  (forced movement), disarm/sunder (weapon hp), overrun, steal, reverse — each an action button that
  runs the check through P3's roll path.
* Real AoO loop: `combatState.onMoveOpportunity` — one free attack per action per attacker
  (`aoosRemaining`), withdraw/run/exclude-list per A.10, attacking unarmed provoking, and the
  "5-10-5 then leave a threatened square doesn't re-provoke" nuance.
* Movement rules the grid can enforce: difficult terrain ×2/×4, minimum 5 ft movement provokes,
  squeeze −4/−4, running through allies, charge path rules (SRD Charge — no dedicated Appendix A
  entry yet; transcribe the canonical source before fixtures, per R01), and "you can't 5-foot-step into
  difficult terrain".
* Mounted (A.11): mount check DCs, +2 to hit from horseback, lance ×2, horse actions on your initiative,
  and unhorsed handling. (Smallest slice: the modifiers + the horse as a linked companion actor.)
* **Accept:** S4 + a table test over Appendix A.9's legality column and the A.10 exclusion set.

### P7 — Damage consequences, healing, death (3–4 d) → closes §4.10, part of §5
* Dying/stable per A.13 (staggered at negative up to −Con; −1 per round; endurance check vs DC 10+
  damage-taken; stabilize DC 15 removes the condition; natural recovery track), coup de grace (full
  round, auto-hit + full damage, no save for the helpless).
* Ability damage/drain, ability burn (Ultimate Combat, optional behind a `worldSettings` toggle),
  hit point recovery, fast/regenerate + suppress flags (already modeled strategically in the pack's
  `regeneration.suppress`), nonlethal → unconscious at hp 0, and DR-vs-hardness for objects
  (`A.12` splash/`A.17` object rules).
* **Accept:** S5 + the min-1-damage-into-nonlethal regression already written for the sim, mirrored at
  actor level.

### P8 — Dual-scale loop, analytics, content, hardening (4–6 d) → closes §5, §6, §7
* Hero ↔ army integration (strategic MVP plan's Task 7): produce the missing `isHeroUnit` input so the
  already-implemented leadership auras, cleave carryover and envelopment interactions are reachable;
  assert a hero token joining a battle changes both scales consistently *by best effort*, not by a
  parity gate (decision 2).
* Fix the analytics gaps the audit named: `srBlocked`, `aooExecuted`, `aooHits`, `cmbSuccesses`,
  `deathsCount`, `damageHealed` incremented; `generateReport()` called by the module; CSV quoting
  (RFC-4180) in `exportAnalyticsToCsv`; mount `PF1eBattleAnalysis.svelte` + `TurnReportTimeline.svelte`
  + `ArmyWindow` in `WindowHost` (currently mountable only from `e2eHook.ts:815`).
* Clear the `FLANKED` bit when geometry changes (Gap List §2 caveat), and fix the condition-bit
  collision plan (§2.13) with a `status2` column **only if** the §19 budget re-measure stays ≤ 200 B.
* Content: bestiary 6 → 30 CR-appropriate entries, feats table (the ones that alter math: Improved
  Critical, Power Attack, Combat Expertise, Weapon Finesse, Improved Initiative, Toughness, Dodge,
  Mobility, Spring Attack, Combat Casting, Iron Will/Lightning Reflexes), equipment (armor/shields with
  ACP/max Dex), and a class table for the 6 core classes.
* Hardening: a rules-coverage dashboard (`scripts/coverage.mjs` scanning `@srd` doc tags in tests —
  Gap List §7.6) so "what's left" is generated, not remembered.
* **Accept:** the strategic scale gate stays green with the new columns (or no new columns), every
  analytics counter has a test, and a 200-actor tactical combat resolves in one frame budget.

---

## 5. Pull-request sequence (reviewable slices)

| PR | Contents | Lines (est.) | Depends on |
|---|---|---|---|
| **PR-A** | P0: `actor.ts` + `effects.ts` + `combatState.ts` + `worldSettings` plumbing + manifest `1.1.0` migrations | ~900 (⅔ tests) | — |
| **PR-B** | P1: sheet mounted, PF1e actor/monster rendering, submit-path fix | ~600 | PR-A |
| **PR-C** | P2: token context menu, selection-scoped stat initiative, ties, surprise, encounter list | ~450 | PR-A |
| **PR-D** | P3: tactical attack/damage module + sheet roll buttons + chat `rollData` | ~700 | PR-A |
| **PR-E** | P4: effect store, editor, timers/clock, condition library, token icons | ~1100 | PR-A, PR-D |
| **PR-F..H** | P5 → P7 | ~800 each | PR-E |
| **PR-I** | P8 (split further if it grows) | — | PR-F..H |

Each PR: `corepack pnpm test`, `tsc --noEmit`, `eslint .`, `prettier --check` on touched files,
`pnpm build` + `pnpm size` when UI is touched (single-file budget), `pnpm build:systems` when packs or
`rulesEntry.ts` change, and a Gap List status line + `DECISIONS.md` entry for anything that changes an
existing contract. `playwright test --list` is the browser validation available in this sandbox;
actual browser runs happen wherever browsers exist — say so in the PR, don't imply a green e2e.

---

## 6. Verification strategy

1. **One test per SRD row, named after the heading**: `"Cover > Improved Cover: +8 AC, +4 Reflex"`.
   A reviewer checks the rule, not the code. Cite the same heading in the doc comment of the function.
2. **Fixtures over generators**: the derived-value tests use the Gap List's Appendix A tables verbatim;
   add `tests/packages/pf1eFixtures.json` (≈500 worked examples) and one table-driven test that
   `derivePF1eActor` matches it exactly, so an engine edit that changes one row fails loudly.
3. **Discriminating assertions only.** Every PR must include at least one assertion that would fail
   under a plausible wrong implementation (the pattern from PR #1: 22/16/17 AC trio; flanked 18 vs AC
   19 miss vs 19 hit; min-damage-1 into nonlethal). "Does not throw" is not a test.
4. **Oracle for probabilities** (P3+): for a fixed build vs a fixed AC, assert the Monte-Carlo hit rate
   matches the algebraic chance within tolerance at 100 k seeded iterations, and assert exact values for
   single-roll paths. Seeded — never `Math.random()`.
5. **E2E for flow, Node for numbers.** Keep this split we established in §1.11 of the Gap List:
   browser specs prove clicks/windows/replication; budgets, determinism and perf live in vitest.
6. **No snapshot tests** for derived numbers — they bless whatever the code currently does.

---

## 7. Platform constraints to respect (each already bit us once)

* **World-record writes go through `HostPersister.patchWorld`.** A bare `putWorld` is reverted by the
  next 500 ms write-behind flush (Gap List §1.1b). PR-A sidestepped the whole seam by putting world
  settings in a replicated document instead, which is the lesson: prefer a document to a record field.
* **Wire bytes are gzip-compressed, so determinism tests compare `decompressSync(bytes)`** (fflate's
  header carries MTIME; Gap List §1.11 Trap 1).
* **`rules.js` is a build product** (`pnpm build:systems`, git/prettier/eslint-ignored, one
  `export default (() => …)()` expression). Adding files under `src/packages/pf1e/` is free; adding a
  bare import inside the bundle is not.
* **Perf gates:** the 10k strategic turn has a measured p95 ≈ 45–50 ms at 20×500 and **misses** 50 ms
  at 40×250; if P8 adds pool columns, re-measure. Tactical work is not pool-bound, but the 200-actor
  tracker refresh must stay inside one frame — assert it in the scale test rather than eyeballing.
* **Single combat assumption** (`getAll("combats")[0]`) and **single scene assumption for combatants**
  (`beginCombat` reads the first scene's tokens) are both P2 fixes; don't reintroduce them in new code.
* **`noUncheckedIndexedAccess` is on** and `expect(x).includes(…)` is not a matcher — use
  `toContain`. Prettier ignores `systems/**`; markdown is not CI-checked (there is no `.github/`), so
  keep doc tables at a consistent cell count by hand.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Effects-as-modifiers fights the frozen core `EffectDocument`** (PR review pain, "then just extend core") | The contract in §3.2 keeps core untouched and stores everything in `flags.pf1e`; the only core-adjacent change is the optional round-start tick, added as a **new** transition (`combatState.pf1eNextTurn`) wrapping the existing one, so non-PF1e worlds are bit-identical. If we ever do extend core, it is its own design doc + migration, not a side effect of P4. |
| Sheets turn into a second, drifting rule table | `derivePF1eActor` is the single consumer of Appendix A tables at tactical scale; a test asserts no other `src/ui/**` file imports the tables module. |
| UX creep (a real character sheet is a tarpit) | P1 is explicitly *editor + derived readout*, not a Foundry clone: no drag-and-drop loot management, no auto-feature-application UI, per-phase acceptance is the five scenarios. Features that don't serve a scenario go to §9. |
| P5's area tool destabilizing the canvas render path | Targeting lives in a new `src/canvas/grid/targeting.ts` (pure geometry: which cells, which tokens) + one overlay in `EffectsLayer`; the interaction change in P2 stays a menu, so the controller's drag/pan state machine is edited once, not per feature. |
| Rule detail we cannot verify (Appendix gaps: Fighting Defensively / Combat Expertise exact numbers were never re-read) | Both are flagged "re-read before encoding" in the Gap List. P3/P4 must re-fetch the chapter (only `fetch_page` on the canonical d20pfsrd URL works) rather than reuse the sim's `-2/+2` guess. |
| Pack ↔ engine drift (six bestiary rows already mirror in-repo tables) | Keep the existing equality test, and require every new pack field to be asserted there — a field with no test is a field that lies later. |

---

## 9. Explicitly out of scope for this plan

* Anything in Gap List §8 (mass-combat-adjacent 3PP subsystems beyond the firearm rules already
  implemented, vehicles, siege, domain/politics, mass-battle morale rework) and the §4 "hero-level
  spellbook management" depth.
* A shared cross-scale rules kernel (rejected, decision 1), and any `module.js`/iframe module surface
  expansion (`MODULE_METHODS`/`MODULE_HOOKS` are too small to host sheets; PF1e is in-repo).
* Player-facing feature parity beyond: sheet ownership + rolls + chat + their own effects (players
  currently get only Chat + Sheets in `JoinApp.svelte`; adding Journal/Tables/Tracker to the player
  sidebar is a ½-day follow-up in P1 if you want it, not a PF1e item).
* Visual craft: portrait frames, 3D dice animations, theming.

---

## 10. What I need from you before PR-A — **resolved 2026-09-08, see `DECISIONS.md` D-113**

Answers below, with the two revisions the code forced (both are *improvements* to what I proposed, so
they are recorded rather than silently applied):

1. **Adopted as stated.** `system.pf1e` is the single authored tactical location; `derivePF1eActor` is
   its only tactical consumer; nothing derived is persisted. **Revision:** no `1.1.0` bump and no
   declarative migration in P0 — there is no persisted PF1e tactical data to migrate (the orphan sheet's
   `applyEnvelope` was never mounted, and the packs already ship `data.system.pf1e`). Instead the
   derivation is total over partial input and a test derives the *shipped bestiary JSON*, so pack data
   and code cannot drift. Whoever later adds a real migration: the step field is `transforms`, not `ops`
   (`src/core/migrations.ts:58`).
2. **Adopted as stated.** Effects stay `flags.pf1e` payloads; core's `flags.core.duration` keeps ticking;
   the round-start variant arrives as a wrapper transition, not a `core/combat.ts` edit.
3. **Revised — and the original proposal was wrong.** `worldSettings` and the round clock do **not** go on
   `WorldsRecord` (`src/storage/idb.ts:41`): that record is the local host's row and is not replicated, so
   players would buff against a clock they cannot see. They live in the `settings` collection that already
   exists but had no reader or writer (`src/core/documents.ts:314`), as one document `_id="world-settings"`,
   which `projectWorld` replicates at `ownership.default = LIMITED` (`src/core/projection.ts:138`).
   Not to be confused with `idb.getSetting/putSetting` (`src/storage/idb.ts:189`), which are app-local.
4. **Adopted as stated.** Fireball is 20 ft (the pack, i.e. the SRD); the sim's 15 ft and the invented
   scatter are filed in `DEVIATIONS.md` in P5 — deleted or justified there, not left to diverge.
5. **Adopted as stated.** Order A→B→C: sheet before tracker, because the tracker's context menu needs
   something to act on.
