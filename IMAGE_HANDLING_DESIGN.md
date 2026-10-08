# Image handling system — design

**Status:** revision 3 · decisions 1–8 and A, B, D answered 2026-10-09 (§11) · all items resolved · **Branch:** `arena/8c636714-arenastar-vtt`

**Goal.** One image-ingest system for ArenaStar VTT that covers, and where possible exceeds, the
capabilities of three Foundry VTT modules:

- **Mini Uploader** (xthesaintx; marketed as Stephen Garrett's wgtnGM tools): drop files on the window,
  convert to WebP, store, and add as journal pages.
- **Scene Express** (ldng): drop an image on the Scenes tab, get a new scene sized to the image.
- **Sephral's Image Paste & Drop** (Sephral, "SIPD"): paste or drop images or URLs, preview them,
  then choose a target (scene background, foreground, tile, journal page, show to players, preview).

It also has to cover the Foundry-core image behaviour those modules sit on: background sizing,
grid alignment, offset and scale, tile sizing, and foreground layers.

Every claim about Foundry or the modules is cited in §2 and §3. Every claim about this repository is
checked against code and cited by path in §4. Design choices are marked **Decision** or **Proposal**.
§11 lists what needs your sign-off.

---

## 1. Scope and non-goals

**In scope:** ingest of raster images (PNG, JPEG, WebP, GIF, AVIF) from files, clipboard, dragged URLs
and in-app drags; image URLs used directly for scene backgrounds, tokens and tiles (§6.9); conversion and derived variants; sizing and alignment of scene backgrounds,
foregrounds and tiles; journal image pages; permissions and undo for all of it.

**Phase 4 candidates:** video backgrounds (Mini Uploader's docs list video and audio; Foundry supports
video backgrounds), a shared asset library UI, and show-to-players broadcasts.

**Out of scope:** Foundry's server data-folder model (we have no server; see §4), The Forge integration,
Foundry's Tile Browser as a file manager, and audio ingestion (playlists already have their own path).

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
| Tiles | Tiles render images and video. They fully integrate with lighting and vision. Players cannot see the Tiles layer. | [4] |
| Tile sizing | A tile can be placed at a size set by dragging, or from the Tile Browser at an *Asset Grid Size*. Example: a 256 px icon on a 100 px grid becomes 2.56 squares; with Asset Grid Size 128 it becomes 2×2. | [4] |
| Tile occlusion | Fade, Surface, Radial and Vision modes, each with an occlusion alpha. Overhead tiles can also act as roofs that block light. | [4][5] |
| Thumbnails | Scene thumbnails include overhead tiles. | [5] |

**Takeaways for the design:** Foundry derives scene size from the image, lets users override it with an
aspect lock, and has padding, offset, scale, foreground and an asset-grid concept for tiles. Scale and
alignment are per-scene properties, not image properties.

---

## 3. The three modules

### 3.1 Mini Uploader (xthesaintx / Stephen Garrett)

- **Versions:** 3.5 is the latest listed. It requires Foundry 13+ and is verified on 14 [6].
- **Flow:** drop one or more image files anywhere on the Foundry window. Each file is converted to
  WebP, uploaded, and added as a new page in a target journal (default name "mini-uploader") [6][7].
- **Settings:** upload folder (with `{worldId}` placeholder), target journal, *WebP Quality* from 0.1 to
  1.0, and *Auto-Create Journal* [7].
- **Storage layout:** `uploads/{worldId}/webp-images/` [6][7].
- **Other:** Forge VTT detection [7]. The documentation site says the module also accepts video and
  audio, but the README mentions only images. This is a discrepancy to check in the module before we
  claim parity for media [6][7].
- **Not in scope for us:** The Forge detection and the server folder layout. We have no server folder.

### 3.2 Scene Express (ldng)

- **Versions:** 0.14.1 (Foundry 12+, verified 14), licence LGPL-3.0 [8][9].
- **Flow:** a drop zone at the bottom of the Scenes tab. Each dropped image is uploaded and becomes a
  new scene with the image as background and the file name as the scene name [8].
- **Source-confirmed behaviour** (`src/scene-express.mjs`, read on 2026-10-09 [10]):
  - Scene name is the file's base name with `_` and `+` replaced by spaces.
  - Dimensions come from decoding the file (`createImageBitmap`), and are written to the scene's
    `width` and `height`.
  - `padding: 0`, `backgroundColor: "#000000"`, grid type and size from module settings.
  - Settings cover navigation, permissions (GM only or all players), token vision, fog exploration,
    and whether the scene activates immediately.
  - A thumbnail is generated with `scene.createThumbnail()`.
  - On Foundry 14+, the background is stored as a level named "Background".
- **Duplicate policy:** three options: stop with an error, reuse the existing file, or overwrite it.
  Matching is by file name, not content [8][10].
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
  - `worlds/<id>/sephrals-image-paste-drop/clipboard-images/YYYY/MM/` by default.
  - Replacing a background or foreground uses a deterministic path per scene.
  - Shared images use a path per user.
  - Other persistent uploads are named by SHA-256 of their content, so identical content reuses one
    file [13].
  - Preview-only uses a temporary object URL and writes nothing to disk, unless the image is also shared [13].
- **Preferences:** client-scoped settings for paste and drop enablement, default action, remember last
  action, default share, activate scene, navigation, upload-directory history, theme, and window sizes [13].
- **Access:** GM only by default. An optional restricted player mode lets players open the flow but
  limits them to preview [13].
- **Known limitations** (from the author): no reliable client-side delete [13]; uploading needs the file
  upload permission [13]; URL drops depend on the browser being able to fetch the URL [13]; tile
  insertion needs an active viewed scene [13].

---

## 4. Current state of ArenaStar_VTT

Verified in the checkout on 2026-10-09.

| Area | What exists | Evidence |
|---|---|---|
| Content-addressed assets | SHA-256 hash is the asset id. Storage uses OPFS, with IDB as fallback. | `PLAN.md` §7 entries; `src/storage/opfs.ts`, `src/storage/idb.ts` |
| Import pipeline | `ImportPipeline.importImage` stores the original, a 256 px WebP thumbnail, a 1024 px WebP mid-res, and 1024 px WebP tiles for maps over 4096 px. Derived quality is 0.8. | `src/host/import.ts` |
| Decode and derive | Done in a worker with `createImageBitmap` and OffscreenCanvas. `fitWithin` never upscales. | `src/workers/asset.worker.ts`, `src/workers/assetJob.ts` |
| Scene model | `SceneDocument` has `img`, `width`, `height`, `grid` (type, size, distance, units, diagonals, hex layout), plus placeable arrays such as `tiles` and `drawings`. There is **no** offset, scale, padding, background colour, or foreground field. | `src/core/documents.ts` ~L690–720 |
| Tile model | `TileDocument` has `x`, `y`, `width`, `height`, `img`, `rotation`, `sort`, `above`, `occlusion` (`roof` or `fade`, with alpha). There is **no** asset-grid size or scale mode. | `src/core/documents.ts` ~L144–165 |
| Journal page | `JournalPageDocument` has `src: string \| null`, so image pages are supported. | `src/core/documents.ts` ~L413 |
| Background render | `SceneBackgroundPlayer` shows the thumbnail first, then the full image. It fetches **asset hashes only**, so a URL in `scene.img` is not rendered today. `imageTexture` decodes via blob URL. | `src/client/sceneBackground.ts`, `src/canvas/imageTexture.ts` |
| URL images | `TileImageCache` already loads `http(s):`, `data:` and `blob:` sources with `crossOrigin = "anonymous"`. `TokenDocument.img` is documented as "asset hash or external URL (§7 allows both)". The CSP `img-src` allows `https:` only, so `http:` URLs are blocked. | `src/canvas/layers/TilesLayer.ts` ~L131–156, `src/core/documents.ts` ~L69, `index.html` |
| Theme | No light/dark theme switch exists. The UI is styled dark. Themes and dark mode are an open polish item (G-40). | `src/app/App.svelte` styles; `STATUS_ASSESSMENT_2026-09-21.md` §2.3 |
| Map import | The sidebar's **Import map** (file input, `accept="image/*"`) replaces the active scene's `img` and `width`/`height`. It does not create a scene and does not touch offset or grid. | `src/app/App.svelte` ~L2900–2960, ~L4457 |
| Grid editor | Settings → *Scene grid* edits type, layout and size only. | `src/ui/settings/SettingsPanel.svelte` ~L416–490 |
| Drop targets | The canvas `ondrop` handles only compendium and encounter payloads, not OS image files. | `src/app/App.svelte` ~L4561–4568 |
| Paste | No clipboard-image paste handler. `src/ui/clipboard.ts` only copies text. | `src/ui/clipboard.ts`; search of `src` for `paste` |
| Agent path | `host.importImage` is exposed to agents and MCP. | `src/app/agentBridge.ts` ~L215–219, ~L1572 |
| CSP | `img-src` allows `'self' data: blob: https:`. `connect-src` allows `https:`. | `index.html` |
| Asset limits | Explicit byte caps exist for codex bundles (32 MiB) and world-zip entries (128 MiB). I found no cap on direct image imports. | `src/core/campaignCodexBundle.ts` L37 |
| Placeables on resize | I found no code that moves placeables when a scene's width or height changes. Changing dimensions via **Import map** just changes them. | search of `src/host` and `src/core` |

**Gap summary.** The repo has the storage and derivation core. What is missing is the ingest surface
(paste, OS drop, URL drop, preview, scene creation from an image), the scene and tile geometry that
Foundry relies on (offset, scale, padding, foreground, asset-grid sizing, aspect lock), and the
alignment workflow.

---

## 5. Requirements

Each requirement lists the module or Foundry feature it comes from. **M** is Mini Uploader, **SE** is
Scene Express, **SIPD** is Sephral's Image Paste & Drop, **F** is Foundry core.

### 5.1 Input

| ID | Requirement | From |
|---|---|---|
| IN-1 | Drop one or more image files anywhere on the app window. Batch import with per-file progress. | M, SE, SIPD |
| IN-2 | Drop zone in the Scenes sidebar that creates one scene per dropped image. | SE |
| IN-3 | Ctrl+V pastes a clipboard image when focus is not in a text field. Use the `paste` event, not `navigator.clipboard.read()`, to avoid permission prompts. | SIPD |
| IN-4 | Drop or paste an image URL. Accept `text/uri-list` and `<img src>` from `text/html`. Resolve it as described in §6.9. | SIPD, user |
| IN-7 | Image URLs can be used directly for scene backgrounds, tokens and tiles, not only uploaded files. | user |
| IN-8 | Pinterest: accept the image address (`i.pinimg.com/...`). Proxied image links work as ordinary links. A Pinterest **pin page** link is detected and explained, not silently failed. | user |
| IN-9 | When the browser blocks a direct read, show a plain message with the save-and-drop instruction (§6.9). | user |
| IN-5 | Drop an image from an external app onto the canvas to place a tile. Placing from the asset library is a Phase 4 item. | F, SIPD |
| IN-6 | Drop targets are visibly labelled, with a hint shown while dragging over the window. | SE issue #6 |

### 5.2 Conversion and storage

| ID | Requirement | From |
|---|---|---|
| CV-1 | Option to convert to WebP at quality 0.1–1.0 (default 0.8). The original is kept unless the user chooses conversion. | M |
| CV-2 | Thumbnail, mid-res and tiles as today (§4). | existing |
| CV-3 | Detect the real format from magic bytes, not the file extension or MIME type. Reject unsupported formats and SVG. | security |
| CV-4 | Apply EXIF orientation when decoding, so the size and rotation match what the user sees. Strip GPS metadata from derived variants. | SE (sizes), security |
| CV-5 | Content-hash deduplication. Identical bytes reuse one asset. No filename-based dedupe. | SIPD (better) |
| CV-6 | Scene and journal names come from the file name: strip the extension, replace `_` and `+` with spaces, trim. | SE |
| CV-7 | Duplicate name policy: if the name exists with identical content, reuse; if it exists with different content, ask (create new, replace, or cancel). | SE, improved |
| CV-8 | Limits: a source file cap and a decoded-pixel cap to stop decompression bombs. Proposed: 64 MB and 100 megapixels (§11). | security |

### 5.3 Destinations (actions)

| ID | Action | Writes | From |
|---|---|---|---|
| A-1 | New scene with the image as background | `create scene`, plus `img`, `width`, `height` | SE, SIPD |
| A-2 | Replace the active scene's background | `update scene` (`img`, `width`, `height`) | SIPD, Import map (today) |
| A-3 | Replace the active scene's foreground | `update scene` (`foreground.img`, see §6.2) | SIPD |
| A-4 | Centred tile at natural size | `create tile` | SIPD |
| A-5 | Centred tile scaled to fit the scene | `create tile` | SIPD |
| A-6 | Tile at Asset Grid Size | `create tile` | F |
| A-7 | Journal page with the image | `create page` with `src` | M, SIPD |
| A-8 | Show to connected players (broadcast, not persisted) | ephemeral message | SIPD |
| A-9 | Preview only, nothing persisted | none | SIPD |

Every persistent action is a normal host intent. It goes through `can()`, the OpLog and Revert, so it
can be undone like any other edit. This is an advantage over the modules, none of which describe undo.

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
| SZ-12 | Background colour defaults to white (`#ffffff`). The GM can choose any colour or shade with a colour picker or a typed value, per scene. |
| SZ-11 | Dimension changes never move placeables silently. The user chooses: keep positions (default) or rescale placeables by the size ratio. | F (reposition), decision |

### 5.5 Permissions and privacy

| ID | Requirement | From |
|---|---|---|
| PM-1 | Only the GM can create or replace content by default. Players with the `TRUSTED` role may upload (PM-6). | SIPD, user |
| PM-2 | Optional restricted player mode: players can preview, and cannot persist anything. | SIPD |
| PM-3 | Preview-only writes nothing to the world. Use an object URL, as SIPD does. Use the existing `imageTexture`. | SIPD |
| PM-6 | Players can upload only if the GM grants them the `TRUSTED` role, which already allows creating tokens, drawings and templates (`src/core/permissions.ts`). The GM can revoke it. | user |
| PM-7 | Each upload by a granted player posts a GM-visible audit line naming the player and the image, and is attributed in the OpLog. | user, M (audit) |
| PM-4 | Imported images carry **no rights metadata**. Visibility (`gm`, `referenced`, or `world`) stays as an audience setting: who receives the image. The export-rights flag in the repo applies only to FX media and does not apply to these images. | user, repo model |
| PM-5 | Every persistent import is attributed to the user who made it, in the OpLog and a chat record when enabled. | M (audit), repo model |

---

## 6. Proposed design

### 6.1 Architecture

```
          ┌──────────────────────── input adapters (UI) ────────────────────────┐
          │ window drop (files / uri-list)  │ window paste  │ canvas drop │ sidebar│
          └────────────────┬────────────────┴───────┬───────┴──────┬─────────┴────┘
                           ▼                        ▼              ▼
                     ImageIngest (client): kind detection, magic bytes, limits, name normalisation
                           │
                           ▼
                 ImportPreviewDialog (client): defaults from prefs; action choice; sizing preview
                           │ (preview-only path ends here, uses imageTexture)
                           ▼
              ImportPipeline (existing, host) ── derive variants (worker) ── AssetServer (OPFS/IDB)
                           │
                           ▼
                 Action planner (pure, shared): action + sizing  →  intents
                           │
                           ▼
            HostSync: intents → can() → apply → OpLog → project → broadcast
```

- **Client adapters** only collect bytes and intent. They never write documents directly.
- **Action planner** is pure and shared between client and host. It takes an image's metadata and
  the chosen action, and returns a list of intents. This is where the sizing rules live, so they can be
  unit-tested without a browser.
- **ImportPipeline** is the existing class in `src/host/import.ts`, unchanged except for the new
  format and limit checks (CV-3, CV-8).
- **Agents** keep using `host.importImage`. They get the same checks.

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
  importedBy?: string;                // user id
};
ingest?: { format: "original" | "webp"; quality?: number };
```

Client preferences (client-scoped, not replicated), mirroring SIPD's settings:
`dropEnabled`, `pasteEnabled`, `defaultAction`, `rememberLastAction`, `webpConvert`, `webpQuality`,
`targetJournal`, `defaultNavigation`, `activateNewScene`, `defaultOwnership`.

GM world settings (replicated): `playerUploadQuotaMB` (optional; unset means no quota, §11 item D).

No new operation kinds are needed. Persistent actions use existing `create` and `update` ops.

### 6.3 Sizing rules (pure functions)

These are the only geometry rules. They live in `src/core/imageSizing.ts` and are tested directly.

- **Scene size from image:** `width = image.width`, `height = image.height`. Aspect-locked edits
  change one side and derive the other, rounded to the nearest integer.
- **Grid from pre-gridded image:** `size = round(image.width / columns)`. Reject sizes below 50. Warn
  when the result is not an integer divisor of the image height within 1 px.
- **Background transform:** `drawnWidth = width × scale`, `drawnHeight = height × scale`, drawn at
  `offset`. Padding adds `padding × max(width, height)` on each side, unlit by default.
- **Tile at Asset Grid Size:** `tileWidth = imageWidth / assetGridSize × grid.size`. Natural size is
  `tileWidth = imageWidth`.
- **Fit-to-scene tile:** the largest rectangle with the image's aspect ratio that fits in the scene,
  centred.
- **Placeables on resize (SZ-11):** default is no change. When "rescale placeables" is chosen,
  every placeable's `x`, `y` and size is multiplied by `newWidth / oldWidth` (and the same for height),
  as one batched intent so undo restores everything at once.

### 6.4 Naming and duplicates

- Names follow CV-6. The file name is the default for scene and journal names. The preview dialog
  lets the user change it before creating anything.
- Duplicate handling follows CV-7. Because the hash is the identity, identical files never create
  duplicate assets. Only the document's name can collide.
- Images have no rights flag. Who can see an image is set by its visibility, not by a rights value.

### 6.5 Permissions

- Ingest is GM-only by default. Players without the `TRUSTED` role open the preview dialog only. The
  Persist and Show-to-players actions are disabled for them.
- A player with the `TRUSTED` role can upload and create scenes, tiles, tokens and journal images. Each
  of those writes goes through `can()` like any other create, and each upload posts an audit line for the
  GM (PM-7).
- The GM can revoke the role at any time. Revoking it stops new uploads. It does not remove images already
  uploaded.
- Per-player upload quota: none by default. The GM can set one, and the value is whatever the GM chooses (§11 item D).

### 6.6 Security and limits

- **Format:** sniff magic bytes (PNG, JPEG, WebP, GIF, AVIF). Reject SVG and anything that decodes as
  something else. This closes the mismatch between extension and content.
- **Size:** source cap (proposed 64 MB) and decoded-pixel cap (proposed 100 MP). Check before decoding.
- **URLs:** HTTPS only. The browser performs the fetch under the page's CORS rules. There is no server
  proxy, because the app has no server. Failures are reported with the reason.
- **Metadata:** EXIF orientation is applied. GPS and other EXIF data are removed from derived variants.
  The original is kept only if the GM chose to keep originals.
- **CSP:** `img-src` already allows `blob:` and `https:`. `connect-src` allows `https:`. No CSP change is
  needed for this design. URLs must therefore be `https:`. A plain `http:` image is blocked by the CSP,
  and so is a test fixture on `http://127.0.0.1` (§9).

