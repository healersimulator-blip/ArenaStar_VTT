/** Document-only transport envelopes. Ordinary RPCs retain the 64 KiB frame limit. */
export const AIS_RPC_FRAME_BYTES = 64 * 1024;
export const AIS_DOCUMENT_REQUEST_BYTES = 512 * 1024 + 1024;
export const AIS_DOCUMENT_RESPONSE_BYTES = 1024 * 1024 + 1024;
export const AIS_RPC_CHUNK_CHARS = 8192; // Worst-case JSON escaping: six bytes per code unit.
export const AIS_RPC_TRANSFER_MS = 30_000;

export interface AisRpcChunk {
  vttAisRpc: 1;
  kind: "request-chunk";
  id: number;
  index: number;
  total: number;
  text: string;
}

export function aisRequestChunks(frame: unknown, id: number): AisRpcChunk[] {
  const text = JSON.stringify(frame);
  const total = Math.ceil(text.length / AIS_RPC_CHUNK_CHARS);
  return Array.from({ length: total }, (_, index) => ({
    vttAisRpc: 1,
    kind: "request-chunk",
    id,
    index,
    total,
    text: text.slice(
      index * AIS_RPC_CHUNK_CHARS,
      (index + 1) * AIS_RPC_CHUNK_CHARS,
    ),
  }));
}

/** One ordered partial request per authenticated port; no transfer IDs or unbounded maps. */
export class AisRequestAssembler {
  private partial: {
    id: number;
    total: number;
    next: number;
    text: string;
    bytes: number;
    expires: number;
  } | null = null;

  clear(): void {
    this.partial = null;
  }

  accept(
    value: Record<string, unknown>,
    now: number,
  ): { id: number; value: unknown } | null {
    const { id, index, total, text } = value;
    if (
      Object.keys(value).some(
        (key) =>
          !["vttAisRpc", "kind", "id", "index", "total", "text"].includes(key),
      ) ||
      !Number.isSafeInteger(id) ||
      Number(id) < 0 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      Number(total) < 1 ||
      Number(total) > 129 ||
      Number(index) < 0 ||
      Number(index) >= Number(total) ||
      typeof text !== "string" ||
      text.length < 1 ||
      text.length > AIS_RPC_CHUNK_CHARS
    ) {
      this.clear();
      return null;
    }
    if (index === 0) {
      this.partial = {
        id: Number(id),
        total: Number(total),
        next: 0,
        text: "",
        bytes: 0,
        expires: now + AIS_RPC_TRANSFER_MS,
      };
    }
    const partial = this.partial;
    if (
      !partial ||
      partial.expires <= now ||
      partial.id !== id ||
      partial.total !== total ||
      partial.next !== index
    ) {
      this.clear();
      return null;
    }
    // Count bytes incrementally, before retaining the chunk. Split surrogate pairs are
    // conservatively counted as replacement characters (never undercount the budget).
    partial.bytes += new TextEncoder().encode(text).length;
    if (partial.bytes > AIS_DOCUMENT_REQUEST_BYTES) {
      this.clear();
      return null;
    }
    partial.text += text;
    partial.next++;
    if (partial.next !== partial.total) return null;
    this.clear();
    try {
      return { id: partial.id, value: JSON.parse(partial.text) as unknown };
    } catch {
      return null;
    }
  }
}
