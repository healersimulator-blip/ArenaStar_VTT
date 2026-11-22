/**
 * §9A ModelLayer — renders the ModelPool between Tokens and Tiles(above).
 *
 * LOD0 uses a single PixiJS ParticleContainer (instanced rendering): one
 * pooled Particle per VISIBLE model, fields written in a tight loop straight
 * from the pool's typed arrays — no per-model display objects and no
 * per-model allocations in the render loop. LOD1/LOD2 draw a handful of
 * pooled Graphics/Text per UNIT/ARMY (units are few by construction).
 *
 * All drawing is in WORLD coordinates inside the camera-transformed root;
 * screen-constant strokes/fonts compensate for camera scale.
 */
import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import type { Application, IParticle } from "pixi.js";
import type { Camera, Viewport } from "../../camera";
import type { ModelPool } from "../../../core/strategic";
import { ModelStatus } from "../../../core/strategic";
import { ModelSpatialHash, type WorldRect } from "../../spatial";
import type { DrawableUnit } from "./units";
import { ATLAS_FRAME, type AtlasEntry, type AtlasPlan, atlasKey, bindDecision } from "./atlases";
import {
  bboxIntersects,
  chooseUnitLods,
  DEFAULT_LOD_THRESHOLDS,
  drawableModelIndices,
  strengthFraction,
  unitBBox,
  UnitLodState,
  type BBox,
  type LodThresholds,
} from "./lod";

export * from "./lod";
export * from "./units";
export { ModelSpatialHash };

export interface ModelLayerOptions {
  /** Model stand size in world units (default 0.75). */
  modelSize?: number;
  thresholds?: LodThresholds;
  /** Spatial-hash cell size (default 5, matches DetectionGrid §5A). */
  cellSize?: number;
  /** Optional: when zoomed out (LOD1), show a unit-sized round token portrait if `unit.tokenImg` is set. */
  zoomOutUnitToken?: boolean;
}

export interface ModelSyncStats {
  lod0Models: number;
  lod1Units: number;
  lod2Armies: number;
  culledUnits: number;
  totalUnits: number;
  syncMs: number;
}

interface UnitBlockView {
  box: Graphics;
  banner: Text;
  portrait?: Sprite;
  /** Redraw key: bbox/strength/color/selection/zoom-bucket. */
  key: string;
  bbox: BBox;
}

interface ArmyMarkerView {
  g: Graphics;
  label: Text;
  key: string;
}

const MODEL_MARGIN = 4; // world units of bbox padding before cull tests

export class ModelLayer {
  readonly container = new Container();
  readonly hash: ModelSpatialHash;
  private readonly particles: ParticleContainer;
  private readonly particlePool: Particle[] = [];
  private readonly blocksLayer = new Container();
  private readonly selectionLayer = new Container();
  private readonly blocks = new Map<string, UnitBlockView>();
  private readonly armyMarkers = new Map<string, ArmyMarkerView>();
  private readonly lodState = new UnitLodState();
  private readonly thresholds: LodThresholds;
  private readonly modelSize: number;
  private readonly app: Application;
  private standTexture: Texture;
  /** §7 atlas subframes by frame key (unit type × palette). */
  private readonly unitTextures = new Map<string, Texture>();
  /** Base atlas textures by atlas id (≤ MAX_BOUND_ATLASES bound). */
  private readonly atlasBases = new Map<string, Texture>();
  /** frame key → owning atlas id (eviction bookkeeping). */
  private readonly keyAtlas = new Map<string, string>();
  /** Bound atlas ids in LRU order (oldest first). */
  private boundAtlasIds: string[] = [];
  /** Cached round VTT portrait textures keyed by `${tokenImg}|${palette}` (for units with tokenImg). */
  private readonly portraitTextures = new Map<string, Texture | "loading" | "failed">();
  private zoomOutUnitToken = false;
  private selection = new Set<string>();
  /** Reused per-unit index scratch (no per-model allocation). */
  private readonly scratch: number[] = [];
  private unitRanges: ReadonlyArray<{ id: string; modelRange: readonly [number, number] | null }> =
    [];

