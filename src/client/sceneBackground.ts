/** Latest-scene-wins background loading shared by GM and player shells.
 * Checks both fetch and decode races (the stage guards decode), and never lets
 * a late thumbnail replace a full image. Clearing removes the visible image now.
 */
import type { AssetManifest } from "../core/documents";

export interface BackgroundView {
  clearBackgroundImage(): void;
  setBackgroundImage(bytes: Uint8Array, mime?: string): Promise<void>;
}
export class SceneBackgroundPlayer {
  private revision = 0;
  private hash: string | null | undefined;
  private view: BackgroundView | undefined;

  sync(hash: string | null, manifest: AssetManifest,
    fetch: (hash: string, priority: "ui" | "scene") => Promise<Uint8Array>, view: BackgroundView): void {
    if (this.hash === hash && this.view === view) return;
    this.hash = hash;
    this.view = view;
    const revision = ++this.revision;
    view.clearBackgroundImage();
    if (hash === null) return;
    let fullStarted = false;
    const current = () => revision === this.revision;
    const entry = manifest[hash];
    const thumbnail = entry?.thumb?.assetId;
    if (thumbnail && thumbnail !== hash) {
      void fetch(thumbnail, "ui").then((bytes) => {
        if (current() && !fullStarted) return view.setBackgroundImage(bytes, manifest[thumbnail]?.mime ?? "image/webp");
      }).catch(() => undefined);
    }
    void fetch(hash, "scene").then((bytes) => {
      if (!current()) return;
      fullStarted = true;
      return view.setBackgroundImage(bytes, entry?.mime ?? "image/png");
    }).catch(() => undefined);
  }

  destroy(): void {
    this.revision++;
    this.hash = undefined;
    this.view = undefined;
  }
}
