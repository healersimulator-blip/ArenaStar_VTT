# Canvas toolbar gap analysis — PR #27 vs. the Roll20 Toolbox

**Date:** 2026-09-20 · **Base:** `arena/01a0bc2f-arenastar-vtt` @ `a79540e` (merge of PR #27) + working tree
**Question:** PR #27 ("feat: add shared canvas toolbar and playable starter world") replaces the old
in-canvas hints with a Roll20-style tool rail. Where is it still lacking against the Roll20
reference?
**Method:** (a) Roll20 documentation research — Toolbar Overview wiki, the 2024 "Toolbar and Layers
Redesign" (Project Jumpgate), Ruler, Drawing Tools, Dice Rolling GUI, Fog of War, Turn Tracker,
Keyboard Shortcuts (URLs in §7); (b) PR #27 code review (`src/ui/canvas/CanvasToolbar.svelte`,
`src/canvas/tools/*`, `src/app/App.svelte`, `src/app/JoinApp.svelte`); (c) hands-on verification —
6 new browser tests (`e2e/canvas_toolbar.spec.ts`) driving every tool with real pointer gestures,
plus the existing 154-test chromium suite against the built `dist/index.html`.

**Read with:** `GAP_ANALYSIS_Roll20_Foundry.md` §E ("Canvas, scene & map tools", G-24…G-32) — that
document is the *platform* parity view; this one is the *toolbar surface* view. Gaps that already
have an ID there are cross-referenced instead of duplicated.

**Severity scale:** **High** — a table moving from Roll20 hits this in the first session ·
**Med** — regulars expect it · **Low** — polish/power-user.

---

## 1. What PR #27 actually ships (verified)

| Area | Delivered | Verified by |
| --- | --- | --- |
| Rail UI | `CanvasToolbar.svelte`: Select, Pan, Draw, Text, Measure, Dice + GM "Erase drawings" + collapse toggle; rendered in both the GM shell and the player shell | `e2e/app.spec.ts` toolbar test; screenshots in test-results |
| Keyboard | `V`/`H`/`D`/`T`/`M`/`R` select tools, `Escape` → Select (never steals keys from inputs) | `CanvasToolbar.svelte:onKey`; new e2e keeps focus cases green |
| Select | marquee, token drag, double-click sheet, context menu — unchanged | `tests/canvas/interactions.test.ts` (29 tests) |
| Pan | Pan tool pans on left-drag; middle/right/shift-drag still pan from any tool | `e2e/canvas_toolbar.spec.ts` "pan mode drags the map…" |
| Draw | freehand stroke → `DrawingDocument` (`kind:"freehand"`, simplified points) committed as one `create` op on `scenes/<id>/drawings` | e2e "draw tool paints one freehand drawing…" |
| Text | `window.prompt` → `kind:"text"` label document (fixed 180×32 box) | e2e "text tool writes a labelled drawing…" |
| Measure | 2-point drag preview overlay (`svg.measure-preview`) + radius circle, grid-unit label, multi-waypoint path; plus the pre-existing ctrl+click ruler broadcast | e2e "measure tool previews along the pointer in grid units…" |
| Dice | formula field (default `1d20`) → `parseChatCommand("/roll …")` → chat message; identical to typing `/roll` in chat | e2e "dice tool rolls through the chat path" |
| GM clear | "Erase drawings" (confirm dialog) deletes every drawing on the scene | e2e "GM erase-all clears every drawing…" |
| Ownership | drawings carry `flags.core.createdBy` + per-user OWNER ownership | `src/canvas/tools/drawing.ts`; unit tests |

Tool state is real: `ToolInteractionController.activate()` is driven from a `$effect` that re-runs
when the async stage finishes (`toolReady`), and `CanvasController` gained an `interactionMode`
gate so a stroke does not also marquee/drag the token underneath it.

## 2. The Roll20 reference (what the toolbar is in Roll20)

