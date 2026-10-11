/**
 * §9 tiles (D-083): floor tiles below the grid, overhead tiles (roofs) above
 * the tokens layer. Textures load through an injected port (asset hash → Texture) with a
 * deterministic tinted-rect placeholder until (or instead of) the image.
 *
 * D-438 roofs: `resolveRoofs` (core/roofs.ts) decides each overhead tile's state from the
 * viewers' token centres, the GM's hover point and the current vision polygons. This layer only
 * draws that state:
 * - a whole-tile alpha;
 * - openings: an inverse mask on the tile plus a masked copy at the occlusion alpha (WebGL
 *   only, so Canvas2D never gets holes);
 * - a G-24 copy in the container above the fog.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { RotationAnimation } from "../rotationAnimation";
import { MovementAnimation, movementDuration } from "../movementAnimation";
import type { RegionDocument, TileDocument } from "../../core/documents";
import { regionGeometryError, regionTriggerTile } from "../../core/regionGeometry";
import { tileTriggerLocalPolygon, tileTriggerZoneError } from "../../core/tileTriggerZone";
import { ROOF_IDLE, resolveRoofs, roofStateKey, type RoofArtMask, type RoofHoles, type RoofPoint, type RoofState } from "../../core/roofs";
import { tileTint, type TileRect } from "../ephemera";
import { roofArtMaskFromTexture } from "../roofArt";
import { lowerFloorTint } from "../../core/levelPlay";

export interface TilesLayerOptions {
  /** Asset hash/URL → texture; null/undefined keeps the tinted placeholder. */
  loadTexture?: (img: string) => Promise<Texture | null>;
}

/** D-438: per-sync roof inputs that are not tiles. */
export interface RoofSyncOptions {
  /** Scene grid size in px: the unit of the radial opening radius. */
  gridSize?: number;
}

/** e2e/test readback of what a roof is drawing. */
export interface RoofReadback {
  alpha: number;
  holes: "none" | "circles" | "vision";
  openings: number;
  holeAlpha: number;
  under: boolean;
  linked: boolean;
  reveal: boolean;
  /** The "under" test used the tile's art. */
  art: boolean;
}

interface TileView {
  tile: TileDocument;
  movement: MovementAnimation;
  rotation: RotationAnimation;
  g: Graphics;
  sprite: Sprite | null;
  loadRevision: number;
  loadedImage: string | null;
  /** Last computed occlusion alpha (readback + sprite path). */
  alpha: number;
  /** D-438: the roof state this view last drew. */
  roofKey: string;
  holeMask: Graphics | null;
  holeTarget: Container | null;
  /** The openings' copy at the occlusion alpha, clipped to `innerMask`. */
  inner: Container | null;
  innerMask: Graphics | null;
  /** G-24: the copy drawn above the fog. */
  fogCopy: Container | null;
  /** Geometry/texture key the copies were built for. */
  copyKey: string;
}

export class TilesLayer {
  private readonly below: Container;
  private readonly above: Container;
  private readonly opts: TilesLayerOptions;
  private readonly views = new Map<string, TileView>();
  private readonly regionViews = new Map<string, Graphics>();
  private readonly movementMedia = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  /** G-24: the container above the fog; null disables reveal copies. */
  private readonly overFog: Container | null;
  /** G-26: the renderer has inverse stencil masks (Canvas2D does not). */
  private readonly masks: boolean;
  private occupied: readonly TileRect[] = [];
  private gridSize = 100;
  private vision: readonly Float32Array[] = [];
  private hover: RoofPoint | null = null;
  private hoverFade = false;
  private roofs = new Map<string, RoofState>();
  /** Art alpha by loaded image (null = unreadable; falls back to zone/rectangle). */
  private readonly art = new Map<string, RoofArtMask | null>();

  constructor(below: Container, above: Container, options: TilesLayerOptions = {},
    roof: { overFog?: Container | null; inverseMasks?: boolean } = {}) {
    this.below = below;
    this.above = above;
    this.opts = options;
    this.overFog = roof.overFog ?? null;
    this.masks = roof.inverseMasks ?? false;
    this.lower = new Container();
    this.lower.label = "lowerFloors";
    this.lower.sortableChildren = true;
  }

