<script lang="ts">
  /**
   * Map & background editor (GM, Map & background layer). Every control writes one scene update;
   * numeric fields commit on change (Enter or Tab), so typing a value is one undo step, not one per key.
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
  const scalePct = $derived(natural ? round(transform.scaleX * 100) : 100);
  const scalePctY = $derived(natural ? round(transform.scaleY * 100) : 100);
  const alignment = $derived(
    natural && mapGrid && gridSize ? gridAlignmentError(transform, mapGrid, gridSize) : null,
  );
  const aligned = $derived(alignment !== null && alignment.phasePx < 0.5 && alignment.pitchPx < 0.05);
  /** Square size as drawn on the scene, so the GM compares like with like. */
  const drawnSquare = $derived(mapGrid ? round(mapGrid.sizeX * transform.scaleX) : null);
  const detecting = $derived(detection.status === "running");

  function num(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function round(value: number): number {
    return Math.round(value * 100) / 100;
  }
  function fmt(value: number): string {
    return String(round(value));
  }
  /** Enter commits a numeric field the same way Tab does. */
  function commitOnEnter(e: KeyboardEvent): void {
    if (e.key === "Enter") (e.currentTarget as HTMLElement).blur();
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
  function setScalePct(axis: "x" | "y" | "both", value: string): void {
    const pct = num(value, 0);
    if (!(pct > 0)) return;
    const factor = pct / 100;
    if (axis === "both") {
      const ratio = transform.scaleY / transform.scaleX;
      onTransform({ ...transform, scaleX: factor, scaleY: factor * ratio });
      return;
    }
    onTransform(axis === "x" ? { ...transform, scaleX: factor } : { ...transform, scaleY: factor });
  }

  const presets: Array<{ mode: "fit" | "cover" | "native" | "center"; label: string; title: string }> = [
    { mode: "fit", label: "Fit", title: "Fit the whole image inside the scene" },
    { mode: "cover", label: "Cover", title: "Cover the scene; edges may be cropped" },
    { mode: "native", label: "1:1", title: "Native pixel size, top-left at the origin" },
    { mode: "center", label: "Centre", title: "Centre the image on the scene" },
  ];
</script>

<section class="bg-panel" aria-label="Map and background" data-background-panel>
  <header class="head">
    <div class="title">
      <h2>Map &amp; background</h2>
      {#if natural}
        <p class="sub">{natural.width} × {natural.height} px image</p>
      {/if}
    </div>
    <button type="button" class="icon" aria-label="Close map panel" title="Close" onclick={onClose}>×</button>
  </header>

  {#if !natural}
    <p class="empty">This scene has no background image. Use the image import to add one.</p>
  {:else}
    {#if locked}
      <div class="notice" role="status">
        <span>Locked. Moving, resizing and fields are off.</span>
      </div>
    {/if}

    <details class="section" open>
      <summary>Placement</summary>

      <div class="fields">
        <label class="field">
          <span>X</span>
          <span class="input"><input type="number" step="1" value={fmt(transform.x)} disabled={locked}
            data-bg-field="x" onkeydown={commitOnEnter}
            onchange={(e) => setPosition("x", e.currentTarget.value)} /><em>px</em></span>
        </label>
        <label class="field">
          <span>Y</span>
          <span class="input"><input type="number" step="1" value={fmt(transform.y)} disabled={locked}
            data-bg-field="y" onkeydown={commitOnEnter}
            onchange={(e) => setPosition("y", e.currentTarget.value)} /><em>px</em></span>
        </label>
        <label class="field">
          <span>Width</span>
          <span class="input"><input type="number" step="1" min="1" value={fmt(drawn?.width ?? 0)} disabled={locked}
            data-bg-field="w" onkeydown={commitOnEnter}
            onchange={(e) => setDrawnSize("w", e.currentTarget.value)} /><em>px</em></span>
        </label>
        <label class="field">
          <span>Height</span>
          <span class="input"><input type="number" step="1" min="1" value={fmt(drawn?.height ?? 0)} disabled={locked}
            data-bg-field="h" onkeydown={commitOnEnter}
            onchange={(e) => setDrawnSize("h", e.currentTarget.value)} /><em>px</em></span>
        </label>
      </div>

      {#if keepAspect}
        <div class="fields single">
          <label class="field">
            <span>Scale</span>
            <span class="input"><input type="number" step="0.1" min="0.01" value={fmt(scalePct)} disabled={locked}
              data-bg-field="scale-x" onkeydown={commitOnEnter}
              onchange={(e) => setScalePct("both", e.currentTarget.value)} /><em>%</em></span>
          </label>
        </div>
      {:else}
        <div class="fields">
          <label class="field">
            <span>Scale X</span>
            <span class="input"><input type="number" step="0.1" min="0.01" value={fmt(scalePct)} disabled={locked}
              data-bg-field="scale-x" onkeydown={commitOnEnter}
              onchange={(e) => setScalePct("x", e.currentTarget.value)} /><em>%</em></span>
          </label>
          <label class="field">
            <span>Scale Y</span>
            <span class="input"><input type="number" step="0.1" min="0.01" value={fmt(scalePctY)} disabled={locked}
              data-bg-field="scale-y" onkeydown={commitOnEnter}
              onchange={(e) => setScalePct("y", e.currentTarget.value)} /><em>%</em></span>
          </label>
        </div>
      {/if}

      <div class="segmented" role="group" aria-label="Place image">
        {#each presets as preset (preset.mode)}
          <button type="button" disabled={locked} title={preset.title} aria-label={preset.title}
            onclick={() => onPlace(preset.mode)}>{preset.label}</button>
        {/each}
      </div>

      <div class="toggles">
        <label class="toggle">
          <input type="checkbox" checked={keepAspect} disabled={locked}
            onchange={(e) => onKeepAspect(e.currentTarget.checked)} />
          <span>Keep aspect</span>
        </label>
        <label class="toggle">
          <input type="checkbox" checked={locked} data-bg-lock
            onchange={(e) => onLock(e.currentTarget.checked)} />
          <span>Lock background</span>
        </label>
      </div>
    </details>

    <details class="section" open>
      <summary>Grid alignment</summary>

      {#if detecting}
        <div class="card neutral" aria-live="polite">
          <span class="pulse" aria-hidden="true"></span>
          <p>Measuring the map's squares…</p>
        </div>
      {:else if !mapGrid}
        {#if detection.status === "none" || detection.status === "error"}
          <div class="card warn">
            <p class="card-title">No square grid found</p>
            <p class="card-body" data-bg-detect-message>{detection.message}</p>
            <p class="card-body">You can still line the map up by hand with the fields or by dragging.</p>
          </div>
        {:else}
          <div class="card neutral">
            <p class="card-body">
              Find the map's square grid, then line it up with the scene grid so the squares match.
            </p>
          </div>
        {/if}
        <button type="button" class="primary wide" disabled={locked} onclick={onDetect} data-bg-detect>
          {detection.status === "none" || detection.status === "error" ? "Try again" : "Detect map grid"}
        </button>
      {:else}
        <div class="measured">
          <p data-bg-map-grid>Map squares: {fmt(mapGrid.sizeX)} × {fmt(mapGrid.sizeY)} px (native).</p>
          <div class="measured-actions">
            <button type="button" class="link" disabled={locked || detecting} onclick={onDetect} data-bg-detect>Detect again</button>
            <button type="button" class="link" disabled={locked} onclick={onForgetMapGrid}>Forget</button>
          </div>
        </div>

        {#if !gridSize}
          <div class="card warn">
            <p class="card-body">This scene has no square grid. Turn one on in Scene settings to line the map up with it.</p>
          </div>
        {:else if aligned}
          <div class="card ok">
            <p class="card-title" data-bg-alignment>Map lines sit on the grid.</p>
            <p class="card-body">Each map square draws at {drawnSquare} px, the same as the grid.</p>
          </div>
        {:else if alignment}
          <div class="card warn">
            <p class="card-title" data-bg-alignment>Map lines are off the grid.</p>
            <p class="card-body">
              Map squares draw at {drawnSquare} px; grid squares are {fmt(gridSize)} px.
              Lines are {fmt(alignment.phasePx)} px out of place.
            </p>
          </div>
          <div class="choices">
            <button type="button" class="primary wide" disabled={locked} onclick={onAlignToGrid} data-bg-align>
              Match map to grid
            </button>
            <p class="choice-hint">Scales the map so its squares fit the grid. The grid stays the same.</p>
            <button type="button" class="secondary wide" disabled={locked} onclick={onUseSquaresAsGrid} data-bg-squares>
              Use map squares as grid
            </button>
            <p class="choice-hint">Sets the scene grid to {fmt(mapGrid.sizeX)} px. The map stays the same.</p>
          </div>
        {/if}
      {/if}

      <div class="snap">
        <span class="snap-label" id="bg-snap-label">Snap while moving</span>
        <div class="segmented" role="group" aria-labelledby="bg-snap-label" data-bg-snap-group>
          <button type="button" aria-pressed={snap === "off"} disabled={locked}
            onclick={() => onSnap("off")}>Off</button>
          <button type="button" aria-pressed={snap === "grid"} disabled={locked || !gridSize}
            title="Snap the image corner to grid intersections" onclick={() => onSnap("grid")}>Grid</button>
          <button type="button" aria-pressed={snap === "map"} disabled={locked || !mapGrid || !gridSize}
            title="Snap the image to the map's own grid lines" onclick={() => onSnap("map")}>Map lines</button>
        </div>
      </div>
    </details>

    <details class="section shortcuts">
      <summary>Shortcuts</summary>
      <ul>
        <li><span>Move</span> drag inside the frame</li>
        <li><span>Resize</span> drag a handle</li>
        <li><span>Free resize</span> hold Shift while dragging a corner</li>
        <li><span>Nudge</span> <kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> 1 px, <kbd>Shift</kbd> 10 px</li>
        <li><span>Grid step</span> <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + arrows: one grid square</li>
      </ul>
    </details>
  {/if}
</section>

<style>
  .bg-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 20;
    width: 300px;
    max-height: calc(100% - 24px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--vtt-panel) 96%, transparent);
    border: 1px solid var(--vtt-border);
    color: var(--vtt-text);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(10px);
    font-size: 0.9375rem;
    scrollbar-width: thin;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  .title h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 650;
    letter-spacing: 0.01em;
  }
  .sub {
    margin: 2px 0 0;
    color: var(--vtt-muted);
    font-size: 0.8125rem;
  }
  .icon {
    flex: 0 0 auto;
    width: 2.25rem;
    min-width: 2.25rem;
    min-height: 2.25rem !important;
    padding: 0;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--vtt-muted);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
  }
  .icon:hover { background: var(--vtt-panel-raised); color: var(--vtt-text); }

  .empty { color: var(--vtt-muted); margin: 6px 0; }

  .notice {
    margin: 6px 0 4px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(255, 218, 140, 0.1);
    border: 1px solid rgba(255, 218, 140, 0.35);
    color: var(--vtt-focus);
    font-size: 0.875rem;
  }

  details.section {
    border-top: 1px solid var(--vtt-border);
    padding: 10px 0 12px;
  }
  details.section > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 2rem;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vtt-muted);
    border-radius: 6px;
  }
  details.section > summary::-webkit-details-marker { display: none; }
  details.section > summary::after {
    content: "";
    width: 0.5rem;
    height: 0.5rem;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(45deg) translateY(-2px);
    transition: transform 0.15s ease;
  }
  details.section[open] > summary::after { transform: rotate(225deg) translateY(-2px); }

  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .fields.single { grid-template-columns: 1fr; }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .field > span:first-child {
    color: var(--vtt-muted);
    font-size: 0.8125rem;
  }
  .input {
    position: relative;
    display: flex;
    align-items: center;
  }
  .input input {
    width: 100%;
    padding: 0.35rem 2.25rem 0.35rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--vtt-border);
    background: var(--vtt-bg);
    color: var(--vtt-text);
    font-variant-numeric: tabular-nums;
  }
  .input input:hover:not(:disabled) { border-color: var(--vtt-border-strong); }
  .input em {
    position: absolute;
    right: 0.6rem;
    font-style: normal;
    font-size: 0.8125rem;
    color: var(--vtt-muted);
    pointer-events: none;
  }
  input:disabled { opacity: 0.5; cursor: not-allowed; }

  .segmented {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 2px;
    margin-top: 10px;
    padding: 3px;
    border-radius: 10px;
    background: var(--vtt-bg);
    border: 1px solid var(--vtt-border);
  }
  .segmented button {
    padding: 0.3rem 0.25rem;
    white-space: nowrap;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--vtt-muted);
    font-size: 0.875rem;
    cursor: pointer;
    min-height: 2rem !important;
  }
  .segmented button:hover:not(:disabled) { color: var(--vtt-text); }
  .segmented button[aria-pressed="true"] {
    background: var(--vtt-panel-raised);
    color: var(--vtt-accent);
    box-shadow: inset 0 -2px 0 var(--vtt-accent);
  }
  .segmented button:disabled { opacity: 0.45; cursor: not-allowed; }

  .toggles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 2rem;
    cursor: pointer;
    font-size: 0.9375rem;
  }
  .toggle input { width: 1.05rem; height: 1.05rem; margin: 0; }
  .toggle:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }

  .card {
    margin-top: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--vtt-border);
    background: var(--vtt-panel-raised);
    font-size: 0.875rem;
  }
  .card p { margin: 0; }
  .card-title { font-weight: 650; font-size: 0.9375rem; margin-bottom: 3px !important; }
  .card-body { color: var(--vtt-muted); line-height: 1.4; }
  .card.ok {
    background: rgba(115, 216, 197, 0.1);
    border-color: rgba(115, 216, 197, 0.4);
  }
  .card.ok .card-title { color: var(--vtt-accent); }
  .card.warn {
    background: rgba(240, 184, 107, 0.09);
    border-color: rgba(240, 184, 107, 0.4);
  }
  .card.warn .card-title { color: #f5c17f; }
  .card.neutral { display: flex; align-items: center; gap: 10px; }
  .card.neutral p { color: var(--vtt-muted); }

  .pulse {
    flex: 0 0 auto;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: var(--vtt-accent);
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.25; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.1); }
  }

  .measured {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 8px;
    color: var(--vtt-muted);
    font-size: 0.875rem;
  }
  .measured p { margin: 0; }
  .measured-actions { display: flex; gap: 14px; }

  button.link {
    padding: 0.2rem 0;
    min-height: 1.75rem !important;
    border: 0;
    background: none;
    color: var(--vtt-accent);
    font-size: 0.875rem;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  button.link:disabled { opacity: 0.45; cursor: not-allowed; }

  .wide { width: 100%; margin-top: 8px; }
  button.primary,
  button.secondary {
    padding: 0.4rem 0.75rem;
    border-radius: 9px;
    font-weight: 600;
    cursor: pointer;
  }
  button.primary {
    border: 1px solid var(--vtt-accent);
    background: var(--vtt-accent);
    color: #04201a;
  }
  button.primary:hover:not(:disabled) { filter: brightness(1.07); }
  button.secondary {
    border: 1px solid var(--vtt-border-strong);
    background: transparent;
    color: var(--vtt-text);
  }
  button.secondary:hover:not(:disabled) { background: var(--vtt-panel-raised); }
  button.primary:disabled,
  button.secondary:disabled { opacity: 0.45; cursor: not-allowed; }

  .choices { display: flex; flex-direction: column; }
  .choice-hint {
    margin: 4px 2px 6px;
    color: var(--vtt-muted);
    font-size: 0.8125rem;
    line-height: 1.35;
  }

  .snap { margin-top: 12px; }
  .snap-label {
    display: block;
    margin-bottom: 2px;
    color: var(--vtt-muted);
    font-size: 0.8125rem;
  }
  .snap .segmented { margin-top: 6px; }

  .shortcuts ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--vtt-muted);
    font-size: 0.8125rem;
  }
  .shortcuts li span {
    display: inline-block;
    min-width: 6.5rem;
    color: var(--vtt-text);
  }
  kbd {
    display: inline-block;
    min-width: 1.4rem;
    padding: 0 0.3rem;
    border-radius: 5px;
    border: 1px solid var(--vtt-border-strong);
    border-bottom-width: 2px;
    background: var(--vtt-bg);
    color: var(--vtt-text);
    font: inherit;
    font-size: 0.75rem;
    text-align: center;
  }
</style>
