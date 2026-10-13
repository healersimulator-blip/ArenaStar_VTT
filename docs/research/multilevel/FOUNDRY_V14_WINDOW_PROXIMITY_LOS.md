# Foundry V14: proximity windows and attenuated line of sight

**Research date:** 2026-10-12  
**Scope:** Foundry's documented window/proximity behavior; current ArenaStar wall-LOS paths; a proposed implementation sequence.  
**Evidence rule:** Foundry core is proprietary. This note uses Foundry's public wall documentation and V14 release notes; the pseudocode below is an ArenaStar design sketch, **not Foundry source code**. No Foundry instance was run to measure its attenuation curve.

## Short answer

The behavior described by the user is Foundry's **Proximity** restriction with **Proximity Threshold Attenuation** enabled on the wall's sight channel. A far viewer gets little or no view past the window; as the viewer approaches, the allowed sight depth behind the opening grows; next to the wall, the viewer can use their normal sight range. This is not a separately authored angular-cone angle: the finite wall segment and the per-ray depth cap make the visible area look like a narrow wedge/cone behind the window.

Foundry also documents **Reverse Proximity**, which reverses the eligibility side and attenuation progression, and **Limited**, where one limited wall can be passed but the next Limited or Normal wall stops the ray. Sight, light and sound restrictions are independent. Proximity attenuation applies to light and vision, **not sound**.

The public documentation describes the monotonic behavior but does **not** publish the exact attenuation function. Do not claim a byte-for-byte or formula-level Foundry match without measuring a V14 instance or obtaining a more precise API contract.

## Sources