  /**
   * G-19 (D-443): art of the floors seen beneath the current one (tile id → depth). These tiles
   * are drawn first, deepest at the bottom, dimmed by depth, as plain art: never roofs, triggers
   * or outlines. Call before `sync`.
   */
  private readonly lower: Container;
  private lowerDepth: ReadonlyMap<string, number> = new Map();
  setLowerFloors(depths: ReadonlyMap<string, number>): void { this.lowerDepth = depths; }
  /** The container sits at the bottom of the tiles-below layer only while it holds lower-floor art. */
  private placeLower(): void {
    if (this.lower.children.length && this.lower.parent !== this.below) this.below.addChildAt(this.lower, 0);
    else if (!this.lower.children.length && this.lower.parent) this.lower.parent.removeChild(this.lower);
  }
  /** Readback: the lower-floor tiles currently drawn, with their depth. */
  lowerFloorTiles(): Array<{ id: string; depth: number }> {
    return [...this.views.keys()].filter((id) => this.lowerDepth.has(id)).sort().map((id) => ({ id, depth: this.lowerDepth.get(id) as number }));
  }
  /** A lower floor's roof is just art seen from above. */
  private effective(tile: TileDocument): TileDocument {
    return tile.above && this.lowerDepth.has(tile._id) ? { ...tile, above: false } : tile;
  }
  private styleLower(view: TileView): void {
    const depth = this.lowerDepth.get(view.tile._id);
    const tint = depth === undefined ? 0xffffff : lowerFloorTint(depth);
    const z = depth === undefined ? 0 : -depth;
    for (const node of [view.sprite, view.g]) if (node) { node.tint = tint; node.zIndex = z; }
  }

  /** G-12 (D-434): tiles of other floors drawn faintly in the GM's "ghost" floor view. */
  private ghosts: ReadonlySet<string> = new Set();
  private ghostAlpha = 0.25;
  setGhosts(ids: ReadonlySet<string>, alpha = 0.25): void {
    this.ghosts = ids;
    this.ghostAlpha = alpha;
  }
  /** D-372/A41: count the live tile views and successfully decoded image sprites. */
  get count(): number { return this.views.size; }
  get renderedImageCount(): number {
    let count = 0;
    for (const view of this.views.values()) if (view.sprite) count += 1;
    return count;
  }

