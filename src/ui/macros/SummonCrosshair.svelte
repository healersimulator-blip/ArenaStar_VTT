<script lang="ts">
  import { screenToWorld, worldToScreen, type Camera } from "../../canvas/camera";
  import type { SceneDocument } from "../../core/documents";
  import { summonPlacementError } from "../../core/summons";
  import type { SummonPickOptions, SummonPickPoint } from "./summonPicker";

  let { scene, options, camera, pick, cancel }: {
    scene: SceneDocument;
    options: SummonPickOptions;
    camera: () => Camera;
    pick: (at: SummonPickPoint) => void;
    cancel: () => void;
  } = $props();
  let overlay: HTMLDivElement;
  let point = $state<SummonPickPoint | null>(null);
  let snap = $state(true);
  const caster = $derived(scene.tokens.find((t) => t._id === options.summonerTokenId));
  const error = $derived(point ? summonPlacementError(scene, { sceneId: options.sceneId,
    maxDistance: options.maxDistance, size: options.size,
    requireLoS: options.requireLoS }, point, caster, !options.gmManual) : null);
  const diameter = $derived((options.size ?? 1) * scene.grid.size * camera().scale);
  const preview = $derived(point ? worldToScreen(camera(), point.x, point.y) : null);
  const radius = $derived(caster ? options.maxDistance * scene.grid.size / scene.grid.distance * camera().scale : 0);
  const center = $derived(caster ? worldToScreen(camera(), caster.x, caster.y) : null);
  $effect(() => { if (overlay) queueMicrotask(() => overlay?.focus()); });

  function move(ev: PointerEvent): void {
    if (!overlay || (ev.target instanceof Element && ev.target.closest(".controls"))) return;
    const rect = overlay.getBoundingClientRect();
    const world = screenToWorld(camera(), ev.clientX - rect.left, ev.clientY - rect.top);
    const cell = scene.grid.size;
    const gridSnap = snap && scene.grid.type === "square" && Number.isFinite(cell) && cell > 0;
    point = gridSnap ? { x: Math.round((world.x - cell / 2) / cell) * cell + cell / 2,
      y: Math.round((world.y - cell / 2) / cell) * cell + cell / 2 } : world;
  }
  function choose(ev: MouseEvent): void {
    if (ev.target instanceof Element && ev.target.closest(".controls")) return;
    ev.preventDefault(); ev.stopPropagation();
    if (point && !error) pick(point);
  }
</script>

<div class="summon-crosshair" data-summon-crosshair role="dialog" aria-modal="true"
  aria-label="Choose a summon point" tabindex="0" bind:this={overlay}
  onpointermove={move} onclick={choose}
  onkeydown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); cancel(); }
    if (ev.key === "Enter" && point && !error) { ev.preventDefault(); pick(point); } }}>
  {#if center && !options.gmManual}
    <div class="range" style={`left:${center.x}px;top:${center.y}px;width:${radius * 2}px;height:${radius * 2}px;`}></div>
  {/if}
  {#if preview}
    <div class:invalid={!!error} class="footprint" style={`left:${preview.x}px;top:${preview.y}px;width:${diameter}px;height:${diameter}px;`}></div>
    <div class="at" style={`left:${preview.x}px;top:${preview.y + diameter / 2 + 8}px;`}>
      {Math.round(point?.x ?? 0)}, {Math.round(point?.y ?? 0)} · {error ?? "Click to summon"}
    </div>
  {/if}
  <div class="controls" role="group" aria-label="Summon placement controls">
    <strong>Choose a summon point</strong>
    <label><input type="checkbox" bind:checked={snap} /> Snap square grid</label>
    <small>Footprint {(options.size ?? 1)} cells · range {options.maxDistance} {scene.grid.units} {options.requireLoS ? "· line of sight" : ""}</small>
    <button data-summon-cancel type="button" onclick={(ev) => { ev.stopPropagation(); cancel(); }}>Cancel · Esc</button>
  </div>
</div>

<style>
  .summon-crosshair { position: absolute; inset: 0; z-index: 1050; background: rgb(4 10 18 / 0.25); cursor: crosshair; outline: none; overflow: hidden; }
  .range { position: absolute; pointer-events: none; transform: translate(-50%, -50%); border: 1.5px dashed #b5d4ff; border-radius: 50%; background: rgb(130 180 255 / 0.06); }
  .footprint { position: absolute; pointer-events: none; transform: translate(-50%, -50%); border: 2px solid #81edb2; background: rgb(40 214 122 / 0.23); border-radius: 6px; box-shadow: 0 0 18px #30a569; }
  .footprint.invalid { border-color: #fb7575; background: rgb(231 63 63 / 0.3); box-shadow: 0 0 15px #a23232; }
  .at { position: absolute; pointer-events: none; transform: translateX(-50%); white-space: nowrap; background: #151d29e8; border: 1px solid #8291ac; padding: 3px 7px; border-radius: 4px; color: #f6f6f6; }
  .controls { position: absolute; top: 14px; right: 14px; display: grid; gap: 5px; max-width: 320px; padding: 12px; color: #fff; background: #141b29ed; border: 1px solid #67789a; border-radius: 8px; cursor: auto; }
  .controls label { display: flex; gap: 6px; align-items: center; }
  .controls small { color: #bbcbdd; }
</style>
