/**
 * §9 Drawings layer — freehand / polygon / rectangle / text drawings from
 * DrawingDocument lists. Version-keyed single-Graphics redraw; text uses
 * pooled Text objects. Pure bounds helper exported for hit-testing.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { Camera } from "../camera";
import type { DrawingDocument } from "../../core/documents";

/** #rrggbb → 0xrrggbb (fallback grey). */
function parse(hex: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const g = m?.[1];
  return g ? parseInt(g, 16) : fallback;
}

export { drawingBounds } from "./drawingGeometry";

export class DrawingsLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private readonly texts = new Container();
  private readonly textViews = new Map<string, Text>();
  private key = "";

  constructor() {
    this.container.label = "drawings";
    this.g.label = "drawingGeometry";
    this.container.addChild(this.g, this.texts);
  }

  sync(drawings: readonly DrawingDocument[], camera: Camera): void {
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${zoomBucket}|${drawings
      .map(
        (d) =>
          `${d._id}:${d.kind}:${d.points.length}:${d.box ? d.box.join(",") : ""}:${d.stroke}:${d.fill}:${d.strokeWidth}:${d.text ?? ""}`,
      )
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clear();
    const seen = new Set<string>();
    for (const d of drawings) {
      const stroke = parse(d.stroke, 0xe8ecf2);
      const fill = parse(d.fill, 0x53b7ff);
      const hasFill = d.fill.trim().length > 0 && d.fill !== "none";
      const lw = Math.max(d.strokeWidth, 0.5) / camera.scale;
      if (d.kind === "freehand" && d.points.length >= 4) {
        g.moveTo(d.points[0] ?? 0, d.points[1] ?? 0);
        for (let i = 2; i + 1 < d.points.length; i += 2)
          g.lineTo(d.points[i] ?? 0, d.points[i + 1] ?? 0);
        g.stroke({ width: lw, color: stroke, alpha: 0.95 });
      } else if (d.kind === "poly" && d.points.length >= 6) {
        g.moveTo(d.points[0] ?? 0, d.points[1] ?? 0);
        for (let i = 2; i + 1 < d.points.length; i += 2)
          g.lineTo(d.points[i] ?? 0, d.points[i + 1] ?? 0);
        g.closePath();
        if (hasFill) g.fill({ color: fill, alpha: 0.3 });
        g.stroke({ width: lw, color: stroke, alpha: 0.95 });
      } else if (d.kind === "rect" && d.box) {
        const [x, y, w, h] = d.box;
        g.rect(x ?? 0, y ?? 0, w ?? 0, h ?? 0);
        if (hasFill) g.fill({ color: fill, alpha: 0.3 });
        g.stroke({ width: lw, color: stroke, alpha: 0.95 });
      } else if (d.kind === "text" && d.box && d.text) {
        seen.add(d._id);
        let view = this.textViews.get(d._id);
        if (!view) {
          view = new Text({ text: "", style: { fontSize: 14, fill: 0xe8ecf2 } });
          this.textViews.set(d._id, view);
          this.texts.addChild(view);
        }
        view.text = d.text;
        view.style.fontSize = Math.max(8, d.strokeWidth || 14) / camera.scale;
        view.style.fill = parse(d.stroke, 0xe8ecf2);
        view.position.set(d.box[0] ?? 0, d.box[1] ?? 0);
      }
    }
    for (const [id, view] of this.textViews) {
      if (!seen.has(id)) {
        this.textViews.delete(id);
        view.destroy();
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.textViews.clear();
  }
}