  /**
   * Reconcile tile views. `occupied` are the rects of the viewer's own vision tokens: a roof opens
   * for a token whose centre is under it (D-438).
   */
  sync(input: readonly TileDocument[], occupied: readonly TileRect[], regions: readonly RegionDocument[] = [],
    roof: RoofSyncOptions = {}): void {
    this.occupied = occupied;
    if (roof.gridSize !== undefined && Number.isFinite(roof.gridSize) && roof.gridSize > 0) this.gridSize = roof.gridSize;
    const seen = new Set<string>();
    const tiles = input.map((tile) => this.effective(tile));
    for (const tile of tiles) {
      seen.add(tile._id);
      let view = this.views.get(tile._id);
      if (!view) {
        const g = new Graphics();
        const fresh: TileView = { tile, movement: new MovementAnimation(), rotation: new RotationAnimation(), g, sprite: null,
          loadRevision: 0, loadedImage: null, alpha: 1, roofKey: "", holeMask: null, holeTarget: null, inner: null,
          innerMask: null, fogCopy: null, copyKey: "" };
        this.views.set(tile._id, fresh);
        this.containerFor(tile).addChild(g);
        this.maybeLoadTexture(fresh);
        view = fresh;
      }
      const changed = view.tile.img !== tile.img;
      if (view.tile.above !== tile.above) this.clearRoofExtras(view);
      view.tile = tile;
      if (changed) {
        view.loadRevision++;
        this.clearRoofExtras(view);
        view.sprite?.destroy();
        view.sprite = null;
        view.loadedImage = null;
        this.maybeLoadTexture(view);
      }
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.detach(view);
        this.views.delete(id);
      }
    }
    this.roofs = this.resolve();
    for (const tile of tiles) {
      const view = this.views.get(tile._id);
      if (view) this.draw(view);
    }
    this.placeLower();
    const images = new Set([...this.views.values()].map((view) => view.loadedImage));
    for (const image of this.art.keys()) if (!images.has(image)) this.art.delete(image);
    this.syncRegions(regions);
  }

  /** G-24/G-26: the viewer's current vision polygons (flat world coordinates); [] = no live sight. */
  setVision(polys: readonly Float32Array[]): void {
    if (polys.length === 0 && this.vision.length === 0) return;
    this.vision = [...polys];
    this.visionRevision++;
    this.refreshRoofs();
  }

  /** G-26c: GM-local "peek under roofs": the pointer opens the roof it is over. */
  setHoverFade(enabled: boolean): void {
    if (this.hoverFade === enabled) return;
    this.hoverFade = enabled;
    this.refreshRoofs();
  }

  setHover(point: RoofPoint | null): void {
    if (point === this.hover || (point && this.hover && point.x === this.hover.x && point.y === this.hover.y)) return;
    this.hover = point ? { x: point.x, y: point.y } : null;
    if (this.hoverFade) this.refreshRoofs();
  }

  /** What a roof is drawing (e2e readback); null for an unknown tile. */
  roofStateOf(tileId: string): RoofReadback | null {
    const view = this.views.get(tileId);
    if (!view) return null;
    const state = this.roofs.get(tileId) ?? ROOF_IDLE;
    return {
      alpha: view.alpha,
      holes: state.holes?.kind ?? "none",
      openings: !state.holes ? 0 : state.holes.kind === "circles" ? state.holes.circles.length : this.vision.length,
      holeAlpha: state.holeAlpha,
      under: state.under,
      linked: state.linked,
      reveal: state.reveal && !!view.fogCopy,
      art: !!this.artFor(view.tile),
    };
  }

  private resolve(): Map<string, RoofState> {
    const tiles = [...this.views.values()].map((view) => view.tile);
    if (!tiles.some((tile) => tile.above)) return new Map();
    return resolveRoofs(tiles, {
      viewers: this.occupied.map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })),
      hover: this.hoverFade ? this.hover : null,
      vision: this.vision,
      gridSize: this.gridSize,
      masks: this.masks,
      art: (tile) => this.artFor(tile),
    });
  }

  /** Re-resolve after a non-document input changed; redraw only the roofs whose state moved. */
  private refreshRoofs(): void {
    const next = this.resolve();
    this.roofs = next;
    for (const view of this.views.values()) {
      if (!view.tile.above && !view.roofKey) continue;
      const state = next.get(view.tile._id) ?? ROOF_IDLE;
      if (this.roofKeyOf(view, state) !== view.roofKey) this.applyRoof(view, state);
    }
  }

  private artFor(tile: TileDocument): RoofArtMask | null {
    if (!tile.above) return null;
    const view = this.views.get(tile._id);
    const image = view?.sprite ? view.loadedImage : null;
    if (!view?.sprite || !image) return null;
    if (!this.art.has(image)) this.art.set(image, roofArtMaskFromTexture(view.sprite.texture));
    return this.art.get(image) ?? null;
  }

  private syncRegions(regions: readonly RegionDocument[]): void {
    const seen = new Set<string>();
    for (const region of regions) {
      if (regionGeometryError(region)) continue;
      seen.add(region._id);
      let graphics = this.regionViews.get(region._id);
      if (!graphics) {
        graphics = new Graphics();
        graphics.label = `region:${region._id}`;
        this.regionViews.set(region._id, graphics);
        this.below.addChild(graphics);
      }
      const tile = regionTriggerTile(region);
      const polygon = tileTriggerLocalPolygon(tile);
      if (!polygon) continue;
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      graphics.clear();
      graphics.pivot.set(cx, cy);
      graphics.position.set(cx, cy);
      graphics.rotation = (region.rotation ?? 0) * Math.PI / 180;
      graphics.poly(polygon.flatMap(({ x, y }) => [x, y]))
        .fill({ color: 0x54d6c7, alpha: 0.035 })
        .stroke({ width: 2, color: 0x54d6c7, alpha: 0.75 });
    }
    for (const [id, graphics] of this.regionViews) {
      if (seen.has(id)) continue;
      graphics.parent?.removeChild(graphics);
      graphics.destroy();
      this.regionViews.delete(id);
    }
  }

  /** Current occlusion alpha per tile id (e2e readback). */
  alphaOf(tileId: string): number | null {
    const view = this.views.get(tileId);
    return view ? view.alpha : null;
  }

  /** What is actually drawable, not the desired document image (null while loading). */
  imageOf(tileId: string): string | null {
    const view = this.views.get(tileId);
    return view?.sprite ? view.loadedImage : null;
  }

  private containerFor(tile: TileDocument): Container {
    return this.lowerDepth.has(tile._id) ? this.lower : tile.above ? this.above : this.below;
  }

  private detach(view: TileView): void {
    view.loadRevision++;
    this.clearRoofExtras(view);
    if (view.sprite) {
      this.containerFor(view.tile).removeChild(view.sprite);
      view.sprite.destroy();
      view.sprite = null;
    }
    this.containerFor(view.tile).removeChild(view.g);
    view.g.destroy();
  }

  private maybeLoadTexture(view: TileView): void {
    const loader = this.opts.loadTexture;
    if (!loader || !view.tile.img) return;
    const image = view.tile.img;
    const revision = ++view.loadRevision;
    void loader(image)
      .then((texture) => {
        if (!texture || this.views.get(view.tile._id) !== view || view.loadRevision !== revision) return;
        if (view.sprite) return; // already loaded
        const sprite = new Sprite(texture);
        sprite.label = "tileImg";
        this.containerFor(view.tile).addChild(sprite);
        view.sprite = sprite;
        view.loadedImage = image;
        // The load may finish between replica updates: position and size it now,
        // rather than leaving a 1px sprite at (0,0) until the next world op.
        sprite.anchor.set(0.5);
        const position = view.movement.sample(performance.now()) ?? { x: view.tile.x + view.tile.width / 2, y: view.tile.y + view.tile.height / 2 };
        sprite.position.set(position.x, position.y);
        sprite.width = view.tile.width; sprite.height = view.tile.height;
        sprite.rotation = view.rotation.sample(performance.now()) * Math.PI / 180;
        sprite.alpha = view.alpha;
        view.g.clear();
        if (!this.lowerDepth.has(view.tile._id)) this.drawAdornment(view);
        this.containerFor(view.tile).addChild(view.g); // trigger outline above the loaded image
        this.styleLower(view);
        this.placeLower();
        // D-438: the art now decides "under", and openings/copies move onto the sprite.
        this.clearRoofExtras(view);
        if (view.tile.above) this.refreshRoofs();
      })
      .catch(() => undefined);
  }

  private draw(view: TileView): void {
    const { tile } = view;
    const state = this.roofs.get(tile._id) ?? ROOF_IDLE;
    const alpha = state.alpha * (this.ghosts.has(tile._id) ? this.ghostAlpha : 1);
    view.alpha = alpha;
    const parent = this.containerFor(tile);
    if (view.g.parent !== parent) parent.addChild(view.g);
    const cx = tile.x + tile.width / 2;
    const cy = tile.y + tile.height / 2;
    const cut = this.movementMedia?.matches === true;
    const drawn = view.sprite ?? view.g;
    view.movement.update({ x: cx, y: cy }, { x: drawn.x, y: drawn.y }, cut ? 0 : movementDuration(tile), performance.now(), JSON.stringify(tile.flags.arenaMove ?? null));
    if (cut) view.movement.cancel();
    const position = view.movement.sample(performance.now()) ?? { x: cx, y: cy };
    const angle = view.rotation.update(tile, performance.now(), cut) * Math.PI / 180;
    view.g.alpha = alpha; // placeholder path: whole-view fade (readback honest)
    view.g.pivot.set(cx, cy);
    view.g.position.set(position.x, position.y);
    view.g.rotation = angle;
    if (view.sprite) {
      if (view.sprite.parent !== parent) parent.addChild(view.sprite);
      parent.addChild(view.g); // outlines stay above tile art
      view.sprite.anchor.set(0.5);
      view.sprite.position.set(position.x, position.y);
      view.sprite.width = tile.width;
      view.sprite.height = tile.height;
      view.sprite.rotation = angle;
      view.sprite.alpha = alpha;
      view.g.clear();
      // Roof and trigger outlines stay visible even with a texture (not on art seen below).
      if (!this.lowerDepth.has(tile._id)) this.drawAdornment(view);
    } else {
      view.g.clear();
      this.drawPlaceholder(view.g, tile);
      if (!this.lowerDepth.has(tile._id)) this.drawAdornment(view);
    }
    this.styleLower(view);
    this.applyRoof(view, state);
  }

  /** The imageless look: the trigger mask, the trigger polygon or the rectangle, tinted. */
  private drawPlaceholder(g: Graphics, tile: TileDocument): void {
    const triggerPoints = tile.triggerZone ? tileTriggerLocalPolygon(tile) : null;
    const points = triggerPoints?.flatMap(({ x, y }) => [x, y]);
    const mask = tile.triggerZone?.kind === "alpha" && tileTriggerZoneError(tile.triggerZone) === null
      ? tile.triggerZone : null;
    if (mask) {
      for (let row = 0; row < mask.height; row++) for (const [start, end] of mask.rows[row] ?? []) {
        g.rect(tile.x + start * tile.width / mask.width, tile.y + row * tile.height / mask.height,
          (end - start) * tile.width / mask.width, tile.height / mask.height)
          .fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 });
      }
    } else if (points) {
      g.poly(points).fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 });
    } else {
      g.rect(tile.x, tile.y, tile.width, tile.height)
        .fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.15 });
    }
  }

  private roofKeyOf(view: TileView, state: RoofState): string {
    const ghost = this.ghosts.has(view.tile._id) ? this.ghostAlpha : 1;
    const holes = state.holes?.kind === "vision" ? `:${this.vision.length}:${this.visionRevision}` : "";
    return `${roofStateKey(state)}${holes}|${ghost}|${view.sprite ? 1 : 0}`;
  }

  private visionRevision = 0;

  /** D-438: draw a roof state: alpha, openings and the copy above the fog. */
  private applyRoof(view: TileView, state: RoofState): void {
    const ghost = this.ghosts.has(view.tile._id) ? this.ghostAlpha : 1;
    view.alpha = state.alpha * ghost;
    view.g.alpha = view.alpha;
    if (view.sprite) view.sprite.alpha = view.alpha;
    view.roofKey = view.tile.above || state !== ROOF_IDLE ? this.roofKeyOf(view, state) : "";
    if (!state.holes && !state.reveal && !view.holeMask && !view.inner && !view.fogCopy) return;
    const copyKey = `${view.sprite ? `s:${view.loadedImage ?? ""}` : `g:${view.tile.x},${view.tile.y}`}:${view.tile.width}x${view.tile.height}:` +
      `${view.tile.img}:${JSON.stringify(view.tile.triggerZone ?? null)}`;
    if (copyKey !== view.copyKey) {
      this.clearCopies(view);
      view.copyKey = copyKey;
    }
    const parent = this.containerFor(view.tile);
    const drawn: Container = view.sprite ?? view.g;
    if (state.holes) {
      if (view.holeTarget && view.holeTarget !== drawn) this.unmask(view.holeTarget);
      const hole = view.holeMask ?? new Graphics();
      if (!view.holeMask) {
        hole.label = `roofHole:${view.tile._id}`;
        parent.addChild(hole);
        view.holeMask = hole;
      }
      hole.clear();
      this.drawHoles(hole, state.holes);
      drawn.setMask({ mask: hole, inverse: true });
      view.holeTarget = drawn;
      const innerAlpha = state.holeAlpha * ghost;
      if (innerAlpha > 0) {
        const inner = view.inner ?? this.makeCopy(view, "roofOpening");
        const innerMask = view.innerMask ?? new Graphics();
        if (!view.innerMask) {
          innerMask.label = `roofOpeningMask:${view.tile._id}`;
          parent.addChild(innerMask);
          view.innerMask = innerMask;
        }
        innerMask.clear();
        this.drawHoles(innerMask, state.holes);
        if (inner.parent !== parent) parent.addChildAt(inner, Math.min(parent.children.length, parent.getChildIndex(drawn) + 1));
        view.inner = inner;
        inner.mask = innerMask;
        inner.alpha = innerAlpha;
        this.placeCopy(view, inner);
      } else this.clearInner(view);
    } else this.clearHoles(view);
    if (state.reveal && this.overFog) {
      const copy = view.fogCopy ?? this.makeCopy(view, "roofOverFog");
      if (copy.parent !== this.overFog) this.overFog.addChild(copy);
      view.fogCopy = copy;
      copy.alpha = view.alpha;
      this.placeCopy(view, copy);
    } else if (view.fogCopy) {
      view.fogCopy.parent?.removeChild(view.fogCopy);
      view.fogCopy.destroy();
      view.fogCopy = null;
    }
  }

  private drawHoles(g: Graphics, holes: RoofHoles): void {
    if (holes.kind === "circles") {
      for (const circle of holes.circles) g.circle(circle.x, circle.y, circle.r).fill(0xffffff);
      return;
    }
    for (const poly of this.vision) if (poly.length >= 6) g.poly(Array.from(poly)).fill(0xffffff);
  }

  private makeCopy(view: TileView, label: string): Container {
    if (view.sprite) {
      const sprite = new Sprite(view.sprite.texture);
      sprite.anchor.set(0.5);
      sprite.label = `${label}:${view.tile._id}`;
      return sprite;
    }
    const g = new Graphics();
    g.label = `${label}:${view.tile._id}`;
    this.drawPlaceholder(g, view.tile);
    return g;
  }

  private placeCopy(view: TileView, copy: Container): void {
    if (view.sprite && copy instanceof Sprite) {
      copy.position.set(view.sprite.x, view.sprite.y);
      copy.width = view.tile.width;
      copy.height = view.tile.height;
      copy.rotation = view.sprite.rotation;
      return;
    }
    copy.pivot.set(view.g.pivot.x, view.g.pivot.y);
    copy.position.set(view.g.x, view.g.y);
    copy.rotation = view.g.rotation;
  }

  private unmask(target: Container): void {
    if (target.destroyed) return;
    target.mask = null;
    target.setMask({ inverse: false });
  }

  private clearInner(view: TileView): void {
    if (view.inner) {
      view.inner.mask = null;
      view.inner.parent?.removeChild(view.inner);
      view.inner.destroy();
      view.inner = null;
    }
    if (view.innerMask) {
      view.innerMask.parent?.removeChild(view.innerMask);
      view.innerMask.destroy();
      view.innerMask = null;
    }
  }

  private clearHoles(view: TileView): void {
    if (view.holeTarget) this.unmask(view.holeTarget);
    view.holeTarget = null;
    if (view.holeMask) {
      view.holeMask.parent?.removeChild(view.holeMask);
      view.holeMask.destroy();
      view.holeMask = null;
    }
    this.clearInner(view);
  }

  private clearCopies(view: TileView): void {
    this.clearInner(view);
    if (view.fogCopy) {
      view.fogCopy.parent?.removeChild(view.fogCopy);
      view.fogCopy.destroy();
      view.fogCopy = null;
    }
  }

  private clearRoofExtras(view: TileView): void {
    this.clearHoles(view);
    this.clearCopies(view);
    view.copyKey = "";
    view.roofKey = "";
  }

  private drawAdornment(view: TileView): void {
    const { tile, g } = view;
    if (tile.above) {
      g.rect(tile.x, tile.y, tile.width, tile.height)
        .stroke({ width: 1, color: 0xffd166, alpha: 0.25 });
    }
    if (tile.triggerZone?.kind === "polygon") {
      const points = tileTriggerLocalPolygon(tile)?.flatMap(({ x, y }) => [x, y]);
      if (points) g.poly(points).stroke({ width: 2, color: 0xffd166, alpha: 0.95 });
    } else if (tile.triggerZone?.kind === "alpha" && tileTriggerZoneError(tile.triggerZone) === null && view.sprite) {
      const mask = tile.triggerZone;
      for (let row = 0; row < mask.height; row++) for (const [start, end] of mask.rows[row] ?? []) {
        g.rect(tile.x + start * tile.width / mask.width, tile.y + row * tile.height / mask.height,
          (end - start) * tile.width / mask.width, tile.height / mask.height)
          .fill({ color: 0xffd166, alpha: 0.22 });
      }
    }
  }

  /** Shared stage ticker; update transforms only, never world documents. */
  tick(now = performance.now()): void {
    for (const view of this.views.values()) {
      if (this.movementMedia?.matches === true) view.rotation.cancel();
      const angle = view.rotation.sample(now) * Math.PI / 180;
      view.g.rotation = angle;
      if (view.sprite) view.sprite.rotation = angle;
      if (this.movementMedia?.matches === true) {
        view.movement.cancel();
        const x = view.tile.x + view.tile.width / 2, y = view.tile.y + view.tile.height / 2;
        view.g.position.set(x, y); view.sprite?.position.set(x, y);
        if (view.inner) this.placeCopy(view, view.inner);
        if (view.fogCopy) this.placeCopy(view, view.fogCopy);
        continue;
      }
      const point = view.movement.sample(now);
      if (point) { view.g.position.set(point.x, point.y); view.sprite?.position.set(point.x, point.y); }
      if (view.inner) this.placeCopy(view, view.inner);
      if (view.fogCopy) this.placeCopy(view, view.fogCopy);
    }
  }

  destroy(): void {
    for (const view of this.views.values()) this.detach(view);
    this.views.clear();
    this.lower.parent?.removeChild(this.lower);
    this.lower.destroy();
    for (const graphics of this.regionViews.values()) {
      graphics.parent?.removeChild(graphics);
      graphics.destroy();
    }
    this.regionViews.clear();
  }
}
