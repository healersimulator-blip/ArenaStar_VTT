# Multilevel research: source audit and implementation evidence

Research date: **2026-10-10**. Main deliverable: [Multilevel & walls design](../../../MULTILEVEL_WALLS_DESIGN.md).

## Evidence vocabulary

- **Code-verified:** a named source file was read at the pinned commit. This is static inspection, not a runtime test of Foundry.
- **API-verified:** public API documentation states a contract; proprietary implementation was not inspected.
- **Publisher-documented:** product documentation/changelog says a behavior exists. It was not reproduced here.
- **Proposed:** ArenaStar design, not a claim about either upstream project or current ArenaStar runtime.

No Foundry instance was run. No public/private module account was authenticated. No upstream artwork or implementation code is added to the app. Original snippets are in [SNIPPETS.md](SNIPPETS.md); their small executable helpers are separate from production code.

## Ripper predecessor repositories — source inspected

Added at the user's suggestion after the Baileywiki ZIP remained unavailable. The dedicated [Ripper predecessor audit](RIPPER_PREDECESSORS.md) contains 12 reading cards, immutable code links, V13/V14 distinctions, licensing facts and a design/acceptance matrix. Predecessor pins: Better Roofs tag 3.0.0 at `df35cca8c73e7e8d420a81aada7b65c591c06d82`; Levels tag 6.1.0 at `17d4cfdd674b45e4abf4235416a23f889ba12163`. Current V14 comparison pins and decoded-byte SHA-256 hashes are in [source-pins.json](source-pins.json).

The useful mechanisms are tile-derived roof masks, linked occlusion, eye-height/tile-plane/wall-height queries, stair route continuation and per-level fog storage. These are **code-verified predecessor observations**, not evidence of Baileywiki's renderer. Better Roofs MIT is inspected; Levels has no located license grant in either inspected tree/README, plus a fog implementation provenance concern. Both adoption cases remain pending; no implementation/assets are transferred.

## Foundry V14 primary references

