# Entangle test scene — readiness analysis

> **Status, 2026-10-06 (D-407).** The authorised slice landed: **S1** (authored tactical spell effects,
> `src/packages/pf1e/spellEffects.ts` + the corrected `entangle` pack entry, pinned by the pack-mirror
> test), **S2** (the spell→condition rider: `pf1e.condition`'s optional
> `spell: { effectId, actionId, targetKey }`, host-derived source, `condition` rider on the cast card,
> Revertable as one receipt), **S5a** (the item cue wired into every committed cast path **and** a new
> `fxSpell` binding — a timeline bound to a spell by catalogue id, authored in the FX wizard's
> "Bind to a spell" panel) and a minimal **S6** (a `spell` quickbar slot for the prepared rows the
> catalogue authors). **S3** (area cast), **S4** (RAW cadence: break-free move action, end-of-caster's-
> turn re-save) and **S5b** (condition↔FX teardown) remain deferred. The scene's browser spec now
> exists and passes (`e2e/pf1e_entangle.spec.ts` **2/2**: a failed save delivers Entangled + the bound
> cue and Revert undoes both; a made save delivers nothing and requests no cue), executed through
> D-222's `@sparticuz/chromium` recipe over `file://`. The step table and defects below are kept as the
> analysis that was delivered, not as a statement of the current tree.
>
> **Question.** Player character casts *Entangle* from the hot bar over an area containing a test
enemy (orc warrior): does the action card fire with the right DC, does the spell deliver the
entangled condition on a failed save (and no condition on a successful one), does the matching FX
appear around the enemy's token on a failed save only, and does a successful follow-up save remove
both the condition and the FX? **Can the sim do that today, or is something missing?**

**Answer (short).** **Not end-to-end today.** The card half of the scene is largely built — a v2
action card with the save DC, a host-rolled save for a GM-owned enemy, and a source-aware condition
store with Revert. The FX half is also largely built — authored timelines, token-following anchors,
persistent loops, item bindings with success/failure branches. What is missing is the **connective
tissue between them**: no spell authoritatively applies a condition, no round cadence removes one,
nothing links a condition's lifetime to an FX run, the hot bar cannot bind a prepared spell, and the
cast UI is single-target with no area payload. There are also three content defects that block the
scene regardless (the pack's Entangle data is *wrong*, there is no orc statblock, and the repo ships
no vine media asset).

A manual approximation is possible today (see §4), but it is half-right on both paths: the sheet cast
has the right DC and no cue; the hot-bar/consumable cast fires a cue but currently asks for no save.

---

## 1. The scene, step by step

