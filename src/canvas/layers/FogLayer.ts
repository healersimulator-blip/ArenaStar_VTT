/**
 * §9 Fog — per-user explored render-texture. Unexplored area is an opaque
 * cover; revealing a visibility polygon ERASES it from the texture (the
 * explored state accumulates across turns). `readbackPng()` produces the PNG
 * the §5 fog.put upload and the §8 fog store keep; `mergePng()` folds a stored
 * map back in (D-250: the explored set is a union, so restore, reconnect and a
 * reveal that raced the restore all compose without ordering rules).
 *
 * A second texture dims what is explored but not in sight right now
 * (`setVisible`): black = never seen, dim = remembered, clear = seen now.
 *
 * Two styles (D-251): `opaque` is what a player gets; `translucent` is the GM's cover — the
 * same shapes at a fraction of the alpha, so the GM sees where fog lies and every token and
 * map feature under it.
 */
import { Container, Graphics, RenderTexture, Sprite, Texture } from "pixi.js";
import type { Application } from "pixi.js";
import type { Camera, Viewport } from "../camera";

export const FOG_TEXTURE_WIDTH = 512;
/** Alpha of the "remembered but not currently visible" veil. */
export const FOG_DIM_ALPHA = 0.55;
/** D-251: the GM's translucent cover — unexplored areas at this alpha… */
export const FOG_GM_COVER_ALPHA = 0.35;
/** …and the remembered veil at this fraction of its player alpha. */
export const FOG_GM_VEIL_ALPHA = 0.35;

export type FogLayerStyle = "opaque" | "translucent";

type PngCanvas = HTMLCanvasElement & {
  convertToBlob?: (o?: { type?: string }) => Promise<Blob>;
};

/**
 * PNG bytes of a canvas. The synchronous `toDataURL` path is preferred on purpose: the
 * shells flush the fog on `pagehide`, where an async `toBlob` may never call back.
 */
