import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Stable content identity for a validated package. Length-prefixing the UTF-8 file names and
 * contents avoids delimiter ambiguity; sorting makes the hash independent of ZIP entry order.
 */
export function packageContentHash(files: Readonly<Record<string, string>>): string {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, entries.length, false);
  chunks.push(header);
  for (const [path, text] of entries) {
    const pathBytes = encoder.encode(path);
    const textBytes = encoder.encode(text);
    const sizes = new Uint8Array(8);
    const view = new DataView(sizes.buffer);
    view.setUint32(0, pathBytes.byteLength, false);
    view.setUint32(4, textBytes.byteLength, false);
    chunks.push(sizes, pathBytes, textBytes);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytesToHex(sha256(bytes));
}
