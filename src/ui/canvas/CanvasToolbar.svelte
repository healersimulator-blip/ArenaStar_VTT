<script lang="ts">
  /**
   * §10 the left canvas rail (D-255, D-256) — the Roll20 Toolbox laid out as one column:
   * layers (GM), navigation, tools, GM tools, then zoom/window actions, with a sub-toolbar
   * under whichever tool is active (Roll20's secondary toolbar). The component owns nothing
   * but its own UI state: the shells hold the tool settings object and act on
   * `vtt-canvas-tool` / `vtt-canvas-action` events.
   */
  import { workspaceUi } from "../workspace/state";
  import { tick } from "svelte";
  import { isTypingTarget } from "../../core/keys";
  import { hexTravel } from "../../core/hexcrawl/strings";
  import Icon from "../icons/Icon.svelte";
  import type { ToolOptions } from "../../canvas/tools/controller";
  import type { DoorState } from "../../canvas/vision/wallSight";

  export type CanvasTool =
    | "select"
    | "pan"
    | "draw"
    | "text"
    | "measure"
    | "dice"
    | "fog"
    | "wall"
    | "light"
    | "pin"
    /** D-275: the hexcrawl travel route — click hexes to extend it (plan §5.7). */
    | "path"
    /** G-14 (D-450): drag a stairwell out on a scene with floors. */
    | "stairs"
    /** D-453: drag a raised area (crates, a dais, a scaffold) out on the viewed floor. */
    | "raised";
  /** Roll20's four layers: Map & Background (map), Objects & Tokens (tokens), GM Info (gm), Dynamic Lighting (lighting). */
  export type CanvasLayer = "map" | "tokens" | "gm" | "lighting";
  export type CanvasAction =
    | "escape"
    | "zoom-in"
    | "zoom-out"
    | "zoom-fit"
    | "turn-order"
    | "add-turn"
    | "settings"
    | "help"
    | "reveal-all"
    | "hide-all"
    | "delete-last-placement"
    /** D-276: Shift+H — open the hex the party is standing in (plan §8 Phase 7's keyboard row). */
    | "hex-party"
    | "character-sheet";
  export type RollMode = "roll" | "gmroll" | "blindroll" | "selfroll";

  let {
    active = $bindable<CanvasTool>("select"),
    collapsed = $bindable(false),
    isGM = false,
    layer = $bindable<CanvasLayer>("tokens"),
    settings,
    cellSize = 100,
    fogStrokes = 0,
    bindings = {},
    onAction = () => {},
    onPanel = () => {},
    onChooseTool = () => {},
    onRoll = () => {},
    onEraseAll = () => {},
    pathTool = false,
    stairsTool = false,
    raisedTool = false,
    selectedLight = null,
    onLightChange = () => {},
    onLightDelete = () => {},
  }: {
    active?: CanvasTool;
    collapsed?: boolean;
    isGM?: boolean;
    layer?: CanvasLayer;
    settings: ToolOptions;
    cellSize?: number;
    fogStrokes?: number;
    /** action → combo overrides from the settings/keybinding layer (§10). */
    bindings?: Readonly<Record<string, string>>;
    onAction?: (action: CanvasAction) => void;
    onPanel?: (id: string) => void;
    /** The shell can dismiss setup before showing this tool's contextual options. */
    onChooseTool?: (tool: CanvasTool) => void;
    onRoll?: (formula: string, mode: RollMode) => void;
    onEraseAll?: () => void;
    /**
     * D-275: show the *Travel path* tool. It is a hexcrawl tool — a route means nothing on a
     * tactical map — so the shell says whether the active scene has a hexcrawl profile, rather
     * than the rail guessing from the scene it cannot see.
     */
    pathTool?: boolean;
    /** G-14 (D-450): the scene has floors, so stairwells can be drawn. */
    stairsTool?: boolean;
    raisedTool?: boolean;
    /** D-465: the light the Light tool has selected; its options edit that light, not the next one. */
    selectedLight?: { id: string; dim: number; bright: number; color: string } | null;
    onLightChange?: (patch: { dim?: number; bright?: number; color?: string }) => void;
    onLightDelete?: () => void;
  } = $props();

  let formula = $state("1d20");
  let diceCount = $state(1);
  let rollMode = $state<RollMode>("roll");
  let history = $state<Array<{ formula: string; mode: RollMode }>>([]);
  let optionsOpen = $state(false);
  let extraOpen = $state(false);
  let controlSet = $state("tokens");
  const controls = [
    { id: "tokens", label: "Token controls", icon: "tokens", tool: "select" as CanvasTool, gm: false },
    { id: "templates", label: "Measurement controls", icon: "measure", tool: "measure" as CanvasTool, gm: false },
    { id: "tiles", label: "Map and tile controls", icon: "map", tool: "select" as CanvasTool, gm: true },
    { id: "drawings", label: "Drawing controls", icon: "draw", tool: "draw" as CanvasTool, gm: false },
    { id: "walls", label: "Wall controls", icon: "wall", tool: "wall" as CanvasTool, gm: true },
    { id: "lights", label: "Lighting controls", icon: "light", tool: "light" as CanvasTool, gm: true },
    { id: "audio", label: "Audio playlists", icon: "playlists", tool: null, gm: true },
    { id: "notes", label: "Note controls", icon: "pin", tool: "pin" as CanvasTool, gm: true },
    { id: "regions", label: "Region and elevation tools", icon: "placeables", tool: null, gm: true },
  ];
  const setTools = $derived(visibleTools.filter((tool) => {
    const sets: Record<string, readonly string[]> = { tokens: ["select", "pan", "dice"], templates: ["measure"], tiles: ["select", "pan"],
      drawings: ["draw", "text"], walls: ["wall"], lights: ["light", "fog"], notes: ["pin"], regions: ["raised", "stairs", "path"] };
    return (sets[controlSet] ?? []).includes(tool.id);
  }));
  // Every tool stays one click away in every layout (D-464): the modern rail groups them with
  // hairline gaps (navigate · author · GM scene tools · dice) instead of hiding GM tools in a menu.
  const primaryTools = $derived(visibleTools);
  const toolGroup = (id: string): string => ["select", "pan"].includes(id) ? "navigate" : ["draw", "text", "measure"].includes(id) ? "author" : id === "dice" ? "dice" : "scene";
  function chooseSet(id: string): void {
    controlSet = id; extraOpen = false;
    const control = controls.find((entry) => entry.id === id);
    // Walls are drawn and edited on the GM-info layer (the overlay only shows there, D-465);
    // lights live on the dynamic-lighting layer.
    if (id === "tiles") layer = "map"; else if (id === "walls") layer = "gm"; else if (id === "lights") layer = "lighting"; else layer = "tokens";
    if (control?.tool) choose(control.tool);
    if (id === "audio") onPanel("playlists");
    if (id === "regions") onPanel("placeables");
  }
  const HAS_OPTIONS = new Set<CanvasTool>(["draw", "text", "measure", "dice", "fog", "wall", "light", "pin", "path", "stairs", "raised"]);
  let toolDice = [4, 6, 8, 10, 12, 20] as const;
  let drawShapes = [
    { id: "freehand", label: "Freehand", icon: "✎", key: "F" },
    { id: "rect", label: "Rectangle", icon: "▭", key: "" },
    { id: "ellipse", label: "Ellipse", icon: "◯", key: "" },
    { id: "line", label: "Line", icon: "╱", key: "" },
    { id: "poly", label: "Polygon", icon: "⬠", key: "" },
  ] as const;
  let measureShapes = [
    { id: "line", label: "Ruler" },
    { id: "circle", label: "Circle" },
    { id: "cone", label: "Cone" },
    { id: "ray", label: "Ray" },
  ] as const;
  let snapModes = [
    { id: "none", label: "Off" },
    { id: "centre", label: "Center" },
    { id: "corner", label: "Corner" },
  ] as const;
  let layers = [
    { id: "map", label: "Map & background", key: "Shift+M" },
    { id: "tokens", label: "Objects & tokens", key: "O" },
    { id: "gm", label: "GM info", key: "K" },
    { id: "lighting", label: "Dynamic lighting", key: "," },
  ] as const;
  /** D-257: the state a placed door is written in (Roll20 places doors closed). */
  const doorStates = [
    { id: 0 as DoorState, label: "Closed" },
    { id: 1 as DoorState, label: "Open" },
    { id: 2 as DoorState, label: "Locked" },
  ];
  let rollModes = [
    { id: "roll", label: "Public" },
    { id: "gmroll", label: "GM" },
    { id: "blindroll", label: "Blind" },
    { id: "selfroll", label: "Self" },
  ] as const;

  const tools: Array<{ id: CanvasTool; label: string; icon: string; shortcut: string; gmOnly: boolean }> = [
    { id: "select", label: "Select", icon: "↖", shortcut: "V", gmOnly: false },
    { id: "pan", label: "Pan / hand", icon: "✋", shortcut: "H", gmOnly: false },
    { id: "draw", label: "Draw", icon: "✎", shortcut: "D", gmOnly: false },
    { id: "text", label: "Text label", icon: "T", shortcut: "T", gmOnly: false },
    { id: "measure", label: "Measure", icon: "⌁", shortcut: "Q", gmOnly: false },
    { id: "dice", label: "Dice", icon: "d20", shortcut: "R", gmOnly: false },
    { id: "fog", label: "Hide / reveal mask", icon: "◍", shortcut: "G", gmOnly: true },
    { id: "wall", label: "Walls & doors", icon: "▤", shortcut: "W", gmOnly: true },
    { id: "light", label: "Lighting", icon: "☀", shortcut: "L", gmOnly: true },
    { id: "pin", label: "Place pin", icon: "⚑", shortcut: "P", gmOnly: true },
    // D-275 (plan §5.7): path mode. Hexcrawl maps only, and the GM's alone — the route is
    // authored for the party, not by it.
    { id: "path", label: "Travel path", icon: "⇢", shortcut: "Y", gmOnly: true },
    { id: "stairs", label: "Stairs", icon: "⇅", shortcut: "", gmOnly: true },
    { id: "raised", label: "Raised area", icon: "⛰", shortcut: "", gmOnly: true },
  ];

  const visibleTools = $derived(
    tools.filter(
      (tool) => (isGM || !tool.gmOnly) && (tool.id !== "path" || pathTool) && (tool.id !== "stairs" || stairsTool) && (tool.id !== "raised" || raisedTool),
    ),
  );

  function choose(toolId: CanvasTool) {
    optionsOpen = HAS_OPTIONS.has(toolId) && (toolId !== active || !optionsOpen);
    active = toolId;
    // D-465: the Wall tool is blind off the GM-info layer (existing walls and endpoint edits
    // only show there), so picking it moves the GM onto that layer.
    if (toolId === "wall" && isGM && layer !== "gm") layer = "gm";
    extraOpen = false;
    onChooseTool(toolId);
    globalThis.dispatchEvent(new CustomEvent("vtt-canvas-tool", { detail: toolId }));
  }

  function act(action: CanvasAction) {
    onAction(action);
  }

  function roll(formulaText: string) {
    const trimmed = formulaText.trim();
    if (!trimmed) return;
    history = [{ formula: trimmed, mode: rollMode }, ...history].slice(0, 5);
    onRoll(trimmed, rollMode);
  }

  /** The rail's own keyboard layer: `/…` combos from `bindings` first, then the defaults. */
  function onKey(event: KeyboardEvent) {
    // Never steal a key from a form control (§10 isTypingTarget also covers <select> and
    // contenteditable) and never fire on a modified chord (Ctrl+D must stay the browser's).
    if (isTypingTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if ($workspaceUi.profile === "foundry") {
      if (event.shiftKey && key === "c") { event.preventDefault(); onPanel("chat"); void tick().then(() => document.getElementById("chat-input")?.focus()); }
      else if (!event.shiftKey && key === "c") { event.preventDefault(); act("character-sheet"); }
      // Foundry movement/target letters must not accidentally select ArenaStar drawing tools.
      return;
    }
    if (key === "y") { event.preventDefault(); act("turn-order"); return; }
    if (key === "u") { event.preventDefault(); act("add-turn"); return; }
    for (const [action, combo] of Object.entries(bindings)) {
      if (combo.toLowerCase() === key) {
        event.preventDefault();
        act(action as CanvasAction);
        return;
      }
    }
    // Layer chords (Roll20 advanced shortcuts; the Map layer needs Shift because `m` is
    // the legacy measure alias).
    if (event.shiftKey && key === "m") {
      event.preventDefault();
      layer = "map";
      return;
    }
    // D-276: the plan asked for `H` for the hex menu, and `h` alone is Roll20's hand tool — so
    // the modifier is what buys the mnemonic. Shift+H opens the hex the *party* stands in: a key
    // has no pointer, and the party's cell is the one hex it can mean.
    if (event.shiftKey && key === "h") {
      event.preventDefault();
      act("hex-party");
      return;
    }
    const layerHit = layers.find((entry) => entry.key.toLowerCase() === key && entry.id !== "map");
    if (layerHit && isGM) {
      event.preventDefault();
      layer = layerHit.id;
      return;
    }
    const aliases: Record<string, CanvasTool> = {
      v: "select",
      s: "select",
      h: "pan",
      a: "pan",
      d: "draw",
      f: "draw",
      t: "text",
      q: "measure",
      m: "measure",
      r: "dice",
    };
    if (key === "x" && active === "measure") {
      event.preventDefault();
      act("recall-measure");
      return;
    }
    const tool = visibleTools.find(
      (item) => item.shortcut.toLowerCase() === key || aliases[key] === item.id,
    );
    if (tool) {
      event.preventDefault();
      choose(tool.id);
    }
    // Escape is gesture-aware: the shell decides whether it cancels a pending polygon
    // (Roll20) or returns to Select when nothing is armed. An open "More tools" menu closes
    // first, and the canvas key layer may already have taken the same Escape (D-465).
    if (event.key === "Escape") {
      if (extraOpen) { event.preventDefault(); extraOpen = false; return; }
      if (event.defaultPrevented) return;
      event.preventDefault();
      act("escape");
    }
  }

  /** D-465: a click anywhere outside the rail's "More tools" menu dismisses it. */
  function onWindowPointerDown(event: PointerEvent) {
    if (!extraOpen) return;
    const target = event.target as Element | null;
    if (target?.closest("[data-workspace-tools-menu], [data-workspace-more-tools]")) return;
    extraOpen = false;
  }

</script>

<svelte:window onkeydown={onKey} onpointerdown={onWindowPointerDown} />
<div class:collapsed class="canvas-toolbar" role="toolbar" aria-label="Canvas tools" data-canvas-toolbar>
  {#if $workspaceUi.profile === "foundry"}
    <div class="foundry-controls" data-foundry-controls>
      <div class="control-sets" role="group" aria-label="Scene control groups">
        {#each controls.filter((item) => isGM || !item.gm) as control (control.id)}
          <button data-icon-button type="button" data-foundry-control={control.id} class:active={controlSet === control.id}
            aria-pressed={controlSet === control.id} title={control.label} aria-label={control.label} onclick={() => chooseSet(control.id)}><Icon name={control.icon} size={19}/></button>
        {/each}
      </div>
      <div class="control-tools" role="group" aria-label="Selected layer tools">
        {#each setTools as tool (tool.id)}
          <button data-icon-button type="button" data-canvas-tool={tool.id} class:active={active === tool.id} aria-pressed={active === tool.id}
            title={tool.label} aria-label={tool.label} onclick={() => choose(tool.id)}><Icon name={tool.id} size={18}/></button>
        {/each}
        {#if controlSet === "templates"}
          {#each measureShapes as shape (shape.id)}<button type="button" title={shape.label} aria-label={shape.label} data-canvas-measure-shape={shape.id}
            class:active={settings.measureShape === shape.id} onclick={() => { choose("measure"); settings.measureShape = shape.id; }}><Icon name={shape.id === "line" ? "measure" : "placeables"} size={17}/></button>{/each}
        {/if}
      </div>
    </div>
  {:else}
    <div class="rail-scroll">
      {#if $workspaceUi.profile === "modern"}
        <button data-icon-button class="collapse" type="button" title={collapsed ? "Expand tools" : "Collapse tools"} aria-label={collapsed ? "Expand toolbar" : "Collapse toolbar"} onclick={() => collapsed = !collapsed}><Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={16}/></button>
      {/if}
      {#if !collapsed || $workspaceUi.profile === "roll20"}
        <div class="group main-tools" role="group" aria-label="Tools">
          {#each primaryTools as tool, index (tool.id)}
            {#if $workspaceUi.profile === "modern" && index > 0 && toolGroup(tool.id) !== toolGroup(primaryTools[index - 1].id)}<i class="rail-gap" aria-hidden="true"></i>{/if}
            <button data-icon-button type="button" class:active={active === tool.id} aria-pressed={active === tool.id} title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
              aria-label={tool.label} data-canvas-tool={tool.id} data-tool-group={toolGroup(tool.id)} onclick={() => choose(tool.id)}><Icon name={tool.id} size={19}/><span class="label">{tool.label}</span></button>
          {/each}
          <button data-icon-button type="button" class:active={extraOpen} title="More tools and layers" aria-label="More tools and layers" aria-expanded={extraOpen}
            data-workspace-more-tools onclick={() => { extraOpen = !extraOpen; optionsOpen = false; }}><Icon name="more" size={19}/></button>
        </div>
        {#if $workspaceUi.profile === "modern" && isGM}
          <div class="group layer-switch" role="group" aria-label="Layers">
            {#each layers as entry (entry.id)}
              <button data-icon-button type="button" class:active={layer === entry.id} aria-pressed={layer === entry.id} title={`${entry.label} layer`} aria-label={entry.label}
                data-canvas-layer={entry.id} onclick={() => layer = entry.id}><Icon name={entry.id} size={16}/></button>
            {/each}
          </div>
        {/if}
        {#if $workspaceUi.profile === "roll20" && isGM}
          <div class="group layer-dock" role="group" aria-label="Layers"><span class="layer-caption">LAYERS</span>
            {#each [layers[1], layers[2], layers[0], layers[3]] as entry (entry.id)}
              <button data-icon-button type="button" class:active={layer === entry.id} aria-pressed={layer === entry.id} title={entry.label} aria-label={entry.label}
                data-canvas-layer={entry.id} onclick={() => layer = entry.id}><Icon name={entry.id} size={21}/><span>{entry.id === "tokens" ? "TOKENS" : entry.id === "lighting" ? "LIGHT" : entry.id.toUpperCase()}</span></button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
    {#if extraOpen}
      <div class="tool-extra-menu" data-workspace-tools-menu role="menu" aria-label="More canvas tools">
        <span class="menu-caption">Table actions</span>
        {#each [{ id: "zoom-in", label: "Zoom in", icon: "zoomIn" }, { id: "zoom-out", label: "Zoom out", icon: "zoomOut" }, { id: "zoom-fit", label: "Fit scene", icon: "fit" }, { id: "turn-order", label: "Turn order", icon: "turn" },
          { id: "add-turn", label: "Add to turn order", icon: "addTurn" }, { id: "settings", label: "Settings", icon: "settings" }, { id: "help", label: "Help", icon: "help" }] as action (action.id)}
          <button role="menuitem" data-canvas-action={action.id} onclick={() => { extraOpen = false; act(action.id as CanvasAction); }}><Icon name={action.icon} size={17}/>{action.label}</button>
        {/each}
        {#if isGM}<button role="menuitem" data-canvas-action="erase-all" onclick={() => { extraOpen = false; onEraseAll(); }}><Icon name="trash" size={17}/>Erase drawings</button>{/if}
      </div>
    {/if}
  {/if}
  {#if ($workspaceUi.profile === "foundry" || !collapsed) && optionsOpen && HAS_OPTIONS.has(active)}
    <div class="tool-popover" data-tool-options={active}>
      <div class="popover-heading">
        <div><span class="popover-kicker">CANVAS TOOL</span><strong>{tools.find((tool) => tool.id === active)?.label}</strong></div>
        <button data-icon-button type="button" class="popover-close" aria-label="Close tool options" title="Close tool options"
          onclick={() => (optionsOpen = false)}><Icon name="x" size={17} /></button>
      </div>
    <div class="group subpanel" role="group" aria-label="Tool options">
      {#if active === "path"}
        <p class="hint" data-path-hint>{hexTravel.pathHint}</p>
      {:else if active === "draw"}
        <div class="swatches">
          {#each drawShapes as shape (shape.id)}
            <button
              type="button"
              class:active={settings.drawShape === shape.id}
              aria-pressed={settings.drawShape === shape.id}
              title={shape.label}
              data-canvas-shape={shape.id}
              onclick={() => (settings.drawShape = shape.id)}
            >
              <span class="icon">{shape.icon}</span><span class="label">{shape.label}</span>
            </button>
          {/each}
        </div>
        <div class="style-row">
          <input
            type="color"
            aria-label="Stroke colour"
            title="Stroke colour"
            data-canvas-stroke
            bind:value={settings.drawingStyle.stroke}
          />
          <input
            type="color"
            aria-label="Fill colour"
            title="Fill colour"
            data-canvas-fill
            bind:value={settings.drawingStyle.fill}
          />
          <input
            type="range"
            aria-label="Line width"
            title="Line width"
            min="1"
            max="12"
            data-canvas-width
            bind:value={settings.drawingStyle.strokeWidth}
          />
        </div>
        <p class="hint">Alt = ellipse · Shift = snap to grid · Esc finishes a polygon</p>
      {:else if active === "text"}
        <div class="style-row">
          <input
            type="number"
            aria-label="Font size"
            title="Font size"
            min="8"
            max="72"
            data-canvas-text-size
            bind:value={settings.textSize}
          />
          <input
            type="color"
            aria-label="Text colour"
            title="Text colour"
            data-canvas-text-color
            bind:value={settings.drawingStyle.stroke}
          />
        </div>
        <p class="hint">Click the map to type · Esc commits · double-click a label to edit</p>
      {:else if active === "measure"}
        <div class="swatches">
          {#each measureShapes as shape (shape.id)}
            <button
              type="button"
              class:active={settings.measureShape === shape.id}
              aria-pressed={settings.measureShape === shape.id}
              title={`${shape.label} measurement`}
              data-canvas-measure-shape={shape.id}
              onclick={() => (settings.measureShape = shape.id)}
            >
              <span class="label">{shape.label}</span>
            </button>
          {/each}
        </div>
        <div class="swatches">
          {#each snapModes as mode (mode.id)}
            <button
              type="button"
              class:active={settings.measureSnap === mode.id}
              aria-pressed={settings.measureSnap === mode.id}
              title={`Snap: ${mode.label}`}
              data-canvas-snap={mode.id}
              onclick={() => (settings.measureSnap = mode.id)}
            >
              <span class="label">{mode.label}</span>
            </button>
          {/each}
        </div>
        <button
          type="button"
          class:active={settings.measureBroadcast}
          aria-pressed={settings.measureBroadcast}
          title="Show the measurement to everyone (Roll20: Show to others)"
          data-canvas-measure-broadcast
          onclick={() => (settings.measureBroadcast = !settings.measureBroadcast)}
        >
          <span class="icon">{settings.measureBroadcast ? "◉" : "◎"}</span>
          <span class="label"
            >{settings.measureBroadcast ? "Shown to others" : "Hidden from others"}</span
          >
        </button>
        <p class="hint">Right-click while measuring (or Ctrl+click) adds a waypoint · X recalls the last measurement</p>
      {:else if active === "dice"}
        <div class="swatches">
          {#each toolDice as die (die)}
            <button
              type="button"
              title={`Roll ${diceCount}d${die}`}
              data-canvas-die={die}
              onclick={() => roll(`${diceCount}d${die}`)}
            >
              <span class="label">d{die}</span>
            </button>
          {/each}
        </div>
        <div class="swatches">
          {#each [1, 2, 3, 4, 5] as count (count)}
            <button
              type="button"
              class:active={diceCount === count}
              aria-pressed={diceCount === count}
              title={`${count} dice`}
              data-canvas-dice-count={count}
              onclick={() => (diceCount = count)}>{count}</button
            >
          {/each}
        </div>
        <div class="swatches">
          {#each rollModes as mode (mode.id)}
            <button
              type="button"
              class:active={rollMode === mode.id}
              aria-pressed={rollMode === mode.id}
              title={`Roll to: ${mode.label}`}
              data-canvas-roll-mode={mode.id}
              onclick={() => (rollMode = mode.id)}
            >
              <span class="label">{mode.label}</span>
            </button>
          {/each}
        </div>
        <form
          class="dice-form"
          onsubmit={(event) => {
            event.preventDefault();
            roll(formula);
          }}
        >
          <input aria-label="Dice formula" bind:value={formula} placeholder="1d20+5" />
          <button type="submit" data-canvas-roll>Roll</button>
        </form>
        {#if history.length > 0}
          <div class="history">
            <span class="group-label">Last rolls</span>
            {#each history as entry, index (index)}
              <button
                type="button"
                title={`Re-roll ${entry.formula} (${entry.mode})`}
                data-canvas-reroll={index}
                onclick={() => {
                  rollMode = entry.mode;
                  roll(entry.formula);
                }}>{entry.formula}</button
              >
            {/each}
          </div>
        {/if}
      {:else if active === "fog"}
        <div class="swatches">
          <button
            type="button"
            class:active={settings.fogBrush === "reveal"}
            aria-pressed={settings.fogBrush === "reveal"}
            title="Reveal brush"
            data-canvas-fog-brush="reveal"
            onclick={() => (settings.fogBrush = "reveal")}><span class="label">Reveal</span></button
          >
          <button
            type="button"
            class:active={settings.fogBrush === "hide"}
            aria-pressed={settings.fogBrush === "hide"}
            title="Hide brush"
            data-canvas-fog-brush="hide"
            onclick={() => (settings.fogBrush = "hide")}><span class="label">Hide</span></button
          >
        </div>
        <div class="swatches">
          <button
            type="button"
            class:active={settings.fogShape === "rect"}
            aria-pressed={settings.fogShape === "rect"}
            title="Rectangle brush (drag)"
            data-canvas-fog-shape="rect"
            onclick={() => (settings.fogShape = "rect")}><span class="label">Rect</span></button
          >
          <button
            type="button"
            class:active={settings.fogShape === "poly"}
            aria-pressed={settings.fogShape === "poly"}
            title="Polygon brush (click vertices, Esc or click the first point to close)"
            data-canvas-fog-shape="poly"
            onclick={() => (settings.fogShape = "poly")}><span class="label">Polygon</span></button
          >
        </div>
        <div class="swatches">
          <button
            type="button"
            title="Reveal the whole scene"
            data-canvas-action="reveal-all"
            onclick={() => act("reveal-all")}><span class="label">Reveal all</span></button
          >
          <button
            type="button"
            title="Hide the whole scene"
            data-canvas-action="hide-all"
            onclick={() => act("hide-all")}><span class="label">Hide all</span></button
          >
        </div>
        <p class="hint">{fogStrokes} mask stroke(s) · Esc closes a polygon</p>
      {:else if active === "wall"}
        <div class="swatches" role="group" aria-label="Wall editing mode">
          {#each [{ id: "draw", label: "Draw" }, { id: "corner", label: "Move corner" }, { id: "split", label: "Split" }] as mode (mode.id)}
            <button type="button" data-wall-edit-mode={mode.id}
              class:active={settings.wallEditMode === mode.id} aria-pressed={settings.wallEditMode === mode.id}
              onclick={() => settings.wallEditMode = mode.id as ToolOptions["wallEditMode"]}><span class="label">{mode.label}</span></button>
          {/each}
        </div>
        <label><input type="checkbox" data-wall-endpoint-snap bind:checked={settings.wallEndpointSnap} />Snap to endpoints (8 px)</label>
        {#if settings.wallEditMode === "corner"}
          <label><input type="checkbox" data-wall-joined bind:checked={settings.wallMoveJoined} />Move joined endpoints</label>
        {/if}
        <div class="swatches">
          <button
            type="button"
            class:active={settings.wallKind === "wall"}
            aria-pressed={settings.wallKind === "wall"}
            title="Wall segment — blocks sight, light, sound and movement"
            data-canvas-wall-kind="wall"
            onclick={() => (settings.wallKind = "wall")}><span class="label">Wall</span></button
          >
          <button
            type="button"
            class:active={settings.wallKind === "door"}
            aria-pressed={settings.wallKind === "door"}
            title="Door — click it to open or close"
            data-canvas-wall-kind="door"
            onclick={() => (settings.wallKind = "door")}><span class="label">Door</span></button
          >
          <button
            type="button"
            class:active={settings.wallKind === "window"}
            aria-pressed={settings.wallKind === "window"}
            title="Window — sight and light pass, movement and sound do not"
            data-canvas-wall-kind="window"
            onclick={() => (settings.wallKind = "window")}><span class="label">Window</span></button
          >
        </div>
        {#if settings.wallKind === "door"}
          <div class="swatches">
            {#each doorStates as state (state.id)}
              <button
                type="button"
                class:active={settings.wallDoorState === state.id}
                aria-pressed={settings.wallDoorState === state.id}
                title={`Place the door ${state.label.toLowerCase()}`}
                data-canvas-door-state={state.label.toLowerCase()}
                onclick={() => (settings.wallDoorState = state.id)}
              ><span class="label">{state.label}</span></button>
            {/each}
          </div>
        {/if}
        <button type="button" data-canvas-action="delete-last-placement" onclick={() => act("delete-last-placement")}>
          <span class="label">Erase last</span>
        </button>
        {#if settings.wallEditMode === "draw"}
          <p class="hint">Drag to place · click a door to open/close · Alt-click erases · Ctrl bypasses endpoint snapping</p>
        {:else if settings.wallEditMode === "corner"}
          <p class="hint">Drag a gold endpoint · shared corners move together · Ctrl bypasses endpoint snapping · Esc cancels</p>
        {:else}
          <p class="hint">Click a plain wall to split · doors/windows and prefab walls are protected · one undo per edit</p>
        {/if}
      {:else if active === "light"}
        {#if selectedLight}
          {@const light = selectedLight}
          <!-- D-465: a placed light stays editable — radius swatches, colour and Delete act on it. -->
          <p class="hint" data-light-selected={light.id}>Selected light · {Math.round(light.dim / cellSize * 10) / 10}□ radius</p>
          <div class="swatches">
            {#each [1, 2, 3, 6] as cells (cells)}
              <button
                type="button"
                class:active={light.dim === cells * cellSize}
                aria-pressed={light.dim === cells * cellSize}
                title={`${cells} grid cell(s) of light`}
                data-canvas-light-radius={cells}
                onclick={() => onLightChange({ dim: cells * cellSize, bright: Math.max(1, Math.round((cells * cellSize) / 2)) })}
              >
                <span class="label">{cells}□</span>
              </button>
            {/each}
          </div>
          <div class="style-row">
            <input
              type="color"
              aria-label="Light colour"
              title="Light colour"
              data-canvas-light-color
              value={light.color}
              onchange={(event) => onLightChange({ color: event.currentTarget.value })}
            />
            <button type="button" data-canvas-light-delete onclick={() => onLightDelete()}>
              <span class="label">Delete light</span>
            </button>
          </div>
          <p class="hint">Drag the marker to move it · Alt-click or Delete removes it · Esc deselects</p>
        {:else}
          <div class="swatches">
            {#each [1, 2, 3, 6] as cells (cells)}
              <button
                type="button"
                class:active={settings.lightRadius === cells * cellSize}
                aria-pressed={settings.lightRadius === cells * cellSize}
                title={`${cells} grid cell(s) of light`}
                data-canvas-light-radius={cells}
                onclick={() => (settings.lightRadius = cells * cellSize)}
              >
                <span class="label">{cells}□</span>
              </button>
            {/each}
          </div>
          <div class="style-row">
            <input
              type="color"
              aria-label="Light colour"
              title="Light colour"
              data-canvas-light-color
              bind:value={settings.lightColor}
            />
            <button type="button" data-canvas-action="delete-last-placement" onclick={() => act("delete-last-placement")}>
              <span class="label">Erase last</span>
            </button>
          </div>
          <p class="hint">Click the map to place a light · click a placed light to select, drag or delete it</p>
        {/if}
      {:else if active === "stairs"}
        <p class="hint" data-stairs-hint>
          Drag over the stairs on the map. They join the floor you are viewing and the next one up; change the floors, directions or name under Scenes → Floor play &amp; stairs.
        </p>
      {:else if active === "raised"}
        <div class="style-row" data-raised-options>
          <label class="hint">Height
            <input type="number" min="1" max="1000" step="1" aria-label="Raised area height" data-raised-height bind:value={settings.raisedHeight} />
          </label>
          <label class="hint">
            <input type="checkbox" aria-label="Raised area solid" data-raised-solid bind:checked={settings.raisedSolid} />
            Solid (blocks sight)
          </label>
        </div>
        <p class="hint" data-raised-hint>
          Drag over crates, a dais or a scaffold. Walking tokens climb onto it; a solid one hides what is behind it from eyes below its top. Edit it under Scenes → Raised areas.
        </p>
      {:else if active === "pin"}
        <p class="hint">
          Click the map to drop a pin. Pins are GM-only until you make them visible.
        </p>
      {:else if active === "pan"}
        <p class="hint">Drag the map with any mouse button · Shift-drag pans from any tool</p>
      {:else}
        <p class="hint">
          Click to select · double-click a token for its sheet · Alt+click pings
        </p>
      {/if}
    </div>

    </div>
  {/if}
</div>

<style>
  /* A single, fixed-width icon rail. Tool options occupy the content-dock edge
     rather than swallowing drawing gestures on the map; no canvas reflow. */
  .canvas-toolbar {
    position: relative;
    flex: 0 0 56px;
    width: 56px;
    min-height: 0;
    background: #111a23;
    border-right: 1px solid #283443;
    z-index: 20;
  }
  .canvas-toolbar.collapsed { flex-basis: 44px; width: 44px; }
  .rail-scroll {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    padding: 9px 6px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    overscroll-behavior: contain;
  }
  .rail-scroll::-webkit-scrollbar { display: none; }
  .rail-scroll .group { display: flex; flex-direction: column; gap: 3px; width: 100%; border-top: 1px solid #293846; padding-top: 9px; }
  .rail-scroll .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .rail-scroll button {
    flex: 0 0 42px;
    width: 42px;
    height: 42px;
    min-width: 0;
    min-height: 42px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 11px;
    background: transparent;
    color: #aebec8;
    cursor: pointer;
    transition: color .16s, background .16s, border-color .16s;
  }
  .rail-scroll button:hover { background: #233342; color: #f2fbfc; }
  .rail-scroll button.active {
    border-color: #4e938b;
    color: #a7f0df;
    background: #1d4342;
    box-shadow: inset 3px 0 0 #70d8c6;
  }
  .rail-scroll button:focus-visible { position: relative; z-index: 2; }
  .rail-scroll .collapse { flex-basis: 32px; height: 32px; min-height: 32px; opacity: .8; }
  .canvas-toolbar.collapsed .rail-scroll { padding-inline: 1px; }
  .canvas-toolbar.collapsed .collapse { width: 40px; }
  .icon { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; }
  .tool-popover {
    /* A flyout on the table side of the chat dock: it sits over the map's right edge and never
       over the dock, and the map's left side (where the rail's tools are drawn) stays clickable. */
    position: fixed;
    left: auto;
    right: calc(var(--gm-dock-width, 340px) + 12px);
    top: 186px;
    width: calc(clamp(312px, 25vw, 376px) - 24px);
    max-height: min(590px, calc(100dvh - 210px));
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border: 1px solid #41566a;
    border-radius: 14px;
    background: #1b2632;
    color: #edf5f6;
    box-shadow: 0 18px 52px #020810bd, 0 2px 10px #02081055;
  }
  .popover-heading {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 12px 10px 16px;
    border-bottom: 1px solid #354658;
    background: #202d3a;
  }
  .popover-heading > div { display: flex; flex-direction: column; gap: 2px; }
  .popover-heading strong { font-size: .94rem; font-weight: 700; }
  .popover-kicker { font-size: .63rem; font-weight: 750; letter-spacing: .14em; color: #86bfb7; }
  .popover-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #b6c6cd;
    cursor: pointer;
  }
  .popover-close:hover { background: #344757; color: #fff; }
  .subpanel { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 18px; }
  .subpanel .group-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .09em; color: #a3b8bf; }
  .swatches, .style-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
  .subpanel button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: auto;
    min-width: 39px;
    min-height: 38px;
    padding: 6px 9px;
    border: 1px solid #465a68;
    border-radius: 8px;
    background: #253543;
    color: #ebf3f3;
    cursor: pointer;
    text-align: center;
    font-size: .86rem;
  }
  .subpanel button:hover, .subpanel button.active { background: #315a57; border-color: #70d8c6; color: #f6fffc; }
  .subpanel .icon { width: auto; height: auto; font-weight: 700; }
  .subpanel .label { font-size: .83rem; }
  .subpanel input { min-height: 38px; border: 1px solid #506473; border-radius: 7px; background: #111e29; color: #fff; padding: 5px 8px; }
  .style-row input[type="color"] { width: 40px; height: 38px; min-height: 38px; padding: 2px; }
  .style-row input[type="range"] { flex: 1 1 100px; min-width: 85px; }
  .style-row input[type="number"] { width: 82px; }
  .hint { margin: 0; color: #b5c4ca; font-size: .76rem; line-height: 1.45; }
  .dice-form { display: flex; gap: 7px; }
  .dice-form input { flex: 1; width: 0; }
  .dice-form button { flex: 0 0 auto; }
  .history { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid #354658; padding-top: 10px; }
  .history .group-label { width: 100%; }
  .canvas-toolbar:not(.collapsed)::after {
    content: "⌄";
    position: absolute;
    bottom: 0;
    left: 0;
    width: 55px;
    height: 19px;
    background: linear-gradient(transparent, #111a23 65%);
    color: #91bdb8;
    text-align: center;
    line-height: 20px;
    pointer-events: none;
  }
  @media (max-width: 930px) {
    .tool-popover { right: calc(var(--gm-dock-width, 340px) + 8px); width: 290px; }
  }
  @media (max-width: 710px) {
    .tool-popover {
      top: auto;
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      max-height: min(36dvh, 320px);
    }
  }
</style>