- Foundry's [Walls article](https://foundryvtt.com/article/walls/) documents None, Normal, Limited, Proximity and Reverse Proximity; the threshold; attenuation; wall direction; and the sound exception.
- Foundry V14 [release 14.349](https://foundryvtt.com/releases/14.349) explicitly records fixing a bug where proximity attenuation was not functioning. This confirms the behavior is part of the V14 canvas path, not just a predecessor-module feature.
- Existing project source index: [`SOURCES.md`](SOURCES.md#foundry-v14-primary-references). It already records the public Walls article and the limitation that Foundry core source was not inspected.
- Related ArenaStar target contract: [`MULTILEVEL_WALLS_DESIGN.md`](../../../MULTILEVEL_WALLS_DESIGN.md) §4.4 (barrier model) and §5 (authoritative perception/replication).

## Documented behavior, normalized

| Restriction | Sight/vision behavior |
|---|---|
| None | Pass the wall. |
| Normal | Stop at the wall. |
| Limited | Pass this Limited wall, but do not see past a later Limited or Normal wall on the same ray. |
| Proximity | Pass only when the viewer/source is within the configured distance threshold of the wall. |
| Reverse Proximity | Pass only when the viewer/source is outside the configured threshold. |

For **Proximity** and **Reverse Proximity**, attenuation off makes the rule binary: fully pass or fully block according to the threshold. With attenuation on, sight/light penetration depends on the viewer/source's distance to the wall. For Proximity, being barely inside the threshold gives short penetration; moving closer gives more; immediately next to the wall permits the ordinary maximum range. Reverse Proximity has the corresponding progression on the far side of its threshold. The documentation says sound remains binary because sound volume already depends on source-to-listener distance.

Wall direction still matters: a restriction may apply from both sides or only its configured side. A window is therefore better represented as a wall with independent channel policies than as a special always-transparent sprite.

### Reference algorithm sketch (not Foundry code)

The documented contract can be implemented as an observer-specific ray policy. The exact `attenuationDepth` curve below is intentionally a named policy boundary; Foundry's public article does not provide its formula.

```ts
for (const hit of orderedWallHitsForRay) {
  if (!wallAppliesFromThisSide(hit.wall, viewer)) continue;

  switch (hit.sight.mode) {
    case "normal":
      return stopAt(hit.distance);
    case "limited":
      if (passedLimitedWall) return stopAt(hit.distance);
      passedLimitedWall = true;
      break;
    case "proximity":
    case "reverseProximity": {
      const d = distanceFromViewerToWallSegment(viewer, hit.wall);
      if (!eligibleByThreshold(hit.sight.mode, d, hit.sight.threshold)) {
        return stopAt(hit.distance);
      }
      if (hit.sight.attenuation) {
        // Perpendicular viewer-to-wall distance controls depth beyond the crossing.
        // The ordinary sight radius remains the final upper bound.
        rayLimit = Math.min(rayLimit,
          hit.distance + attenuationDepth(d, hit.sight.threshold, sightRadius));
      }
      break;
    }
    case "none":
      break;
  }
}
return castTo(Math.min(rayLimit, sightRadius));
```

A linear candidate for ArenaStar would be `depth = sightRadius * clamp(1 - d / threshold, 0, 1)` for Proximity, with the reverse curve mirrored around the threshold. **That is a proposed ArenaStar policy, not a verified Foundry formula.** The window endpoints make this finite depth visible as a wedge; a later solid wall still clips it. A floor/ceiling surface is a separate hit and must still block a ray through its solid footprint—an open vertical window must never punch a hole in a horizontal floor plane.

## What ArenaStar does today

### Flat-scene canvas LOS

- `WallDocument` (`src/core/documents.ts`) only has the legacy per-axis codes `0=blocks`, `1=conditional on door`, `2=permits`. It has no proximity mode, distance threshold, attenuation flag, window sill/head height or authored Z span.
- The current Window preset (`src/canvas/vision/wallKinds.ts`) writes sight/light `2` (fully permitted), movement/sound `0`, with no window distance setting.
- `sightSegments()` (`src/canvas/vision/wallSight.ts`) includes only walls that fully block sight. A current Window is omitted, so LOS passes through it at full range at every viewer distance.
- `visibilityPolygon()` (`src/canvas/vision/polygon.ts`) sweeps static opaque 2D segments around the observer. It has a radius cap, but no observer-specific window rule or depth-after-opening cap.

### 2.5D/floor LOS

- `SpatialKernel` can trace 3D rays through wall barriers and horizontal floor surfaces; vector holes in a floor surface are already meaningful openings.
- `SpatialPerception.clear()` (`src/core/spatial/perception.ts`) currently treats **any** sight hit as blocked. `legacySpatialBarrier()` maps only the old `0/1/2` restriction and door state; it has no Limited/Proximity/attenuation policy.
- Floor openings and window openings are different geometry: floor openings are holes in a horizontal surface; windows are apertures/restrictions on vertical wall segments. The existing floor-opening behavior does not provide proximity-window behavior.
- Foundry import currently reports that Limited, Proximity and distance-sense walls are simplified to blocking walls (`src/core/foundryImport.ts`). That is lossy and should remain explicit until those policies can be represented.

**Conclusion:** the codebase has useful 2D angular sweep and 2.5D ray/surface primitives, but no shared window-LOS model. The simple window is currently fully transparent, while the cross-floor perception path is binary clear/blocked.

## ArenaStar product requirement (user direction, 2026-10-12)

The scene-level policy is the normal authoring path; GMs should not have to tune every window. Per-opening overrides are an exception for unusual geometry.

- In **Scene Settings**, configure the viewer-to-opening distance at which the **partial/small cone** applies, its depth beyond the opening and its angular width; configure a closer distance at which the **full cone** applies, with its own depth/width. The ordinary token sight range remains an upper bound unless a separate explicit product choice says otherwise.
- Select which opening categories inherit the scene rule: **windows**, **doors**, and **floor/ceiling apertures**. Define doors as eligible only while physically open; a closed or locked door remains a hard blocker.
- Provide a scene-level **Off** choice: by default, included openings then pass ordinary full LOS, preserving current behavior. An explicit local override may still opt that one opening into a custom policy.
- Right-click an individual wall/opening to choose **Inherit scene**, **Full LOS**, or **Custom**. Custom exposes the same distance/partial/full controls as the scene rule.

### Proposed resolution model

Distances are viewer-to-opening distances in declared scene units. `partialAt` is farther than `fullAt`. Beyond `partialAt`, there is no LOS beyond an included opening; at `partialAt`, use the partial cone; between the two values, interpolate depth and width; at/below `fullAt`, use the full cone. An initial implementation can use linear interpolation, but that is an ArenaStar policy choice—the Foundry article does not specify its curve.

```ts
interface OpeningCone {
  /** Maximum sight distance past the opening; `normal` means the token's own sight range. */
  depth: number | "normal";
  /** Full angular width, in degrees; the physical opening still clips possible rays. */
  widthDeg: number;
}
interface SceneOpeningSightPolicy {
  enabled: boolean;
  applyTo: { windows: boolean; doors: boolean; apertures: boolean };
  partialAt: number; // farther viewer-to-opening distance
  partial: OpeningCone;
  fullAt: number; // nearer viewer-to-opening distance
  full: OpeningCone;
}
type OpeningSightOverride =
  | { mode: "inherit" }
  | { mode: "full" }
  | { mode: "custom"; policy: SceneOpeningSightPolicy };
```

Policy precedence should be: physical blocker/state first (including closed/locked doors); then an explicit opening override; then the applicable scene policy; otherwise the current unrestricted behavior of the opening. A sight ray must actually intersect the opening geometry. Its configured cone may narrow that set, never create rays through surrounding solid wall or floor.

**Data-model implication:** current walls do not store an explicit `window` kind, and traced `LevelSurface` holes do not have stable per-hole IDs. Scene-category matching needs an explicit/normalized opening category; per-wall overrides need a wall field, and per-hole overrides need stable aperture IDs (or a deliberate first-slice limitation to whole-floor-surface overrides). Do not make a context-menu override require every opening to be edited.

## Recommended ArenaStar update plan

### Slice 1 — scene policy and compatibility

1. Add optional scene-level settings for partial/full distances, depths and angular widths, plus category checkboxes for windows, doors and floor apertures. Default absent settings to the current full-LOS behavior.
2. Add a sparse per-wall override (`inherit`, `full`, `custom`). For surface apertures, choose either stable per-hole records now or defer per-hole overrides explicitly; avoid an ambiguous raw array index as an identity.
3. Preserve legacy `0/1/2` restriction semantics. Keep sight independent from light and sound in this feature; only adopt Foundry's binary sound gate in a separately scoped change.
4. Validate `partialAt > fullAt`, finite/ranged lengths and widths, and distance units. Start with one documented ArenaStar interpolation curve; don't claim its formula is Foundry-identical without measurement.
5. Put precedence and geometry in a pure shared resolver, not UI conditionals or inferred `window` labels.

### Slice 2 — ordinary 2D sight polygon

1. Extend the observer-specific angular ray sweep so a ray through an eligible opening is capped at `openingIntersection + permittedDepth` and constrained to the configured angular width. Do not simply remove a proximity window from `sightSegments()`.
2. Sort wall hits along each ray. A normal blocker still stops it; Limited-wall allowance is consumed in order; later blockers remain effective; proximity caps cannot reveal past a nearer obstruction.
3. Recompute as the observer moves. Preserve endpoint epsilon behavior, one-way direction, the token's ordinary sight radius, fog/explored-map semantics and existing full-pass windows when policy is absent/off.

### Slice 3 — floors and host perception

1. Reuse the same policy in `SpatialPerception`; return ordered 3D intersections and distances rather than reducing every sight ray to `any hit`.
2. Apply it to floor-aperture crossings only when the scene category includes apertures. Keep the solid portion of each `LevelSurface` authoritative; a window policy must not bypass a solid floor plane.
3. Make host exposure and client rendering use the same policy. Client LOS must not by itself authorize hidden lower-floor tokens.

### Slice 4 — editor, importer and rollout

1. Put the default controls in **Scene Settings**. Add a concise preview/example, with partial and full cones visualized from a sample opening.
2. Add a right-click wall/opening settings action for the sparse local override, defaulting to **Inherit scene**. The panel should show the inherited scene values before offering custom fields.
3. Import Foundry restriction modes/thresholds where present; preserve and report unmapped data rather than silently converting it to a normal blocker.
4. Add the required wire/archive capability before new policy fields can be committed/restored by mixed-version clients.

### Acceptance tests

- At/behind `partialAt`: no view past the opening; at that distance: exact configured partial depth/width; between keyframes: monotonic interpolation; at/inside `fullAt`: configured full cone, still capped by ordinary token sight range.
- Test a wider and narrower opening, angled approach, both wall sides, endpoints, threshold boundaries, rotations, and another blocker behind the opening.
- Scene category selection independently targets windows, open doors and floor apertures. Closed/locked doors remain blockers.
- **Inherit**, **Full LOS**, and **Custom** overrides resolve correctly; local overrides remain sparse; scene Off means full LOS except where an explicit override applies.
- No ray escapes the real opening, a solid floor still blocks, and a traced floor hole permits vertical LOS only through its footprint.
- Playwright pixel/LOS tests compare far/partial/intermediate/near observers, assert cone depth and width, and verify that fog does not explore beyond the resolved cone.
- Legacy scenes/windows with no scene policy render exactly as they do now.

## Suggested first implementation scope

Start with **scene-level defaults for opt-in 2D window sight**, including the two distance keyframes, partial/full depth and angular width, category selection, and sparse wall overrides. Preserve legacy behavior when settings are absent. Then reuse the same policy for doors and floor apertures through the 2.5D kernel. The scene policy is the default; per-opening editing stays optional.
