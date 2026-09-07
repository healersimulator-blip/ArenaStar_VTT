/** §5A strategic simulation core: PRNG, ModelPool, Sim codecs (see PLAN M2). */
export { XoshiroPRNG, seedFrom, stepU32, type XoshiroState } from "./prng";
export {
  REMOVED_INDEX,
  allocModel,
  bytesPerModel,
  clonePool,
  columnNames,
  compactPool,
  createModelPool,
  freeModel,
  hashPool,
  type AllocModelInit,
  type SysSchema,
} from "./pool";
export {
  applySimDelta,
  decodeSimDelta,
  decodeSimSnapshot,
  diffPools,
  encodeSimDelta,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "./codec";
export {
  SimRunnerCore,
  type SimLoadRequest,
  type SimResolveRequest,
  type SimResolveResult,
  type SimTickRequest,
  type SimTickResult,
} from "./runner";