| # | Scene step | Today | Verdict |
| --- | --- | --- | --- |
| 1 | A player character and an orc-warrior enemy exist | Actors/tokens/ownership all work; but the bestiary pack holds **40 mass-battle unit actors**, not monster statblocks (`systems/pf1e-core/packs/bestiary.json`, M16) — the orc must be authored by hand (sheet or e2e hook) | works, content gap |
| 2 | Cast Entangle **from the hot bar** | Quickbar binds attack lines, damage verbs and *castable consumables* only (`src/ui/quickbar/model.ts:31-61` docs, `:135-166` candidates; `run.ts:137-151` refuses a non-consumable). Prepared spells are explicitly out of scope there ("the corpus authors no spell blocks (D-259)") | **missing** for a prepared spell; a generated wand/scroll works |
| 3 | Action card with the correct DC | Sheet cast → `resolveCastFlow` builds a **v2 action card** with per-target rows, `check {kind:"save", formula, dc, total, saveType, passed}`, outcome and evidence (`pf1eCastFlow.ts:404-470`); DC is the derived spell DC `10 + level + key ability mod` (`:767`). Consumable cast uses the item DC (`consumables.ts:71-85` — e.g. DC 11 for a 1st-level scroll/wand) | works (sheet path), partial (hot bar path) |
| 4 | Spell fires over an **area** containing the enemy | The cast flow is strictly single-target; `context.area` is carried onto the card only if a caller supplies it (`pf1eCastFlow.ts:126-133`, `:416`) and no UI does — the sheet's own note says "area/target-count payloads (C05) are not yet part of this single-target flow" (`PF1eActorSheet.svelte:3616`). The area math and `affectedTokens` exist and are e2e-verified (`src/packages/pf1e/areaPreview.ts:1-12`, exposed only through the e2e hook at `App.svelte:3926`; `e2e/pf1e_targeting.spec.ts`) | **missing** (single target is the workaround) |
| 5 | Enemy rolls its save | GM-owned target: host-rolled inside `runSpellEffect` (save → SR → damage → HP write). Player-owned target: an F03 pending save card is created and "no damage or condition is inferred from the card" (`pf1eCastFlow.ts:1509-1575`, quote at `:1537`) — the effect continuation after a pending save is explicitly open (plan Phase 5) | works for the enemy scene |
| 6 | FX effect of entangle around the token | The FX wizard can author an image/video timeline that **follows the target token** and loops persistently (`src/core/fx.ts:765`, `:929`; `FxSequencePanel.svelte:2443` "Follow visible token anchors"), and can **bind it to an item** with success/failure branches (`core/fxBinding.ts:24-47`, editor at `FxSequencePanel.svelte:2526-2565`). The cue fires after the item use commits, pointed at the target token (`ui/sheets/fxItemCue.ts:111-141`). But: **no cue is fired from the sheet's cast path** (only the quickbar item cast `run.ts:137-181` and the item window `PF1eItemWindow.svelte:155-161` fire it), and the repo ships **no media assets** (no `public/`, no images/videos) — the vine asset must exist in the world's asset manifest | partial: wizard ready, wiring/asset missing |
| 7 | Failed save → **entangled** condition | No spell applies any condition. The library has `Entangled` with mods/denies (`packages/pf1e/conditions.ts:186-204`) and the application schema even models `source.kind:"spell"` and an `expiry` removal policy (`conditionApplications.ts:13-57`) — but the only producer, the typed condition action, hardcodes `source {kind:"manual"}` / `removal {kind:"manual"}` (`host/sync.ts:4154-4270`, source at `:4224`) and expiry is refused by name (`conditionApplications.ts:131-136`). Today the condition is applied by hand on the Effects tab (typed action, receipt, Revertable) | **missing** (manual workaround) |
| 8 | Successful save → no condition, no FX | Condition: nothing is produced anyway. FX: expressible today — bind the vine timeline as the item's own cue and leave "On a failed use" as "play nothing"; `fxCastOutcome` maps **a made save to `failure`** (`fxItemCue.ts:36-45`), so the default timeline only plays when the spell actually lands | works (given 6) |
| 9 | Next round: successful save removes condition **and** FX | Conditions have **no cadence**: only poison has a scheduler (`host/sync.ts:4650 sweepPF1ePoisonDue`, fired from clock/turn advance); nothing expires or re-saves a condition. Nothing stops FX when a condition goes away — FX stop exists (`fx.stop`/`fx.stopMatching` `core/messages.ts:58-70`; `api.fx.stop`/`stopMatching` `host/sync.ts:5405+`; panel stop `FxManagerPanel.svelte:34-77`) but no condition path calls it. Removal today = manual typed remove (Revertable) + manual FX stop | **missing** |

**Rules note (CRB p.278, AoN).** *Entangle* is **Reflex partial; see text**, area **40-ft.-radius
spread**, range **long**, duration **1 min./level (D)**, **SR: no**, and the whole area is difficult
terrain. An entangled creature does not simply re-save each round: it can **break free as a move
action** with a Strength or Escape Artist check **against the spell DC**; a creature that *made* its
save but stays in the area **saves again at the end of the caster's turn**; a creature that moves in
saves immediately (failure ends its movement and entangles it). The scene's "success on the following
round" is best modelled as one of those two mechanics, not a generic per-round save.

---

## 2. The four producers that are missing

