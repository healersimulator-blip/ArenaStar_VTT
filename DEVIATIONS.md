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
| D-2 | Hard-coded Fireball order `radius: 15` (`massBattlePf1e.ts:170`) vs the shipped pack's **20 ft** | Fireball (CRB p.283): 20-ft.-radius spread; the pack's data is the agreed baseline | The strategic demo order does not match the content it claims to fire | P5 replaces the literal with spellbook/profile-driven orders; until then the literal stays **15 ft** and is reported here | **Decided (D-130): pack's 20 ft is the baseline; deviation is temporary until P5.** **CLOSED (D-151, 2026-09-11):** `parsePackSpellOrder` reads the pack's `massBattle` block, so radius/shape/save/dice are pack data; the DC comes from the shared `spellSaveDc`; and `tests/packages/pf1eSpellPacks.test.ts` asserts the in-code mirror against the shipped `spells.json`. C05 stays open on location, range and targets |

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
