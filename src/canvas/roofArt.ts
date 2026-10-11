/**
 * G-26a (D-438): a roof's art alpha, read once per loaded texture.
 *
 * The image is drawn into a canvas of at most ROOF_ART_MAX_SIDE px per side, then its alpha is
 * thresholded. Any failure returns null, and the roof falls back to its trigger zone or rotated
 * rectangle. Failures include no DOM (tests, workers), a cross-origin canvas, a video source or
 * a lost context.
 */
import type { Texture } from "pixi.js";
import { ROOF_ART_MAX_SIDE, roofArtMaskFromRgba, type RoofArtMask } from "../core/roofs";

type DrawableCanvas = { getContext(kind: "2d", options?: { willReadFrequently?: boolean }): unknown };

function scratchCanvas(width: number, height: number): DrawableCanvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function roofArtMaskFromTexture(texture: Texture): RoofArtMask | null {
  try {
    const resource = (texture.source as { resource?: unknown } | undefined)?.resource;
    if (!resource || typeof resource !== "object") return null;
    const isImage = (typeof HTMLImageElement !== "undefined" && resource instanceof HTMLImageElement) ||
      (typeof ImageBitmap !== "undefined" && resource instanceof ImageBitmap) ||
      (typeof HTMLCanvasElement !== "undefined" && resource instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== "undefined" && resource instanceof OffscreenCanvas);
    if (!isImage) return null;
    const frame = texture.frame;
    if (!(frame.width > 0 && frame.height > 0)) return null;
    const scale = Math.min(1, ROOF_ART_MAX_SIDE / Math.max(frame.width, frame.height));
    const width = Math.max(1, Math.round(frame.width * scale));
    const height = Math.max(1, Math.round(frame.height * scale));
    const canvas = scratchCanvas(width, height);
    const context = canvas?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null | undefined;
    if (!context) return null;
    context.clearRect(0, 0, width, height);
    context.drawImage(resource as CanvasImageSource, frame.x, frame.y, frame.width, frame.height, 0, 0, width, height);
    return roofArtMaskFromRgba(context.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return null;
  }
}