**Legacy Toolbox (top → bottom, [Toolbox wiki](https://wiki.roll20.net/Toolbox))**

1. **Select/Move** — one button toggling *select* mode and *pan* mode.
2. **Layers** (GM) — Map & Background / Objects & Tokens / GM Info Overlay / Dynamic Lighting.
   Players are always on the Objects layer.
3. **Drawing Tools** — Draw Shapes, Freehand, Polygon/Line, Text, Clear Drawings, each with a
   secondary appearance toolbar (stroke colour, fill colour, line width).
4. **Fx Tool** (Pro, GM) — burn/explode/dragon's-breath canvas effects.
5. **Zoom Tool** — zoom in/out control.
6. **Ruler** — click-drag measurement with a full options set (below).
7. **Place Tool** (GM) — place lights, doors, windows (Dynamic Lighting layer).
8. **Fog of War** (GM) — reveal/hide mask, renamed **Hide/Reveal Mask** in Jumpgate; Darkness Tool
   when Updated Dynamic Lighting is active.
9. **Turn Tracker** (GM opens; everyone sees) — interactive initiative list, Ctrl+U adds selection.
10. **Dice Rolling GUI** — quick-roll tray + advanced roller + 3D dice.
11. **Help Tool**.

**2024 redesign (Project Jumpgate, [redesign wiki](https://wiki.roll20.net/Toolbar_and_Layers_Redesign))** —
adds a **Settings** submenu (dark mode, preview-as-token, logout), splits **Select** and **Pan**
into separate buttons, separates **Text** from **Draw**, renames **Ruler → Measure** (which also
grew circle/cone **AoE shapes**), Fx → **Effects**, Place → **Lighting**, and pins the **Layers**
picker to the bottom-left corner.

**Per-tool behaviour depth that defines "Roll20 parity"**

| Tool | Roll20 behaviour |
| --- | --- |
| Ruler/Measure | snap to corner / cell centre / none (`Q`+`1/2/3`); show-to-others vs hide-from-others (`Q`+`S/H`, GM still sees); `Q`/right-click adds a waypoint; `Shift` keeps the line until dismissed; `X` recalls the last measurement; GM per-page measurement style: square 5E/4E (diagonal = 1), Pathfinder/3.5E (1.5, round down), Manhattan, Euclidean; hex Hex-Path/Euclidean; AoE circle/cone in Jumpgate |
| Draw | rectangle by default, `Alt` = circle/ellipse, `Shift` = snap to grid; freehand; polygon/line (vertex clicks, right-click/Esc closes, `Ctrl+Z` undoes a segment, near-start auto-close); text with font/size/colour, Esc defocus, double-click to edit; Clear Drawings clears the current layer only; grouping via right-click; drawings on the DL layer act as walls; players can always draw (only an API Mod stops them) |
| Dice | hover tray: up to 5 dice of a size with one click; advanced roller window; 3D dice |
| Turn tracker | GM-openable list; drag tokens/`Ctrl+U` to add; round advance; visible to everyone |
| Fog | three GM tools — Reveal, Polygon Reveal, Hide (`R`+`R/G/T`); the mask is static over map/tokens/text/drawings and only the GM changes it by hand; a player always sees tokens they own |
| Select / Pan | Select modifiers: `Ctrl` = only tokens/images on the current layer, `Alt` = only text and drawings, `Shift` = only map pins/doors/windows regardless of layer, `Ctrl+A` = everything on the layer, `Ctrl+Shift+A` = that plus pins/doors/windows elsewhere |
| Place Pin | GM creates a handout-linked map pin (drag a handout or a header onto the map, or the Place Pin tool / right-click); hidden by default with a visibility toggle, tooltips carry separate player/GM notes, `Shift+Z` or `Shift`+click shows the pin image to players, double-click opens the linked handout, pins are layerless |
| Shortcuts (advanced) | `S` select, `A` pan, `F` then `R`/`F`/`G`/`D` = shape/freehand/polygon/text, `Q` measure with `Q1/Q2/Q3` snapping and `QH/QS` broadcast, `X` recall last measurement, `R` then `R`/`G`/`T` = fog reveal / polygon reveal / hide, `Y` turn tracker, `U` add turn, `D` dice, `P` show/hide toolbar, `M`/`O`/`K`/`,` layers, `L`+layer chord moves the selection, `Z` / `Shift+Z` zoom view of the selected graphic (to all), `Ctrl+U` turn tracker, `Shift`+draw snapping, `Alt`+wheel zoom, right-drag pan, `Delete`, `Ctrl+Z/Y`, copy/paste |

## 3. Parity matrix (toolbar surface)

Legend: ✅ parity · 🟡 partial · ❌ missing.

| Roll20 tool | PR #27 | Notes |
| --- | --- | --- |
| Select | ✅ | marquee/drag/activation are richer than Roll20's free tier |
| Pan | ✅ | separate button (matches Jumpgate); left-drag fixed in the working tree |
| Draw (freehand) | 🟡 | freehand only — no shapes, polygon/line, colour/fill/width, snapping, per-layer clear, grouping, or in-canvas undo of a segment |
| Text | 🟡 | places a label, but via a blocking `window.prompt`; no font/size/colour, no in-place edit |
| Measure | 🟡 | preview + waypoints + radius + grid-unit label ✅; no snapping modes, no show/hide-from-others for the *tool* line, no recall, no AoE shapes, no colour |
| Dice | 🟡 | formula → chat ✅ (and the app has 3D dice for chat rolls), but no quick-roll tray, no `/gmroll`/`/selfroll` toggles, no last-rolls list |
| Layers | ❌ | no layer switch at all (Map/Objects/GM/DL) — see G-24/G-25 for the underlying lighting/fog work |
| Fog of War / Hide-Reveal mask | ❌ | explored fog + vision exist, but no GM reveal/hide brush in any UI (G-25) |
| Place/Lighting tool (lights, doors, windows) | ❌ | lights/doors exist as documents; no placement tool |
| Turn Tracker | 🟡 | combat tracker lives in the sidebar and the token context menu; no toolbar button |
| Zoom | ❌ | wheel zoom + fit exist; no zoom control on the rail |
| Fx / Effects | ❌ | actor/item effects exist; no canvas FX |
| Settings / Help | 🟡 | settings live in the sidebar tab; nothing on the rail |
| Clear Drawings | 🟡 | GM-only "Erase drawings" clears **all** drawings on the scene; Roll20 clears the current layer for anyone |
| Players may draw | 🟡 | Roll20: players can *always* draw unless a Mod blocks it (there is no built-in switch; DryErase is the API workaround). Ours: creating a drawing needs role `TRUSTED`, so a plain player can select the tool but the host refuses the op |
| Map pins / Place Pin | ❌ | scenes already carry a `notes` collection and the stage has a `notes` layer, but nothing in the UI creates a pin: no handout-linked pins, tooltips, hidden/visible toggle, or `Shift+Z` show-to-players |

## 4. Defects found in PR #27 during this review (all fixed in the working tree)

| # | Defect | Effect | Fix |
| --- | --- | --- | --- |
| F-1 | Tool controller/toolbar never activated: `ToolInteractionController.activate()` had **no production caller** | draw/text/measure were dead in the built app (probe: draw drag advanced `seq` by 0, measure preview never rendered) | `$effect` in `App.svelte`/`JoinApp.svelte` arms `activate(tool)` on tool change and re-runs on `toolReady` |
| F-2 | Canvas gestures never gated: `CanvasController` still marquee-dragged tokens underneath a stroke | drawing across a token moved the token | new `interactionMode` option (`select`/`pan`/`suppress`); Pan tool pans on left-drag |
| F-3 | Measure overlay transform added half the canvas (`rect.width/2`) and the label printed raw world pixels ("1000 ft" for 500 px) | preview drawn off-cursor; nonsense distances | `worldToScreen(...)` + `displayDistance()` (px → grid distance units) used by both the overlay and the in-canvas ruler |
| F-4 | Toolbar was `position:absolute` **inside** the canvas and intercepted clicks meant for the map/other windows | two upstream specs failed (`ephemera`, `gmextras`: toolbar button swallowed clicks); tokens under the rail were unclickable | toolbar is now a flex column (`.board`/`.toolrail`) beside the canvas in both shells |
| F-5 | Wrong property: tools were handed `client.user._id`, but the session user is `{id, role, name}` | every toolbar drawing stored `createdBy: undefined` / ownership key `"undefined"`; dice/chat author empty | 6 call sites now use `client.user?.id`; `pnpm typecheck` cannot catch this because `.svelte` files are outside `tsc`'s include (see §6) |

## 5. Remaining gaps, ranked

- **T-01 — Layers picker (High).** Roll20's rail is layer-first: four layers with `Ctrl+M/O/K` and
  "move selection to layer" chords. We have no layer concept in the UI even though the stage has
  per-layer holders and scenes model `walls`/`lights`/`tiles`/`drawings`. Without it the DL/fog
  tooling below has nowhere to live. *Shape:* `activeLayer` state + layer filter on hit-testing and
  edits; GM-info layer needs a visibility flag (`hidden`/GM-only drawing or note). **L.**
- **T-02 — Fog of War / Hide-Reveal mask (High; same root as G-25).** Roll20's mask is manual and
  GM-driven; ours is automatic only. *Shape:* GM brush/polygon that writes the explored-fog bitmap
  (reveal/hide) + "reveal all"/"hide all". **L.**
- **T-03 — Lighting / Place tool (High; same root as G-24).** Doors, lights, windows are documents
  with no placement affordance; GMs must go through raw ops. *Shape:* a placement mode that reuses
  the tool controller to create `walls`/`lights`/`tiles` (grid snap, polygon walls like Roll20's
  polygon draw). **M–L.**
- **T-04 — Draw toolset (Med).** Shapes (rect/ellipse with `Alt`), polygon/line with shift-snap and
  per-segment undo, stroke/fill/width controls, and a "clear layer" that respects permissions.
  `DrawingDocument` already supports `kind: "poly" | "rect"` and `stroke/fill/strokeWidth`, so the
  model is ready. **M.**
- **T-05 — Text tool (Med).** Replace `window.prompt` with an in-canvas editor (click-to-type,
  Esc to commit, double-click to edit) + font size/colour. **M.**
- **T-06 — Measure options (Med).** Snap modes (corner/centre/none), show-to-others/hide-from-others
  for the tool's own line (today only the ctrl+click ruler broadcasts), recall last measurement,
  and AoE shapes (circle/cone/ray) — the template *geometry* already exists
  (`templateGeometry.ts`, cone/circle/ray/rect). **M.**
- **T-07 — Dice tray (Med/Low).** Add the quick-roll tray (d4…d20 ×1–5, one click), roll-mode
  toggles (`/gmroll`, `/selfroll`, blind), and a "re-roll last" affordance; the chat roll pipeline
  already supports all modes. **S–M.**
- **T-08 — Turn tracker button (Low).** Surface "add to turn order" from the toolbar and give the
  combat tracker a roll-up button; `Ctrl+U` parity. **S.**
- **T-09 — Zoom control + Help/Settings (Low).** Zoom in/out/fit buttons on the rail; a settings
  entry point (the sidebar Settings tab already hosts the grid editor, keybindings, undo/redo and
  fog settings — the rail just has no door to it). **S.**
- **T-10 — Toolbar surface polish (Low).** Roll20's rail is icon-first with hover labels and
  submenus; ours is a 112 px labelled column. An icon-only compact mode (with tooltips) and
  `aria` grouping would close most of the visual gap. **S.**
- **T-11 — Permission model for drawings (Low–Med).** Two halves: (a) the helpers
  `canDeleteDrawing` / `canEraseAllDrawings` (`src/core/drawingPermissions.ts`) and
  `canEditDrawing` (`src/canvas/tools/drawing.ts`) have no production caller, so "Erase drawings"
  ignores ownership and there is no per-drawing delete/edit path; (b) creating drawings needs role
  `TRUSTED` (`src/core/permissions.ts:54`), so a plain `PLAYER` sees a Draw tool that the host will
  refuse — Roll20 lets players draw by default and Pro GMs lock it with the DryErase API instead.
  Wire the helpers into a select-then-Delete flow and either hide or explain the tool for
  non-TRUSTED players. **S–M.**
- **T-13 — Map pins (Low–Med).** Roll20's newest toolbar tool and the only one that links the journal to the canvas: a GM places a pin from the toolbar or by dragging a handout/heading, the pin defaults to hidden, carries separate player/GM notes, and can be revealed per-pin or shown as an image to players with `Shift+Z`. Our `notes` collection + `notes` layer are the natural home — it needs a placement tool, a pin editor, and a projection rule for hidden pins. **M.**
- **T-12 — `.svelte` files are not typechecked (process, Low but consequential).** `pnpm typecheck`
  runs plain `tsc` over `src/**/*.ts`, so F-5 (wrong property on a session object) shipped silently.
  Add `svelte-check` (or `svelte2tsx`-based checking) to the typecheck script. **S.**

## 6. Suggested order

1. **T-12, T-08, T-09, T-10, T-11, T-13** — days, and they remove the rough edges that make the
   rail look unfinished (plus the typecheck hole that hid F-5; T-13 is small and self-contained).
2. **T-04, T-05, T-06, T-07** — the three tools users actually touch every session; all are
   model-ready, no new subsystems.
3. **T-01 → T-03** — layers, then the fog/lighting tools that hang off it; this is where the
   platform gaps (G-24, G-25) and the toolbar gaps converge, so it deserves its own milestone.

## 7. Sources

- Roll20 wiki, *Toolbar Overview* (legacy Toolbox): https://wiki.roll20.net/Toolbox
- Roll20 wiki, *Toolbar and Layers Redesign* (Jumpgate, 2024 rollout): https://wiki.roll20.net/Toolbar_and_Layers_Redesign
- Roll20 wiki, *Ruler* (snap/broadcast/waypoints/diagonal rules): https://wiki.roll20.net/Ruler
- Roll20 wiki, *Drawing Tools* (shapes/freehand/polygon/text/clear/grouping/walls): https://wiki.roll20.net/Drawing_Tools
- Roll20 wiki, *Dice Rolling GUI* (quick rolls, advanced roller, 3D dice): https://wiki.roll20.net/Dice_Rolling_GUI
- Roll20 wiki, *Fog of War* (manual mask; Hide/Reveal Mask in Jumpgate): https://wiki.roll20.net/Fog_of_War
- Roll20 wiki, *Turn Tracker*: https://wiki.roll20.net/Turn_Tracker
- Roll20 wiki, *Keyboard Shortcuts* (default bindings): https://wiki.roll20.net/Keyboard_Shortcuts
- Roll20 wiki, *Advanced Shortcuts* (two-key tool chords, layer chords, `Q`-snapping): https://wiki.roll20.net/Advanced_Shortcuts
- Roll20 Help Center, *Advanced Hotkeys* (current two-key chords + `X` recall): https://help.roll20.net/hc/en-us/articles/360039178974-Advanced-Hotkeys
- Roll20 Help Center, *Measure Tool* keyboard shortcuts: https://help.roll20.net/hc/en-us/articles/360039674913-Measure-Tool
- Roll20 Help Center, *Select and Pan Tools* (layer-aware selection modifiers): https://help.roll20.net/hc/en-us/articles/360039674873-Select-and-Pan-Tools
- Roll20 Help Center, *Toolbar Overview* (current left-toolbar inventory): https://help.roll20.net/hc/en-us/articles/360039674753-Toolbar-Overview
- Roll20 Help Center, *Map Pins* (handout-linked pins, visibility, `Shift+Z`): https://help.roll20.net/hc/en-us/articles/36271267343639-Map-Pins
- Roll20 wiki, *Player* (which tools are GM-only; players can always draw): https://wiki.roll20.net/Player
