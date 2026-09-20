# Toolbar parity plan — closing T-01…T-13 of the Roll20 comparison

**Date:** 2026-09-20 · **Branch:** `arena/01a0bc2f-arenastar-vtt`
**Inputs:** `TOOLBAR_GAP_ANALYSIS_PR27.md` (the T-numbered gap list), `GAP_ANALYSIS_Roll20_Foundry.md` §E
(G-24…G-32: lighting/fog on the platform level), Roll20 Toolbox / Jumpgate / Ruler / Drawing Tools /
Dice GUI / Fog of War / Turn Tracker / Map Pins / Advanced Hotkeys documentation.
**Goal:** the left canvas rail reaches Roll20 Toolbox parity — every tool present, every tool's
default behaviour and modifier semantics matched, and the three keystone gaps (layers, fog mask,
lighting placement) usable from the rail alone.

## Definition of done

1. **Every Roll20 rail tool exists** in our rail or is deliberately documented as unported (with the
   reason): Select, Pan, Draw, Text, Measure, Dice, Turn Order, Place Pin, Hide/Reveal Mask,
   Lighting, Layers, Zoom, Settings, Help, Effects.
2. **Behaviour parity for the tools we claim**: modifier semantics (Alt/Shift/right-click), snapping,
   broadcast toggles, recall, per-tool sub-toolbars.
3. **A player shell parity check**: players get the tools Roll20 gives them (everything but the GM
   tools) and never see the GM-only ones.
4. **Evidence**: unit tests for every pure decision, e2e specs driving the real rail with real
   pointer gestures against the built `dist/index.html`, and the full chromium suite no worse than
   the pre-change baseline (161 passed / 1 known-flaky).

## Reference behaviour we are matching (condensed)

| Tool | Roll20 semantics that must hold in ours |
| --- | --- |
| Select | layer-aware selection: tokens on the objects layer, text/drawings with `Alt`, everything on the layer with `Ctrl+A` |
| Pan | separate tool; left-drag pans; middle/right/shift-drag pans from any tool |
| Draw | shapes (rectangle default, `Alt` = ellipse), freehand, polygon/line, `Shift` = snap to grid, stroke/fill/width sub-toolbar, clear drawings |
| Text | click-type in place, font size + colour, `Esc` commits, double-click re-opens for edit |
| Measure | `Q` tool, snap centre/corner/none, show-to-others vs hide-from-others, waypoints, `X` recalls the last measurement, AoE shapes (circle/cone/ray) |
| Dice | quick-roll tray (up to 5 dice of a size, one click), advanced formula box, roll-mode toggles (`/gmroll`, `/blindroll`, `/selfroll`), re-roll from the last rolls |
| Turn Order | GM opens it, everyone sees it, `U`/`Ctrl+U` adds the selection, round advance |
| Place Pin | GM places a handout-linked pin; hidden by default; tooltip with player vs GM text; `Shift+Z` shows the pin to players |
| Hide/Reveal Mask | GM-only brushes: Reveal, Polygon Reveal, Hide (+ our symmetric Hide polygon), Reveal all / Hide all; the mask is manual and survives vision updates |
| Lighting | GM placement of walls, doors and lights (grid-snapped), erase the last one |
| Layers | four layers (Map & Background, Objects & Tokens, GM Info, Dynamic Lighting) with `M`/`O`/`K`/`,` chords; GM layers invisible to players |
| Zoom / Settings / Help / Effects | rail buttons: zoom in/out/fit, the settings window, the help/keybinding window; Effects documented as unported (needs the Fx engine) |

## Phases

### Phase 1 — rail infrastructure (T-08, T-09, T-10, T-12)

| ID | Task | Files | Acceptance |
| --- | --- | --- | --- |
| P1.1 | Rail re-layout: grouped columns (layers, navigation, tools, GM tools, actions), icon-first collapsed mode with tooltips, `role="toolbar"`, focus rings | `src/ui/canvas/CanvasToolbar.svelte`, both shells' CSS | rail renders in both shells; every control reachable by keyboard; no click lands on the map |
| P1.2 | Rail actions: zoom in / zoom out / fit, turn order, settings, help → `vtt-canvas-action` event; shells implement | both shells | zoom actions change `camera().scale`; turn order opens the combat window; settings opens the settings window |
| P1.3 | `pnpm check:svelte`: compile every `.svelte` with `svelte/compiler`, fail on errors and on `non_reactive_update`; wired into `pnpm typecheck` | `scripts/checkSvelte.mjs`, `package.json`, `App.svelte`, `JoinApp.svelte` | script exits 0; the two existing `non_reactive_update` warnings are fixed, not suppressed |

### Phase 2 — tool depth (T-04, T-05, T-06, T-07)

