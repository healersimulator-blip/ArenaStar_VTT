# Multilevel implementation status

**2026-10-11 — native cover, wall authoring, spatial kernel, level drafts, isolated floor play, stairwells with player choice (D-430), pass-through and door-linked stairs (D-437), floor scopes for presentation objects (D-432), the floor-play check (D-433), roofs (D-438), floor merge/reorder/rescale (D-439), token elevation cues (D-440), importing a scene as a floor (D-441), seeing lower floors (D-443), solid floors with openings (D-444), seeing tokens below (D-445), light between floors (D-446), area effects on floors (D-447), standing, falling and flying (D-448), importing Foundry scenes with their floors (D-449), drawing and editing stairs (D-450) and keeping other floors' data on the host (D-451); the complete design is not finished.**

Target: [Multilevel, walls and Faux Overhead design](MULTILEVEL_WALLS_DESIGN.md).

Review 2026-10-11: [GAP analysis vs Levels, Better Roofs and Foundry V14 Scene Levels](MULTILEVEL_GAP_ANALYSIS_LEVELS_ROOFS.md). It covers status defects S1–S8 (overlapping stairs silently refused, floorless tokens hidden on isolated floors, auxiliary layers removed, Faux Overhead inverted on the Canvas2D renderer, two stale specs), gaps G-01 to G-33 and a recommended sequence.

## Current player experience: isolated floors, stairwells with a choice (D-428 → D-437)

Players in a scene with **isolated floor play** see one floor: its map tiles/background, its walls and lights, its ambient light and its own remembered fog. The view follows a controlled token. Walking into a stairwell either changes floor at once (one possible destination) or asks the player which floor (several destinations, or a stairwell set to always ask); "Take stairs" on the floor chip asks again while standing on the stairs, and Esc stays. A stairwell set to *pass-through* also works when a move crosses it: the token stops just inside to choose, or — with one destination — changes floor there and carries on to where it was dragged when the new floor allows. Stairs linked to a door work only while that door is open. Stairs are outlined with up/down arrows and an optional label (hidden passages are not marked). Arriving shows "You arrive on …" with a short cross-fade. Refused moves say why (a wall, a blocked landing, locked stairs). Drawings, templates and notes without a floor appear on every floor; floor-scoped ones only on theirs. New tokens always land on a floor.

### Set up a playable stack

1. Place each floor map as a scene tile using the normal image tools.
2. In **Scenes → Draft levels**, create/save the floors. Tick each floor's map tiles; optionally assign the existing scene background to one floor. Set ambient overrides if needed.
3. Under **Membership**, assign tokens, walls and lights (and, if wanted, drawings, templates, notes and regions). Walls/lights/tiles on no floor do not take part in floor play; the floor-play check offers "put these walls/lights on every floor" and "assign tokens by elevation".
4. Open **Floor play & stairs → Create stairwell**: tick the floors it connects (2–8), choose both ways / up only / down only, travel at once or always ask, an optional label and "hidden passage", "also when a move passes through", an optional door it depends on, and either a rectangle in scene pixels or an existing region drawn in Active Zones. Each stairwell row can be locked, switched to always ask, hidden from markers, switched to pass-through, linked to a door, converted (legacy) or removed.
5. Enable **isolated floor play**. The floor-play check runs first: errors block, warnings can be fixed in place or acknowledged with **Enable anyway**. The same check stays live in the panel.

Legacy scenes are not silently migrated. Legacy `{from,to}` stairs keep working; overlapping ones now combine into one choice, and identical-geometry pairs can be merged into a stairwell from the check.