  constructor(app: Application, options: ModelLayerOptions = {}) {
    this.app = app;
    this.modelSize = options.modelSize ?? 0.75;
    this.thresholds = options.thresholds ?? DEFAULT_LOD_THRESHOLDS;
    this.zoomOutUnitToken = options.zoomOutUnitToken === true;
    this.hash = new ModelSpatialHash(options.cellSize ?? 5);
    this.container.label = "models";
    this.particles = new ParticleContainer({
      dynamicProperties: { position: true, rotation: true, color: true },
    });
    this.container.addChild(this.particles, this.blocksLayer, this.selectionLayer);
    this.standTexture = this.makeStandTexture();
  }

  /** Round VTT token disc (`combat_resolver_5` SL6/SL7): tintable disc + bezel + front chevron (+x). */
  private makeStandTexture(): Texture {
    try {
      const g = new Graphics();
      const s = 24;
      const r = 10;
      g.circle(s / 2, s / 2, r)
        .fill({ color: 0xe8ebf0 })
        .stroke({ width: 1.8, color: 0x181c22, alpha: 0.85 });
      g.circle(s / 2, s / 2, r - 2.2).stroke({ width: 0.9, color: 0xffffff, alpha: 0.35 });
      g.moveTo(s / 2 + r + 1.5, s / 2)
        .lineTo(s / 2 + r - 3.5, s / 2 - 2.8)
        .lineTo(s / 2 + r - 3.5, s / 2 + 2.8)
        .closePath()
        .fill(0xffffff);
      const tex = this.app.renderer.generateTexture(g);
      g.destroy();
      return tex;
    } catch {
      return Texture.WHITE;
    }
  }

  /** Select units (rings drawn on next sync). */
  setSelection(ids: ReadonlySet<string>): void {
    this.selection = new Set(ids);
  }

  /** Toggle zoomed-out unit-sized token portraits for units with `tokenImg`. */
  setZoomOutUnitToken(enabled: boolean): void {
    this.zoomOutUnitToken = enabled;
  }

  /** §7 readback: bound atlas textures + distinct frame keys. */
  atlasStats(): { bound: number; frames: number; keys: string[] } {
    return {
      bound: this.boundAtlasIds.length,
      frames: this.unitTextures.size,
      keys: [...this.unitTextures.keys()],
    };
  }

  /**
   * §7 sprite atlases: register plans (unit type × faction palette frames).
   * Baked-palette frames replace the tinted stand marker per unit; at most
   * MAX_BOUND_ATLASES base textures stay bound (LRU eviction destroys the
   * oldest atlas and its subframes — those units fall back to the marker).
   */
  registerAtlases(plans: readonly AtlasPlan[]): void {
    const wanted = plans.map((p) => p.baseKey);
    const decision = bindDecision(this.boundAtlasIds, wanted);
    for (const id of decision.evict) {
      const base = this.atlasBases.get(id);
      this.atlasBases.delete(id);
      if (base) base.destroy(true);
      for (const [frameKey, atlasId] of this.keyAtlas) {
        if (atlasId !== id) continue;
        this.keyAtlas.delete(frameKey);
        const sub = this.unitTextures.get(frameKey);
        if (sub) sub.destroy();
        this.unitTextures.delete(frameKey);
      }
    }
    // decision.keep already contains the admitted ids (finalists list)
    this.boundAtlasIds = decision.keep;
    for (const plan of plans) {
      if (!decision.admit.includes(plan.baseKey)) continue;
      if (this.atlasBases.has(plan.baseKey)) continue;
      const base = this.makeAtlasTexture(plan);
      if (!base) continue;
      this.atlasBases.set(plan.baseKey, base);
      for (const frame of plan.frames) {
        const sub = new Texture({
          source: base.source,
          frame: new Rectangle(frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height),
        });
        sub.label = frame.key;
        this.unitTextures.set(frame.key, sub);
        this.keyAtlas.set(frame.key, plan.baseKey);
      }
    }
  }

  /** One atlas texture: all frames' glyphs drawn on a 4×4 grid (64×64). */
  private makeAtlasTexture(plan: AtlasPlan): Texture | null {
    try {
      const g = new Graphics();
      for (const frame of plan.frames) this.drawGlyph(g, frame.entry, frame.rect);
      const tex = this.app.renderer.generateTexture(g);
      g.destroy();
      return tex;
    } catch {
      return null;
    }
  }