### 6.7 Platform notes

- **`file://`:** storage falls back to IDB, as today. URL drops may fail on CORS, which is handled.
- **Large maps:** over 4096 px, tiling already applies. The preview dialog warns when a map will be
  tiled.
- **Mobile:** the paste and drop paths are desktop-first. Touch devices use the file-picker path.

### 6.8 Undo and cleanup

- Every persistent action is one intent batch, so Revert removes the scene, tile, page or background
  change in one step.
- Orphaned assets (a replaced background, or an action that was reverted) are not deleted at once.
  A later **Clean up unused images** command, GM-only, lists unreferenced assets and deletes them after
  confirmation. The GM can always download the assets first.
- This addresses SIPD's limitation: it has no reliable delete, so its files accumulate.

---

### 6.9 URL sources: direct links, proxied links and pin pages

**Decision (user, 2026-10-09):** an image URL can be used instead of an uploaded file, at least for scene
backgrounds and tokens. Pinterest is the main source, and some of those links already go through a proxy.

**Principle.** The app fetches whatever `https:` URL the GM pastes. A proxied link is just another link: the
proxy adds the header the browser needs, so the app needs no proxy setting, no template and no knowledge of
any service. The app never adds a proxy of its own.

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
| **Link** | The URL only, in `scene.img` or `token.img`. | The host sends the CORS header. | Each client fetches the URL. Needs the source to stay up. Not in the world file. |
| **Store** | The bytes, imported as an asset (§6.1). The URL is kept as `source`. | The host sends the CORS header. | Same as an upload. In the world file. |

