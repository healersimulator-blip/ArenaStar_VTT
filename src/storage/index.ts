/**
 * src/storage barrel (§18, §8): IndexedDB "vtt", OPFS asset blobs, host
 * write-behind persistence, quota/persistence health.
 */
export * from "./idb";
export * from "./persistence";
export * from "./opfs";
export * from "./quota";
export {
  CHECKPOINT_RECENT_TURNS,
  CHECKPOINT_STRIDE,
  SIMDELTA_RING,
  applyCheckpointRetention,
  decodeReport,
  encodeReport,
  getReport,
  latestCheckpoint,
  listCheckpoints,
  listDeltas,
  listReports,
  putCheckpoint,
  putDelta,
  putReport,
  type CheckpointRecord,
  type SimDeltaRecord,
  type TurnReportRecord,
} from "./strategicStore";
