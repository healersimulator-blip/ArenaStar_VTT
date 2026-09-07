/**
 * §9A order-overlay renderer — draws OrderOverlayGeometry (+ the live drag
 * preview) in world coordinates. Ephemeral by design: sync() clears and
 * redraws a single Graphics each change (few dozen strokes; no pooling
 * needed). Strokes/fonts divide by camera scale to stay screen-constant.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { Camera } from "../camera";
import type { OrderPreview } from "../interactions/unitOrders";
import type { MovePathOverlay, OrderOverlayGeometry } from "../interactions/orderOverlays";

const PATH_COLOR = 0x53b7ff;
const CHARGE_COLOR = 0xff6a5a;
const ATTACK_COLOR = 0xffb054;
const PREVIEW_COLOR = 0xa0e07a;

export class OrderOverlayLayer {
  readonly container = new Container();
  private readonly geometry = new Graphics();
  private readonly preview = new Graphics();
  private readonly labels = new Container();
  private readonly labelPool: Text[] = [];
  private readonly labelActive: Text[] = [];

  constructor() {
    this.container.label = "orderOverlays";
    this.geometry.label = "orderGeometry";
    this.preview.label = "orderPreview";
    this.container.addChild(this.geometry, this.preview, this.labels);
  }

  /** Redraw committed order overlays. */
  sync(
    geometry: OrderOverlayGeometry,
    camera: Camera,
    pathLengths?: ReadonlyMap<string, number>,
  ): void {
    const g = this.geometry;
    g.clear();
    this.releaseLabels();
    const s = camera.scale;
    for (const path of geometry.paths) this.drawPath(g, path, PATH_COLOR, 1.5 / s, 5 / s);
    for (const charge of geometry.charges) this.drawPath(g, charge, CHARGE_COLOR, 2.5 / s, 8 / s);
    for (const target of geometry.targets)
      this.drawDash(g, target.from, target.to, ATTACK_COLOR, 1.5 / s, 5 / s);
    if (pathLengths) {
      for (const path of [...geometry.paths, ...geometry.charges]) {
        const len = pathLengths.get(path.unitId);
        if (len === undefined) continue;
        const end = path.points[path.points.length - 1];
        if (!end) continue;
        this.label(`${len.toFixed(1)}`, end, 10 / s, PATH_COLOR);
      }
    }
  }

  /** Live gesture preview (null clears). */
  syncPreview(preview: OrderPreview | null, camera: Camera, lengthWorld?: number): void {
    const g = this.preview;
    g.clear();
    if (!preview) return;
    const s = camera.scale;
    if (preview.kind === "move") {
      this.drawPath(g, { points: preview.points, pace: preview.pace }, PREVIEW_COLOR, 2 / s, 7 / s);
      const end = preview.points[preview.points.length - 1];
      if (end && lengthWorld !== undefined) {
        this.previewLabel(`${lengthWorld.toFixed(1)}`, end, 11 / s);
      }
    } else {
      const color = preview.kind === "attack" ? ATTACK_COLOR : 0x9aa0a8;
      this.drawDash(g, preview.from, preview.to, color, 2 / s, 6 / s);
    }
  }

  private drawPath(
    g: Graphics,
    path: Pick<MovePathOverlay, "points"> & { pace: string },
    color: number,
    width: number,
    head: number,
  ): void {
    const pts = path.points;
    if (pts.length < 2) return;
    g.moveTo(pts[0]?.x ?? 0, pts[0]?.y ?? 0);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]?.x ?? 0, pts[i]?.y ?? 0);
    g.stroke({ width, color, alpha: 0.9 });
    // arrowhead at the final segment
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    if (a && b) this.arrowHead(g, a, b, color, head);
    // waypoint dots
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      if (p) g.circle(p.x, p.y, width * 1.1).fill({ color, alpha: 0.9 });
    }
  }

  private drawDash(
    g: Graphics,
    from: { x: number; y: number },
    to: { x: number; y: number },
    color: number,
    width: number,
    dash: number,
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const ux = dx / len;
    const uy = dy / len;
    const step = dash * 2;
    for (let t = 0; t < len; t += step) {
      const t2 = Math.min(len, t + dash);
      g.moveTo(from.x + ux * t, from.y + uy * t).lineTo(from.x + ux * t2, from.y + uy * t2);
    }
    g.stroke({ width, color, alpha: 0.85 });
    // target crosshair
    g.circle(to.x, to.y, width * 3).stroke({ width: width * 0.8, color, alpha: 0.9 });
  }

  private arrowHead(
    g: Graphics,
    a: { x: number; y: number },
    b: { x: number; y: number },
    color: number,
    size: number,
  ): void {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const back = ang + Math.PI;
    const p1 = { x: b.x + Math.cos(back + 0.42) * size, y: b.y + Math.sin(back + 0.42) * size };
    const p2 = { x: b.x + Math.cos(back - 0.42) * size, y: b.y + Math.sin(back - 0.42) * size };
    g.poly([b.x, b.y, p1.x, p1.y, p2.x, p2.y]).fill({ color, alpha: 0.95 });
  }

  private label(text: string, at: { x: number; y: number }, size: number, color: number): void {
    const t = this.acquireLabel();
    t.text = text;
    t.style.fontSize = size;
    t.style.fill = color;
    t.anchor.set(0.5);
    t.position.set(at.x, at.y - size);
    t.visible = true;
  }

  private previewLabel(text: string, at: { x: number; y: number }, size: number): void {
    this.label(text, at, size, PREVIEW_COLOR);
  }

  private acquireLabel(): Text {
    const pooled = this.labelPool.pop();
    const t = pooled ?? new Text({ text: "", style: { fontSize: 10, fill: 0xffffff } });
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
