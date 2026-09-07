/**
 * §9 Templates layer — cone/circle/ray/rect overlays (半-transparent fills,
 * measured labels). Redraws on a version key; pure geometry lives in
 * templateGeometry.ts.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { Camera } from "../camera";
import type { TemplateDocument } from "../../core/documents";
import { templateShape } from "./templateGeometry";

export class TemplatesLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private readonly labelActive: Text[] = [];
  private key = "";

  constructor() {
    this.container.label = "templates";
    this.g.label = "templateGeometry";
    this.container.addChild(this.g, this.labels);
  }

  sync(templates: readonly TemplateDocument[], camera: Camera): void {
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${zoomBucket}|${templates
      .map(
        (t) =>
          `${t._id}:${t.kind}:${Math.round(t.x)}:${Math.round(t.y)}:${Math.round(t.distance)}:${Math.round(t.direction * 100)}:${Math.round(t.width)}`,
      )
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clear();
    this.releaseLabels();
    const lw = 1.5 / camera.scale;
    for (const t of templates) {
      const shape = templateShape(t);
      const fill = { color: 0x53b7ff, alpha: 0.18 };
      const stroke = { width: lw, color: 0x53b7ff, alpha: 0.85 };
      if (shape.kind === "circle") {
        g.circle(shape.center.x, shape.center.y, shape.radius).fill(fill).stroke(stroke);
      } else if (shape.kind === "polygon") {
        const first = shape.points[0];
        if (!first) continue;
        g.moveTo(first.x, first.y);
        for (let i = 1; i < shape.points.length; i++) {
          const p = shape.points[i];
          if (p) g.lineTo(p.x, p.y);
        }
        g.closePath().fill(fill).stroke(stroke);
      } else {
        const half = shape.width / 2;
        const dx = shape.b.x - shape.a.x;
        const dy = shape.b.y - shape.a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        const px = (-dy / len) * half;
        const py = (dx / len) * half;
        g.moveTo(shape.a.x + px, shape.a.y + py)
          .lineTo(shape.b.x + px, shape.b.y + py)
          .lineTo(shape.b.x - px, shape.b.y - py)
          .lineTo(shape.a.x - px, shape.a.y - py)
          .closePath()
          .fill(fill)
          .stroke(stroke);
      }
      // measured label at the far edge / rim
      const label = this.acquireLabel();
      label.text = `${Math.round(t.distance)}`;
      label.style.fontSize = 11 / camera.scale;
      label.style.fill = 0x9fd4ff;
      const anchor =
        shape.kind === "circle"
          ? { x: shape.center.x, y: shape.center.y - shape.radius }
          : shape.kind === "segment"
            ? shape.b
            : (shape.points[shape.points.length - 1] ?? { x: t.x, y: t.y });
      label.anchor.set(0.5);
      label.position.set(anchor.x, anchor.y);
    }
  }

  private acquireLabel(): Text {
    const pooled = this.labelPool.pop();
    const t = pooled ?? new Text({ text: "", style: { fontSize: 11, fill: 0x9fd4ff } });
    if (!pooled) this.labels.addChild(t);
    this.labelActive.push(t);
    return t;
  }

  private releaseLabels(): void {
    for (const t of this.labelActive) {
      t.visible = false;
      this.labelPool.push(t);
    }
    this.labelActive.length = 0;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.labelPool.length = 0;
    this.labelActive.length = 0;
  }
}
