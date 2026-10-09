import { describe, expect, test } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  aspectLockedSize,
  backgroundBounds,
  fitTileToScene,
  gridFromImage,
  isPinterestPinPage,
  normalizeImageName,
  normalizeLogicalFolder,
  rescaleScenePlaceables,
  sceneSizeFromImage,
  sniffImage,
  sniffMedia,
  sniffVideo,
  tileAtAssetGridSize,
  tileAtNaturalSize,
  validateDecodedDimensions,
  validateHttpsImageUrl,
  assertImageByteLength,
} from "../../src/core/imageSizing";
import type { SceneDocument } from "../../src/core/documents";
import { pngHeaderForTest } from "../helpers/imageBytes";

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  writeAscii(bytes, 0, "GIF89a");
  bytes[6] = width & 0xff;
  bytes[7] = (width >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >>> 8) & 0xff;
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, "RIFF");
  writeU32be(bytes, 4, 22);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8X");
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >>> 8) & 0xff;
  bytes[26] = ((width - 1) >>> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >>> 8) & 0xff;
  bytes[29] = ((height - 1) >>> 16) & 0xff;
  return bytes;
}

function avifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  writeU32be(bytes, 0, 16);
  writeAscii(bytes, 4, "ftyp");
  writeAscii(bytes, 8, "avif");
  writeU32be(bytes, 20, 20);
  writeAscii(bytes, 24, "ispe");
  writeU32be(bytes, 32, width);
  writeU32be(bytes, 36, height);
  return bytes;
}

