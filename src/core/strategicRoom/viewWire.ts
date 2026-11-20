import {
  integer,
  MARKER_COUNT_BYTES,
  MARKER_X_BIT,
  MARKER_Y_BIT,
  STRATEGIC_PATCH_TYPE,
  MARKER_POINT_BYTES,
  MAX_VIEW_BYTES,
  MAX_VIEW_META_BYTES,
  STRATEGIC_VIEW_TYPE,
  VIEW_PREFIX_BYTES,
  type Baseline,
  type BaselineMeta,
  type MarkerLabels,
  type UnitMarker,
} from "./protocol";

// Both integral deployment coordinates and fractional projected centroids live in the same
// table. Give points double fields from the first snapshot so V8 needn't migrate every old
// integer-shaped point on first contact. Keep plain objects for map/JSON compatibility.
function markerPoint(x: number, y: number) {
  const point = { x: NaN, y: NaN };
  point.x = x;
  point.y = y;
  return point;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A marker reference without its exact in-memory baseline is not a new view. */
export class MissingViewMarkers extends Error {}

export const VIEW_ATTEMPTS = 6;
/** Smooth a publication's HTTP burst without delaying admission or order receipts. */
export const viewPublicationDelay = () => Math.random() * 240;
/** Spread retries so a whole cohort doesn't hit the fixed HTTP cap again together. */
export const viewRetryDelay = (attempt: number) =>
  110 * (attempt + 1) + Math.random() * 180;

async function readBounded(
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
) {
  if (!body) throw new Error("Missing view body.");
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      length += value.byteLength;
      if (length > MAX_VIEW_BYTES) throw new Error("View exceeds byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const first = chunks[0];
  if (chunks.length === 1 && first) return first;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readView(response: Response, base?: Baseline) {
  return decodeView(
    await readBounded(response.body),
    response.headers.get("content-type"),
    base,
  );
}

/** The current result is assembled privately; never mutate a displayed baseline on a partial frame. */
function applyMarkerChanges(
  patch: DataView,
  meta: BaselineMeta,
  base?: Baseline,
): Baseline {
  if (
    !base ||
    base.epoch !== meta.epoch ||
    base.role !== meta.role ||
    base.factionId !== meta.factionId ||
    base.head.version + 1 !== meta.head.version
  )
    throw new MissingViewMarkers("No matching previous marker baseline.");
  const markerBytes = patch.byteLength;
  if (markerBytes < 4 || patch.getUint16(0) !== base.markers.length)
    throw new MissingViewMarkers("Previous marker count differs.");
  const count = patch.getUint16(2);
  if (count > base.markers.length) throw new Error("Invalid change count.");
  const markers = new Array<UnitMarker>(count);
  let next = 0,
    written = 0;
  for (let p = 4; p < markerBytes;) {
    const tag = patch.getUint16(p);
    const i = tag & (MARKER_X_BIT - 1);
    if (i < next || i >= base.markers.length)
      throw new Error("Invalid marker index.");
    const old = base.markers[i];
    if (!old) throw new Error("Missing marker row.");
    if (tag & (MARKER_X_BIT | MARKER_Y_BIT)) {
      p += 2;
      const x = tag & MARKER_X_BIT ? patch.getFloat64(p) : old.at.x;
      if (tag & MARKER_X_BIT) p += 8;
      const y = tag & MARKER_Y_BIT ? patch.getFloat64(p) : old.at.y;
      if (tag & MARKER_Y_BIT) p += 8;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new Error("Invalid changed position.");
      if (written >= count) throw new Error("Too many marker rows.");
      markers[written++] = {
        id: old.id,
        name: old.name,
        factionId: old.factionId,
        at: markerPoint(x, y),
      };
      next = i + 1;
    } else {
      const length = patch.getUint16(p + 2);
      next = i + length;
      if (!length || next > base.markers.length || written + length > count)
        throw new Error("Invalid marker run.");
      for (let idx = i; idx < next; idx++) {
        const row = base.markers[idx];
        if (!row) throw new MissingViewMarkers("Missing marker run.");
        markers[written++] = row;
      }
      p += 4;
    }
  }
  if (written !== count) throw new Error("Incomplete marker changes.");
  return { ...meta, markers };
}

/** u32be metadata length, u32be marker length, private JSON, then the negotiated marker table. */
export async function decodeView(
  body: Uint8Array<ArrayBuffer>,
  contentType: string | null | undefined,
  base?: Baseline,
): Promise<Baseline> {
  if (body.byteLength > MAX_VIEW_BYTES)
    throw new Error("View exceeds byte limit.");
  const type = contentType?.split(";", 1)[0];
  if (type === "application/json")
    return JSON.parse(utf8.decode(body)) as Baseline;
  if (
    (type !== STRATEGIC_VIEW_TYPE && type !== STRATEGIC_PATCH_TYPE) ||
    body.byteLength <= VIEW_PREFIX_BYTES
  )
    throw new Error("Invalid strategic view format.");
  const sizes = new DataView(body.buffer, body.byteOffset, VIEW_PREFIX_BYTES);
  const metaBytes = sizes.getUint32(0);
  const markerBytes = sizes.getUint32(4);
  const offset = VIEW_PREFIX_BYTES + metaBytes;
  if (
    metaBytes === 0 ||
    metaBytes > MAX_VIEW_META_BYTES ||
    offset + markerBytes !== body.byteLength
  )
    throw new Error("Invalid strategic view lengths.");
  const meta = JSON.parse(
    utf8.decode(body.subarray(VIEW_PREFIX_BYTES, offset)),
  ) as BaselineMeta;
  if (type === STRATEGIC_PATCH_TYPE)
    return applyMarkerChanges(
      new DataView(body.buffer, body.byteOffset + offset, markerBytes),
      meta,
      base,
    );
  if (markerBytes === 0) {
    if (
      !base ||
      base.epoch !== meta.epoch ||
      base.head.version !== meta.head.version ||
      base.role !== meta.role ||
      base.factionId !== meta.factionId
    )
      throw new MissingViewMarkers("No matching marker baseline.");
    return { ...meta, markers: base.markers };
  }
  let input = offset;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      // Keep the data presented to the inflater per chunk bounded too.
      const end = Math.min(input + 32 * 1024, body.byteLength);
      controller.enqueue(body.subarray(input, end));
      input = end;
      if (input === body.byteLength) controller.close();
    },
  });
  const plain = await readBounded(
    source.pipeThrough(new DecompressionStream("gzip")),
  );
  if (plain.byteLength <= MARKER_COUNT_BYTES)
    throw new Error("Missing strategic marker table.");
  const points = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const count = points.getUint32(0);
  const labelsOffset = MARKER_COUNT_BYTES + count * MARKER_POINT_BYTES;
  if (labelsOffset >= plain.byteLength)
    throw new Error("Invalid strategic marker count.");
  const labels = JSON.parse(
    utf8.decode(plain.subarray(labelsOffset)),
  ) as MarkerLabels;
  if (
    !Array.isArray(labels) ||
    labels.length !== 3 ||
    labels.some((c) => !Array.isArray(c) || c.length !== count)
  )
    throw new Error("Invalid strategic marker columns.");
  const [ids, names, sides] = labels;
  const markers = new Array<UnitMarker>(count);
  for (
    let i = 0, pos = MARKER_COUNT_BYTES;
    i < count;
    i++, pos += MARKER_POINT_BYTES
  ) {
    const side = sides[i];
    const factionId = integer(side, 0, meta.factions.length - 1)
      ? meta.factions[side]?.id
      : undefined;
    const id = ids[i],
      name = names[i];
    const x = points.getFloat64(pos),
      y = points.getFloat64(pos + 8);
    if (
      factionId === undefined ||
      typeof id !== "string" ||
      typeof name !== "string" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      throw new Error("Invalid strategic marker row.");
    markers[i] = { id, name, factionId, at: markerPoint(x, y) };
  }
  return { ...meta, markers };
}
