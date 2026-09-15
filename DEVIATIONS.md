# DEVIATIONS — differences from the spec (target: none)

Any necessary deviation is proposed here first (per operating rule 1) with: spec section,
conflict, minimal change, and approval state.

R03 (2026-09-09, D-130) resolved the intentional variants. The active deviations the
code carries today are indexed here with their correction paths; the standing
strategic-vs-tactical scale trade-offs (AoO budget `1 + max(0, dexMod)`, published
saves vs ability-mod saves, generic vs special size ladder) remain recorded where they
were decided, in Gap List §10.2, with their P8 unification phases.

| # | Deviation | Spec section | Conflict | Minimal change | Approval state |
| --- | --- | --- | --- | --- | --- |
| D-1 | Strategic spell **scatter step** (`spells.ts`: every model inside a template is unconditionally moved 5 ft away from the epicenter and takes no damage if the step leaves the radius) | SRD Magic / AOE (no such rule anywhere; nothing lets a creature step out of a `fireball` before saving) | Invented mechanic; distorts AOE outcomes and silently moves units | Delete the scatter in P5: models resolve SR and the save **in their square**; `modelsScattered` metric removed with it | **Decided (D-130): remove.** Not an opt-in setting — it may return only as a named `worldSettings` toggle if a mass-battle consumer asks for it (none today); the rejected P0-toggle idea stays rejected. **CLOSED (D-151, 2026-09-11):** the scatter block is deleted, `modelsScattered` is gone from `PF1eSpellMetrics`, and a fixture puts a model 14.5 ft from the epicenter of a 15-ft blast — exactly where the old step pushed it to 15.5 ft and reported it as escaped |
| D-2 | Hard-coded Fireball order `radius: 15` (`massBattlePf1e.ts:170`) vs the shipped pack's **20 ft** | Fireball (CRB p.283): 20-ft.-radius spread; the pack's data is the agreed baseline | The strategic demo order does not match the content it claims to fire | P5 replaces the literal with spellbook/profile-driven orders; until then the literal stays **15 ft** and is reported here | **Decided (D-130): pack's 20 ft is the baseline; deviation is temporary until P5.** **CLOSED (D-151, 2026-09-11):** `parsePackSpellOrder` reads the pack's `massBattle` block, so radius/shape/save/dice are pack data; the DC comes from the shared `spellSaveDc`; and `tests/packages/pf1eSpellPacks.test.ts` asserts the in-code mirror against the shipped `spells.json`. **C05 remainder closed (D-164, 2026-09-11):** the point of origin rides the order, range is enforced from the pack's `rangeCategory` via the CRB p.213 formulas, and caster level / key modifier ride the caster's profile. |

**Live count as of 2026-09-11: zero.** D-1 and D-2 are closed above and kept in the table as a
record of what was carried and how it was removed. A new content discrepancy was found while
closing D-2 and is deliberately *not* filed here as a deviation, because it is a bug in our own
pack data rather than a divergence from the spec: `systems/pf1e-core/packs/spells.json` lists
Fireball at level 5 (CRB p.283: sorcerer/wizard 3), with range "100 ft. + 50 ft./level" (CRB:
long, 400 ft. + 40 ft./level) and a `target` line an area spell does not have. It is tracked in
`PF1e_Unified_TODO.md` §7 and in D-151, and it is inert: nothing reads the pack's `level` table,
since the DC is computed by `spellSaveDc` from a caller-supplied spell level.

Rejected outright in D-130 (inventions that will **not** be filed as deviations because
they are not deviations *from* anything — they are non-rules):

- **Overkill damage carryover** — SRD Cleave (CRB p.119) is a standard action: one
  attack at full BAB, then — if it hits — one additional attack at full BAB against a
  foe adjacent to the first, with a −2 AC penalty; it is not triggered by dropping a
  target and it never propagates leftover damage. `overkillDamage` stays an
  **analytics metric** (how much damage exceeded a model's remaining HP) and never
  applies damage to another model.
- **Total envelopment (+4 AB / flat-footed)** — SRD flanking is +2 melee with no
  flat-footing (A.14); there is no envelopment rule. The strategic geometry task now
  targets real flanking (threatened-square adjacency, opposite-side check, per-round
  set/clear) per Gap List §5.
- **Combat_Resolver_5 parity** is a metrics-compatibility reference for porting the old
  resolver's reports — it is not an SRD-fidelity claim and may not be cited as one.

## D-227 additions (2026-09-15, M01 / Gap §2.4–2.10)

- **DR `/epic` is refused, not approximated.** The CRB "Overcoming DR" ladder is now complete
  through +5/alignment, but `PF1eDrType` is a u8 and every bit is allocated (magic, cold iron,
  silver, adamantine, slashing, piercing, bludgeoning, alignment). No shipped content is
  mythic, so an epic form would cost a new column for zero reachable behavior. Add it with a
  column-widening decision if mythic content ever ships.
- **DR `/alignment` collapses the four alignments to one bit.** The CRB's +5 row treats
  "alignment" as a single rung, and the weapon side carries explicit good/evil/lawful/chaotic
  flags; a defender's DR names only "an alignment". Per-alignment defender DR (DR/good vs
  DR/evil) is not representable in the remaining bit space and is out of scope until content
  needs it.