  /** Procedural round VTT token glyph per unit type with the faction palette baked in (`combat_resolver_5` SL6/SL7). */
  private drawGlyph(
    g: Graphics,
    entry: AtlasEntry,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const r = Math.min(rect.width, rect.height) / 2 - 1.5;
    const ink = 0x14171c;
    g.circle(cx, cy, r)
      .fill({ color: entry.palette, alpha: 0.95 })
      .stroke({ width: 1.2, color: ink, alpha: 0.85 });
    switch (entry.unitType) {
      case "cavalry":
        g.moveTo(cx - r * 0.45, cy - r * 0.45)
          .lineTo(cx + r * 0.55, cy)
          .lineTo(cx - r * 0.45, cy + r * 0.45)
          .closePath()
          .fill({ color: 0xffffff, alpha: 0.85 });
        break;
      case "artillery":
        g.circle(cx, cy, r * 0.35).fill(ink);
        break;
      case "archer":
      case "skirmish":
        g.moveTo(cx, cy - r * 0.5)
          .lineTo(cx + r * 0.5, cy)
          .lineTo(cx, cy + r * 0.5)
          .lineTo(cx - r * 0.5, cy)
          .closePath()
          .fill({ color: 0xffffff, alpha: 0.78 });
        break;
      default:
        g.circle(cx, cy, r * 0.42).stroke({ width: 1, color: 0xffffff, alpha: 0.55 });
        break;
    }
    // Front facing chevron (+x)
    g.moveTo(cx + r + 1, cy)
      .lineTo(cx + r - 2.4, cy - 2)
      .lineTo(cx + r - 2.4, cy + 2)
      .closePath()
      .fill(0xffffff);
    void ATLAS_FRAME;
  }

  get selected(): ReadonlySet<string> {
    return this.selection;
  }

  /** Hit-test a world point to a unit id (works at every LOD). */
  hitTest(wx: number, wy: number, pool: ModelPool, radius = this.modelSize): string | null {
    return this.hash.unitAtPoint(wx, wy, this.unitRanges, pool, radius + 0.25);
  }

  /** Box-select units in a world rect (works at every LOD). */
  unitsInRect(rect: WorldRect, pool: ModelPool): Set<string> {
    return this.hash.unitsInRect(rect, this.unitRanges, pool);
  }

  /**
   * Refresh the layer from a pool snapshot (also the undo/resync path).
   * In realtime mode callers feed deltas to `hash.applyDelta` between syncs;
   * sync itself always reflects the pool it is handed.
   */
  sync(
    pool: ModelPool,
    units: readonly DrawableUnit[],
    camera: Camera,
    viewport: Viewport,
  ): ModelSyncStats {
    const t0 = performance.now();
    this.unitRanges = units.map((u) => ({ id: u.id, modelRange: u.modelRange }));
    this.hash.rebuild(pool);

    const rect: WorldRect = {
      x: camera.x - MODEL_MARGIN,
      y: camera.y - MODEL_MARGIN,
      width: viewport.width / camera.scale + MODEL_MARGIN * 2,
      height: viewport.height / camera.scale + MODEL_MARGIN * 2,
    };

    const lods = chooseUnitLods(units, camera.scale, this.lodState, this.thresholds, pool);

    let lod0Models = 0;
    let particleCount = 0;
    let lod1Units = 0;
    let culledUnits = 0;
    let drawableUnitsTotal = 0;
    const lod1Draw: DrawableUnit[] = [];
    const lod2Units = new Map<string, DrawableUnit[]>();
    const bboxes = new Map<string, BBox | null>();
    const unitCount = new Map<string, number>();
    const list: IParticle[] = this.particles.particleChildren;

    for (const unit of units) {
      if (!unit.modelRange) continue;
      drawableUnitsTotal++;
      unitCount.set(unit.id, unit.modelRange[1] - unit.modelRange[0]);
      const bbox = unitBBox(pool, unit.modelRange);
      bboxes.set(unit.id, bbox);
      if (!bbox || !bboxIntersects(bbox, rect)) {
        culledUnits++;
        continue;
      }
      const lod = lods.get(unit.id) ?? 1;
      if (lod === 0) {
        // per-unit model cull → particles written immediately (unit known here;
        // no per-model unit lookup, no allocation)
        this.scratch.length = 0;
        drawableModelIndices(pool, unit.modelRange, rect, this.scratch);
        lod0Models += this.scratch.length;
        particleCount = this.writeParticles(pool, unit, this.scratch, particleCount, list);
      } else if (lod === 1) {
        lod1Draw.push(unit);
        lod1Units++;
      } else {
        const bucket = lod2Units.get(unit.armyId);
        if (bucket) bucket.push(unit);
        else lod2Units.set(unit.armyId, [unit]);
      }
    }
    list.length = particleCount;

    this.syncBlocks(pool, lod1Draw, bboxes, camera);
    this.syncArmyMarkers(pool, lod2Units, bboxes, unitCount);
    this.syncSelection(units, lods, bboxes, camera, lod2Units);

    return {
      lod0Models,
      lod1Units,
      lod2Armies: lod2Units.size,
      culledUnits,
      totalUnits: drawableUnitsTotal,
      syncMs: performance.now() - t0,
    };
  }

