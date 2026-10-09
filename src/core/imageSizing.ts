/**
 * Image handling foundations: byte/header validation and pixel-space sizing rules.
 *
 * The header parser runs before an image decoder is asked to allocate a bitmap. It is intentionally
 * small and conservative: unsupported/malformed containers fail closed, and the decoded dimensions
 * are checked a second time by the host pipeline after EXIF orientation has been applied.
 */
import type { SceneDocument } from "./documents";

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 100_000_000;

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "avif";

export interface SniffedImage {
  format: ImageFormat;
  mime: `image/${string}`;
  width: number;
  height: number;
}

export interface SceneSize {
  width: number;
  height: number;
}

export interface GridFromImageResult {
  size: number;
  /** True when the chosen size does not divide the image height within one pixel. */
  heightAlignmentWarning: boolean;
}

export interface BackgroundBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  paddingPx: number;
}

export interface TileSize {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) result += String.fromCharCode(bytes[offset + i] ?? 0);
  return result;
}

function hasFourCc(bytes: Uint8Array, offset: number, value: string): boolean {
  return bytes[offset] === value.charCodeAt(0) && bytes[offset + 1] === value.charCodeAt(1) &&
    bytes[offset + 2] === value.charCodeAt(2) && bytes[offset + 3] === value.charCodeAt(3);
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid image dimensions: ${width}×${height}`);
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()}-pixel limit`);
  }
}

export function assertImageByteLength(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Image file is empty or has an invalid size");
  if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 64 MB source-file limit");
}

function pngDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  if (ascii(bytes, 12, 4) !== "IHDR" || u32be(bytes, 8) < 13) {
    throw new Error("Malformed PNG header");
  }
  return [u32be(bytes, 16), u32be(bytes, 20)];
}

function gifDimensions(bytes: Uint8Array): [number, number] | null {
  const sig = ascii(bytes, 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  if (bytes.length < 10) throw new Error("Malformed GIF header");
  return [u16le(bytes, 6), u16le(bytes, 8)];
}

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] !== 0xff && offset < bytes.length) offset++;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++] ?? 0;
    // Standalone markers carry no length.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("Malformed JPEG segment");
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) throw new Error("Malformed JPEG frame header");
      return [u16be(bytes, offset + 5), u16be(bytes, offset + 3)];
    }
    // No frame header can follow the compressed scan data.
    if (marker === 0xda || marker === 0xd9) break;
    offset += length;
  }
  throw new Error("JPEG does not contain a readable frame-size header");
}

function webpDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    if (bytes.length < 30) throw new Error("Malformed WebP VP8X header");
    return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1];
  }
  if (chunk === "VP8 ") {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new Error("Malformed WebP VP8 header");
    }
    return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) throw new Error("Malformed WebP VP8L header");
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return [1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))];
  }
  throw new Error(`Unsupported WebP bitstream: ${chunk || "missing image chunk"}`);
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
  const major = ascii(bytes, 8, 4);
  if (major === "avif" || major === "avis") return true;
  // Compatible brands are 4-byte entries after the minor-version word.
  for (let i = 16; i + 4 <= Math.min(bytes.length, 128); i += 4) {
    const brand = ascii(bytes, i, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

function avifDimensions(bytes: Uint8Array): [number, number] | null {
  if (!isAvif(bytes)) return null;
  // AVIF dimensions are carried by ISO-BMFF `ispe` full boxes. Containers can carry
  // multiple item properties (e.g. an auxiliary image or thumbnail), so apply the cap
  // to the largest declared image rather than trusting the first box to be the primary.
  // The source is already capped at 64 MB; scan bytes without allocating or decoding.
  let largest: [number, number] | null = null;
  for (let i = 4; i + 16 <= bytes.length; i++) {
    if (!hasFourCc(bytes, i, "ispe")) continue;
    const boxSize = u32be(bytes, i - 4);
    if (boxSize < 20 || i - 4 + boxSize > bytes.length) continue;
    const dimensions: [number, number] = [u32be(bytes, i + 8), u32be(bytes, i + 12)];
    if (!largest || dimensions[0] * dimensions[1] > largest[0] * largest[1]) largest = dimensions;
  }
  if (!largest) throw new Error("AVIF does not contain a readable ispe dimensions box");
  return largest;
}

/**
 * Detect an image from its bytes, not the supplied filename or MIME. SVG and unknown containers
 * are deliberately rejected. The returned dimensions are header dimensions before EXIF orientation.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage {
  assertImageByteLength(bytes.byteLength);
  let format: ImageFormat | null = null;
  let dimensions: [number, number] | null = null;
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    format = "png";
    dimensions = pngDimensions(bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = "jpeg";
    dimensions = jpegDimensions(bytes);
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    format = "webp";
    dimensions = webpDimensions(bytes);
  } else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    format = "gif";
    dimensions = gifDimensions(bytes);
  } else if (isAvif(bytes)) {
    format = "avif";
    dimensions = avifDimensions(bytes);
  }
  if (!format || !dimensions) {
    throw new Error("Unsupported or malformed image. Accepted formats: PNG, JPEG, WebP, GIF and AVIF; SVG is not supported.");
  }
  const [width, height] = dimensions;
  assertDimensions(width, height);
  return {
    format,
    mime: `image/${format === "jpeg" ? "jpeg" : format}`,
    width,
    height,
  };
}

/** Check post-decode (EXIF-oriented) dimensions as a second decompression-bomb guard. */
/** A video background container (Phase 4, §11 decision 7). Only the container is recognised here. */
export interface SniffedVideo {
  kind: "video";
  mime: "video/webm" | "video/mp4";
}

export type SniffedMedia = ({ kind: "image" } & SniffedImage) | SniffedVideo;

/**
 * WebM (EBML header) or MP4 (ISO BMFF `ftyp` box). AVIF also uses `ftyp`, so it is excluded here and
 * stays an image. The codecs inside the container are the browser's to decode, not the host's.
 */
export function sniffVideo(bytes: Uint8Array): SniffedVideo | null {
  assertImageByteLength(bytes.byteLength);
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { kind: "video", mime: "video/webm" };
  }
  if (ascii(bytes, 4, 4) === "ftyp" && !isAvif(bytes)) return { kind: "video", mime: "video/mp4" };
  return null;
}

/** Image or video container, by magic bytes. Anything else is rejected with the image message. */
export function sniffMedia(bytes: Uint8Array): SniffedMedia {
  const video = sniffVideo(bytes);
  if (video) return video;
  return { kind: "image", ...sniffImage(bytes) };
}

export function isVideoMime(mime: string): boolean {
  return mime === "video/webm" || mime === "video/mp4";
}

export function validateDecodedDimensions(width: number, height: number): void {
  assertDimensions(width, height);
}

/** Foundry-style naming: strip only the final extension, replace `_` and `+`, then trim. */
export function normalizeImageName(filename: string): string {
  const leaf = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const withoutExtension = leaf.replace(/\.[^.]*$/, "");
  const normalized = withoutExtension.replace(/[_+]/g, " ").trim();
  return normalized.slice(0, 160) || "Image";
}

function removeControlCharacters(value: string): string {
  let clean = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f)) clean += character;
  }
  return clean;
}

export function normalizeLogicalFolder(folder: string): string {
  return folder
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => removeControlCharacters(part.trim()))
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 240);
}

export function validateHttpsImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a complete image URL beginning with https://");
  }
  if (url.protocol !== "https:") throw new Error("Only HTTPS image URLs are allowed");
  if (!url.hostname) throw new Error("The image URL has no host");
  return url;
}

export function isPinterestPinPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return /(^|\.)pinterest\.[a-z.]+$/i.test(url.hostname) && /\/pin\//i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Image dimensions are the default scene dimensions. */
export function sceneSizeFromImage(image: Pick<SniffedImage, "width" | "height">): SceneSize {
  validateDecodedDimensions(image.width, image.height);
  return { width: image.width, height: image.height };
}

/** Change one scene dimension and derive the other, rounded to the nearest pixel. */
export function aspectLockedSize(
  original: SceneSize,
  edited: "width" | "height",
  value: number,
): SceneSize {
  if (!Number.isFinite(value) || value < 1) throw new Error("Scene dimensions must be positive numbers");
  const next = Math.max(1, Math.round(value));
  const ratio = original.width / original.height;
  const result = edited === "width"
    ? { width: next, height: Math.max(1, Math.round(next / ratio)) }
    : { width: Math.max(1, Math.round(next * ratio)), height: next };
  return result;
}

/** Grid size from a pre-gridded map. Sizes below 50px are refused. */
export function gridFromImage(width: number, height: number, columns: number): GridFromImageResult {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      !Number.isSafeInteger(columns) || columns < 1) {
    throw new Error("Image dimensions and square count must be positive");
  }
  const size = Math.round(width / columns);
  if (size < 50) throw new Error("The resulting grid size is below the 50px minimum");
  const rows = Math.round(height / size);
  const heightAlignmentWarning = Math.abs(height - rows * size) > 1;
  return { size, heightAlignmentWarning };
}

/** Image-space scene rectangle, including the unlit padding margin. */
export function backgroundBounds(width: number, height: number, padding: number): BackgroundBounds {
  if (![width, height, padding].every(Number.isFinite) || width <= 0 || height <= 0 || padding < 0 || padding > 1) {
    throw new Error("Invalid scene size or background padding");
  }
  const paddingPx = padding * Math.max(width, height);
  return { x: -paddingPx, y: -paddingPx, width: width + paddingPx * 2, height: height + paddingPx * 2, paddingPx };
}