1. **Hot-bar spell binding.** The quickbar's only item kind is a castable consumable
   (`quickbar/model.ts:135-160`); a prepared spell has no slot kind. A generated wand/scroll of
   Entangle *can* be bound — but generating one is itself broken for saves: `authoredSpellRows`
   reads `saveType`/`damageFormula` from prepared rows (`pf1eItemsTab.ts:489-517`) that never carry
   them (`packages/pf1e/actor.ts:204-217`), so `consumableCastAuthored` falls to
   `severity: "none"` (`consumables.ts:259-279`) and the scroll asks for **no save at all**. The
   sheet's cast form is the only place the save choices are authored today, and that path fires no
   cue.
2. **A spell→condition producer.** Nothing in `resolveCastFlow`/`runSpellEffect` applies a
   condition, and the typed condition action cannot express a spell source, a duration or a removal
   policy. This is also why the failure branch and the "no condition on a save" branch are
   half-implemented: the card knows the save result, the condition store never hears about it.
3. **Area casting (C05).** The math is already there (`areaPreview.ts`, `targeting.affectedTokens`)
   but no dialog places a template, collects the affected actors or resolves one cast against
   several targets with per-target outcomes. Everything downstream — per-target condition, per-target
   FX — is gated on this.
4. **Condition cadence and the FX link.** No turn/round sweep for conditions (Phase 4 keeps
   `expiry` refused precisely because the sweep does not exist), no break-free action, and no
   instance-level FX handle: even with a working stop API, nothing knows *which* run belongs to
   *which* condition instance, so removal cannot tear the FX down (and Revert could not restore it).

---

## 3. Content defects found while checking the scene

- **The pack's Entangle entry is not just descriptive, it is wrong** (`systems/pf1e-core/packs/spells.json`,
  id `entangle`): range "medium (100 ft. + 10 ft./level)" (CRB: long, 400 ft. + 40 ft./level);
  area "40-ft. square/level" (CRB: 40-ft.-radius spread); duration "1 round/level" (CRB:
  1 min./level, dismissible); "Reflex negates" (CRB: Reflex partial, see text); SR `true`
  (CRB: **no**); and it lists `witch 1`, which is not a class Entangle appears on. It also omits
  the DF component. This must be corrected before any automation is authored on top of it.
- **No orc warrior (or any tactical monster)** in the bestiary pack; the 40 entries are
  mass-battle unit mirrors. A scene enemy is hand-authored.
- **No bundled media**: FX image/video sections need an asset in the world's asset manifest, and
  the repository ships no image or video files, so "vines grappling its token" needs an asset
  imported first.

---

## 4. What can be demonstrated today (manual runbook, no code)

1. Author the druid (prepared 1st-level Entangle) and the orc (any stats; GM-owned) on the Actors
   tab; place both tokens on the active scene.
2. Author a **"Vines" timeline** in the FX wizard: an image (or short video) section with its anchor
   following the **target** token, marked persistent (loop until stopped).
3. Bind that timeline to the *item* that will cast the spell — the wizard's "Bind to an item" panel
   (`data-fx-binding-actor` / `data-fx-binding-item`, event `use`, failure branch left as
   "play nothing"). A binding needs a real item on the actor, so this only works for a
   wand/scroll/potion, not for a prepared spell row.
4. Cast through a path that fires cues: bind a quickbar slot to the consumable and press it with the
   orc selected, or cast from the item window. The card posts, the enemy's save is host-rolled, and
   the vine cue plays only when the spell lands.
5. Apply **Entangled** by hand on the Effects tab (typed action → receipt → Revertable).
6. When the orc breaks free / re-saves, remove the condition by hand and stop the cue from the FX
   manager ("Stop matching in scene").

**Honest caveats:** step 4's hot-bar/consumable path currently has no save authored for a generated
scroll (see §2.1), so in practice the GM must flip to the sheet cast to get the Reflex save — and the
sheet cast does not fire the bound cue. That is exactly the split this analysis is about: neither
available half does the whole scene.

---

## 5. Minimum work to make the scene work end to end

Ordered; each slice is independently verifiable.

- **S1 — Authored spell effects (content + schema).** Give a spell item a validated mechanical
  payload (save, severity, condition(s), duration/removal, area shape, re-save/break-free policy)
  and fix the Entangle entry. Mirrors the poison work: pack data + validation + pack-mirror test
  (`packages/pf1e/spellEffects.ts` new, `packs/spells.json`, `tests/packages/pf1eContentPacks.test.ts`).
