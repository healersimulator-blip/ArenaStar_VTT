<script lang="ts">
  /**
   * D-465 — Scene settings window (GM). Everything a scene *is*, in one place: name, size in
   * pixels (and in cells), the grid (type, size, colour, opacity, distance, units, diagonals,
   * hex layout), background colour and darkness — plus the fit testers asked for: state how
   * many squares or hexes the map has, and the scene and background are derived from that.
   *
   * Every field writes one scene update on change (one undo step per edit). The window follows
   * the scene it was opened for; if that scene is deleted it says so instead of editing nothing.
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { SceneDocument, SceneGrid } from "../../core/documents";
  import {
    backgroundRect,
    backgroundTransformOf,
    backgroundWriteFields,
    type MapGridEstimate,
    type NaturalSize,
  } from "../../core/backgroundTransform";
  import {
    MAX_GRID_COUNT,
    fitSceneToGridCount,
    gridCountOfMap,
    normalizeGridCount,
    type GridCount,
  } from "../../core/sceneFit";
  import { DEFAULT_GRID_COLOR_CSS, DEFAULT_GRID_STYLE } from "../../canvas/grid";

  let {
    client,
    bus,
    sceneId = null,
    backgroundNatural = null,
    activeSceneId = null,
    onOpenBackground = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    /** The scene this window edits; null = the active scene. */
    sceneId?: string | null;
    /** Natural pixel size of the *active* scene's background, when the shell has decoded it. */
    backgroundNatural?: NaturalSize | null;
    activeSceneId?: string | null;
    /** Opens the Map & background panel (grid detection lives there). */
    onOpenBackground?: (() => void) | null;
  } = $props();

  let scene = $state<SceneDocument | null>(null);
  let missing = $state(false);
  let countDraft = $state<GridCount | null>(null);
  let fitNotice = $state<string>("");

  function refresh(): void {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const target = sceneId
      ? scenes.find((entry) => entry._id === sceneId) ?? null
      : scenes.find((entry) => entry.active) ?? scenes[0] ?? null;
    missing = !!sceneId && !target;
    scene = target ? structuredClone(target) : null;
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
    };
  });

  const grid = $derived(scene?.grid ?? null);
  const isActive = $derived(!!scene && (activeSceneId === null || scene._id === activeSceneId || scene.active));
  /** Natural size is only known for the active scene's background (the stage decoded it). */
  const natural = $derived(isActive && scene?.img ? backgroundNatural : null);
  const mapGrid = $derived.by((): MapGridEstimate | null => {
    const measured = scene?.background?.mapGrid;
    if (!scene || !measured || measured.image !== scene.img) return null;
    return { sizeX: measured.sizeX, sizeY: measured.sizeY, offsetX: measured.offsetX, offsetY: measured.offsetY };
  });
  const cells = $derived.by(() => {
    if (!scene || !grid || !(grid.size > 0) || grid.type === "gridless") return null;
    return { columns: Math.round((scene.width / grid.size) * 10) / 10, rows: Math.round((scene.height / grid.size) * 10) / 10 };
  });
  /** What the GM is most likely to recognise: the measured count, else the image at the grid's size. */
  const suggestedCount = $derived.by((): GridCount => {
    if (natural && mapGrid) return gridCountOfMap(natural, mapGrid);
    if (natural && grid && grid.size > 0) {
      const t = backgroundTransformOf(scene?.background);
      return {
        columns: Math.max(1, Math.round((natural.width * t.scaleX) / grid.size)),
        rows: Math.max(1, Math.round((natural.height * t.scaleY) / grid.size)),
      };
    }
    return { columns: 20, rows: 15 };
  });
  const count = $derived(countDraft ?? suggestedCount);
  const fitPreview = $derived.by(() => {
    if (!natural || !grid || grid.type === "gridless") return null;
    return fitSceneToGridCount({
      natural,
      count,
      gridSize: grid.size,
      type: grid.type,
      hexLayout: grid.hexLayout,
      mapGrid: mapGrid && !countDraft ? mapGrid : null,
    });
  });
  const gridAlpha = $derived(typeof grid?.alpha === "number" ? grid.alpha : DEFAULT_GRID_STYLE.alpha);
  const gridColor = $derived(grid?.color ?? DEFAULT_GRID_COLOR_CSS);

  function submit(diff: Record<string, unknown>): void {
    if (!scene) return;
    client.submit([{ kind: "update", ref: { coll: "scenes", id: scene._id }, diff }]);
  }
  function patchGrid(patch: Partial<SceneGrid>): void {
    if (!grid) return;
    submit({ grid: { ...grid, ...patch } });
  }
  function number(event: Event, fallback: number, min: number, max: number): number {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }
  function setSize(width: number, height: number): void {
    submit({ width: Math.round(width), height: Math.round(height) });
  }
  /** The scene becomes exactly the background as drawn (no empty margin, nothing cut off). */
  function fitSizeToBackground(): void {
    if (!scene || !natural) return;
    const rect = backgroundRect(natural, backgroundTransformOf(scene.background));
    const t = backgroundTransformOf(scene.background);
    submit({
      width: Math.max(1, Math.round(rect.right - rect.left)),
      height: Math.max(1, Math.round(rect.bottom - rect.top)),
      background: { ...(scene.background ?? {}), ...backgroundWriteFields({ ...t, x: 0, y: 0 }) },
    });
  }
  function applyCountFit(): void {
    if (!scene || !fitPreview || !grid) return;
    const normalized = normalizeGridCount(count);
    if (!normalized) return;
    submit({
      width: fitPreview.width,
      height: fitPreview.height,
      grid: { ...grid, size: fitPreview.gridSize },
      background: {
        ...(scene.background ?? {}),
        ...backgroundWriteFields(fitPreview.transform),
        // The stated count is the map's grid from now on (phase from the measurement if kept).
        mapGrid: scene.img
          ? {
              image: scene.img,
              sizeX: fitPreview.cell.width,
              sizeY: fitPreview.cell.height,
              offsetX: mapGrid && !countDraft ? mapGrid.offsetX : 0,
              offsetY: mapGrid && !countDraft ? mapGrid.offsetY : 0,
            }
          : (scene.background?.mapGrid ?? null),
      },
    });
    fitNotice = `Scene set to ${normalized.columns} × ${normalized.rows} cells (${fitPreview.width} × ${fitPreview.height} px); the map fills it.`;
    countDraft = null;
  }
  const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();
