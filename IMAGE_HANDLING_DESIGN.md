# Image handling system — design

**Status:** revision 5 · module-capability parity review updated 2026-10-09 · decisions 1–8 and A–D answered (§11) · **Branch:** `arena/bb3f6bb6-arenastar-vtt`

**Goal.** Specify one image-ingest system for ArenaStar VTT that reproduces the core user-facing
capabilities of three Foundry VTT modules where possible, with adaptations and deliberate exceptions
called out rather than implying exact parity:

- **Mini Uploader** (xthesaintx; marketed as Stephen Garrett's wgtnGM tools): drop files on the window,
  convert to WebP, store, and add as journal pages.
- **Scene Express** (ldng): drop an image on the Scenes tab, get a new scene sized to the image.
- **Sephral's Image Paste & Drop** (Sephral, "SIPD"): paste clipboard images or drop image files/URLs,
  preview them, then choose a target (scene background, foreground, tile, journal page, show to players, preview).

It also has to cover the Foundry-core image behaviour those modules sit on: background sizing,
grid alignment, offset and scale, tile sizing, and foreground layers.

Every claim about Foundry or the modules is cited in §2 and §3. Every claim about this repository is
checked against code and cited by path in §4. Design choices are marked **Decision** or **Proposal**.
§11 records the resolved product decisions. **This revision is not yet a full capability replica:** §7 separates covered,
adapted, intentionally excluded and unverified module behaviors; do not read a green row as implementation.

---

## 1. Scope and non-goals

**In scope:** ingest of raster images (PNG, JPEG, WebP, GIF, AVIF) from files, clipboard, dragged URLs
and in-app drags; image URLs used directly for scene backgrounds, tokens and tiles (§6.9); conversion and derived variants; sizing and alignment of scene backgrounds,
foregrounds and tiles; journal image pages; permissions and undo for all of it.

**Phase 4 candidates:** video backgrounds (Foundry supports them; Mini Uploader's video claim is unverified)
and a shared asset-library UI. Show-to-players is A-8 in Phase 2 below, not a Phase 4 candidate. Audio ingestion
is explicitly excluded; Mini Uploader's audio claim is unverified.

**Explicit exceptions / non-goals:** Foundry's physical server-folder APIs and The Forge integration
(ArenaStar uses its own content-addressed store, not Foundry's server filesystem); Foundry's Tile Browser as a
file manager; UI theme controls (user decision B); and audio ingestion
(the app's playlists keep their own path). These are **not** full module parity. User-visible upload-directory
selection is in scope as a logical-folder workflow (§5.2, §6.2): a content-addressed store alone does not
replace it. Logical folders intentionally do not reproduce Foundry filesystem paths or Forge-specific storage.

---

## 2. Foundry VTT reference behaviour

Sources are the official Scenes article, the official Tiles article, the Content Creation style guide,
and the Foundry grid and scene guides cited inline.

| Topic | Foundry behaviour | Source |
|---|---|---|
| Background size | The background image determines the scene's dimensions. Dimensions can be overridden in *Image Dimensions*. A link button keeps the aspect ratio. Clearing both fields and saving resets them to the image's size. | [1] |
| Resize with placeables | When scene dimensions change, Foundry tries to reposition tokens, tiles, lights, walls, templates, sounds, drawings and other placeables. Drastic changes may still need manual fixes. | [1] |
| Padding | *Padding Percentage* adds a border around the background, as a percentage of scene size. Padding is unlit and hidden unless a vision source is there. Changing padding after detailing a scene displaces placeables. | [1] |
| Background offset | *Offset Background* X and Y in pixels shift the image to line up pre-drawn grids. | [1] |
| Background scale | The Grid Configuration Tool has a *Background Image Scale*. In a third-party guide, Shift + scroll adjusts it. | [1][3] |
| Grid size | Pixels per square. Default 100, minimum 50. Most maps use 70, 100, 140 or 200. Changing grid size can misalign walls, lights, notes and tiles. | [1] |
| Grid must be integer | Grids must be integer sizes; decimal grids do not work. Larger grids give finer snap points: 128 px+ gives 1/16 squares, 64 px+ gives 1/8, 50 px+ gives 1/4. | [2] |
| Grid from a pre-gridded image | Divide image width and height by the number of squares. Example: 3080×2520 px with 22×18 squares gives 140 px. | [1] |
| Grid alignment tool | An angled-ruler tool next to the grid type dropdown provides a dedicated alignment workflow. | [1] |
| DPI | Foundry ignores DPI/PPI. Quality comes from pixels per grid square. | [2] |
| Foreground | An optional overlay drawn above the scene like an overhead tile, with no occlusion. It must match the background size and is resized automatically if it does not. Elevation sets how tokens interact with it. | [1] |
| Tiles | Tiles render images and video and integrate with lighting and vision. Distinguish the GM-facing tile-editing layer from placed tile visibility: visible tiles render for players; hidden tiles do not. | [4] |
| Tile sizing | A tile can be placed at a size set by dragging, or from the Tile Browser at an *Asset Grid Size*. Example: a 256 px icon on a 100 px grid becomes 2.56 squares; with Asset Grid Size 128 it becomes 2×2. | [4] |
| Tile occlusion | Fade, Surface, Radial and Vision modes, each with an occlusion alpha. Overhead tiles can also act as roofs that block light. | [4][5] |
| Thumbnails | Scene thumbnails include overhead tiles. | [5] |

**Takeaways for the design:** Foundry derives scene size from the image, lets users override it with an
aspect lock, and has padding, offset, scale, foreground and an asset-grid concept for tiles. Scale and
alignment are per-scene properties, not image properties.

---

## 3. The three modules

### 3.1 Mini Uploader (xthesaintx / Stephen Garrett)

- **Evidence status:** the package listing and documentation describe version 3.5, Foundry 13+ (verified
  on 14), window-wide batch image drop, WebP conversion, journal pages, and settings [6][7]. The source
  repository URL returned 404 during this review, so these are documentation claims, not source-verified
  behavior.
- **Documented flow:** drop one or more image files anywhere on the Foundry window. Each file is converted
  to WebP, uploaded, and added as a page in a target journal (default name "mini-uploader") [6][7].
- **Documented settings/storage:** upload folder (with `{worldId}` placeholder), target journal, *WebP
  Quality* from 0.1 to 1.0, *Auto-Create Journal*, and `uploads/{worldId}/webp-images/` [6][7].
- **Other documented capability:** Forge VTT detection [7]. The documentation site also claims video and
  audio, while the README describes images only. Neither media claim is verified against module source [6][7].
- **Not in scope for us:** Forge detection and Foundry's physical server-folder layout. User-visible
  destination selection is still addressed through logical folders (§5.2, §6.2).

### 3.2 Scene Express (ldng)

- **Versions:** the release listing identifies 0.14.1 (Foundry 12+, verified 14), LGPL-3.0 [8][9]. The current public `main` source was checked for this review; its `module.json` reports 0.0.1 and placeholder manifest/download URLs, so release metadata and repository metadata do not agree [8][9].
- **Flow:** a drop zone at the bottom of the Scenes tab. Each dropped image is uploaded and becomes a
  new scene with the image as background and the file name as the scene name [8].
- **Source-confirmed behaviour** (`src/scene-express.mjs`, public `main` rechecked on 2026-10-09 [10]):
  - Scene name is `file.name.split(".")[0]`, then `_` and `+` are replaced by spaces. This splits at the **first** dot and does not trim; “base name” is only an approximation. CV-6 below intentionally proposes cleaner extension stripping and trimming.
  - Dimensions come from decoding the file (`createImageBitmap` → `PIXI.Texture.from`), and are written to the scene's `width` and `height`.
  - `padding: 0`, `backgroundColor: "#000000"`, grid type and size from module settings.
  - World settings provide an enable/disable toggle, destination folder (default
    `worlds/<world-id>/scenes/`), duplicate behavior, and defaults for grid type/size, navigation,
    ownership (GM only or all players), token vision, fog exploration and immediate activation [10][17].
  - A thumbnail is generated with `scene.createThumbnail()` after the scene dimensions are set.
  - The submitted data includes a level named "Background" for Foundry 14+; this is Foundry-specific
    metadata, with no direct ArenaStar equivalent in this design.
- **Duplicate policy:** one setting chooses stop (the default), reuse the existing file, or overwrite it.
  Scene collisions use the normalized scene name; stored-file collisions use the original file name in
  the destination folder. Reuse/overwrite also update an existing same-name scene. Neither check compares
  content hashes [8][10].
- **Known issues:** users could not find the drop zone (issue #6) [11]. A bug where scenes were created
  with wrong dimensions was fixed in August 2026 (issue #11) [10][12]. Both are design lessons (§6.1,
  §6.4).

### 3.3 Sephral's Image Paste & Drop (SIPD)

- **Versions:** 1.0.1 (Foundry 13–14, verified 14) [13].
- **Inputs:** Ctrl+V outside text inputs (image clipboard items only); dropped image files; dropped
  image URLs that the browser can fetch [13].
- **Preview dialog:** always shown first, starting from configurable defaults [13].
- **Targets:**
  1. Create a new scene with the image as background.
  2. Replace the current scene's background.
  3. Replace the current scene's foreground.
  4. Create a centred tile.
  5. Create a centred tile scaled to fit the scene.
  6. Create a journal entry with an image page.
  7. Show the image to connected players.
  8. Preview only, in a window [13].
- **Storage:**
  - `worlds/<id>/sephrals-image-paste-drop/clipboard-images/YYYY/MM/` by default; the user can also invoke
    **Upload directory** and choose a different folder.
  - Replacing a background or foreground uses a deterministic path per scene.
  - **Show to players / Share image** persists or updates a deterministic shared-image path per user and
    broadcasts the shared image; it is not a broadcast-only, storage-free action.
  - Other persistent uploads are named by SHA-256 of their content, so identical content reuses one
    file [13].
  - Preview-only uses a temporary object URL and writes nothing to disk, unless the image is also shared [13].
- **Preferences:** client-scoped settings for paste/drop enablement, default action, remember/reuse last
  successful action, default share-to-players, activate scene, navigation, default upload directory and its
  history, dialog theme, and saved window sizes [13].
- **Access:** GM only by default. An optional restricted player mode lets players open the flow but
  limits them to preview [13].
- **Known limitations** (from the author): no reliable client-side delete [13]; uploading needs the file
  upload permission [13]; URL drops depend on the browser being able to fetch the URL [13]; tile
  insertion needs an active viewed scene [13].

---

## 4. Current state of ArenaStar_VTT

This is supporting implementation context only; it does not determine module parity. §7 compares module
capabilities with the design specification, independent of whether the current app already implements them.

Verified in the checkout on 2026-10-09.

| Area | What exists | Evidence |
|---|---|---|
| Asset storage and identity | Original and derived files use SHA-256 IDs. `AssetServer.import` defaults new assets to `visibility: "referenced"`; bytes use OPFS with IDB fallback. Deduplication is **per world**: records and OPFS paths are keyed by `worldId`; equal bytes in different worlds get the same hash but separate stored copies. | `src/host/assets.ts`, `src/storage/opfs.ts`, `src/storage/idb.ts`, `src/core/assetAccess.ts` |
| Import pipeline | `ImportPipeline.importImage` always stores the source bytes, plus a ≤256 px WebP thumbnail and ≤1024 px WebP mid-res (both quality 0.8). If **width or height >4096 px**, it also stores 1024 px WebP tiles (quality 0.85; partial edge tiles). Each variant/tile has its own hash; descriptors sit on the original asset. | `src/host/import.ts`, `src/workers/assetJobRun.ts`, `tests/assets/import.test.ts` |
| Decode and validation | `createImageBitmap` + OffscreenCanvas run in an inline worker when available; `AssetWorkerCodec` has a main-thread fallback. `fitWithin` does not upscale. There is no app-level magic-byte allowlist/SVG rejection, explicit EXIF/GPS policy, or decoded-pixel limit; the original bytes are kept unchanged. | `src/workers/asset.worker.ts`, `src/workers/assetWorkerClient.ts`, `src/workers/assetJobRun.ts` |
| Scene model | `SceneDocument` has `img`, `width`, `height`, `grid` (type, size, distance, units, diagonals, hex layout), and embedded placeable arrays. There is **no** offset, background scale, padding, background colour, or foreground field. Its `img` comment permits URLs, but that alone does not mean the renderer handles them. | `src/core/documents.ts` ~L690–720 |
| Tile model | `TileDocument` has position/size, `img`, optional rotation/sort/hidden/trigger fields, `above`, and roof/fade occlusion. There is no asset-grid size or scale mode. | `src/core/documents.ts` ~L144–165 |
| Journal image pages | `JournalPageDocument.src` exists and asset entitlement code recognizes it, but the standard journal reader renders only `page.text`; there is no current image-page picker/renderer. Campaign Codex image widgets are a separate feature. | `src/core/documents.ts` ~L413, `src/ui/journals/JournalPage.svelte`, `src/ui/journals/JournalsPanel.svelte`, `src/core/assetAccess.ts` |
| Background render / variants | `SceneBackgroundPlayer` requests the thumbnail and full hash concurrently (thumbnail at `ui`, full at `scene` priority); it displays a thumbnail if it arrives before the full image. It does not use the manifest's mid-res or large-map tile descriptors. `renderChain`/`loadProgressive` implement and test thumb→mid→full, but have no production caller. No current map renderer consumes `AssetManifestEntry.tiles`. | `src/client/sceneBackground.ts`, `src/client/assets.ts`, `src/canvas/stage.ts`, `tests/assets/import.test.ts` |
| URL images | `TileImageCache` directly attempts `http(s):`, `data:` and `blob:` tile sources with `crossOrigin = "anonymous"` (cross-origin WebGL use needs a CORS-readable image). `SceneBackgroundPlayer` treats `scene.img` as an asset hash. The token schema comment permits a URL/hash, but `stage.syncTokens` draws a placeholder and ignores `token.img`; no token artwork currently renders. CSP allows external `https:` images, not `http:`. | `src/canvas/imageTexture.ts`, `src/canvas/layers/TilesLayer.ts`, `src/client/sceneBackground.ts`, `src/canvas/stage.ts`, `src/core/documents.ts`, `index.html` |
| Asset permissions and rights metadata | Manifest visibility (`gm`/`referenced`/`world`) controls who receives an asset; new imports default to `referenced`. `assetAccess` grants a referenced source's thumbnail/mid/tile hashes the same entitlement. The optional `exportRights` field is FX-oriented but stored on generic assets and can affect world-file export. Ordinary map-image imports do not set it or collect source/license attribution. | `src/host/assets.ts`, `src/core/documents.ts` ~L752–770, `src/core/assetAccess.ts`, `src/host/worldFile.ts` |
| Asset writes, permissions and audit | Asset bytes and `assetManifest` are written by `AssetServer`, outside document Ops/OpLog. The current client protocol has `asset.get`/`asset.chunk` for host-to-client reads, not a player upload message. `TRUSTED` currently permits create of tokens/drawings/templates only; it does not grant image upload or scene/tile/page creation. | `src/host/assets.ts`, `src/core/messages.ts`, `src/core/permissions.ts`, `src/core/agents/writeTools.ts` |
| Theme | No light/dark theme switch exists. The UI is styled dark. Themes and dark mode are an open polish item (G-40). | `src/app/App.svelte` styles; `STATUS_ASSESSMENT_2026-09-21.md` §2.3 |
| Map import | The sidebar's **Import map** (file input, `accept="image/*"`) reads the entire file into memory, imports it, then updates the active scene's `img` and intrinsic `width`/`height` (or falls back to the default scene). It neither creates a scene nor changes grid/geometry. `File.type` is trusted, falling back to `image/png`; no direct-import size cap is applied. | `src/app/App.svelte` ~L2900–2960, ~L4457 |
| Grid editor | Settings → *Scene grid* edits the tactical/strategic ruleset scale (`flags.core.scale`) plus grid type, hex layout, size, distance, units and diagonal rule; it has no map-background offset/scale/padding/colour/foreground controls. | `src/ui/settings/SettingsPanel.svelte` ~L416–560 |
| Drop targets | The canvas `ondrop` handles only app-internal compendium and encounter payloads; there is no general window/canvas image-file or URL drop path. | `src/app/App.svelte` ~L4559–4573 |
| Paste | No clipboard-image paste handler. `src/ui/clipboard.ts` only copies text. | `src/ui/clipboard.ts`; search of `src` for `paste` |
| Agent path | The agent `asset.import` tool is wired to the host's `ImportPipeline` through `AgentWorldViewOptions.importImage`; it has an 8 MiB source cap in `agentBridge.ts`. This is a host-local agent capability, not a general player upload route. | `src/core/agents/writeTools.ts`, `src/app/agentBridge.ts` ~L215–223, ~L1571–1587, `src/app/App.svelte` ~L3089–3094 |
| CSP | `img-src` allows `'self' data: blob: https:`. `connect-src` allows `https:`. | `index.html` |
| Asset limits | No general source-byte or decoded-pixel cap exists in `ImportPipeline` or the ordinary file picker. The agent `asset.import` route is capped at 8 MiB. Codex-bundle (32 MiB) and world-file entry (128 MiB) caps are separate paths, not normal image-import limits. | `src/app/App.svelte` ~L2900–2910, `src/app/agentBridge.ts` ~L222–223, `src/core/campaignCodexBundle.ts`, `src/host/worldFile.ts` |
| Placeables on resize | No code moves placeables when a scene's width or height changes. **Import map** changes the image and dimensions; embedded coordinates/sizes are not transformed. | search of `src/host` and `src/core`; `src/app/App.svelte` ~L2944–2962 |

**Gap summary.** The repo has storage/derivation, a tile-only remote-URL texture path, and a progressive
variant helper that is tested but not connected to a production renderer. Missing are app-wide paste/file
and URL ingest, preview, scene creation from an image, and an image-page editor. The scene background does
not currently accept a URL in its renderer, and token art is not rendered at all. Foundry-style geometry
(offset, scale, padding, foreground, asset-grid sizing, aspect lock) and grid alignment are also absent.
Asset bytes are written outside HostSync/OpLog; player upload and audit therefore need a new host-side path,
not just UI controls or a `TRUSTED` role check.

---

## 5. Requirements

Each requirement lists the module or Foundry feature it comes from. **M** is Mini Uploader, **SE** is
Scene Express, **SIPD** is Sephral's Image Paste & Drop, **F** is Foundry core.

### 5.1 Input

| ID | Requirement | From |
|---|---|---|
| IN-1 | Drop one or more image files anywhere on the app window. Batch import with per-file progress. | M, SE |
| IN-2 | Visible drop zone in the Scenes sidebar that creates one scene per dropped image, with a world-level enable/disable setting. | SE |
| IN-3 | Ctrl+V pastes a clipboard image when focus is not in a text field. Use the `paste` event, not `navigator.clipboard.read()`, to avoid permission prompts. | SIPD |
| IN-4 | Drop or paste an image URL. Accept `text/uri-list` and `<img src>` from `text/html`. Resolve it as described in §6.9. | SIPD (drop), user (URL paste) |
| IN-7 | Image URLs can be used directly for scene backgrounds, tokens and tiles, not only uploaded files. | user |
| IN-8 | Pinterest: accept the image address (`i.pinimg.com/...`). Proxied image links work as ordinary links. A Pinterest **pin page** link is detected and explained, not silently failed. | user |
| IN-9 | When the browser blocks a direct read, show a plain message with the save-and-drop instruction (§6.9). | user |
| IN-5 | Drop an image from an external app onto the canvas to place a tile. Placing from the asset library is a Phase 4 item. | F, SIPD |
| IN-6 | Drop targets are visibly labelled, with a hint shown while dragging over the window. | SE issue #6 |

### 5.2 Conversion and storage

| ID | Requirement | From |
|---|---|---|
| CV-1 | WebP conversion with quality 0.1–1.0 (default 0.8). Product decision: keep the original by default and convert only by preference; this intentionally differs from Mini Uploader's documented convert-on-every-upload behavior. | M; decision 1 |
| CV-2 | Persist thumbnail, mid-res and large-map tile variants as today; do not imply the current map renderer consumes all of them (§4). | existing |
| CV-3 | Detect the real format from magic bytes, not the file extension or MIME type. Reject unsupported formats and SVG. | security |
| CV-4 | Apply EXIF orientation when decoding, so the size and rotation match what the user sees. Strip GPS metadata from derived variants. | SE (sizes), security |
| CV-5 | Content-hash deduplication. Identical bytes reuse one asset. No filename-based dedupe. | SIPD (better) |
| CV-6 | Scene and journal names come from the file name: strip the extension, replace `_` and `+` with spaces, trim. | SE |
| CV-7 | Separate document-name and logical-folder collision policies. Support Scene Express outcomes (stop, reuse existing, overwrite/replace) as configurable modes, defaulting to stop, with an Ask mode (create new, replace, cancel) and content-hash reuse for identical bytes. Replacing a reference stores the new hash and leaves old bytes for cleanup; it must not mutate another document's shared hash asset. | SE, SIPD; safer adaptation |
| CV-8 | Limits: a source-file cap and decoded-pixel cap to stop decompression bombs. Agreed: 64 MB and 100 megapixels (§11). Check byte length before buffering and dimensions before full bitmap allocation; `createImageBitmap` alone may decode too early to enforce the pixel cap. | security |
| CV-9 | User-visible logical destination folders: select a folder for an import, retain a default and recent-folder history, expose an Upload directory action, and allow a world-level scene-drop destination. Persist each logical `(folder, display-name)` alias separately from the content hash, so identical bytes can appear under multiple names/folders without duplicate blobs. This is collection organization, not a server filesystem path. | M, SE, SIPD; adapted for this app |
| CV-10 | Preserve the stable storage roles SIPD exposes: per-scene background/foreground slots and a persistent per-user shared-image slot. The slot points to the current asset hash; content remains immutable/addressed by hash and superseded blobs remain cleanup candidates. | SIPD; logical-slot adaptation |

### 5.3 Destinations (actions)

| ID | Action | Writes | From |
|---|---|---|---|
| A-1 | New scene with the image as background | `create scene`, plus `img`, `width`, `height` | SE, SIPD |
| A-2 | Replace the active scene's background | `update scene` (`img`, `width`, `height`) | SIPD, Import map (today) |
| A-3 | Replace the active scene's foreground | `update scene` (`foreground.img`, see §6.2) | SIPD |
| A-4 | Centred tile at natural size in the active/viewed scene; disable or explain the action when no scene is available. | `create tile` | SIPD |
| A-5 | Centred tile scaled to fit the active/viewed scene; disable or explain the action when no scene is available. | `create tile` | SIPD |
| A-6 | Tile at Asset Grid Size | `create tile` | F |
| A-7 | Journal page with the image; use the selected target journal, and optionally create it when missing (default name `mini-uploader`). | `create page` with `src`; optional `create journal` | M, SIPD |
| A-8 | Show to connected players; persist/reuse a stable per-user shared-image slot, then broadcast its asset reference. | persistent asset write plus ephemeral message | SIPD |
| A-9 | Preview only, nothing persisted | none | SIPD |

Document writes (create/update scene, tile, page, etc.) are HostSync intents and go through `can()`,
the OpLog and Revert. **The asset bytes and `assetManifest` are not:** `AssetServer` writes them outside
Ops (D-015), so current map/agent imports do not appear in the world OpLog and Revert cannot delete the
blob. The design must add a host-side upload authorization/audit path; document undo can remove the
reference, while orphaned bytes remain until the cleanup step in §6.8.

### 5.4 Sizing and alignment

| ID | Requirement | From |
|---|---|---|
| SZ-1 | Scene size defaults to the image's pixel size. | F, SE |
| SZ-2 | Aspect-locked width and height editing, with a reset to image size. | F |
| SZ-3 | Background offset X and Y in pixels. | F |
| SZ-4 | Background scale, changeable with Shift + scroll and numerically. | F |
| SZ-5 | Padding as a percentage, default 0. Padding area is unlit unless vision reaches it. | F, SE (padding 0) |
| SZ-6 | Grid size is an integer ≥ 50. Default 100. The UI suggests 70, 100, 140 and 200. | F |
| SZ-7 | Grid from a pre-gridded image: a helper takes the image width and the number of squares and sets grid size. | F |
| SZ-8 | Grid alignment tool: live preview of grid lines over the background while adjusting size and offset. | F |
| SZ-9 | Foreground image is resized to the scene size on import, with a warning if the aspect ratio differs. | F |
| SZ-10 | Tile sizing: natural size, asset grid size, or fit-to-scene. | F, SIPD |
| SZ-12 | Background colour defaults to white (`#ffffff`). The GM can choose any colour or shade with a colour picker or a typed value, per scene. This intentionally differs from Scene Express's `#000000` default. | decision; SE |
| SZ-13 | New-scene defaults are configurable: grid type and size (100 px default), navigation (off), ownership (GM-only), token vision (off), fog exploration (off), and immediate activation (off), matching Scene Express where the app has equivalent fields. | SE |
| SZ-14 | Generate a scene-list thumbnail after new-scene creation and refresh it when the background is replaced; do not leave a stale preview. | SE |
| SZ-11 | Dimension changes never move placeables silently. The user chooses: keep positions (default) or rescale placeables by the size ratio. | F (reposition), decision |

### 5.5 Permissions and privacy

| ID | Requirement | From |
|---|---|---|
| PM-1 | Only the GM can create or replace content by default. Players with the `TRUSTED` role may upload (PM-6). | SIPD, user |
| PM-2 | Optional restricted player mode: players can preview, and cannot persist anything. | SIPD |
| PM-3 | Preview-only writes nothing to the world. Use an object URL, as SIPD does. Existing `imageTexture` accepts bytes, not URL strings; Link-mode previews need a URL-aware loader and the same CORS checks as tile rendering. | SIPD |
| PM-6 | Keep `TRUSTED` as the product-level GM grant for player image upload. **Current code does not make that role an upload permission:** `can()` allows it to create tokens/drawings/templates only, not assets, scenes, tiles or pages. Add host-enforced upload authorization and explicit destination-document permissions (or keep those destinations GM-only); the GM role editor can grant/revoke `TRUSTED`. | user; current permission model: `src/core/permissions.ts`, `src/ui/permissions/PermissionsPanel.svelte` |
| PM-7 | Each upload by a granted player posts a GM-visible audit line naming the player and image, and is attributed in the OpLog. This is a **new requirement**, not current `AssetServer` behavior. | user, M (audit); current gap: `src/host/assets.ts`, `src/core/agents/writeTools.ts` |
| PM-4 | Collect no new source/license-rights metadata for ordinary image imports. Visibility (`gm`, `referenced`, or `world`) remains the audience setting. Repository nuance: `exportRights` is an optional, FX-oriented field on the generic asset record; ordinary map imports leave it unset, but existing values can affect world-file export and must not be silently widened or discarded on hash reuse. | user; `src/core/documents.ts`, `src/host/assets.ts`, `src/host/worldFile.ts` |
| PM-5 | Every persistent import is attributed to the user who made it, in the OpLog and a chat record when enabled. This needs an explicit host audit/OpLog path; asset imports are not document Ops today. | user, M (audit); current gap: `src/host/assets.ts`, `src/core/agents/writeTools.ts` |

### 5.6 Workflow preferences

| ID | Requirement | From |
|---|---|---|
| PF-1 | Client preferences cover paste/drop enablement, default and last successful action, default sharing, scene activation/navigation defaults, default upload folder and recent-folder history, and saved dialog/window sizes. Theme selection is intentionally excluded (decision B). | SIPD |
| PF-2 | Select a target journal; if none exists, an Auto-Create Journal option creates one (default name `mini-uploader`). | M |
| PF-3 | Configure WebP conversion and quality from 0.1–1.0 (default 0.8), with conversion disabled by default per decision 1. | M; decision 1 |
| PF-4 | World-scoped Scene Express preferences cover the Scenes-tab drop-zone toggle, logical destination folder, separate logical-file and scene-name collision behaviors (stop by default), and the new-scene defaults in SZ-13. | SE |

---

## 6. Proposed design

### 6.1 Architecture

```
          ┌──────────────────────── input adapters (UI) ────────────────────────┐
          │ window drop (files / uri-list)  │ window paste  │ canvas drop │ sidebar│
          └────────────────┬────────────────┴───────┬───────┴──────┬─────────┴────┘
                           ▼
              ImageIngest (client): source detection, preview metadata, name normalisation
                           │
                           ▼
        ImportPreviewDialog (client): defaults from prefs; action choice; sizing preview
             ├── Preview only: in-memory bytes via imageTexture; URL preview needs URL loader
             ├── Link URL: document action stores the HTTPS URL (no asset upload)
             └── Store/file: NEW host upload gate (authorize, validate, quota, audit)
                                  │
                                  ▼
              ImportPipeline (host) → derive variants → AssetServer (OPFS/IDB; outside Ops)
                                  │ hash
                                  ▼
                 Action planner: action + sizing → document intents
                                  │
                                  ▼
            HostSync: intents → can() → apply → OpLog → project → broadcast
```

- **Client adapters** only collect source and intent. They never write documents directly. For player
  uploads, a new client-to-host transfer/request path is required; today's `asset.get`/`asset.chunk`
  protocol only fetches host assets to clients.
- **Action planner** is pure and shared between client and host. It takes validated image metadata and
  the chosen action, and returns document intents. This is where sizing rules live, so they can be
  unit-tested without a browser.
- **ImportPipeline** remains the host-side derivation/storage primitive, but host-side format/size/pixel
  validation and authorization must not rely on client checks. `AssetServer` updates asset bytes and
  `assetManifest` outside Ops/OpLog; it is not made undoable by placing a document intent after it.
- **Agents** continue to use the host-wired `asset.import` tool/`ImportPipeline`, not a player upload
  endpoint. `agentBridge.ts` currently imposes an 8 MiB cap; decide whether that agent-specific cap
  remains in addition to the proposed 64 MB general limit.
- **Show to players (A-8)** has two parts: persist or update the stable per-user shared-image slot, then
  emit an ephemeral broadcast that references its asset ID. `EphemeralKind` currently has no image/show
  kind, so this needs a new message/event contract and a durable asset write, but no new document Op.

### 6.2 Data model changes

All additions are optional, so existing worlds and world files keep loading (the same approach used
for `cells` and `regions`).

```ts
// SceneDocument additions
background?: {
  offset: { x: number; y: number };   // px, SZ-3
  scale: number;                      // 1 = natural, SZ-4
  padding: number;                    // fraction of max(width,height), SZ-5; default 0
  color: string;                      // CSS colour; default "#ffffff"; the GM may choose any colour or shade (SZ-12)
};
foreground?: {
  img: AssetId | null;
  elevation: number;                  // distance units, F "Foreground Elevation"
};
thumbnail?: AssetId | null;           // scene-list preview, refreshed on create/background change (SZ-14)

// Existing fields, now formally allowed to hold a URL (§6.9)
// SceneDocument.img:  asset hash | https URL | null
// TokenDocument.img:  asset hash | https URL

// TileDocument additions
assetGridSize?: number;               // provenance for A-6; informational

// AssetManifestEntry additions
source?: {
  kind: "file" | "paste" | "url" | "tile-browser";
  originalName?: string;
  originalMime?: string;
  url?: string;                       // optional GM-only provenance; may contain a bearer token
  importedBy?: string;                // user id; GM-only
};
ingest?: { format: "original" | "webp"; quality?: number };
logicalFiles?: Array<{ folder: string; name: string }>; // virtual aliases; content remains hash-addressed (CV-9)
```

**Persistence/projection boundary:** `AssetManifestEntry` is rehydrated from the `AssetRecord` stored by
`AssetServer`, and `worldFile.ts` serializes an explicit asset-field allowlist. Adding `source`, `ingest`, or
`logicalFiles` to the TypeScript interface alone will not persist it: add the fields to `AssetRecord`,
`import`/`describe` and `manifestEntry`, and world-file export/import validation, with reload/round-trip tests.
The per-user shared-image slot (`shareSlotByUser[uid] -> AssetId`) must also persist; project only assets a
viewer is entitled to receive. Provenance (`originalName`, `url`, `importedBy`) is GM-only;
`projectAssetManifest` currently returns manifest entries whole, so explicitly strip these fields from
player-projected manifests. A Store import should omit the source URL by default or safely redact it;
otherwise signed links may leak through player snapshots or world exports.

Client preferences (client-scoped, not replicated), covering SIPD and Mini Uploader controls:
`dropEnabled`, `pasteEnabled`, `defaultAction`, `rememberLastAction`, `lastUsedAction`, `defaultShareToPlayers`,
`activateNewScene`, `defaultNavigation`, `defaultUploadFolder`, `uploadFolderHistory`, `dialogWindowSizes`,
`targetJournal`, `autoCreateJournal`, `autoCreateJournalName` (default `mini-uploader`), `webpConvert` (false by
default per decision 1), and `webpQuality` (0.8; range 0.1–1.0). SIPD's theme preference is intentionally
omitted (decision B).

GM world settings (replicated): `playerUploadQuotaMB` (optional; unset means no quota, §11 item D) and
`sceneExpressDefaults` (`enabled`, `destinationLogicalFolder`, separate `duplicateFileBehavior` and `duplicateSceneBehavior` policies, `gridType`, `gridSize`,
`navigation`, `ownership`, `tokenVision`, `fogExploration`, `activateImmediately`). Their defaults follow
PF-4/SZ-13; `destinationLogicalFolder` is not a server path.

No new **document** operation kinds are needed for scene/tile/page changes; use existing `create` and
`update` ops. The asset-byte/manifest write is not currently an Op, so PM-5's upload attribution still
needs an explicit host-side audit/OpLog event (and optionally the agreed chat record). A-8 needs both a
durable per-user share-slot asset update and a new ephemeral image-broadcast message kind; the broadcast
is not a document Op, but the shared image is persistent.

### 6.3 Sizing rules (pure functions)

These are the only geometry rules. They live in `src/core/imageSizing.ts` and are tested directly.

- **Scene size from image:** `width = image.width`, `height = image.height`. Aspect-locked edits
  change one side and derive the other, rounded to the nearest integer.
- **Grid from pre-gridded image:** `size = round(image.width / columns)`. Reject sizes below 50. Warn
  when the result is not an integer divisor of the image height within 1 px.
- **Background transform:** `drawnWidth = width × scale`, `drawnHeight = height × scale`, drawn at
  `offset`. Padding adds `padding × max(width, height)` on each side, unlit by default.
- **Tile at Asset Grid Size:** `tileWidth = imageWidth / assetGridSize × grid.size` and
  `tileHeight = imageHeight / assetGridSize × grid.size`. Natural size uses the intrinsic pixel width
  and height.
- **Fit-to-scene tile:** the largest rectangle with the image's aspect ratio that fits in the scene,
  centred.
- **Placeables on resize (SZ-11):** default is no change. The opt-in rescale must transform each
  document type's pixel-space geometry (positions, endpoints, point arrays, bounds and dimensions), not
  blindly multiply every numeric field. Preserve rotations, elevations, grid-unit values and unrelated
  stats; state how normalized shapes and circular/radial geometry behave if X/Y ratios differ. Submit the
  resulting document changes as one batch so Revert restores them together.

### 6.4 Naming and duplicates

- Name normalization follows CV-6: strip only the final extension, replace `_` and `+` with spaces,
  and trim. This intentionally improves Scene Express's first-dot split. The file name is the default
  for scene and journal names; the preview dialog lets the user edit it before creating anything.
- Duplicate handling follows CV-7. Hash identity deduplicates identical bytes regardless of name or folder.
  The default collision mode is stop, matching Scene Express. For a logical-folder/name collision,
  expose reuse-existing and replace/overwrite modes; Ask mode
  can offer create-new, replace and cancel. For a same-name scene, the equivalent actions are stop, reuse
  the existing scene, or replace its image/reference. A replacement writes a new hash and changes the
  logical alias/reference; it never mutates bytes that another document may share. This preserves the
  useful outcomes of Scene Express's three modes without reproducing mutable server files.
- The product decision is to collect no new source/license-rights metadata for ordinary images. Audience
  visibility (`gm`/`referenced`/`world`) is separate. The repository still has generic `exportRights`
  metadata used by the world-file exporter (especially for FX); ordinary image import leaves it unset,
  but hash reuse must preserve any existing restriction and the design must not silently grant export.

### 6.5 Permissions

- Ingest is GM-only by default. Players without the `TRUSTED` role may open the preview dialog only;
  Persist and Show-to-players are disabled for them.
- `TRUSTED` remains the agreed GM grant for the new player-upload flow, but it is **not currently an
  asset-upload permission**. `can()` only grants TRUSTED create rights for tokens, drawings and templates;
  it rejects scene/tile/page creates. `AssetServer.import` is a direct host API, not a `can()`-checked
  intent, and there is no client-to-host upload message. Add a host-validated upload endpoint that checks
  the current role before bytes are persisted. Separately authorize the target document action: either
  extend `can()` for selected document types or keep those targets GM-only.
- The same host path must write the required per-user audit/OpLog record. The agent `asset.import` tool is
  a separate GM-host capability with an agent audit ring; it currently creates no document Op or Revert.
- The GM can revoke the role at any time. Revoking it stops new authorized uploads; it does not remove
  assets already uploaded or references already committed.
- Per-player upload quota: none by default. The GM can set one, and the value is whatever the GM chooses (§11 item D).

### 6.6 Security and limits

- **Format:** sniff magic bytes (PNG, JPEG, WebP, GIF, AVIF) on the host as well as the client. Reject
  SVG and anything outside the allowlist; do not trust `File.type` or the caller-supplied MIME. Current
  code delegates decode to the browser and stores the provided MIME, with no explicit format check.
- **Size:** source cap (agreed 64 MB) and decoded-pixel cap (agreed 100 MP). Enforce the byte cap before
  buffering and validate dimensions before full bitmap allocation on the host; `createImageBitmap` metadata
  alone is too late for a strict decompression-bomb guard. Current normal import has neither cap (the agent
  tool has its separate 8 MiB cap).
- **URLs:** HTTPS only. Store mode attempts a CORS-readable fetch in the GM's browser; Link mode loads
  the URL from each viewer's browser. There is no server proxy, because the app has no server.
- **Metadata:** make EXIF orientation handling explicit and scrub GPS from derived variants. Current
  decoding relies on browser defaults and does not inspect/scrub metadata; source bytes are stored
  unchanged. Canvas-encoded derivatives are not a deliberate source-metadata preservation path.
- **CSP:** `img-src` allows `blob:` and `https:`. `connect-src` allows `https:`. No CSP change is needed.
  URLs must therefore be `https:` in this app; plain `http:` is blocked, including an `http://127.0.0.1`
  test fixture (§9). `imageTexture` takes bytes, not URLs; link previews need a URL-aware texture loader.
- **Errors:** browser fetch/decode APIs often expose only a generic network/decode failure for CORS; do not
  promise the exact server-side reason. Show an actionable category (“could not read/load; possibly CORS”)
  and the save-and-drop fallback.

### 6.7 Platform notes

- **`file://`:** storage falls back to IDB, as today. URL drops may fail on CORS, which is handled.
- **Large maps:** over 4096 px, tiling already applies. The preview dialog warns when a map will be
  tiled.
- **Mobile:** the paste and drop paths are desktop-first. Touch devices use the file-picker path.

### 6.8 Undo and cleanup

- The document part of a persistent action (create/update scene, tile, page or background reference) can
  be one HostSync intent batch, so Revert removes that document change in one step.
- Asset bytes/manifest entries are written separately by `AssetServer`, outside Ops/OpLog. Upload can
  leave an orphan if the later document intent fails; Revert removes the reference but does **not** delete
  the content-addressed blob. Do not describe the whole import as atomic or fully undoable.
- Orphaned assets (including a replaced background or reverted action) remain until a later **Clean up
  unused images** command, GM-only, lists unreferenced assets and deletes them after confirmation. The GM
  can download assets first.
- This addresses SIPD's limitation: it has no reliable delete, so its files accumulate.

---

### 6.9 URL sources: direct links, proxied links and pin pages

**Decision (user, 2026-10-09):** an image URL can be used instead of an uploaded file, at least for scene
backgrounds and tokens. Pinterest is the main source, and some of those links already go through a proxy.

**Principle.** Store mode asks the GM's browser to read the pasted `https:` URL; Link mode keeps the URL
and each viewer's browser loads it through a CORS-enabled image/texture path. A proxied link is just another
link: if its final image response permits the browser read, it works without an app proxy setting or
service-specific code. The app never adds a proxy of its own.

**Why some links fail.** Showing a cross-origin image needs no special headers. Reading its bytes does:
storing a copy, or drawing on the WebGL canvas, needs the host to send `Access-Control-Allow-Origin`
[14][15]. A host that does not send it blocks the read, so the image cannot reliably be drawn on the canvas
either.

**Pinterest.** A pin page (`pinterest.*/pin/...`) is HTML, not an image. The design asks for the image address
(the `i.pinimg.com` link), which the browser's *Copy image address* command provides. Browser JavaScript cannot
call Pinterest's API directly because of CORS [16]. I could not test whether `i.pinimg.com` sends the CORS
header, since this sandbox cannot reach it. That test is a release gate (§8, §9).

**Two modes.** Store is the default (§11 A). Link is available when the GM accepts that the URL must stay up.

| Mode | What is stored | Works when | Player experience |
|---|---|---|---|
| **Link** | The HTTPS URL in the chosen document field (`scene.img`, `tile.img` or `token.img`). The URL string is serialized with the world document; the external image bytes are not packaged. | The image host permits the CORS-enabled texture read. | Each client loads the URL and needs the source to stay up. Current direct-URL rendering exists for tiles only; scene backgrounds and token art still need renderers. |
| **Store** | The bytes, imported as an asset (§6.1). Optional source provenance is GM-only; omit or redact the source URL by default. | The GM browser can read the image under CORS. | Players receive the stored bytes through the asset pipeline. World export packages the asset bytes subject to the existing `exportRights` policy. |

**Steps when a URL is pasted or dropped:**
1. Accept only `https:` URLs. Anything else is refused, with the reason.
2. If it is a Pinterest pin page, stop with: "This is a Pinterest page, not an image. Copy the image address instead."
3. In Store mode, try a direct CORS read; in Link mode, validate/load through the CORS-enabled image texture path. If it works, continue in the chosen mode (Store by default).
4. If fetch/decode fails, show an actionable generic message: "The browser couldn't read or load this image (it may be blocked by CORS). Save the image to your computer and drop the file here." Browser JavaScript may not expose the server's exact CORS reason. Offer retry or choose another image; there is no relay fallback.

A proxied link goes through step 3 like any other link. If the final response permits the CORS read, it can be used in Link mode or copied in Store mode; if not, it reaches step 4 like any other.

**What the app does not build.** No relay, no proxy setting, no default service, and no server (the app has none).
Anything that needs one is covered by save-and-drop.

**Privacy.** In Store mode, the GM's browser contacts the image host directly; in Link mode, each viewer's
browser does. The app adds no third party. A proxy inside a pasted link is the GM's own choice and is part
of the destination the browser contacts.

**Players.** In Link mode, each player's browser fetches the URL, so each player needs the same access. In Store
mode, players receive the bytes through the normal asset pipeline.

**Limits of Link mode.** The external image bytes are not bundled, but the URL string remains in the relevant
world document and is serialized in `documents.json`. If the source disappears or blocks a viewer's CORS-enabled
texture request, the image cannot render. The GM can convert a linked image to a stored one at any time.

**Security.** An external URL is a third-party request made by every client. URLs are limited to `https:`
(matching the CSP), and the full destination is shown before import. ArenaStar does not attach its own
session credentials to the cross-origin read; use the anonymous-CORS texture mode. A Link URL may itself
contain userinfo or query tokens: it is stored in a document and projected to players who need to load it,
so disclose that before sharing. Store mode should not retain the source URL in provenance by default.

## 7. Module capability parity

This is a **design-spec review**, not an implementation checklist. `✓` means the feature is documented or
source-confirmed for that module (`✓*` = Mini Uploader documentation only; its source was not verified);
`—` means the module does not list that capability; `?` means a claim is unverified or conflicting. In the
design column, `✓` means specified (not implemented), `≈` means an intentional adaptation/difference,
and `⊘` means an explicit non-goal.

**Verdict: not strict full parity.** The earlier matrix overstated coverage. The current design now specifies
the missing user workflows and settings below, but intentionally does not reproduce Foundry filesystem paths,
Forge detection, SIPD's theme control, audio ingestion, or Foundry 14's Background level metadata. Video is
Phase 4, Mini Uploader's media claims are unverified, and Mini Uploader's source could not be checked. Logical
folders and stable asset slots reproduce user-facing organization/sharing, not physical path semantics.

| Capability | Mini Uploader | Scene Express | SIPD | Design disposition |
|---|---|---|---|---|
| Drop image files anywhere in the window | ✓* | — | ✓ | ✓ IN-1; supports batch import and per-file progress |
| Batch: handle each dropped file as a separate import | ✓* | ✓ | — | ✓ IN-1/IN-2 |
| Scenes-tab drop zone and enable/disable control | — | ✓ | — | ✓ IN-2; visible, world-configurable zone |
| Ctrl+V clipboard image outside text fields | — | — | ✓ | ✓ IN-3 |
| Drop a browser-readable image URL | — | — | ✓ | ✓ IN-4/§6.9; Store/Link behavior is specified |
| Paste URL text | — | — | — | ✓ IN-4; additional input beyond SIPD's image-only clipboard handling |
| Use URL directly for scene background, token or tile | — | — | URL is fetched/stored, not retained as a link | ✓ IN-7/§6.9; design adds Link mode and CORS handling |
| Preview dialog after paste/drop, initialized from preferences | — | — | ✓ | ✓ §6.1/PF-1 |
| Create scene from image (intrinsic sizing is explicit for Scene Express; SIPD README lists the action but not the sizing rule) | — | ✓ | ✓ (sizing unspecified) | ✓ A-1/SZ-1 |
| Replace current scene background or foreground | — | — | ✓ | ✓ A-2/A-3 |
| Centered tile and fit-to-scene tile | — | — | ✓ | ✓ A-4/A-5; requires an active/viewed scene or gives an actionable explanation |
| Journal entry/image page | ✓* | — | ✓ | ✓ A-7; target journal and create-if-missing are specified |
| Target journal and Auto-Create Journal | ✓* | — | — | ✓ PF-2; default new journal name is `mini-uploader` |
| Convert every upload to WebP with quality control | ✓* | — | — | ≈ CV-1/PF-3; quality range is covered, but original-preserving default intentionally differs |
| Upload-folder chooser/default/history | ✓* | ✓ | ✓ | ≈ CV-9/PF-1/PF-4; logical folders replace physical destinations |
| Foundry world/server folder paths and `{worldId}` layout | ✓* | ✓ | ✓ | ⊘ Physical paths are out of scope; logical folder membership is specified |
| Scene Express grid, navigation, permissions, vision, fog and activation defaults | — | ✓ | Some (navigation/activation) | ✓ SZ-13/PF-4; source defaults are recorded |
| Scene Express scene thumbnail generation/refresh | — | ✓ | — | ✓ SZ-14 |
| Scene Express stop / reuse / overwrite collision modes | — | ✓ | — | ≈ CV-7; mapped to immutable hashes, logical aliases and scene references |
| Scene/journal names derived from source filename | — | ✓ | — | ≈ CV-6; cleaner final-extension stripping intentionally differs from Scene Express's first-dot split |
| SHA-256 content reuse and collision-safe uploads | — | — | ✓ | ✓ CV-5; hash identity is independent of logical folder/name |
| Stable per-scene background/foreground storage slots | — | — | ✓ | ≈ CV-10; stable logical slot, replaced content remains cleanup-eligible |
| Persistent per-user shared image plus live player broadcast | — | — | ✓ | ≈ A-8/CV-10; persistent per-user slot **and** ephemeral broadcast are both required |
| Default/last action, share, paste/drop, scene nav/activation preferences | — | — | ✓ | ✓ PF-1 |
| Saved dialog/window sizes | — | — | ✓ | ✓ PF-1 |
| SIPD dialog theme selector | — | — | ✓ | ⊘ Decision B; theme controls are intentionally excluded |
| GM-only use and restricted players limited to preview | — | — | ✓ | ✓ PM-1/PM-2; the `TRUSTED` upload grant is an additional product feature (PM-6) |
| Foundry file-upload permission gate | — | ✓ (Foundry file picker) | ✓ | ≈ PM-6; replaced by a host-enforced app permission and destination authorization |
| Forge-specific detection/integration | ✓* | — | — | ⊘ Explicit non-goal |
| Video backgrounds | ? (documentation claim only) | — | — | ⊘ Phase 4, not in current parity claim |
| Audio ingestion | ? (conflicting docs; source unchecked) | — | — | ⊘ Explicit non-goal; not claimed as covered |
| Foundry 14+ level named "Background" | — | ✓ | — | ⊘ No direct ArenaStar level equivalent is specified |
| Background-colour default | — | ✓ (`#000000`) | — | ≈ SZ-12: user can choose any colour, but product default is white by decision |
| Foundry geometry beyond the three modules (offset, scale, padding, grid alignment, asset-grid sizing, placeable resize) | — | — | — | ✓ SZ-2..SZ-11; additional scope, not module parity |
| Undo/cleanup of stored assets | — | — (server files) | No reliable delete | ✓ §6.8; document Revert plus a confirmed GM cleanup command |

**What this means:** ordinary image ingest, all listed SIPD targets, Mini Uploader's journal workflow, and
Scene Express's scene-creation workflow are specified. The parity adaptations and exclusions above are
intentional and visible; they must not be presented as exact replicas. Before claiming Mini Uploader parity,
verify its installed source/version and settle its video/audio claims. Scene Express's release-list versus
`main` metadata discrepancy is recorded in §3.2 and §12.

---

## 8. Phases and acceptance

Each phase ends with unit tests, the existing gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`), and an
e2e spec for the user-visible parts.

**Phase 0: foundations (no UI).**
- `src/core/imageSizing.ts` with the §6.3 functions, plus magic-byte sniffing and the limits.
- Acceptance: pure unit tests for each sizing rule and rejection case. Preserve behavior for valid inputs within the new limits; explicitly test the intentional new rejection of unsupported formats, files over 64 MB, and images over 100 MP.

**Phase 1: ingest parity with Scene Express and Mini Uploader (with documented adaptations).**
- Window/Scenes-tab drop, batch, logical destination folders, name normalization, new scene from image
  (A-1), scene defaults and thumbnail (SZ-13/14), journal page (A-7), target/auto-created journal (PF-2),
  WebP control (PF-3), and duplicate modes (CV-7).
- Acceptance: dropping a PNG on the Scenes tab creates a scene named after the file, sized to the image,
  with the configured defaults and a generated thumbnail. Dropping three files creates three scenes.
  Test all duplicate modes and verify that a logical folder selection persists without creating a physical
  server path. Verify journal targeting/auto-creation and WebP quality while preserving the original by
  default. Use Playwright with a synthetic `DataTransfer`.

**Phase 2: ingest parity with SIPD (theme intentionally excluded).**
- Paste, URL drop and URL-text paste (§6.9, Link / Store), preview dialog, destination-folder chooser and
  history, replace background/foreground (A-2/A-3), centered and fit tiles (A-4/A-5), journal page (A-7),
  preview-only (A-9), restricted player mode (PM-2), persistent per-user share slot plus live broadcast
  (A-8/CV-10), and player uploads with the `TRUSTED` grant (PM-6/PM-7). Persist last-action and window-size
  preferences; omit the theme selector by decision B.
- Acceptance: Ctrl+V opens the preview only for image clipboard items outside text fields. A URL read/decode
  failure shows the actionable generic CORS/network message and save-and-drop instruction; a Pinterest
  pin-page link is refused with an explanation. Repeated background/foreground replacements update the
  logical slot, and repeated shares update the per-user slot while connected players receive the asset.
  A player in restricted mode can preview but cannot persist anything. A `TRUSTED` player can upload only
  through the new host-authorized path, with separately authorized target writes and a GM-visible
  audit/OpLog record; revoking the role blocks new uploads before bytes are stored.
- **Gate before release:** a real Pinterest image address, tested directly in Chromium, Firefox and
  Safari, recording whether it loads in each mode. The result goes in the release notes.

**Phase 3: Foundry geometry.**
- Schema additions (§6.2), aspect lock, offset, scale, padding, grid-from-image, alignment tool,
  foreground (A-3, SZ-9), placeables choice (SZ-11).
- Acceptance: a pre-gridded 3080×2520 image with 22×18 squares gives grid size 140, and the grid
  lines match the image. Placeables stay where they were unless the user chooses to rescale. Rescale is
  one undo step.

**Phase 4: polish and extras (not current module-parity scope).**
- Clean-up command, video backgrounds (Mini Uploader support is unverified), asset library view, i18n of
  new strings, and an e2e run in Chromium on file:// and https. Audio ingestion remains an explicit non-goal.
- **Status (2026-10-09).** Done: the GM library with list, download and a confirmed **Clean up unused images**
  (§6.8, `e2e/image_library.spec.ts`, `tests/core/assetUsage.test.ts`). A deleted image is one that no live
  document uses; Undo history is not a root, because the OpLog is never compacted in the app and keeping it
  would make a replaced background undeletable. The confirmation says that Undo can no longer restore it.
  Upload audit records are provenance, not use. The file:// and https origin checks
  (`e2e/origins.spec.ts`). Not done: video backgrounds (a host upload branch must go through the same
  quota, audit and format gate, so it needs its own design pass), i18n of new strings (the project has no
  string catalogue yet, D-263 / G-38), and placing a stored image onto the canvas from the library (IN-5).

---

## 9. Testing plan

- **Unit (vitest):** sizing rules (§6.3) with the worked examples from §2; name normalization
  (`my_map+v2.png` → `my map v2`); magic-byte sniffing with mismatched extensions; limits; each duplicate
  mode; logical folder/name aliases and cross-name hash reuse; and defaults for journal, WebP, scene creation, and SIPD
  client preferences.
- **Host (vitest):** upload authorization, server-side format/size/pixel checks, quota and audit run before
  `AssetServer.import`; a `TRUSTED` role alone does not authorize a scene/tile/page intent unless the
  destination policy allows it. Verify a failed document intent leaves a detectable orphan. Verify the
  per-user share-slot mapping persists, its projection grants only entitled viewers, and the share event
  is emitted only after the asset is available. Rescale is one document-intent batch.
- **e2e (Playwright, Chromium):** synthetic paste and drop via `DataTransfer`; new scene dimensions,
  configured defaults and thumbnail match the import; journal page carries `src`; target/auto-created
  journal and logical-folder chooser/history work; SIPD share updates a stable per-user slot and reaches
  connected players. Undo removes the document/reference, while the imported blob remains until the
  cleanup path deletes it after confirmation.
- **URL modes (e2e):** an HTTPS fixture server that sends CORS headers, and a second one that does not. A
  third case is a proxy in front of the second fixture, where the proxy adds the header; it must behave
  like the first. Check success/failure and the actionable generic message; do not assert an exact browser
  CORS diagnostic. The CSP allows external `https:` images, so fixtures must use HTTPS (for example with
  a self-signed test certificate), not plain `http://127.0.0.1`.
- **Player upload:** verify untrusted upload is rejected before `AssetServer.import`; Trusted upload is
  accepted only through the host gate and attributed in the specified audit/OpLog record. Independently
  test that Trusted cannot create scene/tile/page docs unless the target policy explicitly grants it.
- **Manual (before release):** test on Firefox and Safari, since paste and drop behaviour differs.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Paste and drop differ between browsers. | Use the standard `paste` and `drop` events. Cover in the manual matrix. |
| URL reads fail on CORS or network errors, whose exact cause may be opaque to browser code. | Show an actionable generic load/CORS message and save-and-drop instruction (§6.9); do not claim an exact server-side diagnosis or add a relay. |
| Rescale of placeables is destructive. | Make it opt-in, batch it, and make it one undo step. |
| Asset storage grows with replaced images. | Clean-up command (§6.8). |
| Schema additions could break old world files. | All additions optional, with defaults. Round-trip test with an old world file. |
| Asset bytes/manifest writes bypass HostSync/OpLog; a UI-only Trusted check would not authorize player uploads. | Add a host-enforced upload path, audit/OpLog event and target-document checks; test denial before persistence. |
| New asset metadata could disappear after reload/export if added only to `AssetManifestEntry`. | Extend `AssetRecord`, `AssetServer` rehydration and world-file serialization/import; add round-trip tests. |
| Modules' behaviour may change. | This document cites behaviour as of 2026-10-09. Re-check before each phase. |
| Pinterest image hosts may not send CORS headers. Direct links then fail. | Test a real address before release (§8). Save-and-drop is the fallback. |
| Linked images can disappear. | Link mode is labelled as such. The GM can convert to Store at any time. |
| Linked image bytes are not in the world file, although the URL reference is serialized in the world document. | Warn on export that external media is not bundled and may be unreachable. |
| Background colour default is fixed white, which may look wrong on a dark-styled UI. | Colour picker per scene (SZ-12). Theme work stays out of scope. |

---

## 11. Decisions

### Resolved (2026-10-09)

| # | Topic | Decision |
|---|---|---|
| 1 | Keep originals or convert to WebP? | **Agreed:** keep the original by default. A preference converts to WebP at quality 0.1–1.0 (default 0.8). |
| 2 | Size limits | **Agreed:** 64 MB source, 100 megapixels decoded. |
| 3 | URL drops | **Any HTTPS image URL the browser can use, for scene backgrounds and tokens**, with Pinterest and proxied links working as ordinary links (§6.9). Remote URLs must be HTTPS under the current CSP; actual scene/token renderer support is still to be implemented. IN-7 also covers tiles. |
| 4 | Rights for images | **No new source/license-rights metadata** for ordinary image imports. Visibility stays an audience setting (PM-4). Preserve the repository's existing optional `exportRights` checks; it is not a license grant and must not be widened on hash reuse. |
| 5 | Player uploads | **Allowed when the GM grants rights.** Use `TRUSTED` as the grant signal, but add a host-enforced upload permission and destination checks: the current role only grants token/drawing/template creation (PM-6). |
| 6 | Placeables on resize | **Agreed:** keep positions by default, with an explicit rescale option. |
| 7 | Video backgrounds | **Agreed:** Phase 4. |
| 8 | Background colour | **White by default, and the GM can choose any colour or shade** (SZ-12). The theme itself is not changed (see B). |
| A | Default URL mode | **Agreed: Store.** Link stays available for the GM to choose. |
| B | Theme | **Do not touch the theme for now.** Backgrounds default to white, and the colour choice is free (SZ-12). |
| D | Player upload quota | **No quota by default.** The GM may set one, and the value is whatever the GM chooses. |
| C | Proxy template | **Dropped.** The app does not configure or add proxies. A proxied link works as any link. A blocked read gets the save-and-drop instruction. |

### Open

No product decisions remain open. The deliberate parity exceptions and source-verification caveats are recorded in §§7 and 12.

## 12. References

[1] Foundry VTT, *Scenes* article: https://foundryvtt.com/article/scenes/
[2] Foundry VTT, *Content Creation Style Guide*: https://foundryvtt.com/article/content-creation-guide/
[3] Encounter Library, *Scenes*: https://encounterlibrary.com/foundry-basics/scenes/
[4] Foundry VTT, *Tiles* article: https://foundryvtt.com/article/tiles/
[5] Foundry VTT, *Release 0.8.2* notes: https://foundryvtt.com/releases/8.90
[6] Foundry package page, *Mini Uploader*: https://foundryvtt.com/packages/mini-uploader
[7] Mini Uploader README and documentation: https://github.com/xthesaintx/mini-uploader ; https://campaigncodex.wgtngm.com/mini-uploader/
[8] Scene Express repository: https://github.com/ldng/fvtt-scene-express
[9] Scene Express package page: https://foundryvtt.com/packages/scene-express
[10] Scene Express source, `src/scene-express.mjs`: https://github.com/ldng/fvtt-scene-express/blob/main/src/scene-express.mjs
[11] Scene Express issue #6, "No Scene Express drop zone?": https://github.com/ldng/fvtt-scene-express/issues/6
[12] Scene Express releases and commit "[Bugfix] Scenes Created with Wrong Dimensions" (#11): https://github.com/ldng/fvtt-scene-express/commit/6c6473333aef7c3fa8eba8b452ef86b66af52ae9
[13] Sephral's Image Paste & Drop, package page and README: https://foundryvtt.com/packages/sephrals-image-paste-drop ; https://github.com/Sephral/sephrals-image-paste-drop
[14] MDN, *Use cross-origin images in a canvas*: https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
[15] ImageURLGenerator, *CORS Error on an Image URL: The Actual Fix (2026)*: https://www.imageurlgenerator.com/blog/cors-error-image-url-fix
[16] Stack Overflow, *Pinterest CORS error when retrieving picture* (2017; older source, used only for the point that Pinterest's API is not callable directly from browser JavaScript): https://stackoverflow.com/questions/44885156/pinterest-cors-error-when-retrieving-picture
[17] Scene Express source, `src/settings.mjs`: https://github.com/ldng/fvtt-scene-express/blob/main/src/settings.mjs

**Caveats.** The Mini Uploader repository URL returned 404 via the GitHub API during this audit, so its
source could not be checked; its cited package page/docs also disagree on video/audio support. Treat §3.1
and every Mini Uploader feature marked `✓*`/`?` in §7 as documentation-only until verified against the
installed module. Scene Express §3.2 was rechecked against its public `main` source, settings and release
list on 2026-10-09; the release list says 0.14.1, while the current `main` manifest reports 0.0.1 with
placeholder URLs. SIPD §3.3 was cross-checked against the current GitHub README and package listing; its
implementation source was not audited. The Foundry grid-scale shortcut is from a third-party guide, and
Shift + scroll in particular should be checked in Foundry before we copy it.
