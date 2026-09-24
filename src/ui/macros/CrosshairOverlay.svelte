<script lang="ts">
  /**
   * SQ-10 — the shared crosshair overlay. One instrument for the FX wizard's
   * anchors and the summon windows: pick a point, choose a shape, see the area
   * it covers, and see *why* a spot is refused. It owns a preview only — the
   * placement it returns is authored data, the host re-checks it, and cancelling
   * (Esc, Cancel, or a new gesture) leaves the caller's draft untouched.
   *
   * Live feedback is the shared `crosshairFaults`, the same rule the host
   * applies, so this component never disagrees with a save.
   */
  import { untrack } from "svelte";
  import { screenToWorld, worldToScreen, type Camera } from "../../canvas/camera";
  import {
    CROSSHAIR_ANGLE_STEP, crosshairArea, crosshairCommit, crosshairFaults, crosshairFaultMessage,
    crosshairPxPerUnit, crosshairSnapPoint, type CrosshairPlacement, type CrosshairPoint,
    type CrosshairRequest, type CrosshairShape, type CrosshairShapeKind,
  } from "../../core/crosshair";
  import { shapeWithExtent, type CrosshairPickOptions } from "./crosshairPicker";

  let { options, request, camera, pick, cancel }: {
    options: CrosshairPickOptions;
    request: CrosshairRequest;
    camera: () => Camera;
    pick: (placement: CrosshairPlacement) => void;
    cancel: () => void;
  } = $props();

  let overlay: HTMLDivElement;
  let point = $state<CrosshairPoint | null>(null);
  let snap = $state(true);
  // The starting shape is read once, deliberately: the request that opened this
  // overlay defines the gesture, and later re-renders must not reset the author's edits.
  let shape = $state<CrosshairShape>(untrack(() => options.shape ?? { kind: "point" }));
  let angleDeg = $state(untrack(() => options.shape?.angle ?? 0));
  let name = $state("");
  /** Set when the author is standing on a placement they already committed. */
  let reusing = $state<string | null>(null);
  const named = $derived(options.named ?? []);
  const shapes = $derived<CrosshairShapeKind[]>([...new Set<CrosshairShapeKind>(["point", ...(options.shapes ?? [])])]);
  const faults = $derived(point ? crosshairFaults(request, point, shape, angleDeg) : []);
  const message = $derived(crosshairFaultMessage(faults));
  const distance = $derived(point && request.origin
    ? Math.hypot(point.x - request.origin.x, point.y - request.origin.y) / crosshairPxPerUnit(request.grid)
    : null);
  const preview = $derived(point ? worldToScreen(camera(), point.x, point.y) : null);
  const outline = $derived(point
    ? crosshairArea(point, shape, request.grid, angleDeg).map((at) => worldToScreen(camera(), at.x, at.y))
    : []);
  const footprint = $derived(options.constraints?.footprint
    ? options.constraints.footprint * crosshairPxPerUnit(request.grid) * camera().scale : 22);
  const unit = $derived(request.grid.units ?? "units");
  const canCommit = $derived(point !== null && faults.length === 0);
  $effect(() => { if (overlay) queueMicrotask(() => overlay?.focus()); });

  function move(ev: PointerEvent): void {
    if (!overlay || (ev.target instanceof Element && ev.target.closest(".controls"))) return;
    const rect = overlay.getBoundingClientRect();
    const world = screenToWorld(camera(), ev.clientX - rect.left, ev.clientY - rect.top);
    point = crosshairSnapPoint(world, request.grid, snap);
    reusing = matchingName(point);
  }

  /** The placement this point already stands for, if any — so reuse is visible. */
  function matchingName(at: CrosshairPoint): string | null {
    const hit = named.find((entry) => Math.abs(entry.point.x - at.x) < 0.5 && Math.abs(entry.point.y - at.y) < 0.5);
    return hit?.name ?? null;
  }

  function choose(ev: MouseEvent): void {
    if (ev.target instanceof Element && ev.target.closest(".controls")) return;
    ev.preventDefault(); ev.stopPropagation();
    commit();
  }

  function commit(): void {
    if (!point) return;
    // Reusing a name keeps it: the author is deliberately re-using one spot, and
    // only that name is exempt from the uniqueness suffix.
    const taken = named.map((entry) => entry.name).filter((entry) => entry !== name);
    const committed = crosshairCommit({ request, point, shape, angleDeg, name, taken });
    if (committed.ok) pick(committed.placement);
  }

  function setShape(kind: CrosshairShapeKind): void {
    shape = shapeWithExtent(kind, shape);
  }

  function rotate(step: number): void {
    angleDeg = ((angleDeg + step) % 360 + 360) % 360;
  }

  function wheel(ev: WheelEvent): void {
    if (ev.target instanceof Element && ev.target.closest(".controls")) return;
    ev.preventDefault();
    rotate(ev.deltaY > 0 ? CROSSHAIR_ANGLE_STEP : -CROSSHAIR_ANGLE_STEP);
  }

  function reuse(entry: { name: string; point: CrosshairPoint }): void {
    point = { x: entry.point.x, y: entry.point.y };
    name = entry.name;
    reusing = entry.name;
  }
