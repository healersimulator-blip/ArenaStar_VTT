/**
 * §9 Walls(GM) overlay — wall segments with restriction colors, door-state
 * dots, one-way arrows. Redrawn only when the walls version key changes
 * (positions × flags × camera zoom bucket); screen-constant widths.
 */
import { Container, Graphics } from "pixi.js";
import type { Camera } from "../camera";
import type { WallDocument } from "../../core/documents";
import { WALL_COLORS, wallStroke } from "../vision/wallSight";

export class WallsLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private key = "";

  constructor() {
    this.container.label = "walls";
    this.g.label = "wallGeometry";
    this.container.addChild(this.g);
  }

  /** GM-only overlay; hidden entirely for players via container.visible. */
  sync(walls: readonly WallDocument[], camera: Camera): void {
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${walls.length}|${zoomBucket}|${walls
      .map(
        (w) =>
          `${w.c.join(",")};${w.door}${w.oneWay ? 1 : 0}${w.sight}${w.move}${w.light}${w.sound}`,
      )
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clear();
    const lw = 1.5 / camera.scale;
    const dotR = 2.5 / camera.scale;
    for (const w of walls) {
      const [x1, y1, x2, y2] = w.c;
      const color = wallStroke(w);
      const conditional = w.sight === 1 || w.move === 1 || w.light === 1 || w.sound === 1;
      g.moveTo(x1 ?? 0, y1 ?? 0).lineTo(x2 ?? 0, y2 ?? 0);
      g.stroke({ width: lw, color, alpha: 0.9 });
      if (conditional) {
        // dashes overlay marks conditionality
        g.moveTo(x1 ?? 0, y1 ?? 0).lineTo(x2 ?? 0, y2 ?? 0);
        g.stroke({ width: lw * 2, color: 0x000000, alpha: 0.35 });
      }
      if (w.oneWay) {
        // direction chevron at the midpoint pointing along the segment
        const mx = ((x1 ?? 0) + (x2 ?? 0)) / 2;
        const my = ((y1 ?? 0) + (y2 ?? 0)) / 2;
        const ang = Math.atan2((y2 ?? 0) - (y1 ?? 0), (x2 ?? 0) - (x1 ?? 0));
        const s = 6 / camera.scale;
        g.moveTo(mx + Math.cos(ang + 2.5) * s, my + Math.sin(ang + 2.5) * s)
          .lineTo(mx, my)
          .lineTo(mx + Math.cos(ang - 2.5) * s, my + Math.sin(ang - 2.5) * s)
          .stroke({ width: lw, color: WALL_COLORS.oneWay, alpha: 0.95 });
      }
      if (w.door !== 0 || w.sight === 1 || w.move === 1) {
        const doorColor =
          w.door === 1
            ? WALL_COLORS.doorOpen
            : w.door === 2
              ? WALL_COLORS.doorLocked
              : WALL_COLORS.doorClosed;
        g.circle(((x1 ?? 0) + (x2 ?? 0)) / 2, ((y1 ?? 0) + (y2 ?? 0)) / 2, dotR).fill(doorColor);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
