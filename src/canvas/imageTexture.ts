/** Decode owned bytes explicitly: blob URLs have no extension for Pixi Assets to infer. */
import { Texture } from "pixi.js";

export async function imageTexture(bytes: Uint8Array, mime = "image/png"): Promise<Texture> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  try { return await imageUrlTexture(url); }
  finally { URL.revokeObjectURL(url); }
}

async function imageUrlTexture(url: string): Promise<Texture> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  return Texture.from(image);
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
