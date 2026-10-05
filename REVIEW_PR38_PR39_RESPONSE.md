# Review response — PR #38 / PR #39, executed 2026-10-05

This is the disposition record for `REVIEW_PR38_PR39_2026-10-05.md`. It states the user's decisions,
what was changed for every numbered finding, and the evidence. Decision record: **D-406** in
`DECISIONS.md`. Plan status: `CONDITION_EFFECT_REVERT_GAP_AND_PLAN.md` §4.

## 1. The user's decisions, as implemented

| Directive (2026-10-05) | Implementation |
| --- | --- |
| Panicked is behavioural; treat it as GM-mediated and do **not** add a cast-while-fleeing exception | `Panicked`'s payload is unchanged in substance (deny list still refuses `cast-spell`) and its `notes` now say the simplification is deliberate and a GM adjudicates escape spells. No code path was added. |
| Poison is a **rider** of a landed attack or an applied spell, able to connect to other entity-to-entity interactions | `ActionTarget.riders` (card v2) + `pf1e.poison` `rider: { actionId, targetKey }`; the host re-reads the delivering card and accepts a landed row of either an attack (`hit`) or a cast (`failedSave`/`affected`), so the mechanism is generic to the interaction rather than poison-specific. The shipped producer is the attack line's `poisonId`; a spell-side producer is contract-ready but not yet wired (open item 6). |
| D-405 must be done properly: part of the action card, pending roll for a player victim, Revertable | Delivered on the card; a player-owned victim's save is a host pending roll the victim rolls from the card through the ordinary commit-reveal path; the exposure's receipt Revert restores the rider row, the pending offer, the course and the ability damage. Covered in `tests/host/pf1ePoison.test.ts` (rider block) and `e2e/pf1e_poison.spec.ts`. |
| Allowing self-attributed manual condition tags is OK **if** the GM is told who added what | The typed `pf1e.condition` action posts a chat record naming the acting client, the condition and the actor alongside its receipt; the generic-op path may only add/remove the caller's own `source.kind:"manual"` tag and posts a GM-visible audit line naming the client and every changed condition. Everything else on that path is refused by name. |

## 2. Findings D1–D11

