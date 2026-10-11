# Multilevel scenes and enhanced walls, doors & windows

**ArenaStar VTT · design proposal · 2026-10-10**

**Status:** target design; implementation has begun. Native Faux Overhead/geometry and flat-scene endpoint/corner/split authoring slices are implemented and tested, and an isolated finite-height wall/surface collision kernel is now tested. GM-only embedded level drafts/editor/copy and draft archive/wire compatibility gates are also implemented. Explicit GM/API token membership and wall topology scopes now have atomic validation, private projection, copy and compatibility contracts; explicit assignment UI and a binding audit are implemented; navigation UI and physical activation remain pending. GM-only per-level fog persistence/diagnostics, light scopes and per-level ambient inheritance now exist; player-authorized level perception and vertical lighting remain pending. The kernel is not yet connected to live authority; the full multilevel/walls design is not complete. See [implementation status, usage and remaining gates](MULTILEVEL_IMPLEMENTATION.md). Existing save/cloud/zoom work is preserved.

**Companions:** [Ripper predecessor source review](docs/research/multilevel/RIPPER_PREDECESSORS.md) · [source audit and evidence](docs/research/multilevel/SOURCES.md) · [annotated snippets](docs/research/multilevel/SNIPPETS.md) · [machine-readable source pins](docs/research/multilevel/source-pins.json).

