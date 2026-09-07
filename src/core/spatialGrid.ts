/**
 * Pure environment-agnostic SpatialGrid for O(1) cell hashing.
 * Re-exports ModelSpatialHash for both worker simulation and canvas rendering.
 */
import { ModelSpatialHash, type CellEntry, type UnitRange, type WorldRect } from "../canvas/spatial";

export { ModelSpatialHash as SpatialGrid };
export type { CellEntry, UnitRange, WorldRect };