</script>

<div class="crosshair" data-crosshair data-crosshair-label={options.label ?? "a point"}
  role="dialog" aria-modal="true" aria-label={`Pick ${options.label ?? "a point"} on the map`}
  tabindex="0" bind:this={overlay} onpointermove={move} onclick={choose} onwheel={wheel}
  onkeydown={(ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); cancel(); }
    else if (ev.key === "Enter" && canCommit) { ev.preventDefault(); commit(); }
    else if (ev.key === "[" || ev.key === "ArrowLeft" && ev.shiftKey) { ev.preventDefault(); rotate(-CROSSHAIR_ANGLE_STEP); }
    else if (ev.key === "]" || ev.key === "ArrowRight" && ev.shiftKey) { ev.preventDefault(); rotate(CROSSHAIR_ANGLE_STEP); }
  }}>
  {#if outline.length > 1}
    <svg class="area" data-crosshair-area aria-hidden="true">
      <polygon class:invalid={faults.length > 0}
        points={outline.map((at) => `${at.x},${at.y}`).join(" ")} />
    </svg>
  {/if}
  {#if request.origin && (request.maxDistance !== undefined || request.minDistance !== undefined)}
    {@const center = worldToScreen(camera(), request.origin.x, request.origin.y)}
    {#if request.maxDistance !== undefined}
      <div class="range" data-crosshair-range style={`left:${center.x}px;top:${center.y}px;width:${request.maxDistance * crosshairPxPerUnit(request.grid) * camera().scale * 2}px;height:${request.maxDistance * crosshairPxPerUnit(request.grid) * camera().scale * 2}px;`}></div>
    {/if}
  {/if}
  {#if preview}
    <div class:invalid={faults.length > 0} class="footprint" data-crosshair-marker
      style={`left:${preview.x}px;top:${preview.y}px;width:${footprint}px;height:${footprint}px;`}></div>
    <div class="readout" data-crosshair-readout style={`left:${preview.x}px;top:${preview.y + footprint / 2 + 8}px;`}>
      {Math.round(point?.x ?? 0)}, {Math.round(point?.y ?? 0)}{distance !== null ? ` · ${distance.toFixed(1)} ${unit}` : ""} · {message ?? "Click to place"}
    </div>
  {/if}
  <div class="controls" role="group" aria-label="Crosshair controls">
    <strong>Pick {options.label ?? "a point"}</strong>
    {#if shapes.length > 1}
      <div class="row shapes" role="group" aria-label="Crosshair shape">
        {#each shapes as kind (kind)}
          <button type="button" data-crosshair-shape={kind} aria-pressed={shape.kind === kind}
            class:active={shape.kind === kind} onclick={(ev) => { ev.stopPropagation(); setShape(kind); }}>{kind}</button>
        {/each}
      </div>
    {/if}
    {#if shape.kind !== "point"}
      <div class="row">
        <label>{shape.kind === "circle" ? "Radius" : "Reach"} <input type="number" min="0.25" step="0.25"
          data-crosshair-length value={shape.length ?? ""}
          oninput={(ev) => { shape = { ...shape, length: Number(ev.currentTarget.value) }; }} /> {unit}</label>
        {#if shape.kind === "ray" || shape.kind === "rect"}
          <label>Width <input type="number" min="0.25" step="0.25" data-crosshair-width value={shape.width ?? ""}
            oninput={(ev) => { shape = { ...shape, width: Number(ev.currentTarget.value) }; }} /> {unit}</label>
        {/if}
        {#if shape.kind === "cone"}
          <label>Aperture <input type="number" min="5" max="355" step="5" data-crosshair-spread value={shape.spread ?? ""}
            oninput={(ev) => { shape = { ...shape, spread: Number(ev.currentTarget.value) }; }} />°</label>
        {/if}
      </div>
      <div class="row">
        <button type="button" data-crosshair-rotate="-15" onclick={(ev) => { ev.stopPropagation(); rotate(-CROSSHAIR_ANGLE_STEP); }}>↺ 15°</button>
        <span class="angle" data-crosshair-angle>{angleDeg}°</span>
        <button type="button" data-crosshair-rotate="15" onclick={(ev) => { ev.stopPropagation(); rotate(CROSSHAIR_ANGLE_STEP); }}>↻ 15°</button>
      </div>
    {/if}
    <label><input type="checkbox" bind:checked={snap} data-crosshair-snap /> Snap to cell centre{shape.kind !== "point" ? " and 15°" : ""}</label>
    <label>Name <input data-crosshair-name bind:value={name} maxlength="48" placeholder="Placement" /></label>
    {#if named.length > 0}
      <div class="row reuse" role="group" aria-label="Reuse a named placement">
        <small>Reuse:</small>
        {#each named as entry (entry.name)}
          <button type="button" data-crosshair-reuse={entry.name} aria-pressed={reusing === entry.name}
            onclick={(ev) => { ev.stopPropagation(); reuse(entry); }}>{entry.name}</button>
        {/each}
      </div>
    {/if}
    {#if faults.length > 0}
      <ul class="faults" data-crosshair-faults>
        {#each faults as fault (fault.code)}
          <li data-crosshair-fault={fault.code}>{fault.message}</li>
        {/each}
      </ul>
    {/if}
    <small>Scene {(request.bounds.width)}×{(request.bounds.height)} · {options.hint ?? "the draft changes only on a commit"}</small>
    <div class="row">
      <button type="button" data-crosshair-commit disabled={!canCommit} onclick={(ev) => { ev.stopPropagation(); commit(); }}>Place it</button>
      <button type="button" data-crosshair-cancel onclick={(ev) => { ev.stopPropagation(); cancel(); }}>Cancel · Esc</button>
    </div>
  </div>
</div>

<style>
  .crosshair { position: absolute; inset: 0; z-index: 1050; background: rgb(4 10 18 / 0.25); cursor: crosshair; outline: none; overflow: hidden; }
  .area { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .area polygon { fill: rgb(40 214 122 / 0.18); stroke: #81edb2; stroke-width: 2; }
  .area polygon.invalid { fill: rgb(231 63 63 / 0.22); stroke: #fb7575; }
  .range { position: absolute; pointer-events: none; transform: translate(-50%, -50%); border: 1.5px dashed #b5d4ff; border-radius: 50%; background: rgb(130 180 255 / 0.06); }
  .footprint { position: absolute; pointer-events: none; transform: translate(-50%, -50%); border: 2px solid #81edb2; background: rgb(40 214 122 / 0.23); border-radius: 50%; box-shadow: 0 0 18px #30a569; }
  .footprint.invalid { border-color: #fb7575; background: rgb(231 63 63 / 0.3); box-shadow: 0 0 15px #a23232; }
  .readout { position: absolute; pointer-events: none; transform: translateX(-50%); white-space: nowrap; background: #151d29e8; border: 1px solid #8291ac; padding: 3px 7px; border-radius: 4px; color: #f6f6f6; }
  .controls { position: absolute; top: 14px; right: 14px; display: grid; gap: 5px; max-width: 340px; padding: 12px; color: #fff; background: #141b29ed; border: 1px solid #67789a; border-radius: 8px; cursor: auto; }
  .controls label { display: flex; gap: 6px; align-items: center; }
  .controls small { color: #bbcbdd; }
  .row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .shapes button.active { outline: 2px solid #81edb2; }
  .angle { min-width: 44px; text-align: center; }
  .reuse button { padding: 2px 6px; }
  .faults { margin: 0; padding-left: 16px; color: #ffc9c9; }
</style>