- **Compound DR now requires every listed quality** ("magic and cold iron" stalls both a +1
  steel sword and a mundane cold-iron sword). Previously the first-match OR treated compound
  forms as satisfied by either half.
- **Mass-battle ammunition/weapon-state are per-model columns** (`ammo`, `weaponState`), so
  the UC p.135 explosion burst and the Gun-Training +2 misfire variant stay tactical-scale
  notes; the mass scale books the second misfire of a broken early firearm as weapon
  destruction (the same bit) — D-219's adopted variant stands.


## D-233/D-234 additions (2026-09-15, M15/M16 content coverage)

Content gaps that are **coverage limits of the R02 corpus**, not deviations from a rule: each is a
number the transcribed appendix does not carry, recorded here so nobody reads its absence as an
error in the packs. `tests/packages/pf1eContentPacks.test.ts` asserts the shape of every claim below.

- **Bestiary entries are unit-role mirrors, not published stat lines.** The Gap List appendices
  contain no creature entries, so the pack authors `size/HD/progression/saves-quality/ability
  modifiers/natural armor/armor/shield/speed/CR/attack dice` and derives BAB, saves, AC and touch AC
  from `rulesTables.ts` — the same tables the resolver uses. Transcribing a named creature's stat
  block from memory would be D-1-class invention; if a future slice buys a licensed stat block, the
  row shape already has a `mirror.derived` field for its citation.
- **No prices, weights or per-item armor numbers in the equipment pack.** The corpus's Appendix A.7/
  A.8 rows carry mechanics (damage, crit range, range increment, properties) but list cost and weight
  as `—`, and the CRB armor tables (max Dex bonus, armor check penalty, arcane spell failure,
  armored speed by armor category) were transcribed only as the *mechanical* effects. The eight
  shipped rows are therefore the tables the code reads; a shop, loadout or encumbrance feature needs
  those tables added to the corpus first.
- **Armored speed covers 30-ft and 20-ft base speeds only.** `PF1E_ARMORED_SPEED` is exactly
  `{30: 20, 20: 15}` — the two rows Gap List A.10 transcribes (human/elf 30 ft becoming 20 ft in
  medium or heavy armor, dwarf/gnome/halfling 20 ft becoming 15). `speedAfterArmor` **keeps the base
  speed** for any other value rather than extrapolating a halving, so a 50-ft creature in full plate
  keeps 50 ft until the CRB speed table is in the corpus; the equipment pack therefore carries no
  armored-speed row, because a row asserting an untranscribed case is the guess this file exists to
  prevent.
- **Feat prerequisites are descriptive.** `feats.json` names each row's prerequisite line as text, and
  only the handful `validatePF1eFeatSelection` checks are enforced; full prerequisite validation is
  P04-class work. The `automation` split is the honest statement of which feats change a calculation.
- **The initiative, mobility, defense and maneuver feats M16 names are catalogued, not implemented.**
  15 of the pack's 33 rows are `automation: descriptive` for exactly that reason: `Improved Initiative`,
  `Dodge`, `Mobility`, `Spring Attack`, `Combat Casting`, `Toughness`, the three save feats and the six
  maneuver feats have no rule that looks them up by name — initiative and AC bonuses are authored columns
  the sheet fills, and there is **no** bull-rush/disarm/grapple/sunder/trip mechanic at strategic scale
  (M11 records `cmbSuccesses` as having nothing to source it). They ship as searchable content with the
  reason in `mechanismSource`, which is what M15's descriptive/automated distinction is for; the alternative
  was a row whose `mechanical` block asserted an effect nothing applies.
- **Class rows carry no hit die, starting gold, or skill-rank budget.** The six starter classes publish
  BAB, saves, and the feat-granting levels derived from the shared ladders; the CRB class tables
  (Table 3-x) are outside the transcribed corpus, so those rows are `automation: descriptive` and say
  what a mass-battle consumer may actually read (proficiencies and the base attack/save progressions).
- **XP is authored for CR ≥ 1 only.** Bestiary rows publish `mirror.cr`; the corpus has no XP-below-CR-1
  ladder, so `precreateActorDocument` leaves `xp` at 0 for those rows instead of interpolating.
- **Descriptive spells are catalogued, not implemented.** 71 of the 75 rows are `automation:
  descriptive` with the missing mechanism named in `massBattle.notes`; the four automated ids
  (`fireball`, `burning-hands`, `cone-of-cold`, `lightning-bolt`) are exactly `PF1E_MASS_SPELLS`, which
  the content test asserts in both directions. The CRB's remaining combat-relevant spells are not rows
  at all, so the pack's size is a transcription budget rather than the engine's limit, and §6/P5's
  "~40 spells" ask is met by content that also says what it cannot do. `massBattleIntent` on the
  descriptive area rows records the SRD shape so the next C05 slice is a data diff, not archaeology.
