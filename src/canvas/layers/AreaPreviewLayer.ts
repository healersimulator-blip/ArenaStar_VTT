/**
 * P5/C01 (D-154) — PF1e area preview overlay. Renders the draw lists of a
 * `PF1eAreaPreviewModel`: semi-transparent fills over the affected cells and
 * a highlight ring around each affected token. The model is computed by
 * `src/packages/pf1e/areaPreview` — this layer only draws and never imports
 * the package, so core canvas stays system-agnostic (structurally, like the
 * E06 badge seam).
 *
 * Local caster UI, not a replicated document: the layer lives in the controls
 * holder, redraws on a version key, and clears on `sync([], [])`.
 */
import { Container, Graphics } from "pixi.js";
import type { Camera } from "../camera";

export interface AreaPreviewRect {
  x: number;
  y: number;
  size: number;
}

export interface AreaPreviewHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class AreaPreviewLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private key = "";
  /** Cell rects drawn by the last actual redraw (0 = cleared). */
  rectCount = 0;
  /** Token highlight rings drawn by the last actual redraw. */
  highlightCount = 0;

  constructor() {
    this.container.label = "pf1eAreaPreview";
    this.g.label = "pf1eAreaPreviewGeometry";
    this.container.addChild(this.g);
  }

  /** Redraw when the draw lists or the zoom bucket change. Empty = clear. */
  sync(
    rects: readonly AreaPreviewRect[],
    highlights: readonly AreaPreviewHighlight[],
    camera: Camera,
  ): void {
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${zoomBucket}|${rects
      .map((r) => `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.size)}`)
      .join("#")}|${highlights
      .map(
        (h) =>
          `${Math.round(h.x)}:${Math.round(h.y)}:${Math.round(h.width)}:${Math.round(h.height)}`,
      )
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    this.rectCount = rects.length;
    this.highlightCount = highlights.length;
    const g = this.g;
    g.clear();
    if (rects.length === 0 && highlights.length === 0) return;
    const lw = 1.5 / camera.scale;
    for (const r of rects) g.rect(r.x, r.y, r.size, r.size);
    if (rects.length > 0) {
      g.fill({ color: 0xff9d4d, alpha: 0.22 }).stroke({
        width: lw,
        color: 0xffb066,
        alpha: 0.9,
      });
    }
    const pad = 2 / camera.scale;
    for (const h of highlights) {
      g.rect(
        h.x - pad,
        h.y - pad,
        h.width + pad * 2,
        h.height + pad * 2,
      ).stroke({ width: lw * 1.6, color: 0xffd166, alpha: 0.95 });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
