# The Entangle scene — what landed (D-407, 2026-10-06)

You asked for a table-testable scene: *a PC casts **Entangle** from its hot bar at an orc; the cast
fires correctly, the orc saves; a failed save means the **Entangled** condition **and** vines around
its token; a successful save means neither; and the state can be undone cleanly.* This is where that
stands now, what was ruled and built, and what is deliberately not in yet.

## 1. The scene, as it behaves today

| # | Step you described | Now |
|---|---|---|
| 1 | A **player character** places *Entangle* on its **hot bar** | **Yes** — the quickbar gained a fourth slot kind, `spell`. It offers the prepared rows the tactical catalogue authors ("Entangle (level 1) — cast at the selected target — REF DC from your spell DC, delivers Entangled"). A spell nobody authored is **not** offered: the bar never invents a save. |
| 2 | The cast fires **with the right DC**, as a card | **Yes** — the slot runs the same cast flow the sheet does, with the save and severity taken from the spell's own catalogue row. The card is a normal `cast` card (DC 15 for a Wis-18 1st-level caster in the test). |
| 3 | The enemy **saves**; **fail** ⇒ Entangled | **Yes** — the condition is applied *by the spell*: the application's source is `spell` (spell id + cast card + caster/item), it rides that cast card as a `condition` rider, and the chat record names the spell ("… applied Entangled on orc via Entangle"). |
| 4 | …and **vine FX around the token** | **Yes, for a committed cue** — an author binds a timeline to the **spell** (FX wizard → "Bind to a spell", new `fxSpell` binding). The cue is requested **after** the cast commits, at the caster's and target's tokens. |
| 5 | **Success** ⇒ no condition, no FX | **Yes** — a made save delivers nothing and the note says so in the spell's own words ("the spell has no cue for that outcome" — the failure branch, which is "nothing" unless you bound one). |
| 6 | Removal is **clean** | **Partly** — the card's own **Revert** removes the condition and its rider together (one receipt, nothing left behind). The scene's "successful save the following round" is **not** yet demonstrable: see §4. |

Undo/cleanup, as you ruled it: **RAW**, not a generic per-round re-save. The printed cadence is a
**break-free move action** (Str/Escape Artist vs the spell DC) plus a re-save at the **end of the
caster's turn while the creature is still in the area**. That slice (**S4**) is designed and ruled but
not built.

## 2. What changed in the tree

- **S1 — authored tactical spell effects.** `src/packages/pf1e/spellEffects.ts` mirrors
  `systems/pf1e-core/packs/spells.json` (`system.tacticalEffect`), pinned by a pack-mirror test.
  Entangle's printed line was corrected in place (long range, 40-ft.-radius spread, 1 min./level (D),
  Reflex **partial**, SR no, `witch` removed, DF added), and the halves the engine does not model
  (duration, area re-saves, break-free, difficult terrain) are named in the pack's `automationNote`
  rather than implied.
- **S2 — the spell→condition rider.** `pf1e.condition` took one optional field,
  `spell: { effectId, actionId, targetKey }`. The client names the catalogue effect and the card row;
  the **host re-reads the card**, requires a `cast` card whose named row is resolved and **landed by
  the effect's own save shape**, requires the condition to be one the effect applies, derives the
  source (spell, card, caster, item) from the card, refuses a second delivery from the same card, and
  attaches a `condition` rider (second `ActionRiderKind`). All seven ways a client can lie about the
  row are covered by `tests/host/pf1eSpellEffectRider.test.ts`.
- **S5a — both halves, as you chose.** (a) The existing item cue is now fired from **every** committed
  cast path — the sheet's cast form (which previously played no cue at all), the item window and the
  hot bar. (b) A new **spell-keyed** binding (`fxSpell`: a timeline bound to a spell by catalogue id,
  optional failure cue, recognition override, enabled flag), validated at authoring time by the host
  (the catalogue must ship the spell, the cues must be timelines the author can read, one timeline per
  spell) and authored in the FX wizard's "Bind to a spell" panel.