**Steps when a URL is pasted or dropped:**
1. Accept only `https:` URLs. Anything else is refused, with the reason.
2. If it is a Pinterest pin page, stop with: "This is a Pinterest page, not an image. Copy the image address instead."
3. Try a direct read. If it works, import in the chosen mode (Store by default).
4. If the browser blocks the read, show: "This site doesn't let the browser use this image directly. Save the image to your computer and drop the file here." Offer to retry or to choose another image. There is no further fallback.

A proxied link goes through step 3 like any other link. If the proxy sends the header, it imports. If not, it reaches step 4 like any other.

**What the app does not build.** No relay, no proxy setting, no default service, and no server (the app has none).
Anything that needs one is covered by save-and-drop.

**Privacy.** The read goes from the GM's browser straight to the host the GM chose. The app adds no third party.
A proxy inside a pasted link is the GM's own choice, and the link shows where it goes.

**Players.** In Link mode, each player's browser fetches the URL, so each player needs the same access. In Store
mode, players receive the bytes through the normal asset pipeline.

**Limits of Link mode.** A linked image is not part of the world file. If the source disappears, the background
is lost. The GM can convert a linked image to a stored one at any time.

**Security.** An external URL is a third-party request made by every client. URLs are limited to `https:`
(matching the CSP), and the host name is shown before import. The app never sends the user's credentials.

