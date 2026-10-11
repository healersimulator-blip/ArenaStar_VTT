# Annotated snippets for the standalone ArenaStar design

Companion to [the design document](../../../MULTILEVEL_WALLS_DESIGN.md) and [source audit](SOURCES.md).

## Provenance and scope

These are **original ArenaStar-oriented design snippets**, not pasted/adapted upstream implementation blocks. Monk's mechanisms were inspected and have pinned source-reading cards M01–M15; Better Levels behavior was studied from publisher documentation but its implementation archive was not retrieved. There is consequently **no purported Better Levels shader excerpt** here. Ripper's predecessor implementations are now separately inspected in [reading cards R01–R12](RIPPER_PREDECESSORS.md); the additional pseudocode below expresses native design contracts, not transplanted upstream functions.

The repository's current adoption policy requires a closed review before third-party implementation is committed. The source-reading cards save the useful upstream *locations and reasoning*; these snippets save applicable *local contracts*. They are not a claim of legally certified clean-room provenance after source inspection.

Executable versions of the narrow helpers below are in [design-kernels.mjs](design-kernels.mjs). They have no runtime dependencies and are **not imported by the app or bundled into `index.html`**. The interface sketches and pipeline pseudocode below are non-executable design material.

Run their specification checks:

```sh
node --test docs/research/multilevel/design-kernels.test.mjs
```

## S1 — Half-open level membership

**Motivation:** native V14 elevation bands; independent ArenaStar boundary policy. A token at 10 must not unpredictably belong to both 0–10 and 10–20.

```js
export function levelAtZ(levels, z) {
  if (!Number.isFinite(z)) throw new Error("Elevation must be finite");
  const matches = levels.filter(level =>
    (level.bottom === null || z >= level.bottom) &&
    (level.top === null || z < level.top));
  if (matches.length > 1) throw new Error("Overlapping level bands");
  return matches[0]?.id ?? null;
}
```

Inputs are prevalidated bands; `null` is an open bound, not an infinite JSON number. `null` result is a gap/out-of-stack condition, not permission to teleport. Actual native documents use `_id`; the tiny fixture DTO uses `id`. Do not directly replace the existing **inclusive** `triggerElevation` tests with this helper: those are a different legacy contract.

## S2 — Level-safe snapping in screen-space units

**Source-reading motivation:** Monk cards M03/M08. Existing ArenaStar `wallPickAt` already accepts a world-space tolerance; extend the same convention rather than copying Foundry interaction hooks.

```js
const worldTolerance = cssTolerance / cameraScale;
const candidates = endpointIndex.query(pointerWorld, worldTolerance)
  .filter(endpoint => endpoint.topologyKey === activeTopologyKey && !endpoint.locked);
// Compare squared distance, then wall ID (fixed lexical ordering), then endpoint 0/1.
// Freeze the chosen adjacency set for the duration of the gesture.
```

`endpointIndex` is proposed, not present. The executable `nearestEndpoint` intentionally uses a small linear scan so its contract can be tested independently of the future spatial index. A topology key includes scene, canonical level scope and vertical span; coincident points on different floors never join. The key is separate from the optional user selection set.

Do not multiply by device pixel ratio when tolerances are already CSS pixels. Grid snapping and endpoint snapping have explicit precedence; Shift bypasses both. A locked connected endpoint is a separate edit-plan conflict, not something that a nearest-point search may silently unlock.

## S3 — One undoable wall split, not two network writes

**Source-reading motivation:** Monk M05 performs the geometric split; M03 manually combines history. ArenaStar already has rollback/inverse-aware `OpEnvelope` transactions.

```ts
// Proposed transaction assembly. `point` is projected onto the segment by our own picker.
const parent = { coll: "scenes", id: sceneId };
const ops: Op[] = [
  { kind: "update", ref: { coll: "walls", id: wall._id, parent },
    diff: { c: [ax, ay, point.x, point.y] } },
  { kind: "create", coll: "walls", parent,
    data: { ...detachedCopyOfWall, _id: newId,
      c: [point.x, point.y, bx, by] } },
];
// Submit ONE intent; the host validates the entire plan before committing ONE envelope.
```