- **S2 — Spell→condition producer.** Extend the typed condition action to carry an optional source
  (`kind:"spell"`, `itemId`, `actionId` = card id) and a removal policy, host-derived from the cast
  (never client-invented), applied only on a landed row and committed with the cast's receipt so
  Revert removes it. Reuse the D-406 rider pattern from poison: card row → host re-read → condition
  instance with `source`, chat record, receipt.
- **S3 — Area cast (C05).** Wire `pf1eAreaPreviewModel` into the cast dialog: place a spread, list
  affected actors, resolve one cast with **one target row per actor** on the same card (per-target
  outcome, condition and rider), keeping the slot spend single. This is also what makes the
  per-target FX cue correct.
- **S4 — Condition cadence.** Un-refuse `expiry` and add the sweep the poison scheduler already
  demonstrates (`sweepPF1ePoisonDue` precedent): round/own-turn boundaries, plus the Entangle
  break-free action (move action, Str/Escape Artist vs spell DC) and the end-of-caster's-turn re-save
  for those still in the area. Owned by the turn engine, not by the cast flow.
- **S5 — FX lifecycle.** Two halves: (a) fire the bound cue from the **sheet cast path** as well
  (today only quickbar/item window do), and (b) give a condition application an FX handle
  (an `fxRunId`/authored-cue reference resolved host-side) so break-free, expiry, manual removal and
  **Revert** start/stop the matching run. Play the cue from the same committed moment the condition is
  applied, not from the card's optimistic claim.
- **S6 — Hot bar prepared spells.** Either add a `spell` entry kind to the quickbar (needs S1 so the
  slot does not invent save/damage — exactly why D-259 deferred it), or keep the consumable route and
  fix it (S1's payload feeding `authoredSpellRows`, item vs caster DC stated on the slot).

**Smallest path to the scene as asked:** S1 + S2 + S5a (with a hand-placed single target from the cast
dialog and a manual or scripted break-free) gets card → condition → vines → removal. Full parity with
the described loop needs S3 (area) and S4 (cadence) as well; S6 is required only because the scene
says "from its hot bar".

---

## 6. Evidence index

| Claim | Where |
| --- | --- |
| Quickbar kinds / spell-through-item rule | `src/ui/quickbar/model.ts:24-30`, `:135-166`; `src/ui/quickbar/run.ts:137-181` |
| Cast flow card, DC, save, pending-save gap | `src/ui/sheets/pf1eCastFlow.ts:404-470`, `:767`, `:1509-1575` |
| Sheet cast fires no item cue; C05 note | `src/ui/sheets/PF1eActorSheet.svelte:1418`, `:3616`; grep `fireBoundItemCue` = only the attack path (`:930`) |
| Area model exists, e2e-only | `src/packages/pf1e/areaPreview.ts:1-12`; `src/app/App.svelte:3926` |
| Condition library / schema / refusal / manual-only producer | `src/packages/pf1e/conditions.ts:186-204`; `src/packages/pf1e/conditionApplications.ts:13-57`, `:131-136`; `src/host/sync.ts:4224` |
| No condition scheduler | `src/host/sync.ts:4650` (poison only) |
| FX binding branches and token anchors | `src/core/fxBinding.ts:24-47`; `src/ui/sheets/fxItemCue.ts:36-45`, `:111-141`; `src/core/fx.ts:765`, `:929` |
| FX stop APIs | `src/core/messages.ts:58-70`; `src/host/sync.ts:5405+`; `src/ui/macros/FxManagerPanel.svelte:34-77` |
| Entangle content defects | `systems/pf1e-core/packs/spells.json` (id `entangle`) vs AoN CRB p.278 |
| No monsters / no media | `systems/pf1e-core/packs/bestiary.json` (40 unit actors); no image/video files in-repo |

**Sources:** Archives of Nethys, *Entangle* (PRPG Core Rulebook p.278),
<https://www.aonprd.com/SpellDisplay.aspx?ItemName=Entangle>; conditions text already checked
against CRB p.565 (<https://www.aonprd.com/Rules.aspx?ID=413>) for the `Entangled` definition.
