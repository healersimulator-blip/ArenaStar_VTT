# Hosted strategic spell-hazard fidelity

This work follows the strategic product principle: **strategic mode is the full VTT operating at
formation scale, not a reduced battle service**. See
[STRATEGIC_FULL_VTT_DESIGN.md](STRATEGIC_FULL_VTT_DESIGN.md). Spell definitions, resources,
action cards and authored FX are shared PF1e content; only target enumeration and dense state
storage are scale-specific.

Reference reviewed: `Examples/combat_resolver_5.html`, especially C5/C13/C14/C15, B8/B11 and the
round loop around `burnTick`, `tentaclePhase`, `fleeHarm`, `clampTargetOutOfHarm`,
`harmDetourPoint`, and `moveAvoidingHarm`.

## Implemented in the hosted frozen resolver

- Frozen active intervals (`startsTurn` through inclusive `expiresAfterTurn`) and replay-stable
  per-model dice streams.
- Entangle/Burning Entanglement Reflex saves, including natural 1/20.
- Burning Entanglement's 2d6 normal / 4d6 already-entangled tick and half damage on a save.
- Black Tentacles CMB `caster level + 5` versus CMD; retained holds get +5 and 1d6+4 constriction.
  Caster-faction models are excluded when a caster faction is supplied.
- Hazard-owned grapple state is separate from ordinary creature grapples, so spell expiry cannot
  clear an unrelated grapple.
- Entangled/grappled Dexterity penalties affect AC, touch AC, and Reflex; both impose attack
  penalties in the shared PF1e attack engine, including opportunity attacks.
- Entangled formations have half movement. Tentacle-grappled formations cannot translate before
  escaping the hold.
- Active areas are difficult terrain and entered squares cost double through the existing PF1e
  stride pricer.
- A formation starting inside harm flees to the nearest safe rim first. Unsafe goals are clamped;
  crossing paths get deterministic same-side outer waypoints; overlapping areas are processed
  independently; stable routing prevents ping-pong.
- Clearance includes the farthest living formation slot, not only the anchor. Expired areas vanish
  from saves, movement costs, and routing, allowing the formation to return/reform.

## Existing systems retained (better than duplicating the HTML implementation)

Unit attacks continue through the production PF1e engine: iterative attacks, natural 1/20,
critical confirmation, ranged increments, cover, AC types, DR, conditions, attacks of opportunity,
flanking/envelopment, walls, casualties, and deterministic substreams. Hazard conditions are inputs
to that same engine rather than a parallel simplified attack routine.

## End-to-end PF1e spell & hazard integration (implemented)

Shared PF1e spell projection (`src/core/strategicRoom/pf1eActionProjection.ts`) and campaign
actor/spellbook projection (`src/core/strategicRoom/campaignScene.ts`) now connect authored PF1e
actors, prepared/spontaneous spell slots, validated `ActionArea` geometry, host-owned saving throw
DCs, action cards, `HostedFxCue`s, persistent hazards, and campaign slot write-back end to end
across 7 shared PF1e spells (`STRATEGIC_SPELL_CATALOG`):

- **Persistent area hazards:** `entangle` (circle 40 ft, 1 min/level), `burning-entanglement`
  (circle 40 ft, fire tick + Reflex save), and `black-tentacles` (circle 20 ft, CMB `CL + 5` vs
  CMD grapple + `1d6+4` constriction).
- **Instantaneous formation blasts:** `fireball` (circle 20 ft, `min(CL, 10)d6` fire, Reflex half),
  `burning-hands` (15-ft cone, `min(CL, 5)d4` fire, Reflex half), `lightning-bolt` (120-ft line,
  `min(CL, 10)d6` electricity, Reflex half), and `cone-of-cold` (60-ft cone, `min(CL, 15)d6` cold,
  Reflex half).

Commanders select projected spells on their unit card, preview the circle/cone/line template on the
strategic canvas, submit `cast` orders validated for control, range, line-of-effect (including live
door states), and remaining slots, see unit-level `ActionCard`s and FX cues on publish, and
reconcile expended spell slots back to the campaign `ActorDocument` on battle finish (with
single-step GM undo).

