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

## Current integration gap—not a product boundary

The normal VTT already aims and resolves the regular 40-foot Entangle spread, verifies affected token
footprints host-side, applies saves/conditions, consumes resources and owns persistent FX. Hosted
hazard state is the dense, replay-safe representation of that same result; it is not intended to be a
second strategic-only spell definition or a scenario-authored substitute.

The missing adapter must carry the regular PF1e caster, item, slot/resource expenditure, validated
`ActionArea`, duration, action card, condition provenance and FX binding into the frozen hosted turn,
then enumerate affected models instead of tactical token footprints. Hosted controls and authority
must expose that ordinary cast. Campaign launch currently freezing scenario hazard rows and hosted
orders exposing only hold/march/attack are pilot limitations to remove.

Keep this gap visible in capability reports until a browser can cast regular PF1e Entangle in hosted
strategic play end to end. Do not describe the gap as intended scope or solve it by maintaining
parallel tactical and strategic spell semantics.
