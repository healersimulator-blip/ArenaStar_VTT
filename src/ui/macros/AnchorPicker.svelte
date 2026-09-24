<script lang="ts">
  /**
   * Full-canvas point picker for FX anchors. It owns a *preview* only: the point
   * it returns is authored data, the host still validates the sequence's bounds
   * and media, and cancelling (Esc, Cancel, or a new gesture) leaves the wizard
   * draft untouched. Grid snap follows the token rule — cell/hex centres.
   */
  import { screenToWorld, worldToScreen, type Camera } from "../../canvas/camera";
  import type { SceneDocument } from "../../core/documents";
  import { anchorPickError, snapAnchorPoint, type AnchorPickOptions, type AnchorPickPoint } from "./anchorPicker";

  let { scene, options, camera, pick, cancel }: {
    scene: SceneDocument;
    options: AnchorPickOptions;
    camera: () => Camera;
    pick: (at: AnchorPickPoint) => void;
    cancel: () => void;
  } = $props();
  let overlay: HTMLDivElement;
  let point = $state<AnchorPickPoint | null>(null);
  let snap = $state(true);
  const error = $derived(point ? anchorPickError(point, options.bounds) : null);
  const preview = $derived(point ? worldToScreen(camera(), point.x, point.y) : null);
  $effect(() => { if (overlay) queueMicrotask(() => overlay?.focus()); });

  function move(ev: PointerEvent): void {
    if (!overlay || (ev.target instanceof Element && ev.target.closest(".controls"))) return;
    const rect = overlay.getBoundingClientRect();
    const world = screenToWorld(camera(), ev.clientX - rect.left, ev.clientY - rect.top);
    point = snapAnchorPoint(world, scene.grid, snap);
  }
  function choose(ev: MouseEvent): void {
    if (ev.target instanceof Element && ev.target.closest(".controls")) return;
    ev.preventDefault(); ev.stopPropagation();
    if (point && !error) pick(point);
  }
</script>

<div class="anchor-picker" data-fx-pick-overlay role="dialog" aria-modal="true"
  aria-label={`Pick ${options.label ?? "a point"} on the map`} tabindex="0" bind:this={overlay}
  onpointermove={move} onclick={choose}
  onkeydown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); cancel(); }
    if (ev.key === "Enter" && point && !error) { ev.preventDefault(); pick(point); } }}>
  {#if preview}
    <div class:invalid={!!error} class="marker" style={`left:${preview.x}px;top:${preview.y}px;`}></div>
    <div class="readout" data-fx-pick-readout style={`left:${preview.x}px;top:${preview.y + 20}px;`}>
      {Math.round(point?.x ?? 0)}, {Math.round(point?.y ?? 0)} · {error ?? "Click to place"}
    </div>
  {/if}
  <div class="controls" role="group" aria-label="Anchor picking controls">
    <strong>Pick {options.label ?? "a point"}</strong>
    <label><input type="checkbox" bind:checked={snap} data-fx-pick-snap /> Snap to cell centre</label>
    <small>Scene bounds {(options.bounds.width)}×{(options.bounds.height)} · the draft changes only on a click</small>
    <button data-fx-pick-cancel type="button" onclick={(ev) => { ev.stopPropagation(); cancel(); }}>Cancel · Esc</button>
  </div>
</div>

<style>
  .anchor-picker { position: absolute; inset: 0; z-index: 1050; background: rgb(4 10 18 / 0.25); cursor: crosshair; outline: none; overflow: hidden; }
  .marker { position: absolute; pointer-events: none; transform: translate(-50%, -50%); width: 22px; height: 22px; border: 2px solid #81edb2; border-radius: 50%; background: rgb(40 214 122 / 0.25); box-shadow: 0 0 18px #30a569; }
  .marker::after { content: ""; position: absolute; left: 50%; top: 50%; width: 2px; height: 2px; background: #eafff4; transform: translate(-50%, -50%); }
  .marker.invalid { border-color: #fb7575; background: rgb(231 63 63 / 0.3); box-shadow: 0 0 15px #a23232; }
  .readout { position: absolute; pointer-events: none; transform: translateX(-50%); white-space: nowrap; background: #151d29e8; border: 1px solid #8291ac; padding: 3px 7px; border-radius: 4px; color: #f6f6f6; }
  .controls { position: absolute; top: 14px; right: 14px; display: grid; gap: 5px; max-width: 320px; padding: 12px; color: #fff; background: #141b29ed; border: 1px solid #67789a; border-radius: 8px; cursor: auto; }
  .controls label { display: flex; gap: 6px; align-items: center; }
  .controls small { color: #bbcbdd; }
</style>
