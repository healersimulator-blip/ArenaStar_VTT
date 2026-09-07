/**
 * Shared §7 asset-job runner (D-082): the SAME logic runs in asset.worker.ts
 * (primary, off-thread) and — when worker-side image decoding is unavailable
 * (WebKit: opaque-origin workers cannot read Blobs; Firefox headless rejects
 * Blob bitmaps) — on the main thread via AssetWorkerCodec's fallback decode.
 * Pure over an injected `decode(bytes) → ImageBitmap`.
 */
import type { AssetJob, AssetJobResult, DerivedImage, DerivedTiles } from "./assetJob";
import { fitWithin } from "./assetJob";

async function encode(
  source: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  outW: number,
  outH: number,
  mime: string,
  quality: number,
): Promise<DerivedImage> {
  const canvas = new OffscreenCanvas(outW, outH);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("asset job: no 2d context");
  g.drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);
  const blob = await canvas.convertToBlob({ type: mime, quality });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime,
    width: outW,
    height: outH,
  };
}

function qualityOf(target: { quality?: number }): number {
  return target.quality ?? 0.8;
}

export async function runAssetJob(
  job: AssetJob,
  decode: (bytes: Uint8Array) => Promise<ImageBitmap>,
): Promise<{ result: AssetJobResult; transfer: ArrayBuffer[] }> {
  switch (job.kind) {
    case "metadata": {
      const bitmap = await decode(job.bytes);
      const result: AssetJobResult = {
        id: job.id,
        ok: true,
        width: bitmap.width,
        height: bitmap.height,
      };
      bitmap.close();
      return { result, transfer: [] };
    }
    case "derive": {
      const bitmap = await decode(job.bytes);
      try {
        const derived: DerivedImage[] = [];
        for (const target of job.targets) {
          const { width, height } = fitWithin(bitmap.width, bitmap.height, target.maxEdge);
          derived.push(
            await encode(
              bitmap,
              0,
              0,
              bitmap.width,
              bitmap.height,
              width,
              height,
              target.mime,
              qualityOf(target),
            ),
          );
        }
        return {
          result: { id: job.id, ok: true, derived },
          transfer: derived.map((d) => d.bytes.buffer as ArrayBuffer),
        };
      } finally {
        bitmap.close();
      }
    }
    case "tile": {
      const bitmap = await decode(job.bytes);
      try {
        const cols = Math.ceil(bitmap.width / job.tileSize);
        const rows = Math.ceil(bitmap.height / job.tileSize);
        const tiles: DerivedImage[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const sx = c * job.tileSize;
            const sy = r * job.tileSize;
            tiles.push(
              await encode(
                bitmap,
                sx,
                sy,
                Math.min(job.tileSize, bitmap.width - sx),
                Math.min(job.tileSize, bitmap.height - sy),
                Math.min(job.tileSize, bitmap.width - sx),
                Math.min(job.tileSize, bitmap.height - sy),
                job.outputMime,
                qualityOf(job),
              ),
            );
          }
        }
        const out: DerivedTiles = { cols, rows, size: job.tileSize, tiles };
        return {
          result: { id: job.id, ok: true, tiles: out },
          transfer: tiles.map((t) => t.bytes.buffer as ArrayBuffer),
        };
      } finally {
        bitmap.close();
      }
    }
  }
}