</script>

<div class="scene-settings" data-scene-settings-panel={scene?._id ?? ""}>
  {#if missing}
    <p class="empty" data-scene-settings-missing>This scene no longer exists.</p>
  {:else if !scene || !grid}
    <p class="empty">No scene to edit yet — create one from the scene bar.</p>
  {:else}
    <section>
      <h4>Scene</h4>
      <div class="row">
        <label class="grow">
          Name
          <input data-scene-name type="text" value={scene.name} onchange={(e) => submit({ name: (e.target as HTMLInputElement).value.trim() || scene?.name })} />
        </label>
        <label>
          Background colour
          <input data-scene-bg-color type="color" value={scene.background?.color ?? "#000000"}
            onchange={(e) => submit({ background: { ...(scene?.background ?? {}), color: (e.target as HTMLInputElement).value } })} />
        </label>
      </div>
      <label class="slider">
        Darkness <span class="value">{Math.round((scene.darkness ?? 0) * 100)}%</span>
        <input data-scene-darkness type="range" min="0" max="1" step="0.05" value={scene.darkness ?? 0}
          onchange={(e) => submit({ darkness: number(e, 0, 0, 1) })} />
      </label>
    </section>

    <section>
      <h4>Size</h4>
      <div class="row">
        <label>
          Width (px)
          <input data-scene-width type="number" min="100" max="40000" step="1" value={scene.width}
            onchange={(e) => setSize(number(e, scene?.width ?? 1000, 100, 40000), scene?.height ?? 1000)} />
        </label>
        <label>
          Height (px)
          <input data-scene-height type="number" min="100" max="40000" step="1" value={scene.height}
            onchange={(e) => setSize(scene?.width ?? 1000, number(e, scene?.height ?? 1000, 100, 40000))} />
        </label>
        {#if cells}
          <p class="readout" data-scene-cells>= {cells.columns} × {cells.rows} cells of {grid.size} px</p>
        {/if}
      </div>
      {#if natural}
        <div class="row">
          <button type="button" data-scene-fit-background onclick={fitSizeToBackground}>Size scene to the background ({Math.round(natural.width * backgroundTransformOf(scene.background).scaleX)} × {Math.round(natural.height * backgroundTransformOf(scene.background).scaleY)} px)</button>
        </div>
      {:else if scene.img && !isActive}
        <p class="hint">Activate this scene to size it from its background.</p>
      {/if}
    </section>

    <section>
      <h4>Grid</h4>
      <div class="row">
        <label>
          Type
          <select data-scene-grid-type value={grid.type} onchange={(e) => patchGrid({ type: (e.target as HTMLSelectElement).value as SceneGrid["type"] })}>
            {#each ["square", "hex", "gridless"] as t (t)}<option value={t}>{t}</option>{/each}
          </select>
        </label>
        <label>
          Size (px)
          <input data-scene-grid-size type="number" min="10" max="1000" value={grid.size}
            onchange={(e) => patchGrid({ size: number(e, grid?.size ?? 100, 10, 1000) })} />
        </label>
        <label>
          Hex layout
          <select data-scene-grid-layout value={grid.hexLayout} disabled={grid.type !== "hex"}
            onchange={(e) => patchGrid({ hexLayout: (e.target as HTMLSelectElement).value as SceneGrid["hexLayout"] })}>
            {#each ["evenQ", "oddQ", "evenR", "oddR"] as l (l)}<option value={l}>{l}</option>{/each}
          </select>
        </label>
      </div>
      <div class="row">
        <label>
          Line colour
          <input data-scene-grid-color type="color" value={gridColor} onchange={(e) => patchGrid({ color: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="slider grow">
          Line opacity <span class="value">{Math.round(gridAlpha * 100)}%</span>
          <input data-scene-grid-alpha type="range" min="0" max="1" step="0.05" value={gridAlpha}
            onchange={(e) => patchGrid({ alpha: number(e, DEFAULT_GRID_STYLE.alpha, 0, 1) })} />
        </label>
        <button type="button" class="link" data-scene-grid-style-reset
          disabled={grid.color === undefined && grid.alpha === undefined}
          onclick={() => { if (!grid) return; const rest: SceneGrid = { ...grid }; delete rest.color; delete rest.alpha; submit({ grid: rest }); }}>Default look</button>
      </div>
      <div class="row">
        <label>
          Distance per cell
          <input data-scene-grid-distance type="number" min="0.01" step="any" value={grid.distance}
            onchange={(e) => patchGrid({ distance: number(e, grid?.distance ?? 5, 0.01, 100000) })} />
        </label>
        <label>
          Units
          <input data-scene-grid-units type="text" value={grid.units} onchange={(e) => patchGrid({ units: (e.target as HTMLInputElement).value.slice(0, 32) })} />
        </label>
        <label>
          Diagonals
          <select data-scene-grid-diagonals value={grid.diagonals} onchange={(e) => patchGrid({ diagonals: (e.target as HTMLSelectElement).value as SceneGrid["diagonals"] })}>
            {#each ["555", "5105", "euclidean"] as d (d)}<option value={d}>{d}</option>{/each}
          </select>
        </label>
      </div>
    </section>

    <section data-scene-fit-section>
      <h4>Fit the map by its grid</h4>
      {#if !scene.img}
        <p class="hint">This scene has no background image. Add one from Scenes &amp; images, then come back to fit it.</p>
      {:else if !natural}
        <p class="hint">{isActive ? "Waiting for the background to load…" : "Activate this scene to fit its background."}</p>
      {:else if grid.type === "gridless"}
        <p class="hint">Pick a square or hex grid above to fit the map to it.</p>
      {:else}
        <p class="hint">
          Count the {grid.type === "hex" ? "hexes" : "squares"} on the map itself (e.g. 48 × 64). The map is then scaled so one map
          {grid.type === "hex" ? "hex" : "square"} is one grid cell of {grid.size} px, and the scene is sized to exactly that many cells —
          no guessing from line detection.
        </p>
        <div class="row">
          <label>
            {grid.type === "hex" ? "Hexes across" : "Squares across"}
            <input data-scene-count-columns type="number" min="1" max={MAX_GRID_COUNT} step="1" value={count.columns}
              oninput={(e) => (countDraft = { ...count, columns: number(e, count.columns, 1, MAX_GRID_COUNT) })} />
          </label>
          <label>
            {grid.type === "hex" ? "Hexes down" : "Squares down"}
            <input data-scene-count-rows type="number" min="1" max={MAX_GRID_COUNT} step="1" value={count.rows}
              oninput={(e) => (countDraft = { ...count, rows: number(e, count.rows, 1, MAX_GRID_COUNT) })} />
          </label>
          {#if mapGrid && !countDraft}
            <p class="readout" data-scene-count-source>from the measured map grid ({fmt(mapGrid.sizeX)} px squares)</p>
          {:else}
            <p class="readout" data-scene-count-source>image {natural.width} × {natural.height} px</p>
          {/if}
        </div>
        {#if fitPreview}
          <p class="readout" data-scene-fit-preview>
            One map {grid.type === "hex" ? "hex" : "square"} = {fmt(fitPreview.cell.width)} × {fmt(fitPreview.cell.height)} px →
            scene {fitPreview.width} × {fitPreview.height} px, map scale {Math.round(fitPreview.transform.scaleX * 100)}%.
          </p>
          {#if fitPreview.warning}<p class="warn" data-scene-fit-warning>{fitPreview.warning}</p>{/if}
        {/if}
        <div class="row">
          <button type="button" class="primary" data-scene-fit-count disabled={!fitPreview} onclick={applyCountFit}>
            Fit scene to {count.columns} × {count.rows} {grid.type === "hex" ? "hexes" : "squares"}
          </button>
          {#if onOpenBackground}
            <button type="button" class="link" data-scene-open-background onclick={() => onOpenBackground?.()}>Measure the map's squares instead…</button>
          {/if}
        </div>
        {#if fitNotice}<p class="ok" data-scene-fit-notice aria-live="polite">{fitNotice}</p>{/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .scene-settings { display: flex; flex-direction: column; gap: 14px; padding: 10px 12px 16px; color: #dbe3f0; font-size: 12px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  h4 { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #93a4b8; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #aebbcc; }
  label.grow, .slider.grow { flex: 1 1 160px; }
  .slider { min-width: 150px; }
  .slider .value { color: #e6eef9; font-weight: 600; margin-left: 4px; }
  input[type="text"], input[type="number"], select { padding: 4px 6px; color: #fff; background: #0c111b; border: 1px solid #3a455e; border-radius: 4px; font: inherit; min-width: 80px; }
  input[type="number"] { width: 92px; }
  input[type="color"] { width: 44px; height: 28px; padding: 0 2px; background: #0c111b; border: 1px solid #3a455e; border-radius: 4px; }
  input[type="range"] { width: 100%; }
  button { padding: 5px 10px; color: #e6eef9; background: #243244; border: 1px solid #3c4d63; border-radius: 5px; font: inherit; cursor: pointer; }
  button.primary { background: #2f6fdc; border-color: #4a86ea; }
  button.link { background: transparent; border-color: transparent; color: #8fb8ff; text-decoration: underline; padding-inline: 4px; }
  button:disabled { opacity: 0.55; cursor: default; }
  .readout { margin: 0; color: #c7d3e2; align-self: center; }
  .hint { margin: 0; color: #9fb0c3; line-height: 1.4; }
  .warn { margin: 0; color: #ffcf7a; }
  .ok { margin: 0; color: #9fe3b5; }
  .empty { margin: 0; padding: 12px; color: #9fb0c3; }
</style>
