/**
 * §9 Lighting — colored ambient darkness with additive light gradients
 * clipped by each light's visibility polygon (computed by vision.worker).
 * Pure helpers (lightAffectsViewport, parseLightColor, gradient stops) are
 * separated for Node tests; the layer itself is Pixi-only.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import type { RadialGradientOptions } from "pixi.js";
import type { Camera, Viewport } from "../camera";
import type { LightDocument } from "../../core/documents";

import type { AmbientLighting } from "../vision/lights";
import { lightAffectsViewport, parseLightColor, rgba } from "../vision/lights";

export type { AmbientLighting as Ambient } from "../vision/lights";

export interface LightView {
  light: LightDocument;
  /** Visibility polygon (flat [x,y,…]) from the vision worker, or null. */
  poly: Float32Array | null;
}

export { lightAffectsViewport, parseLightColor };

export function lightGradient(
  bright: number,
  dim: number,
  color: number,
  alpha: number,
): FillGradient {
  // radial gradient in LOCAL 0-1 space (default textureSpace): center 0.5,
  // outerRadius 0.5 covers the (pre-scaled) light shape; the caller draws the
  // polygon/path scaled so 1 = dim radius.
  const radius = Math.max(dim, bright, 1);
  const options: RadialGradientOptions = {
    type: "radial",
    center: { x: 0.5, y: 0.5 },
    innerRadius: 0.5 * Math.max(0, Math.min(bright / radius, 0.999)),
    outerRadius: 0.5,
    colorStops: [
      { offset: 0, color: rgba(color, alpha) },
      { offset: 1, color: rgba(color, 0) },
    ],
  };
  return new FillGradient(options);
}

export class LightingLayer {
  readonly container = new Container();
  private readonly darkness = new Graphics();
  private readonly lights = new Container();
  private readonly views = new Map<string, Graphics>();
  private key = "";

  constructor() {
    this.container.label = "lighting";
    this.darkness.label = "darkness";
    this.lights.label = "lights";
    this.container.addChild(this.darkness, this.lights);
  }

  sync(
    views: readonly LightView[],
    ambient: AmbientLighting,
    camera: Camera,
    viewport: Viewport,
  ): void {
    const view = {
      x: camera.x,
      y: camera.y,
      width: viewport.width / camera.scale,
      height: viewport.height / camera.scale,
    };
    const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
    const key = [
      zoomBucket,
      ambient.darkness.toFixed(3),
      ambient.color,
      views
        .map(
          (v) =>
            `${v.light._id}:${Math.round(v.light.x)}:${Math.round(v.light.y)}:${v.light.bright}:${v.light.dim}:${v.light.color}:${v.light.alpha}:${v.poly ? v.poly.length : -1}`,
        )
        .join("#"),
    ].join("|");
    if (key === this.key) return;
    this.key = key;

    // darkness overlay (colored ambient), additive lights punch through
    const color = parseLightColor(ambient.color, 0x0a0e1a);
    this.darkness
      .clear()
      .rect(view.x - 2, view.y - 2, view.width + 4, view.height + 4)
      .fill({ color, alpha: Math.max(0, Math.min(1, ambient.darkness)) });

    const seen = new Set<string>();
    for (const { light, poly } of views) {
      if (!lightAffectsViewport(light, view)) continue;
      seen.add(light._id);
      let g = this.views.get(light._id);
      if (!g) {
        g = new Graphics();
        g.blendMode = "add";
        this.views.set(light._id, g);
        this.lights.addChild(g);
      }
      g.clear();
      const radius = Math.max(light.dim, light.bright, 1);
      const gradient = lightGradient(
        light.bright,
        light.dim,
        parseLightColor(light.color),
        light.alpha,
      );
      // draw in a LOCAL frame (light center = origin, 1 = dim radius) so the
      // 0-1 radial gradient aligns; the container translation places it.
      g.position.set(light.x, light.y);
      if (poly && poly.length >= 6) {
        g.moveTo(((poly[0] ?? 0) - light.x) / radius, ((poly[1] ?? 0) - light.y) / radius);
        for (let i = 2; i < poly.length; i += 2) {
          g.lineTo(((poly[i] ?? 0) - light.x) / radius, ((poly[i + 1] ?? 0) - light.y) / radius);
        }
        g.closePath().fill(gradient);
      } else {
        // no polygon (open field): full circle
        g.circle(0, 0, 1).fill(gradient);
      }
    }
    for (const [id, g] of this.views) {
      if (!seen.has(id)) {
        this.views.delete(id);
        g.destroy();
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.views.clear();
  }
}
