/**
 * §9 Walls(GM) overlay — wall segments with restriction colors, door-state
 * dots, one-way arrows. Redrawn only when the walls version key changes
 * (positions × flags × camera zoom bucket); screen-constant widths.
 */
import { Container, Graphics } from "pixi.js";
import type { Camera } from "../camera";
import type { WallDocument } from "../../core/documents";
import { WALL_COLORS, wallStroke } from "../vision/wallSight";
import { wallKindOf } from "../vision/wallKinds";

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
      const kind = wallKindOf(w);
      const color =
        kind === "door"
          ? w.door === 1
            ? WALL_COLORS.doorOpen
            : w.door === 2
              ? WALL_COLORS.doorLocked
              : WALL_COLORS.doorClosed
          : kind === "window"
            ? WALL_COLORS.window
            : wallStroke(w);
      g.moveTo(x1 ?? 0, y1 ?? 0).lineTo(x2 ?? 0, y2 ?? 0);
      g.stroke({ width: lw, color, alpha: 0.9 });
      if (kind === "door") {
        // dashes overlay marks conditionality (the state can change at runtime)
        g.moveTo(x1 ?? 0, y1 ?? 0).lineTo(x2 ?? 0, y2 ?? 0);
        g.stroke({ width: lw * 2, color: 0x000000, alpha: 0.35 });
      } else if (kind === "window") {
        // a second parallel line reads as glazing (D-257)
        const dx = (x2 ?? 0) - (x1 ?? 0);
        const dy = (y2 ?? 0) - (y1 ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        const ox = (-dy / len) * dotR * 0.8;
        const oy = (dx / len) * dotR * 0.8;
        g.moveTo((x1 ?? 0) + ox, (y1 ?? 0) + oy).lineTo((x2 ?? 0) + ox, (y2 ?? 0) + oy);
        g.stroke({ width: lw * 0.6, color, alpha: 0.75 });
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
      if (kind === "door") {
        // the dot is the click target (D-257): its colour is the door's state
        g.circle(((x1 ?? 0) + (x2 ?? 0)) / 2, ((y1 ?? 0) + (y2 ?? 0)) / 2, dotR).fill(color);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
