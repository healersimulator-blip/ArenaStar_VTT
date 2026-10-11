# Ripper predecessors: Levels and Better Roofs

**Research date: 2026-10-10 · static source inspection · design only**

Companions: [main design](../../../MULTILEVEL_WALLS_DESIGN.md), [source audit](SOURCES.md), [exact file SHA-256 pins](source-pins.json), [original examples](SNIPPETS.md).

## 1. Scope and identity

These repositories provide actual implementation evidence for **Ripper's predecessor systems**. They do **not** establish how Baileywiki Better Levels implements Faux Overhead, shaders, ghost hit testing or audit rules. That module's archive remains unavailable. No Foundry runtime was launched and no upstream behavior was reproduced here.

Default branches already target Foundry V14. To study the older integrated system, this review also pinned V13-era tags:

| Source | Inspected identity | Compatibility in source manifest | Role |
|---|---|---|---|
| [Better Roofs](https://github.com/theripper93/Better-Roofs/tree/df35cca8c73e7e8d420a81aada7b65c591c06d82) | tag `3.0.0`, commit `df35cca8c73e7e8d420a81aada7b65c591c06d82` | Foundry 13 | Predecessor roof masks and linked occlusion |
| [Levels](https://github.com/theripper93/Levels/tree/17d4cfdd674b45e4abf4235416a23f889ba12163) | tag `6.1.0`, commit `17d4cfdd674b45e4abf4235416a23f889ba12163` | Foundry 13 | Predecessor elevation, visibility, transitions and fog |
| [Better Roofs](https://github.com/theripper93/Better-Roofs/tree/83867b4d5b34711e7bec52d91946b1f1f170dbb9) | main/tag `4.0.2`, commit `83867b4d5b34711e7bec52d91946b1f1f170dbb9` | Foundry 14 | Compare integration after native levels |
| [Levels](https://github.com/theripper93/Levels/tree/230f3ac3d784932f15dad84fb43aa1dc66000b42) | master, commit `230f3ac3d784932f15dad84fb43aa1dc66000b42` | Foundry 14 | Migration/native-surface adapter comparison |

Some manifest version strings differ from tag labels (notably Levels `4.2.7`, including the inspected `6.1.0` tag). Identify evidence by **commit + path + compatibility**, not the version string alone. Release ZIP contents were not compared with these repository snapshots. Hashes cover retrieved file bytes, including original line endings; sources are linked rather than vendored.

### Licensing boundary

- Better Roofs has an [MIT LICENSE at the predecessor pin](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/LICENSE), copyright 2023 theripper93. It is a possible licensed adaptation candidate after ArenaStar's adoption review, not an already approved dependency.
- Neither inspected Levels tree contains a LICENSE/LICENCE/COPYING file; no grant was located in its inspected README. GitHub metadata returned no identified license. Publicly readable source is **not** permission to redistribute it.
- Levels' [FogManager.js, lines 185–201](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/FogManager.js#L185-L201) explicitly marks the following section as original code retained because of protected methods. Underlying/core-code provenance needs separate review; do not treat this entire file as freely reusable module code.
- No upstream implementation, shader, asset or runtime dependency is added to ArenaStar. The proposals and examples here are independently written, **not a certified clean-room process**. Adoption inventory entries remain pending.

## 2. Better Roofs V13: actual mechanism

### R01 — A tile texture contributes a mask to vision

Read [main.js, 1–30](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/main.js#L1-L30), [roofs.js, 1–75](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/roofs.js#L1-L75), and [helpers.js, 10–46](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/helpers.js#L10-L46).

On sight refresh the module uses the first controlled token and requires its sight. Registered roof tiles receive white texture-derived mask sprites in a container attached to `canvas.masks.vision`. The sprite follows tile position, rotation and scale. The show/hide predicate requires the tile to be visible, not occluded, and above the observer's eye (`losHeight`, falling back to feet elevation), plus a sampled intersection with LOS under global illumination or FOV otherwise. Tile updates rebuild the roof set with a one-second debounce; the active 3D object-sight path bypasses that set.

**Lesson:** roof art, local roof fade and vision masks are distinct inputs. ArenaStar should not write roof-display masks into persistent exploration. This code is **not** an implementation of region-based Faux Overhead or token-only ghosts. Static attachment to a vision mask does not, by itself, prove the exact persisted pixels for every Foundry fog setting.

### R02 — Intersection approximation is not a geometry kernel

Read [helpers.js, 90–113](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/helpers.js#L90-L113) and [config.js, 53–100](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/config.js#L53-L100).

The helper samples polygon vertices and edge midpoints, offsets them toward the token, and tests tile mesh containment. It appends the first vertex pair **to the supplied points array**. The midpoint condition checks a coordinate for truthiness, so zero-valued coordinates deserve regression coverage. Sparse samples cannot establish exact polygon overlap or containment. The `brMode` and `overrideHide` parameters are not used in the show/hide decision; do not invent runtime modes from those parameter names. Configuration also converts earlier numeric mode values to a boolean presentation option.

**ArenaStar choice:** immutable geometry inputs; exact polygon/segment operations with explicit hole rules; CSS-pixel tolerances only for editor interaction. Texture alpha is an optional import aid, not an implicit source of physical solidity. Include zero coordinates, rotated/scaled masks, an enclosed roof with no sampled boundary hit, and repeated-refresh immutability fixtures.

### R03 — Linked occlusion is useful, but should be indexed and deterministic

Read [occlusionlink.js, 1–39](https://github.com/theripper93/Better-Roofs/blob/df35cca8c73e7e8d420a81aada7b65c591c06d82/scripts/occlusionlink.js#L1-L39).

The wrapper augments the native occluded set: tiles with the same nonempty link ID follow an occluded tile marked as a link source. The nested tile scans are quadratic in tile count. The V13 integration skips recipients at or below the selected Levels token's feet and removes fog-reveal sprites for occluded meshes. It mutates the occluded set while traversing it.

**ArenaStar choice:** an explicit roof assembly/group with source and follower roles. Build a group index; evaluate source eligibility from a frozen direct-occlusion result before applying followers. Compute presentation per authorized observer/view policy, not from whichever token happens to be first in a selection array. Linking can fade authorized roof art but cannot grant token visibility, remove physical barriers, reveal a lower map, or explore fog. Group evaluation must be invariant under tile ordering. Do not claim that the upstream set mutation necessarily causes an observed user bug: this review did not execute it.

## 3. Levels V13: elevation and geometry

### R04 — Feet, eye height and level bands are not interchangeable

Read [helpers.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/helpers.js), [tileHandler.js, 1–72](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/tileHandler.js#L1-L72), [tokenHandler.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/tokenHandler.js), and [wrappers.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/wrappers.js).

Generic range checks include both ends; tile visibility uses a half-open eye-height band; tile fog masks use inclusive bounds. Tile visibility also accounts for pending movement elevation deltas, background height, basement flags and show-above ranges. The player occludable-token override selects the current Levels token rather than a general party-observer union.

**ArenaStar choice:** retain separate feet/body/eye values and one documented interval convention. Logical level bands are half-open; physical contact has its own epsilon policy. Do not globally apply `top + 1`, `top - epsilon` or inclusive comparisons during import. Preserve original flags in an inert provenance record and report ambiguities. Party vision, selected-token preview and GM viewed floor are explicit policies rather than incidental selection order.

### R05 — Target samples approximate 3D visibility, not full volumetric perception

Read [sightHandler.js, 1–74](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/sightHandler.js#L1-L74), [lightHandler.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/lightHandler.js), and [soundHandler.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/soundHandler.js).

Sight uses unit-converted 3D distances and target sample points: center/corners at eye height, with additional lower/body samples in the exact-token mode. An unobstructed sample can establish visibility. Light/sound handlers add vertical-range and background rules, with special 3D integration.

**ArenaStar choice:** bounded, documented target sampling for token visibility, kept separate from illumination and movement volume. Range filtering alone is not proof of light propagation through atriums or volumetric sound. A ray that reaches a token still requires host authorization, target illumination/sense rules and a presentation policy.

### R06 — Horizontal tile planes and vertical wall planes

Read [sightHandler.js, 321–503](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/sightHandler.js#L321-L503).

The collision routine tests strict crossings of a background plane and tile planes at `document.elevation`; same-height rays skip horizontal-plane intersections. Tiles marked `noCollision` are skipped. Tile mesh containment uses alpha thresholds of `0.99` for sight and `0.1` for other channels. Although it reads `rangeTop` and a comment mentions ceilings, this tile loop does **not** test a second plane at `rangeTop`.

Walls are tested as bounded vertical planes with wall-height limits, channel restrictions, open-door exemptions, directional behavior and limited-wall accounting. Unbounded heights are represented by large sentinel numbers. The routine can return a first encountered collision, not necessarily the nearest along the ray. That is sufficient for some **any-hit** queries, not a contract for movement truncation at the closest blocker. These are line tests, not swept-body collision.

**ArenaStar choice:** explicit floor and ceiling surfaces with holes and independent channel policies; no inferred ceiling merely because art has a height range. Preserve null/unbounded limits rather than magic world coordinates. Separate `any` from `closest` query contracts; sort/deduplicate crossings when nearest-hit or limited-boundary semantics require it. Swept token footprint/body collision remains additional work. Parallel, collinear, exact-plane contact, two planes in reverse insertion order and repeated limited-boundary hits need fixtures.

## 4. Fog: presentation versus persistent exploration

### R07 — Tile masks and token bubbles are not token-only ghost compositing

Read [fowHandler.js, 1–134](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/fowHandler.js#L1-L134).

The advanced-fog path adds black tile-texture masks to an explored container. Visibility is gated by elevation range, fog settings, tile visibility and `noFogHide`. Optional token reveal uses circular token bubbles whose visibility follows token visibility.

**ArenaStar choice:** do not copy a bubble reveal as a cross-level ghost implementation. An authorized token-only overlay may reveal the token silhouette, not surrounding map pixels, decorations or hit targets without separate authorization. This is a threat-model distinction, not a claim of a reproduced exploit in Levels. Test screenshot output **and** interaction/HUD targets with overlapping hidden tokens at the same XY.

### R08 — Per-level fog uses surrogate scene records

Read [FogManager.js, 1–74](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/FogManager.js#L1-L74), [185–201](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/FogManager.js#L185-L201), [385–460](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/FogManager.js#L385-L460), and [config.js, 22–35](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/config.js#L22-L35).

The installed FogManager subclass chooses a surrogate Scene named `originalName[bottom-top]` using the first inclusive elevation-band match. Missing matches or insufficient level definitions fall back to the original scene. Setup clones scene data, clears array-valued fields, disables navigation/active status and enables fog exploration. It warns when advanced fog is enabled alongside this setup. The save path queues work and checks whether the exploration object changed during asynchronous image extraction.

**ArenaStar choice:** preserve the single scene, and store fog under stable `(worldId, sceneId, levelId, user-or-partyId)` keys. Renaming/reordering levels must not change fog identity; never merge floors by default when a key is missing. Capture the fog key, reset epoch and content revision before extraction. A completed A-floor readback may persist to the captured A record if still valid, but must never be attached to current floor B or saved using B's key. A reset/deleted record invalidates old readbacks. Failed/stale extraction must not silently clear the dirty state of a newer revision. These persistence rules work automatically; they do not add GM approval prompts per edit.

## 5. Stairs and elevators

### R09 — Region transitions stop movement and continue the remaining route

Read [regionHandler.js, 1–64](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/regionHandler.js#L1-L64) and [main.js](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/main.js).

Region stair handling checks the initiating user, distinguishes bidirectional/top-bottom and one-way cases, stops movement, waits for animation, filters intermediate pending waypoints, then resumes with rewritten elevations and a displacement action while retaining options. Legacy pre-update checks can reject non-GM elevation changes on collision, with stair/teleport/displace exemptions.

**ArenaStar choice:** preserve the useful behavior—crossing a stair need not throw away the remainder of the route—but implement it as a host-validated transaction. Evaluate continuous path entry, authorize destination/body clearance, transform the remaining route, then revalidate that route against destination geometry. Use action IDs, expected revisions and transition cooldowns to avoid duplicate execution. An event's initiating-user guard or a client-side collision warning is not ArenaStar's network authority boundary.

### R10 — Deprecated drawing triggers explain import edge cases

Read [drawingHandler.js, 1–163](https://github.com/theripper93/Levels/blob/17d4cfdd674b45e4abf4235416a23f889ba12163/scripts/handlers/drawingHandler.js#L1-L163).

Older stairs use endpoint containment, an `inStair` latch, separate drawing modes, a `top + 1` workaround and deferred update hooks. Truthy fallback expressions deserve care for zero-valued coordinates/elevation. Elevator floors are parsed from a string and the chosen floor updates the first controlled token.

**ArenaStar choice:** explicit typed destinations, nullable checks, swept path entry, stable IDs and idempotent transactions. Import drawing/region modes through **version-specific** tables—do not assume their numeric encodings are interchangeable. Never execute imported scripts; unsupported scripts remain inert with an actionable report. Test path entry and exit within a single move, origin `(0,0,0)`, movement cancellation, and two users triggering different stairs concurrently.

## 6. What changed in the inspected V14 branches?

### R11 — Better Roofs now gates against the viewed native level

Read [V14 occlusionlink.js](https://github.com/theripper93/Better-Roofs/blob/83867b4d5b34711e7bec52d91946b1f1f170dbb9/scripts/occlusionlink.js) and [V14 main.js](https://github.com/theripper93/Better-Roofs/blob/83867b4d5b34711e7bec52d91946b1f1f170dbb9/scripts/main.js).

The occlusion integration compares `canvas.level.elevation.bottom` against tile elevation rather than the legacy Levels selected-token feet check. This is an integration change, not proof that viewer floor and observer eye are interchangeable. Both concepts remain explicit in ArenaStar's render plan.

### R12 — Levels becomes a migration/native-surface adapter

Read [V14 main.js](https://github.com/theripper93/Levels/blob/230f3ac3d784932f15dad84fb43aa1dc66000b42/scripts/main.js) and [migration.js, 239–381](https://github.com/theripper93/Levels/blob/230f3ac3d784932f15dad84fb43aa1dc66000b42/scripts/migration.js#L239-L381).

The entry point imports migration and region helpers, not the old complete handler stack. It wraps native `Scene.testSurfaceCollision` for movement/sight **any-hit** queries, adding opt-in tile-plane alpha checks before falling back to the native method. The old sight-handler file's presence in the tree does not establish that its legacy integration is active.

Migration creates native Level records, sets lower-level visibility links, assigns placeables to levels and removes legacy flags in several paths; it also deletes/replaces some old records. Its welcome/merge UI warns about backups. This is evidence for deliberate version-aware conversion, not an ArenaStar migration algorithm to transplant.

**ArenaStar choice:** dry-run report, source backup, stable import identity map, explicit ambiguity resolution and one atomic apply/undo boundary. Preserve unknown source flags/scripts as inert metadata. Do not use concatenated elevation strings or display names as native identity; do not delete source records before a successful export/backup and validated conversion. This one-time import review is separate from normal automatic edit/save flow.

## 7. Concrete design impact and acceptance additions

These findings strengthen the existing native design; they do not require a Foundry compatibility runtime.

| Contract | Required fixture / expected result | Delivery stage |
|---|---|---|
| Observer policy | Two controlled tokens on different floors; reorder selection; explicit selected/party policy governs result, never accidental array order | M2–M3 |
| Band normalization | Feet/eyes exactly at adjacent limits including zero and negatives; one logical owner, separate physical-contact rule | M1–M2 |
| Explicit planes | Tile top metadata alone creates no ceiling; floor and ceiling holes each have tested channels | M2 |
| Collision query mode | Reverse candidate order; `closest` returns same blocker; limited boundaries deduplicated; `any` only promises a boolean | M2 |
| Roof groups | Source/follower roles, unrelated groups and reordered tiles; deterministic indexed result with no fog/authority change | M3 |
| Immutable overlap | Repeat mask evaluation at zero coordinates and rotated/scaled roofs; no geometry mutation or containment miss | M3 |
| Keyed fog | Rename floor/scene; duplicate display names; switch A→B during extraction; reset A during extraction; no cross-key or stale-reset write | M1/M3 |
| Ghost isolation | Authorized token behind art, hidden neighbor at same XY; no circular map reveal, no unauthorized HUD/picking | M3 |
| Stair continuation | Fast path crosses entire region; only one transition; remaining route revalidated; destination obstruction blocks safely | M2 |
| Import safety | V13 and V14 fixture families kept distinct; drawing versus region mode mapping, `noCollision`, absent ceiling, zero coordinates, ambiguous ranges reported | M5 |

**Status:** these are acceptance requirements, not newly passing engine tests. Existing original design-kernel tests cover only their documented narrow contracts. No production code changed. Baileywiki source review remains an optional later parity/provenance audit, not a prerequisite for implementing this independent proposal.

**Validation for this follow-up:** 33 pinned Ripper file hashes verified against retrieved bytes; local Markdown paths/anchors and whitespace checks passed; `node --test docs/research/multilevel/design-kernels.test.mjs` passed all 12 existing tests. No Foundry runtime, GPU acceptance or full ArenaStar suite was run for this documentation-only update. Temporary upstream source downloads were removed after recording evidence; the immutable links and hashes support re-fetching.
