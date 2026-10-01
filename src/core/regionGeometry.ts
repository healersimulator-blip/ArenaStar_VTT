import type { RegionDocument, SceneDocument, TileDocument } from "./documents";
import { tileTriggerElevationError, tileTriggerZoneError } from "./tileTriggerZone";

/** Validate the persisted, deliberately bounded first-class scene-region shape. */
export function regionGeometryError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "region must be an object";
  const region = value as Record<string, unknown>;
  if (region.type !== "region" ||
      ![region.x, region.y, region.width, region.height, region.rotation ?? 0].every(Number.isFinite) ||
      (region.width as number) <= 0 || (region.height as number) <= 0 ||
      Math.abs(region.x as number) > 1_000_000 || Math.abs(region.y as number) > 1_000_000 ||
      (region.width as number) > 1_000_000 || (region.height as number) > 1_000_000 ||
      Math.abs((region.rotation ?? 0) as number) > 1_000_000)
    return "region bounds and rotation must be finite and bounded";
  if (!region.shape || typeof region.shape !== "object" || Array.isArray(region.shape) ||
      (region.shape as Record<string, unknown>).kind !== "polygon")
    return "region shape must be a convex polygon";
  const shape = region.shape as Record<string, unknown>;
  const error = tileTriggerZoneError(shape);
  if (error) return error;
  if (tileTriggerElevationError(region.triggerElevation)) return tileTriggerElevationError(region.triggerElevation);
  if (region.hidden !== undefined && typeof region.hidden !== "boolean") return "region hidden must be boolean";
  if (region.sort !== undefined && (!Number.isSafeInteger(region.sort) || Math.abs(region.sort as number) > 1_000_000))
    return "region sort must be a bounded integer";
  return null;
}

/** Adapt a validated region to the shared bounded polygon/sweep geometry kernel. */
export function regionTriggerTile(region: RegionDocument): TileDocument {
  return {
    _id: region._id,
    type: "tile",
    name: region.name,
    ownership: region.ownership,
    flags: region.flags,
    system: region.system,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    rotation: region.rotation ?? 0,
    img: "",
    triggerZone: region.shape,
    ...(region.triggerElevation ? { triggerElevation: region.triggerElevation } : {}),
    ...(region.sort !== undefined ? { sort: region.sort } : {}),
    above: false,
    occlusion: { mode: "fade", alpha: 1 },
  };
}

/** Resolve a graph anchor without granting regions tile click/target semantics. */
export function automationSourceTile(
  scene: SceneDocument, id: string, sourceKind: "tile" | "region" | undefined,
): TileDocument | undefined {
  if (sourceKind === "region") {
    const region = scene.regions?.find((candidate) => candidate._id === id);
    return region ? regionTriggerTile(region) : undefined;
  }
  return scene.tiles.find((candidate) => candidate._id === id);
}