The tested `planPlainWallSplit` rejects endpoint/zero-length splits and all explicit or legacy portals, deep-copies metadata and preserves direction/scope/height. It is **not** the finished planner: host revision checks, ownership, reference migration, minimum visual segment length, new-ID uniqueness and portal group semantics still belong to production implementation. Avoid cloning a door into two independently operable doors or retaining the wrong prefab membership.

For general join/drag, accumulate one final coordinate array per wall ID; repeated endpoint visits merge into that array. Never submit one update per endpoint, and never mutate the persistent wall document during pointer-move preview.

## S4 — Elevation-aware surface intersection

**Motivation:** Foundry's documented Define Surface contract. This is basic analytic geometry, not inspected Foundry source.

```js
const dz = target.z - eye.z;
// Parallel/coplanar is a separate result; do not divide by zero or assume it is visible.
const t = (surfaceZ - eye.z) / dz;
const crossing = {
  x: eye.x + t * (target.x - eye.x),
  y: eye.y + t * (target.y - eye.y)
};
// A blocking crossing needs t within the ray AND crossing in solid footprint minus holes.
```

The executable `crossHorizontalPlane` returns `none`, `coplanar` or a bounded point with `t`. It does **not** implement polygon subtraction, target visibility, tangency/contact policy or a complete collision sweep. The test with eye Z=25, target Z=5 and plane Z=10 yields `t=0.75`; checking the XY midpoint would inspect the wrong point.

Wall extrusion queries similarly interpolate ray Z at each 2D segment hit. A worker accepting only XY segment arrays cannot establish this on its own. The production worker needs a versioned input contract, shared robust predicates and source/target heights.

## S5 — Faux Overhead presentation cannot manufacture LOS

**Motivation:** publisher-documented Faux Overhead and its level/fog/interaction regressions; no Better Levels source copied.

```js
if (!authorized || (!visibleByLos && !privileged)) {
  return { mode: "hidden", targetCandidate: false, hitTest: false };
}
if (visibleByLos) {
  return {
    mode: preference === "hidden" ? "ghost" : preference,
    targetCandidate: true,
    hitTest: true
  };
}
return { mode: preference, targetCandidate: false, hitTest: preference !== "hidden" };
```

This helper is called only for an **already geometrically covered token**. `authorized` comes from host exposure, not a checkbox. `privileged` is owned-token/GM diagnostic display. `targetCandidate`/`hitTest` mean presentation eligibility; ordinary target permissions, ownership and system actions are still independently checked. A full-size diagnostic sprite does not grant combat LOS.

A production caller must first verify that the region affects this token's level, cover Z is above the token, and the pixel lies inside the region excluding holes. Apply the result consistently to token art, labels, bars, badges, targets and pointer picking. Don't create a second independent token object for the ghost.

## S6 — Three different masks

**Motivation:** Better Levels' documented keep-lit basement regression. ArenaStar should prevent the category of failure rather than imitate an unknown shader implementation.

```text
visibleNow(surface, pixel) = authorizedSurface ∩ geometricSight ∩ illuminationPolicy
exploredNext(surface)      = exploredPrevious(surface) ∪ visibleNow(surface)
artBrightness(surface)     = normalLighting OR scopedKeepLitArt

finalArt = artBrightness, still clipped by the permitted surface's visibility/history fog
finalToken = authorized token + current perception + Faux clip/ghost policy
```

This is pipeline pseudocode, **not a shader**. Bright artwork is not the same thing as explored terrain or a seen token. `keepLitArt` must never write into `visibleNow` or a scene-global history mask. Region holes and unrelated basement planes remain excluded. Ordinary gameplay may display remembered terrain dimly, but current enemy tokens do not persist merely because the floor was explored earlier.

