# Multilevel implementation status

**2026-10-11 — native cover, wall-authoring, spatial-kernel, GM level-draft and draft wire-compatibility slices; the complete design is not finished.**

Target: [Multilevel, walls and Faux Overhead design](MULTILEVEL_WALLS_DESIGN.md).

## Current player experience: isolated maps, stairs first (D-428)

The earlier token-only focus limitation is superseded for scenes with **isolated floor play** enabled. Players see one floor's assigned map tiles/background, scoped walls/lights, effective ambient and separate remembered exploration—not three overlapping maps. The default view follows a controlled token. Walking into a GM-authored stair region changes floor and feet elevation atomically, and the view follows automatically. Manual floor selection is a collapsed fallback.

### Set up a playable stack

1. Place each floor map as a scene tile using the normal image tools.
2. In **Scenes → Draft levels**, create/save the floors. Tick each floor's map tiles; optionally assign the existing scene background to one floor. Set ambient overrides if needed.
3. Under **Membership**, assign tokens, walls and lights. Unassigned tiles/walls/lights do not participate in the isolated player floor.
4. Open **Floor artwork & stair travel**. Choose source/destination floors and rectangle bounds in scene pixels. **Create return stairs** makes the reverse direction at the same XY. Existing Active Zones authoring can edit region polygons/rotation.
5. Enable **isolated floor play**. Compatible players follow their controlled token; finish a move with its center inside the stairs. For the return direction, leave the region and enter again.

Legacy scenes are not silently migrated. The new option excludes the global foreground and unscoped drawings, notes, templates, cosmetic regions, sounds and hexcrawl layers; these need explicit floor authoring before being restored. Legacy manual fog masks are not copied across floors. The GM's legacy diagnostic remains an all-art authoring view.

The host rejects ambiguous overlapping stairs and source/landing wall collisions. No spawn/undo bounce or automatic relocation of attached/summoned tokens. Save/reopen, archive copies and scene duplication preserve/rekey configuration. Floor selection itself is session state, not a document edit or movement command.

**Remaining:** comprehensive snapshot/asset/sheet/FX secrecy, cross-floor sight/light/terrain masks, scoped auxiliary authoring, audio and full cross-floor action/support physics. This is discrete playable-floor rendering/travel, not completion of the entire multilevel design.

Validation: **5,416 Vitest passed / 12 skipped; five Chromium journeys passed**. The new browser journey drags an actual player's token through stairs and checks GPU map pixels changing red→blue→red at the same coordinates, isolated dark-floor fog and remembered ground-floor exploration on return. Typecheck, targeted lint and single-file build passed; Svelte 87 components / zero blockers / one existing advisory.

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
| M1 structure/authoring | Flat wall tools and private embedded level drafts/editor/copy implemented; explicit membership/topology contracts implemented; assignment UI and binding audit implemented; scoped drawing, level navigation, base-level upgrade and physical-feature client gates remain |
| M2 authority/physics | Isolated finite-height wall/surface and body-sweep kernel implemented; isolated owned-observer exposure planner added; live adapters, revision/index ownership, movement/portal permissions, stairs and complete host redaction remain |
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
