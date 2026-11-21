# Authored hosted strategic battle plan

## Product principle

**Strategic mode should be the full VTT operating at formation scale, not a reduced battle
service.** See the canonical [full-VTT strategic design](STRATEGIC_FULL_VTT_DESIGN.md).

A GM-authored strategic scene remains the same campaign scene and rules environment when hosted. The
service uses a signed, versioned, permission-filtered projection for durability, privacy, replay and
scale; that projection must preserve all battle-relevant campaign documents and behavior rather than
replace them with an unrelated schematic room.

## Implemented Full-VTT vertical slices (Phases A–E)

The implementation now delivers Phases A–E end-to-end across campaign projection, PostgreSQL
authority, deterministic PF1e turn resolution, live browser play, and conflict-aware campaign
reconciliation:

1. **Battlefield art & stitched multi-panel maps** — bounded, content-addressed PNG/JPEG/WebP
   backgrounds and 1–64 stitched floor-map panels (up to `5,000 × 5,000` squares) are included in
   the signed launch deployment, validated, persisted, served same-origin, and rendered beneath
   hosted markers.
2. **Signed dependency graph, geometry, doors, lighting & elevation (Phase A)** —
   `arenastar-battle-projection-v1` hashes participating `scenes`, `armies`, `actors`, `factions`,
   `journals`, `rollTables`, `playlists`, and `macros`, surfaces explicit `unsupported` diagnostics
   (such as `macro.script`), and projects interactive doors (`0 | 1 | 2`), walls, difficult terrain,
   darkness, point lights, vision modes, elevated `raised`/`stairs` regions, and measured templates.
3. **Derived PF1e actors, spellbooks, consumables & active effects (Phase B)** — leader/cohort
   actors project derived PF1e AC/saves/BAB/HP/weapons, active tactical effects (`readTacticalEffect`),
   7 shared PF1e area spells (`STRATEGIC_SPELL_CATALOG`), and charge-tracked consumables (`heal`,
   `bless`, `haste`, `shield`).
4. **Shared PF1e casting, item use & readied reactions at formation scale (Phase C)** — commanders
   aim and submit generalized `cast` (circle/cone/line), `useItem`, and `ready`
   (`enemyEntersReach` / `enemyCasts` / `allyAttacked` → `melee` / `shot` / `countermarch`) orders,
   producing host-provenanced `ActionCard`s, `HostedFxCue`s, persistent hazards, and durable
   slot/charge expenditure without per-model card floods at 10,000–50,000 models.
5. **Live VTT scene controls, scoped chat, dice, tables, playlists & vetted macros (Phase D)** —
   GMs toggle doors, darkness, hidden lights, measured templates, and playlist tracks live; players
   and GMs exchange `public` / `faction` / `gm` chat with host-rolled dice (`provenance: "host"`),
   read `<secret>`-stripped journals, roll shared tables, and run declarative macros.
6. **Conflict-aware reconciliation preview & single-step undoable write-back (Phase E)** — GMs can
   inspect a live `Reconciliation Preview` (`previewOnly: true`) without ending the battle, skip
   concurrently edited campaign documents (`skipConflicted`), apply casualties, positions, expended
   spell slots, item charges, conditions, door states, and darkness atomically via
   `HostSync.commitBattleReconciliation`, and revert or redo the entire battle write-back in one step.

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

## Remaining future extensions

Phases A–E now cover interactive doors, walls, difficult terrain, lighting/vision, elevated
`raised`/`stairs` regions, templates, derived PF1e actor/item/spell/effect projection, 7 shared PF1e
area spells, consumables, readied reactions, scoped chat/dice/tables/journals/playlists/declarative
macros, and conflict-checked undoable campaign reconciliation. Remaining future extensions beyond
this foundation:

- Sandboxed execution policy for arbitrary JavaScript `script` macros in hosted play (currently
  surfaced as an explicit `macro.script` projection diagnostic and disabled button reason).
- Multi-floor isolated level switching (`levels`) inside the hosted strategic canvas beyond
  projected `raised` and `stairs` elevation regions.
- Expanding `STRATEGIC_SPELL_CATALOG` beyond the initial 7 area/hazard/blast spells to arbitrary
  compendium buffs, summons, and single-target spells.

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

### Qualification (verified)

Verified across Vitest (`tests/strategicRoom/fullVttScale.test.ts`, including 500 commanders /
5,000 units / 10,000 models and PostgreSQL `StrategicAuthority` live-command + reconciliation
suites) and real multi-browser Chromium + PostgreSQL Playwright E2E (`npm run test:e2e:strategic`
and `npm run test:e2e:campaign`, 7/7 passing):

- `e2e/strategic_full_vtt_scale.spec.ts` — Full VTT Phases A–E: closed door LOS/charge blocking,
  live GM door open + SSE enemy reveal, lighting/darkness, `<secret>` stripping & GM journal
  filtering, faction-scoped chat + host-provenanced `1d20+5` roll, roll table, declarative
  `/order defend` macro + disabled script macro reason, live playlist, PF1e Fireball + Readied
  Countermarch, Wand of Cure Light Wounds, conflict-aware reconciliation preview (`skipConflicted`),
  atomic write-back of casualties/positions/spells/charges/doors, and single-step GM Undo.
- `e2e/strategic_actual_battle.spec.ts` — 12 browser commanders, 48 units, 3,840 models, live grant
  withdrawal/restoration, allegiance round-trip, attack/envelop/reform/hold orders, and paged report.
- `e2e/strategic_twenty_player_skirmish.spec.ts` — 20 browser commanders, 100 custom-badged
  50-model companies (5,000 models).
- `e2e/strategic_large_stitched_map.spec.ts` — `1,000 × 1,000` square stitched 4-panel map, 80
  commander seats, 600 units (12,000 models).
- `e2e/hosted_strategic.spec.ts` — 50,000-model compact view + crash/rejoin/revocation.
- `e2e/campaign_battle.spec.ts` — Campaign launch, play, resume, and finish.

