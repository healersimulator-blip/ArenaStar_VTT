<script lang="ts">
  /**
   * Map & background editor (GM, Map & background layer). Every control writes one scene update;
   * numeric fields commit on change, so typing a value is one undo step, not one per keystroke.
   */
  import {
    backgroundRect,
    gridAlignmentError,
    type BackgroundSnap,
    type BackgroundTransform,
    type MapGridEstimate,
    type NaturalSize,
  } from "../../core/backgroundTransform";
  import type { BackgroundDetectionView } from "./backgroundPanelTypes";


  let {
    natural,
    transform,
    gridSize,
    locked,
    keepAspect,
    snap,
    mapGrid,
    detection,
    onTransform,
    onPlace,
    onSnap,
    onKeepAspect,
    onLock,
    onDetect,
    onAlignToGrid,
    onUseSquaresAsGrid,
    onForgetMapGrid,
    onClose,
  }: {
    natural: NaturalSize | null;
    transform: BackgroundTransform;
    /** Scene grid size, or null when the scene has no square grid. */
    gridSize: number | null;
    locked: boolean;
    keepAspect: boolean;
    snap: BackgroundSnap;
    /** The map grid measured for the current image, or null. */
    mapGrid: MapGridEstimate | null;
    detection: BackgroundDetectionView;
    onTransform: (next: BackgroundTransform) => void;
    onPlace: (mode: "fit" | "cover" | "native" | "center") => void;
    onSnap: (next: BackgroundSnap) => void;
    onKeepAspect: (next: boolean) => void;
    onLock: (next: boolean) => void;
    onDetect: () => void;
    onAlignToGrid: () => void;
    onUseSquaresAsGrid: () => void;
    onForgetMapGrid: () => void;
    onClose: () => void;
  } = $props();

  const drawn = $derived(natural ? backgroundRect(natural, transform) : null);
  const scalePct = $derived(natural ? Math.round(transform.scaleX * 10000) / 100 : 100);
  const scalePctY = $derived(natural ? Math.round(transform.scaleY * 10000) / 100 : 100);
  const alignment = $derived(
    natural && mapGrid && gridSize ? gridAlignmentError(transform, mapGrid, gridSize) : null,
  );
  const aligned = $derived(alignment !== null && alignment.phasePx < 0.5 && alignment.pitchPx < 0.05);

  function num(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function setPosition(axis: "x" | "y", value: string): void {
    onTransform({ ...transform, [axis]: num(value, transform[axis]) });
  }

  /** Width/height are drawn scene pixels; with the lock on, the other axis keeps its ratio. */
  function setDrawnSize(axis: "w" | "h", value: string): void {
    if (!natural) return;
    const size = num(value, 0);
    if (!(size > 0)) return;
    const nextX = axis === "w" ? size / natural.width : transform.scaleX;
    const nextY = axis === "h" ? size / natural.height : transform.scaleY;
    if (keepAspect) {
      const ratio = transform.scaleY / transform.scaleX;
      if (axis === "w") onTransform({ ...transform, scaleX: nextX, scaleY: nextX * ratio });
      else onTransform({ ...transform, scaleX: nextY / ratio, scaleY: nextY });
      return;
    }
    onTransform({ ...transform, scaleX: nextX, scaleY: nextY });
  }

  /** Scale percentages are relative to the native size, so 100 means 1 image px = 1 scene px. */
  function setScalePct(axis: "x" | "y", value: string): void {
    const pct = num(value, 0);
    if (!(pct > 0)) return;
    const factor = pct / 100;
    if (keepAspect) {
      const ratio = transform.scaleY / transform.scaleX;
      if (axis === "x") onTransform({ ...transform, scaleX: factor, scaleY: factor * ratio });
      else onTransform({ ...transform, scaleX: factor / ratio, scaleY: factor });
      return;
    }
    onTransform(axis === "x" ? { ...transform, scaleX: factor } : { ...transform, scaleY: factor });
  }

  function fmt(value: number): string {
    return String(Math.round(value * 100) / 100);
  }
</script>

<section class="bg-panel" aria-label="Map and background" data-background-panel>
  <header>
    <strong>Map &amp; background</strong>
    <button type="button" class="close" aria-label="Close map panel" onclick={onClose}>×</button>
  </header>

  {#if !natural}
    <p class="muted">This scene has no background image. Use the image import to add one.</p>
  {:else}
    <div class="grid">
      <label>X <input type="number" step="1" value={fmt(transform.x)} disabled={locked}
        data-bg-field="x" onchange={(e) => setPosition("x", e.currentTarget.value)} /></label>
      <label>Y <input type="number" step="1" value={fmt(transform.y)} disabled={locked}
        data-bg-field="y" onchange={(e) => setPosition("y", e.currentTarget.value)} /></label>
      <label>W <input type="number" step="1" min="1" value={fmt(drawn?.width ?? 0)} disabled={locked}
        data-bg-field="w" onchange={(e) => setDrawnSize("w", e.currentTarget.value)} /></label>
      <label>H <input type="number" step="1" min="1" value={fmt(drawn?.height ?? 0)} disabled={locked}
        data-bg-field="h" onchange={(e) => setDrawnSize("h", e.currentTarget.value)} /></label>
      <label>Scale X % <input type="number" step="0.1" min="0.01" value={fmt(scalePct)} disabled={locked}
        data-bg-field="scale-x" onchange={(e) => setScalePct("x", e.currentTarget.value)} /></label>
      <label>Scale Y % <input type="number" step="0.1" min="0.01" value={fmt(scalePctY)} disabled={locked}
        data-bg-field="scale-y" onchange={(e) => setScalePct("y", e.currentTarget.value)} /></label>
    </div>

    <div class="row">
      <label class="check"><input type="checkbox" checked={keepAspect} disabled={locked}
        onchange={(e) => onKeepAspect(e.currentTarget.checked)} /> Keep aspect</label>
      <label class="check"><input type="checkbox" checked={locked}
        onchange={(e) => onLock(e.currentTarget.checked)} data-bg-lock /> Lock background</label>
    </div>

    <div class="row buttons">
      <button type="button" disabled={locked} onclick={() => onPlace("fit")}>Fit scene</button>
      <button type="button" disabled={locked} onclick={() => onPlace("cover")}>Cover scene</button>
      <button type="button" disabled={locked} onclick={() => onPlace("native")}>1:1 at origin</button>
      <button type="button" disabled={locked} onclick={() => onPlace("center")}>Centre</button>
    </div>

    <div class="row">
      <label>Snap
        <select value={snap} disabled={locked} data-bg-snap
          onchange={(e) => onSnap(e.currentTarget.value as BackgroundSnap)}>
          <option value="off">Off</option>
          <option value="grid" disabled={!gridSize}>Grid intersections</option>
          <option value="map" disabled={!mapGrid || !gridSize}>Map grid lines</option>
        </select>
      </label>
    </div>

    <div class="grid-section">
      <strong>Grid</strong>
      <div class="row buttons">
        <button type="button" disabled={locked || detection.status === "running"} onclick={onDetect}
          data-bg-detect>{detection.status === "running" ? "Detecting…" : "Detect map grid"}</button>
        {#if mapGrid}
          <button type="button" onclick={onForgetMapGrid} disabled={locked}>Forget map grid</button>
        {/if}
      </div>

      {#if detection.status === "found"}
        <p class="ok">Grid found, confidence {Math.round(detection.confidence * 100)}%.</p>
      {:else if detection.status === "none" || detection.status === "error"}
        <p class="warn" data-bg-detect-message>{detection.message}</p>
      {/if}

      {#if mapGrid}
        <p class="muted" data-bg-map-grid>
          Map squares: {fmt(mapGrid.sizeX)} × {fmt(mapGrid.sizeY)} px (native).
        </p>
        {#if alignment}
          <p class={aligned ? "ok" : "warn"} data-bg-alignment>
            {aligned ? "Map lines sit on the grid." : `Lines are ${fmt(alignment.phasePx)} px off the grid; each square is ${fmt(alignment.pitchPx)} px off.`}
          </p>
        {:else if !gridSize}
          <p class="muted">Set a square grid in Scene settings to align the map to it.</p>
        {/if}
        <div class="row buttons">
          <button type="button" disabled={locked || !gridSize} onclick={onAlignToGrid}
            data-bg-align>Match map to grid</button>
          <button type="button" disabled={locked || !gridSize} onclick={onUseSquaresAsGrid}
            data-bg-squares>Use map squares as grid</button>
        </div>
      {/if}
    </div>

    <p class="hint">
      Drag the frame to move it; drag a handle to resize (corners keep aspect unless Keep aspect is off;
      hold Shift to invert). Arrows nudge 1 px, Shift 10 px, Ctrl/⌘ one grid square.
    </p>
  {/if}
</section>

<style>
  .bg-panel {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    width: 260px;
    max-height: calc(100% - 16px);
    overflow: auto;
    padding: 10px;
    border-radius: 8px;
    background: rgba(18, 24, 33, 0.94);
    border: 1px solid #2c3a4d;
    color: #e6edf5;
    font-size: 12px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .close { background: none; border: none; color: inherit; font-size: 16px; cursor: pointer; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
  label { display: flex; flex-direction: column; gap: 2px; }
  label.check { flex-direction: row; align-items: center; gap: 4px; }
  input[type="number"], select {
    background: #0c1119; color: inherit; border: 1px solid #2c3a4d; border-radius: 4px; padding: 3px 4px;
    width: 100%; box-sizing: border-box;
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .buttons button {
    background: #1d2a3b; color: inherit; border: 1px solid #2c3a4d; border-radius: 4px; padding: 3px 6px;
    cursor: pointer;
  }
  .buttons button:disabled, input:disabled, select:disabled { opacity: 0.45; cursor: default; }
  .grid-section { margin-top: 10px; border-top: 1px solid #2c3a4d; padding-top: 8px; }
  .muted { opacity: 0.7; margin: 4px 0; }
  .ok { color: #7fd6a0; margin: 4px 0; }
  .warn { color: #f0b86b; margin: 4px 0; }
  .hint { opacity: 0.6; font-size: 11px; margin-top: 10px; }
</style>