  /** Write one unit's visible models into the shared particle pool. */
  private resolvePortraitTexture(tokenImg: string, color: number): Texture | null {
    const cacheKey = `${tokenImg}|${color}`;
    const existing = this.portraitTextures.get(cacheKey);
    if (existing && existing !== "loading" && existing !== "failed") return existing;
    if (existing === "loading" || existing === "failed") return null;
    if (
      typeof document === "undefined" ||
      typeof HTMLImageElement === "undefined"
    ) {
      this.portraitTextures.set(cacheKey, "failed");
      return null;
    }
    this.portraitTextures.set(cacheKey, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const s = 32;
        const r = 13;
        const canvas = document.createElement("canvas");
        canvas.width = s;
        canvas.height = s;
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) {
          this.portraitTextures.set(cacheKey, "failed");
          return;
        }
        const hex = `#${color.toString(16).padStart(6, "0")}`;
        ctx2d.beginPath();
        ctx2d.arc(s / 2, s / 2, r, 0, Math.PI * 2);
        ctx2d.fillStyle = "#14171c";
        ctx2d.fill();
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.arc(s / 2, s / 2, r - 1.5, 0, Math.PI * 2);
        ctx2d.clip();
        ctx2d.drawImage(img, s / 2 - r, s / 2 - r, r * 2, r * 2);
        ctx2d.restore();
        ctx2d.beginPath();
        ctx2d.arc(s / 2, s / 2, r - 0.8, 0, Math.PI * 2);
        ctx2d.strokeStyle = hex;
        ctx2d.lineWidth = 2.2;
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.moveTo(s / 2 + r + 2.2, s / 2);
        ctx2d.lineTo(s / 2 + r - 3, s / 2 - 3);
        ctx2d.lineTo(s / 2 + r - 3, s / 2 + 3);
        ctx2d.closePath();
        ctx2d.fillStyle = "#ffffff";
        ctx2d.fill();
        this.portraitTextures.set(cacheKey, Texture.from(canvas));
      } catch {
        this.portraitTextures.set(cacheKey, "failed");
      }
    };
    img.onerror = () => {
      this.portraitTextures.set(cacheKey, "failed");
    };
    img.src = tokenImg;
    return null;
  }

  private writeParticles(
    pool: ModelPool,
    unit: DrawableUnit,
    indices: readonly number[],
    start: number,
    list: IParticle[],
  ): number {
    // §7: unit portrait VTT token disc beats atlas frame, which beats tinted stand marker
    const portraitTexture = unit.tokenImg
      ? this.resolvePortraitTexture(unit.tokenImg, unit.color)
      : null;
    const atlasTexture =
      portraitTexture ??
      this.unitTextures.get(
        atlasKey({ unitType: unit.type, palette: unit.color }),
      );
    const texture = atlasTexture ?? this.standTexture;
    const scale = this.modelSize / texture.width;
    let n = start;
    for (let k = 0; k < indices.length; k++) {
      if (this.particlePool.length === n) {
        this.particlePool.push(new Particle({ texture }));
      }
      const idx = indices[k] ?? 0;
      const particle = this.particlePool[n];
      if (!particle) continue; // unreachable once pooled; satisfies the guard
      particle.texture = texture;
      particle.x = pool.x[idx] ?? 0;
      particle.y = pool.y[idx] ?? 0;
      particle.scaleX = scale;
      particle.scaleY = scale;
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;
      particle.rotation = ((pool.facing[idx] ?? 0) / 256) * Math.PI * 2;
      const status = pool.status[idx] ?? 0;
      particle.tint = atlasTexture ? 0xffffff : unit.color;
      particle.alpha =
        (status & ModelStatus.routed) !== 0
          ? 0.55
          : (status & ModelStatus.engaged) !== 0
            ? 0.85
            : 1;
      list[n] = particle;
      n++;
    }
    return n;
  }

  private syncBlocks(
    pool: ModelPool,
    units: readonly DrawableUnit[],
    bboxes: Map<string, BBox | null>,
    camera: Camera,
  ): void {
    const seen = new Set<string>();
    for (const unit of units) {
      seen.add(unit.id);
      const bbox = bboxes.get(unit.id);
      if (!bbox) continue;
      const frac = strengthFraction(pool, unit.modelRange);
      const zoomBucket = Math.max(1, Math.round(4 / camera.scale));
      const portraitTex =
        this.zoomOutUnitToken && unit.tokenImg
          ? this.resolvePortraitTexture(unit.tokenImg, unit.color)
          : null;
      const key = [
        Math.round(bbox.minX * 4),
        Math.round(bbox.minY * 4),
        Math.round(bbox.maxX * 4),
        Math.round(bbox.maxY * 4),
        Math.round(frac * 20),
        unit.color,
        this.selection.has(unit.id) ? 1 : 0,
        zoomBucket,
        portraitTex ? unit.tokenImg : "",
      ].join("|");
      let view = this.blocks.get(unit.id);
      if (!view) {
        const box = new Graphics();
        const banner = new Text({ text: "", style: { fontSize: 11, fill: 0xf2f4f8 } });
        banner.anchor.set(0.5);
        this.blocksLayer.addChild(box, banner);
        view = { box, banner, key: "", bbox };
        this.blocks.set(unit.id, view);
      }
      view.bbox = bbox;
      if (view.key !== key) {
        view.key = key;
        this.drawBlock(view, unit, frac, camera, portraitTex);
      }
    }
    for (const [id, view] of this.blocks) {
      if (!seen.has(id)) {
        this.blocks.delete(id);
        view.portrait?.destroy();
        view.box.destroy();
        view.banner.destroy();
      }
    }
  }

  private drawBlock(
    view: UnitBlockView,
    unit: DrawableUnit,
    frac: number,
    camera: Camera,
    portraitTex: Texture | null,
  ): void {
    const { minX, minY, maxX, maxY } = view.bbox;
    const pad = 0.6;
    const selected = this.selection.has(unit.id);
    const barH = Math.max(0.35, 1.6 / camera.scale);
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    view.box
      .clear()
      .roundRect(minX - pad, minY - pad, w, h, 0.8)
      .fill({ color: unit.color, alpha: portraitTex ? 0.14 : 0.28 })
      .stroke({
        width: (selected ? 2.5 : 1.2) / camera.scale,
        color: unit.color,
        alpha: selected ? 1 : 0.9,
      });
    if (portraitTex) {
      if (!view.portrait) {
        view.portrait = new Sprite(portraitTex);
        view.portrait.anchor.set(0.5);
        this.blocksLayer.addChild(view.portrait);
      } else {
        view.portrait.texture = portraitTex;
        view.portrait.visible = true;
      }
      const unitDiam = Math.max(4, Math.min(Math.max(w, h) * 0.95, Math.min(w, h) * 1.35));
      const minScreenWorld = 24 / camera.scale;
      const diam = Math.max(unitDiam, minScreenWorld);
      view.portrait.position.set(cx, cy);
      view.portrait.width = diam;
      view.portrait.height = diam;
    } else if (view.portrait) {
      view.portrait.visible = false;
    }
    // strength bar: green → red by alive fraction
    const green = Math.round(0xff * Math.min(1, frac * 2));
    const red = Math.round(0xff * Math.max(0, frac * 2 - 1));
    const barColor = (red << 16) | (green << 8);
    const barW = w;
    view.box
      .rect(minX - pad, minY - pad - barH * 1.8, barW * Math.max(0, Math.min(1, frac)), barH)
      .fill(barColor)
      .rect(minX - pad, minY - pad - barH * 1.8, barW, barH)
      .stroke({ width: 0.6 / camera.scale, color: 0x000000, alpha: 0.5 });
    view.banner.text = unit.name.slice(0, 12);
    view.banner.style.fontSize = 11 / camera.scale;
    view.banner.position.set((minX + maxX) / 2, maxY + 6 / camera.scale);
  }

  private syncArmyMarkers(
    pool: ModelPool,
    armies: Map<string, DrawableUnit[]>,
    bboxes: Map<string, BBox | null>,
    unitCount: Map<string, number>,
  ): void {
    const seen = new Set<string>();
    for (const [armyId, units] of armies) {
      seen.add(armyId);
      let sx = 0;
      let sy = 0;
      let w = 0;
      let aliveTotal = 0;
      let color = 0x9aa0a8;
      let name = armyId;
      for (const unit of units) {
        const bbox = bboxes.get(unit.id);
        if (!bbox) continue;
        const weight = Math.max(1, unitCount.get(unit.id) ?? 1);
        sx += ((bbox.minX + bbox.maxX) / 2) * weight;
        sy += ((bbox.minY + bbox.maxY) / 2) * weight;
        w += weight;
        aliveTotal += strengthFraction(pool, unit.modelRange) * weight;
        color = unit.color;
        name = unit.armyName;
      }
      if (w === 0) continue;
      const cx = sx / w;
      const cy = sy / w;
      const key = [Math.round(cx), Math.round(cy), Math.round(aliveTotal), color].join("|");
      let view = this.armyMarkers.get(armyId);
      if (!view) {
        const g = new Graphics();
        const label = new Text({ text: "", style: { fontSize: 12, fill: 0xf2f4f8 } });
        label.anchor.set(0.5);
        this.blocksLayer.addChild(g, label);
        view = { g, label, key: "" };
        this.armyMarkers.set(armyId, view);
      }
      if (view.key !== key) {
        view.key = key;
        const anySelected = units.some((u) => this.selection.has(u.id));
        view.g
          .clear()
          .circle(cx, cy, 6)
          .fill({ color, alpha: 0.85 })
          .stroke({
            width: anySelected ? 2.5 : 1.25,
            color: 0xffffff,
            alpha: anySelected ? 1 : 0.7,
          });
        view.label.text = `${name} · ${Math.round(aliveTotal)}`;
        view.label.position.set(cx, cy - 14);
      }
    }
    for (const [id, view] of this.armyMarkers) {
      if (!seen.has(id)) {
        this.armyMarkers.delete(id);
        view.g.destroy();
        view.label.destroy();
      }
    }
  }

  /** Selection rings work at every LOD (§9A). */
  private syncSelection(
    units: readonly DrawableUnit[],
    lods: Map<string, number>,
    bboxes: Map<string, BBox | null>,
    camera: Camera,
    lod2Units: Map<string, DrawableUnit[]>,
  ): void {
    const g = this.selectionGraphics();
    g.clear();
    const lw = 1.5 / camera.scale;
    for (const unit of units) {
      if (!this.selection.has(unit.id)) continue;
      const lod = lods.get(unit.id) ?? 1;
      const bbox = bboxes.get(unit.id);
      if (lod === 2) {
        // ring the army marker of the unit's army
        const peers = lod2Units.get(unit.armyId);
        if (!peers || peers.length === 0) continue;
        let sx = 0;
        let sy = 0;
        let w = 0;
        for (const peer of peers) {
          const b = bboxes.get(peer.id);
          if (!b) continue;
          const weight = Math.max(1, (peer.modelRange?.[1] ?? 1) - (peer.modelRange?.[0] ?? 0));
          sx += ((b.minX + b.maxX) / 2) * weight;
          sy += ((b.minY + b.maxY) / 2) * weight;
          w += weight;
        }
        if (w > 0) g.circle(sx / w, sy / w, 10).stroke({ width: lw, color: 0x53b7ff, alpha: 0.95 });
        continue;
      }
      if (!bbox) continue;
      const pad = 1.2;
      g.roundRect(
        bbox.minX - pad,
        bbox.minY - pad,
        bbox.maxX - bbox.minX + pad * 2,
        bbox.maxY - bbox.minY + pad * 2,
        1,
      ).stroke({ width: lw, color: 0x53b7ff, alpha: 0.95 });
    }
  }

  private selectionGraphics(): Graphics {
    let g = this.selectionLayer.getChildByLabel("selection") as Graphics | null;
    if (!g) {
      g = new Graphics();
      g.label = "selection";
      this.selectionLayer.addChild(g);
    }
    return g;
  }

  destroy(): void {
    for (const tex of this.portraitTextures.values()) {
      if (tex !== "loading" && tex !== "failed") tex.destroy(true);
    }
    this.portraitTextures.clear();
    for (const base of this.atlasBases.values()) base.destroy(true);
    this.atlasBases.clear();
    this.unitTextures.clear();
    this.keyAtlas.clear();
    this.boundAtlasIds = [];
    this.container.destroy({ children: true });
    this.particlePool.length = 0;
    this.blocks.clear();
    this.armyMarkers.clear();
  }
}
