/**
 * Browser adapter for grid detection: decodes the background at native resolution and streams it
 * through the pure accumulator in row strips, so only a few rows of pixels are resident at a time.
 */
import { MAX_IMAGE_PIXELS } from "../core/imageSizing";
import { EdgeProfileAccumulator, detectMapGrid, type GridDetection } from "../core/gridDetection";

/** Pixels per strip (about 16 MB of RGBA). Strips never change the result, only the memory use. */
const STRIP_PIXELS = 4_000_000;

export class GridDetectionError extends Error {}

export async function detectMapGridFromBytes(bytes: Uint8Array, mime: string): Promise<GridDetection> {
  if (!mime.startsWith("image/")) throw new GridDetectionError("Grid detection reads still images only.");
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new GridDetectionError("This image could not be decoded for grid detection.");
  });
  try {
    const { width, height } = bitmap;
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new GridDetectionError("This image is too large to analyse in the browser.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    const stripRows = Math.max(1, Math.min(height, Math.floor(STRIP_PIXELS / width)));
    canvas.height = stripRows;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new GridDetectionError("The browser refused a canvas for grid detection.");
    const acc = new EdgeProfileAccumulator(width, height);
    for (let y = 0; y < height; y += stripRows) {
      const rows = Math.min(stripRows, height - y);
      ctx.clearRect(0, 0, width, stripRows);
      // Draw the whole bitmap shifted up so the wanted rows land in the strip canvas.
      ctx.drawImage(bitmap, 0, -y);
      const pixels = ctx.getImageData(0, 0, width, rows);
      acc.addRows(pixels.data, rows);
    }
    return detectMapGrid(acc);
  } finally {
    bitmap.close();
  }
}