/** Asset Grid Size tile dimensions from the asset's intrinsic pixel size. */
export function tileAtAssetGridSize(
  image: SceneSize,
  assetGridSize: number,
  sceneGridSize: number,
  scene: SceneSize,
): TileSize {
  if (![image.width, image.height, assetGridSize, sceneGridSize, scene.width, scene.height].every(Number.isFinite) ||
      image.width <= 0 || image.height <= 0 || assetGridSize <= 0 || sceneGridSize <= 0 || scene.width <= 0 || scene.height <= 0) {
    throw new Error("Invalid dimensions for Asset Grid Size");
  }
  const width = image.width / assetGridSize * sceneGridSize;
  const height = image.height / assetGridSize * sceneGridSize;
  return { x: (scene.width - width) / 2, y: (scene.height - height) / 2, width, height };
}

/** Centre an image at natural pixel dimensions in the scene. */
export function tileAtNaturalSize(image: SceneSize, scene: SceneSize): TileSize {
  return { x: (scene.width - image.width) / 2, y: (scene.height - image.height) / 2, width: image.width, height: image.height };
}

/** Largest aspect-preserving rectangle that fits a scene, centred. */
export function fitTileToScene(image: SceneSize, scene: SceneSize): TileSize {
  if ([image.width, image.height, scene.width, scene.height].some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error("Invalid dimensions for fit-to-scene tile");
  }
  const scale = Math.min(scene.width / image.width, scene.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (scene.width - width) / 2, y: (scene.height - height) / 2, width, height };
}

/**
 * Rescale every documented pixel-space placeable when a GM explicitly asks. X/Y ratios are applied
 * independently to rectangular geometry and point arrays. Circle/radius fields use the geometric
 * mean ratio (area-preserving approximation); rotations, elevations, grid-unit/template distances,
 * normalized region/tile polygons, and unrelated system data are left unchanged. This function is
 * pure so the caller can submit all returned diffs in one undoable HostSync envelope.
 */
export function rescaleScenePlaceables(scene: SceneDocument, width: number, height: number): SceneDocument {
  if (![width, height].every((v) => Number.isFinite(v) && v > 0)) throw new Error("Scene dimensions must be positive");
  const sx = width / scene.width;
  const sy = height / scene.height;
  const sr = Math.sqrt(sx * sy);
  return {
    ...scene,
    width,
    height,
    tokens: scene.tokens.map((token) => ({
      ...token, x: token.x * sx, y: token.y * sy, width: token.width * sx, height: token.height * sy,
    })),
    walls: scene.walls.map((wall) => ({
      ...wall, c: [wall.c[0] * sx, wall.c[1] * sy, wall.c[2] * sx, wall.c[3] * sy],
    })),
    ...(scene.cells ? { cells: scene.cells.map((cell) => ({
      ...cell,
      ...(cell.poly ? { poly: cell.poly.map((v, i) => v * (i % 2 === 0 ? sx : sy)) } : {}),
    })) } : {}),
    lights: scene.lights.map((light) => ({
      ...light, x: light.x * sx, y: light.y * sy, dim: light.dim * sr, bright: light.bright * sr,
    })),
    sounds: scene.sounds.map((sound) => ({
      ...sound, x: sound.x * sx, y: sound.y * sy, radius: sound.radius * sr,
    })),
    tiles: scene.tiles.map((tile) => ({
      ...tile, x: tile.x * sx, y: tile.y * sy, width: tile.width * sx, height: tile.height * sy,
    })),
    ...(scene.regions ? { regions: scene.regions.map((region) => ({
      ...region, x: region.x * sx, y: region.y * sy, width: region.width * sx, height: region.height * sy,
    })) } : {}),
    drawings: scene.drawings.map((drawing) => ({
      ...drawing,
      points: drawing.points.map((v, i) => v * (i % 2 === 0 ? sx : sy)),
      box: drawing.box ? [drawing.box[0] * sx, drawing.box[1] * sy, drawing.box[2] * sx, drawing.box[3] * sy] : null,
      strokeWidth: drawing.strokeWidth * sr,
    })),
    templates: scene.templates.map((template) => ({ ...template, x: template.x * sx, y: template.y * sy })),
    notes: scene.notes.map((note) => ({ ...note, x: note.x * sx, y: note.y * sy })),
  };
}

/** Convenience used by image alignment previews. */
export function scenePoint(x: number, y: number, offsetX: number, offsetY: number, scale: number) {
  return { x: offsetX + x * scale, y: offsetY + y * scale };
}
