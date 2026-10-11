# Multilevel GAP analysis: PR #45 vs Levels, Better Roofs and Foundry V14 Scene Levels

**Date:** 2026-10-11 · **Base:** `09728f5` (the PR #45 merge tree `8e1b368` plus the two `Examples/` zips)
**Scope:** the multilevel work in PR #45 (D-416 to D-428) · **Author:** Arena agent

**Method.** Every claim was either read in the code or run in this checkout:

- Full Vitest suite.
- All 11 multilevel Chromium tests, run twice: once on Pixi's Canvas2D fallback and once on WebGL (SwiftShader).
- A scripted repeat of the testers' stairwell case, using the real GM UI and a real player joining over manual signalling.

The Foundry modules were read from the exact bytes in `Examples/`. The V13 versions were read at the tags already pinned in `docs/research/multilevel/source-pins.json`. Foundry V14 core is proprietary, so its behavior is described only from public documentation (links in §2). This document adds to the research in `docs/research/multilevel/RIPPER_PREDECESSORS.md` (R01–R12) and does not repeat it.

---

## 0. Verdict

**What works (verified):**
- Private level drafts: validation, undo, scene copy, format-3 archives and capability negotiation.
- Per-floor map tiles or background, walls and lights assigned to floors, per-floor ambient light.
- Isolated player floors: the view follows the player's token, and each floor keeps its own explored fog with durable reset epochs.
- Stairs are host-authoritative: floor membership and feet elevation change in one undoable envelope. Tokens don't bounce back, and walls are checked at entry and at the landing.
- Native Faux Overhead covers with vector holes, and wall corner/split editing.
- Unit suite: **5,416 passed / 12 skipped / 0 failed**.
- **9 of 11** multilevel browser tests pass with WebGL. The other 2 fail only on stale text assertions.

**What is broken or misleading today** (details in §1.2):

1. **A stairwell cannot serve more than one other floor.** The editor accepts overlapping stair regions, but every move into the overlap is rejected, and the player isn't told why. This is the root cause of the testers' "can't choose up or down" complaint. I reproduced it in the browser.
2. On isolated floors, **tokens with no assigned floor are invisible to players**. That includes every token created during play, and summoned creatures can never be assigned.
3. Isolated floor play **removes templates, drawings, map notes and Faux Overhead covers** from player canvases.
4. **Faux Overhead is inverted on Pixi's Canvas2D renderer** (machines without WebGL). It shows the covered part of a token and hides the exposed part.
5. Two multilevel browser tests are red at HEAD (their text assertions are stale).
6. Once isolated play is enabled, **walls not assigned to a floor silently stop blocking movement**. Enabling it runs no pre-check.
7. **The GM always sees every floor stacked.** The top floor's map covers the others. The level selector only changes fog and lighting.

**Biggest capability gaps vs Levels / V14 / Better Roofs** (§5):
- Choosing a destination at stairs or elevators (G-01).
- A GM floor view, build mode, and new objects automatically placed on the active floor (G-12, G-13).
- Seeing lower floors and the tokens on them from upper floors (G-19, G-20).
- Physical floors with holes, and light passing between floors (G-21, G-22).
- Roofs visible through fog from outside, and multi-tile roofs fading together (G-24, G-25).

**Most of this is already specified** in `MULTILEVEL_WALLS_DESIGN.md`:
- §5.1: *"Multiple destinations/elevators use a player destination choice … Use explicit arrivals … Pair return links explicitly"*.
- §9: the level builder, visibility matrix, navigator and build mode.
- §6.6: linked roof assemblies.

So these are **delivery gaps, not design gaps**. The most valuable next slice is **Stairs v2** (G-01, G-02, G-03, G-08, G-10, G-11). It fixes the testers' complaint and the silent failures around it.

---

## 1. Status of the multilevel work in PR #45

### 1.1 What was delivered

| Capability | Decision | Evidence in this checkout |
|---|---|---|
| Private level drafts, validation, undo, scene copy, format-3 archive | D-419 | unit tests; `level_drafts` e2e (red only on a stale text assertion, S5) |
| Version checks between clients for each new level feature | D-420 to D-428 | `tests/client/capabilities.test.ts` and others |
| Token floor assignment, wall/light floor assignment, assignment audit | D-421, D-422 | `level_bindings` e2e: token test green; wall test red on stale text (S5) |
| Separate explored fog per floor, durable reset epochs | D-423, D-425 | `level_perception`, `level_ambient` green |
| Per-floor ambient override | D-424 | `level_ambient` green |
| Player choice of which token's floor to view (now the fallback) | D-427 | `player_floor_focus` green |
| Isolated floor maps and stair travel | D-428 | `isolated_floors` green (GPU pixel check red→blue→red) |
| Faux Overhead (vector covers with holes) | D-416 | `faux_overhead` green on WebGL; **red on Canvas2D** (S4) |
| Wall corner and split editing | D-417 | `wall_editing` 2/2 green |
| Spatial kernel; vertical perception and exposure planner | D-418, D-426 | unit tests only. **Nothing in production imports** `src/core/spatial/perception.ts` or `src/host/levelDisclosure.ts` |

### 1.2 Status findings: defects, traps and drift

**S1. Overlapping stairs are accepted, then refused without explanation.**
- `stairMovementOps` throws `"Overlapping stair destinations: GM must resolve the regions"` (`src/core/levelPlay.ts:86`) whenever two stair regions leaving the same floor contain the move's endpoint.
- The stair editor (`LevelPlayEditor.svelte`) never checks for this.
- Reproduction (scratch Playwright script, not committed):
  1. Three floors (Basement, Ground, Upper).
  2. The GM creates **Ground→Upper** and **Ground→Basement**, each with return stairs, on the same rectangle. Both report *"Stair regions saved"* and four regions are listed.
  3. Enabling floor play succeeds.
  4. A real player drags the hero into the stairwell. **The token snaps back to its start and nothing is shown on screen.** The floor chip still reads *"Ground · Following token · walk into stairs to change floors"*.
- Because a destination can't be chosen, one place can't serve both up and down. GMs have to put up-stairs and down-stairs in different spots.

**S2. Tokens with no assigned floor disappear for players on isolated floors.**
- A floor's token list keeps only `t.levelId === levelId` (`src/core/levelNavigation.ts:30`).
- No creation path sets `levelId`: dragging from Actors, compendium import, prefab placement and summons all leave it empty.
- The assignment editor refuses summoned and attached tokens (`src/ui/images/levelBindingEditor.ts:15`), and stairs skip them (`levelPlay.ts`, the `prefab`/`summon` guard).
- Result: a monster the GM drops mid-session is invisible until the GM assigns it from a dropdown, and **a summoned creature can never be shown** on an isolated floor.

**S3. Isolated mode removes the auxiliary layers.**
- `floorScene` (`levelPlay.ts:46-56`) empties `sounds`, `regions`, `drawings`, `templates`, `notes` and `cells` for players.
- The player shell draws drawings, templates, notes and Faux Overhead covers from that emptied scene (`src/app/JoinApp.svelte:1084`, `:1102-1103`).
- So spell templates, GM annotations, map pins and roof covers vanish for players on isolated floors.
- The implementation notes call these layers "excluded rather than mixed". For templates, that is a gameplay regression, not a styling choice.

**S4. Faux Overhead is inverted on Pixi's Canvas2D renderer.**
- `FauxOverheadLayer.ts:89` uses an inverse stencil mask (`setMask({ mask, inverse: true })`).
- Without WebGL, Pixi 8.20.1 silently falls back to its canvas renderer (`renderer.name === "canvas"`), which **keeps only the inside of the mask**.
- Measured token alpha with a cover over x≥200:

  | Renderer | x=160, 180 (exposed) | x=205–240 (covered) |
  |---|---|---|
  | Canvas2D | 0 / 0 | 230 |
  | WebGL (ANGLE/SwiftShader) | 229 / 229 | 0 / 0 / 0 (correct) |

- A screenshot comparison confirms this is visible on screen, not only in the test readback. Any user without WebGL (hardware acceleration off, blocklisted GPU, some remote desktops or VMs) would see tokens **only** where they are under a roof.
- Test-infra note: the documented `@sparticuz/chromium` recipe only gives WebGL if `libEGL.so`, `libGLESv2.so`, `libvk_swiftshader.so` and `vk_swiftshader_icd.json` sit **next to the executable**. Setting `LD_LIBRARY_PATH` is not enough. Otherwise the `faux_overhead` pixel test fails for environmental reasons.

**S5. Two browser specs are red at HEAD.**
- `e2e/level_drafts.spec.ts:11` expects the text "Planning only".
- `e2e/level_bindings.spec.ts:22` expects "do not hide other floors".
- The editor text was rewritten afterwards.
- D-428 reported five passing browser tests. Those five did not include these two specs or `faux_overhead`.

**S6. Unassigned walls fail open.**
- In isolated mode, host movement validation keeps only walls scoped to "all floors" or to the mover's floor (`src/host/sync.ts:1708`). Unassigned (legacy) walls stop blocking on every floor.
- Enabling floor play checks nothing first.
- The assignment audit shows a "Legacy walls: N" count, but nothing connects it to activation.

**S7. The GM view stacks every floor.**
- The canvas level selector ("GM fog & lighting diagnostic") only drives fog and lighting (`previewLevel` in `App.svelte`). Tiles and tokens are not filtered.
- In the reproduction, the Upper floor's map covered Ground and Basement on the GM canvas, and the Ground-floor hero was drawn on top of the Upper map.
- The four stacked stair regions rendered as a single unlabeled outline with no direction marks.

**S8. Documentation drift.**
- In `MULTILEVEL_IMPLEMENTATION.md`:
  - "Remaining design work" still lists level navigation as remaining, although D-427/D-428 delivered it.
  - "Validation performed" still quotes D-420 numbers (5,364 tests / 12 Chromium).
- D-428 triggers stairs only when a move *ends* inside the region. It does not record why this departs from research R09 (continue the route after stairs) or from design §5.1 (a thin stair crossed in one move; destination choice).

---

## 2. What the `Examples/` zips actually are

- **Both zips are the Foundry V14 versions, not V13.** Their files are byte-identical to the V14 commits the repo already pinned:
  - Levels `230f3ac`: `module.json`, `README.md`, `scripts/main.js` and `scripts/migration.js` hashes match.
  - Better Roofs `83867b4`: all five pinned files match.
  - Both manifests declare compatibility 14/14/14.
- **Levels 7.0.3 is a retirement adapter.** Foundry V14 moved multilevel support into core ("Scene Levels"). Its 63 KB of JavaScript is:
  - migration to core levels (30 KB),
  - region helpers (3 KB),
  - a wrapper that adds tile-plane collision tests (4 KB),
  - `sightHandler.js` (25 KB), which **nothing imports** (left over from V13).
- Its `elevator` handler calls itself recursively, so 7.0.3 is not a working reference. About 24 MB of the archive is sample maps, art and audio, and **the archive contains no licence file**.
- **Better Roofs 4.0.2** (MIT, 17 KB) differs from V13's 3.0.0 only in its level check: it uses the viewed level's bottom instead of the Levels token's feet.
- For the code comparison I therefore also read the **V13 implementation** at the pins the repo already records. Both were fetched to `/tmp` and not committed:
  - Levels 6.1.0 [`17d4cfd`](https://github.com/theripper93/Levels/tree/17d4cfdd674b45e4abf4235416a23f889ba12163) (about 200 KB: sight, tile, token, region, drawing, light, sound, note, template and fog handlers, plus the GM layer tool).
  - Better Roofs 3.0.0 [`df35cca`](https://github.com/theripper93/Better-Roofs/tree/df35cca8c73e7e8d420a81aada7b65c591c06d82).
- **V14 core behavior comes from public sources:**
  - Change Level is *"a behavior that prompts to change the level of Tokens that enter the Region"* ([API](https://foundryvtt.com/api/v14/classes/foundry.data.regionBehaviors.ChangeLevelRegionBehaviorType.html)).
  - Scene Levels phase 1: elevation bands, sublevels visible from upper levels, Change Level and Define Surface ([14.353](https://foundryvtt.com/releases/14.353)).
  - When Change Level moves a token, its destination is adjusted so the token's center stays inside the region ([14.354](https://foundryvtt.com/releases/14.354)).
  - Build workflow: visibility lists, auto-tagging, stairs in the lower band ([tutorial](https://foundrymods.com/how-to/foundry-v14-levels)).
  - A module that changes level from elevation edits, using a dialog based on core's Change Level when several levels are possible ([Elevation Level Change](https://foundryvtt.com/packages/elevation-level-change)).
  - The mapping in `migration.js` shows how V13 concepts became V14 ones.
- **Licensing:**
  - Levels has no licence: use it as a behavior reference only, implemented clean-room.
  - Better Roofs is MIT: code can be adapted with attribution after the adoption review in `tools/adopt/`.
  - Foundry core is proprietary: take concepts from public documentation only.
  - Committing the Levels zip to this public repository conflicts with `LEGAL.md` §3.

---

## 3. Capability matrix

Legend: ✅ have · ◐ partial · ❌ missing · — not applicable. Gap IDs refer to §5.

### 3.1 Structure and GM authoring

| Capability | Levels V13 | Foundry V14 core (+Levels 7) | ArenaStar (PR #45) | Gap |
|---|---|---|---|---|
| Named elevation bands | scene flag list `[bottom, top, name]` | Level documents | ✅ `LevelDocument` (band, floorZ, sort) | — |
| Per-floor art | tiles with ranges, background elevation | per-level background plus tagged tiles | ✅ per-floor `tileIds`, optional scene background | G-29 |
| GM floor switch (view and placement) | layer tool: click a level | level switcher, Levels tab | ❌ fog/lighting only (S7) | G-12 |
| New objects stamped with the active floor | `preCreate*` hooks for tiles, walls, lights, sounds, notes, regions, drawings, tokens | auto-tag to the viewed level | ❌ one dropdown per object | G-13 |
| Bulk assignment | via the active level | multi-select | ❌ | G-13 |
| Build mode (hide other floors while editing) | range filter for the GM | (Better Levels) | ❌ | G-12 |
| Per-level visibility list | implicit (show-if-above, basement) | `visibility.levels` | ✅ "Sees floors below" per floor, with presets (D-443) | G-19 |
| Generate or auto-detect levels | "Get levels from scene" | (Better Levels Generate Levels) | ❌ manual add (default 10-unit bands) | G-28 |
| Drop another scene in as a floor | yes | — | ✅ map, tiles, walls and lights, scaled to the grid (D-441) | G-29 |
| Who is on which floor | player portraits per level | Placeables tab | ❌ audit lists IDs only | G-17 |
| Audit | scene checker | (Better Levels: 32 rules) | ◐ band gaps, tokens outside bands, unassigned counts | G-15 |

### 3.2 Stairs and transitions

| Capability | Levels V13 | Foundry V14 core | ArenaStar (PR #45) | Gap |
|---|---|---|---|---|
| One region that works both ways | `stair` toggles bottom↔top | Change Level region lists both levels | ❌ needs two regions | G-01 |
| One-way up or down | `stairUp` / `stairDown` | through the region's level set | ✅ `{from, to}` | — |
| Elevator / choice between floors | "Choose a Floor" dialog | Change Level prompt | ❌ overlapping regions are rejected (S1) | **G-01** |
| Use stairs while standing on them | elevator dialog stays open while inside | prompt on entry | ❌ leave and re-enter | G-08 |
| Trigger when the path enters, then continue the route | stop, wait for the animation, re-issue the remaining waypoints on the new level | (core) | ❌ triggers only if the move ends inside | G-09 |
| Lock stairs | lock toggle on the drawing's HUD | toggle the behavior | ❌ | G-11 |
| Players can see the stairs | drawing visible | region visible on both floors | ❌ regions are stripped for players | G-10 |
| Arrival position | XY kept | XY kept, token center kept inside the region | ◐ XY kept, no explicit arrival points | G-01 |
| Explaining a refused move | warnings | — | ❌ silent rollback | G-02 |
| Elevation change changes floor | yes (elevation *is* the level) | (Elevation Level Change module) | ❌ out-of-band elevation edits are refused, and there is no elevation UI | G-16, G-23 |

### 3.3 Physics, perception and presentation

| Capability | Levels V13 | Foundry V14 core / Better Roofs | ArenaStar (PR #45) | Gap |
|---|---|---|---|---|
| Wall heights | wall-height bottom/top | walls tagged to levels | ✅ floor scopes; finite heights exist only in the unconnected kernel | G-21 |
| Solid floors and ceilings with holes | tile planes; holes from alpha | Define Surface regions with hole tool | ✅ a solid shape per floor, traced from its art, previewed and checked (D-444); play consumers in G-20/G-22/G-23 | G-21 |
| See tokens on other floors through openings | 3D line-of-sight sampling | visibility lists plus surfaces | ◐ planner exists, nothing uses it | G-20 |
| See lower-floor art from above | show-if-above, basement rules | visibility lists | ✅ through the floor art's transparent parts, dimmed by depth (D-443) | G-19 |
| Light passing between floors | light masking by viewer height | unassigned lights; floors restrict light | ❌ hard per-floor scope | G-22 |
| Notes, templates, drawings per floor | elevation-gated; template elevation tool | tagged to levels | ❌ removed in isolated mode (S3) | **G-06**, G-27 |
| Flying and falling between floors | warning when crossing a floor | surfaces plus elevation | ❌ | G-23 |
| Faux Overhead token clipping | (Better Levels) | — | ✅ vector; ❌ on Canvas2D (S4); ❌ in isolated mode (S3) | G-05, G-06 |
| Roof fades when a token is under it | core modes: fade / radial / vision | core | ◐ `roof` fades the whole tile using its bounding box | G-26 |
| Roof visible through fog from outside | — | Better Roofs *Reveals Fog of War* | ❌ | G-24 |
| Multi-tile roofs fade together | — | Better Roofs *Occlusion Link Id/Source* | ❌ | G-25 |
| Explored fog per floor | hidden copy scenes per level (beta) | core, per level | ✅ **ahead**: per-floor storage keys, reset epochs, stale-upload fencing | — |
| Token size shrinks with height difference | yes | — | ✅ optional, plus a height badge (D-440) | G-32 |
| Other floors' data withheld from clients | no (filtered on the client) | no (filtered on the client) | ◐ drafts and scopes withheld; other floors' tokens still sent | G-33 (beyond parity) |

---

## 4. How the modules handle the tricky parts, and what to adopt

Code references point to the pinned commits. Behavior is described in my own words; no upstream code is reproduced.

### T1. Stairs: toggle, one-way, elevator, and continuing the route

**What they do.** V13 `scripts/handlers/regionHandler.js` (L4-57) and V14 `scripts/regionHandler.js` (L11-63):
- The handler runs only for the user who moved the token.
- `stair` is a toggle based on where the token is now: bottom goes to top, top goes to bottom.
- `stairUp` / `stairDown` move to the next band up or down.
- An elevator opens a list of named floors.
- **Route continuation** (`updateMovement`) is the clever part. It stops the token, waits for the running animation, takes the remaining planned waypoints, rewrites them to the new level as a "displace" move, and re-issues the move with the original options. Crossing a staircase continues the walk on the new floor instead of ending it.

**V14's model.** The V14 migration (`migration.js` ≈L287-328) maps all four legacy stair modes onto **one** core `changeLevel` region. That region's `levels` set lists every connected floor: one region per stairwell, not one per direction.

**Avoid:**
- Treating "the moving user ran it" as a security boundary.
- Exact float equality tests (`elevation === bottom`).
- The drawing-era `top + 1` workaround.
- An `inStair` flag stored on the token object.

**Take:**
- One region per stairwell serving N floors, with a prompt when there is more than one destination.
- Route continuation, done as a host transaction that rechecks the rest of the route against the destination floor's walls.
- ArenaStar already has the swept-path code for this:
  - `sweptTileEvents` (`src/core/automation.ts:1057`) returns where along a move it enters and leaves convex and alpha zones.
  - `stairMovementOps` already converts stair regions with `regionTriggerTile`.

### T2. Preventing bounce-back

- V13 drawings keep a per-token "in this stair" flag until the token leaves.
- V14 places stairs in the lower band with *Top Inclusive*, so the arrival band doesn't fire again.
- ArenaStar triggers only on the outside→inside edge. This is stateless and robust; **keep it**.
- Add explicit re-use instead: a "Take stairs" action while standing on them (G-08). Today a return trip needs leaving and re-entering.

### T3. Stamping new objects with the active floor

- V13 (`scripts/ui.js` ≈L684-857): while the layer tool is on, `preCreate*` hooks stamp every new tile, light, sound, note, region, drawing, wall and token with the active band.
  - Roof mode: elevation = the band's top, range up to infinity.
  - "Place regions as stairs": a new region becomes a stair to the next level.
- V14 core auto-tags new placeables to the viewed level.
- **Take:** the GM's "active floor" (the same switch as the GM floor view, G-12) sets defaults on create, and the host validates the floor reference. Reuse the existing `wallsForAuthoring(walls, level)` for wall editing.

### T4. Which floors are drawn

- V13 (`handlers/tileHandler.js` L2-49) compares the controlled token's eye height with each tile's band:
  - basement tiles show only inside their band;
  - higher tiles are hidden unless *show if above* applies within a maximum height difference (balconies);
  - roofs are hidden when the viewer is below the background (in a basement).
- While the token animates, V13 uses the **destination** elevation (L16-18), so the view switches at the right moment.
- V14: each Level has `visibility.levels`, the floors drawn when viewing it. The migration sets it to "every level at or below" (`migration.js` L248-255).
- **Take:** ArenaStar already stores `visibleLevelIds`. Draw the visible lower floors beneath the current one (dimmed, art only at first), and switch floors with a short transition timed to the arrival (G-18, G-19).

### T5. 3D line of sight

- V13 `handlers/sightHandler.js`:
  - L29-59: the target is sampled at its center plus four inset corners at eye height, or at 11 points (adding feet and mid-body) in "exact" mode.
  - L320-475:
    - Vision range is spherical.
    - Floors are planes crossed by the ray, tested against the floor tile's pixel alpha at the crossing point (threshold 0.99 for sight, 0.1 for movement).
    - Walls are vertical rectangles between their bottom and top, with direction and proximity rules.
    - The first *limited* wall is passed through.
- ArenaStar's `src/core/spatial/kernel.ts` and `perception.ts` already implement finite-height walls, horizontal surfaces with **vector** holes, and bounded body samples. Nothing in production uses them.
- **Take:** the sampling policy and the "first limited wall passes" rule, as test fixtures. Keep vector holes rather than alpha tests (D-418). Add an eye/body height per token, derived from size, like Levels' token height setting.

### T6. Holes from map transparency

- Levels V14 (`scripts/main.js` L71-99) wraps core `Scene.testSurfaceCollision`: a flagged floor tile blocks a ray only where its pixels are opaque at the crossing point.
- Better Levels traces floor surfaces "to the tile's actual non-transparent footprint".
- ArenaStar decided against physics from map transparency (D-418), and that's right for determinism and security.
- **Bridge without reversing it:** an authoring-time **"Trace openings from floor art"** action. It turns a floor tile's transparent areas into a validated vector outline, reusing `tileAlphaMaskFromRgba` (`src/core/tileTriggerZone.ts:46`), and shows a preview the GM accepts.

### T7. Lights between floors

- V13 (`handlers/lightHandler.js` L2-56) hides lights outside the viewer's band, or in "light masking" mode keeps lights at or below the viewer's height.
- V14 advice: leave lights unassigned at their floor's elevation and let floors restrict light. Light then spills naturally down stairwells and through openings.
- ArenaStar only has hard per-floor light scopes. Address this after surfaces exist (G-22).

### T8. Better Roofs: roof visible through fog, and linked roofs

**Reveal through fog** (`scripts/helpers.js` L10-48):
- When the controlled token's vision polygon touches a roof tile above its eye height, a white silhouette of the roof (a small shader that outputs the texture's alpha) is added to the **vision mask**. The building's exterior then shows through fog.
- The "touches" test samples polygon vertices and edge midpoints pushed 5 px outward (L90-111). This is approximate: it misses fully enclosed roofs and mutates its input.

**Linked roofs** (`scripts/occlusionlink.js` L10-38):
- After core works out which tiles are hidden by a token underneath, any tile sharing a link id with a hidden *source* tile is hidden too.
- The scan is quadratic and changes the set while iterating over it.

**Take:** the behavior. MIT allows adapting the code with attribution, but implement it natively:
- An exact polygon intersection between the viewer's current vision and the roof's vector outline.
- Draw the roof in the visible layer without writing to explored fog (research R01).
- Groups as an indexed `roofGroup` with source and follower roles, evaluated from a frozen result so tile order doesn't matter (research R03).

### T9. Small presentation details worth copying

- Tokens at a different elevation from the controlled token are drawn smaller: a cheap "flying / other level" cue (V13 `handlers/tokenHandler.js` L10-27).
- Templates default to the caster's elevation, optionally at hand height (V13 `handlers/templateHandler.js` L2-30).
- Arrow-key nudges keep the token's elevation (V13 `wrappers.js` L36-44).
- For players, only the current token opens roofs (V13 `wrappers.js` L90-100). A roof doesn't fade just because some other owned token is inside.

### T10. Fog per floor: ArenaStar is ahead

- V13 swapped in hidden copy scenes named `name[bottom-top]` (`handlers/FogManager.js` L30-37), and its README admits per-floor exploration isn't saved with advanced fog.
- ArenaStar stores fog under `(scene, level, user, epoch)` keys, with durable resets and protection against stale uploads. Keep this.

### T11. The V14 migration as an import spec

`migration.js` shows exactly how V13 data maps to V14:
- Drawing stair modes become change-level regions with level sets.
- Tile *show if above*, basement and infinite ranges become tile level sets.
- Walls and lights get the levels they fall within; other objects get the levels at or above them.
- Tokens get their band.
- Bands smaller than 1.5 grid units are merged into the band that contains them.

Use it as the behavior spec for a Foundry importer (G-30): written clean-room, with a dry-run report (research R12).

---

## 5. GAP list and how to bridge each gap

**Priority:**
- **P0:** defect or tester blocker.
- **P1:** core play or GM authoring parity.
- **P2:** perception and presentation parity.
- **P3:** productivity, portability, or beyond parity.

**Effort:** S ≤ 1 day · M 2–4 days · L ≥ 1 week.

**Design** points to the section of `MULTILEVEL_WALLS_DESIGN.md` that already specifies the behavior.

### P0: defects and the tester blocker

#### G-01: Stairs v2, one stairwell serving several floors, with a player choice
P0 · M–L · Design §5.1 · Evidence: S1

**Missing**
- `StairBehavior` is only `{from, to}`.
- A second destination needs an overlapping region, which breaks every move into it.
- No elevator, no two-way toggle, no arrival points.

**Reference**
- V13 `stair` / `stairUp` / `stairDown` / `elevator`.
- V14 Change Level prompts among the region's levels.

**Bridge**
1. **Data.** Extend `RegionDocument.stairs` to:
   - `version: 2`
   - `levels`: 2–8 connected floors
   - `mode`: `"auto"` or `"prompt"`
   - `edges?`: allowed `{from, to}` pairs (default: all)
   - `arrivals?`: per-floor `{x, y}` landing points
   - `locked?`, `label?`

   Read legacy `{from, to}` as `{levels: [from, to], edges: [{from, to}], mode: "auto"}`. Offer *"Merge return pair"* to turn today's two regions into one.
2. **Host.** When a token enters, destinations = the region's floors minus the current floor, filtered by allowed pairs, lock and landing clearance:
   - none: no transition, and explain why if it is locked or blocked (G-02);
   - one destination in `auto` mode: today's atomic transition;
   - otherwise: commit the move (the token stands in the stairwell) and send `stair.offer {offerId, sceneId, regionId, tokenId, choices: [{levelId, name, direction: "up"|"down"}], expiresAt}` **to the moving user only** (the GM for NPCs).
   - `stair.choose {offerId, levelId}` rechecks that the token is still inside and still on the source floor, that the destination is allowed and the landing is clear, and the revision. Then it commits floor + feet elevation (+ arrival XY) in one undoable envelope.
   - "Stay" or a timeout discards the offer.
   - Overlapping v2 regions **combine their choices** instead of throwing.
3. **Client.** A small non-modal chooser next to the token (*↑ Upper floor · ↓ Basement · Stay*), with keyboard shortcuts. The floor chip shows "On stairs: choose a floor".
4. **Wire.** `stair.offer` (host → client), `stair.choose` and `stair.request` (G-08), behind feature `scene-level-stairs-v2`. Update `PROTOCOL.md` and its doc-consistency test. Negotiate the feature the same way as D-420/D-427.
5. **Tests:**
   - unit: destination set, allowed pairs, lock, arrivals, combining overlaps;
   - host: forged or stale offers, reconnect, two users on two stairs, undo/redo never re-offer;
   - e2e: three-floor stairwell (up, down, stay), re-use while standing, NPC moved by the GM.

#### G-02: Tell the player why a move was refused
P0 · S

- **Missing:** the player's drag uses fire-and-forget `client.submit` (`JoinApp.svelte:1476`). When the host refuses, the token silently snaps back (S1).
- **Bridge:** listen for the `rejected` bus event for that transaction and show a short message by the token with the host's reason. Examples: "A wall blocks entry to the stairs", "Stair landing overlaps a wall", "Stairs are locked". This applies to every refused move, not only stairs.

#### G-03: Catch stair ambiguity when the stairs are created
P0 · S

- **Missing:** the editor saves overlapping stairs from the same floor; the error appears only during play.
- **Bridge:** validate in the editor and in the activation pre-check (G-15). Until G-01 lands, refuse with a message naming both regions; afterwards, suggest "merge into one stairwell".

#### G-04: Fix the two stale specs
P0 · S

- Update `level_drafts.spec.ts:11` and `level_bindings.spec.ts:22` to the current text, or better, assert on stable `data-*` attributes.
- Add a `test:multilevel` batch (like the FX batches) containing all 11 multilevel specs, so text changes can't silently break them again.

#### G-05: Faux Overhead must never be inverted
P0 · S (guard) / M (full fix)

- **Missing:** Pixi's Canvas2D renderer ignores inverse stencil masks (S4).
- **Bridge, now:** detect `app.renderer.name === "canvas"` when the stage starts. In that mode, hide the **whole** token and its decorations whenever a cover overlaps it. That is conservative and never reveals covered pixels. Tell the GM once that hardware acceleration is off.
- **Bridge, later:** compute the exposed part on the CPU (token rectangle minus cover polygons) and use it as a normal mask, which works on every renderer.
- **Also:**
  - Run the canvas and FX browser batches once under Canvas2D to find other WebGL-only assumptions.
  - Update the sandbox recipe in `README.md` and `FX_TEST_BATCHES.md` so the SwiftShader libraries sit next to the executable and browser tests actually run on WebGL.

#### G-06: Keep templates, drawings, notes and covers on isolated floors
P0 · M · Design §4 (explicit floor scope for every object kind)

- **Missing:** `floorScene` removes them (S3).
- **Bridge:**
  - Add `levelScope` to templates, drawings, notes and regions, using the same validator as walls and lights.
  - **Unassigned legacy objects are shown on every floor, not hidden.**
  - New objects are stamped with the creator's current floor: a player's followed floor, or the GM's active floor (G-12, G-13).
  - Faux Overhead covers become floor-scoped regions passed to the player canvas.

#### G-07: New tokens must land on a floor
P0 · S–M · Design §4 ("new objects are assigned explicitly to the active authoring level")

- **Missing:** see S2. Tokens created during play, prefab tokens and summons have no floor, and summons can't be assigned.
- **Reference:** V13 stamps new tokens with the active band (`preCreateToken`); V14 auto-tags.
- **Bridge:** on token creation in an isolated scene, the host picks a floor and sets feet elevation in the same op, choosing, in order:
  1. an explicit `levelId`;
  2. the summoner's or prefab owner's floor;
  3. the GM's active floor;
  4. the floor whose band contains the token's elevation.

  Let attached and summoned tokens follow their owner through stairs (D-428 deferred this).

### P1: core play and GM authoring parity

#### G-08: "Take stairs" while standing on them
P1 · S

- Today a return trip needs leaving and re-entering the region.
- `stair.request {tokenId}` re-opens the G-01 choice when the token is inside a stair region on its current floor.
- Show it as a button on the floor chip and as a token context-menu entry.

#### G-09: Trigger when the path enters the stairs, and continue the route
P1 · M · Design §5.1 steps 3–7 · Research R09

- **Missing:** only the endpoint counts. A route crossing the stairs ignores them, and when stairs do fire, the rest of a multi-waypoint route is lost.
- **Bridge:**
  - Run `sweptTileEvents` against stair regions to find the first entry point.
  - Stop the move at the entry point (prompt mode), or, in auto mode, continue the remaining waypoints on the destination floor after rechecking them against that floor's walls.
  - Keep the outside→inside rule. Limit transitions per move (the design proposes 8) and dedupe them per transaction.

#### G-10: Show stairs to players
P1 · S–M

- **Missing:** `floorScene` removes regions and stair regions are created hidden, so players rely on the map art.
- **Reference:** V14 stair regions are visible from both connected floors.
- **Bridge:**
  - Include a cleaned-up marker for each stair on the player's current floor in `level.focus.state`: `{regionId, polygon, label?, directions}`, with no level IDs beyond names the GM chose to show.
  - Draw an outline or icon with a tooltip.
  - A per-stair `secret` flag keeps hidden passages invisible until discovered.

#### G-11: Lock and unlock stairs
P1 · S

- **Reference:** the V13 drawing HUD lock (`stairLocked`).
- **Bridge:**
  - Add `locked` to stairs v2, with a GM toggle in the stair list and the region's context menu.
  - Optionally link a stair to a door wall, so it works only while that door is open.
  - Explain refusals through G-02.

#### G-12: GM floor view and build mode
P1 · M · Design §9 (navigator, build mode) · Evidence: S7

- **Reference:** the V13 layer tool's range view; the V14 level switcher; Better Levels build mode.
- **Bridge:**
  - Turn the "GM fog & lighting diagnostic" selector into a **GM floor switch**. It filters tiles, tokens, walls and lights locally, like the player's floor view, without editing any documents.
  - Options: *All floors (authoring)* and *Ghost other floors at 25%*.
  - In build mode, selection and picking are limited to the active floor.
  - PageUp/PageDown move a floor up or down.

#### G-13: Stamp new objects with the active floor, and assign in bulk
P1 · M · Design §4

- **Missing:**
  - Assignment is one object at a time from a dropdown of IDs.
  - Floor map tiles are a checklist of *every* tile, repeated for each floor.
- **Bridge:**
  - While a GM floor is active, new walls, lights, tiles, regions, notes, drawings, templates and tokens are stamped with that floor (scope `levels: [active]`; tokens get `levelId` + floor elevation).
  - Add **"Assign selection to floor…"** for the canvas selection (marquee).
  - Add **"Assign all unassigned walls to…"** in the audit.

#### G-14: Draw and edit stairs on the canvas
P1 · M

- **Missing:**
  - Stairs are entered as numeric X/Y/width/height.
  - There is no rename or retarget.
  - Stacked stairs show as one unlabeled outline.
- **Reference:** V13 "place regions as stairs" mode; V14 region tools.
- **Bridge:**
  - A **Stairs** tool in the region drawing tools (rectangle or polygon), pre-filled from the active floor.
  - Labels and up/down marks on the GM canvas.
  - Edit in place: resize, retarget, rename, lock.

#### G-15: Activation pre-check and live audit
P1 (blocking part is P0) · M · Design §9 audit contract · Evidence: S2, S6

- **Bridge:** when enabling isolated play, list:
  - unassigned walls, lights and tiles;
  - tokens without a floor;
  - stairs with no way back;
  - overlapping stairs;
  - landings inside walls;
  - floors with no map art.
- Block on errors and ask the GM to acknowledge warnings. This is a one-time activation step, not a per-edit approval.
- Keep the audit live in the Draft levels panel.

#### G-16: Quick floor moves and token elevation for the GM
P1 · S–M

- **Missing:** there is no token HUD or elevation control anywhere. Moving a token to another floor needs the assignment editor.
- **Reference:** V14 token level/elevation fields; the Elevation Level Change module (prompts when elevation enters another band).
- **Bridge:**
  - Token context menu **"Move to floor ▸"** for one or several selected tokens, changing floor + floor elevation atomically.
  - An elevation field (GM only, or players if a world setting allows) that offers "Change floor to X?" when the new feet elevation falls in another band.

#### G-17: Who is on which floor
P1 · S

- **Reference:** the V13 layer tool shows player portraits per level.
- **Bridge:** per-floor counts and PC portraits in the GM floor switch; clicking one selects and centres that token.

#### G-18: Floor transition presentation
P1 · S

- **Bridge:**
  - A short cross-fade and a toast, e.g. "You climb to the Upper floor".
  - Keep the camera centred on the token.
  - Use the destination floor during the move animation (as V13 does) so the old floor doesn't flash.

### P2: perception and presentation parity

#### G-19: See lower floors from upper floors
P2 · M (art) → L (with tokens) · Design §9 visibility matrix

- **Missing:** `visibleLevelIds` is validated and copied, but has no UI and nothing draws from it.
- **Reference:** V14 visibility lists; V13 show-if-above and basement rules.
- **Bridge:**
  - A **visibility matrix** in Draft levels. Relations are one-directional, with presets: sealed, or above-ground floors see each other.
  - The renderer draws visible lower floors beneath the current floor. This needs transparent openings in the floor art or vector holes.
  - Art first; tokens on other floors only through G-20.

#### G-20: See tokens on other floors
P2 · L · Design §5.2, §5.4

- **Missing:** the D-426 perception planner has no production importers.
- **Bridge:**
  - Connect the planner to the player view for isolated scenes. A token on a visible floor appears only when a sampled ray passes through an opening (vector surfaces, G-21).
  - Add token eye/body height.
  - Start as a GM preview, then players, with the host deciding what each player sees.

#### G-21: Solid floors and ceilings with holes; trace openings from the art
P2 · L · Design §4.3

- **Reference:** V14 Define Surface regions; Levels tile planes with alpha thresholds; Better Levels outline tracing.
- **Bridge:**
  - Author `surface` regions (floor or ceiling, which kinds of passage they block, and their holes) on top of the existing kernel.
  - **"Trace openings from floor art"**: alpha mask → simplified polygon → preview → accept.
  - Audit: "an opening exists in this floor but not in the floor below".

#### G-22: Light through openings
P2 · M–L · Design §5.3

- **Bridge:** once G-21 exists, let unassigned lights at a floor's elevation light other visible floors through surface holes (clipped to the holes), instead of stopping at a hard per-floor boundary.

#### G-23: Flying and falling
P2 · L · Design §5.1 "Flying/falling"

- **Bridge:**
  - A flying token changes floor with its elevation when the swept path is clear (needs G-21).
  - An unsupported landing is refused, or the GM is offered a fall action.

#### G-24: Roofs visible through fog from outside
P2 · M · Better Roofs *Reveals Fog of War*

- **Bridge:**
  - Add a tile flag `revealInFog`.
  - When the viewer's current vision polygon intersects the roof's vector outline (exact test) and the viewer is below the roof, draw the roof in the visible layer.
  - Never write it to explored fog (research R01).
  - If code is adapted, the MIT notice goes in `tools/adopt/INVENTORY.md`.

#### G-25: Multi-tile roofs fade together
P2 · S–M · Better Roofs *Occlusion Link* · Design §6.6

- **Bridge:**
  - Add `roofGroup: {id, role: "source" | "follower"}` to tiles.
  - Work out which tiles are directly hidden first, then apply followers.
  - Use an index so the result doesn't depend on tile order.

#### G-26: Better roof fading
P2 · S–M

- **Missing:**
  - `roof` mode tests the tile's bounding box, not its art.
  - There are no radial or vision-shaped modes and no hover fade.
- **Bridge:**
  - Decide "token is under the roof" from the tile's art/vector outline.
  - Add `radial` (fade a circle around the token) and `vision` modes.
  - Add a GM-local hover-fade toggle.

#### G-27: Templates and area effects that know about floors
P2 · M

- **Reference:** the V13 template elevation tool and caster hand height.
- **Bridge:** templates carry a floor (G-06) and an elevation. Area effects resolve against tokens on the template's floor, plus visible floors once G-20 exists.

### P3: productivity, portability, beyond parity

| ID | Gap | Bridge | Effort |
|---|---|---|---|
| G-28 | "Add levels" generator | Design §9: number of floors and basements, floor height, optional roof; preview bands and art slots; conservative visibility presets | S |
| G-29 | Another scene as a floor; per-level background | *Import scene as floor* copies its background as a floor tile plus its walls and lights stamped with that floor; optional `background` on `LevelDocument` | M |
| G-30 | Foundry multilevel import | Use the V14 migration mapping (T11) as the behavior spec; dry-run report and explicit choices for ambiguous cases (research R12) | L |
| G-31 | Merge, rescale and reorder levels | "Merge into level" (Levels 7) and elevation rescale (Levels API), as atomic undoable plans | S |
| G-32 | Elevation cues | Elevation badge on tokens; optional size scaling by height difference (T9); "hide elevation from players" setting | S |
| G-33 | Withholding other floors' data entirely | Beyond Foundry parity (Foundry also sends other floors' tokens to clients). Keep on the roadmap; don't block parity work on it | L |

---

## 6. Recommended sequence

| Slice | Content | Size | Why first |
|---|---|---|---|
| **A: stop the bleeding** | G-04, G-02, G-03, G-05 guard, G-07, G-15 blocking part, S8 doc sync | ≈2 days | Removes silent failures and fail-open traps before more people build floors |
| **B: Stairs v2** (testers) | G-01, G-08, G-10, G-11, G-18, minimal G-14; entry detection from G-09 (route continuation can follow) | ≈1 week | The reported complaint, and the core of "multilevel feels usable" |
| **C: GM authoring** | G-12, G-13, G-16, G-17, full G-15, G-06, G-28 | ≈1–1.5 weeks | Makes real three-floor maps practical to build |
| **D: Perception** | G-19 → G-21 → G-20 → G-22 → G-27 → G-23 | multi-week | Parity with V14 "see lower floors and tokens through openings" |
| **E: Roofs** | G-26 → G-25 → G-24 | ≈1 week | Parity with Better Roofs; reuses Faux Overhead geometry |
| **F: Portability** | G-29, G-30, G-31, G-32, G-33 | as needed | Import, utilities, stricter secrecy |

**Acceptance for slice B (tester-facing):**
- A three-floor stairwell at one spot.
- A player on Ground steps in and chooses Up or Down, or stays.
- They can take the stairs again without leaving the region.
- Locked or blocked stairs explain themselves.
- The GM moves an NPC through the same stairwell.
- Undo restores both floor and elevation in one step.
- The stairs are visible on every floor they serve.
- No regression in `isolated_floors`, `player_floor_focus`, `level_ambient` or the player-fog specs.

### Implementation progress

Updated as slices land; decisions are in `DECISIONS.md`.

| Item | Status | Where |
|---|---|---|
| S1 / G-01 Stairs v2 | **Done** — stairwells of 2–8 floors, auto/ask, directions, arrivals, private host-revalidated choice, overlaps combine | D-430 · `src/core/levelPlay.ts`, `stair.*` messages |
| G-02 Refusal reasons | **Done** — player notify stack and GM notify log | D-429 · `src/client/moveRefusals.ts` |
| G-03 Ambiguity at authoring | **Superseded** — overlaps are now valid (they combine); the check explains them and merges identical legacy pairs | D-430, D-433 |
| S4 / G-05 Canvas2D inversion | **Done (guard)** — whole-token hiding, one GM notice; CPU-exact masks remain optional | D-429 |
| S3 / G-06 Auxiliary layers | **Done** — scopes on drawings/templates/notes/regions, unscoped on every floor, covers reach players | D-432 |
| S2 / G-07 Floorless tokens | **Done** — creation stamping; attached tokens follow; summons use stairs | D-430, D-431 |
| G-08 Take stairs while standing | **Done** — `stair.request`, floor-chip button | D-430 |
| G-09 Path entry / route continuation | **Done** — opt-in `trigger:"cross"`: first stairwell along the centre path; stop-and-ask, or auto floor change with the drag continuing on the new floor when its walls allow | D-437 |
| G-10 Stairs visible to players | **Done** — markers per floor, `secret` hides them | D-430 |
| G-11 Lock stairs | **Done** — toggle, plus stairs linked to a door work only while it is open (dangling links audited) | D-430, D-437 |
| G-14 Stairs on the canvas | **Partial** — GM labels/arrows, create from any Active Zones region; dedicated draw tool open | D-430 |
| S5 / G-04 Stale specs | **Done** — plus `test:multilevel` (now 20 Chromium tests, roofs included) | D-429 |
| S6 / G-15 Pre-check and live audit | **Done** — blocking errors, acknowledged warnings, quick fixes, live list | D-433 |
| G-18 Transition presentation | **Done** — arrival notice and cross-fade | D-430 |
| S7 / G-12 GM floor view & build mode | **Done** — floor switch with ghost/only/all, build mode, PageUp/PageDown | D-434 · `src/core/gmFloorView.ts` |
| G-13 Stamp & bulk assign | **Done** — GM build floor stamps every kind (tiles join floor art); token menu moves the selection; unassigned walls/lights to a floor | D-434, D-435 |
| G-16 Move to floor & elevation | **Done (GM)** — token menu floors, elevation with floor offer; player elevation not added | D-435 |
| G-17 Who is where | **Done** — roster with counts and PCs; click to jump | D-434 |
| G-28 Level generator | **Done** — floors, basements, height, roof | D-436 |
| G-26 Better roof fading | **Done** — "under" from the roof's art (then zone, then rotated rectangle); only the viewer's own vision tokens open roofs (a selection narrows them); `radial` and `vision` openings on WebGL, whole-roof fade on Canvas2D; GM-local "Peek under roofs" | D-438 · `src/core/roofs.ts` |
| G-25 Roof groups | **Done** — `roofGroup {id, role}`: an occupied source fades the whole group, followers never trigger; order-independent | D-438 |
| G-24 Roofs through fog | **Done** — `revealInFog`: a copy above the fog while live sight touches the outline (exact test); never explored | D-438 |
| Roof authoring (found while doing E) | **Done** — no UI could make a tile overhead; Scenes → Tiles & roofs edits overhead, mode, opacity, radius, group, role, reveal | D-438 · `src/ui/images/RoofEditor.svelte` |
| G-31 Merge, reorder, rescale | **Done** — merge into level (tokens keep height above the floor; scopes, stairs, visibility, art remapped; touching bands absorbed), move up/down (bands swap, contents follow), rescale (×factor, optional grid distance); each one undo with a preview | D-439 · `src/core/levelRestack.ts` |
| G-32 Elevation cues | **Done** — a badge with the height above the token's floor (+15 ft), an optional smaller-at-other-heights cue measured from the selected token (×0.83 at two cells, half size from ten), a world setting for everyone / GM only / off (GM only hides the size cue too), and the token menu's Feet Z on every scene | D-440 · `src/core/elevationCues.ts` |
| G-29 Scene as a floor | **Done** — import another scene (or one floor of a multilevel scene) into an existing floor or a new floor on top: its map becomes a floor map tile, its tiles, walls and lights are copied and stamped, scaled so grid cells match, one undo step; tokens and regions stay behind. No per-level `background` field: a floor map tile already is one | D-441 · `src/core/levelImport.ts` |
| G-33 Withhold other floors | **Deferred, design recorded** — do after G-20, which decides what other floors a player legitimately sees; the plan is a per-session floor set as a projection read boundary with a scene resend on floor change | D-442 |
| G-19 See lower floors | **Done (art)** — per-floor "Sees floors below" with Sealed / Down to ground / All below presets; isolated player floors and the GM's isolated view draw the visible lower floors' art beneath, dimmed by depth, through the floor art's transparent parts. Tokens on other floors wait for G-20. Also fixed: GM-only changes no longer blank players' floors, and players' height badges measure from their floor | D-443 · `visibleFloorsBelow` |
| G-21 Solid floors with openings | **Done (model + authoring)** — `LevelDocument.surface` (solid area, holes = openings; absent = solid everywhere); "Trace from floor art" with preview; kernel planes via `floorSurfaces`; `opening-over-void` check. Surfaces inside a band (bridges) deferred | D-444 · `traceSurface` |
| G-20, G-22, G-23, G-27, G-30 | Open (slices D and F) | — |

---

## 7. Licensing and adoption notes

- **Levels** (no licence found at either pin, and none in the zip): behavior reference only. Don't copy code, shaders or assets. Describe behavior in our own words, citing pinned commits as this document does.
- **Better Roofs** (MIT, copyright 2023 theripper93): code may be adapted with the copyright notice. Still prefer exact geometry (T8). Record an inventory row in `tools/adopt/INVENTORY.md` if any code is adapted.
- **Foundry V14 core:** proprietary. Use concepts from public documentation only.
- **`Examples/RipperLevels-7.0.3.zip`:** this ~24 MB archive with no licence in a **public** repository conflicts with `LEGAL.md` §3. Move it out of Git and keep the pinned GitHub links instead. The research only needs the commit identity, which is already pinned.

---

## Appendix A: Evidence and reproduction

| Gate | Result |
|---|---|
| `pnpm exec vitest run` | 386 files passed / 2 skipped; **5,416 passed / 12 skipped / 0 failed** (302 s) |
| Multilevel e2e on **Canvas2D** (no WebGL) | 8 passed / 3 failed: `faux_overhead:7` (S4), `level_bindings:4`, `level_drafts:4` (S5) |
| Multilevel e2e on **WebGL** (ANGLE/SwiftShader) | 9 passed / 2 failed: `level_bindings:4`, `level_drafts:4` (S5) |
| Stairwell reproduction (scratch script, real GM UI + manual-signalling player) | overlapping stairs saved; enabling succeeded; player drag rolled back silently; player stayed on Ground |
| Renderer probe | default sandbox: `renderer.name = "canvas"`; with SwiftShader libraries next to the executable: `"webgl"`, ANGLE (SwiftShader, Vulkan) |
| Zip identity | Levels zip = pinned `230f3ac` (4/4 pinned files match); Better Roofs zip = pinned `83867b4` (5/5 match); neither matches the V13 pins |

Browser command used (the sandbox recipe, with WebGL):

```sh
# Once per environment: unpack @sparticuz/chromium so libEGL.so, libGLESv2.so,
# libvk_swiftshader.so and vk_swiftshader_icd.json sit next to /tmp/chromium.
LD_LIBRARY_PATH=/tmp/al2023/lib:/tmp PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/tmp/chromium \
PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1 corepack pnpm exec playwright test --project=chromium \
  --workers=1 --retries=0 e2e/faux_overhead.spec.ts e2e/isolated_floors.spec.ts \
  e2e/level_ambient.spec.ts e2e/level_bindings.spec.ts e2e/level_drafts.spec.ts \
  e2e/level_perception.spec.ts e2e/player_floor_focus.spec.ts e2e/wall_editing.spec.ts
```

Stairwell reproduction steps (they turn into the G-01 acceptance spec):
1. Seed three full-size coloured floor tiles.
2. Add three draft levels, rename them Basement / Ground / Upper, and assign one tile to each.
3. Assign the hero to Ground.
4. Create Ground→Upper and Ground→Basement stairs (each with return stairs) at X=300, Y=100, 100×100.
5. Enable isolated floor play.
6. Join a player over manual signalling and drag the hero from (150,150) to (350,150).
7. Observed: the player stays on Ground, the token is back at its start, and no message is shown.
