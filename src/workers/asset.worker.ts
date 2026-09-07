/**
 * §7 asset worker — hashing-class image work off the main thread (§17 quality
 * bar: asset hashing/resizing in Workers). Decodes via createImageBitmap and
 * encodes via OffscreenCanvas; speaks the AssetJob/AssetJobResult contract.
 * Job logic lives in assetJobRun.ts (shared with the main-thread fallback).
 */
import type { AssetJob, AssetJobResult } from "./assetJob";
import { runAssetJob } from "./assetJobRun";

interface WorkerCtx {
  onmessage: ((ev: MessageEvent<AssetJob>) => void) | null;
  postMessage(msg: AssetJobResult, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerCtx;

async function decode(bytes: Uint8Array): Promise<ImageBitmap> {
  const copy = new Uint8Array(bytes); // createImageBitmap may detach
  return createImageBitmap(new Blob([copy.buffer as ArrayBuffer]));
}

ctx.onmessage = (ev: MessageEvent<AssetJob>) => {
  const job = ev.data;
  void (async () => {
    try {
      const { result, transfer } = await runAssetJob(job, decode);
      ctx.postMessage(result, transfer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.postMessage({
        id: (job as { id: number }).id,
        ok: false,
        error: message,
      } satisfies AssetJobResult);
    }
  })();
};
