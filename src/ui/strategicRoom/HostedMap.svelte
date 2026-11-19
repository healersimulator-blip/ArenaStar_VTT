<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    fitRect,
    screenToWorld,
    worldToScreen,
    zoomAt,
    type Camera,
  } from "../../canvas/camera";
  import {
    REGION_SIZE,
    type Baseline,
    type ModelMarker,
    type Point,
  } from "../../core/strategicRoom/protocol";
  import type { detailRenderer } from "./detailRenderer";

  let {
    view,
    models,
    selected,
    region,
    onRegion,
    onPoint,
  }: {
    view: Baseline;
    models: ReadonlyMap<string, ModelMarker>;
    selected: string;
    region: { x: number; y: number } | null;
    onRegion: (tile: { x: number; y: number } | null) => void;
    onPoint: (point: Point) => void;
  } = $props();

  let box: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let overlay: HTMLDivElement;
  let viewport = $state({ width: 1, height: 1 });
  let camera = $state<Camera>({ x: 0, y: 0, scale: 1 });
  let detail = $state.raw<Awaited<ReturnType<typeof detailRenderer>> | null>(
    null,
  );
  let gpuUnavailable = $state(false);
  let detailWanted = $state(false);
  let pan: { x: number; y: number; origin: Camera; moved: boolean } | undefined;
  const colors = $derived(new Map(view.factions.map((f) => [f.id, f.color])));

  function fit() {
    const b = view.bounds;
    if (viewport.width > 64 && viewport.height > 64)
      camera = fitRect(
        {
          x: b.minX,
          y: b.minY,
          width: b.maxX - b.minX,
          height: b.maxY - b.minY,
        },
        viewport,
        20,
      );
  }

  function trackRegion(at?: Point) {
    if (!detailWanted) return;
    const center =
      at ?? screenToWorld(camera, viewport.width / 2, viewport.height / 2);
    const b = view.bounds;
    const x = Math.floor(
      (Math.min(b.maxX, Math.max(b.minX, center.x)) - b.minX) / REGION_SIZE,
    );
    const y = Math.floor(
      (Math.min(b.maxY, Math.max(b.minY, center.y)) - b.minY) / REGION_SIZE,
    );
    onRegion({ x, y });
  }

  function detailToggle() {
    detailWanted = !detailWanted;
    if (detailWanted) trackRegion();
    else onRegion(null);
  }

  function centerOwn() {
    const at =
      view.own.find((u) => u.id === selected)?.at ??
      view.own.find((u) => u.at)?.at;
    if (!at) return;
    const scale = Math.max(2.2, camera.scale);
    camera = {
      x: at.x - viewport.width / (2 * scale),
      y: at.y - viewport.height / (2 * scale),
      scale,
    };
    trackRegion(at);
  }

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    pan = {
      x: event.clientX,
      y: event.clientY,
      origin: { ...camera },
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    if (!pan) return;
    const dx = event.clientX - pan.x,
      dy = event.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !pan.moved) return;
    pan.moved = true;
    camera = {
      ...pan.origin,
      x: pan.origin.x - dx / pan.origin.scale,
      y: pan.origin.y - dy / pan.origin.scale,
    };
  }

  function up(event: PointerEvent) {
    if (!pan) return;
    if (pan.moved) trackRegion();
    else {
      const r = canvas.getBoundingClientRect();
      const pt = screenToWorld(
        camera,
        event.clientX - r.left,
        event.clientY - r.top,
      );
      if (
        pt.x >= view.bounds.minX &&
        pt.x <= view.bounds.maxX &&
        pt.y >= view.bounds.minY &&
        pt.y <= view.bounds.maxY
      ) {
        onPoint({
          x: Math.round(pt.x * 16) / 16,
          y: Math.round(pt.y * 16) / 16,
        });
        trackRegion(pt);
      }
    }
    pan = undefined;
  }

  function zoom(
    delta: number,
    x = viewport.width / 2,
    y = viewport.height / 2,
  ) {
    camera = zoomAt(camera, x, y, delta, { min: 0.035, max: 12 });
    trackRegion();
  }

  function key(event: KeyboardEvent) {
    const shift = 40 / camera.scale;
    if (event.key === "ArrowLeft") camera = { ...camera, x: camera.x - shift };
    else if (event.key === "ArrowRight")
      camera = { ...camera, x: camera.x + shift };
    else if (event.key === "ArrowUp")
      camera = { ...camera, y: camera.y - shift };
    else if (event.key === "ArrowDown")
      camera = { ...camera, y: camera.y + shift };
    else if (event.key === "+") zoom(1.3);
    else if (event.key === "-") zoom(1 / 1.3);
    else return;
    trackRegion();
    event.preventDefault();
  }

  onMount(() => {
    detailWanted = untrack(() => region !== null);
    let ready = false;
    const observer = new ResizeObserver(() => {
      viewport = { width: box.clientWidth, height: box.clientHeight };
      if (!ready && viewport.width > 64 && viewport.height > 64) {
        ready = true;
        fit();
      }
    });
    observer.observe(box);
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoom(
        ev.deltaY < 0 ? 1.12 : 1 / 1.12,
        ev.clientX - r.left,
        ev.clientY - r.top,
      );
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", wheel);
    };
  });

  $effect(() => {
    if (!detailWanted) return;
    let disposed = false;
    let renderer: typeof detail = null;
    void import("./detailRenderer")
      .then((m) => (disposed ? null : m.detailRenderer(overlay)))
      .then((value) => {
        if (disposed) {
          value?.destroy();
          return;
        }
        detail = renderer = value;
      })
      .catch(() => {
        if (!disposed) gpuUnavailable = true;
      });
    return () => {
      disposed = true;
      renderer?.destroy();
      detail = null;
    };
  });

  $effect(() => {
    const v = view,
      c = { ...camera },
      { width, height } = viewport;
    const subset = models,
      r = region,
      sel = selected,
      palette = colors,
      d = detail;
    const raf = requestAnimationFrame(() => {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const scale = Math.min(2, devicePixelRatio);
      if (canvas.width !== width * scale || canvas.height !== height * scale) {
        canvas.width = width * scale;
        canvas.height = height * scale;
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const b = v.bounds;
      const origin = worldToScreen(c, b.minX, b.minY);
      const mapWidth = (b.maxX - b.minX) * c.scale,
        mapHeight = (b.maxY - b.minY) * c.scale;
      ctx.fillStyle = "#212c2b";
      ctx.fillRect(origin.x, origin.y, mapWidth, mapHeight);
      ctx.strokeStyle = "#465553";
      ctx.strokeRect(origin.x, origin.y, mapWidth, mapHeight);
      const spacing = c.scale * (c.scale >= 2 ? 5 : 120);
      ctx.strokeStyle = "#ffffff13";
      ctx.beginPath();
      for (
        let x =
          origin.x + Math.max(1, Math.ceil(-origin.x / spacing)) * spacing;
        x < Math.min(width, origin.x + mapWidth);
        x += spacing
      ) {
        ctx.moveTo(x, origin.y);
        ctx.lineTo(x, origin.y + mapHeight);
      }
      for (
        let y =
          origin.y + Math.max(1, Math.ceil(-origin.y / spacing)) * spacing;
        y < Math.min(height, origin.y + mapHeight);
        y += spacing
      ) {
        ctx.moveTo(origin.x, y);
        ctx.lineTo(origin.x + mapWidth, y);
      }
      ctx.stroke();
      if (r) {
        ctx.strokeStyle = "#e0bf7c";
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(
          origin.x + r.x * REGION_SIZE * c.scale,
          origin.y + r.y * REGION_SIZE * c.scale,
          REGION_SIZE * c.scale,
          REGION_SIZE * c.scale,
        );
        ctx.setLineDash([]);
      }
      const detailed =
        c.scale > 1.7
          ? new Set([...subset.values()].map((m) => m.unitId))
          : new Set<string>();
      for (const u of v.markers) {
        const p = worldToScreen(c, u.at.x, u.at.y);
        if (p.x < -8 || p.x > width + 8 || p.y < -8 || p.y > height + 8)
          continue;
        ctx.fillStyle = palette.get(u.factionId) ?? "#aaa";
        const size = sel === u.id ? 10 : c.scale < 0.65 ? 4 : 7;
        if (!detailed.has(u.id))
          ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
        if (sel === u.id) {
          ctx.strokeStyle = "#ffdc8d";
          ctx.strokeRect(p.x - 8, p.y - 8, 16, 16);
        }
        if (c.scale > 1.65 && (sel === u.id || v.markers.length <= 30)) {
          ctx.font = "11px system-ui";
          ctx.fillText(u.name, p.x + 8, p.y - 6);
        }
      }
      if (d && c.scale > 1.7) d.draw(v, subset, c, { width, height });
      else if (subset.size && c.scale > 1.7)
        for (const m of subset.values()) {
          const p = worldToScreen(c, m.x, m.y);
          ctx.fillStyle = "#edf2e8";
          ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        }
    });
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="controls">
  <button
    onclick={() => {
      fit();
      trackRegion();
    }}>Fit map</button
  >
  <button onclick={() => zoom(1.35)} aria-label="Zoom in">＋</button>
  <button onclick={() => zoom(1 / 1.35)} aria-label="Zoom out">−</button>
  <button disabled={!view.own.some((u) => u.at)} onclick={centerOwn}
    >Center unit</button
  >
  <button
    class:active={detailWanted}
    aria-pressed={detailWanted}
    onclick={detailToggle}>Region detail</button
  >
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (interactive map with keyboard pan and zoom) -->
<div
  class="map"
  bind:this={box}
  role="application"
  tabindex="0"
  aria-label="Battlefield. Drag to pan or use arrow keys. Click a march destination."
  onkeydown={key}
>
  <canvas
    bind:this={canvas}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => {
      pan = undefined;
    }}
  ></canvas>
  <div
    class="detail"
    class:invisible={camera.scale <= 1.7}
    bind:this={overlay}
    aria-hidden="true"
  ></div>
</div>
<p class="legend">
  {#each view.factions as f (f.id)}<span style:color={f.color}>■ {f.name}</span
    >{/each}
  <span
    >Drag to pan · scroll to zoom · click to aim{gpuUnavailable
      ? " · 2D renderer"
      : ""}</span
  >
</p>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0 0 0.65rem;
  }
  .map {
    position: relative;
    height: clamp(20rem, 56vh, 43rem);
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    overflow: hidden;
    background: #141c1b;
  }
  canvas,
  .detail {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  canvas {
    cursor: crosshair;
    touch-action: none;
  }
  .map:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }
  .detail {
    pointer-events: none;
  }
  .detail.invisible {
    visibility: hidden;
  }
  .controls .active {
    border-color: var(--accent);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0.6rem 0 0;
  }
</style>
