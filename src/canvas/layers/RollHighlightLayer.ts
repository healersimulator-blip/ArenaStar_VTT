/**
 * F01 — Roll-card highlight overlay.
 * Renders initiator/target/area outlines so the table can read
 * "who rolled, who got hit, where" straight off the canvas.
 * The model is computed by the chat card — this layer only draws.
 *
 * Fades after `fadeSec` (1–10 s, default 4 s, world setting). When the card's
 * initiator/target/area link is clicked the layer re-syncs to that rect and
 * recenters the camera (the card drives that; the layer just draws).
 */

import { Container, Graphics } from "pixi.js";
import type { Camera } from "../camera";

export interface RollHighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "initiator" | "target" | "area";
}

export class RollHighlightLayer {
  readonly container = new Container();
  private readonly g = new Graphics();
  private key = "";
  private fadeSec = 4;
  private fadeHandle: ReturnType<typeof setTimeout> | null = null;
  /** How many rects were drawn by the last actual redraw (0 = cleared). */
  rectCount = 0;
  /** Whether an area fill was drawn. */
  areaDrawn = false;

  constructor() {
    this.container.label = "rollHighlight";
    this.g.label = "rollHighlightGeometry";
    this.container.addChild(this.g);
  }

  /** Redraw when the draw lists, fadeSec or zoom bucket change. Empty = clear. */
  sync(
    rects: readonly RollHighlightRect[],
    camera: Camera,
    fadeSec = this.fadeSec,
  ): void {
    this.fadeSec = Math.max(1, Math.min(10, Math.trunc(fadeSec) || 4));
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = `${zoomBucket}|${this.fadeSec}|${rects
      .map((r) => `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}:${r.kind}`)
      .join("#")}`;
    if (key === this.key) return;
    this.key = key;
    this.rectCount = rects.length;
    this.areaDrawn = rects.some((r) => r.kind === "area");
    const g = this.g;
    g.clear();
    if (this.fadeHandle !== null) {
      clearTimeout(this.fadeHandle);
      this.fadeHandle = null;
    }
    if (rects.length === 0) {
      g.alpha = 1;
      return;
    }
    const lw = 1.5 / camera.scale;
    const pad = 2 / camera.scale;
    for (const r of rects) {
      const color =
        r.kind === "initiator" ? 0x53b7ff : r.kind === "target" ? 0xff6b6b : 0xffd166;
      const alpha = r.kind === "area" ? 0.22 : 0;
      if (r.kind === "area") {
        g.rect(r.x, r.y, r.width, r.height).fill({ color, alpha });
      }
      g.rect(r.x - pad, r.y - pad, r.width + pad * 2, r.height + pad * 2).stroke({
        width: r.kind === "initiator" ? lw * 1.8 : lw * 1.6,
        color,
        alpha: 0.95,
      });
    }
    // Fade after fadeSec — clear the geometry but keep the container alive.
    g.alpha = 1;
    if (rects.length > 0) {
      const ms = this.fadeSec * 1000;
      // Simple timeout fade: after ms, wipe. Tests that need the timing can
      // assert rectCount and that a second sync([]) clears.
      this.fadeHandle = setTimeout(() => {
        this.clear();
      }, ms);
      // So the timeout doesn't keep Node alive in tests.
      if (this.fadeHandle && typeof (this.fadeHandle as unknown as { unref?: () => void }).unref === "function") {
        (this.fadeHandle as unknown as { unref: () => void }).unref();
      }
    }
  }

  clear(): void {
    if (this.fadeHandle !== null) {
      clearTimeout(this.fadeHandle);
      this.fadeHandle = null;
    }
    this.g.clear();
    this.g.alpha = 1;
    this.rectCount = 0;
    this.areaDrawn = false;
    // Force the next sync() to redraw even with an identical rect list.
    this.key = "";
  }

  destroy(): void {
    if (this.fadeHandle !== null) clearTimeout(this.fadeHandle);
    this.container.destroy({ children: true });
  }
}
