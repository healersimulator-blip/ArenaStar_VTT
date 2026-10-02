/**
 * §9 tiles (D-083): floor tiles below the grid, overhead tiles (roofs) above
 * the tokens layer. Occlusion (roof/fade) is the pure rule from ephemera.ts;
 * textures load through an injected port (asset hash → Texture) with a
 * deterministic tinted-rect placeholder until (or instead of) the image.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { RotationAnimation } from "../rotationAnimation";
import { MovementAnimation, movementDuration } from "../movementAnimation";
import type { RegionDocument, TileDocument } from "../../core/documents";
import { regionGeometryError, regionTriggerTile } from "../../core/regionGeometry";
import { tileTriggerLocalPolygon, tileTriggerZoneError } from "../../core/tileTriggerZone";
import { rectsOverlap, tileAlpha, tileTint, type TileRect } from "../ephemera";

export interface TilesLayerOptions {
  /** Asset hash/URL → texture; null/undefined keeps the tinted placeholder. */
  loadTexture?: (img: string) => Promise<Texture | null>;
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
}

export class TilesLayer {
  private readonly below: Container;
  private readonly above: Container;
  private readonly opts: TilesLayerOptions;
  private readonly views = new Map<string, TileView>();
  private readonly regionViews = new Map<string, Graphics>();
  private readonly movementMedia = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

  constructor(below: Container, above: Container, options: TilesLayerOptions = {}) {
    this.below = below;
    this.above = above;
    this.opts = options;
  }

  /** D-372/A41: count the live tile views and successfully decoded image sprites. */
  get count(): number { return this.views.size; }
  get renderedImageCount(): number {
    let count = 0;
    for (const view of this.views.values()) if (view.sprite) count += 1;
    return count;
  }

  /**
   * Reconcile tile views; `occupied` are rects of tokens with vision (roof
   * tiles over one of them fade to their occlusion alpha).
   */
  sync(tiles: readonly TileDocument[], occupied: readonly TileRect[], regions: readonly RegionDocument[] = []): void {
    const seen = new Set<string>();
    for (const tile of tiles) {
      seen.add(tile._id);
      let view = this.views.get(tile._id);
      if (!view) {
        const g = new Graphics();
        const fresh: TileView = { tile, movement: new MovementAnimation(), rotation: new RotationAnimation(), g, sprite: null, loadRevision: 0, loadedImage: null, alpha: 1 };
        this.views.set(tile._id, fresh);
        this.containerFor(tile).addChild(g);
        this.maybeLoadTexture(fresh);
        view = fresh;
      }
      const changed = view.tile.img !== tile.img;
      view.tile = tile;
      if (changed) {
        view.loadRevision++;
        view.sprite?.destroy();
        view.sprite = null;
        view.loadedImage = null;
        this.maybeLoadTexture(view);
      }
      this.draw(view, occupied);
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.detach(view);
        this.views.delete(id);
      }
    }
    this.syncRegions(regions);
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
    return tile.above ? this.above : this.below;
  }

  private detach(view: TileView): void {
    view.loadRevision++;
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
        this.drawAdornment(view);
        this.containerFor(view.tile).addChild(view.g); // trigger outline above the loaded image
      })
      .catch(() => undefined);
  }

  private draw(view: TileView, occupied: readonly TileRect[]): void {
    const { tile } = view;
    const rect: TileRect = { x: tile.x, y: tile.y, width: tile.width, height: tile.height };
    const occupiedUnder = occupied.some((o) => rectsOverlap(rect, o));
    const alpha = tileAlpha(tile, occupiedUnder);
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
      // Roof and trigger outlines stay visible even with a texture.
      this.drawAdornment(view);
      return;
    }
    view.g.clear();
    const triggerPoints = tile.triggerZone ? tileTriggerLocalPolygon(tile) : null;
    const points = triggerPoints?.flatMap(({ x, y }) => [x, y]);
    const mask = tile.triggerZone?.kind === "alpha" && tileTriggerZoneError(tile.triggerZone) === null
      ? tile.triggerZone : null;
    if (mask) {
      for (let row = 0; row < mask.height; row++) for (const [start, end] of mask.rows[row] ?? []) {
        view.g.rect(tile.x + start * tile.width / mask.width, tile.y + row * tile.height / mask.height,
          (end - start) * tile.width / mask.width, tile.height / mask.height)
          .fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 });
      }
    } else if (points) {
      view.g.poly(points).fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 });
    } else {
      view.g.rect(tile.x, tile.y, tile.width, tile.height)
        .fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.15 });
    }
    this.drawAdornment(view);
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
        continue;
      }
      const point = view.movement.sample(now);
      if (!point) continue;
      view.g.position.set(point.x, point.y); view.sprite?.position.set(point.x, point.y);
    }
  }

  destroy(): void {
    for (const view of this.views.values()) this.detach(view);
    this.views.clear();
    for (const graphics of this.regionViews.values()) {
      graphics.parent?.removeChild(graphics);
      graphics.destroy();
    }
    this.regionViews.clear();
  }
}