async function canvasToPng(canvas: PngCanvas): Promise<Uint8Array> {
  if (typeof canvas.toDataURL === "function") {
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof canvas.convertToBlob === "function") {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("fog readback: canvas cannot encode PNG");
}

export class FogLayer {
  readonly container = new Container();
  /** Explored map: opaque = unexplored, transparent = explored. */
  readonly texture: RenderTexture;
  /** Current-sight veil: dim everywhere except what is visible right now. */
  readonly visibleTexture: RenderTexture;
  /** Scene cover size (for stage layer reuse checks). */
  readonly coverWidth: number;
  readonly coverHeight: number;
  private readonly cover = new Sprite();
  /**
   * D-256: the GM's manual mask (Hide/Reveal brushes) as its own texture, drawn over the
   * explored cover. White = the GM hid this area, transparent = GM reveal or untouched.
   */
  readonly manualTexture: RenderTexture;
  private readonly manual = new Sprite();
  private readonly veil = new Sprite();
  private readonly sceneBounds = { x: 0, y: 0, width: 100, height: 100 };
  /**
   * The erase brush. It is rendered through a parent container on purpose: pixi applies a
   * blend mode from the render-group traversal, and a container rendered as the pass root
   * keeps the default — an "erase" set on the root would paint white instead of erasing.
   */
  private readonly scratch = new Graphics();
  private readonly brush = new Container();
  private currentStyle: FogLayerStyle = "opaque";
  private destroyed = false;

  constructor(
    private readonly app: Application,
    sceneSize: { width: number; height: number },
  ) {
    this.container.label = "fog";
    const aspect = sceneSize.height > 0 ? sceneSize.width / sceneSize.height : 1;
    const w = FOG_TEXTURE_WIDTH;
    const h = Math.max(1, Math.round(w / Math.max(aspect, 0.01)));
    this.texture = RenderTexture.create({ width: w, height: h });
    this.visibleTexture = RenderTexture.create({ width: w, height: h });
    this.manualTexture = RenderTexture.create({ width: w, height: h });
    this.veil.texture = this.visibleTexture;
    this.veil.label = "fogVeil";
    this.container.addChild(this.veil);
    this.cover.texture = this.texture;
    this.cover.label = "fogCover";
    this.manual.texture = this.manualTexture;
    this.manual.label = "fogManual";
    this.container.addChild(this.cover, this.manual);
    this.sceneBounds.width = sceneSize.width;
    this.sceneBounds.height = sceneSize.height;
    this.coverWidth = sceneSize.width;
    this.coverHeight = sceneSize.height;
    this.scratch.blendMode = "erase";
    this.brush.addChild(this.scratch);
    this.reset();
  }

  /** World → fog-texture pixel scale. */
  private scale(): number {
    return this.texture.width / Math.max(1, this.sceneBounds.width);
  }

  private fitSprite(sprite: Sprite): void {
    sprite.width = this.sceneBounds.width;
    sprite.height = this.sceneBounds.height;
    sprite.position.set(this.sceneBounds.x, this.sceneBounds.y);
  }

  /** Opaque everywhere (scene load / world import); nothing currently visible. */
  reset(): void {
    const g = new Graphics();
    g.rect(0, 0, this.texture.width, this.texture.height).fill(0x000000);
    this.app.renderer.render({ container: g, target: this.texture, clear: true });
    g.destroy();
    this.fitSprite(this.cover);
    this.fitSprite(this.manual);
    this.fitSprite(this.veil);
    this.setVisible([]);
    this.clearManualMask();
  }

  /** Show or hide the whole fog (fog off for the scene hides it; the map keeps accumulating). */
  setShown(shown: boolean): void {
    this.container.visible = shown;
  }

  get shown(): boolean {
    return this.container.visible;
  }

  /** D-251: the player's opaque cover, or the GM's see-through one. */
  setStyle(style: FogLayerStyle): void {
    this.currentStyle = style;
    const translucent = style === "translucent";
    this.cover.alpha = translucent ? FOG_GM_COVER_ALPHA : 1;
    this.manual.alpha = translucent ? FOG_GM_COVER_ALPHA : 1;
    this.veil.alpha = translucent ? FOG_GM_VEIL_ALPHA : 1;
  }

  get style(): FogLayerStyle {
    return this.currentStyle;
  }

  private polygonPath(g: Graphics, poly: Float32Array): void {
    const s = this.scale();
    g.moveTo((poly[0] ?? 0) * s, (poly[1] ?? 0) * s);
    for (let i = 2; i < poly.length; i += 2) {
      g.lineTo((poly[i] ?? 0) * s, (poly[i + 1] ?? 0) * s);
    }
    g.closePath().fill(0xffffff);
  }

  /** Erase a polygon (flat world coords) from a texture. */
  private erase(target: RenderTexture, poly: Float32Array): void {
    if (poly.length < 6) return;
    const g = this.scratch;
    g.clear();
    this.polygonPath(g, poly);
    this.app.renderer.render({ container: this.brush, target, clear: false });
  }

  /** Erase a visibility polygon (flat world coords) from the explored map. */
  reveal(poly: Float32Array): void {
    this.erase(this.texture, poly);
  }

  /** D-256: drop every manual GM stroke (scene load / "reveal all"). */
  clearManualMask(): void {
    const g = new Graphics();
    g.rect(0, 0, this.manualTexture.width, this.manualTexture.height).fill(0x000000);
    this.app.renderer.render({ container: g, target: this.manualTexture, clear: true });
    g.destroy();
    this.fitSprite(this.manual);
  }

  /**
   * D-256: replay the GM's ordered mask log. `hide` strokes paint cover into the manual
   * texture, `reveal` strokes erase it **and** the explored cover underneath (a GM reveal
   * shows the map even where nobody has vision), so a later stroke always wins over an
   * earlier one. Replaying is idempotent — every client does it on every sync.
   */
  applyManualMask(log: readonly { mode: "reveal" | "hide"; poly: number[] }[]): void {
    this.clearManualMask();
    if (log.length === 0) return;
    for (const op of log) {
      const poly = Float32Array.from(op.poly);
      if (poly.length < 6) continue;
      if (op.mode === "hide") {
        const g = new Graphics();
        this.polygonPath(g, poly);
        this.brush.addChild(g);
        this.app.renderer.render({
          container: this.brush,
          target: this.manualTexture,
          clear: false,
        });
        this.brush.removeChild(g);
        g.destroy();
      } else {
        this.erase(this.manualTexture, poly);
        // A GM reveal also uncovers terrain and tokens the viewers have no sight of.
        this.erase(this.texture, poly);
      }
    }
  }

  /**
   * What is in sight right now: the veil dims everything else. An empty list dims every
   * explored area (nothing is currently seen).
   */
  setVisible(polys: readonly Float32Array[]): void {
    const dim = new Graphics();
    dim
      .rect(0, 0, this.visibleTexture.width, this.visibleTexture.height)
      .fill({ color: 0x000000, alpha: FOG_DIM_ALPHA });
    this.app.renderer.render({ container: dim, target: this.visibleTexture, clear: true });
    dim.destroy();
    for (const poly of polys) this.erase(this.visibleTexture, poly);
  }

  /** PNG of the explored map (full texture resolution by default; `targetWidth` downscales). */
  async readbackPng(targetWidth: number = this.texture.width): Promise<Uint8Array> {
    const src = this.app.renderer.extract.canvas(this.texture) as HTMLCanvasElement;
    if (targetWidth >= this.texture.width) return canvasToPng(src);
    const thumb = document.createElement("canvas");
    thumb.width = targetWidth;
    thumb.height = Math.max(
      1,
      Math.round((this.texture.height / this.texture.width) * targetWidth),
    );
    const ctx = thumb.getContext("2d");
    if (!ctx) throw new Error("fog readback: no 2d context");
    ctx.drawImage(src, 0, 0, thumb.width, thumb.height);
    return canvasToPng(thumb);
  }

  /**
   * Fold a stored explored map into this one: a pixel stays covered only where BOTH maps
   * cover it (`destination-in` multiplies the alphas), so explored areas are the union.
   * Any PNG size is accepted — it is stretched to the texture.
   */
  async mergePng(png: Uint8Array): Promise<void> {
    const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
    try {
      if (this.destroyed) return;
      const canvas = this.app.renderer.extract.canvas(this.texture) as HTMLCanvasElement;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("fog merge: no 2d context");
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const merged = Texture.from(canvas);
      const sprite = new Sprite(merged);
      sprite.width = this.texture.width;
      sprite.height = this.texture.height;
      this.app.renderer.render({ container: sprite, target: this.texture, clear: true });
      sprite.destroy();
      merged.destroy(true);
    } finally {
      bitmap.close();
    }
  }

  /** Share of the map that is explored (alpha < ½), 0..1 — a readback for tests/e2e. */
  exploredFraction(): number {
    const { pixels, width, height } = this.app.renderer.extract.pixels(this.texture);
    const total = width * height;
    if (total === 0) return 0;
    let explored = 0;
    for (let i = 3; i < pixels.length; i += 4) if ((pixels[i] ?? 255) < 128) explored++;
    return explored / total;
  }

  /** Is the world point explored (alpha < ½)? */
  exploredAt(worldX: number, worldY: number): boolean {
    const { pixels, width, height } = this.app.renderer.extract.pixels(this.texture);
    const s = this.scale();
    const px = Math.min(width - 1, Math.max(0, Math.floor((worldX - this.sceneBounds.x) * s)));
    const py = Math.min(height - 1, Math.max(0, Math.floor((worldY - this.sceneBounds.y) * s)));
    return (pixels[(py * width + px) * 4 + 3] ?? 255) < 128;
  }

  /** Viewport rejection helper (kept for the app loop). */
  coversView(camera: Camera, viewport: Viewport): boolean {
    void camera;
    void viewport;
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.container.destroy({ children: true });
    this.brush.destroy({ children: true });
    this.texture.destroy();
    this.visibleTexture.destroy();
  }
}