| ID | Task | Files | Acceptance |
| --- | --- | --- | --- |
| P2.1 | Draw shapes: freehand / rectangle / ellipse / line / polygon, `Alt` = ellipse, `Shift` = grid snap, live preview, stroke+fill+width sub-toolbar | `src/core/documents.ts`, `src/canvas/layers/drawingGeometry.ts`, `src/canvas/layers/DrawingsLayer.ts`, `src/canvas/tools/{drawing,controller}.ts`, `CanvasToolbar.svelte`, both shells | each shape commits one drawing with the right `kind`/geometry; `Alt` swaps rect→ellipse; `Shift` snaps; the preview matches the committed shape |
| P2.2 | Text tool: in-canvas editor (click to type, Esc/click-away commits, Shift+Enter newline), font size + colour, double-click an existing label to edit it | `CanvasToolbar.svelte`, both shells, `src/canvas/interactions/index.ts` (text hit-test) | a typed label is committed with the chosen size/colour; `window.prompt` is gone from the text path; editing an existing label updates it |
| P2.3 | Measure options: snap none/centre/corner, show-to-others vs hide-from-others, `X` recalls the last measurement, AoE shapes (circle / cone / ray) from the template geometry | `src/canvas/tools/{measureTool,controller}.ts`, both shells, `CanvasToolbar.svelte` | snapping changes the readout; broadcast publishes the ruler to the other peer; `X` re-shows the last measurement; cone/circle previews are drawn from the same geometry as `TemplatesLayer` |
| P2.4 | Dice tray: quick rolls (d4…d20 × 1–5), roll-mode toggles, last-10 roll history with re-roll | `CanvasToolbar.svelte`, `src/core/chat.ts` (existing modes), both shells | a quick roll lands in chat with the chosen mode; the history re-rolls the same formula |

### Phase 3 — layers and GM tools (T-01, T-02, T-03, T-13)

| ID | Task | Files | Acceptance |
| --- | --- | --- | --- |
| P3.1 | Layers picker (Map / Tokens / GM / Lighting) with `M`/`O`/`K`/`,` chords; the layer gates token hit-testing/dragging and the GM-only layers are invisible to players | `src/canvas/interactions/index.ts`, `src/core/keys.ts`, both shells, `CanvasToolbar.svelte` | with the GM layer active a click on a token does not select it; a player shell has no layer picker and no GM layers drawn |
| P3.2 | Fog mask brushes: Reveal rect / Reveal polygon / Hide rect / Hide polygon / Reveal all / Hide all; the hide mask is a replicated scene flag that every client renders as cover and that also withholds tokens inside it | `src/core/fogMask.ts` (new), `src/core/fogExploration.ts`, `src/canvas/layers/FogLayer.ts`, `src/client/fogExploration.ts`, both shells | a GM brush changes what the layer covers and the change survives a reload; a hide-brush hides a token from the player peer |
| P3.3 | Lighting placement: wall segments (drag, corner-snapped), doors, lights (click, radius + colour), erase the last placement | `src/canvas/tools/controller.ts`, both shells | a dragged wall lands in `scene.walls` with the right geometry and blocks sight (the vision polygon changes); a placed light lands in `scene.lights` |
| P3.4 | Map pins: GM places a pin, tooltip separates player vs GM text, visibility toggle per pin, `Shift`-click shows the image/text to players, double-click opens the linked journal | `src/core/documents.ts` (`NoteDocument`), `src/canvas/layers/NotesLayer.ts` (new), `src/canvas/stage.ts`, both shells | a hidden pin is not rendered in the player shell; toggling visibility publishes it; double-click opens the journal window |

### Phase 4 — hardening

- Extend `e2e/canvas_toolbar.spec.ts` with a spec per new capability (real pointer gestures only).
- Unit tests: document factories + bounds, `fogMask`, measure snapping/shapes, controller gestures, dice tray modes, key chords.
- Full chromium suite + `pnpm build` → `build:systems` → `build:worlds`, `pnpm size`, `pnpm typecheck`,
  `pnpm lint`, `pnpm test`; DECISIONS.md entry.

## Deliberately out of scope (documented, not silently dropped)

- **Fx / Effects tool** — Roll20's canvas spell effects need a particle/FX engine; our `effects`
  collection is actor/item effects, not canvas FX. Porting is a project of its own.
- **3D dice** — already exists in the app for chat rolls; the rail's tray reuses it.
- **Handout anchor pins & rich tooltips** — Phase 3 keeps pins plain-text with a journal link; the
  rich-text/anchor behaviour is a follow-up.
- **Cloud/sound share, playlists** — not toolbar surface (tracked as G-29/G-30).

## Status

See the status table at the end of `DECISIONS.md`'s D-256 entry for what landed in this slice.
