# Authored hosted strategic battle plan

## Product principle

**Strategic mode should be the full VTT operating at formation scale, not a reduced battle
service.** See the canonical [full-VTT strategic design](STRATEGIC_FULL_VTT_DESIGN.md).

A GM-authored strategic scene remains the same campaign scene and rules environment when hosted. The
service uses a signed, versioned, permission-filtered projection for durability, privacy, replay and
scale; that projection must preserve all battle-relevant campaign documents and behavior rather than
replace them with an unrelated schematic room.

## Current vertical slice

The implementation currently proves only an incremental foundation:

1. **Battlefield art transfer** — a bounded, content-addressed PNG/JPEG/WebP background is included
   in the signed launch deployment, validated, persisted, served from a same-origin endpoint, and
   rendered beneath hosted markers.
2. **Authored token deployment** — visible friendly/hostile scene tokens can seed hosted companies.
   Token centers become five-foot anchors and disposition supplies the initial faction. Army
   documents remain the richer source where present.
3. **Authority and control** — commander seats use durable membership, invitations, explicit unit
   grants, revocation, allegiance administration, frozen orders and reconnectable publication.
4. **Formation-scale simulation** — compact checkpoints can resolve thousands of models while
   retaining deterministic retry and permission-filtered views.
5. **Initial spell-area mechanics** — the frozen resolver can represent persistent Entangle,
   Burning Entanglement and Black Tentacles effects. The player-facing cast must ultimately originate
   from the regular PF1e item/caster/resource/action-area workflow, not separate scenario authoring.

These are implemented capabilities, not the intended boundary of strategic mode.

## Required battle projection

Launch/freeze must grow into a transitive projection of every relevant source revision:

- scene, map, grid, walls, doors, terrain, elevation/floors, lighting, vision and persistent
  templates/regions;
- factions, armies, units, tokens, actors/profiles, items, attacks, spellbooks and resources;
- conditions, active effects, initiative, targeting, reactions and pending action state;
- relevant journals, roll tables, macros, playlists, FX bindings, package content and assets;
- ownership, unit grants, visibility policy, rules versions, seed and model checkpoint.

The projection is least-privilege: unrelated private campaign content stays out and player views are
filtered. Relevant content must not be stripped merely because the first scenario schema lacks it.
Every projected type needs validation, bounded payloads, provenance, revisioning and explicit
unsupported-feature diagnostics.

## Shared rules, formation-scale adapters

Strategic mode must execute the same PF1e content definitions used by ordinary scenes. Different
storage is allowed; duplicated gameplay meaning is not. For example, regular Entangle supplies its
item, slot expenditure, range, radius, duration, DC, save, condition, action card and FX. The
strategic adapter changes affected-token enumeration into affected-model enumeration and freezes the
persistent area for replay. It does not create a second strategic spell.

The same rule applies to attacks, saves, reactions, movement, conditions, terrain, walls, vision,
items, active effects, macros and future systems.

## Synchronization and write-back

Hosted launch is not intended to remain a one-way import:

1. Freeze exact source revisions and references.
2. Resolve all mutations with document/action provenance.
3. Synchronize authorized in-battle edits and effects through explicit commands.
4. On finish, show a conflict-aware GM reconciliation preview.
5. Apply accepted casualties, resources, conditions, movement and other consequences as one
   auditable, undoable campaign transaction.

The current aggregate survivor record is a pilot limitation. It must not be treated as the final
campaign integration contract.

## Current gaps that must remain visible

- Token fallback currently creates standardized melee companies instead of preserving complete actor,
  item, effect and resource semantics.
- The hosted room does not yet project the complete scene graph or expose ordinary tactical editing.
- Hosted browser orders still have a narrow vocabulary; regular PF1e spell/action controls are not
  yet connected to formation-scale resolution.
- Walls, doors, floors, lighting, vision, authored terrain, templates, journals, tables, macros,
  playlists and complete FX/content dependencies are not yet carried through the hosted projection.
- Finish records aggregate results rather than an undoable campaign reconciliation.

These are technical debt and release limitations—not deliberate product exclusions.

## Implementation plan and sequencing

Work proceeds as vertical slices; every slice carries source provenance, authority, frozen replay,
filtered views, UI and browser acceptance rather than landing a server-only duplicate mechanic.

### Phase A — battle projection foundation (in progress; first geometry slice implemented)

1. Add a signed/versioned projection manifest with stable source references, source revisions,
   dependency hashes, visibility classes, rules/package versions and bounded payload declarations.
   **Started:** campaign launches now include a strict `arenastar-battle-projection-v1` manifest with
   world/scene identity, frozen `DocumentStore` sequence, system/version and a SHA-256 digest over the
   normalized scenario payload. Import rejects payload/manifest tampering. Per-dependency hashes and
   visibility classes remain next.
2. Carry authored scene scale and movement/visibility geometry first: walls and doors, difficult
   terrain, floors/elevation, lights/vision, regions and measured templates.
