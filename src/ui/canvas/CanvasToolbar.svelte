<script lang="ts">
  /**
   * §10 the left canvas rail (D-255, D-256) — the Roll20 Toolbox laid out as one column:
   * layers (GM), navigation, tools, GM tools, then zoom/window actions, with a sub-toolbar
   * under whichever tool is active (Roll20's secondary toolbar). The component owns nothing
   * but its own UI state: the shells hold the tool settings object and act on
   * `vtt-canvas-tool` / `vtt-canvas-action` events.
   */
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
    | "path";
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
    | "hex-party";
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
    onChooseTool = () => {},
    onRoll = () => {},
    onEraseAll = () => {},
    pathTool = false,
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
  } = $props();

  let formula = $state("1d20");
  let diceCount = $state(1);
  let rollMode = $state<RollMode>("roll");
  let history = $state<Array<{ formula: string; mode: RollMode }>>([]);
  let optionsOpen = $state(false);
  const HAS_OPTIONS = new Set<CanvasTool>(["draw", "text", "measure", "dice", "fog", "wall", "light", "pin", "path"]);
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
  ];

  const visibleTools = $derived(
    tools.filter(
      (tool) => (isGM || !tool.gmOnly) && (tool.id !== "path" || pathTool),
    ),
  );

  function choose(toolId: CanvasTool) {
    optionsOpen = HAS_OPTIONS.has(toolId) && (toolId !== active || !optionsOpen);
    active = toolId;
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
      u: "turn-order",
      y: "turn-order",
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
    // (Roll20) or returns to Select when nothing is armed.
    if (event.key === "Escape") {
      event.preventDefault();
      act("escape");
    }
  }

</script>

<svelte:window onkeydown={onKey} />
<div class:collapsed class="canvas-toolbar" role="toolbar" aria-label="Canvas tools" data-canvas-toolbar>
  <div class="rail-scroll">
  <button data-icon-button
    class="collapse"
    type="button"
    aria-label={collapsed ? "Expand toolbar" : "Collapse toolbar"}
    title={collapsed ? "Expand toolbar" : "Collapse toolbar"}
    onclick={() => (collapsed = !collapsed)}><Icon name={collapsed ? "chevronRight" : "chevronLeft"} /></button
  >
  {#if !collapsed}
    {#if isGM}
      <div class="group" role="group" aria-label="Layers">
        <span class="group-label">Layer</span>
        <div class="layers">
          {#each layers as entry (entry.id)}
            <button data-icon-button
              type="button"
              class:active={layer === entry.id}
              aria-pressed={layer === entry.id}
              title={`${entry.label} (${entry.key})`}
              aria-label={entry.label}
              data-canvas-layer={entry.id}
              onclick={() => (layer = entry.id)}
            >
              <span class="icon"><Icon name={entry.id} /></span>
              <span class="label">{entry.label.split(" ")[0]}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="group" role="group" aria-label="Tools">
      {#each visibleTools as tool (tool.id)}
        <button data-icon-button
          type="button"
          class:active={active === tool.id}
          aria-pressed={active === tool.id}
          title={`${tool.label} (${tool.shortcut})`}
          aria-label={tool.label}
          data-canvas-tool={tool.id}
          onclick={() => choose(tool.id)}
        >
          <span class="icon"><Icon name={tool.id} /></span><span class="label">{tool.label}</span>
        </button>
      {/each}
    </div>

    <div class="group" role="group" aria-label="View">
      <button data-icon-button type="button" title="Zoom in" aria-label="Zoom in" data-canvas-action="zoom-in" onclick={() => act("zoom-in")}>
        <span class="icon"><Icon name="zoomIn" /></span><span class="label">Zoom in</span>
      </button>
      <button data-icon-button type="button" title="Zoom out" aria-label="Zoom out" data-canvas-action="zoom-out" onclick={() => act("zoom-out")}>
        <span class="icon"><Icon name="zoomOut" /></span><span class="label">Zoom out</span>
      </button>
      <button data-icon-button type="button" title="Fit scene to view" aria-label="Fit scene" data-canvas-action="zoom-fit" onclick={() => act("zoom-fit")}>
        <span class="icon"><Icon name="fit" /></span><span class="label">Fit</span>
      </button>
      <button data-icon-button type="button" title="Turn order (Y)" aria-label="Turn order" data-canvas-action="turn-order" onclick={() => act("turn-order")}>
        <span class="icon"><Icon name="turn" /></span><span class="label">Turn order</span>
      </button>
      <button data-icon-button type="button" title="Add the selection to the turn order (U)" aria-label="Add to turn order" data-canvas-action="add-turn" onclick={() => act("add-turn")}>
        <span class="icon"><Icon name="addTurn" /></span><span class="label">Add turn</span>
      </button>
      <button data-icon-button type="button" title="Settings" aria-label="Settings" data-canvas-action="settings" onclick={() => act("settings")}>
        <span class="icon"><Icon name="settings" /></span><span class="label">Settings</span>
      </button>
      <button data-icon-button type="button" title="Keyboard shortcuts and help" aria-label="Help" data-canvas-action="help" onclick={() => act("help")}>
        <span class="icon"><Icon name="help" /></span><span class="label">Help</span>
      </button>
    </div>

    {#if isGM}
      <div class="group" role="group" aria-label="Drawings">
        <button data-icon-button
          type="button"
          class="danger"
          aria-label="Erase all drawings"
          title="Erase all drawings in this scene"
          data-canvas-action="erase-all"
          onclick={onEraseAll}><span class="icon"><Icon name="trash" /></span><span class="label">Erase drawings</span></button
        >
      </div>
    {/if}
  {/if}
  </div>
  {#if !collapsed && optionsOpen && HAS_OPTIONS.has(active)}
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
        <p class="hint">Ctrl+click adds a waypoint · X recalls the last measurement</p>
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
        <p class="hint">Drag to place · click a door to open/close · Alt-click erases a wall</p>
      {:else if active === "light"}
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
        <p class="hint">Click the map to place a light</p>
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
  .rail-scroll .group-label, .rail-scroll .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .layers { display: flex; flex-direction: column; gap: 3px; }
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
  .danger { color: #e6a7a5 !important; }
  .tool-popover {
    position: fixed;
    left: auto;
    right: 12px;
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
    .tool-popover { right: 8px; width: 290px; }
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