## 7. Parity matrix

✅ = covered by this design · 🟡 = partly covered, detail in notes · ➕ = goes beyond the module

| Capability | Mini Uploader | Scene Express | SIPD | Our design |
|---|---|---|---|---|
| Drop files on window | ✅ | 🟡 drop zone only | ✅ | ✅ IN-1 |
| Drop zone on Scenes tab | — | ✅ | — | ✅ IN-2 |
| Ctrl+V paste | — | — | ✅ | ✅ IN-3 |
| Drop URL | — | — | ✅ | ✅ IN-4, §6.9 (HTTPS; blocked reads explained; save-and-drop fallback) |
| Image URL as scene background or token | — | — | 🟡 URL fetched and stored | ✅ IN-7 (Link or Store) |
| Pinterest image address and proxied links | — | — | — | ✅ IN-8 (proxied links work as ordinary links; pin pages explained) |
| Preview dialog | — | — | ✅ | ✅ §6.1 |
| New scene from image | — | ✅ | ✅ | ✅ A-1 |
| Replace background | — | — | ✅ | ✅ A-2 |
| Replace foreground | — | — | ✅ | ✅ A-3 (needs §6.2 field) |
| Centred tile | — | — | ✅ | ✅ A-4 |
| Scaled-to-fit tile | — | — | ✅ | ✅ A-5, SZ-10 |
| Tile at asset grid size | — | — | — | ✅ A-6 (Foundry feature) |
| Journal image page | ✅ | — | ✅ | ✅ A-7 |
| WebP conversion with quality | ✅ 0.1–1.0 | — | — | ✅ CV-1 (default 0.8) |
| Upload folder setting | ✅ | ✅ | ✅ | ➕ not needed; content store |
| Target journal setting | ✅ | — | — | ✅ preference |
| Auto-create journal | ✅ | — | — | ✅ preference |
| Batch import | ✅ | ✅ one scene per file | — | ✅ IN-1 |
| Filename-based names | — | ✅ | — | ✅ CV-6 |
| Duplicate policy | — | ✅ 3 options (by name) | — | ✅ CV-7 (by content, then name) |
| Dimensions from image | — | ✅ | ✅ | ✅ SZ-1 |
| Aspect lock and reset | — | — | — | ✅ SZ-2 (Foundry feature) |
| Offset / scale / padding | — | 🟡 padding 0 | — | ✅ SZ-3..5 |
| Grid from pre-gridded image | — | — | — | ✅ SZ-7 (Foundry guide) |
| Grid alignment tool | — | — | — | ✅ SZ-8 |
| Foreground image size match | — | — | — | ✅ SZ-9 |
| Placeables on resize | — | — | — | ✅ SZ-11, with an explicit choice |
| Thumbnails | — | ✅ | — | ✅ existing |
| Show to players | — | — | ✅ | ✅ A-8 |
| Preview only, nothing written | — | — | ✅ | ✅ A-9, PM-3 |
| Player uploads with a GM grant | — | — | 🟡 restricted mode is preview only | ✅ PM-6 (`TRUSTED` role) |
| Restricted player mode | — | — | ✅ | ✅ PM-2 |
| Content-hash dedupe | — | — | ✅ (SHA-256 names) | ✅ CV-5, shared across worlds |
| Background colour | — | — | — | ✅ SZ-12: white default, any colour per scene |
| Undo / Revert | — | — | — | ➕ every action is an intent batch |
| Cleanup of unused images | — | — | — | ➕ GM command (SIPD has no delete) |
| Magic-byte format check, SVG rejection | — | — | — | ➕ CV-3 |
| Decompression-bomb guard | — | — | — | ➕ CV-8 |
| Video backgrounds | 🟡 claimed in docs | — | — | Phase 4 |

