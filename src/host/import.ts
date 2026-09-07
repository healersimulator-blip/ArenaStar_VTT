/**
 * §7 import pipeline (host): hashing + 256 px thumbnail + mid-res WebP via an
 * ImageCodec (the asset worker in browsers, §17), and >4096 px map tiling.
 *
 * Every derived artifact is itself a content-addressed asset; the manifest
 * entry of the ORIGINAL hash gains { width, height, thumb, mid, tiles? }
 * descriptors so clients can render thumbnail → mid → full (§7).
 */
import type { AssetId } from "../core/ids";
import type { AssetManifestEntry, AssetTiles, AssetVariant } from "../core/documents";
import type { AssetServer, ImportedAsset } from "./assets";
import type { DerivedImage, ImageCodec } from "../workers/assetJob";

export interface ImportPipelineOptions {
  /** Thumbnail longest-edge cap (default 256, §7). */
  thumbEdge?: number;
  /** Mid-res longest-edge cap (default 1024, D-042). */
  midEdge?: number;
  /** Maps larger than this on a side are tiled (default 4096, §7). */
  tileEdge?: number;
  /** Tile grid size (default 1024, D-042). */
  tileSize?: number;
}

export interface ImportedImage {
  hash: AssetId;
  entry: AssetManifestEntry;
}

const THUMB_MIME = "image/webp";
const MID_MIME = "image/webp";
const TILE_MIME = "image/webp";
const QUALITY = 0.8;
const TILE_QUALITY = 0.85;

export class ImportPipeline {
  private readonly thumbEdge: number;
  private readonly midEdge: number;
  private readonly tileEdge: number;
  private readonly tileSize: number;

  constructor(
    private readonly server: AssetServer,
    private readonly codec: ImageCodec,
    options: ImportPipelineOptions = {},
  ) {
    this.thumbEdge = options.thumbEdge ?? 256;
    this.midEdge = options.midEdge ?? 1024;
    this.tileEdge = options.tileEdge ?? 4096;
    this.tileSize = options.tileSize ?? 1024;
  }

  /** Import an image: full bytes + thumbnail + mid-res (+ tiles when large). */
  async importImage(bytes: Uint8Array, name: string, mime: string): Promise<ImportedImage> {
    const meta = await this.codec.metadata(bytes, mime);
    const derived = await this.codec.derive(bytes, mime, [
      { maxEdge: this.thumbEdge, mime: THUMB_MIME, quality: QUALITY },
      { maxEdge: this.midEdge, mime: MID_MIME, quality: QUALITY },
    ]);
    const [thumb, mid] = derived;
    if (!thumb || !mid)
      throw new Error("import pipeline: codec returned fewer variants than targets");

    const full = await this.server.import(bytes, name, mime);
    const thumbAsset = await this.server.import(thumb.bytes, `${name}#thumb`, thumb.mime);
    const midAsset = await this.server.import(mid.bytes, `${name}#mid`, mid.mime);

    const patch: Partial<AssetManifestEntry> = {
      width: meta.width,
      height: meta.height,
      thumb: variant(thumbAsset, thumb),
      mid: variant(midAsset, mid),
    };

    if (meta.width > this.tileEdge || meta.height > this.tileEdge) {
      const grid = await this.codec.tile(bytes, mime, this.tileSize, TILE_MIME, TILE_QUALITY);
      const ids: AssetId[] = [];
      for (let i = 0; i < grid.tiles.length; i++) {
        const tile = grid.tiles[i];
        if (!tile) throw new Error(`import pipeline: missing tile ${i}`);
        const stored = await this.server.import(tile.bytes, `${name}#tile${i}`, tile.mime);
        ids.push(stored.hash);
      }
      const tiles: AssetTiles = { size: grid.size, cols: grid.cols, rows: grid.rows, ids };
      patch.tiles = tiles;
    }

    const entry = await this.server.describe(full.hash, patch);
    return { hash: full.hash, entry };
  }
}

function variant(asset: ImportedAsset, image: DerivedImage): AssetVariant {
  return { assetId: asset.hash, width: image.width, height: image.height };
}
