import { gzipSync } from "node:zlib";
import {
  MARKER_COUNT_BYTES,
  MARKER_X_BIT,
  MARKER_Y_BIT,
  MARKER_POINT_BYTES,
  MAX_VIEW_BYTES,
  MAX_VIEW_META_BYTES,
  VIEW_PREFIX_BYTES,
  type BaselineMeta,
  type MarkerLabels,
  type UnitMarker,
} from "../../../src/core/strategicRoom/protocol";

/** Compress only already-projected cohort data. Don't mix orders or tokens into it. */
export function packMarkers(
  markers: readonly UnitMarker[],
  factions: BaselineMeta["factions"],
): Buffer {
  const indexes = new Map(factions.map((f, i) => [f.id, i]));
  const labels: MarkerLabels = [[], [], []];
  const [ids, names, sides] = labels;
  const pointBytes = MARKER_COUNT_BYTES + markers.length * MARKER_POINT_BYTES;
  if (pointBytes > MAX_VIEW_BYTES)
    throw new Error("Strategic marker cohort exceeds byte limit.");
  const points = Buffer.allocUnsafe(pointBytes);
  points.writeUInt32BE(markers.length);
  let offset = MARKER_COUNT_BYTES;
  for (const marker of markers) {
    const index = indexes.get(marker.factionId);
    if (index === undefined) throw new Error("Invalid marker faction.");
    ids.push(marker.id);
    names.push(marker.name);
    sides.push(index);
    // Keep the projected centroids exact without paying to format/parse decimal numbers.
    points.writeDoubleBE(marker.at.x, offset);
    points.writeDoubleBE(marker.at.y, offset + 8);
    offset += MARKER_POINT_BYTES;
  }
  const text = Buffer.from(JSON.stringify(labels));
  if (pointBytes + text.byteLength > MAX_VIEW_BYTES)
    throw new Error("Strategic marker cohort exceeds byte limit.");
  return gzipSync(Buffer.concat([points, text]), { level: 3 });
}

export function viewPrefix(
  meta: BaselineMeta,
  markerBytes: number,
): Buffer | null {
  const json = JSON.stringify(meta);
  const metaBytes = Buffer.byteLength(json);
  if (
    metaBytes > MAX_VIEW_META_BYTES ||
    VIEW_PREFIX_BYTES + metaBytes + markerBytes > MAX_VIEW_BYTES
  )
    return null;
  const prefix = Buffer.allocUnsafe(VIEW_PREFIX_BYTES + metaBytes);
  prefix.writeUInt32BE(metaBytes, 0);
  prefix.writeUInt32BE(markerBytes, 4);
  prefix.write(json, VIEW_PREFIX_BYTES, metaBytes, "utf8");
  return prefix;
}

/** Rebuild the visible list in current roster order. Omitted old indices disappear. A run
 * references unchanged rows; a move carries exact projected doubles, never model positions.
 * A newly visible or relabelled row needs a full baseline, not an out-of-cohort lookup. */
export function packMarkerChanges(
  before: readonly UnitMarker[],
  after: readonly UnitMarker[],
  budget: number,
): Buffer | undefined {
  if (before.length >= MARKER_X_BIT || after.length > before.length)
    return undefined;
  const data = Buffer.allocUnsafe(Math.min(budget, 4 + 18 * after.length));
  if (data.length < 4) return undefined;
  data.writeUInt16BE(before.length);
  data.writeUInt16BE(after.length, 2);
  let cursor = 0,
    offset = 4,
    run = -1;
  for (const marker of after) {
    while (cursor < before.length && before[cursor]?.id !== marker.id) {
      cursor++;
      run = -1;
    }
    const old = before[cursor];
    if (!old || old.name !== marker.name || old.factionId !== marker.factionId)
      return undefined;
    const move =
      (old.at.x !== marker.at.x ? MARKER_X_BIT : 0) |
      (old.at.y !== marker.at.y ? MARKER_Y_BIT : 0);
    if (!move) {
      if (run === -1) {
        if (offset + 4 > data.length) return undefined;
        data.writeUInt16BE(cursor, offset);
        run = offset + 2;
        offset += 4;
        data.writeUInt16BE(1, run);
      } else data.writeUInt16BE(data.readUInt16BE(run) + 1, run);
    } else {
      const end =
        offset +
        2 +
        (move & MARKER_X_BIT ? 8 : 0) +
        (move & MARKER_Y_BIT ? 8 : 0);
      if (end > data.length) return undefined;
      offset = data.writeUInt16BE(move | cursor, offset);
      if (move & MARKER_X_BIT) offset = data.writeDoubleBE(marker.at.x, offset);
      if (move & MARKER_Y_BIT) offset = data.writeDoubleBE(marker.at.y, offset);
      run = -1;
    }
    cursor++;
  }
  return data.subarray(0, offset);
}