---

## 8. Phases and acceptance

Each phase ends with unit tests, the existing gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`), and an
e2e spec for the user-visible parts.

**Phase 0: foundations (no UI).**
- `src/core/imageSizing.ts` with the §6.3 functions, plus magic-byte sniffing and the limits.
- Acceptance: pure unit tests for each sizing rule and rejection case. No change to existing behaviour.

**Phase 1: ingest parity with Scene Express and Mini Uploader.**
- Window drop, Scenes-tab drop zone, batch, name normalisation, new scene from image (A-1), journal
  page (A-7), WebP option.
- Acceptance: dropping a PNG on the Scenes tab creates a scene named after the file, sized to the
  image, with padding 0. Dropping three files creates three scenes. An e2e test does this with
  Playwright, using a synthetic `DataTransfer`.

**Phase 2: ingest parity with SIPD.**
- Paste, URL drop (§6.9, Link / Store), preview dialog, replace background (A-2), centred and
  fit tiles (A-4, A-5), asset grid tiles (A-6), preview-only (A-9), restricted player mode (PM-2), show
  to players (A-8), player uploads with the `TRUSTED` grant (PM-6, PM-7).
- Acceptance: Ctrl+V on the canvas opens the preview. A URL drop that fails CORS shows the reason, and
  shows the save-and-drop instruction when a read is blocked. A Pinterest pin-page link is refused with the
  explanation. A player in restricted mode can preview but cannot create anything. A `TRUSTED` player
  can upload, and the GM sees an audit line. Revoking the role stops further uploads.
- **Gate before release:** a real Pinterest image address, tested directly in Chromium, Firefox and
  Safari, recording whether it loads in each mode. The result goes in the release notes.

**Phase 3: Foundry geometry.**
- Schema additions (§6.2), aspect lock, offset, scale, padding, grid-from-image, alignment tool,
  foreground (A-3, SZ-9), placeables choice (SZ-11).
- Acceptance: a pre-gridded 3080×2520 image with 22×18 squares gives grid size 140, and the grid
  lines match the image. Placeables stay where they were unless the user chooses to rescale. Rescale is
  one undo step.

**Phase 4: polish and extras.**
- Clean-up command, video backgrounds, asset library view, i18n of new strings, and an e2e run in
  Chromium on file:// and https.

---

## 9. Testing plan

- **Unit (vitest):** sizing rules (§6.3) with the worked examples from §2; name normalisation
  (`my_map+v2.png` → `my map v2`); magic-byte sniffing with mismatched extensions; limits;
  duplicate-policy decisions; preference defaults.
- **Host (vitest):** a create-scene import produces one `create scene` plus one `update`; rescale is one
  batch; a player's import is refused with a clear reason.
- **e2e (Playwright, Chromium):** synthetic paste and drop via `DataTransfer`; new scene dimensions
  match the file; journal page carries `src`; undo removes everything.
- **URL modes (e2e):** an HTTPS fixture server that sends CORS headers, and a second one that does not. A
  third case is a proxied URL in front of the second fixture, where the proxy adds the header; it must
  behave like the first. Each case is checked for the result and the message. The CSP allows only `https:`
  images, so the fixtures must be served over HTTPS (for example with a self-signed test certificate), not
  plain `http://127.0.0.1`.