## S7 — Collision-free fog identity

```js
export function fogKey(worldId, sceneId, levelId, userId) {
  if (![worldId, sceneId, levelId, userId].every(value =>
      typeof value === "string" && value.length > 0)) {
    throw new Error("Fog identity is incomplete");
  }
  return JSON.stringify([worldId, sceneId, levelId, userId]);
}
```

This is an in-memory cache key example. IndexedDB should use the actual compound key `[worldId, sceneId, levelId, userId]`. Do not concatenate unchecked IDs with colons and assume no collisions. Wire/user identity comes from the session, not a claimed user field. Legacy PNGs migrate to base only.

## S8 — Freeze, validate, commit, then invalidate

**Motivation:** existing ArenaStar architecture plus Monk's multi-point operations and Better Levels' audit workflow.

```text
capture scene + affected document revisions
    → build detached preview plan
    → validate geometry, references, permissions and all new invariants on staged state
    → submit one host transaction (or reject stale plan)
    → update indexes/perception revision from committed document changes
    → emit ordered exposure deltas and post-commit automation events
```

Do not call a nonexistent transaction API from a Foundry module. Use ArenaStar's existing Intent/OpEnvelope path; extend its preflight for cross-document level/surface references. The existing store supplies rollback on apply failure, but it does not automatically supply every new semantic check. A bulk audit fix is the same kind of explicit edit plan; the routine save flow remains automatic.

## S9 — Indexed roof groups affect presentation only

**Motivation:** [R03](RIPPER_PREDECESSORS.md#r03--linked-occlusion-is-useful-but-should-be-indexed-and-deterministic). Original pipeline pseudocode, not an executable module adapter.

```text
members = authorized roof art eligible for this observer/view and cover height
index members by [sceneId, assemblyId, groupId]
direct = immutable snapshot of independently computed direct fades
activeGroups = groups with an eligible source member in direct
result = direct plus eligible followers in activeGroups
```

Keep geometry and authority inputs outside this cosmetic result. A follower never grants visibility or feeds a fog-exploration write. Empty group IDs do not link unrelated roofs. Use an explicit selected-observer or party policy, not selection-array order. Index construction/evaluation is linear in member count rather than a pairwise tile scan. Group application still needs real render/permission tests.

## S10 — Fence asynchronous fog extraction

**Motivation:** [R08](RIPPER_PREDECESSORS.md#r08--per-level-fog-uses-surrogate-scene-records). Original lifecycle pseudocode; not an IndexedDB implementation.

```text
capture ticket = { compoundKey, lifecycleEpoch, contentRevision }
extract pixels from the corresponding immutable/staged texture
in one storage transaction:
    read record at ticket.compoundKey
    reject if missing, reset/recreated, or revision superseded
    persist pixels only to ticket.compoundKey
    mark only the successfully written revision clean
attach pixels to the view only if its key and view revision still match
```

A valid A-floor save can complete after navigation to B; navigation is not permission to write A pixels under B's key. A reset/deletion must invalidate older tickets even if the same display name or record ID is reused. Extraction/storage failure leaves the affected revision dirty and retryable, without clearing newer work. Epoch allocation, extraction snapshot ownership and transactional checks need production tests; this sketch does not claim to solve those races by itself.

## What is tested versus still proposed

The accompanying **12 specification tests** cover membership boundaries, invalid/overlapping bands, zoom tolerance, level-partitioned snapping and ties, non-mutating split plans/portal rejection, ray-plane math, permission-safe presentation selection and level/user-safe fog keys.

S9–S10 are additional design pseudocode and are **not covered by these 12 tests**. The predecessor acceptance matrix is planned, not passing engine coverage.

They do **not** establish full multilevel implementation, polygon/holes correctness, GPU clipping, player authority, Foundry interoperability or performance. Those require the staged acceptance plan in the main document. No production tests are replaced or weakened by these research examples.