**Navigate:** [research](#2-research-what-to-learn-and-what-not-to-transplant) · [current architecture](#3-arenastar-baseline-and-integration-gaps) · [data model](#4-behavioral-contract-and-data-model) · [authority & physics](#5-authoritative-movement-perception-and-replication) · [Faux Overhead](#6-faux-overhead-and-rendering) · [wall tools](#7-walldoorwindow-authoring-and-interaction) · [migration](#8-fog-persistence-migration-and-portability) · [rollout](#10-implementation-slices-and-file-map) · [acceptance](#12-acceptance-plan).

## 1. Executive recommendation

Build **native, data-driven 2.5D scenes**, not a Foundry compatibility layer and not a separate scene for every floor. A single scene keeps its tokens, combat, automation and spatial coordinates while adding named levels, structural surfaces, elevation-aware barriers and per-level fog. Keep the existing single-floor path as the default.

Separate five concepts throughout the implementation:

1. **Level membership:** which logical floor a token or authored object belongs to.
2. **Physical geometry:** where its feet, head, walls, surfaces and openings actually are.
3. **Perception:** whether a particular observer can see/hear/illuminate a target through that geometry.
4. **Presentation:** which floor the user is editing/viewing, roof fading and Faux Overhead masks.
5. **Authority:** which facts/actions the host is allowed to disclose/accept for that user.

A display preference must never grant perception or bypass authority. A floor image must never be mistaken for a physical floor. A token visible through a balcony must not cause the entire building above it to disappear.

### Recommended scope

| Deliver incrementally | Deliberately separate/later |
|---|---|
| Named levels; per-level map art; deterministic elevation semantics | General-purpose 3D terrain, sloped meshes and volumetric physics |
| Floor/ceiling surfaces with holes; stairs and explicit level changes | Fully moving elevators/ships with attached passengers |
| Level-aware walls, movement, sight, lighting, audio and fog | Arbitrary nested region scripting or Foundry runtime execution |
| Faux Overhead with partial clipping and permission-safe ghosts | Image generation/inpainting of unseen artwork |
| Joined endpoint editing, snapping, split/join, freehand, drawing conversion | Automatic wall extraction from arbitrary map pixels |
| Regular/secret doors, lock state, windows, directional rules | Automatically resolving locks, breakage or climbing for every RPG system |
| Optional audit/build mode; one undoable edit per gesture | Continuous silent auto-repair of authored scenes |

**No new server requirement:** geometry, workers, rendering and authoring ship in the built standalone HTML. The GM tab remains authoritative; IndexedDB remains local storage. The optional cloud companion is unrelated to this feature.

## 2. Research: what to learn, and what not to transplant

### 2.1 Foundry V14 core

Foundry V14 shipped native Scene Levels, allowing vertically stacked maps inside one scene and assigning placeables to particular or shared levels. It also introduced supporting Region behavior for moving between levels and defining surfaces. This is distinct from the older third-party Levels module. [4](https://foundryvtt.com/releases/14.359)

The public [BaseLevel API](https://foundryvtt.com/api/v14/classes/foundry.documents.BaseLevel.html) demonstrates embedded Level documents with elevation bands and separate background/foreground art. The [Level API](https://foundryvtt.com/api/v14/classes/foundry.documents.Level.html) exposes elevation clamping that considers token depth. [Define Surface](https://foundryvtt.com/api/v14/classes/foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType.html) describes restrictions for light, movement, sight and sound. [Change Level](https://foundryvtt.com/api/v14/classes/foundry.data.regionBehaviors.ChangeLevelRegionBehaviorType.html) describes a token-entry level-change prompt. [Scene Regions](https://foundryvtt.com/article/scene-regions/) supports multiple shapes, subtraction holes and elevation ranges.

**Adopt the concepts, not the API:** embedded native records, explicit art/physics separation, level-aware object management, surface holes and a compact level navigator. ArenaStar chooses its own interval semantics, wire contracts and automatic stair UX below. Do not infer undocumented Foundry behavior from a method name or the older Scenes tutorial; our proposed half-open intervals are an ArenaStar decision, not a claimed Foundry implementation detail.

Foundry's [Walls documentation](https://foundryvtt.com/article/walls/) additionally distinguishes independent movement/sight/light/sound restrictions, terrain/limited walls, proximity/reverse-proximity windows, direction, door type and door state. The proposed richer barrier model supports those categories without reusing their numeric enums.

### 2.2 Baileywiki Better Levels, observed 2.0.14

The current product documentation describes level generation and a visibility matrix; Floor/Roof/Basement/Balcony setup; surface generation; stair helpers; build mode; and a 32-rule audit with grouped repair actions. Its Faux Overhead feature masks tokens beneath painted-in artwork without creating a tile. It includes partial occlusion, LOS-aware ghosts, hidden token decorations/targeting, region overrides, keep-lit and roof-like light occlusion. It also documents an experimental visible-token overlay that preserves covering floor art rather than exposing a whole building. [2](https://foundrymods.com/modules/baileywiki-better-levels)

**Evidence boundary:** product page, public manifest and dated changelog inspected. **Implementation source not retrieved:** the published ZIP endpoint returned HTTP 500 through the research tool; no public source repository was located. No shader, hook, algorithm or license is represented here as code-verified for Better Levels. Source review remains a specific follow-up, not a reason to invent its internals.

Particularly valuable regression lessons from its publisher-maintained changelog:

- **2.0.2:** Faux Overhead needed explicit enabled-level gating to avoid concealing tokens in a sealed basement at the same XY.
- **2.0.8:** keep-lit needed viewed-level gating to avoid clearing basement fog.
- **2.0.12:** cross-level ghost/outline presentation also needed correct targeting, HUD, decorations and GM viewed-level selection; light setup wording clarified that a blank light-level assignment was intentional in that module.
- **2.0.14:** advanced tile-role actions were confined to the open helper panel, avoiding ordinary-play toolbar clutter.

These are documented upstream regressions/UX choices, not independently reproduced failures. See the [publisher changelog](https://foundrymods.com/modules/baileywiki-better-levels).

**Our response:** explicit scope fields; independent perception/presentation masks; one token interaction model instead of duplicate interactive sprites; audit on demand; one coherent surface/cutout model rather than mirrored unrelated holes. Older July tutorials are useful orientation, but must not override October behavior or supply a guessed implementation.

### 2.3 Monk's Wall Enhancement, source inspected

Pinned repository: `ironmonk108/monks-wall-enhancement`, commit **79c722aef1cb772885ab28e8a267b5178c06fabe**, manifest **14.01**, verified/minimum Foundry **14**. The [source audit](docs/research/multilevel/SOURCES.md#monks-source-reading) records exact file ranges and hashes.

Code-level observations:

| Mechanism inspected | Useful idea | ArenaStar adaptation / caution |
|---|---|---|
| Capture exactly coincident endpoints when dragging starts | Maintain connected wall joints | Derived endpoint graph partitioned by level/height; local previews; one host transaction |
| Scan endpoints and snap to nearest within tolerance | Close tiny authoring gaps | Spatial index, CSS-pixel tolerance converted by camera scale, deterministic tie-breaks |
| Project double-click onto segment, shorten original, create second wall | Fast split without moving the line | One atomic envelope and inverse; protect door/trigger references; avoid zero-length pieces |
| Freehand point collection and recursive distance simplification | Fast cavern tracing | Bounded iterative simplification; explicit squared-distance units; preserve marked corners |
| Join nearby selected endpoints at an average position | Repair gaps | Snapshot-based bounded clusters; no transitive drift, repeated writes or cross-floor joins |
| Per-scene one-way-door interception and side-aware door controls | Useful one-way interactions | Typed direction policy shared by host collision, LOS and door authorization; do not copy its reversed-door convention implicitly |
| Drawing conversion followed by deleting source drawings | Reuse geometric authoring | Keep source by default; optional removal in the same undoable transaction |
| Resize adjustment, wall-off-scene and close-open-doors batches | Efficient bulk edits | Full affine transform, explicit floor scope, preview for destructive operations; preserve locks |

**Do not port the wrappers:** the module patches Foundry prototypes and has an `eval`-based fallback. Those are incompatible with our CSP/offline architecture. Do not reproduce its temporary mutation of persistent-looking wall objects or manually splice undo history.

**Licensing gate:** LICENSE is GPLv3; README additionally states Commons Clause and a Foundry EULA condition. This is not equivalent to an uncomplicated MIT/BSD grant. No upstream implementation or asset is committed here. Original design snippets and pinned source-reading references are provided instead, following [the repository adoption policy](tools/adopt/README.md). Having inspected source is not a claim of legally certified clean-room provenance.

### 2.4 Ripper's Levels and Better Roofs, source inspected

The user-supplied public repositories supply predecessor implementation evidence without needing the unavailable Baileywiki archive. Both default branches already target V14, so this review separately pins **Levels tag 6.1.0** (`17d4cfdd674b45e4abf4235416a23f889ba12163`) and **Better Roofs tag 3.0.0** (`df35cca8c73e7e8d420a81aada7b65c591c06d82`) for Foundry 13, plus V14 comparisons. Repository manifest version strings differ from tag labels; exact commit/file hashes identify the inspected source. See the [12 source-reading cards and pinned links](docs/research/multilevel/RIPPER_PREDECESSORS.md).

- **Better Roofs:** texture-derived sprites join a vision-mask container; linked roof tiles follow explicit occlusion sources. This is not region-based Faux Overhead. Take the group UX, but keep roof display, current sight and exploration independent. Replace nested tile scans and mutable sampled overlap checks with indexed groups and immutable geometry.
- **Levels:** sight rays intersect horizontal tile planes and finite-height walls; feet and eye height have distinct roles. A tile's `rangeTop` is not proof of an implemented ceiling plane. Target samples are an approximation, not swept-body collision or volumetric lighting.
- **Fog:** optional token bubbles and tile masks are presentation mechanisms. Per-level persistence uses auxiliary Scenes matched by names/ranges. ArenaStar instead needs token-only authorized overlays, stable compound fog keys and fenced asynchronous readbacks.
- **Stairs:** region handling can stop movement and continue remaining waypoints at the new elevation. ArenaStar must additionally revalidate the remaining path at the destination and commit transitions through host authority.
- **Migration:** V14 Levels is chiefly a native-level migration/region adapter plus an opt-in surface-collision wrapper, not the older complete runtime. Keep V13 and V14 importer fixtures distinct and preserve unknown data inertly.

Better Roofs has an inspected MIT license; no license grant was located in the inspected Levels trees/README, and its fog file has an additional core-code provenance concern. Neither is adopted into production. This static source review does not establish Baileywiki Better Levels internals or replace runtime acceptance testing.

## 3. ArenaStar baseline and integration gaps

These are findings from the current working tree, including the earlier uncommitted work—not assumptions about `main`.

| Existing surface | What it actually supplies | Required change |
|---|---|---|
| `src/core/documents.ts` | Token `elevation`; scene background and a foreground with elevation; embedded walls/tiles/regions. No level collection or token body depth | Add explicit levels, spatial scope, body/eye height and structural surfaces |
| `core/regionGeometry.ts`, `tileTriggerZone.ts` | Bounded convex local polygons and inclusive trigger elevation bands; bounded image-alpha masks | Add versioned multipolygon/hole geometry without changing legacy trigger semantics |
| `canvas/vision/wallKinds.ts`, `wallSight.ts` | Block/conditional/permit axes; regular door state; clear windows; one-way sight treated conservatively | New shared barrier evaluator; preserve existing numeric meanings |
| `core/movementPolicy.ts` | Center-line and swept rectangular-footprint collision; one-way treated two-sided | Height-aware swept collision; wire **all** move entry points. Existing use is in automation, not proof that every drag is already validated |
| `workers/vision.worker.ts`, `visionWorkerClient.ts` | 2D segment polygons with transferable arrays and sandboxed worker | Versioned 2.5D perception jobs plus an unchanged flat-scene fast path |
| `client/sceneLighting.ts` | Independently uses the light axis via a sight-segment adapter; stale-result rejection and fail-closed recomputation | Height/source-aware light propagation; retain separate light/sight policies |
| `canvas/stage.ts`, `layers/TilesLayer.ts`, `ephemera.ts` | Fixed layer order; below/above tile containers and overlap-based fading | Per-view render plan, physical elevation sorting and separate Faux Overhead masks |
| `core/fogExploration.ts`, `client/fogExploration.ts` | Client LOS/token display, currently 2D; scene-keyed caches | Level/eye/geometry revisions in cache keys; no cross-level reveal reuse |
| `storage/idb.ts`, `core/messages.ts`, `host/sync.ts` | Fog key is world/scene/user; wire fog messages contain no level ID | New level-keyed store/protocol/archive index and explicit legacy migration |
| `core/projection.ts` | Ownership/hidden filtering; non-hidden tokens are not generally LOS-redacted at transport level | Authoritative multilevel exposure view; hiding a sprite is not confidentiality |
| `core/store.ts`, `ops.ts`, `undo.ts` | Host-sequenced envelopes, inverse operations and rollback on apply failure | Stage new cross-document invariants before commit; do not replace with per-endpoint writes |
| `core/automation.ts`, `host/sync.ts` | Swept region events, deterministic ordering, door-state automations | Level-aware event paths; bounded transitions; legacy event compatibility |
| `core/sceneCopy.ts`, `assetUsage.ts`, `host/worldFile.ts` | Reference-remapped scene copying, media collection and portable world ZIPs | Remap level/surface/portal links, include level art, add fog keys and format capability gate |
| `app/App.svelte`, `app/JoinApp.svelte` | GM/player composition and existing canvas controls | Shared level-aware runtime; GM-only authoring, player-safe viewing and doors |

### Critical incompatibility: wall numbers

ArenaStar currently stores **`wall.door: 0=closed, 1=open, 2=locked`**, and conditional restriction axes identify legacy doors. Foundry's door *type* and door *state* are separate concepts. Never assign a Foundry `door` value directly to ArenaStar's `door` field. Existing ArenaStar window = sight/light permit and movement/sound block; do not silently convert every legacy window to proximity vision.

## 4. Behavioral contract and data model

### 4.1 Units, bands and stable identities

- XY remains scene pixels. New elevation/height fields use **scene distance units**, the units represented by `grid.distance`; conversion to pixel-equivalent distances is `z * grid.size / grid.distance`.
- Preserve existing numeric token/trigger elevations verbatim. Current comments say “scene grid units” without a comprehensive unit migration contract; do not silently multiply old data by grid size or 5. Confirm legacy importer conventions in phase M0 and show units explicitly in editors.
- Level IDs are stable, unrelated to names/order/elevation. Renaming does not move tokens. Changing height is an explicit plan with a choice to move assigned contents by delta or leave their absolute elevation and report conflicts.
- New membership bands use **[bottom, top)**. A shared boundary belongs to the upper band. `null` means an unbounded endpoint; JSON never contains Infinity/NaN. Creation UI uses finite floors; an open top is useful for roofs/exterior flight.
- First release rejects overlapping bands and zero-height bands, allows gaps only with an audit warning. Arbitrary overlapping XY districts with different elevation stacks are deferred; use one common level band or separate scenes.
- A level-less scene uses an implicit `base` level and the legacy rendering/physics path. The enable-levels plan provides an explicit base support plane over the intended map rectangle; additional upper floors require authored surfaces rather than invisible automatic full-scene support. Enabling levels creates a real base document and moves legacy fog only to that document, not every new floor.
- A token's **authoritative level ID and feet elevation are updated together**. Editing the viewed floor alone never moves any token. Flight/GM relocation must explicitly reconcile level membership when crossing bands.

### 4.2 Proposed schema sketch — not current interfaces

```ts
interface LevelDocument extends BaseDocument {
  type: "level";
  bottom: number | null;
  top: number | null;
  floorZ: number;                 // Finite default arrival/support height
  visibleLevelIds: string[];      // Directed eligibility, self included logically
  background: LevelArt | null;   // Hash/URL plus transform, as for scene art
  foreground: LevelArt | null;
  sort: number;                  // UI order, NOT physical elevation
}
type LevelScope =
  | { mode: "all" }
  | { mode: "levels"; ids: [string, ...string[]] };
interface SpatialFields {
  levelScope: LevelScope;         // Walls, tiles, regions, notes, drawings, etc.
  elevation?: number;
}
interface TokenSpatialFields {
  levelId: string;
  bodyHeight: number;
  eyeHeight: number;              // Offset above feet; explicit/system-supplied default
}
interface RegionShapeV2 {
  version: 2;
  components: Array<{ outer: Point[]; holes: Point[][] }>;
}
interface SurfaceBehavior {
  kind: "surface";
  planes: Array<{ z: number; blocks: Axis[]; supportsMovement: boolean }>;
}
interface TransitionBehavior {
  kind: "levelTransition";
  fromLevelId: string;
  toLevelId: string;
  arrival: { x: number; y: number; z: number };
  movementModes: string[];
  activation: "cross" | "interact";
  bidirectional: boolean;
}
interface FauxOverheadBehavior {
  kind: "fauxOverhead";
  coverZ: number;
  affectedLevels: LevelScope;
  concealment: "solid" | "slatted";
  lighting: "inherit" | "keepLitArt" | "occludeLight";
}
```

`SceneDocument.levels?` is an embedded collection. Add its collection/type to store resolution, references, permission/projection allowlists, schema validation, undo, scene copy and export. `LevelArt`, `Point` and `Axis` here stand for bounded, validated records—not arbitrary executable objects. Persist declarative typed Region behaviors; continue using automation graphs for scripted effects rather than embedding code strings.

**Defaults:** new objects are assigned explicitly to the active authoring level; “all levels” is a deliberate choice. Missing scope in a legacy flat scene means `base`; conversion previews scopes before enabling a stack. Empty level lists are invalid, never secretly “all”. Imported Foundry null/empty assignments require a format-specific adapter, not this native interpretation.

### 4.3 Geometry and surfaces

RegionShapeV2 represents the **union of components**, each component being its outer ring minus its own holes. Validate winding/canonicalization, self-intersections, hole containment, zero-area rings and bounded complexity. A hole in one component can be covered by a different overlapping solid component; audit that case rather than inventing global subtraction.

Use a shared CPU geometry kernel for containment, boundary classification, segment/ring intersections and swept events. Triangulated Pixi meshes/masks are derived caches, not world data. Keep the existing convex trigger geometry adapter for old regions; do not feed concave or holed rings into it unchanged.

A surface is **physical geometry**, not just a level visibility tag. Its planes block rays/sweeps that actually intersect its solid footprint at its Z. Viewing a different level must not disable a physical ceiling. Region authoring scope controls editing/presentation; a surface's physical effect comes from its explicit planes, footprint and restrictions, not from whichever floor the GM currently views.

Store a shared cutout once in the owning surface geometry. If a floor/ceiling assembly has two blocking planes, both refer to that same footprint; no manually duplicated stairwell holes that drift apart. A detached balcony is a bounded surface island, not a full-scene floor.

**No automatic physical inference from art:** transparent pixels may propose an outline, but the GM chooses Floor/Roof/Decoration. A rug does not become a load-bearing floor. Alpha tracing is optional, bounded and based on imported/hash-addressed media. External cross-origin or video sources without reliable readback use a visibly labelled rectangle/manual outline; never loosen CSP or assume an unreadable alpha mask is empty.

### 4.4 Barrier model: preserve compatibility, add explicit intent

Retain `wall.door` as the canonical legacy-compatible state for this implementation sequence. Add optional fields:

```ts
interface BarrierExtensions {
  levelScope?: LevelScope;
  zSpan?: { bottom: number | null; top: number | null };
  direction?: "both" | "positiveCross" | "negativeCross";
  portal?: {
    kind: "door" | "window";
    secret: boolean;
    openAxes: Axis[];
    interactionSide: "either" | "positiveCross" | "negativeCross";
  };
  perception?: Partial<Record<"sight" | "light" | "sound",
    { mode: "legacy" | "limited" | "proximity" | "reverseProximity";
      threshold?: number; attenuation?: boolean }>>;
}
```

One adapter resolves old numeric axes plus these fields into runtime barrier policies. All consumers use it. Do not let UI classification, sound, movement and vision invent their own door tests.

For walls without an explicit `zSpan`, derive the physical span from their assigned level bands; an all-level wall is unbounded. An explicit `zSpan` is authoritative physical geometry even outside the authoring scope, with an audit warning for surprising spans. Do not drop a tall blocking wall from ray queries merely because its editor tag differs from the observer’s level. New wall tools write the intended span explicitly.

- An **open operable portal** permits its configured `openAxes`; a plain wall never opens because its unused `door` number happens to be 1.
- Regular legacy doors retain all four conditional axes and closed/open/locked behavior. Secret is disclosure/interaction metadata, not another door state.
- Clear legacy windows retain their existing behavior. New presets distinguish **glass**, **proximity window**, **shuttered/operable window** and **curtain**. The preview lists all four axes; names do not substitute for policies.
- An operable window has an explicit portal kind; do not classify it as a door merely because an axis is conditional. Keep legacy `doorOpen/Close/Lock/Unlock` automation events for doors; introduce explicit window/barrier events rather than silently firing door-only graphs for windows.
- A sill/lintel is real geometry. Opening a window does not grant “walk through any Z”; retain blocking lower/upper spans and validate the opening against the token's swept body. Climb/jump rules are explicit system actions, not inferred from a click.
- Direction is defined by the oriented segment's cross-product sign in canvas coordinates. Preview an arrow; do not label signs left/right without accounting for downward-positive Y. Flipping endpoints must preserve intended world-facing restriction by flipping the direction value too.
- Limited barriers count distinct ordered intersections along a ray; a shared endpoint must not count twice. Proximity uses source-to-segment distance in declared scene units. Movement stays binary; attenuation applies only to sight/light, not as a fractional collision rule. Detailed attenuation curve is a documented ArenaStar policy and conformance fixture, not guessed Foundry parity.

## 5. Authoritative movement, perception and replication

### 5.1 One movement pipeline

Route drag, keyboard, waypoint paths, automation moves, stair traversal, script RPC and strategic-to-tactical placement through a shared host validation boundary. Keep trusted teleport/GM override as explicit capabilities, not “the caller sent a new Z”. Client previews can predict but never commit authority.

Process a requested move as:

1. Resolve authenticated user, ownership, movement mode, source position and document revisions.
2. Broad-phase query relevant wall prisms, surfaces, transition regions and occupied landing footprints.
3. Sweep the token footprint and vertical extent along **each path segment**, not just endpoints or the straight chord of a waypoint route. For changing rotation use conservative subdivision; the existing fixed-rotation hull is not a rotating-body solver.
4. Evaluate wall direction, portal state, elevation span and collision axis at intersection time. Test floor/ceiling planes and explicit support; avoid both tunnelling across thin regions and landing inside a wall.
5. Resolve transition crossings in deterministic path order, then region priority and stable ID. Only host-authored transitions can change the movement path/level automatically.
6. Revalidate the destination and commit position/elevation/level plus related permitted changes in one envelope. Reject with a local contextual reason if the world changed incompatibly.
7. Emit post-commit movement/region events once. Transition recursion is bounded and transaction-deduplicated.

**Stairs:** single unambiguous configured stair runs automatically without a GM approval popup. Multiple destinations/elevators use a player destination choice; it is not an authorization grant. Use explicit arrivals instead of blindly copying XY to the next floor. Pair return links explicitly. Suppress immediate re-entry until the token leaves the arrival zone; preserve suppression for the rest of that movement transaction and avoid firing on reconnect/import alone. A long move crossing multiple floors has a bounded transition count (initial proposal: 8) and rejects a cycle.

**Flying/falling:** flight can cross a level boundary only when the physical sweep is clear. Never snap a flying token to `floorZ` merely because its viewed level changed. Automatic fall simulation is deferred: an unsupported landing is rejected or offers a system/GM-authorized fall action. Walk-on surfaces and holes must nevertheless be correctly recognized from the first physical release.

### 5.2 Shared 2.5D query kernel

Represent walls as vertical segment extrusions and floors/ceilings as horizontal polygon planes. For ray `P(t)=A+t(B−A)`:

- At an XY wall intersection `t`, test the ray Z against that wall's span and then its axis/direction/portal policy.
- At surface height `h`, compute `t=(h−Az)/(Bz−Az)` and test the XY crossing against its footprint minus holes.
- Handle parallel/coplanar rays and exact boundary contact explicitly. Keep authoritative calculations in double precision with named epsilon policies; GPU float masks may conservatively hide an extra edge pixel but must not reveal sealed geometry.
- Source eye Z is feet elevation plus eye height, not a token's tile-sort index. Target visibility samples use an explicit body/footprint model, not only its center.

The old 2D polygon worker remains the fast path for level-less scenes and same-height configurations where its assumptions hold. **Filtering walls by the viewer's level alone is not a cross-level LOS algorithm.** Walls between the eye and a balcony target, ceiling planes and openings all matter.

For target-token authority, phase M2 uses a bounded set of defined body samples and returns a conservative boolean permission plus an optional visible silhouette. For terrain reveal, develop per-target-surface masks: project occluders onto that surface / use bounded adaptive ray masks with conservative edge treatment. Sparse point samples must not be interpolated into broad “visible” areas across unsampled walls. Exact mask strategy is a measured engineering spike, with sealed-floor leak tests as a release blocker. Until that passes, cross-level terrain stays covered while independently authorized tokens can use the ghost overlay.

### 5.3 Light, sound, combat and FX

- Light propagation uses the **light** axis and source Z. A visible-level list is not a replacement for roof occlusion. Model lamp placement independently from propagation; an untagged/broad-scope light still cannot shine through a sealed physical floor.
- Darkvision changes illumination requirements, not wall/ceiling penetration. Keep current system range adapters and perform all XY/Z distance conversions centrally.
- Host audio muffling uses listener/source elevation and the sound axis. Derive a player's listener from an authorized owned token; do not trust a client-supplied free position to listen on a hidden floor.
- Target selection, melee reach, ranged LOS, area templates, active zones, cover and measurement consume level-aware queries. Preserve system-specific diagonal/distance rules; do not silently make every spell a 3D sphere. Add an explicit template volume/level-scope policy; legacy templates remain on their converted base plane.
- FX inherit an explicit scene/level/Z and audience. Hidden targets must not leak through impact anchors, names, sounds, movement trails, auras, selection borders, minimaps or combat-list position badges. Cross-level visible targets may be displayed without disclosing their surrounding room.
- Geometry changes invalidate perception atomically; an opening/closing door animation is presentation after the authoritative state change. Reduced motion skips animation but not collision updates.

### 5.4 Replication is a separate deliverable, not a shader feature

Current projection filters ownership/hidden state, while ordinary LOS display is client-side. **Do not promise anti-cheat confidentiality from the existing fog shader.** For multilevel release:

- Maintain a host-side per-user exposure set, derived from owned/authorized viewers and shared geometry. Project secrets/hidden floors/tokens out before snapshots and deltas are sent.
- A visible-level matrix is spatial eligibility, not ACL: changing the client's viewed floor never authorizes a floor, asset, entity, note or door.
- On reveal, send the current projected document; on conceal, send a projected removal without deleting the host object. Visibility changes with no document mutation (e.g. another token moving) still generate ordered exposure updates.
- Existing operations replay against one authoritative sequence; add a distinct view revision for exposure updates and include it in snapshots. Never invent canonical world edits merely to hide an object from one user. Resync after stale/missing view revisions and invalidate cached hover/target state immediately.
- Geometry needed for local masks is a sanitized occlusion representation, not secret region behaviors, door names, trigger payloads or full hidden-token records. Anonymous coordinates can still reveal a hidden layout: when that geometry itself must remain confidential, compute the mask in the GM’s trusted worker and transmit the allowed result rather than sending hidden-floor wall/surface coordinates to the player. A secret door can project as anonymous blocking geometry; guessing its ID still cannot authorize its door action.
- Audit asset manifests, fetch authorization, preload jobs and reconnect/oplog replay alongside document projection. A client cannot be made to “unlearn” an asset it already received; do not advertise DRM or perfect map secrecy after legitimate disclosure. A monolithic background may inherently contain unexplored room art even when fog covers it.
- Host knows all, clients only their permitted view. Shared exploration/vision is an explicit future party policy, not an accidental union across all tokens on all floors.

**Release rule:** ship level authoring in a GM-only experimental mode if necessary, but do not enable player-facing hidden-floor claims until exposure handling, stale jobs and door authorization pass adversarial tests.

## 6. Faux Overhead and rendering

### 6.1 What the feature does—and cannot do

A GM outlines a bridge/tree canopy/awning already painted into a map and supplies cover elevation and affected levels. The **token pixels under that footprint are clipped**, leaving the existing artwork visible. No duplicate image/tile or recovered under-bridge artwork is required. This cannot reconstruct scenery never present in the image; true underfloor art requires another authored image/tile.

For this design, “beneath” uses token **feet Z < coverZ**; equality is not below. Body/eye height is still used by physical and perception queries. Faux art clipping is an XY presentation convention, not a volumetric rendering of a tall token.

The visual canopy is **not automatically a solid floor or roof**. “Add physical surface” is an explicit separate action that creates/links a Surface behavior. A decorative canopy may hide art without blocking a shot; a stone bridge normally needs a physical deck.

### 6.2 Per-view render plan

Build one immutable `SceneViewPlan` from projected documents, host view revision, viewed level, permitted viewers and current geometry/mask revisions. It supplies visible art groups, per-token clip/ghost state, interaction eligibility, lights, fog planes and GM-only editor outlines.

Preserve the existing `LAYER_ORDER` for the flat-scene fast path. A multilevel scene needs a distinct **LevelComposite** world-render subgraph: art, token and overhead passes interleave by elevation/role, with global editor controls above the result. Merely sorting children separately inside the old “all tokens below all above-tiles” containers cannot express that order. Reuse texture loading and render primitives, not the assumption that one above/below bit is sufficient; disable duplicate legacy world draws while the composite is active. Explicitly extend stage-contract/browser tests for this mode. Tile `sort` breaks ties only after physical elevation and presentation role; it never changes collision height.

Apply target-plane visibility/fog inside the composite before layers are combined. A single old full-scene fog texture cannot stand in for every floor's history. The authorized-token ghost pass may sit above cover artwork, but must remain subject to its own current-visibility mask; it never erases another plane's fog.

Use reusable local render textures or meshes for region masks; cull to viewport and affected tokens. **Do not allocate one full-scene texture per token or per floor.** One token has one logical hit-test/selection record even when rendered into multiple visual passes.

### 6.3 Visibility and presentation decision table

| Situation | Rendering | Interaction |
|---|---|---|
| Host did not disclose token / secret entity | Nothing, including hitbox and labels | None |
| Disclosed token is not geometrically covered | Normal allowed rendering, subject to current LOS/fog | Normal permission checks |
| Covered token genuinely visible to an authorized viewer | Clipped base + visible ghost/outline overlay; do not erase the roof | Targetable/selectable only as ordinarily permitted |
| Covered enemy not seen by any authorized viewer | No ghost, hitbox, name, bar, badge or hover response | Cannot target by selecting hidden geometry |
| Covered owned token or GM diagnostic view | Optional ghost/hitbox/full preview, visually marked as privileged | Ownership/GM controls; this does not grant enemy-target LOS |
| Token at/above cover elevation | No “under cover” concealment from that region | Ordinary rules |
| Same XY but token/viewed level outside region scope | No effect from that region | Ordinary rules |

Preferences can reduce presentation; they cannot manufacture visibility. In an LOS-allowed case, a “hide under cover” preference still provides the agreed visible ghost instead of falsely implying disappearance. Multiple viewers union **authorized perception**, not the LOS of every token in the scene. GM inspection follows the selected viewed level when no token is controlled; never pick the first token as a surrogate observer.

### 6.4 Partial overlap, masks and stale frames

Clip by region geometry, not by token-center containment or bounding-box intersection. A token halfway under an arch is half clipped. Handle holes, concave rings, overlapping canopies, rotated/scaled token art and video textures. Overlay decorations are independently authorized; do not leave bars floating over a clipped unseen token. Pointer hits must intersect an authorized visible silhouette or an explicitly privileged owned-token control surface.

Recompute on token XY/Z/body changes; region geometry/scope/cover edits; level changes; door state/direction; LOS/light changes; scene switch; resize; device scale changes; and worker restart. Attach scene ID + geometry revision + view revision to jobs. Ignore late results and clear now-invalid visibility immediately—never retain an old visible token while a new sealed-floor mask is pending.

### 6.5 Keep-lit is not reveal-fog

Use three separate masks: **current visibility**, **explored history**, **art brightness**.

- `keepLitArt` affects brightness only for authorized/explored artwork on the permitted viewed plane. It must not whiten the global fog mask or reveal tokens/terrain in an unseen basement.
- Region holes remain holes; they do not inherit keep-lit fill. If a hole exposes unlit unknown space it remains dark/covered.
- `occludeLight` adds the requested light barrier behavior; it is mutually exclusive with keep-lit in one Faux configuration. The UI explains the difference from adding a walkable surface.
- Revealing a roof's exterior does not mark interior floors explored. Persistent fog is never updated from cosmetic roof fades, build mode or an audit highlight.

### 6.6 Linked roof assemblies

Support optional roof assemblies with a stable scene/assembly/group identity and explicit occlusion-source/follower roles. Index group membership. Compute eligible direct source fades first, freeze that result, then apply followers; never derive permission from an already faded follower. Group evaluation is independent of tile insertion order. Validate each member's cover height and applicable levels against the explicit observer/view policy, rather than blindly choosing the first controlled token.

A group changes only authorized art presentation: it does not expose another floor's pixels, remove physical surfaces, grant target access or persist exploration. Source/follower edits invalidate the relevant group and render-plan revision. This contract is motivated by [Better Roofs' inspected linked occlusion](docs/research/multilevel/RIPPER_PREDECESSORS.md#r03--linked-occlusion-is-useful-but-should-be-indexed-and-deterministic), not copied Foundry hooks.

## 7. Wall/door/window authoring and interaction

### 7.1 Compact editor workflow

Keep the Walls tool's normal simple operation. Expand an **Advanced wall tools** section only when needed: endpoint snap, move connected joints, split/join, freehand, convert drawing, height/direction, bulk actions. Remember client tool preferences separately from world geometry. Always offer button/context-menu equivalents to modifier shortcuts for touch and accessibility.

- **Precision and inspection:** numeric X1/Y1/X2/Y2 editing, endpoint/whole-segment keyboard nudges, chain selection, preset hotkeys and a GM-local “show wall outlines on other tools” toggle. Respect input focus, locked objects and active floor; coalesce a held-key nudge into one gesture undo rather than one record per repeat. Do not globally intercept token movement keys as a module wrapper does.
- **Connected joints:** derive adjacency from canonical coordinates within the same editable level scope and vertical span. Do not join two stacked floors because XY happens to match. Freeze membership for the gesture; highlight every affected endpoint. A locked connected wall aborts or requires explicit disconnect—not a silent tear in the joint.
- **Preview/commit:** clone preview geometry locally. Pointer move does not dirty world documents. Pointer up submits one host plan; Escape/right-click cancels with zero Ops. One undo restores all participants.
- **Snap priority:** Shift bypasses snapping; endpoint snap then configured grid/subgrid. Tolerance is in CSS pixels, divided by camera scale—not device pixels. Deterministic ties use distance, wall ID and endpoint index. Show the snap candidate before drop.
- **Split:** deliberate split tool or configurable double-click on the segment away from endpoints. Keep the original ID on the first segment and allocate a new ID for the second. Reject zero length; preserve restrictions, elevation, scope and direction. Portal segments are protected: offer a portal-aware split/group operation, not two separately operable cloned doors.
- **Join:** operate on a snapshot of selected endpoints; deterministic bounded-diameter clusters, not unconstrained single-linkage chains. Preview the anchor and changed walls. Keep locked/portal anchors fixed; reject collapse or offer deletion in the same transaction. No repeated averaging against already-mutated coordinates.
- **Freehand:** sample at a bounded screen-space distance; retain first/last and pinned corners; simplify with a world-space error derived from a clearly labelled pixel tolerance. Use an iterative stack to avoid recursion overflow. Preserve topology; report self-intersections instead of silently producing leakage. Limit points/segments and show a simplification preview/count for unusually large strokes.
- **Drawing conversion:** apply each drawing's complete local-to-scene transform, including rotation; approximate ellipses with a specified maximum chord error. Respect open versus closed shapes. Preserve source drawings by default; optional delete belongs to the same envelope. New walls inherit the current level and chosen barrier preset.
- **Transform with map:** use `newTransform * inverse(oldTransform)` in one coordinate basis, not only width/height ratios. Distinguish resizing the scene boundary from scaling map content. Preview scope: active level or explicit selected levels, plus related surfaces/arrivals as appropriate. Background padding is not a reason to rescale every Z value.

Split/join/delete must inspect references from automation, tags and prefabs. Provide an explicit retarget/retain plan when an operation would invalidate a referenced wall. Ordinary safe edits do not open approval dialogs; risky bulk destructive operations get one preview/confirmation, not per-wall accepts.

### 7.2 Doors and windows during play

A player sends `requestPortalState(sceneId, wallId, desiredState, actingTokenId, expectedRevision)`, not arbitrary wall-update Ops. The host validates current state, scene access, secret discovery, ownership, proximity, height, permitted interaction side and optional rules-module capabilities. A forged XY or level ID cannot open a remote/hidden door. Locked means locked unless an explicit authorized unlock action succeeds.

The icon is derived from permitted state and interaction geometry. Secret portals are not displayed or named to undiscovering players; plain blocking geometry remains for collision. Per-user discovery can be a later extension; first release may use explicit GM reveal-to-table rather than a partially implemented discovery list.

“Close doors” defaults to the active authoring level or selection, reports its scope, closes only open doors, preserves locked state and does not accidentally include operable windows. “Wall off map” creates exactly the boundary of the selected level's intended map rectangle, with duplicate detection. Door/window media are user-imported/hash-addressed assets; no Foundry bundled textures or sounds are redistributed.

## 8. Fog, persistence, migration and portability

### 8.1 Fog schema and protocol

Create a new `fogLevels` IndexedDB store keyed by **[worldId, sceneId, levelId, userId]** rather than mutating the old store's keyPath in place. Migrate legacy scene fog once to the explicit base-level ID; keep an upgrade marker and make the process restart-safe. Do not clone existing exploration to every new level.

Add `levelId`, schema/capability version and request/view revision to fog messages. Validate scene and level existence, session access, payload size and image dimensions. Bind writes to the authenticated user; do not accept a caller-supplied user ID. Reject stale scene/level responses after navigation. Client-supplied explored history never grants authority or current LOS.

Keep exploration per target plane even when viewing a different floor through a hole. Explore only the actually visible patch on that target plane. On level deletion retain a recoverable snapshot until the transaction/migration succeeds; require reassignment or explicit fog removal, not ID-name matching.

Capture the compound fog key, reset/lifecycle epoch and content revision before asynchronous texture extraction. Persist only to that captured record if its epoch/revision still match; perform the check and write atomically. Navigation A→B may leave a valid A save pending, but its readback must never be displayed on B or written using B's current key. Reset/deletion invalidates older readbacks. Mark a revision clean only after a successful write of that revision; retain dirty work after extraction/storage failures. Missing floor fog starts unexplored, not as a fallback to global scene history. [Predecessor evidence and edge cases](docs/research/multilevel/RIPPER_PREDECESSORS.md#r08--per-level-fog-uses-surrogate-scene-records).

### 8.2 World schema gate

Current exports use format 2 for legacy worlds and **format 3** for private level drafts, requiring `scene-level-drafts-v1`. Readers accept 1/2/3 and fail closed on unknown format-3 features; old readers reject format 3. The full multilevel format-3 schema and additional required capabilities for physical levels, exposure and fog indexes are still pending. Draft records alone do not enable a stack or migrate fog. Future native-stack features must remain incompatible with draft-only readers, rather than flatten a sealed world into an unsafe ordinary scene.

A draft-only hello/welcome capability handshake now gates GM draft replication and commits. Extend it with required physical levels/surfaces/barrier-v2/exposure revisions before live multilevel play. Incompatible clients receive a clear upgrade-required message before joining a multilevel scene; do not merely omit unknown fields and allow play with incorrect collision.

World export includes level background/foreground assets, optional door/window media, region definitions, surface geometry, IDs/scopes, and per-level fog. Extend media reference collection and cleanup roots so floor art is not garbage-collected as “unused”. Derived GPU masks and spatial indexes are rebuilt, not archived. Persisted optional alpha-derived shapes record their source hash/transform and remain editable if media is unavailable.

Scene copy/prefab import allocates new level IDs and remaps token membership, visibility edges, scopes, linked regions, surfaces, arrivals, groups and automation references in the same plan. Shared immutable asset bytes remain shared. Re-key fog against new scene/level IDs only under an explicit copy-exploration policy; default fresh exploration.

### 8.3 Legacy and Foundry import policy

- Native flat scenes stay visually/physically unchanged until the GM enables levels. Keep clear windows, legacy doors and inclusive trigger ranges intact.
- When enabling levels, preview where legacy tokens/objects go; assign unambiguous elevations, ask once for unresolved/out-of-band objects. Do not guess a room's floor from a texture filename.
- Foundry V14 scene import is a **new adapter**, not presumed to exist because PF1e actor/item import exists. Map each external Level to a new internal ID; translate door type/state and wall restriction enums explicitly; preserve metadata in an import report rather than executing module hooks.
- Older `flags.levels`, wall-height and Better Roofs/Better Levels flags require version-aware adapters and fixtures. Unknown behaviors stay inert and appear in the report. No silent successful import that discards all ceiling geometry.
- The inspected V13 flags mix inclusive and half-open ranges; drawing and region transition modes need separate mappings. Do not infer a ceiling from `rangeTop`, silently apply `top + 1`, or treat texture alpha as authored solidity. Convert on staged data with a source backup and ambiguity report; retain original flags inertly. V14 native-level migration is a separate fixture family, not the same adapter.
- Native save/restore and same-app scene duplication are mandatory before advertising external Foundry scene parity. Import source scene JSON is data, never JavaScript to evaluate.

## 9. Level builder, build mode and audit

### Builder

“Add levels” asks for floors, basements, floor height and optional roof; previews bands and artwork slots. Recommended first-use visibility is conservative: self-only, with a separate explicit “above-ground levels can see each other” preset. A basement remains sealed unless the GM configures visibility and an actual aperture. A visibility matrix shows directed eligibility; no “eye” toggle is mistaken for a hole in a ceiling.

A compact floor chip/navigator provides: current viewed floor, follow-selected-token, up/down, and build mode. Level names/counts unseen by a player are not disclosed by the navigator. Multiple controlled tokens on different levels do not make the camera oscillate; pin/follow mode is explicit.

### Build mode

GM-local only. Hide or ghost other-floor art and handles, lock accidental selection of non-active-floor objects, allow an explicit “show all” diagnostic overlay. Do not mutate `hidden`, scope, collision, fog or transmitted visibility. Closing the builder returns to ordinary play with no duplicated scene state.

### Audit contract

Debounce on relevant document changes; display one count in the builder. Each issue includes entity references, explanation, severity, proposed diff, required capability and current geometry revision. Dismiss/ignore is explicit and reversible. A fix-all plan validates against one scene revision and commits once or rejects; do not incrementally alter the live scene while discovering more issues.

| Category | Initial checks |
|---|---|
| Structure | Overlapping/empty bands, dangling IDs, token Z/level disagreement, missing base |
| Geometry | Invalid rings/holes, duplicate planes, unsupported landings, zero-length walls, unsafe complexity |
| Scope | Cross-floor coincident endpoint joins; Faux region affecting a sealed unrelated level; broadly shared secret art |
| Surfaces | Floor/roof explicitly marked but no surface; ambiguous support; mismatched linked cutouts; stale alpha-source hash |
| Transitions | One-sided link, missing destination, invalid landing, wrong movement mode, immediate loop |
| Barriers | Invalid portal state/policy, one-way orientation ambiguity, sill/headroom conflict, missing referenced wall |
| Perception | Keep-lit combined with occlude-light; geometry cache/view revision mismatch; unbounded light propagation configuration |
| Portability | Missing level art, unresolved imported behavior, unsupported client capability, orphan fog record |

Severity describes **risk**, not authorization to silently fix: informational (name/UI), settings (behavior), structural (create/delete/reassign). Do not treat every untagged decoration as broken. A role of `decoration`/ignored is an intentional answer. Store reusable builder defaults client-side; structural roles and deliberate audit ignores are world data.

## 10. Implementation slices and file map

| Slice | Work / proposed modules | Exit gate |
|---|---|---|
| **M0 — contracts & evidence** | Resolve unit semantics; pinned Ripper source evidence (completed), legal gates and optional later Better Levels archive review; original geometry fixtures; capability/version allocation; benchmark current scene | Source gaps documented, schema review approved, baseline figures measured |
| **M1 — native structure & authoring** | `core/levels.ts`, collection plumbing; level-aware scene copy/export/media roots; navigator/builder; wall endpoint tools using existing Ops | Old scenes unchanged; 3-floor author/undo/save/reload; no cross-floor snap; incompatible-client gate |
| **M2 — physical & authority core** | `core/spatial/*` kernel/index; shared move/portal authorization; wall height/direction; surfaces and holes; host exposure projection | Sealed basement safe under forged intents/reconnect; height-aware doors and movement; surface ray tests |
| **M3 — perception & fog** | Versioned inline worker; `SceneViewPlan`; 2.5D token queries; per-level fog store/wire/archive; lighting/audio updates | No fog leakage; stale worker/job tests; cross-level token visibility without exposing room art |
| **M4 — Faux Overhead & advanced barriers** | Per-token partial masks/ghosts; keep-lit-art mask; proximity/limited policies; player controls; door/window presentation | Bridge/cave/basement fixture matrix, interaction parity and screenshot readbacks |
| **M5 — workflow & compatibility** | Audit plans, tile-role/surface generation, optional alpha tracing, native clone and external import adapters | Fix-all atomicity, malformed import safety, real authored scene roundtrips |

M1 can be GM-only experimental. M2/M3 must pass together before normal multiplayer multilevel play is advertised. A simpler editor-only wall enhancement can ship independently if it does not claim new physical semantics. Ship usable vertical slices, not a toolbar full of controls backed by placeholders.

**Cross-cutting touchpoints:** `documents.ts`, `store.ts`, `permissions.ts`, `projection.ts`, `messages.ts`, `host/sync.ts`, `client/sync.ts`, `automation.ts`, `sceneCopy.ts`, `assetUsage.ts`, `worldFile.ts`, `idb.ts`, `saveCoordinator.ts`, `stage.ts`, `TilesLayer.ts`, `FogLayer.ts`, `LightingLayer.ts`, `visionWorkerClient.ts`, `App.svelte` and `JoinApp.svelte`. Existing world-write serialization and cloud export activity guards must count the new structural/fog work; no separate unsaved in-memory levels database.

## 11. Performance and resource policy

These are **initial design budgets to validate**, not measurements or claims of shipped capacity:

- Baseline matrix: 1 / 4 / 12 / 32 levels; 100 / 1,000 / 5,000 walls; 10 / 100 / 500 tokens; 1 / 4 / 8 authorized eyes; 0 / 20 / 100 surface/Faux regions; mixed 4K and tiled 8K art. Include a low-memory laptop and integrated GPU.
- Target interactive authoring p95 main-thread work ≤8 ms/frame on the chosen reference machine; perception jobs may be asynchronous, but no stale permissive frame after a blocker closes. Measure latency, memory and CPU separately; do not “solve” slow masks by revealing everything temporarily.
- Build indexes by scene/level and vertical intervals, with broad-phase spatial buckets/BVH. Query by swept bounds; never rescan every floor's full wall list on every pointer event.
- Initial accepted authoring bounds: 32 levels; 256 vertices per ring; 2,048 vertices per region across ≤32 rings; 4,096 raw freehand samples and ≤1,024 emitted segments per gesture. Imports above supported limits produce a preview/error, never silent truncation.
- Initial texture budgets: 64 MiB for extra multilevel mask caches on desktop, 24 MiB low-memory mode; LRU and viewport-sized masks, not scene-area × floor-count allocation. Map textures have a separate existing media budget.
- Bound and cancel worker queues; latest-view wins. Cache by scene ID, geometry revision, source/target Z, direction/axis, light revision and view revision. Incremental door invalidation must touch relevant observers on both sides/levels.
- Keep file:// compatible with inline workers, no dynamic external imports/eval, and no required CDN/module server. Geometry libraries, if selected, must be license-reviewed and bundled; benchmark their byte cost.
- Preserve the existing **6 MB raw HTML** gate (current prior cloud build ≈4.89 MB). Proposed feature allowance ≤250 KiB additional raw JS initially; measure before committing to a geometry/shader dependency.
- Context loss/failure degrades to conservative occlusion and a non-modal diagnostic, not disabling walls/fog. A source asset decode error shows a placeholder and retains authored physical geometry.

## 12. Acceptance plan

### Required authored fixtures

1. **Sealed stack:** basement −10..0, ground 0..10, upper 10..20, roof 20..open. Same XY enemy/light/door on each floor; one intentionally missing cutout.
2. **Bridge on flat artwork:** Faux region only, then explicit deck surface; token crossing partly underneath; slatted variant; nearby viewer who can see underneath.
3. **Atrium/balcony:** concave floor, two holes, transparent tile decoration, cross-level visible token under intact floor art; one-way visibility eligibility.
4. **Barrier laboratory:** clear and proximity windows; sill/lintel; normal/secret/locked doors; directional walls; limited pairs; curtain; reversed endpoints.
5. **Editing torture scene:** coincident stacked-floor walls, tiny gaps, locked joints, rotated drawing, huge freehand stroke, referenced door, map offset/nonuniform scale, repeated undo/redo.

6. **Predecessor edge cases:** linked roof sources/followers under reordered tiles; two observers on different floors; zero-coordinate and fully contained overlap; reversed collision-candidate order; A→B fog extraction race followed by reset; V13/V14 import ambiguity and stair route continuation. Detailed expected outcomes are in the [predecessor acceptance matrix](docs/research/multilevel/RIPPER_PREDECESSORS.md#7-concrete-design-impact-and-acceptance-additions).

### Automated gates

| Area | Must prove |
|---|---|
| Pure geometry | Half-open band boundaries; finite/null handling; holes; tangent/coplanar rays; ray Z at wall crossing; opposite-side direction; shared-vertex de-duplication |
| Movement | Footprint/headroom; thin stair crossed in one move; collision at landing; no double transition; cycle limit; flight versus support; all input routes agree |
| Wall editing | One transaction/undo per gesture; abort leaves no mutation; stable snap ties at all zooms; locked endpoint safety; portal reference integrity; drawing transform correctness |
| Host security | Forged level/Z/door ID, unauthorized unlock, hidden secret name, client-selected floor, raw-Op bypass, malicious fog write, missing capability |
| Replication | Late join, reconnect, hidden→visible→hidden with no target edit, oplog replay, exposure revision ordering, asset manifest filtering, observer ownership changes |
| Fog | Per-user/per-level isolation, stale request response, base-only migration, surface-hole reveal only, keep-lit never modifies exploration, corrupt archive index |
| Rendering | Partial clipping, holes, rotated/video token, labels/bars/targets, overlays above cover without room reveal, no-first-token GM view bug, context loss |
| Windows/light/audio | Independent axes; proximity threshold boundaries; attenuation policy; sealed-floor torch/sound; correctly elevated listener |
| Persistence | Save now during pending geometry work, reload, source media retention, format 1/2 import, format 3 rejection by old reader, copy-ID remap, ZIP restore |
| Performance/offline | file:// with networking disabled; inline worker startup/CSP; bounds/queue cancellation; main-thread and GPU cache budgets; unchanged flat-scene cost |

Extend existing suites around `wallKinds`, `movementPolicy`, `regionGeometry`, `projection`, fog, world files and browser walls/doors; add shared host/worker conformance vectors. Test headless geometry plus actual Chromium render/readback and real Firefox/WebKit/mobile runs before claiming broad support. A screenshot alone cannot prove host authorization; a unit test alone cannot prove shader clipping.

### Definition of done

A GM can build the sealed-stack fixture, walk two players independently through stairs, operate only reachable authorized doors/windows, see legitimate balcony/under-bridge tokens without revealing unrelated floors, save/close/reopen/export/restore, and undo bulk authoring edits. The application still opens as one self-contained HTML file. No routine per-edit acceptance queue is introduced.

**Historical validation for the design-only delivery (see implementation status for current checks):** 12 isolated specification tests for the original snippets passed; targeted ESLint and documentation link/whitespace checks passed. No multilevel runtime/browser acceptance is claimed, and the full app suite was not rerun for this documentation-only feature proposal.

## 13. Open decisions and explicit limitations

1. **Better Levels code inspection remains incomplete, but is not a blocker.** Its download remains unavailable to the user and this review. Ripper predecessor code is now pinned and inspected; proceed with the independent contracts above. If a legitimate Baileywiki archive becomes available later, audit Faux rendering/hit testing, enabled-level gates, keep-lit, cutouts and audit provenance with file hashes. Do not attribute predecessor implementations to that product.
2. **Legal review:** no upstream code/art ships until the project's adoption process closes the case. The supplied snippets are original design kernels, not a certified source port.
3. **Visibility fidelity:** body-sample policy and conservative cross-level terrain mask algorithm need prototype measurement and published acceptance fixtures. Do not call this a full arbitrary 3D renderer.
4. **Gameplay integration:** system adapters must decide body/eye defaults, climbing, falls, reach and volume targeting. Core supplies geometry and permission boundaries, not new PF1e rules by accident.
5. **Disclosure threat model:** strict live token/floor disclosure is proposed; formerly disclosed bytes and monolithic map art cannot be revoked from a player's browser. Do not overpromise secrecy.
6. **Schema allocation:** format/protocol numbers, resource ceilings and exact UI shortcuts must be confirmed against parallel work before implementation.

**Recommended next step:** approve M0/M1 contracts and build one sealed-stack conformance fixture. Do not begin by grafting Foundry hooks or a Faux Overhead shader onto the current 2D fog pipeline.
