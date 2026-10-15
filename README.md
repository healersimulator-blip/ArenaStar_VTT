# VTT — serverless browser-only Virtual Tabletop

A Foundry-class virtual tabletop that ships as **one self-contained `index.html`**
(all JS/CSS/wasm/fonts inlined). No dedicated server: the GM's browser tab is the
authoritative host, persister and relay; players join with a link/code. Implements
the architecture spec in `uploads/VTT_Task.txt` (§0–§19) — see `PLAN.md`.

## Quickstart

```sh
pnpm install
pnpm dev          # vite dev server
pnpm build        # → dist/index.html (single file, ≤ 6 MB raw budget; runs build:systems first and embeds the first-party packages, D-473)
pnpm test         # vitest unit tests
pnpn typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm size         # prints raw+gzip size of dist/index.html, fails > 6 MB raw
pnpm build:systems # → dist/packages/<id>-<version>.zip (strategic ruleset + content pack)
pnpm build:worlds  # → dist/worlds/<id>-starter-<version>.zip (ready-to-open starter worlds)
pnpm test:e2e     # builds, then runs Playwright against file:// of dist/index.html

# Content (optional — the full PF1e compendium, 28 packs / ~25k entries):
pnpm content:fetch   # clones the pinned sources into tools/content/vendor/ (git-ignored, ~262 MB)
pnpm content:convert # → dist/content/pf1e (manifest + packs + OGL.txt + CREDITS.md)
```

For shorter FX regression runs (one batch at a time, 15-minute global cap), see
[FX_TEST_BATCHES.md](FX_TEST_BATCHES.md).

**Run no test command that takes more than 25 minutes.** The batches in `package.json` are sized for
that (`test:fx:*` cap at 15 minutes, `test:multilevel` at 20), and `pnpm test:e2e` is the one that
does not: it is all 138 specs with no global timeout, hours of wall clock. Take the batches, or name
the specs you need — `pnpm exec playwright test e2e/one.spec.ts e2e/two.spec.ts --workers=1` — and run
heavy jobs one at a time (vitest, Playwright, lint, tsc, build), because the 2-CPU sandbox dies when
they overlap.

Requires Node 20+ and pnpm 10.

**Play PF1e Mass Battles in three clicks:** `pnpm build && pnpm build:systems && pnpm build:worlds`,
open `dist/index.html`, **Open file (.zip)** → `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip`
→ **Open as new world**. The world boots with the PF1e strategic ruleset active and the PF1e
Core compendia installed; nothing to activate, nothing to reload.

**Or in one:** `pnpm build`, open `dist/index.html`, **New world** → Create. The build carries its
own packages (D-473): the wizard's default ruleset is the shipped PF1e Mass Battles Engine with
Pathfinder 1e Core beside it, no zip involved; "built-in" and "load a package" stay one click away,
and Settings → Packages can add the shipped packages to an existing world the same way.

### Content: two ways in

The full converted compendium is **data**, not code: it rides in a world zip and never enters the
app body, so the single-file build stays inside its 6 MB budget.

1. **Build it here** (needs network once). The order matters, because `pnpm build` empties `dist/`:

   ```sh
   pnpm content:fetch                      # pinned checkouts → tools/content/vendor/
   pnpm build && pnpm build:systems && pnpm content:convert && pnpm build:worlds
   pnpm content:package                    # download-ready zip + dist/release/SHA256SUMS
   ```

   `content:fetch` reads `tools/content/sources.json` — every source is a repo URL, an exact
   commit, a sparse path set and the licence fact recorded in `tools/adopt/INVENTORY.md`. It is
   idempotent and verifies what it fetched; `pnpm content:fetch --check` reports the state without
   changing anything, and `--dest <dir>` keeps the 262 MB of sources outside the repo (the
   converter then needs `VTT_CONTENT_VENDOR=<dir>`). If the content directory is missing,
   `build:worlds` still builds the plain starter and says so.