| # | Finding | Disposition | Where |
| --- | --- | --- | --- |
| D1 | Panicked refused escape casting | **Accepted as deliberate** (user decision), documented in the definition's notes; no behaviour change | `src/packages/pf1e/conditions.ts` (`Panicked` notes), D-406 |
| D2 | Poison had no producer/UI/e2e | **Fixed** — attack-line `poisonId` → rider on a landed strike; attack editor select; ActionCard rider rows with a Roll button; new browser spec | `src/ui/sheets/pf1eResolveFlow.ts`, `PF1eAttackEditor.svelte`, `src/ui/chat/ActionCard.svelte`, `e2e/pf1e_poison.spec.ts` |
| D3 | Poison/conditions bypassed the D-405 action system | **Fixed for deliveries** (rider on the delivering card, host-verified attach, deferred save, Revert) and **conditions now have a visible record**: the typed action commits its actor diff, a chat record and a receipt in one envelope. A standalone GM exposure with no delivering interaction still writes its own audited message + receipt, because there is no interaction to attach to. | `src/host/sync.ts` (rider context/attach/continuation, `conditionMessageOp`), `tests/host/pf1ePoison.test.ts` |
| D3b | Rider-save authority: host-rolled vs player-rolled | **Decided and implemented** — player-owned victim ⇒ host pending roll (commit-reveal, rolled by the victim); GM-owned NPC ⇒ host-rolled. "Player-owned" = an ownership entry other than `default`/system user at level ≥ 1, so GM-owned NPCs are never deferred | `src/packages/pf1e/pendingRoll.ts` (`isRiderSave`), `src/host/sync.ts` (`poisonSaveDeferred`) |
| D4 | Generic-op guard | **Closed to one narrow, audited case**: the caller's own manual tag only, no mechanics, no foreign attribution, existing instances immutable, poison state host-owned; every change logs a GM audit line. Dead/contradictory error text removed | `src/host/sync.ts` (`validateOps`), `tests/host/pf1eConditionAction.test.ts` |
| D5 | Deafened's −4 on opposed Perception missing | **Fixed** — Blinded and Deafened share the printed −4 and never stack (one penalty); tests pin the boundary | `src/packages/pf1e/stealthPerception.ts`, `tests/packages/pf1eStealthPerception.test.ts` |
| D6 | Fear/sickened notes claimed "no mod keys" while `skills`/`skill.<id>` exist | **Fixed** — Shaken, Frightened, Panicked and Sickened carry their skill penalty on the general `skills` mod key; notes now say only the ability-check half is caller-owned | `src/packages/pf1e/conditions.ts`, `tests/packages/pf1eConditions.test.ts` |
| D7 | `removal:{kind:"expiry"}` validated but consumed nowhere | **Refused by name** until Phase 4 lands the sweep, so nothing records an expiry that never happens | `src/packages/pf1e/conditionApplications.ts` |
| D8 | Poison conditions tracked in two channels | **One channel** — the course's `activeEffectIds` is the bookkeeping the cure/expiry transitions read; the application records how it is removed (an explicit host action), not a duplicate event label | `src/host/sync.ts` (`poisonEffectPlan`) |
| D9 | Poison catalogue was code, not data; bestiary/statblock carry no poison | **Partially fixed** — profiles are source data in `poisonCatalogue.ts` mirrored by the declared `PF1e Poisons` items pack, pinned profile-for-profile by a test; the `creature-derived` DC formula is implemented and unit-tested. Still open: a shipped `creature-derived` fixture and statblock→poison import | `src/packages/pf1e/poisonCatalogue.ts`, `systems/pf1e-core/packs/poisons.json`, `tests/packages/pf1eContentPacks.test.ts` |
| D10 | Phase 2's producer set untouched | **Split and annotated** — 2a (manual conditions) landed; 2b (trip/overrun, Dirty Trick, grapple, Dying/Stable, first aid) remains and the plan/status/TODO all say so | `CONDITION_EFFECT_REVERT_GAP_AND_PLAN.md` §4, `PF1e_Unified_TODO.md` |
| D11 | Red gates, no browser coverage | **Green** — lint 0, typecheck 0, unit 5,006 passed / 12 skipped / 0 failed, build within budget, new poison spec 2/2, the casing-broken concentration spec fixed | Evidence below |

## 3. Evidence (all executed)

- `corepack pnpm exec tsc --noEmit -p tsconfig.json` — exit 0.
- `corepack pnpm lint` — exit 0 (the nine review-listed errors are fixed).
- `corepack pnpm exec vitest run` — **342 files / 5,018 tests: 5,006 passed, 12 skipped, 0 failed**;
  the player-pending rider test also ran six consecutive green times after it was changed to wait for
  the resolved state instead of a fixed number of microtask flushes.
- `corepack pnpm build` + `pnpm size` — `dist/index.html` **4,342,279 raw / 1,237,964 gzip bytes**
  (within the 6 MB budget), SHA-256 `5e07353c4a10fb6e6d403030f7802ece8db7491b77fce77e8bd75222552bcbdb`.
- Browser (Chromium via the D-222 recipe over `file://`): `e2e/pf1e_poison.spec.ts` **2/2**;
  `e2e/pf1e_concentration.spec.ts`, `e2e/action_revert.spec.ts` green. `e2e/quickbar.spec.ts` still
  fails at `[data-slot]` — one of the 18 reproducible pre-PR failures recorded in the review, not
  attributable to these changes.

## 3a. Follow-up executed 2026-10-06 — D-407 (the Entangle slice)

After the analysis (`ANALYSIS_ENTANGLE_SCENE_READINESS.md`) the user authorised **S1 + S2 + S5a**, and
answered three questions the analysis raised: the FX cue should support **both** an item binding and a
new spell-keyed binding; the (later) cadence slice follows **RAW** (break-free move action, not a
generic per-round save); and a player character must be able to put **normal spells on the hot bar**.
What landed, on top of the table above:

- **Authored tactical spell effects (S1).** `src/packages/pf1e/spellEffects.ts` +
  `system.tacticalEffect` on `packs/spells.json`, pinned by a pack-mirror test. Entangle's printed
  line is corrected in place (long range, 40-ft.-radius spread, 1 min./level (D), Reflex partial, SR
  no, no `witch`, DF added) and its unmodeled halves are named in the pack's `automationNote`.
- **Spell→condition rider producer (S2).** `pf1e.condition` gained the optional
  `spell: { effectId, actionId, targetKey }`; the host re-reads the card, re-checks the row's outcome
  against the catalogue row, derives the source and attaches a `condition` rider (new rider kind in
  `core/action.ts`). The cast flow's client producer fires after the commit; Revert removes the
  condition and the rider together. Seven new host tests, eight cast-flow tests, a catalogue validator
  suite and the pack-mirror pin cover it, including every way a client can lie about the row.
- **FX (S5a).** `fxSpell` — a timeline bound to a **spell** by catalogue id — with host validation,
  an FX-wizard "Bind to a spell" panel, and `castSpellCueNote` fired post-commit from the sheet cast
  (which previously played no cue), the item window and the hot bar.
- **Hot-bar spells (S6, minimal).** A fourth quickbar kind, `spell`, offering only the prepared rows
  the catalogue authors and casting them through the same flow as the sheet.

**Gates after the follow-up:** tsc 0 · lint 0 · `pnpm test` **342 files / 5,046 tests: 5,034 passed,
12 skipped, 0 failed** · build **4,360,575 raw / 1,242,368 gzip** · **browser specs executed** via
D-222's recipe (`@sparticuz/chromium` over `file://`), including the scene's new spec
`e2e/pf1e_entangle.spec.ts` **2/2** and the surrounding set (`pf1e_poison` 2/2, `quickbar` — the
`[data-slot]` failure in §3 is fixed, `pf1e_spell_slots`, `pf1e_inventory`, `pf1e_acceptance`,
`parity`, `fx_item_binding`). `pf1e_cast_flow` (3), `pf1e_touch` (3), `pf1e_pending_cast` (1) and
`pf1e_wizard_combat` (1) fail **identically at base `95ba883`** (verified in a clean worktree): the
version-2 cast card no longer prints the old "casts <spell>" narration line in the chat log. That is a
pre-existing gap of the card-rendering slice, named here rather than counted as this slice's work.

## 4. Still open, named rather than implied

1. **Phase 2b producers** — trip/overrun, Dirty Trick, grapple branches, Dying/Stable and first aid
   are not yet named-Revertable (they still write the legacy path).
2. **Phase 3** — no card-level Revert control; the GM Revert panel covers every audited action.
3. **Phase 4** — condition expiry is refused, not implemented; the eight condition TTLs from the
   rules remain caller-owned.
4. **Poison content breadth** — one `creature-derived` fixture and statblock-imported poison
   definitions are not shipped; the pack currently carries the four cited Core profiles.
5. **Coverage dashboard / `DEVIATIONS.md`** — the Phase 8 status update documents this slice, but the
   dashboard pass has not been re-run with it.
6. **Spell-side *poison* producer** — the host rider contract accepts a cast card's
   `failedSave`/`affected` row as the anchor and D-407 now exercises that path with a **condition**
   rider, but no shipped spell declares a poison delivery (the *poison* spell is not in `spells.json`;
   its DC is the caster's, which the profile model cannot express today). This is Phase 5/6 work.
7. **Entangle scene remainders (S3/S4/S5b)** — area casting (one cast over a 40-ft. spread with a row
   per affected actor), the RAW cadence (break-free move action; end-of-caster's-turn re-save while in
   the area) and the condition↔FX teardown (stopping a persistent cue when the condition that started
   it is removed) are **not** in this slice and remain the scene's open half. A browser spec for the
   scene itself is also unexecuted in this environment (no browser download).
