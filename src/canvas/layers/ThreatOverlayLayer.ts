/**
 * P02/D-197 — PF1e threatened-square overlay. Renders the draw list of a
 * `pf1eThreatModel` entry: semi-transparent fills over the threatened cells
 * and a ring around the threatening token's own footprint, so the table can
 * read "what does this creature threaten" (G §4.5's highlighting) straight
 * off the canvas. The model is computed in `src/app/App.svelte` from
 * `pf1e/threatPreview` — this layer only draws and never imports the package,
 * so core canvas stays system-agnostic (structurally, like the E06 badge seam
 * and the D-154 area preview).
 *
 * Local selection UI, not a replicated document: the layer lives in the
 * controls holder, redraws on a version key, and clears on `sync([], null, …)`.
 */
import { Container, Graphics } from "pixi.js";
import type { Camera } from "../camera";

export interface ThreatOverlayRect {
  x: number;
  y: number;
  size: number;
}

export interface ThreatOverlayOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ThreatOverlayLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private key = "";
  /** Threat cell rects drawn by the last actual redraw (0 = cleared). */
  rectCount = 0;
  /** Whether the threatening token's footprint ring was drawn. */
  originDrawn = false;

  constructor() {
    this.container.label = "pf1eThreatOverlay";
    this.g.label = "pf1eThreatOverlayGeometry";
    this.container.addChild(this.g);
  }

  /** Redraw when the draw lists or the zoom bucket change. Empty = clear. */
  sync(
    rects: readonly ThreatOverlayRect[],
    origin: ThreatOverlayOrigin | null,
    camera: Camera,
  ): void {
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${zoomBucket}|${rects
      .map((r) => `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.size)}`)
      .join("#")}|${
      origin === null
        ? "-"
        : `${Math.round(origin.x)}:${Math.round(origin.y)}:${Math.round(origin.width)}:${Math.round(origin.height)}`
    }`;
    if (key === this.key) return;
    this.key = key;
    this.rectCount = rects.length;
    this.originDrawn = origin !== null;
    const g = this.g;
    g.clear();
    if (rects.length === 0 && origin === null) return;
    const lw = 1.5 / camera.scale;
    for (const r of rects) g.rect(r.x, r.y, r.size, r.size);
    if (rects.length > 0) {
      // Threat is red where the area preview is orange — the two overlays can
      // be on screen together (a selected caster aiming a burst).
      g.fill({ color: 0xd94f4f, alpha: 0.18 }).stroke({
        width: lw,
        color: 0xe86a6a,
        alpha: 0.85,
      });
    }
    if (origin !== null) {
      const pad = 2 / camera.scale;
      g.rect(
        origin.x - pad,
        origin.y - pad,
        origin.width + pad * 2,
        origin.height + pad * 2,
      ).stroke({ width: lw * 1.6, color: 0xffffff, alpha: 0.95 });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