2. **Download the artifacts** (no toolchain, nothing to build). `pnpm content:package` writes the
   installable `dist/packages/pf1e-content-<v>.zip`, `dist/worlds/` holds the ready-made world
   zips, and `dist/release/SHA256SUMS` covers both — that is the file set to attach to a release,
   so a GM without a toolchain downloads one file. Open a zip in the app — **Open file (.zip)** —
   and the packs are installed with the world.

Either way the licence travels with the data: every content package ships `OGL.txt` and
`CREDITS.md` beside its packs, and the app's Help window (**Licences & credits**, `?` in the
canvas rail) names the upstream sources, their pinned commits and the licence. The policy and the
per-asset facts live in `LEGAL.md` and `tools/adopt/INVENTORY.md`.

## Layout

Exact per spec §18 — see `src/` (app, core, host, client, net/signaling/_, canvas/_,
ui/*, dice, audio, packages, storage, workers, sim) and `systems/mass-battle-basic/`.
Each module folder has an `index.ts` barrel. Tracking files live in the repo root:
`PLAN.md`, `DECISIONS.md`, `DEVIATIONS.md`, `ROADMAP.md`, `PROTOCOL.md`, and the
structured rules/chat/FX contract in `ACTION_SYSTEM.md`.

### Modding with the Automation Interconnect System

The [AIS design](AUTOMATION_INTERCONNECT_DESIGN.md) describes the architecture and remaining
implementation gaps. `modules/pf1e-torch/` is the worked ArenaStar-native carried-light module; its
README documents the current command/event contracts and capabilities. Full feature parity with
the original Foundry Torch module is not yet established.

AIS v1's working foundation is covered by a dedicated real-browser acceptance batch:

```sh
corepack pnpm test:fx:prepare   # build the single-file app, systems and starter worlds
corepack pnpm test:e2e:ais      # Chromium, one worker, no retries, 15-minute hard cap
```

To try it, open the PF1e starter, go to **Settings → Packages**, review the Torch entry source
and capabilities, approve its exact hash, and reload. **Runtime: ready** is distinct from
“approved.” Then use a token's carried-light menu or a separately reviewed GM script macro.
Revoking approval, disabling/replacing a package, or changing its grants stops the old instance
without a reload; starting newly approved code still requires one. The acceptance batch checks
this lifecycle and the shipped Torch path over both `file://` and HTTPS. See D-461 and
[E2E_BATCHES.md](E2E_BATCHES.md) for the verified scope; this is not yet the full AIS target design.

**Players run shared modules too (D-468).** An approved module is shared with the table by default
("Players run this module too" in its review). Each player is asked once per device and exact code
hash; after allowing, the same sandboxed module runs on their machine against their own replica,
and everything it writes is the player's own intent — the host's ownership rules decide, so a
player lights the torch on *their* token from the token's right-click menu and is refused on anyone
else's. Un-sharing or revoking stops the player's copy without a reload. The programme that
continues this (player commands, shared sheets, native PF1e into the world file) is
[AIS_PLAYER_RUNTIME_PLAN.md](AIS_PLAYER_RUNTIME_PLAN.md).

**For module authors (D-476…D-479).** [AIS_MODULE_GUIDE.md](AIS_MODULE_GUIDE.md) is the one-page
contract: manifest, lifecycle on GM and player devices, the `AIS.*` API with its capabilities and
bounds. Modules declare **settings** in the manifest (world scope replicates to players as a
document the GM edits; device scope stays local; both shells render the form), read the world's
**compendium** packs on the GM device, call declared commands of modules they **require** through
the module bus, and every running module has a **Health** block (counters, trace, breaker) with
**Restart** in Settings → Packages and in the player's *Shared modules* card.

**Runnable feasibility demo:** [Foundry through AIS](AIS_FOUNDRY_FEASIBILITY.md) loads original,
byte-pinned Tagger 1.5.4 code through a separately packaged adapter, with host-validated tag writes
and a small Sequence-style interface to our existing native FX engine. `test:fx:prepare` also builds
`dist/worlds/ais-foundry-feasibility-0.1.0.zip`. The demo is GM-local and deliberately limited—not
general Foundry compatibility. The [broader adapter proposal](FOUNDRY_AIS_ADAPTER_PROPOSAL.md)
records the remaining workflow, UI, system and multiplayer work.

### Foundry UI appearances — ready-to-open laboratory

`corepack pnpm test:fx:prepare` also builds **`dist/ui-demo.html`** and **`dist/preview/index.html`**.
These open a populated Alderwatch world automatically—no ZIP download, file picker or test flag.
Use the GM header's **palette button** to choose Your Flavor, Carolingian or RPG Styled UI, review
the appearance-only packages, and switch live. Compact/comfortable density, sidebar width and a
native reset are available. The exact upstream code/style coverage is shown on each card.

See [AIS_UI_MODULES.md](AIS_UI_MODULES.md): original Your Flavor token helpers, original RPG startup
hooks/artwork, and Carolingian's upstream CSS cascade are supported appearance profiles—not full
Foundry UI/system emulation. The ordinary `dist/index.html` still opens the normal world picker.

### Workspace layouts — Modern, Foundry-like, Roll20-like (D-464)

The GM and player shells come in three **layouts** over the same world, canvas and permission
engine. The **layout button** in the command bar (or *Workspace layout* in the main menu) opens a
chooser: **Modern** — ArenaStar's own quiet shell (a 46 px command bar with the per-minute actions,
a ⌘ K command palette, a left tool rail with every tactical tool and the GM layer switch, a right
rail with every document tab and a drawer that opens on chat by default, scenes in a popover under
the scene crumb); **Foundry** — a
reference-based v13/v14 arrangement (two scene-control columns, scene pills, the document-tab column
on the sidebar's edge, parchment chat cards, a centred ten-slot macro dock); **Roll20** — a
reference-based current-tabletop arrangement (a black toolbox with a layers dock, a pages drawer,
a seven-tab sidebar strip with an overflow menu, light or dark scheme). The choice is a device
preference (`arenastar.workspace-ui.v1` in local storage), never world data, and every action,
tab and tool keeps its id in every layout — the e2e suite uses `chromeAction`, `openSceneNav` and
`canvasAction` from `e2e/lib.ts` to reach controls that a layout keeps behind a menu. The
compatibility layouts are approximations drawn from public screenshots, not the original products
and not certified pixel parity.

### Scene settings, grid fit and the players roster (D-465)

**Scene settings** (main menu → *Scene settings*, the scene directory, or the background panel)
sets a scene's size in pixels (shown as whole cells), its grid type, cell size, **grid line colour
and opacity**, distance, units and diagonal rule. For an imported map, open **Map & background**
(Shift+M) and either let *Detect map grid* measure the squares — it reports the map's total square
count and offers "twice / half as many" when a bold every-second-line fooled it — or simply type
the count you can read off the map (e.g. 48 × 64), then **Fit scene to the map**: the image is
scaled so its squares equal the grid and the scene becomes exactly that many cells. **Players &
permissions** (main menu, or embedded in World settings) is the roster: who is connected, their
colour and role, the character they play, which tokens on the current scene they control (tick a
token to hand it over), per-player macro saving, and Disconnect / Ban / Unban / Remove. On the
canvas, a right-click while dragging the ruler pins a turn point (Ctrl+click too); placed lights
can be clicked, dragged, re-sized and deleted again with the Light tool; Escape always dismisses
what is armed first and only then returns to Select.

## World files, rulesets and content packs (§8, §12)

A GM handles **one file per campaign**: the world file. Everything else travels inside it
(D-248 format 2, D-249 lifecycle). The app tells the three `.zip` shapes apart by content:

- **World file** — `world.json` at the root. Exported from *Export world (.zip)* /
  *Save to folder…* (in-world) or *Export* on the start screen; it carries the world's
  §12 packages, so a shared world boots the same strategic ruleset on another machine.
  A **starter world** (`pnpm build:worlds`) is a world file with no campaign in it, a
  ruleset active and its content packs installed — it always opens as a fresh copy.
- **Strategic ruleset** — a `manifest.json` with `type: "system"` and `rules.js`
  (e.g. `systems/pf1e-mass-battles`). It drives **strategic** scenes only
  (heroes + units, Settings → Scale); tactical scenes (heroes only) never touch it,
  so one world can mix both kinds. It is chosen in **New world…** and pinned once the
  first strategic turn is resolved. A ruleset may also ship `ui.js` (D-475) — window
  components compiled against this build's Svelte runtime (the PF1e battle-analysis
  view today) — which both the GM's and the players' shells load with the rules.
- **Content pack** — a `manifest.json` with `type: "data"` and packs (e.g.
  `systems/pf1e-core`); its entries appear under Compendia. Chosen in **New world…** or
  added any time under Settings → *Strategic ruleset & content*.

The start screen lists the worlds on this device (**Open / Export / Delete**) and has one
**Open file (.zip)** entry: a world file offers *Open as new world* (a copy under a fresh id,
optionally renamed) or *Restore* (the archive's own id — overwrites that world if present); a
ruleset or content pack is named for what it is and offers *New world with it…*. Inside a
world, **Close world…** returns to the start screen; the sidebar has no importer of its own.

## Local autosave and Save now

Changes accepted from the GM and permitted players save automatically on the **GM's device**.
There are no extra approval prompts or per-edit notifications. In **Settings → Saves & backups**
(or **Session & world → World files**), **Save now** waits for local persistence and displays a
confirmation. A storage failure produces one persistent banner with **Retry save**; keep the world
open until it recovers. Close world stays on the table if saving fails.

**Backups & portability** expands to the existing complete world ZIP download and, where supported,
Save to folder. These are portable copies, not automatic cloud synchronization. Download a backup
regularly: browser storage can be removed, and another browser/profile/origin has different local
worlds. Stored media's export permissions still apply; externally linked media is not embedded.

The host retries failed document/journal and fog writes. Save now also waits for active host action,
asset-import and package work, and captures a realtime strategic checkpoint when applicable.
Web Locks prevent opening the same world in two GM tabs on origins supporting that API.
All chat and action history remains intact. **Cloud backups** offers manual, checksum-verified
Google Drive copies and private **GitHub release-asset** backups. An optional same-origin Node
companion remembers Google offline authorization and the browser pairing between sessions, and
uses its saved GitHub CLI login (or a securely configured token). Local play remains serverless;
static-only deployments can still choose explicitly temporary Google sign-in.

The GM chooses a ZIP cap (default **512 MiB**, not the old 64 MiB; 0 removes the extra cloud cap).
ZIP structural/memory safety bounds and provider limits still apply. See
[CLOUD_BACKUP_PROTOTYPE.md](CLOUD_BACKUP_PROTOTYPE.md) for one-time companion/OAuth setup,
credential/privacy boundaries, size/restore details and **pending live Google/GitHub acceptance**.
Automated tests use mocked providers, including restart/reconnection and real world-ZIP browser flows.

Automatic scheduling, versioned-retention management and history-exclusion/cleanup presets remain
planned; see `SAVE_SYSTEM_PLAN.md`. Cloud backups do not replace local autosave.

## Fog of war (§9)

Fog is a per-scene switch under **Settings → Scene** (*Fog of war*, with an optional *Sight
range* in squares; 0 = the whole scene, sight-blocking walls and closed doors always apply).
Each player uncovers the map with the tokens they control and keeps what they have seen
(D-250): the explored map is saved per player and scene by the host, comes back on reload or
reconnect, and travels in the world file (`fog.json` + `fog/*.png`). What is in sight right
now is clear; what was seen before is dimmed; what was never seen is black.

Fog also hides tokens (D-251): on a fogged scene a player's canvas draws only the tokens they
control plus whatever stands in their sight right now — a token in a remembered or unexplored
area is not drawn and cannot be selected, opened or right-clicked; it appears the moment it
walks into sight or the player's token walks up to it. The GM is never gated: the GM's fog is
a translucent overlay marking where fog lies while every token and map feature stays visible
under it (**God view**, on by default; switch it off in Settings → Scene or GM extras to
preview the opaque cover players get). The GM's own map is the union of every vision token.

## file:// limitations (§15)

The deliverable must boot from `https://` and `file://`:

- The app boots from `file://` in all supported browsers; the bootstrap screen
  reports which storage/network APIs the current origin provides.
- Storage availability on `file://` varies by browser: IndexedDB and Cache API
  generally work in Chromium; OPFS (`navigator.storage.getDirectory`) requires a
  secure context and may be unavailable; Safari/Firefox restrict some storage on
  `file://` origins. The host persistence layer degrades with a visible warning
  when a required store is missing.
- WebRTC works on `file://` (it is treated as a trustworthy/secure context by the
  supported browsers), but public signaling relays must be reachable over wss/https.
- For long-running hosted worlds we recommend serving `index.html` over `https://`;
  `file://` is fully supported for quick local play.

## Browser matrix (§15)

Chromium ≥ 110, Firefox ≥ 115, Safari ≥ 16.4. Playwright e2e runs Chromium; the
other engines are exercised per the matrix during milestone acceptance.

For an already-installed Chromium when the Playwright browser CDN is unavailable,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable:

```bash
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
  pnpm exec playwright test e2e/sheets.spec.ts e2e/windows.spec.ts --project=chromium --workers=1
```

No browser of your own? The npm registry alone is enough — `npm i @sparticuz/chromium`
ships a compressed Chromium plus a tarball of the system libraries it needs; unpack both,
point `LD_LIBRARY_PATH` at the library directory and pass its `executablePath()` to the
variable above. That is how the acceptance runs in this repository's own sandbox were made
(repeatedly, after the CDN turned out to be unreachable).

**Unpack `swiftshader.tar.br` into the same directory as the `chromium` executable** (so
`libEGL.so`, `libGLESv2.so`, `libvk_swiftshader.so` and `vk_swiftshader_icd.json` sit beside it).
Chromium looks for them there; `LD_LIBRARY_PATH` or ANGLE flags alone are not enough. Without them
WebGL is unavailable and Pixi silently falls back to its Canvas2D renderer, so pixel tests then
exercise the fallback rather than the normal path (D-429: Faux Overhead covers hide whole tokens
there, and `e2e/faux_overhead.spec.ts` asserts that contract when it detects Canvas2D).

Containers without user namespaces cannot start the Chromium sandbox; there,
`PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1` is the explicit opt-in that relaxes it. It is the only
case in which the config passes a browser-security flag, it applies only alongside the
executable override above, and CI never sets it. (It was not needed in the sandbox this
repository's own acceptance runs used — the specs pass either way there.)

The override affects only the Chromium project. Without it, Playwright uses its pinned
browser as before. Record the actual browser version when using an alternate binary; this
is not Firefox/WebKit or full supported-matrix acceptance. Browser executables and their
libraries stay outside Git.


## Draft level planning (GM only)

Open **Scenes → Draft levels · GM only** to plan named elevation bands with stable IDs.
Validation, normal autosave, undo/redo and scene-copy reference remapping are implemented.
Drafts are private on updated hosts and **do not activate stacked-floor gameplay** or move tokens.
Backups with drafts use format 3 and require an updated reader; legacy worlds still use format 2.
Live joins and draft edits now require compatible GM clients; incompatible GMs must upgrade or
disconnect before draft changes can commit. Legacy players still receive draft-free projections.
Use updated builds when reopening local browser storage too; wire/archive checks cannot protect old local readers.
Expand **Membership & wall scopes · experimental authoring** to assign tokens or wall scopes and inspect the saved binding audit. Token assignment explicitly moves feet to the selected Floor Z; clearing membership keeps elevation. This does not hide other floors or activate multilevel physics.
Saved levels also enable the **GM fog & lighting diagnostic** on the canvas. It stores exploration separately per level and renders scoped lights; assign placed lights through the same membership editor. Enable scene fog in Settings first. This remains GM-only: player level disclosure, vertical light tracing and per-level reset controls are not implemented. Each draft level can now inherit scene ambient lighting or override its darkness from 0 to 1; the choice affects the GM diagnostic only.
See [usage and remaining gates](MULTILEVEL_IMPLEMENTATION.md).

## Native wall editing

GM: **GM Info → Wall** now offers **Draw**, **Move corner**, and **Split**. Draw/corner tools
snap to nearby endpoints in screen pixels; Ctrl bypasses endpoint snapping. Shared corners move
together by default. Splitting preserves plain-wall metadata and direction while protecting
existing doors, windows and prefab walls. Corner/split gestures preview locally, commit atomically,
and undo in one step; concurrent wall edits are rejected rather than overwritten.

These are flat-scene authoring tools, not level-aware physics. See
[usage, constraints and remaining multilevel work](MULTILEVEL_IMPLEMENTATION.md).

## Native Faux Overhead (first multilevel slice)

GM: **Macros → Active Zones → Region → Faux Overhead** enables an elevation-gated cover over
painted-in map artwork. Native vector masks support partial overlap, concave footprints and openings;
covered pixels cannot be picked, and identifying token decorations are suppressed near cover. Edits
use ordinary undo/autosave and survive world ZIP export/import.

This is **cosmetic tactical-token clipping**, not a physical floor or secrecy boundary. Full level
navigation, host-side cross-level visibility, per-level fog, ghosts, stairs and advanced barrier behavior
are still pending. Use the same updated build on all clients. See [implementation status and usage](MULTILEVEL_IMPLEMENTATION.md)
and the [complete target design](MULTILEVEL_WALLS_DESIGN.md).

### Multilevel follow-up status (D-425 / D-426)

The GM level diagnostic supports **Reset this level’s fog**, with confirmation, durable reset generations, stale-upload protection and backup/restore. Other floors and legacy fog are unaffected; resets cannot be undone. Shared vertical sight/light queries and an owned-observer host exposure planner are implemented and tested, but **not connected to live player projection or rendering**. Player floor switching remains gated; secret stacked-floor play is not yet supported. See `MULTILEVEL_IMPLEMENTATION.md` for remaining integration requirements.

### Player token-floor navigation (D-427)

Assign player-controlled tokens to saved levels in the GM scene editor. Compatible players then see **Token floor focus**, with a host-approved floor list. Switching filters displayed/pickable tokens while preserving normal fog restrictions; **Shared scene · all floors** returns to the existing display. Choices update when token membership or ownership changes. **Artwork, lighting and fog remain shared: this is navigation, not secret-room isolation or full player multilevel perception.**

### Isolated floor maps and stairs-first travel (D-428)

This supersedes the token-only limitation above for explicitly enabled scenes. In **Scenes → Draft levels**, assign each floor's map tiles/background, assign wall/light scopes, then open **Floor artwork & stair travel** to create stairs and enable isolated floor play. Players see one floor's maps, lighting and remembered fog; the view follows their controlled token through stairs by default. The manual selector is a collapsed fallback.

A stair trip completes when a move ends inside the source-floor region; XY is preserved and floor/elevation change in one undoable transaction. Return stairs require leaving and entering again. Unassigned artwork/global foreground and auxiliary layers are excluded rather than mixed. This is playable discrete-floor rendering, **not comprehensive network/asset/FX secrecy or cross-floor sight/light**. Detailed setup and limits: `MULTILEVEL_IMPLEMENTATION.md`.

### Where the multilevel work stands (D-429 … D-454)

Everything the two sections above list as pending has landed: players see lower floors' art, tokens
and light **through the openings their own floor traces**, stairs are drawn and edited on the map rail,
the GM has a floor view with build mode, and other floors' data now stays on the host. The 20-ft
"three-storey building" question is answered by a scene a tester can open: the PF1e starter world
(`pnpm build:worlds`) ships **Ice Beacon — Elevation Test** — four floors of different heights
(20 / 15 / 10 ft and an open top), six stairwells, openings to look down through, crate stacks of
5 / 10 / 15 ft that hide what is behind them, a 10-ft scaffold that hides nothing, and height labels
under every token (from the ground for the GM, from their own token for a player).
`ELEVATION_TEST_SCENE.md` is the layout and the tester script; `MULTILEVEL_GAP_ANALYSIS_LEVELS_ROOFS.md`
keeps the item-by-item progress table.