- **Player upload:** a `TRUSTED` player's import is accepted and attributed; a non-`TRUSTED` player's is refused.
- **Manual (before release):** test on Firefox and Safari, since paste and drop behaviour differs.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Paste and drop differ between browsers. | Use the standard `paste` and `drop` events. Cover in the manual matrix. |
| URL drops fail on CORS in some cases. | Show the reason and the save-and-drop instruction (§6.9). Do not add a relay. |
| Rescale of placeables is destructive. | Make it opt-in, batch it, and make it one undo step. |
| Asset storage grows with replaced images. | Clean-up command (§6.8). |
| Schema additions could break old world files. | All additions optional, with defaults. Round-trip test with an old world file. |
| Modules' behaviour may change. | This document cites behaviour as of 2026-10-09. Re-check before each phase. |
| Pinterest image hosts may not send CORS headers. Direct links then fail. | Test a real address before release (§8). Save-and-drop is the fallback. |
| Linked images can disappear. | Link mode is labelled as such. The GM can convert to Store at any time. |
| Linked images are not in the world file. | Warn when a world is exported with linked images. |
| Background colour default is fixed white, which may look wrong on a dark-styled UI. | Colour picker per scene (SZ-12). Theme work stays out of scope. |

---

## 11. Decisions

### Resolved (2026-10-09)

