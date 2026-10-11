import type {
  FauxOverheadBehavior,
  RegionDocument,
  TokenDocument,
} from "./documents";
import {
  elevationBandError,
  inElevationBand,
  regionShapeV2Error,
  shapeContains,
  transformShape,
  type RegionShapeV2,
  type SpatialPoint,
} from "./multilevelGeometry";

export function fauxOverheadError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Faux Overhead must be an object";
  const cover = value as FauxOverheadBehavior;
  if (
    cover.kind !== "fauxOverhead" ||
    !Number.isFinite(cover.coverZ) ||
    Math.abs(cover.coverZ) > 1_000_000
  )
    return "Faux Overhead needs a finite cover height within ±1,000,000 scene units";
  const bandError = elevationBandError(cover.affectedElevation);
  if (bandError) return bandError;
  if (cover.footprint !== undefined) return regionShapeV2Error(cover.footprint);
  return null;
}
export interface CompiledOverhead {
  id: string;
  behavior: FauxOverheadBehavior;
  shape: RegionShapeV2;
}
/** One compilation per document revision, never per render pixel or token frame. */
export function compileOverhead(
  regions: readonly RegionDocument[],
): CompiledOverhead[] {
  const result: CompiledOverhead[] = [];
  for (const region of regions) {
    const behavior = region.fauxOverhead;
    if (
      !behavior ||
      fauxOverheadError(behavior) ||
      ![
        region.x,
        region.y,
        region.width,
        region.height,
        region.rotation ?? 0,
      ].every(Number.isFinite)
    )
      continue;
    const footprint: RegionShapeV2 = behavior.footprint ?? {
      version: 2,
      components: [
        {
          outer: region.shape.points.map(([x, y]) => ({ x, y })),
          holes: [],
        },
      ],
    };
    if (regionShapeV2Error(footprint)) continue;
    const angle = ((region.rotation ?? 0) * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle);
    const shape = transformShape(footprint, ({ x, y }) => {
      const dx = (x - 0.5) * region.width,
        dy = (y - 0.5) * region.height;
      return {
        x: region.x + region.width / 2 + dx * cos - dy * sin,
        y: region.y + region.height / 2 + dx * sin + dy * cos,
      };
    });
    result.push({ id: region._id, behavior, shape });
  }
  return result;
}
export function overheadAffects(
  cover: CompiledOverhead,
  token: Pick<TokenDocument, "elevation">,
): boolean {
  const feet = token.elevation ?? 0;
  return (
    feet < cover.behavior.coverZ &&
    inElevationBand(cover.behavior.affectedElevation, feet)
  );
}
/** Same predicate used by picking and drawing; it never overrides an upstream visibility deny. */
export function overheadCoversPoint(
  covers: readonly CompiledOverhead[],
  token: Pick<TokenDocument, "elevation">,
  point: SpatialPoint,
): boolean {
  return covers.some(
    (cover) =>
      overheadAffects(cover, token) && shapeContains(cover.shape, point),
  );
}
