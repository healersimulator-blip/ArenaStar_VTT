/**
 * §9 Fog — per-user explored render-texture. Unexplored area is an opaque
 * cover; revealing a visibility polygon ERASES it from the texture (the
 * explored state accumulates across turns). `readbackPng()` produces the
 * downscaled PNG for the periodic §5 fog.put upload to the host.
 */
import { Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import type { Application } from "pixi.js";
import type { Camera, Viewport } from "../camera";

export const FOG_TEXTURE_WIDTH = 512;

export class FogLayer {
  readonly container = new Container();
  readonly texture: RenderTexture;
  /** Scene cover size (for stage layer reuse checks). */
  readonly coverWidth: number;
  readonly coverHeight: number;
  private readonly cover = new Sprite();
  private readonly sceneBounds = { x: 0, y: 0, width: 100, height: 100 };
  private readonly scratch = new Graphics();

  constructor(
    private readonly app: Application,
    sceneSize: { width: number; height: number },
  ) {
    this.container.label = "fog";
    const aspect = sceneSize.height > 0 ? sceneSize.width / sceneSize.height : 1;
    const w = FOG_TEXTURE_WIDTH;
    const h = Math.max(1, Math.round(w / Math.max(aspect, 0.01)));
    this.texture = RenderTexture.create({ width: w, height: h });
    this.cover.texture = this.texture;
    this.cover.label = "fogCover";
    this.container.addChild(this.cover);
    this.sceneBounds.width = sceneSize.width;
    this.sceneBounds.height = sceneSize.height;
    this.coverWidth = sceneSize.width;
    this.coverHeight = sceneSize.height;
    this.reset();
  }

  /** World → fog-texture pixel scale. */
  private scale(): number {
    return this.texture.width / Math.max(1, this.sceneBounds.width);
  }

  /** Opaque everywhere (scene load / world import). */
  reset(): void {
    const g = new Graphics();
    g.rect(0, 0, this.texture.width, this.texture.height).fill(0x000000);
    this.app.renderer.render({ container: g, target: this.texture, clear: true });
    g.destroy();
    this.cover.width = this.sceneBounds.width;
    this.cover.height = this.sceneBounds.height;
    this.cover.position.set(this.sceneBounds.x, this.sceneBounds.y);
  }

  /** Erase a visibility polygon (flat world coords) from the explored map. */
  reveal(poly: Float32Array): void {
    if (poly.length < 6) return;
    const s = this.scale();
    const g = this.scratch;
    g.clear();
    g.moveTo((poly[0] ?? 0) * s, (poly[1] ?? 0) * s);
    for (let i = 2; i < poly.length; i += 2) {
      g.lineTo((poly[i] ?? 0) * s, (poly[i + 1] ?? 0) * s);
    }
    g.closePath().fill(0xffffff);
    g.blendMode = "erase";
    this.app.renderer.render({ container: g, target: this.texture, clear: false });
    g.blendMode = "normal";
  }

  /** Downscaled PNG readback for fog.put (§8/§9). */
  async readbackPng(): Promise<Uint8Array> {
    const canvas = this.app.renderer.extract.canvas(this.texture);
    const src = canvas as HTMLCanvasElement;
    const target = 128;
    const thumb = document.createElement("canvas");
    thumb.width = target;
    thumb.height = Math.max(1, Math.round((this.texture.height / this.texture.width) * target));
    const ctx = thumb.getContext("2d");
    if (!ctx) throw new Error("fog readback: no 2d context");
    ctx.drawImage(src, 0, 0, thumb.width, thumb.height);
    const dataUrl = thumb.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Viewport rejection helper (kept for the app loop). */
  coversView(camera: Camera, viewport: Viewport): boolean {
    void camera;
    void viewport;
    return true;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.texture.destroy();
  }
}
