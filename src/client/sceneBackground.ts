/** Latest-scene-wins background/foreground image loading shared by GM and player shells. */
import type { AssetManifest, SceneDocument } from "../core/documents";
import type { StageBackgroundPresentation } from "../canvas/stage";

export interface BackgroundView {
  clearBackgroundImage(): void;
  setBackgroundImage(bytes: Uint8Array, mime?: string): Promise<void>;
  setBackgroundUrl?(url: string): Promise<void>;
  setBackgroundPresentation?(presentation: StageBackgroundPresentation): void;
  clearForegroundImage?(): void;
  setForegroundImage?(bytes: Uint8Array, mime?: string): Promise<void>;
  setForegroundUrl?(url: string): Promise<void>;
  setForegroundSceneSize?(width: number, height: number, elevation?: number): void;
}

/**
 * Hash-addressed sources are fetched through the normal permission-checked AssetFetcher. HTTPS URLs
 * are loaded anonymously by each browser; they are never fetched by an app proxy. Background
 * transforms update in place, without refetching the image.
 */
export class SceneBackgroundPlayer {
  private backgroundRevision = 0;
  private foregroundRevision = 0;
  private view: BackgroundView | undefined;
  private backgroundSource: string | null | undefined;
  private backgroundPresentationKey: string | null = null;
  private foregroundKey: string | null = null;

  sync(
    image: string | null,
    manifest: AssetManifest,
    fetch: (hash: string, priority: "ui" | "scene") => Promise<Uint8Array>,
    view: BackgroundView,
    scene?: Pick<SceneDocument, "width" | "height" | "background" | "foreground"> | null,
  ): void {
    const viewChanged = this.view !== view;
    if (viewChanged) {
      this.view = view;
      this.backgroundRevision++;
      this.foregroundRevision++;
      this.backgroundSource = undefined;
      this.backgroundPresentationKey = null;
      this.foregroundKey = null;
    }
    const presentation: StageBackgroundPresentation = {
      width: scene?.width ?? 2000,
      height: scene?.height ?? 1500,
      offset: scene?.background?.offset ?? { x: 0, y: 0 },
      scale: scene?.background?.scale ?? 1,
      padding: scene?.background?.padding ?? 0,
      color: scene?.background?.color ?? "#ffffff",
    };
    const presentationKey = JSON.stringify(presentation);
    if (this.backgroundPresentationKey !== presentationKey) {
      this.backgroundPresentationKey = presentationKey;
      view.setBackgroundPresentation?.(presentation);
    }

    if (viewChanged || this.backgroundSource !== image) {
      this.backgroundSource = image;
      const revision = ++this.backgroundRevision;
      const current = () => revision === this.backgroundRevision && this.view === view;
      view.clearBackgroundImage();
      if (image !== null) this.loadBackground(image, manifest, fetch, view, current);
    }
    this.syncForeground(scene ?? null, manifest, fetch, view);
  }

  private loadBackground(
    image: string,
    manifest: AssetManifest,
    fetch: (hash: string, priority: "ui" | "scene") => Promise<Uint8Array>,
    view: BackgroundView,
    current: () => boolean,
  ): void {
    if (isExternalImageUrl(image)) {
      const loading = view.setBackgroundUrl?.(image);
      void loading?.catch(() => undefined);
      return;
    }
    let fullStarted = false;
    const entry = manifest[image];
    const thumbnail = entry?.thumb?.assetId;
    if (thumbnail && thumbnail !== image) {
      void fetch(thumbnail, "ui").then((bytes) => {
        if (current() && !fullStarted) return view.setBackgroundImage(bytes, manifest[thumbnail]?.mime ?? "image/webp");
      }).catch(() => undefined);
    }
    void fetch(image, "scene").then((bytes) => {
      if (!current()) return;
      fullStarted = true;
      return view.setBackgroundImage(bytes, entry?.mime ?? "image/png");
    }).catch(() => undefined);
  }

  private syncForeground(
    scene: Pick<SceneDocument, "width" | "height" | "foreground"> | null,
    manifest: AssetManifest,
    fetch: (hash: string, priority: "ui" | "scene") => Promise<Uint8Array>,
    view: BackgroundView,
  ): void {
    const foreground = scene?.foreground;
    const key = JSON.stringify([scene?.width, scene?.height, foreground ?? null]);
    if (this.foregroundKey === key) return;
    this.foregroundKey = key;
    const revision = ++this.foregroundRevision;
    const current = () => revision === this.foregroundRevision && this.view === view;
    view.clearForegroundImage?.();
    if (!scene || !foreground?.img) return;
    view.setForegroundSceneSize?.(scene.width, scene.height, foreground.elevation ?? 0);
    if (isExternalImageUrl(foreground.img)) {
      const loading = view.setForegroundUrl?.(foreground.img);
      void loading?.catch(() => undefined);
      return;
    }
    const entry = manifest[foreground.img];
    void fetch(foreground.img, "scene").then((bytes) => {
      if (current()) return view.setForegroundImage?.(bytes, entry?.mime ?? "image/png");
    }).catch(() => undefined);
  }

  destroy(): void {
    this.backgroundRevision++;
    this.foregroundRevision++;
    this.view = undefined;
    this.backgroundSource = undefined;
    this.backgroundPresentationKey = null;
    this.foregroundKey = null;
  }
}

function isExternalImageUrl(value: string): boolean {
  return /^(https:|http:|blob:|data:)/i.test(value);
}