| Reference | Evidence and use |
|---|---|
| [V14 Stable 1, 14.359](https://foundryvtt.com/releases/14.359) | Official release describes native Scene Levels, shared scene combat/movement, supporting Regions and level-specific/shared placeables. Native levels, not the old Levels module. |
| [14.354](https://foundryvtt.com/releases/14.354) | Earlier development release explains the dedicated Levels configuration and keeping ordinary scenes simple. Historical context, not final implementation authority. |
| [BaseLevel](https://foundryvtt.com/api/v14/classes/foundry.documents.BaseLevel.html) | API example creates embedded Level documents with elevation bands and individual backgrounds/foregrounds. |
| [Level](https://foundryvtt.com/api/v14/classes/foundry.documents.Level.html#clampelevation) | Public elevation-clamping contract considers token depth/head and feet. Do not infer the underlying algorithm or all boundary rules from it. |
| [SceneLevelsSetField](https://foundryvtt.com/api/v14/classes/foundry.data.fields.SceneLevelsSetField.html) | Public nullable set referencing specific Level documents. Native ArenaStar scopes intentionally avoid ambiguous empty lists. |
| [DefineSurfaceRegionBehaviorType](https://foundryvtt.com/api/v14/classes/foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType.html) | Public contract: surfaces can restrict light, movement, sight and sound. |
| [ChangeLevelRegionBehaviorType](https://foundryvtt.com/api/v14/classes/foundry.data.regionBehaviors.ChangeLevelRegionBehaviorType.html) | Public contract: token-entry behavior prompts a level change. ArenaStar automatic unambiguous stairs are a deliberate UX choice, not a claim that Foundry never prompts. |
| [Scene Regions article](https://foundryvtt.com/article/scene-regions/) | Multiple shapes, negative holes, elevation bands and event/behavior model. Useful concepts; article screenshots/text may predate the latest V14 APIs. |
| [Walls article](https://foundryvtt.com/article/walls/) | Independent restrictions, limited/proximity/reverse-proximity behavior, direction, secret doors, door states and animation. Keep type/state semantics separate when importing. |

Documentation discovery caveat: `/article/scene-levels/` and the guessed `BaseSceneLevel` API URL returned 404. The actual public class is `BaseLevel` / `Level`. The Scenes article still contains older UI descriptions; it was not used as definitive V14 schema documentation.

## Better Levels: verified publication, unverified code

- Product: **Baileywiki Better Levels**, publisher **Baileywiki**.
- Observed public version: **2.0.14**, released **2026-10-10**, manifest minimum/verified core **14**.
- [Product page and changelog](https://foundrymods.com/modules/baileywiki-better-levels).
- [Machine-readable module listing](https://foundrymods.com/api/v1/modules/baileywiki-better-levels).
- [Public manifest](https://foundrymods.com/api/v1/manifest/baileywiki-better-levels).
- Manifest's versioned download: `https://foundrymods.com/api/v1/modules/baileywiki-better-levels/download?version=2.0.14`.
- Download attempt through `fetch_page`: **HTTP 500**. No binary/source retrieved; no archive hash, internal filenames or license verified. GitHub repository/code searches did not locate a public source repository. This does not prove the source is unavailable elsewhere.
- Foundry's guessed package URL returned 404; the functioning publication used here is FoundryMods. Do not confuse this project with `theripper93/Levels` or similarly named game plugins.

### Behavior extraction

All rows here are **publisher-documented**, not code-verified:

| Feature | Extracted requirement | Design response |
|---|---|---|
| Auto-build + level manager | Generate bands; preserve matching levels; visibility grid; meaningful names | Stable IDs and explicit plan; conservative default visibility; no token movement from view selection |
| Floor/Roof/Basement/Balcony roles | Configure tile behavior and create surfaces | Explicit structural role; native Surface behavior; decoration is not inferred as a floor |
| Pixel-footprint surfaces | Optional Mass Edit tracing; rectangle fallback | Own bounded alpha pipeline using existing ArenaStar alpha masks; no module dependency |
| Faux Overhead | Mask under painted-in art without creating a tile | Per-token mask against original art; physical surface optional |
| Partial cover / true-LOS ghost | Clip edges; display genuinely seen tokens | Separate authoritative perception, clip mask, ghost and interaction state |
| Keep-lit / roof-like occlusion | Presentation and lighting options | Three masks; no global fog whitening; explicit level scope |
| Build mode | Hide overhead art and higher-floor region handles while editing | Client-local view filter, never persisted `hidden` changes |
| Audit | 32 upstream rules, categorized fix actions | Start with own bounded rules and explainable atomic plans; do not assert identical rule count or implementation |
| Visible-token-only experimental option | Preserve cover art while displaying seen cross-level tokens | Dedicated visual overlay, same logical target; no duplicate interactive entity |
| Level-change elevation correction | Match token elevation to intended destination floor | Host updates level/Z together; flight and explicit offsets handled separately |
| Backup/restore and cutouts | Safety before structural edits | Existing local Save now/export plus inverse transaction; structural snapshot if needed |

### Changelog-derived regression fixtures

1. **2.0.2 (September 10):** affected-level filtering prevented unrelated sealed-basement tokens from being concealed by a surface overhead.
2. **2.0.8 (October 1):** keep-lit required viewed-level gating to avoid basement fog holes.
3. **2.0.12 (October 9):** cross-level outlines needed correct token controls/targeting/decorations and GM viewed-level handling. Light wording says blank assignment is intentional in that module; placement elevation remains important.
4. **2.0.14 (October 10):** tile-role actions only while helper panel open; build mode alone no longer exposes them.

The product page's “native roofs” wording is treated as a claim about its current integration; it is **not** used to assert that every option is implemented by Foundry core itself. Likewise the July [community guide](https://foundrymods.com/how-to/foundry-v14-levels) is useful historical orientation, not authoritative for October dependency/light policy.

### Exact follow-up for a supplied source archive

1. Record archive SHA-256, internal `module.json` version/dependencies and all license/notice files before reading or adopting code.
2. Identify Faux behavior registration, mask/shader construction, per-client settings, viewed-level and enabled-level predicates.
3. Trace token visibility, decoration suppression, hover/target/HUD integration and any duplicate-token rendering path.
4. Trace keep-lit versus fog exploration, holes, surface creation and invalidation on Level Manager commit.
5. Review audit rule descriptors, repair transactions, backup behavior and legacy migration; distinguish current paths from commented/retired code.
6. Inspect referenced third-party code (including the credited Floor-Cutout) independently. Public availability or attribution does not supply a verified license.
7. Add exact file/range permalinks if a public source pin exists, otherwise archive path/range/hash references. Keep licensed source out of production until review closes.

## Monk's source reading

Repository: [ironmonk108/monks-wall-enhancement](https://github.com/ironmonk108/monks-wall-enhancement).

**Pin:** `79c722aef1cb772885ab28e8a267b5178c06fabe` (commit date 2026-05-17; message “Changing the issue templates”). Manifest at this pin reports `14.01`, minimum/verified Foundry `14`. Do not confuse a later repository indexing/update date with this code pin.

The following source files were fetched through GitHub's contents API at that exact commit: main implementation, `settings.js`, `module.json`, `README.md`, `LICENSE`. File hashes are in [source-pins.json](source-pins.json). Sources were examined in an ephemeral research cache, not vendored into the app.

### Reading cards

| Card | Exact source range | Mechanism observed | Transfer decision |
|---|---|---|---|
| M01 | [main L18–35](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L18-L35) | libWrapper or dynamic `eval` prototype patching | **Reject architecture.** Use explicit imports/callbacks; CSP stays intact. |
| M02 | [main L147–200](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L147-L200) | One-way-door sweep inclusion override, secret-door visibility and controlled-token side checks | Reference behavior only. Host-side authorization required; do not merely hide the icon. |
| M03 | [main L255–361](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L255-L361) | Collect exactly coincident endpoints; mutate connected previews; write each participant; manually combine history entries | Keep frozen adjacency idea; replace persistence/history handling with one envelope and derived previews. |
| M04 | [main L405–557](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L405-L557) | Freehand points, graphics preview and simplified wall chain | Reimplement against local interaction state, bounded sampling and atomic creation. |
| M05 | [main L570–615](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L570-L615) | Endpoint exclusion, segment projection, distance threshold, update original then create copy | Reuse ArenaStar's own projection/picking geometry; single batch, portal safeguards. |
| M06 | [main L617–640](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L617-L640) | GM-only Ctrl/right-click switches door/secret type; state is separate | Add explicit secret/type field; never map type to ArenaStar's state number. |
| M07 | [main L737–777](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L737-L777) | Scene-change prompt and width/height-ratio repositioning | Use complete affine transforms with preview/scope; ratio-only is insufficient for our transforms. |
| M08 | [main L781–801](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L781-L801) | Nearest endpoint scan over scene walls, tolerance gate | Level/height-partitioned index and stable ties; CSS-space tolerance. |
| M09 | [main L827–884](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L827-L884) | Recursive farthest-point simplification uses squared segment distance | Standard geometry idea only. Its call passes `tolerance` directly to a squared-distance parameter: do not copy that unit ambiguity or claim it is necessarily an upstream bug. |
| M10 | [main L886–954](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L886-L954) | Nearby selected endpoints averaged, updates issued while iterating | Freeze input and form bounded deterministic clusters; one update per wall; no transitive drift. |
| M11 | [main L1147–1238](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L1147-L1238) | Rect/ellipse/polygon drawing conversion then source deletion | Preserve originals by default; transformed geometry; delete only by explicit atomic plan. |
| M12 | [main L1245–1286](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L1245-L1286) | Four-edge boundary creation; close only open typed doors | Level-scoped boundary/door batches; preserve locks and exclude windows by default. |
| M13 | [settings](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/settings.js) | Toggles plus simplification/join/snap tolerance settings | Small optional tool palette and explicit units; not a new approval workflow. |

Additional inspected paths: [main L80–143](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L80-L143) (**M14**) intercepts movement keys, throttles updates and nudges either/both endpoints according to modifiers; [main L1473–1521](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/monks-wall-enhancement.js#L1473-L1521) (**M15**) adds numeric endpoint editing. Reuse those UX capabilities with focused input handlers and gesture-batched Ops, not a global keyboard override. The source also defines a `togglewalls` control near L1342; visibility-on-other-tools is a GM presentation aid, never a player disclosure control.

**Commented code caveat:** a wall-preset switch around main L650–679 is commented out. It mentions proximity windows, but is not evidence that this block currently implements them. Foundry's own Walls documentation is the stronger behavioral source for proximity policies. No claim is made that this static review exhaustively exercised every path in Monk's module.

### License facts

- [LICENSE at pin](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/LICENSE): GPLv3 text.
- [README at pin](https://github.com/ironmonk108/monks-wall-enhancement/blob/79c722aef1cb772885ab28e8a267b5178c06fabe/README.md): additionally claims Commons Clause and Foundry's limited EULA license.
- Engineering conclusion: source adoption remains **pending**, not approved. Record the discrepancy for qualified review; no legal determination about enforceability is made here.

## Architecture files actually checked

`src/core/documents.ts`, `ops.ts`, `store.ts`, `projection.ts`, `messages.ts`, `movementPolicy.ts`, `regionGeometry.ts`, `tileTriggerZone.ts`, `automation.ts`, `fogExploration.ts`, `sceneCopy.ts`; `src/canvas/stage.ts`, `layers/TilesLayer.ts`, `vision/wallKinds.ts`, `vision/wallSight.ts`; `src/client/fogExploration.ts`, `sceneLighting.ts`; `src/workers/vision.worker.ts`; `src/host/sync.ts`, `worldFile.ts`; `src/storage/idb.ts`; wall picking/toggling call sites in `src/app/App.svelte`; existing adoption/legal policy.

Useful discoveries: source scene geometry is nested in embedded arrays; store envelopes roll back on apply failure; current fog is keyed only by scene/user; current non-hidden tokens are not transport-LOS-redacted; light already uses its own restriction axis; existing ordinary regions are convex; fixed-rotation movement sweep exists but is presently called from automation. These details materially constrain the design.

## Reproducibility

The JSON pins preserve source identity without redistributing upstream code. To reproduce a Monk reading card, use the exact commit permalink or GitHub contents API with `ref=79c722aef1cb772885ab28e8a267b5178c06fabe`, then compare the decoded file bytes to the stored SHA-256. Do not replace the pin with a moving `main`/`latest` reference during implementation review.

The public web/API pages are mutable, dated observations rather than immutable source snapshots. Better Levels' code-review gap should be closed with an archive hash, not hidden by citing a product page as if it were a shader source file.

For Ripper reading cards, use the repository/commit/path from the corresponding source-pins entry with the GitHub contents API, decode its base64 content and compare SHA-256 without newline normalization. The V13 and V14 snapshots are deliberately separate. A filename remaining in a V14 tree does not prove its old handler is still imported by the entry point.
