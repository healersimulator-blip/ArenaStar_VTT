/**
 * §7 asset job contract — the pure vocabulary shared by the asset worker
 * (asset.worker.ts), its RPC client (assetWorkerClient.ts) and the host
 * ImportPipeline. Everything here is environment-free so Node tests can drive
 * the pipeline with a fake ImageCodec while browsers use the real worker
 * (createImageBitmap + OffscreenCanvas).
 */

/** Never upscale: scale factor = min(1, maxEdge / longest side). */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error(`fitWithin: bad dimensions ${width}x${height}`);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Row-major tile grid for a >4096 px map (§7); edge tiles are partial. */
export function tileGrid(
  width: number,
  height: number,
  tileSize: number,
): { cols: number; rows: number; size: number } {
  if (tileSize <= 0) throw new Error(`tileGrid: bad tileSize ${tileSize}`);
  return {
    cols: Math.ceil(width / tileSize),
    rows: Math.ceil(height / tileSize),
    size: tileSize,
  };
}

// ─── Codec port ───────────────────────────────────────────────────────────────

export interface DeriveTarget {
  /** Longest-edge cap; images at or below it are re-encoded unchanged in size. */
  maxEdge: number;
  mime: string;
  quality?: number;
}

export interface DerivedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface DerivedTiles {
  cols: number;
  rows: number;
  size: number;
  tiles: DerivedImage[]; // row-major
}

/**
 * Image encode port: decode once, resize/encode many times. Implemented by
 * the asset worker (browser); faked in tests.
 */
export interface ImageCodec {
  metadata(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }>;
  derive(
    bytes: Uint8Array,
    mime: string,
    targets: readonly DeriveTarget[],
  ): Promise<DerivedImage[]>;
  tile(
    bytes: Uint8Array,
    mime: string,
    tileSize: number,
    outputMime: string,
    quality?: number,
  ): Promise<DerivedTiles>;
}

// ─── Worker wire jobs (structural clones; bytes transferable) ─────────────────

/** Distributive Omit so union members keep their own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Job payload without the correlation id (client fills it in). */
export type AssetJobBody = DistributiveOmit<AssetJob, "id">;

export type AssetJob =
  | { id: number; kind: "metadata"; bytes: Uint8Array; mime: string }
  | { id: number; kind: "derive"; bytes: Uint8Array; mime: string; targets: DeriveTarget[] }
  | {
      id: number;
      kind: "tile";
      bytes: Uint8Array;
      mime: string;
      tileSize: number;
      outputMime: string;
      quality?: number;
    };

export type AssetJobResult =
  | { id: number; ok: true; width: number; height: number }
  | { id: number; ok: true; derived: DerivedImage[] }
  | { id: number; ok: true; tiles: DerivedTiles }
  | { id: number; ok: false; error: string };
