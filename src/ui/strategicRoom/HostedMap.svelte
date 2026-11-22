<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import {
    fitRect,
    LARGE_SCENE_ZOOM_LIMITS,
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
    type RoomOrder,
  } from "../../core/strategicRoom/protocol";
  import type { detailRenderer } from "./detailRenderer";

  let {
    view,
    models,
    orders = new Map(),
    selected,
    target = "",
    aim = null,
    spellPreview = null,
    region,
    onRegion,
    onPoint,
    onSelectUnit,
    onSelectTarget,
    onToggleDoor,
  }: {
    view: Baseline;
    models: ReadonlyMap<string, ModelMarker>;
    orders?: ReadonlyMap<string, RoomOrder | null>;
    selected: string;
    target?: string;
    aim?: Point | null;
    spellPreview?: { shape: "circle" | "cone" | "line"; radius: number } | null;
    region: { x: number; y: number } | null;
    onRegion: (tile: { x: number; y: number } | null) => void;
    onPoint: (point: Point) => void;
    onSelectUnit?: (unitId: string) => void;
    onSelectTarget?: (unitId: string) => void;
    onToggleDoor?: (wallId: string, door: 0 | 1 | 2) => void;
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
  let badgeTick = $state(0);
  let tileTick = $state(0);
  const badgeCache = new SvelteMap<string, HTMLImageElement>();
  const tileCache = new SvelteMap<string, HTMLImageElement>();
  let pan: { x: number; y: number; origin: Camera; moved: boolean } | undefined;

  const colors = $derived(new Map(view.factions.map((f) => [f.id, f.color])));
  const ownMap = $derived(new Map(view.own.map((u) => [u.id, u])));
  const backgroundUrl = $derived(
    view.background ? new URL(view.background.url, location.href).href : null,
  );
  let backgroundImage = $state.raw<HTMLImageElement | null>(null);

  $effect(() => {
    const url = backgroundUrl;
    backgroundImage = null;
    if (!url) return;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => (backgroundImage = image);
    image.src = url;
    return () => {
      image.onload = null;
    };
  });

  $effect(() => {
    const urls = new SvelteSet<string>();
    for (const raw of Object.values(view.unitBadges ?? {})) {
      if (raw) urls.add(new URL(raw, location.href).href);
    }
    for (const u of view.own) {
      if (u.badgeUrl) urls.add(new URL(u.badgeUrl, location.href).href);
    }
    for (const href of urls) {
      if (badgeCache.has(href)) continue;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        badgeCache.set(href, img);
        badgeTick++;
      };
      img.src = href;
    }
  });

  $effect(() => {
    for (const tile of view.backgroundTiles ?? []) {
      const href = new URL(tile.url, location.href).href;
      if (tileCache.has(href)) continue;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        tileCache.set(href, img);
        tileTick++;
      };
      img.src = href;
    }
  });

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
        24,
        LARGE_SCENE_ZOOM_LIMITS.min,
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
    const scale = Math.max(2.4, camera.scale);
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
      const sx = event.clientX - r.left;
      const sy = event.clientY - r.top;
      const pt = screenToWorld(camera, sx, sy);

      // Check interactive door badges first
      if (onToggleDoor && view.walls?.length) {
        for (const w of view.walls) {
          if (!w.id || w.door === undefined) continue;
          const mid = worldToScreen(camera, (w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2);
          if (Math.hypot(mid.x - sx, mid.y - sy) <= 14) {
            const curDoor = view.doors?.[w.id] ?? w.door;
            const nextDoor: 0 | 1 = curDoor === 1 ? 0 : 1;
            onToggleDoor(w.id, nextDoor);
            pan = undefined;
            return;
          }
        }
      }

      // Check if user clicked near a unit marker to select own unit or target enemy!
      let hitId: string | null = null;
      let hitEnemy = false;
      let bestDist = 16;
      const selectedFaction =
        ownMap.get(selected)?.factionId ?? view.factionId;
      for (const m of view.markers) {
        const mp = worldToScreen(camera, m.at.x, m.at.y);
        const dist = Math.hypot(mp.x - sx, mp.y - sy);
        if (dist < bestDist) {
          if (ownMap.has(m.id) && onSelectUnit) {
            bestDist = dist;
            hitId = m.id;
            hitEnemy = false;
          } else if (
            view.role === "PLAYER" &&
            m.factionId !== selectedFaction &&
            onSelectTarget
          ) {
            bestDist = dist;
            hitId = m.id;
            hitEnemy = true;
          }
        }
      }
      if (hitId && !hitEnemy) {
        onSelectUnit?.(hitId);
      } else if (hitId && hitEnemy) {
        onSelectTarget?.(hitId);
      }
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
    camera = zoomAt(camera, x, y, delta, LARGE_SCENE_ZOOM_LIMITS);
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

  function drawArrowHead(
    ctx: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    size = 7,
  ) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    if (dx * dx + dy * dy < 16) return;
    const angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - size * Math.cos(angle - Math.PI / 6),
      toY - size * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      toX - size * Math.cos(angle + Math.PI / 6),
      toY - size * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  $effect(() => {
    void badgeTick;
    void tileTick;
    const v = view,
      c = { ...camera },
      { width, height } = viewport;
    const subset = models,
      activeOrders = orders,
      r = region,
      sel = selected,
      tgtId = target,
      aimPt = aim,
      spPrev = spellPreview,
      palette = colors,
      ownUnits = ownMap,
      art = backgroundImage,
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

      // Battlefield ground & map art (single background and/or stitched multi-panel map)
      ctx.fillStyle = "#1c2623";
      ctx.fillRect(origin.x, origin.y, mapWidth, mapHeight);
      if (art) ctx.drawImage(art, origin.x, origin.y, mapWidth, mapHeight);
      if (v.backgroundTiles?.length) {
        for (const tile of v.backgroundTiles) {
          const href = new URL(tile.url, location.href).href;
          const tileImg = tileCache.get(href);
          if (!tileImg) continue;
          const tl = worldToScreen(c, tile.x, tile.y);
          const tw = tile.width * c.scale;
          const th = tile.height * c.scale;
          if (tl.x + tw < 0 || tl.y + th < 0 || tl.x > width || tl.y > height) continue;
          if (tile.rotation) {
            ctx.save();
            ctx.translate(tl.x + tw / 2, tl.y + th / 2);
            ctx.rotate((tile.rotation * Math.PI) / 180);
            ctx.drawImage(tileImg, -tw / 2, -th / 2, tw, th);
            ctx.restore();
          } else {
            ctx.drawImage(tileImg, tl.x, tl.y, tw, th);
          }
        }
      }
      ctx.strokeStyle = "#5c706a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(origin.x, origin.y, mapWidth, mapHeight);

      // Adaptive tactical & theater grid (5 ft zoomed in -> 50/100/500/1000 ft zoomed out)
      const hasMapArt = Boolean(art || v.backgroundTiles?.length);
      const gridFeet =
        c.scale >= 2 ? 5 : c.scale >= 0.45 ? 50 : c.scale >= 0.1 ? 100 : c.scale >= 0.02 ? 500 : 1000;
      const spacing = c.scale * gridFeet;
      if (spacing >= 8) {
        ctx.strokeStyle = hasMapArt ? "#ffffff1e" : "#ffffff14";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (
          let x =
            origin.x + Math.max(1, Math.ceil(-origin.x / spacing)) * spacing;
          x < Math.min(width, origin.x + mapWidth);
          x += spacing
        ) {
          ctx.moveTo(x, Math.max(0, origin.y));
          ctx.lineTo(x, Math.min(height, origin.y + mapHeight));
        }
        for (
          let y =
            origin.y + Math.max(1, Math.ceil(-origin.y / spacing)) * spacing;
          y < Math.min(height, origin.y + mapHeight);
          y += spacing
        ) {
          ctx.moveTo(Math.max(0, origin.x), y);
          ctx.lineTo(Math.min(width, origin.x + mapWidth), y);
        }
        ctx.stroke();
      }

      if (v.difficultCells?.length && c.scale >= 0.5) {
        const cellPx = Math.max(1, 5 * c.scale);
        ctx.fillStyle = "#b8924238";
        for (const cell of v.difficultCells) {
          const p = worldToScreen(c, cell.col * 5, cell.row * 5);
          if (
            p.x + cellPx < 0 ||
            p.x > width ||
            p.y + cellPx < 0 ||
            p.y > height
          )
            continue;
          ctx.fillRect(p.x, p.y, cellPx, cellPx);
        }
      }

      // Elevated floors & stairs regions
      if (v.regions?.length) {
        ctx.save();
        for (const reg of v.regions) {
          const tl = worldToScreen(c, reg.x, reg.y);
          const rw = reg.width * c.scale;
          const rh = reg.height * c.scale;
          if (tl.x + rw < 0 || tl.x > width || tl.y + rh < 0 || tl.y > height) continue;
          ctx.fillStyle = reg.kind === "stairs" ? "#9dc3d424" : "#d8bc7c22";
          ctx.strokeStyle = reg.kind === "stairs" ? "#8ac5deaa" : "#efd398aa";
          ctx.lineWidth = 1.4;
          ctx.setLineDash(reg.kind === "stairs" ? [4, 3] : []);
          ctx.fillRect(tl.x, tl.y, rw, rh);
          ctx.strokeRect(tl.x, tl.y, rw, rh);
          if (rw > 34 && rh > 16) {
            ctx.fillStyle = "#f4e6bf";
            ctx.font = "600 10px system-ui, sans-serif";
            const lbl =
              reg.kind === "stairs"
                ? `${reg.name ?? "Stairs"}`
                : `${reg.name ? `${reg.name} · ` : ""}+${reg.elevationFt} ft`;
            ctx.fillText(lbl, tl.x + 4, tl.y + 12);
          }
        }
        ctx.restore();
      }

      // Ambient darkness & light halos
      if ((v.darkness ?? 0) > 0) {
        ctx.fillStyle = `rgba(6, 10, 18, ${Math.min(0.56, (v.darkness ?? 0) * 0.52)})`;
        ctx.fillRect(origin.x, origin.y, mapWidth, mapHeight);
      }
      if (v.lights?.length) {
        ctx.save();
        for (const light of v.lights) {
          if (light.hidden && v.role !== "GM") continue;
          const lp = worldToScreen(c, light.x, light.y);
          const rad = Math.max(light.dim, light.bright, 10) * c.scale;
          if (lp.x + rad < 0 || lp.x - rad > width || lp.y + rad < 0 || lp.y - rad > height)
            continue;
          const grad = ctx.createRadialGradient(lp.x, lp.y, 1, lp.x, lp.y, rad);
          grad.addColorStop(0, `${light.color}${light.hidden ? "24" : "55"}`);
          grad.addColorStop(1, `${light.color}00`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(lp.x, lp.y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Persistent measured templates
      if (v.templates?.length) {
        ctx.save();
        for (const tpl of v.templates) {
          const tp = worldToScreen(c, tpl.x, tpl.y);
          const distPx = tpl.distance * c.scale;
          ctx.strokeStyle = tpl.color;
          ctx.fillStyle = `${tpl.color}2e`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          if (tpl.shape === "circle") {
            ctx.arc(tp.x, tp.y, distPx, 0, Math.PI * 2);
          } else if (tpl.shape === "cone") {
            const ang = ((tpl.direction ?? 0) * Math.PI) / 180;
            ctx.moveTo(tp.x, tp.y);
            ctx.arc(tp.x, tp.y, distPx, ang - Math.PI / 4, ang + Math.PI / 4);
            ctx.closePath();
          } else if (tpl.shape === "line") {
            const ang = ((tpl.direction ?? 0) * Math.PI) / 180;
            const hw = ((tpl.width ?? 5) * c.scale) / 2;
            ctx.save();
            ctx.translate(tp.x, tp.y);
            ctx.rotate(ang);
            ctx.rect(0, -hw, distPx, hw * 2);
            ctx.restore();
          } else {
            ctx.rect(tp.x, tp.y, distPx, (tpl.width ?? tpl.distance) * c.scale);
          }
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }

      for (const area of v.areas ?? []) {
        const p = worldToScreen(c, area.at.x, area.at.y);
        const radius = area.radius * c.scale;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle =
          area.spell === "blackTentacles"
            ? "#7048a955"
            : area.spell === "burningEntanglement"
              ? "#d75c2355"
              : "#4d9b5555";
        ctx.fill();
        ctx.strokeStyle =
          area.spell === "blackTentacles"
            ? "#b58ae6"
            : area.spell === "burningEntanglement"
              ? "#ff985f"
              : "#80d58a";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      if (v.walls?.length) {
        ctx.save();
        ctx.lineWidth = Math.max(1.8, Math.min(4, c.scale * 0.9));
        for (const w of v.walls) {
          const a = worldToScreen(c, w.x1, w.y1);
          const bPt = worldToScreen(c, w.x2, w.y2);
          ctx.beginPath();
          if ((w.restriction & 3) === 3) {
            ctx.strokeStyle = "#e6c387";
            ctx.setLineDash([]);
          } else if ((w.restriction & 1) !== 0) {
            ctx.strokeStyle = "#8faec9";
            ctx.setLineDash([6, 3]);
          } else {
            ctx.strokeStyle = "#b590e8";
            ctx.setLineDash([2, 3]);
          }
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(bPt.x, bPt.y);
          ctx.stroke();
          if (w.id && w.door !== undefined) {
            const dState = v.doors?.[w.id] ?? w.door;
            const mx = (a.x + bPt.x) / 2;
            const my = (a.y + bPt.y) / 2;
            ctx.save();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(mx, my, 7.5, 0, Math.PI * 2);
            ctx.fillStyle =
              dState === 1 ? "#357a4a" : dState === 2 ? "#8c3333" : "#7c5b2b";
            ctx.fill();
            ctx.strokeStyle = "#f5e7c4";
            ctx.lineWidth = 1.4;
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "700 9px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(dState === 1 ? "O" : dState === 2 ? "L" : "D", mx, my);
            ctx.restore();
          }
        }
        ctx.restore();
      }

      // Resolved turn FX cues
      for (const cue of v.content?.fxCues ?? []) {
        if (cue.turnId !== v.head.version) continue;
        const cp = worldToScreen(c, cue.at.x, cue.at.y);
        const rad = Math.max(8, cue.radius * c.scale);
        ctx.save();
        const fxColor =
          cue.preset === "fireball" || cue.preset === "burning-hands" || cue.preset === "burning-entanglement"
            ? "#ff7838"
            : cue.preset === "lightning-bolt" || cue.preset === "cone-of-cold"
              ? "#6fd6ff"
              : cue.preset === "heal"
                ? "#7cf29c"
                : cue.preset === "buff"
                  ? "#ffe17d"
                  : "#a97cf2";
        ctx.strokeStyle = fxColor;
        ctx.fillStyle = `${fxColor}30`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (cue.dir && (cue.preset === "burning-hands" || cue.preset === "cone-of-cold")) {
          const ang = Math.atan2(cue.dir.y, cue.dir.x);
          ctx.moveTo(cp.x, cp.y);
          ctx.arc(cp.x, cp.y, rad, ang - Math.PI / 4, ang + Math.PI / 4);
          ctx.closePath();
        } else if (cue.dir && cue.preset === "lightning-bolt") {
          const ang = Math.atan2(cue.dir.y, cue.dir.x);
          ctx.translate(cp.x, cp.y);
          ctx.rotate(ang);
          ctx.rect(0, -Math.max(2, 2.5 * c.scale), rad, Math.max(4, 5 * c.scale));
        } else {
          ctx.arc(cp.x, cp.y, rad, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      if (r) {
        ctx.save();
        ctx.strokeStyle = "#efd398aa";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(
          origin.x + r.x * REGION_SIZE * c.scale,
          origin.y + r.y * REGION_SIZE * c.scale,
          REGION_SIZE * c.scale,
          REGION_SIZE * c.scale,
        );
        ctx.restore();
      }

      const unitFactionMap = new Map(v.markers.map((m) => [m.id, m.factionId]));
      const detailedUnits =
        c.scale > 1.7
          ? new Set([...subset.values()].map((m) => m.unitId))
          : new Set<string>();

      // Regiment formations (oriented blocks + front shield bar + token art medallion)
      const firstFactionId = v.factions[0]?.id;
      const manyMarkers = v.markers.length > 400;
      const fastHalfD = Math.max(2.5, Math.min(18, 12 * c.scale));
      const fastHalfW = Math.max(3.5, Math.min(36, 22 * c.scale));
      for (const u of v.markers) {
        const p = worldToScreen(c, u.at.x, u.at.y);
        if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60)
          continue;
        const baseColor = palette.get(u.factionId) ?? "#9aa8b8";
        const ownUnit = ownUnits.get(u.id);
        const isOwn = ownUnit !== undefined;
        const isSelected = sel === u.id;
        const isTargeted = tgtId === u.id;
        if (manyMarkers && !isOwn && !isSelected && !isTargeted) {
          ctx.fillStyle = baseColor;
          ctx.fillRect(p.x - fastHalfD, p.y - fastHalfW, fastHalfD * 2, fastHalfW * 2);
          continue;
        }
        const facing =
          v.unitFacings?.[u.id] ??
          ownUnit?.facing ??
          (u.factionId === firstFactionId ? 0 : Math.PI);

        // 50-model line = 10 files (50 ft wide) x 5 ranks (25 ft deep)
        const isDetailed = detailedUnits.has(u.id);
        const depthPx = isDetailed
          ? 24 * c.scale
          : Math.max(8, Math.min(90, 25 * c.scale));
        const frontPx = isDetailed
          ? 48 * c.scale
          : Math.max(13, Math.min(180, 48 * c.scale));

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(facing);

        if (isDetailed) {
          // Subtle formation footprint under individual soldiers when zoomed in
          ctx.fillStyle = `${baseColor}1c`;
          ctx.strokeStyle = isSelected ? "#ffe08a" : `${baseColor}88`;
          ctx.lineWidth = isSelected ? 2.2 : 1.2;
          ctx.fillRect(-depthPx / 2, -frontPx / 2, depthPx, frontPx);
          ctx.strokeRect(-depthPx / 2, -frontPx / 2, depthPx, frontPx);
        } else {
          // Solid regiment block at strategic / operational zoom
          if (v.markers.length <= 300) {
            ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
            ctx.shadowBlur = isSelected ? 8 : 4;
          }
          ctx.fillStyle = isOwn || v.role === "GM" ? baseColor : `${baseColor}cc`;
          ctx.fillRect(-depthPx / 2, -frontPx / 2, depthPx, frontPx);
          if (v.markers.length <= 300) ctx.shadowBlur = 0;

          // Dark inner border + gold ownership border for player's own 5 units
          ctx.strokeStyle = isSelected
            ? "#fff3b0"
            : isOwn
              ? "#efd398"
              : "#0b1116";
          ctx.lineWidth = isSelected ? 2.4 : isOwn ? 1.8 : 1.1;
          ctx.strokeRect(-depthPx / 2, -frontPx / 2, depthPx, frontPx);

          // Bright front-rank shield bar on the +X (forward facing) edge
          const frontBar = Math.max(2.2, Math.min(5, depthPx * 0.22));
          ctx.fillStyle = "#ffffffd8";
          ctx.fillRect(depthPx / 2 - frontBar, -frontPx / 2 + 1, frontBar, frontPx - 2);
        }
        if (isSelected) {
          ctx.strokeStyle = "#ffe08a";
          ctx.lineWidth = 2;
          ctx.strokeRect(-depthPx / 2 - 4, -frontPx / 2 - 4, depthPx + 8, frontPx + 8);
        }
        ctx.restore();

        // Uploaded token badge emblem at formation center
        const rawBadge = v.unitBadges?.[u.id] ?? ownUnit?.badgeUrl;
        const badgeHref = rawBadge ? new URL(rawBadge, location.href).href : null;
        const badgeImg = badgeHref ? badgeCache.get(badgeHref) : undefined;
        if (badgeImg && !detailedUnits.has(u.id)) {
          const rMed = Math.max(5.5, Math.min(16, Math.min(depthPx, frontPx) * 0.46));
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, rMed, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(badgeImg, p.x - rMed, p.y - rMed, rMed * 2, rMed * 2);
          ctx.restore();
          ctx.beginPath();
          ctx.arc(p.x, p.y, rMed, 0, Math.PI * 2);
          ctx.strokeStyle = isOwn ? "#ffe08a" : "#101820";
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // Enemy target reticle
        if (isTargeted) {
          const rad = Math.max(11, Math.min(48, Math.max(depthPx, frontPx) * 0.58));
          ctx.save();
          ctx.strokeStyle = "#ff5c5c";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
          ctx.moveTo(p.x - rad - 4, p.y);
          ctx.lineTo(p.x + rad + 4, p.y);
          ctx.moveTo(p.x, p.y - rad - 4);
          ctx.lineTo(p.x, p.y + rad + 4);
          ctx.stroke();
          ctx.restore();
        }

        // Regiment nameplate & alive count for own units, selected, targeted, or zoomed view
        if (
          isSelected ||
          isTargeted ||
          (isOwn && c.scale >= 0.25) ||
          (c.scale >= 0.85 && v.markers.length <= 120)
        ) {
          const text = ownUnit ? `${u.name} (${ownUnit.alive})` : u.name;
          ctx.font = isSelected || isOwn ? "600 11px system-ui, sans-serif" : "10.5px system-ui, sans-serif";
          const metrics = ctx.measureText(text);
          const lx = p.x - metrics.width / 2;
          const ly = p.y - Math.max(depthPx, frontPx) * 0.55 - 5;
          ctx.fillStyle = "rgba(12, 18, 22, 0.82)";
          ctx.fillRect(lx - 4, ly - 10, metrics.width + 8, 13);
          ctx.fillStyle = isSelected
            ? "#ffe79e"
            : isOwn
              ? "#f7f3e3"
              : baseColor;
          ctx.fillText(text, lx, ly);
        }
      }

      // Zoomed-in individual soldier rendering (crisp faction-colored circular bases + facing ticks)
      if (subset.size > 0 && c.scale > 1.7) {
        const modelRadius = Math.max(2.2, Math.min(9, 2.0 * c.scale));
        for (const m of subset.values()) {
          const p = worldToScreen(c, m.x, m.y);
          if (p.x < -12 || p.x > width + 12 || p.y < -12 || p.y > height + 12)
            continue;
          const fid = unitFactionMap.get(m.unitId);
          const fill = (fid ? palette.get(fid) : undefined) ?? "#dce6f2";
          const isOwnModel = ownUnits.has(m.unitId);
          ctx.beginPath();
          ctx.arc(p.x, p.y, modelRadius, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.strokeStyle = isOwnModel ? "#ffe08a" : "#0d141a";
          ctx.lineWidth = isOwnModel ? 1.2 : 0.9;
          ctx.stroke();

          // Facing spear tick
          const tx = p.x + Math.cos(m.rotation) * (modelRadius * 1.45);
          const ty = p.y + Math.sin(m.rotation) * (modelRadius * 1.45);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(tx, ty);
          ctx.strokeStyle = "#ffffffd8";
          ctx.lineWidth = Math.max(1, modelRadius * 0.34);
          ctx.stroke();
        }
      }
      if (d && c.scale > 1.7) d.draw(v, subset, c, { width, height });

      // Command vectors with arrowheads for own units' drafted/accepted orders
      if (activeOrders.size > 0) {
        const markerAt = new Map(v.markers.map((m) => [m.id, m.at]));
        ctx.save();
        ctx.lineWidth = 2.1;
        for (const own of v.own) {
          if (!own.at) continue;
          const ord = activeOrders.get(own.id);
          if (!ord) continue;
          const from = worldToScreen(c, own.at.x, own.at.y);
          if (ord.kind === "move") {
            const stroke = ord.pace === "charge" ? "#ff7a6b" : "#67d4ff";
            ctx.strokeStyle = stroke;
            ctx.fillStyle = stroke;
            ctx.setLineDash(ord.pace === "charge" ? [] : [6, 4]);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            let prev = from;
            for (const wp of ord.path) {
              const p = worldToScreen(c, wp.x, wp.y);
              ctx.lineTo(p.x, p.y);
              prev = p;
            }
            ctx.stroke();
            ctx.setLineDash([]);
            if (ord.path.length > 0) {
              const prevWp =
                ord.path.length > 1
                  ? worldToScreen(
                      c,
                      ord.path[ord.path.length - 2]?.x ?? own.at.x,
                      ord.path[ord.path.length - 2]?.y ?? own.at.y,
                    )
                  : from;
              drawArrowHead(ctx, prevWp.x, prevWp.y, prev.x, prev.y, 8);
            }
          } else if (ord.kind === "attack") {
            const tgt = markerAt.get(ord.targetUnitId);
            if (tgt) {
              const to = worldToScreen(c, tgt.x, tgt.y);
              const stroke = ord.envelop ? "#ffb35c" : "#ff6363";
              ctx.strokeStyle = stroke;
              ctx.fillStyle = stroke;
              ctx.setLineDash([5, 3]);
              ctx.beginPath();
              ctx.moveTo(from.x, from.y);
              ctx.lineTo(to.x, to.y);
              ctx.stroke();
              ctx.setLineDash([]);
              drawArrowHead(ctx, from.x, from.y, to.x, to.y, 8);
            }
          } else if (ord.kind === "cast") {
            const to = worldToScreen(c, ord.origin.x, ord.origin.y);
            ctx.strokeStyle = "#80d58a";
            ctx.fillStyle = "#80d58a";
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
            ctx.setLineDash([]);
            drawArrowHead(ctx, from.x, from.y, to.x, to.y, 7);
          }
        }
        ctx.restore();
      }

      // Live Aim Reticle where player clicked on the map
      if (aimPt && Number.isFinite(aimPt.x) && Number.isFinite(aimPt.y)) {
        const ap = worldToScreen(c, aimPt.x, aimPt.y);
        ctx.save();
        ctx.strokeStyle = "#ffe08a";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(ap.x, ap.y, 7, 0, Math.PI * 2);
        ctx.moveTo(ap.x - 11, ap.y);
        ctx.lineTo(ap.x + 11, ap.y);
        ctx.moveTo(ap.x, ap.y - 11);
        ctx.lineTo(ap.x, ap.y + 11);
        ctx.stroke();
        const selOwn = ownUnits.get(sel);
        if (selOwn?.at) {
          const fp = worldToScreen(c, selOwn.at.x, selOwn.at.y);
          ctx.strokeStyle = "#ffe08a66";
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(fp.x, fp.y);
          ctx.lineTo(ap.x, ap.y);
          ctx.stroke();
          ctx.setLineDash([]);
          if (spPrev) {
            ctx.strokeStyle = "#a685ff";
            ctx.fillStyle = "#a685ff26";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (spPrev.shape === "circle") {
              ctx.arc(ap.x, ap.y, spPrev.radius * c.scale, 0, Math.PI * 2);
            } else if (spPrev.shape === "cone") {
              const ang = Math.atan2(aimPt.y - selOwn.at.y, aimPt.x - selOwn.at.x);
              ctx.moveTo(fp.x, fp.y);
              ctx.arc(fp.x, fp.y, spPrev.radius * c.scale, ang - Math.PI / 4, ang + Math.PI / 4);
              ctx.closePath();
            } else {
              const ang = Math.atan2(aimPt.y - selOwn.at.y, aimPt.x - selOwn.at.x);
              const hw = Math.max(2, 2.5 * c.scale);
              ctx.save();
              ctx.translate(fp.x, fp.y);
              ctx.rotate(ang);
              ctx.rect(0, -hw, spPrev.radius * c.scale, hw * 2);
              ctx.restore();
            }
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="controls">
  <button
    type="button"
    onclick={() => {
      fit();
      trackRegion();
    }}>Fit map</button
  >
  <button type="button" class="zoom-btn" onclick={() => zoom(1.35)} aria-label="Zoom in">+</button>
  <button type="button" class="zoom-btn" onclick={() => zoom(1 / 1.35)} aria-label="Zoom out">-</button>
  <button type="button" disabled={!view.own.some((u) => u.at)} onclick={centerOwn}
    >Center unit</button
  >
  <button
    type="button"
    class:active={detailWanted}
    aria-pressed={detailWanted}
    onclick={detailToggle}>Region detail</button
  >
  <span class="scale-pill">{camera.scale < 0.01 ? `${(camera.scale * 100).toFixed(1)}` : Math.round(camera.scale * 100)}% zoom</span>
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
    data-hosted-background={backgroundUrl || (view.backgroundTiles?.length ?? 0) > 0 ? "true" : undefined}
    data-hosted-background-tiles={view.backgroundTiles?.length ? String(view.backgroundTiles.length) : undefined}
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
  {#if view.role === "PLAYER"}<span class="own-key">▢ Gold rim = your {view.own.length} units</span>{/if}
  <span
    >Drag to pan · scroll to zoom · click unit to select/target · click ground to aim{gpuUnavailable
      ? " · 2D renderer"
      : ""}</span
  >
</p>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.55rem;
  }
  .zoom-btn {
    min-width: 2.1rem;
    font-weight: 700;
    font-size: 1rem;
    line-height: 1;
  }
  .scale-pill {
    margin-left: auto;
    font-size: 0.76rem;
    color: var(--muted);
  }
  .map {
    position: relative;
    height: clamp(24rem, 66vh, 47rem);
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
    opacity: 0.35;
  }
  .detail.invisible {
    visibility: hidden;
  }
  .controls .active {
    border-color: var(--accent);
    background: #283327;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0.5rem 0 0;
  }
  .own-key {
    color: #efd398;
    font-weight: 600;
  }
</style>
