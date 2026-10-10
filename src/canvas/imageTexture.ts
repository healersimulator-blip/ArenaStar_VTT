/** Decode owned bytes explicitly: blob URLs have no extension for Pixi Assets to infer. */
import { Texture, VideoSource } from "pixi.js";

export async function imageTexture(bytes: Uint8Array, mime = "image/png"): Promise<Texture> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  try { return await imageUrlTexture(url); }
  finally { URL.revokeObjectURL(url); }
}

export async function imageUrlTexture(url: string): Promise<Texture> {
  if (url.startsWith("http:") || (!/^(https:|blob:|data:)/i.test(url)))
    throw new Error("Images must use HTTPS or an in-memory object URL");
  const image = new Image();
  if (/^https:/i.test(url)) image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  return Texture.from(image);
}

/**
 * A looping, muted video background (Phase 4). The texture updates from the playing element, and
 * `stop` pauses it and releases the object URL. Callers must call `stop` before destroying the texture.
 */
export async function videoTexture(bytes: Uint8Array, mime: string): Promise<{ texture: Texture; stop: () => void }> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("The browser could not play this video background"));
      video.src = url;
    });
  } catch (error) {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    throw error;
  }
  video.onerror = null;
  video.onloadeddata = null;
  const source = new VideoSource({ resource: video, autoLoad: false, autoPlay: false });
  source.isReady = true;
  const texture = new Texture({ source });
  source.update();
  void video.play().catch(() => undefined);

  // Redraw on each new frame when the browser reports them; otherwise on animation frames.
  const frames = video as unknown as {
    requestVideoFrameCallback?: (callback: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  let stopped = false;
  let frameHandle: number | null = null;
  const tick = () => {
    if (stopped) return;
    source.update();
    if (typeof frames.requestVideoFrameCallback === "function") frameHandle = frames.requestVideoFrameCallback(tick);
    else frameHandle = window.requestAnimationFrame(tick);
  };
  tick();

  return {
    texture,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (frameHandle !== null) {
        if (typeof frames.cancelVideoFrameCallback === "function") frames.cancelVideoFrameCallback(frameHandle);
        else window.cancelAnimationFrame(frameHandle);
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** Shared tile textures, owned by one canvas. Prune only after its views reconcile. */
export class TileImageCache {
  private readonly entries = new Map<string, Promise<Texture | null>>();
  constructor(private readonly fetch: (hash: string) => Promise<{ bytes: Uint8Array; mime: string }>) {}

  load = (image: string): Promise<Texture | null> => {
    const cached = this.entries.get(image);
    if (cached) return cached;
    const work: Promise<Texture | null> = Promise.resolve().then(async () => {
      try {
        const texture = /^(https?:|data:|blob:)/.test(image) ? await imageUrlTexture(image)
          : await this.fetch(image).then(({ bytes, mime }) => imageTexture(bytes, mime));
        if (this.entries.get(image) !== work) { texture.destroy(true); return null; }
        return texture;
      } catch { return null; }
    });
    this.entries.set(image, work);
    return work;
  };

  retain(images: readonly string[]): void {
    const keep = new Set(images);
    for (const [image, work] of this.entries) {
      if (keep.has(image)) continue;
      this.entries.delete(image);
      void work.then((texture) => { if (texture && !texture.destroyed) texture.destroy(true); });
    }
  }

  destroy(): void { this.retain([]); }
}
