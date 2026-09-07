/** src/host barrel (§18): Host Core — HostSync (§5) and later AssetServer. */
export {
  HostSync,
  gmSessionUser,
  type HostEvents,
  type HostSyncOptions,
  type SessionUser,
} from "./sync";
export * from "./assets";
export {
  DetectionGrid,
  WALL_SIGHT_BIT,
  poolBounds,
  type DetectionBounds,
  type DetectionSource,
} from "../core/detection";
export {
  alliesOf,
  factionVisibility,
  makeUnitVisibility,
  projectDeltaForFaction,
  projectReportForFaction,
  unitFactions,
} from "./simProjection";