3. Feed projected geometry into the same `RulesContext` used by local PF1e simulation and render it in
   hosted clients. Never reduce a rejected dependency to an empty field silently.
4. Add launch, parser, frozen-retry, visibility and browser tests for each projected type.

**First implementation slice — implemented:** authored source-scene walls are converted from scene
pixels to battlefield feet with their compiled move/sight/sound/light restriction mask; difficult
cells retain authored grid coordinates. Both pass strict count/bounds/shape validation, are frozen in
the hosted scenario, rebuild `RulesContext`, and affect the production resolver. Movement-blocking
walls clip whole-formation marches and difficult cells use the shared PF1e double-cost stride logic.
Campaign conversion, malformed-input, wall-blocking and terrain-cost regressions cover the complete
source-scene → validated projection → deterministic worker path.

### Phase B — actors, items and effects

1. Preserve source references and revisions for actor/profile cohorts, items, attacks, inventories,
   spellbooks, slots/resources, conditions and active effects. **Started for Entangle:** an Army
   unit's leader token resolves to its campaign Actor; the regular PF1e prepared/known spell rows,
   caster level, key-ability modifier and remaining level-one resource project into the hosted unit.
   Entangle now references the durable shared `pf1e-core-spells-entangle` compendium document identity
   instead of a temporary strategic item ID. The rest of the actor/item/effect graph, including
   per-dependency content hashes and revisions, still needs the general dependency format.
2. Derive model columns from those projected documents rather than standardized pilot profiles.
3. Synchronize authorized resource/effect mutations and surface exact unsupported-content errors.

### Phase C — shared actions and regular PF1e Entangle

1. Extend hosted commands with shared action-card intent, caster/item/resource references and
   target/template data; authority validates control, range, action economy and expenditure.
2. Adapt the existing host-verified PF1e Entangle cast into a frozen persistent `ActionArea`; enumerate
   strategic models instead of tactical token footprints while preserving the same DC, duration,
   condition, action card and FX. **Adapter foundation implemented:** `projectEntangleAction` accepts
   only a resolved regular PF1e Entangle `ActionCard`, requires host-proven Reflex DC evidence,
   converts scene coordinates using the authored grid, and derives the PF1e 1-minute/level frozen
   duration. It rejects renamed strategic substitutes and client-reported evidence. **Hosted cast
   path now started:** the strict room protocol accepts regular Entangle intent by projected item ID
   and origin; authority checks unit control, item ownership, remaining slots, bounds and PF1e long
   range; the browser exposes the cast only for projected casters; resolution spends a slot and
   publishes a duration-bearing area; PostgreSQL publications persist those areas across turns and
   restart; authorized baselines expose active areas and the hosted map renders their spell-colored
   radius. **Resolution adapter now connected:** a frozen hosted cast first produces a regular
   resolved `ActionCard` carrying actor/item provenance, a host-owned Reflex DC and the ordinary
   40-foot spread, then `projectEntangleAction` creates the dense persistent area; the resolver no
   longer carries a parallel radius/DC/duration hazard calculation. **Action durability started:**
   publication state retains an authoritative history bounded by both 64 cards and 128 KiB encoded
   card data, PostgreSQL stores/restores it,
   and admitted baselines expose it for shared card/FX consumers. Strategic Scene launch options let
   the GM independently enable cards for player characters/leaders, formation units, and individual
   models; model cards are off by default to prevent thousands of attacks from flooding chat/state.
   Disabling a card class never disables its rules resolution. **Hosted card presentation started:**
   admitted players now see the latest ten bounded cards in the hosted **Battle log / Chat and
   actions** window, rendered by the same shared `ui/chat/ActionCard.svelte` component as ordinary
   VTT chat—not a separate strategic card panel. Full shared chat chronology,
   targeting detail, authored FX, and campaign resource write-back remain to connect.
3. Apply the same adapter contract to attacks, saves, reactions, opportunity actions and subsequent
   spells. Remove scenario-authored spell rows as a player-facing substitute once migration exists.

### Phase D — presentation and campaign content

1. Project and entitlement-filter token/unit art, authored FX, sounds/playlists, journals, roll tables,
   compendium dependencies and vetted declarative macro capabilities.
2. Bring hosted scene editing, targeting, doors, floors, lighting and vision controls to feature parity
   using aggregation/LOD where scale requires it.

### Phase E — synchronization and reconciliation

1. Add revision-aware live synchronization for supported campaign edits during a battle.
2. Produce a GM reconciliation preview and apply accepted casualties, movement, resources, conditions
   and effects as one conflict-aware, auditable, undoable campaign transaction.

### Qualification

Qualify the complete authored workflow at realistic scale: 12 browser commanders, 3–5 units each,
50–120 models per unit, administration, engagements, regular PF1e spells, reactions, geometry,
perception, restart and write-back—not only generated rooms or schematic load fixtures. Separately run
the 500-commander/50,000-model performance matrix with every feature advertised for that tier.