function emptyScene(): SceneDocument {
  return {
    _id: "scene-image-sizing",
    type: "scene",
    name: "Sizing",
    ownership: { default: 0 },
    flags: {},
    system: {},
    active: false,
    img: null,
    width: 1000,
    height: 500,
    darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [{ _id: "token", type: "token", name: "Token", ownership: { default: 0 }, flags: {}, system: {},
      x: 100, y: 50, rotation: 0, width: 50, height: 50, img: "", hidden: false, disposition: "neutral",
      vision: true, light: { radius: 0, color: "#fff", alpha: 0.5 } }],
    walls: [{ _id: "wall", type: "wall", name: "Wall", ownership: { default: 0 }, flags: {}, system: {},
      c: [0, 0, 100, 50], door: 0, oneWay: false, move: 1, sight: 1, light: 1, sound: 1 }],
    lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

describe("video background containers (Phase 4)", () => {
  test("recognises WebM and MP4 containers by magic bytes", () => {
    const webm = new Uint8Array(64);
    webm.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    expect(sniffVideo(webm)).toEqual({ kind: "video", mime: "video/webm" });
    const mp4 = new Uint8Array(64);
    writeAscii(mp4, 4, "ftypisom");
    expect(sniffVideo(mp4)).toEqual({ kind: "video", mime: "video/mp4" });
  });

  test("AVIF stays an image, and sniffMedia keeps images and rejects anything else", () => {
    expect(sniffVideo(avifHeader(120, 90))).toBeNull();
    expect(sniffMedia(avifHeader(120, 90))).toMatchObject({ kind: "image", format: "avif" });
    expect(sniffMedia(pngHeaderForTest(2, 3))).toMatchObject({ kind: "image", format: "png", width: 2, height: 3 });
    expect(sniffMedia(webm())).toMatchObject({ kind: "video", mime: "video/webm" });
    expect(() => sniffMedia(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });
});

function webm(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
}

describe("image validation, dimensions and geometry", () => {
  test("sniffs supported formats from bytes and rejects malformed/unsupported content", () => {
    expect(sniffImage(pngHeaderForTest(2, 3))).toMatchObject({ format: "png", mime: "image/png", width: 2, height: 3 });
    expect(sniffImage(jpegHeader(320, 240))).toMatchObject({ format: "jpeg", mime: "image/jpeg", width: 320, height: 240 });
    expect(sniffImage(webpHeader(640, 480))).toMatchObject({ format: "webp", mime: "image/webp", width: 640, height: 480 });
    expect(sniffImage(gifHeader(80, 60))).toMatchObject({ format: "gif", mime: "image/gif", width: 80, height: 60 });
    expect(sniffImage(avifHeader(120, 90))).toMatchObject({ format: "avif", mime: "image/avif", width: 120, height: 90 });
    const multiImageAvif = new Uint8Array(60);
    multiImageAvif.set(avifHeader(120, 90));
    writeU32be(multiImageAvif, 40, 20);
    writeAscii(multiImageAvif, 44, "ispe");
    writeU32be(multiImageAvif, 52, 10_001);
    writeU32be(multiImageAvif, 56, 10_000);
    expect(() => sniffImage(multiImageAvif)).toThrow(/100,000,000-pixel limit/i);
    expect(() => sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")))
      .toThrow(/SVG is not supported/i);
    expect(() => sniffImage(new Uint8Array([1, 2, 3, 4]))).toThrow(/unsupported or malformed/i);
  });

  test("enforces the byte and 100 MP limits before decoding", () => {
    expect(MAX_IMAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_IMAGE_PIXELS).toBe(100_000_000);
    expect(() => assertImageByteLength(MAX_IMAGE_BYTES + 1)).toThrow(/64 MB/i);
    expect(() => assertImageByteLength(0)).toThrow(/empty/i);
    expect(sniffImage(pngHeaderForTest(10_000, 10_000))).toMatchObject({ width: 10_000, height: 10_000 });
    expect(() => sniffImage(pngHeaderForTest(10_001, 10_000))).toThrow(/100,000,000-pixel limit/i);
    expect(() => validateDecodedDimensions(10_001, 10_000)).toThrow(/100,000,000-pixel limit/i);
    expect(() => validateDecodedDimensions(0, 100)).toThrow(/invalid image dimensions/i);
  });

  test("normalizes names and derives image-sized/aspect-locked scenes", () => {
    expect(normalizeImageName("/tmp/my_map+v2.png")).toBe("my map v2");
    expect(normalizeImageName("my.map+v2.png")).toBe("my.map v2");
    expect(sceneSizeFromImage({ width: 3080, height: 2520 })).toEqual({ width: 3080, height: 2520 });
    expect(aspectLockedSize({ width: 3080, height: 2520 }, "width", 1540)).toEqual({ width: 1540, height: 1260 });
    expect(aspectLockedSize({ width: 3080, height: 2520 }, "height", 1260)).toEqual({ width: 1540, height: 1260 });
    expect(() => aspectLockedSize({ width: 100, height: 50 }, "width", 0)).toThrow(/positive/i);
  });

  test("calculates grid, background padding and tile sizing from the design rules", () => {
    expect(gridFromImage(3080, 2520, 22)).toEqual({ size: 140, heightAlignmentWarning: false });
    expect(gridFromImage(3010, 2500, 22)).toMatchObject({ size: 137, heightAlignmentWarning: true });
    expect(() => gridFromImage(1000, 1000, 21)).toThrow(/50px minimum/i);
    expect(backgroundBounds(1000, 500, 0.1)).toEqual({ x: -100, y: -100, width: 1200, height: 700, paddingPx: 100 });
    expect(tileAtNaturalSize({ width: 256, height: 128 }, { width: 1000, height: 800 }))
      .toEqual({ x: 372, y: 336, width: 256, height: 128 });
    expect(tileAtAssetGridSize({ width: 256, height: 128 }, 128, 100, { width: 1000, height: 800 }))
      .toEqual({ x: 400, y: 350, width: 200, height: 100 });
    expect(fitTileToScene({ width: 1600, height: 900 }, { width: 1000, height: 1000 }))
      .toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 });
  });

  test("placeable rescaling changes pixel geometry only when explicitly requested", () => {
    const resized = rescaleScenePlaceables(emptyScene(), 2000, 1000);
    expect(resized.width).toBe(2000);
    expect(resized.height).toBe(1000);
    expect(resized.tokens[0]).toMatchObject({ x: 200, y: 100, width: 100, height: 100 });
    expect(resized.walls[0]?.c).toEqual([0, 0, 200, 100]);
    expect(emptyScene().tokens[0]).toMatchObject({ x: 100, y: 50, width: 50, height: 50 });
  });

  test("uses safe logical folders and accepts only HTTPS URL sources", () => {
    expect(normalizeLogicalFolder(" /Maps/../ Campaign /Dungeon// ")).toBe("Maps/Campaign/Dungeon");
    expect(normalizeLogicalFolder("Maps/Bad\u0001Name/Control\u007fChar")).toBe("Maps/BadName/ControlChar");
    expect(validateHttpsImageUrl("https://example.com/maps/a.png?token=abc").protocol).toBe("https:");
    expect(() => validateHttpsImageUrl("http://example.com/a.png")).toThrow(/HTTPS/i);
    expect(() => validateHttpsImageUrl("not a URL")).toThrow(/complete image URL/i);
    expect(isPinterestPinPage("https://www.pinterest.com/pin/12345/" )).toBe(true);
    expect(isPinterestPinPage("https://i.pinimg.com/originals/a.png")).toBe(false);
  });
});
