import { gzipSync } from "node:zlib";
import {
  MARKER_COUNT_BYTES,
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