| # | Topic | Decision |
|---|---|---|
| 1 | Keep originals or convert to WebP? | **Agreed:** keep the original by default. A preference converts to WebP at quality 0.1–1.0 (default 0.8). |
| 2 | Size limits | **Agreed:** 64 MB source, 100 megapixels decoded. |
| 3 | URL drops | **Any URL the browser can load, for scene backgrounds and tokens**, with Pinterest and proxied links working as ordinary links (§6.9). HTTPS only, because the CSP allows only HTTPS images. |
| 4 | Rights for images | **No rights.** Images have no rights metadata. Visibility stays as an audience setting (PM-4). |
| 5 | Player uploads | **Allowed when the GM grants rights.** Implemented as the existing `TRUSTED` role, which the GM can grant and revoke (PM-6). |
| 6 | Placeables on resize | **Agreed:** keep positions by default, with an explicit rescale option. |
| 7 | Video backgrounds | **Agreed:** Phase 4. |
| 8 | Background colour | **White by default, and the GM can choose any colour or shade** (SZ-12). The theme itself is not changed (see B). |
| A | Default URL mode | **Agreed: Store.** Link stays available for the GM to choose. |
| B | Theme | **Do not touch the theme for now.** Backgrounds default to white, and the colour choice is free (SZ-12). |
| D | Player upload quota | **No quota by default.** The GM may set one, and the value is whatever the GM chooses. |
| C | Proxy template | **Dropped.** The app does not configure or add proxies. A proxied link works as any link. A blocked read gets the save-and-drop instruction. |

### Open

None. All items are resolved.

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

**Caveats.** The Mini Uploader README and package page differ on media support. The Scene Express
behaviour in §3.2 comes from its source as read on 2026-10-09. The SIPD behaviour in §3.3 comes from its
package page; I did not read its source. The Foundry grid-scale shortcut is from a third-party guide, and
the Shift + scroll behaviour in particular should be checked in Foundry before we copy it.
