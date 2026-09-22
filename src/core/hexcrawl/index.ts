/**
 * **Hexcrawl core (D-269).** Pure model first (plan §8, Phase 0b): the scene profile, the cell
 * vocabulary, terrain pricing, the encounter engine and the travel engine. The UI, the canvas
 * overlay and the GM panel build on these, and nothing in here imports from `src/ui` or
 * `src/canvas/layers` — that is the seam the unit tests hold open.
 *
 * Reading order for a newcomer: `types.ts` (what a hexcrawl scene *is*) → `cells.ts` (what a
 * cell is, on all three grid kinds) → `terrain.ts` (what crossing one costs) → `encounter.ts`
 * (what happens when the party arrives) → `travel.ts` (how the party gets there, on the world
 * clock) → `placement.ts` (where the rolled creatures stand — plan §5.5) → `scene.ts` (how any of
 * it is written).
 */
export * from "./types";
export * from "./cells";
export * from "./terrain";
export * from "./tables";
export * from "./tableOps";
export * from "./encounter";
export * from "./encounterFlow";
export * from "./placement";
export * from "./visibility";
export * from "./overlay";
export {
  MAX_TRAVEL_DAYS_PER_ADVANCE,
  MAX_TRAVEL_EVENTS,
  isCellKey,
  partyCellOf,
  partyCentreOf,
  partyPositionOps,
  partyTokenOf,
  routePointsOf,
  routeSeconds,
  stepCostOf,
  stepSecondsOf,
  travelAdvance,
  travelProgressOps,
  travelTerrainCatalog,
  type TravelAdvance,
  type TravelStep,
} from "./travel";
export * from "./features";
export * from "./scene";
