/**
 * Host image pipeline: validate source bytes before decode, preserve originals by default, and
 * produce content-addressed thumbnails/mid-res/WebP map tiles. Asset bytes live outside HostSync ops;
 * callers that create documents must submit those references through ClientSync/HostSync separately.
 */
import type { AssetId } from "../core/ids";
import type { AssetManifestEntry, AssetTiles } from "../core/documents";
import { addLogicalFileAlias, type LogicalFileAlias } from "../core/imageHandling";
import { normalizeLogicalFolder, sniffImage, validateDecodedDimensions } from "../core/imageSizing";
import { sha256Hex, type AssetServer, type ImportedAsset } from "./assets";
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

export interface ImageImportOptions {
  /** Optional audience policy; imports default to referenced. */
  visibility?: NonNullable<AssetManifestEntry["visibility"]>;
  /** No ordinary image import changes exportRights. */
  source?: AssetManifestEntry["source"];
  /** Logical folder/name alias; does not affect hash identity. */
  logicalFile?: LogicalFileAlias;
  /** Logical-folder collision policy; `ask` is resolved by the preview dialog before upload. */
  logicalFileBehavior?: "stop" | "reuse" | "overwrite";
  /** Preference-driven WebP encoding for the primary blob; false preserves original bytes. */
  convertToWebp?: boolean;
  /** Primary WebP quality; thumb/mid retain the repository's 0.8 quality. */
  webpQuality?: number;
  /** Re-check authorization/quota and durably audit immediately before the import commits. */
  beforeStore?: (context: { assetHash: AssetId; preparedHash: AssetId; reused: boolean }) => void | Promise<void>;
}

export interface ImportedImage {
  hash: AssetId;
  entry: AssetManifestEntry;
}

const WEBP_MIME = "image/webp";
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

  /** Validate bytes and dimensions before asking the image codec to allocate a bitmap. */
  async importImage(
    bytes: Uint8Array,
    name: string,
    _callerMime: string,
    options: ImageImportOptions = {},
  ): Promise<ImportedImage> {
    const sniffed = sniffImage(bytes);
    const quality = clampQuality(options.webpQuality ?? QUALITY);
    // Header dimensions (pre-EXIF) are a first guard before browser decoding. The codec's bitmap
    // dimensions are checked again below; EXIF orientation may legitimately swap width and height.
    const meta = await this.codec.metadata(bytes, sniffed.mime);
    validateDecodedDimensions(meta.width, meta.height);
    const targets = [
      ...(options.convertToWebp ? [{ maxEdge: Math.max(meta.width, meta.height), mime: WEBP_MIME, quality }] : []),
      { maxEdge: this.thumbEdge, mime: WEBP_MIME, quality: QUALITY },
      { maxEdge: this.midEdge, mime: WEBP_MIME, quality: QUALITY },
    ];
    const derived = await this.codec.derive(bytes, sniffed.mime, targets);
    const fullImage = options.convertToWebp ? derived[0] : undefined;
    const thumbImage = derived[options.convertToWebp ? 1 : 0];
    const midImage = derived[options.convertToWebp ? 2 : 1];
    if (!thumbImage || !midImage || (options.convertToWebp && !fullImage)) {
      throw new Error("import pipeline: codec returned fewer variants than targets");
    }
    const visibility = options.visibility ?? "referenced";
    const source = options.source ? structuredClone(options.source) : undefined;
    const fullName = name;
    const fullBytes = fullImage?.bytes ?? bytes;
    const fullMime = fullImage?.mime ?? sniffed.mime;
    const logicalFile = options.logicalFile
      ? { folder: normalizeLogicalFolder(options.logicalFile.folder), name: options.logicalFile.name.trim().slice(0, 1024) }
      : undefined;
    const logicalBehavior = options.logicalFileBehavior ?? "stop";
    const fullHash = await sha256Hex(fullBytes);
    const preparedHash = fullHash as AssetId;
    const logicalConflicts = logicalFile
      ? Object.entries(await this.server.manifest())
          .filter(([hash, entry]) => hash !== fullHash && entry.logicalFiles?.some((file) =>
            file.folder === logicalFile.folder && file.name.toLocaleLowerCase() === logicalFile.name.toLocaleLowerCase()))
          .sort(([a], [b]) => a.localeCompare(b))
      : [];
    if (logicalConflicts.length > 0 && logicalBehavior === "stop") {
      throw new Error(`A file named “${logicalFile?.name ?? name}” already exists in “${logicalFile?.folder ?? ""}”`);
    }
    if (logicalConflicts.length > 0 && logicalBehavior === "reuse") {
      const existing = logicalConflicts[0];
      if (!existing) throw new Error("Logical image collision disappeared before reuse");
      const hash = existing[0] as AssetId;
      await options.beforeStore?.({ assetHash: hash, preparedHash, reused: true });
      return { hash, entry: existing[1] };
    }
    await options.beforeStore?.({ assetHash: preparedHash, preparedHash, reused: false });
    const full = await this.server.import(
      fullBytes,
      fullName,
      fullMime,
      visibility,
      undefined,
      {
        ...(source ? { source } : {}),
        ingest: options.convertToWebp ? { format: "webp", quality } : { format: "original" },
        ...(logicalFile ? { logicalFiles: [logicalFile] } : {}),
      },
    );
    if (logicalConflicts.length > 0 && logicalBehavior === "overwrite" && logicalFile) {
      for (const [oldHash, oldEntry] of logicalConflicts) {
        await this.server.describe(oldHash as AssetId, {
          logicalFiles: (oldEntry.logicalFiles ?? []).filter((file) =>
            file.folder !== logicalFile.folder || file.name.toLocaleLowerCase() !== logicalFile.name.toLocaleLowerCase()),
        });
      }
    }
    const thumbAsset = await this.server.import(thumbImage.bytes, `${name}#thumb`, thumbImage.mime);
    const midAsset = await this.server.import(midImage.bytes, `${name}#mid`, midImage.mime);

    const patch: Partial<AssetManifestEntry> = {
      width: meta.width,
      height: meta.height,
      thumb: variant(thumbAsset, thumbImage),
      mid: variant(midAsset, midImage),
    };

    if (meta.width > this.tileEdge || meta.height > this.tileEdge) {
      const grid = await this.codec.tile(bytes, sniffed.mime, this.tileSize, WEBP_MIME, TILE_QUALITY);
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

    if (logicalFile) {
      const existing = await this.server.meta(full.hash);
      patch.logicalFiles = addLogicalFileAlias(existing?.logicalFiles, logicalFile);
    }
    const entry = await this.server.describe(full.hash, patch);
    return { hash: full.hash, entry };
  }
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) throw new Error("WebP quality must be a number from 0.1 to 1.0");
  return Math.min(1, Math.max(0.1, value));
}

function variant(asset: ImportedAsset, image: DerivedImage): NonNullable<AssetManifestEntry["thumb"]> {
  return { assetId: asset.hash, width: image.width, height: image.height };
}