**GM side (D-434–D-436).** An empty Draft levels panel can *generate a stack of floors*. The **GM floor** control on the canvas shows one floor with the others faint (or hidden, or all), steps with PageUp/PageDown, and lists who is on which floor (click a PC to jump). *Build on this floor* keeps picking on that floor and makes everything the GM creates — walls, lights, tiles (added to the floor's art), regions, notes, drawings, templates, tokens — belong to it. The token menu moves a token (or the selection) to any floor and edits feet elevation, offering a floor change when the height belongs to another floor.

**Fixing a stack (D-439).** Draft levels → **Merge, reorder, rescale or import floors**. *Merge* moves everything on one floor to another (tokens keep their height above the floor; walls, lights, stairs and map tiles follow) and deletes the emptied floor; touching bands are joined. *Move up/down* swaps a floor with its neighbour and carries its contents. *Rescale* multiplies every elevation, for example 0.3 when a 5 ft grid becomes 1.5 m. Each shows what it will do first and is one undo step.

**Seeing lower floors (D-443).** In Draft levels, each floor lists the floors it **sees below**. The presets are *Sealed*, *Down to ground* and *All below*. On an isolated floor, and in the GM's isolated floor view, the art of those floors is drawn beneath this floor's art and dimmed by depth, so stairwells, holes and the open air beside a tower show what lies below. Only art is shown: tokens, walls and lights stay on their own floor.

**Solid floors with openings (D-444).** Each draft floor can store where it is solid. **Trace from floor art** turns the opaque parts of its map art into solid floor and the transparent parts into openings, with a preview; untraced floors are solid everywhere. The floor-play check warns about an opening with nothing beneath it. These shapes feed the spatial kernel for seeing tokens below (D-445), light between floors (D-446) and the coming falling work.

**Seeing tokens below (D-445).** A player's tokens can see tokens on the floors below through those openings: from the edge of a stairwell, the goblin at its foot. The host checks a real 3D sightline (openings, walls, range, light or darkvision). Seen tokens are drawn dimmed beneath the floor's art and cannot be picked; the GM's isolated view shows all of them.

**Light between floors (D-446).** Light spills through traced openings. On a dark upper floor, the stairwell shows the hall below under the hall's own light, and a lamp down there glows inside the well but not on the floor around it. A lamp hanging over the well on the floor above lights the landing at its foot. The same light counts when the host decides which tokens below a player can see. Untraced floors stay solid, so nothing changes until a floor is traced. This works on both WebGL and the Canvas2D fallback.

**Area effects on floors (D-447).** A spell area happens on its caster's floor. An Entangle or Lightning Bolt cast on Floor 2 no longer catches creatures standing at the same spot on the ground floor, and walls on other floors no longer get in its way. A burst or spread centred over a stairwell still reaches creatures below it, through the opening and within its radius. Lines and cones stay on their floor. The host checks every target this way.

**Standing, falling and flying (D-448).** Nobody walks on air. A player cannot walk into the empty middle of a traced stairwell or a hole in the floor; the move is refused with a reason. Inside the stairwell's stairs, or with the token's feet above the floor, it is fine. The GM can put a token there. The floor-play check then lists it with **Drop them to the floor below**, and the token menu offers **Fall to Ground (10 ft)**. When the GM raises or lowers a token onto another floor, the offer says whether it fits through the openings on the way, or which solid floor is in the way.

**Importing Foundry scenes (D-449).** Scenes → "Import a Foundry scene" takes the JSON from Foundry's Export Data. It reads a scene built with the Levels module (Foundry V10–V13), with Foundry V14 scene levels, or with no floors at all. Before anything is created, a report shows the source, the counts, a floor table, what will be on every floor, what is skipped and why, and which images still need a file. Floors keep their bands: Levels' inclusive tops meet the next floor, overlaps are clipped, and floors are inferred from wall and tile heights when there is no level list. Wall heights and light ranges become floor scopes; Levels floor tiles become floor art; tokens go on their floors; stairs, one-way stairs, elevators and V14 Change Level regions become stairwells. Map art comes from image files the GM picks, matched by file name. "Create scene" is one undoable step, and the floors stay drafts until the floor-play check turns them on. Actors, sounds, notes and templates are not imported.

**Drawing and editing stairs (D-450).** On a scene with floors, the map's tool rail has a Stairs tool. Drag over the stairs on the map: the area snaps to the grid, and the stairwell joins the floor you are viewing and the next one up, travelling both ways. Each stairwell under Floor play & stairs then has an Edit form for its name, the label players see, the floors it connects, its directions, and its position and size, saved as one undoable change.

**Other floors stay on the host (D-451).** In isolated floor play a player's replica now holds only what their floors can show. That is their own floors' documents, the tokens and floor art of the floors those see below, and the walls and lights of a floor above that sees down. Other floors' token positions and wall layouts never reach the player's machine. When the player's token takes the stairs, the host resends that scene's floor-bound documents. A per-session ledger guarantees the replica never receives an op it cannot apply.

**A scene as a floor (D-441).** The same panel imports another scene (or one floor of a multilevel scene) into an existing floor or a new floor on top: its map becomes a floor map tile, and its tiles, walls and lights are copied, scaled so grid cells match, and stamped with the floor. Tokens and regions stay behind. One undo step removes it all.

**Elevation cues (D-440).** A token above (or below) its floor carries a small badge with its height over that floor, such as **+15 ft**; set it from the token menu's **Feet Z** field, now on every scene. *Settings → Token elevation* shows the badge to everyone (default), only the GM, or nobody, and *Shrink tokens at other heights* draws tokens higher or lower than your selected token smaller (down to half size). Neither changes movement, sight or fog.

**Roofs (D-438).** In **Scenes → Tiles & roofs**, any tile can be made *Overhead (roof)*. Its fade can be:
- *whole roof*: the roof fades while a token is under it;
- *circle round token*: a circle opens around each token under it;
- *token's sight*: the roof opens where the token under it can see;
- *always faded*.

Set the open opacity and the circle radius. Give a building's tiles one group so they open together. A *follower* tile, such as a porch, never opens the group by itself. *Show through fog* lets players see a roof from outside as soon as any part of it is in sight. This never writes explored fog.

Roofs open only for the viewer's own tokens with vision, and only when a token's centre is on the roof's art. Selecting a token narrows which tokens count. Another player's token inside a building does not open the building for you.

The GM can tick **Peek under roofs** on the canvas to fade the roof under the pointer, on the GM's screen only. Circle and sight openings need WebGL; the Canvas2D fallback fades the whole roof.

**Remaining** (tracked as G-items in the [gap analysis](MULTILEVEL_GAP_ANALYSIS_LEVELS_ROOFS.md#implementation-progress)): player flight once players can set heights (G-16), floor surfaces inside a band (bridges, G-21), and comprehensive sheet/FX secrecy beyond scene documents.

Validation (D-429–D-454): **5,585 Vitest passed / 12 skipped** (415 files, 2 skipped); **`test:multilevel` 33/33 Chromium tests passed on WebGL** (26 spec files, 11.2 min on
this hardware — one bounded batch, inside the 25-minute rule in `README.md`), with players' cross-floor views (art, tokens and light from other floors) drawn from the withheld replicas. These include the three-floor stairwell journey (player chooses down, "Take stairs" + Esc, keyboard choice up, locked stairs explained), the pass-through stairwell linked to a door, the GM floor view journey, floor merge/reorder/rescale, scene import, elevation cues, lower floors seen through openings, traced surfaces, tokens seen below, light between floors (real pixels; also passes on Canvas2D), area effects on floors, walking into an opening (refused, then the GM drops a token through the check), the Foundry import (report, picked map image, create, floor play on), the stairs tool (drawn on the map, then renamed, re-directed and resized), the roof journeys, and the
shipped elevation test scene opened as a GM plus a player over the built starter zip (the labels, solid versus
open raised areas, the climb into the floor below seen through its opening). The Faux Overhead, roof and floor-light specs also pass on the Canvas2D fallback. Typecheck, lint and single-file build passed; Svelte 92 components / zero blockers / one existing advisory. Two older spell specs fail the same way on the base commit and are unrelated: `pf1e_entangle` (its hot-bar cast now enters area aiming) and the Entangle half of `pf1e_spell_demo` (an FX scale wait).

## Implemented and usable now

### Native region-based Faux Overhead

- `RegionDocument.fauxOverhead` stores declarative cover height, a half-open feet-elevation band, and an optional normalized V2 footprint.
- A footprint is a union of components. Each component supports a concave outer ring and its own strictly contained, disjoint holes. A second component can fill a first component's opening.
- The ordinary convex region shape remains the automation-trigger shape. An advanced cover footprint does **not** silently change existing trigger behavior.
- Native Pixi inverse vector masks clip tactical token containers against the covering world geometry. No copied module code, custom upstream shader, image readback, or new runtime dependency is used. The covering map artwork is left intact; no background pixels are synthesized or revealed.
- World-coordinate masks remain stationary while a token moves underneath. Geometry is rebuilt when cover definitions or the token's elevation eligibility change, not every animation frame. Stale masks are detached before destruction.
- Labels, badges and HP bars are conservatively suppressed near a cover, using rotation-safe token bounds. They return after the token leaves. This deliberately hides decorations slightly early rather than leave identifying UI floating outside covered art.
- Pointer selection, dragging, double-click activation and context-menu picking reject covered pixels. Marquee selection conservatively excludes cover-overlapping tokens; an exposed part can still be clicked normally.
- Both GM and player shells install the renderer. Existing visibility denial takes precedence: a cover never turns a denied token visible. Fog exploration, light and movement are unchanged.

### Authoring

1. Open **Macros → Active Zones**.
2. Select **Region** as the source kind and create/select a region.
3. Expand **Faux Overhead · native region cover**.
4. Enable a solid cover, choose its height and affected feet-elevation interval, then **Apply cover**.
5. Optionally use **Concave footprint and openings (advanced)** to enter a V2 footprint or draft a central opening. Blank uses the region's existing outline.

The cover edit is one ordinary undoable host operation. Autosave remains automatic; no approval queue is added. Enabling explicitly publishes the region document, including its name, geometry and metadata, to everyone. A concealed region is not allowed to act as a player cover while being omitted from that player's replica.

The first editor uses existing region bounds and an advanced JSON footprint editor, not the planned on-canvas vertex/hole drawing tools. A completely covered token has no ghost/control surface in this slice; temporarily disable its cover or use existing non-canvas document tools when editing it.

### Validation and persistence

- GM/assistant-only region authoring/removal, including whole-scene and dotted-path edits, even when a player owns the parent scene.
- Final staged region validation catches invalid combinations split across multiple operations; ordinary host permission checks still run per operation.
- Finite bounded heights/transforms; normalized vertices; simple nonzero-area rings; no touching, nested or intersecting holes. Winding direction does not change containment.
- Bounds: 512 vertices per footprint; at most 16 components and 16 holes per component; 128 covers and 4,096 cover vertices per scene.
- Region cover data follows normal save/reopen, undo/redo, same-app scene copying and ZIP export/import. Import validates cover geometry before writing the world.
- Shared production geometry also contains half-open membership and ray/plane-footprint helpers for subsequent physical-level work. These helpers are **not yet wired into authoritative movement or sight**.

### Native wall authoring (flat scenes)

Open **GM Info → Wall** and choose:

- **Draw:** existing wall/door/window placement, now with endpoint snapping within 8 screen pixels. Endpoint snapping takes precedence over grid snapping. Disable its checkbox or hold **Ctrl** to bypass endpoints; this does not disable the existing grid snap policy.
- **Move corner:** drag a gold endpoint. Exactly shared endpoints move together by default, including attached door/window endpoints. Disable **Move joined endpoints together** to move only the deterministically selected endpoint. Nearby but distinct endpoints are not implicitly joined. Red locked/prefab endpoints are protected; a shared joint containing a protected member cannot be moved as a group.
- **Split:** click a plain wall. The first half retains its ID, the second receives a new ID; direction, one-way behavior, ownership and other metadata are copied without changing existing values. Doors, windows, explicit portals and prefab/locked walls cannot be split. This is not a general external-reference migration tool; references to the original wall still target its first half.

Corner/split previews are detached from the document store. Each successful gesture is one ordinary host transaction and one undo/redo step. Escape, cancellation, window blur, tool/layer/scene/view-as changes discard a pending gesture. Pointer capture permits release outside the canvas. Short corner clicks do not accidentally move an endpoint; split drags do not commit. Coordinates must remain finite/bounded and walls cannot collapse.

A corner/split intent carries an optional canonical SHA-256 wall-scene revision guard. The host requires GM/assistant identity, validates bounded wall-only operations and rejects the entire edit if **any wall** changed since the press, including newly attached joints or metadata edits. Unrelated actor/chat/scene-name changes do not invalidate it. Rejections appear as ordinary non-modal warnings. Guards never enter committed envelopes, undo records or exported documents; this is an intent precondition, not a new capability or a restriction on legacy unguarded intents. Normal autosave needs no per-edit acceptance.

This is geometry authoring on the existing flat wall model: no level-aware endpoint partition, finite-height collision, freehand/merge operation, portal reference migration, new lock UI or new door-opening authority is claimed. Use the same updated build on host and GM clients; this optional extension is not the future multilevel capability handshake.

### GM-only native level drafts

Open the **Scenes** sidebar and expand **Draft levels · GM only** under a scene. Add/rename draft floors, set bottom/top bands, floor Z and display order, then **Apply draft levels**. Blank bottom/top means unbounded. Bands are half-open; overlaps, invalid floors, duplicate IDs and dangling visibility links are rejected. Gaps and unmatched token feet elevations produce audit warnings without moving anything.

These are real optional embedded `SceneDocument.levels` / `LevelDocument` records with stable IDs, capped at 32 per scene. Editing a name/order/height does not re-key a level or update tokens. Apply emits minimal ordinary Ops in one transaction; normal autosave and undo/redo apply. The editor refuses a visibly stale local draft and offers Reload; ordinary field edits remain last-writer-wins at the host (no new level CAS protocol is claimed). Scene duplication allocates new level IDs and remaps directed visibility references. Save/reopen and ZIP world-copy preserve records and references.

**Private, planning-only data:** GM/assistant authoring is enforced even when a player owns the scene. Whole-array/dotted changes, embedded edits/deletes and deletion of a scene containing drafts are protected. Player snapshots, scene creates, incremental updates and embedded Ops omit these records regardless of ownership. Visibility links are retained/validated as draft metadata, not executed as disclosure policy; they have no editor controls yet.

**Archive compatibility:** legacy worlds still export as format 2. A scene carrying a `levels` field (including an empty array) requires format 3 with `requiredFeatures: ["scene-level-drafts-v1"]`. Updated readers accept formats 1/2/3, reject unknown format-3 features and reject draft data disguised as format 1/2 before any import writes. Older readers reject format 3. This is a draft-data archive gate. Live draft compatibility is also negotiated (below); full physical multilevel capabilities remain pending.

Use the same updated build for host and GM clients. Do not reopen draft-bearing worlds from local browser storage with an old build: the ZIP gate cannot retroactively protect old code opening the same IndexedDB database. No level art, runtime membership/scope, base-floor conversion, fog migration or physical activation is implied by adding drafts. The UI states that this is planning only.

### Live draft compatibility

Hello/welcome now negotiate bounded optional feature lists. A GM/assistant joining a draft-bearing world must support `scene-level-drafts-v1`; incompatible clients receive an upgrade-required response **before any draft snapshot or replay**. Legacy players remain allowed because drafts are omitted from their replicas. Unknown required features are rejected; optional unknown advertisements do not prevent ordinary play.

The host refuses draft-affecting transactions while an incompatible authenticated GM is present. This applies to the common commit path, including scene copies/scripts and undo/redo, without adding a per-edit approval queue. Ordinary edits remain available. Undo/redo refusals preserve history and appear as non-modal GM warnings. Upgrade or disconnect the named GM, then retry.

When the current world is draft-free but its log contains old draft operations, a legacy GM receives a fresh snapshot rather than unsupported raw catch-up. New clients refuse draft sends/replication without negotiation; reconnect clears capabilities and fences old-transport callbacks. The editor shows an upgrade notice for an incompatible host.

This capability is specific to **draft document compatibility**, not physical levels or new player disclosure. It does not certify old local-storage readers, external binaries, or all other optional protocol extensions. See [protocol details](PROTOCOL.md#draft-level-capability-negotiation-d-420).

## Implemented foundation — not active gameplay

`src/core/spatial/kernel.ts` now provides a validated, detached 2.5D query snapshot:

- Finite/unbounded wall spans, actual intersection elevation, independent move/sight/light/sound channels, conditional doors and explicit signed crossing direction.
- Horizontal floor/ceiling planes sharing transformed concave/component/hole geometry; solid rims and component-local openings.
- Continuous body sweeps with fixed rectangular orientation, including rotation, shoulders and head/feet clearance. No fixed-step runtime sampling.
- Explicit highest-support point probes, without silently creating full-map floors.
- Deterministic contacts, strict malformed-input rejection and bounded compilation resources.

This kernel is **not wired into the live scene/host/vision paths**. It adds no world fields, level switch or automatic migration. It must not be treated as movement permission, full-body support, host exposure or fog isolation. See [the API contract, boundary conventions and integration gates](docs/multilevel/SPATIAL_KERNEL.md).

29 new tests include a three-floor geometric fixture, legacy movement conformance and seeded continuous-sweep occupancy checks. The fixture is not multiplayer sealed-stack acceptance. The kernel still needs scene adapters, revision caching/indexing, authoritative integration and measured dense-scene budgets.

## Authoring membership contracts (D-421)

- Optional `TokenDocument.levelId` and `WallDocument.levelScope` now carry explicit GM-authored references. Scopes are `{mode:"all"}` or `{mode:"levels",ids:[...]}`; absence remains the legacy partition. These fields do not activate multilevel physics, rendering or secrecy. The D-422 editor below now exposes explicit assignment.
- Tokens explicitly assigned by host/API must have feet elevation in their half-open level band. `tokenLevelAssignment` produces a single membership + floor-elevation update; removing a bound level requires clearing/reassigning its references in the same transaction. Unassigned legacy tokens remain unconstrained by draft bands.
- Intent validation and the central host commit validate final staged membership. Player owners cannot assign/clear membership or replace bound scene arrays. Player snapshots, creates and direct/whole-array/dotted updates omit membership metadata, including envelope-only projection. This hides authoring metadata, **not wall geometry or other-floor tokens**.
- Scene copy rekeys bindings; save/reopen and ZIP preserve them. Archives and GM wire sessions with bindings additionally require `scene-level-scopes-v1`; support for draft levels alone is insufficient. Historical replay and undo compatibility use the same feature detector.
- Coincident endpoints only join and corner-snap within identical topology scopes (ID order is irrelevant). `wallsForAuthoring` provides explicit partition queries, but toolbar selection, scoped drawing and full level-aware authoring UX remain pending. Full-scene wall guards still detect concurrent changes.
- The draft editor now catches bound-reference/band errors before submission. No per-edit approval queue or automatic token migration was introduced.

Verification: **5,378 Vitest passed / 12 skipped** (381 files passed / 2 skipped); **5 Chromium regressions passed** (draft editor, two wall-edit journeys, two multiplayer fog journeys); TypeScript/Svelte and targeted ESLint passed; standalone build ~4.933 MB. One pre-existing ReplayPanel Svelte advisory remains. This is not sealed-stack or physical-runtime acceptance.

## Membership and scope authoring UI (D-422)

Open **Scenes → Draft levels · GM only → Membership & wall scopes · experimental authoring**.

- Choose a token and a saved destination level. Apply explicitly sets both membership and feet elevation to that level's Floor Z. The form previews this change. Clearing membership preserves elevation; assigning the same level intentionally returns feet to its Floor Z. XY and other token fields are untouched.
- Choose a wall and legacy/unassigned, explicit all-level, or a nonempty selection of saved levels. Scope-only updates preserve coordinates, independent barrier axes and door state. Locked/prefab walls and attached/summoned tokens are refused by this editor; use their owning workflows instead.
- The saved binding audit lists counts and object IDs for each level, plus unassigned-token, legacy-wall and all-level-wall totals. Bound-level removal remains invalid until references are reassigned/cleared.
- Dirty draft-level edits must first be applied or reloaded. Changes to the selected object or saved levels mark the assignment form stale; explicit Reload is required. This is a local stale-form check, **not host compare-and-swap**. It does not promise race-free editing across multiple GMs.
- Capability/role gates and normal host validation remain in force. Each assignment is an ordinary atomic undoable edit with existing autosave; no per-edit approval workflow or implicit migration.
- No floor-view navigation, scoped drawing or physical/runtime activation is added. All warning text explicitly says these assignments do not hide other floors or change wall collision, sight, lighting or fog.

Validation: final full suite **5,382 passed / 12 skipped** (382 files passed / 2 skipped); **7 Chromium journeys passed** including token relocation/clear/undo, wall scope/audit/stale/undo/redo/reopen, existing drafts/wall gestures and both multiplayer fog journeys. TypeScript, targeted ESLint, standalone build (~4.942 MB) and Svelte (86 components, zero blockers) passed. One initial full run hit the existing timed FX live-list gain test; its unchanged 57-test file and the subsequent complete suite passed. One existing ReplayPanel advisory remains.

## Per-level fog and lighting diagnostic (D-423)

**Usable GM-only diagnostic, not multiplayer multilevel perception.** When the active scene has saved levels, the canvas offers **GM fog & lighting diagnostic**. Select a level to view its independent exploration and scoped lighting. Enable ordinary scene fog in Settings first; the diagnostic does not silently turn it on. The legacy whole-scene option restores the existing path. The diagnostic does not redact other-floor tokens or artwork, change physical collision or authorize player exposure. Manual fog painting is disabled while it is selected; existing scene-wide mask policy remains separate.

- `fog.get`, `fog.put`, `fog.state` accept optional `levelId`. Tuple-encoded cache/waiter keys isolate scene, user and level without separator collisions. Missing level ID remains the legacy namespace. Scoped requests require `scene-level-fog-v1`; the host accepts them only for GM/ASSISTANT sessions and existing same-scene levels. Players cannot gain access by supplying a floor ID. Authorization is rechecked after asynchronous restore; newer cached uploads take precedence over delayed storage reads.
- IndexedDB schema **5** adds `levelFog`, keyed `[worldId,sceneId,userId,levelId]`, without rewriting the legacy `fog` store. Upgrade leaves old exploration only in its legacy namespace; it does not seed authored floors. World deletion includes both stores. Writes use existing save coordination with level-aware coalescing keys.
- Level switches save the old map before resetting the shared surface. Readbacks capture their destination level; superseded scoped restores/worker polygons cannot reveal into a newer floor. No extra per-floor full-map texture cache is allocated.
- Format-3 archives carry optional `fog.json.levelId` and require the fog capability when scoped rows exist. Copy/replace import preserves each namespace and rejects missing capability declarations, invalid level IDs, duplicate namespace entries and orphan level references before writes. Export omits local orphan level rows (e.g. deleted levels retained locally for possible undo), rather than creating an archive its importer cannot open. No automatic legacy-to-base upgrade is performed yet.
- `LightDocument.levelScope` uses the same explicit all/selected-level contract as walls, with atomic reference validation, GM-only writes, private metadata projection, copy remapping, and a distinct `scene-level-lighting-v1` gate. The membership editor now offers **Light** and includes lights in its binding audit. Unassigned lights stay in the legacy view; explicit all-level lights illuminate every diagnostic floor. Assigned token-carried lights follow their token's membership.
- Fog and renderer share the same level-filtered source inputs. Lighting polygon cache identity includes level, so late results from another floor cannot return its glow. All physical walls remain in clipping inputs: authoring scope never bypasses collision. Ambient darkness is still scene-wide, and fog's light-at-point policy remains the legacy radial approximation; there is no vertical aperture/light tracing yet.

Verified: **5,389 Vitest passed / 12 skipped** (383 files passed / 2 skipped); **9 Chromium journeys passed**, including actual fog texture exploration/readback/restoration and carried-light layer isolation, plus existing player fog/lighting, assignment, drafts and wall editing. TypeScript, targeted ESLint, Svelte (86 components / zero blockers / one existing advisory), build (~4.949 MB) and diff checks passed. Initial full-suite failure was the all-store deletion fixture missing the new store; it now populates and verifies deletion of level fog as well.

Still required for full M3: host-issued player exposure/view plans, player per-level fog authorization, vertical surface/aperture perception, per-level ambient settings, explicit fog reset generations and base-upgrade UX, cross-level light/audio, and physical-runtime acceptance. Do not advertise this diagnostic as sealed-stack gameplay.

## Per-level ambient inheritance (D-424)

Each saved draft level now offers **Inherit scene ambient lighting**. It is on by default. Uncheck it to set **Level ambient darkness** from `0` (ambiently lit) to `1` (total darkness). Values between them keep the existing lighting/vision semantics: any value below `1` provides ambient light; this is not a new low-light simulation.

- `LevelDocument.darkness?: number` is finite and bounded `[0,1]`. Absence inherits the current scene value; explicit `0` is a real override. `null`, strings and out-of-range values are rejected. Returning to inheritance emits an explicit `-=darkness` removal, not an undefined or null value.
- The GM diagnostic feeds the same effective darkness to fog queries and lighting rendering. Overrides ignore scene-wide darkness-animation hints, and switching diagnostic floors resets the ambient animation context instead of fading through the previous floor's brightness. Existing legacy/flat-scene lighting remains unchanged.
- Changing ambient light recomputes current sight but does not erase remembered exploration. It does not move tokens, change wall physics, disclose levels to players, or activate multiplayer multilevel gameplay.
- Validation, minimal editor diffs, atomic undo/redo, scene copy, autosave/reopen and format-3 archives preserve overrides. A separate additive `scene-level-ambient-v1` capability gates GM joins, override edits/removals, replay and archives. Supporting draft levels or light scopes alone is not enough; ordinary scene-darkness changes do not require the new capability.
- The GM editor disables ambient controls against an unsupported host. Drafts remain stripped from player replicas. No new approval workflow or implicit migration is introduced.

Verified: **5,400 Vitest passed / 12 skipped**, **10 Chromium journeys passed**, including an actual unlit floor revealing nothing, explicit inheritance enabling exploration, undo retaining fog memory and saved overrides surviving reopen. TypeScript, targeted ESLint and single-file build passed; Svelte 86 components / zero blockers / one existing ReplayPanel advisory. Player exposure plans, vertical lighting, fog reset generations and base-upgrade UX remain pending.

## Combined follow-up: reset UI and perception foundation (D-425 / D-426)

- **Live:** the GM level diagnostic now offers a confirmed, non-undoable reset of that floor's remembered exploration for all users. Captured generations fence delayed PNGs; a durable ledger prevents old structural history from resurrecting exploration. Other floors and legacy fog are untouched. Backup/restore carries reset generations and excludes obsolete PNGs.
- **Implemented and unit-tested, not live:** shared vertical sight/light queries and a host-only owned-observer exposure planner. Sealed planes block rays, apertures permit individual token visibility, darkvision cannot see through floors, and lighting distances include vertical scene units. Floor choices never grant access; private floor names and terrain remain withheld. Revisioned concealment is distinct from canonical deletion.
- **Still required for the requested combined milestone:** production geometry adapters, conservative visible terrain masks, host-issued player projection across snapshots/deltas/assets/FX/replay, matching client exposure barriers and action authority, then live vertical-light rendering. Player switching remains disabled rather than presenting a token-only filter as secure floor disclosure.

Verified: **5,410 Vitest passed / 12 skipped**, typecheck, targeted ESLint and single-file build. Chromium reset journey verifies cancel, clearing remembered fog under darkness and reopen. Svelte: 86 components / zero blockers / one existing advisory. The combined three-feature milestone is **not complete**.

## Player token-floor navigation (D-427)

Players now get a **Token floor focus** menu when the host assigns a non-hidden token they control to a saved level. The host supplies only their eligible floor names and validates selections. Actor ownership also counts. Selecting a floor limits token rendering and picking to that floor, intersected with normal fog visibility; **Shared scene · all floors** restores the existing display. Membership/ownership changes automatically refresh or withdraw choices. Reconnect discards the old session selection and fetches a fresh list. Switching does not move tokens or write history.

This is a deliberately limited navigation step, **not isolated player floor perception**. The menu warns that artwork, lighting and fog remain shared. It does not grant player per-level fog access, connect the physical exposure planner or redact existing scene/asset/FX/sheet data. Do not use it to protect secret stacked rooms. The full player view switch is still gated on those integrations.

Validation: **5,412 Vitest passed / 12 skipped; three Chromium journeys passed**, typecheck, targeted ESLint and single-file build passed. Browser coverage includes actual host/player joining, switching both ways, matching drawn/pickable token sets and withdrawing a floor after reassignment. Existing player sight and manual-mask journeys still pass.

## Important boundary

**The Faux Overhead cover itself is cosmetic, not a secrecy or physical-floor boundary.** It does not redact token data from transport, replace combat targeting permissions, mask strategic/3D models, or withdraw information already available in sheets/other UI. Older app builds ignore the new cosmetic field. Do not use this slice to simulate sealed, secret stacked floors.

A private draft level collection and draft archive/wire gates now exist. Explicit authoring membership is available at the host/API boundary, but D-428 now adds opt-in isolated player floor maps/fog and atomic stair travel. Comprehensive disclosure authority, active floor/ceiling support physics and cross-floor perception remain unfinished. Existing wall/door/window physical behavior is unchanged; the new tools edit their flat geometry. No general Foundry scene import is introduced.

## Remaining design work

| Slice | State / next work |
|---|---|
| M0 contracts | Source research and initial geometry contracts exist; unit semantics, physical-feature capability allocation and measured budgets still need completion |
| M1 structure/authoring | Flat wall tools, level drafts/editor/copy, membership/topology contracts, assignment UI, binding audit, floor scopes for drawings/templates/notes/regions (D-432), creation stamping (D-431) and the floor-play check with quick fixes (D-433) implemented; GM floor switch/build mode, bulk assignment, level generator and physical-feature client gates remain |
| M2 authority/physics | Finite-height wall/surface and body-sweep kernel; owned-observer exposure planner (not wired); stairwells v2 with host-revalidated private choices, locks, arrivals and attached followers (D-430). Path-crossing triggers/route continuation, door-linked locks, live surface physics, revision/index ownership and complete host redaction remain |
| M3 perception/fog | Opt-in player floor maps, scoped lighting/ambient, per-level fog/reset and token-follow views implemented; full secret-data projection, cross-floor masks/vertical rendering and scoped audio remain |
| M4 Faux/advanced barriers | Initial native solid cover implemented; authorized token-only ghosts, keep-lit art, roof assemblies, proximity/limited channel policies and advanced door/window presentation remain |
| M5 portability/acceptance | Draft archive and live capability gates implemented; physical-feature negotiation, full multilevel/fog archive schema, external adapters, audit, large-world performance and cross-browser/mobile acceptance remain |

Do not enable full stacked-floor play before the M1–M3 authority/fog/compatibility gates are in place. Baileywiki source availability is **not** a prerequisite; remaining code will be native as well.

## Validation performed

- Full Vitest run after the capability slice: **5,364 passed, 12 skipped; 380 files passed, 2 skipped**. Added negotiation tests cover welcome ordering, legacy GM refusal/player privacy, historical replay fallback, undo/redo retry, pending approval and stale-transport fencing. Includes deterministic picking, shared joints, metadata preservation, protected splits, atomic rollback, gesture cancellation, host stale-edit rejection and player rejection.
- Latest built single-file UI/browser validation: **12 Chromium browser tests passed**. The new level editor journey covers validation, stable IDs, atomic undo/redo and save/reopen. New tests exercise actual corner/split toolbar gestures, detached previews, atomic undo/redo, door/window protection, Escape/blur/pointer cancellation and outside-canvas release. Regression journeys cover Faux Overhead GPU pixels/editor, existing wall/door/window physics, zoom, saves and two real manual-join player-fog journeys.
- TypeScript and targeted ESLint passed. Svelte compilation check: 85 components, no blocking issues; one existing ReplayPanel advisory.
- Production single-file build succeeded (~4.929 MB before compression); root source `index.html` is unchanged. Firefox/WebKit/mobile, 3D models, dense scene performance, cross-level combat and sealed-stack acceptance are **not** claimed.

New source: `src/core/multilevelGeometry.ts`, `fauxOverhead.ts`, `regionValidation.ts`, `wallEditing.ts`, `levels.ts`, `capabilities.ts`, `src/ui/images/LevelDraftEditor.svelte`, `src/core/spatial/kernel.ts`, `src/canvas/layers/FauxOverheadLayer.ts`, `src/canvas/tools/wallEditor.ts`, `src/ui/macros/FauxOverheadEditor.svelte`. Existing document, host validation/import, stage, pointer, tool, toolbar and GM/player-shell paths are integrated rather than replaced.
