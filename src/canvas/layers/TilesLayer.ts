/**
 * §9 tiles (D-083): floor tiles below the grid, overhead tiles (roofs) above
 * the tokens layer. Occlusion (roof/fade) is the pure rule from ephemera.ts;
 * textures load through an injected port (asset hash → Texture) with a
 * deterministic tinted-rect placeholder until (or instead of) the image.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { TileDocument } from "../../core/documents";
import { rectsOverlap, tileAlpha, tileTint, type TileRect } from "../ephemera";

export interface TilesLayerOptions {
  /** Asset hash/URL → texture; null/undefined keeps the tinted placeholder. */
  loadTexture?: (img: string) => Promise<Texture | null>;
}

interface TileView {
  tile: TileDocument;
  g: Graphics;
  sprite: Sprite | null;
  textureLoaded: boolean;
  /** Last computed occlusion alpha (readback + sprite path). */
  alpha: number;
}

export class TilesLayer {
  private readonly below: Container;
  private readonly above: Container;
  private readonly opts: TilesLayerOptions;
  private readonly views = new Map<string, TileView>();

  constructor(below: Container, above: Container, options: TilesLayerOptions = {}) {
    this.below = below;
    this.above = above;
    this.opts = options;
  }

  /**
   * Reconcile tile views; `occupied` are rects of tokens with vision (roof
   * tiles over one of them fade to their occlusion alpha).
   */
  sync(tiles: readonly TileDocument[], occupied: readonly TileRect[]): void {
    const seen = new Set<string>();
    for (const tile of tiles) {
      seen.add(tile._id);
      let view = this.views.get(tile._id);
      if (!view) {
        const g = new Graphics();
        const fresh: TileView = { tile, g, sprite: null, textureLoaded: false, alpha: 1 };
        this.views.set(tile._id, fresh);
        this.containerFor(tile).addChild(g);
        this.maybeLoadTexture(fresh);
        view = fresh;
      }
      view.tile = tile;
      this.draw(view, occupied);
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.detach(view);
        this.views.delete(id);
      }
    }
  }

  /** Current occlusion alpha per tile id (e2e readback). */
  alphaOf(tileId: string): number | null {
    const view = this.views.get(tileId);
    return view ? view.alpha : null;
  }

  private containerFor(tile: TileDocument): Container {
    return tile.above ? this.above : this.below;
  }

  private detach(view: TileView): void {
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
    void loader(view.tile.img)
      .then((texture) => {
        if (!texture || !this.views.has(view.tile._id)) return;
        if (view.sprite) return; // already loaded
        const sprite = new Sprite(texture);
        sprite.label = "tileImg";
        this.containerFor(view.tile).addChild(sprite);
        view.sprite = sprite;
        view.textureLoaded = true;
      })
      .catch(() => undefined);
  }

  private draw(view: TileView, occupied: readonly TileRect[]): void {
    const { tile } = view;
    const rect: TileRect = { x: tile.x, y: tile.y, width: tile.width, height: tile.height };
    const occupiedUnder = occupied.some((o) => rectsOverlap(rect, o));
    const alpha = tileAlpha(tile, occupiedUnder);
    view.alpha = alpha;
    view.g.alpha = alpha; // placeholder path: whole-view fade (readback honest)
    if (view.sprite) {
      view.sprite.position.set(tile.x, tile.y);
      view.sprite.width = tile.width;
      view.sprite.height = tile.height;
      view.sprite.alpha = alpha;
      view.g.clear();
      // roof outline stays visible even with a texture (GM affordance)
      if (tile.above) {
        view.g
          .rect(tile.x, tile.y, tile.width, tile.height)
          .stroke({ width: 1, color: 0xffd166, alpha: 0.25 });
      }
      return;
    }
    view.g
      .clear()
      .rect(tile.x, tile.y, tile.width, tile.height)
      .fill({ color: tileTint(tile.img || tile._id), alpha: 0.85 })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.15 });
  }

  destroy(): void {
    for (const view of this.views.values()) this.detach(view);
    this.views.clear();
  }
}
