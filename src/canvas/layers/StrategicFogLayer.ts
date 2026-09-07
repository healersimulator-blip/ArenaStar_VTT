/**
 * §9A strategic fog layer — dark cover over cells the viewing faction (plus
 * allies) does NOT detect. Cell granularity matches the DetectionGrid
 * (default 5 grid squares); the GM god view simply never syncs rects.
 */
import { Container, Graphics } from "pixi.js";
import { fogSyncKey } from "../../core/strategicFog";
import type { Camera } from "../camera";

export interface FogRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class StrategicFogLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private key = "";
  /** Rects from the last actual redraw (0 = clear) — e2e/telemetry readback. */
  rectCount = 0;

  constructor() {
    this.container.label = "strategicFog";
    this.g.label = "strategicFogCover";
    this.container.addChild(this.g);
  }

  /** Redraw when the rect set or zoom bucket changes. Empty = clear. */
  sync(rects: readonly FogRect[], camera: Camera): void {
    const key = fogSyncKey(rects, camera);
    if (key === this.key) return;
    this.key = key;
    this.rectCount = rects.length;
    this.g.clear();
    if (rects.length === 0) return;
    for (const r of rects) this.g.rect(r.x, r.y, r.width, r.height);
    this.g.fill({ color: 0x05070c, alpha: 0.82 });
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
