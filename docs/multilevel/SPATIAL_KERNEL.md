# Native spatial kernel contract

Implemented in `src/core/spatial/kernel.ts`; conformance tests in `tests/core/spatialKernel.test.ts`.

**Status: isolated production-source foundation, not connected to live movement, fog, lighting, audio or host disclosure.** There is no new editable world field, serialization format, capability or floor-enable switch in this slice. Existing flat scenes still run through the existing paths. This kernel must not be advertised as a secure multilevel implementation.

## Inputs and units

- XY and rectangular footprint dimensions are scene pixels. Z and body height are scene distance units, consistent with the design's proposed contract. No existing token elevation is converted or overwritten.
- `SpatialBarrier` carries an ID, directed XY segment, half-open elevation span, independent move/sight/light/sound restriction codes, door state and explicit crossing direction.
- Restriction codes retain ArenaStar semantics: 0 blocks, 1 obeys door state, 2 permits. Open conditional doors pass; closed and locked conditional doors block. A window can therefore permit sight/light but block movement/sound without a special-case geometry type.
- `legacySpatialBarrier` copies legacy geometry/codes into an unbounded, conservatively two-sided barrier. It does not reinterpret legacy `oneWay` as a newly specified directional policy. This adapter is available for integration tests; it does not replace the current movement pipeline.
- `SpatialSurface` has a normalized V2 component/holes footprint, a world transform and 1–8 horizontal planes. Rotation is in degrees around the transformed rectangle's center. Each plane independently declares blocking channels and whether it is an authored support plane. All planes share the same openings.
- No level membership or viewed-floor field participates in physical queries. A future caller must supply physical geometry from the full scene, not just the currently edited floor.

`new SpatialKernel(walls, surfaces)` validates and copies its inputs into a detached snapshot. Mutating the caller's arrays, door state or plane data cannot silently change that snapshot. A scene-revision cache/invalidation owner is still needed when integrating it into the host/worker paths.

## Queries

### `ray(from, to, axis)`

Returns all contacts, ordered by travel time, kind, stable ID and plane index. Wall height is tested **at intersection time**, not at either endpoint's level. Walls include the bottom and exclude the top of their authored height span. Collinear and vertical-on-wall rays are handled as intervals rather than discarded as parallel.

Surface endpoint contact blocks when a non-coplanar ray starts or ends on a solid plane. Coplanar rays do not cross a horizontal sheet. This is deliberately more conservative at endpoints than the older low-level `surfaceRayHit` strict-interior helper; that helper and its existing callers are unchanged. Hole interiors pass; rims are solid. Component union is local-hole-aware: another component can fill an opening.

Direction is the sign of the change in `cross(B - A, point - A)` for the authored wall order. `positiveCross` and `negativeCross` block the respective direction. Tangential contact remains conservative. This is a mathematical crossing rule, not an observer-relative visibility or door-use policy.

### `sweep(body)`

Continuously sweeps a rectangular body with a **constant** orientation and dimensions between two feet positions. No fixed-step sampling is used in collision detection.

- Segment/footprint intersection uses continuous separating-axis intervals.
- The same time interval must also overlap the wall's vertical span; independently intersecting XY/Z bounding boxes are insufficient.
- A horizontal surface intersects the body's interior only while `feetZ < planeZ < feetZ + bodyHeight`. Walking exactly on a floor or fitting exactly under a ceiling is not penetration.
- Surface boundaries are tested against the entire swept footprint, not just its center or a few sampled eye rays. This catches thin islands and shoulders/head clipping an opening.
- Contact with hole rims is conservative, including simultaneous horizontal/vertical grazing. A collision time is the earliest contact bound, not a guaranteed safe automatic stop position. Callers need a movement response/clearance policy, not a blind clamp to `t`.
- XY contact tolerance is `1e-7` pixels. Z membership uses explicit open/closed inequalities, not an arbitrary height epsilon.

This query checks collision, not whether movement is legal. It does not implement changing rotation, changing body dimensions, support over an entire footprint, gravity, stairs, flight rights, swept transition activation, move budgeting, actor permissions or token disclosure.

### `supportBelow(point)`

Returns the highest explicitly authored support plane at/below a point, or null. There is no inferred full-scene floor. Holes and transformed footprints apply. Equal-height results have deterministic ID/plane ordering.

This is a **center probe**, not evidence that a whole body is supported or authorized to arrive there. Do not use it alone to accept movement.

## Validation and resource boundaries

Compilation and queries throw on invalid inputs. Callers must reject/report the failure; never catch an error and treat it as clear space.

- Finite bounded coordinates and elevations within ±1,000,000; null is permitted only for unbounded wall-span endpoints.
- Nonzero wall segments (at least 0.01 pixels), valid half-open bands, valid directions and channel codes.
- Dimensions at least 0.001, finite bounded rotations, valid normalized topology. Transformed surface vertices must remain in coordinate bounds; collapsed world-space edges are rejected.
- Unique IDs within each geometry kind, at most 128 characters. Wall and surface namespaces are distinct.
- At most 10,000 walls, 128 surfaces, 4,096 total normalized surface vertices and 8 planes per surface. Existing per-footprint shape limits also apply.
- Sparse arrays, malformed channels and invalid numeric queries are rejected rather than silently omitted.

These are defensive work limits, **not measured interactive performance acceptance**. The first implementation is a linear snapshot query with analytic narrow-phase checks. Broad-phase indexing, caching, worker integration and dense-scene budgets remain open.

## Evidence and integration gates

29 kernel tests cover finite/unbounded heights, conditional independent channels, direction, segment endcaps, vertical/collinear rays, simultaneous XY/Z clearance, rotated body footprints, surface transformations, openings/rims, component unions, support semantics, detached snapshots, deterministic ordering and malformed inputs.

A deterministic fixture matrix compares the legacy adapter with existing point and rotated-footprint movement predicates. Seeded continuous-vs-occupancy checks exercise 150 sweeps at 41 occupancy samples each; sampling is test evidence, not the runtime algorithm. A basement/ground/upper/roof fixture proves geometric separation and door-height isolation. **It does not prove multiplayer authorization, secrecy or fog isolation.**

Before live stacked-floor play: stable level records/scopes and explicit migration; validated scene adapters; host movement/portal authorization; synchronized revisioned worker queries; host exposure/projection; per-level fog and stale-job fencing; archive/wire compatibility gates; actual sealed-stack multiplayer, persistence, dense-scene and browser acceptance.