- **S6 — hot-bar normal spells, as you ruled** (*"Allow player character to place 'normal spells' to
  hot bar"*). Fourth slot kind `spell`; a stale binding is **named** ("the bound prepared row is gone —
  re-prepare and re-bind", "the bound row now holds X, not Y"), never silently rerolled.
- **Honesty fix found while testing:** when the catalogue says a save is required but the cast form
  asked for none, the flow now says so ("… but this cast asked for no save — no condition applied")
  instead of silently delivering nothing. The cue's skip sentence now speaks of the **spell**, not the
  item, on the spell path.

## 3. Evidence (all executed)

- `corepack pnpm exec tsc --noEmit` — **exit 0**.
- `corepack pnpm exec eslint .` — **0 errors**.
- `corepack pnpm exec vitest run` — **342 files · 5,034 passed, 12 skipped, 0 failed** (5,046 total),
  including the new host rider suite, the cast-flow producer cases, the catalogue validator and
  pack-mirror pins, the core binding rules and the hot-bar spell-slot cases.
- `corepack pnpm build` + `node scripts/size.mjs` — **4,360,575 raw / 1,242,368 gzip bytes**
  (budget 6 MB raw), SHA-256 `93b840f68f2cd747ee7f8a700cdfbdc1d423482298b8ac72d58f64beb6acccb0`.
- **Browser specs executed** through the documented D-222 recipe (the sandbox cannot reach the
  Playwright CDN; `@sparticuz/chromium` from npm works and `playwright.config.ts` already has the
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` seam):
  - **`e2e/pf1e_entangle.spec.ts` — 2/2** (new): the failed-save branch asserts the card row, the
    rendered `condition` rider, the condition's `spell` source, the cue note, a live FX instance on the
    Pixi stage that then drains, and that the card's Revert leaves neither condition nor rider; the
    made-save branch asserts no rider, no condition, no cue.
  - `pf1e_poison` 2/2 · `pf1e_spell_slots` 7/7 · `fx_item_binding` · `pf1e_inventory` ·
    `pf1e_acceptance` · `parity` · and `quickbar` — whose one failure the review recorded
    (`[data-slot]`, a stale selector) is fixed.
  - **Pre-existing, not mine:** `pf1e_cast_flow` (3), `pf1e_touch` (3), `pf1e_pending_cast` (1) and
    `pf1e_wizard_combat` (1) fail **identically at the base commit `95ba883`** (re-run in a clean
    worktree to be sure). They assert the old chat narration line ("casts Magic Missile"), which the
    version-2 cast card no longer prints. That is a gap of the earlier card-rendering slice, named
    here rather than quietly counted as green or as this slice's regression.

## 4. Deferred, by name (no half-implementations)

- **S3 — area casting.** One cast over a 40-ft.-radius spread with a row per affected actor, and the
  difficult-terrain half of "partial" (which the pack's `automationNote` says is unmodeled). Today a
  cast resolves one target.
- **S4 — the round cadence (ruled RAW).** Break free as a **move action** (Str *or* Escape Artist vs
  the spell DC), immediate save on entering the area (failure ends movement), and the
  **end-of-the-caster's-turn** re-save while still inside. This is what will make your "successful
  save the following round removes it" step demonstrable. **No** generic per-round save was built.
- **S5b — condition↔FX teardown.** Stopping a *persistent* cue when the condition that started it is
  removed (the run handle). Today the cue is a committed one-shot; the condition leaves with the
  card's Revert, but a looping vine timeline would not yet stop itself.
- **Poison side of the cast card.** The rider contract now exercises `cast` cards with a *condition*;
  a spell that *poisons* still has no shipped producer (the *poison* spell's DC is the caster's, which
  the profile model cannot express yet).

## 5. How to try it

1. Open the world, place a PC and a GM-owned NPC.
2. On the PC: Wis (or another key ability) high enough to cast, `spells.slotsPerDay` with level-1
   slots, and `prepared: [{ name: "Entangle", level: 1 }]`.
3. GM Macros → FX → author a timeline → **Bind to a spell → Entangle** → **Save spell binding**.
4. Select the PC token, pick the orc in the quickbar's target select, bind **Entangle (level 1)** to
   slot 1, and press it. A failed save shows the card with the condition rider and plays the vines;
   the card's Revert in the chat's action history undoes it.

Decisions and the long-form rationale: `DECISIONS.md` → **D-407**; the scene analysis with its
step-by-step table: `ANALYSIS_ENTANGLE_SCENE_READINESS.md`; the review follow-up:
`REVIEW_PR38_PR39_RESPONSE.md` §3a.
