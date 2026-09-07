/**
 * §7 asset worker client — an ImageCodec backed by the real asset.worker.ts.
 * Instantiated in browser contexts (GM import UI); tests inject a fake codec.
 */
import type {
  AssetJob,
  AssetJobBody,
  AssetJobResult,
  DerivedImage,
  DerivedTiles,
  DeriveTarget,
  ImageCodec,
} from "./assetJob";
// Inline worker: embedded in the bundle (data URL) — the single-file
// deliverable has no separate worker chunk to fetch (D-059).
import AssetWorkerCtor from "./asset.worker.ts?worker&inline";

/**
 * Main-thread decode fallback (D-082): direct Blob bitmaps first, then
 * Image over a data: URL (decodes under opaque/file:// origins in every
 * engine) drawn through a canvas.
 */
async function mainThreadDecode(bytes: Uint8Array): Promise<ImageBitmap> {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer]);
  try {
    return await createImageBitmap(blob);
  } catch {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < copy.length; i += CHUNK) {
      binary += String.fromCharCode(...copy.subarray(i, i + CHUNK));
    }
    const url = `data:application/octet-stream;base64,${btoa(binary)}`;
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("main-thread decode: image load failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("main-thread decode: no 2d context");
    g.drawImage(img, 0, 0);
    return await createImageBitmap(canvas);
  }
}

export class AssetWorkerCodec implements ImageCodec {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: AssetJobResult) => void; reject: (e: Error) => void }
  >();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new AssetWorkerCtor();
    worker.onmessage = (ev: MessageEvent<AssetJobResult>) => {
      const waiter = this.pending.get(ev.data.id);
      if (!waiter) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) waiter.resolve(ev.data);
      else waiter.reject(new Error(ev.data.error));
    };
    worker.onerror = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("asset worker crashed"));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private call(job: AssetJobBody, transfer: ArrayBuffer[]): Promise<AssetJobResult> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<AssetJobResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...job, id } as AssetJob, transfer);
    }).catch(async (err: unknown) => {
      // D-082: worker-side decode can be unavailable (WebKit opaque-origin
      // workers cannot load Blobs; some Firefox builds reject Blob bitmaps)
      // — retry the SAME job on the main thread with a robust decode.
      void worker;
      return this.callMainThread({ ...job, id }, err);
    });
  }

  private async callMainThread(job: AssetJob, cause: unknown): Promise<AssetJobResult> {
    const { runAssetJob } = await import("./assetJobRun");
    try {
      const { result } = await runAssetJob(job, mainThreadDecode);
      return result;
    } catch (err) {
      const message = `asset job failed (worker: ${String(cause)}; main: ${String(err)})`;
      throw err instanceof Error ? new Error(message, { cause: err }) : new Error(message);
    }
  }

  async metadata(bytes: Uint8Array, mime: string) {
    // No transfer: the import pipeline reuses `bytes` for derive() afterwards,
    // and metadata is a one-shot cold path (D-059).
    const result = await this.call({ kind: "metadata", bytes, mime }, []);
    if (!("width" in result)) throw new Error("asset worker: unexpected metadata result");
    return { width: result.width, height: result.height };
  }

  async derive(
    bytes: Uint8Array,
    mime: string,
    targets: readonly DeriveTarget[],
  ): Promise<DerivedImage[]> {
    // No transfer: the import pipeline reuses `bytes` (asset-store hashing)
    // after derive(); all codec paths are cold import-time calls (D-059).
    const result = await this.call({ kind: "derive", bytes, mime, targets: [...targets] }, []);
    if (!("derived" in result)) throw new Error("asset worker: unexpected derive result");
    return result.derived;
  }

  async tile(
    bytes: Uint8Array,
    mime: string,
    tileSize: number,
    outputMime: string,
    quality?: number,
  ): Promise<DerivedTiles> {
    const result = await this.call(
      {
        kind: "tile",
        bytes,
        mime,
        tileSize,
        outputMime,
        ...(quality !== undefined ? { quality } : {}),
      },
      [],
    );
    if (!("tiles" in result)) throw new Error("asset worker: unexpected tile result");
    return result.tiles;
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error("asset worker closed"));
    this.pending.clear();
  }
}
