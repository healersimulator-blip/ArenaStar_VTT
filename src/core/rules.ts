/**
 * §12 RulesModule contract — the pure rules entry points executed inside the
 * SimWorker (and `forecast` in a client-side sandbox). The RulesModule is
 * pure: no I/O, no DOM, no Documents other than the read-only RulesContext;
 * all randomness comes from the injected seeded PRNG.
 */
import type {
  FactionDocument,
  ModelColumnType,
  ModelPool,
  Order,
  OrderQueue,
  UnitProfile,
} from "./strategic";
import type { Json } from "./documents";
import type { ArmyId, DocId, UnitId } from "./ids";
import type { PRNG, SimEvent } from "./sim";

/** §12 manifest `rules` block. */
export interface RulesSchema {
  version: string;
  /** Extra ModelPool.sys columns, name → element type (§4A). */
  modelColumns: Record<string, ModelColumnType>;
  unitTypes: Record<string, Json>;
  /** Order kinds the module validates (beyond the base §4A union). */
  orderTypes: string[];
  /** Execution order, e.g. ["move","shoot","melee","morale","supply"]. */
  subPhases: string[];
  /** Logistics document types + JSON Schemas (§4A depots/routes/…). */
  logistics?: { documentTypes: Record<string, Json> };
}

export type { Ok, Err, OkOrErr } from "./result";
import type { OkOrErr } from "./result";

export interface RulesGridContext {
  type: "square" | "hex" | "gridless";
  size: number;
  distance: number;
  units: string;
  diagonals: string;
}

/** The standard square, used when a scene's grid distance is missing or unusable. */
const DEFAULT_CELL_FEET = 5;

/**
 * The feet-per-square scale of a scene grid (P01). The scene's authored `distance` when
 * it is a usable positive number, else the standard 5-ft square.
 *
 * This lives next to `RulesGridContext` because it is the derivation both sides of the
 * sim boundary need: the host deploys formations at this spacing and writes it into
 * `ctx.grid.distance`, and a system package derives its own cell conversions from the
 * same number, so the deployer, the spatial hash and the rules cannot disagree about
 * what a square is (Gap List §2.15's "define one canonical scale"). A `gridless` scene
 * still interacts with square-based rules, so it gets the standard square rather than a
 * second convention.
 */
export function sceneCellFeet(distance: unknown): number {
  return typeof distance === "number" &&
    Number.isFinite(distance) &&
    distance > 0
    ? distance
    : DEFAULT_CELL_FEET;
}

/** Walls as typed arrays: bit i of restriction = 1<<i for (move|sight|sound|light). */
export interface RulesWallsContext {
  x1: Float32Array;
  y1: Float32Array;
  x2: Float32Array;
  y2: Float32Array;
  restriction: Uint8Array;
}

/**
 * Read-only, structured-cloned snapshot of the world the rules may see (§12):
 * scene grid/walls, factions, armies/units, leader Actor data, world settings.
 * No Hooks, no Documents API, no async.
 */
export interface RulesContext {
  sceneId: DocId | null;
  grid: RulesGridContext;
  walls: RulesWallsContext;
  factions: readonly FactionDocument[];
  armies: ReadonlyArray<import("./strategic").ArmyDocument>;
  /**
   * Actor documents (full doc JSON) for leaders attached to units; **key = unit id**, so a
   * RulesModule looks up `ctx.leaderActors[unit.id]` (M07). Built by
   * `collectLeaderActors`; empty when no unit has a leader token bound to an actor.
   */
  leaderActors: Record<DocId, Json>;
  worldSettings: Record<string, Json>;
}

/**
 * Collect leader actor documents for hero-led units (M07): unit → its leader token → the
 * token's actor → the actor document, keyed by unit id. Units without a token, tokens
 * without an actor and actor ids that resolve to nothing are skipped silently — the
 * consuming module keeps its unit-stats fallback for them.
 */
export function collectLeaderActors(input: {
  units: ReadonlyArray<{ id: string; leaderTokenId: DocId | null }>;
  tokens: ReadonlyArray<{ _id: DocId; actorId?: DocId }> | null | undefined;
  getActor: (actorId: DocId) => Json | null | undefined;
}): Record<DocId, Json> {
  const out: Record<DocId, Json> = {};
  if (!input.tokens) return out;
  for (const unit of input.units) {
    if (!unit.leaderTokenId) continue;
    const token = input.tokens.find((t) => t._id === unit.leaderTokenId);
    if (!token || !token.actorId) continue;
    const actor = input.getActor(token.actorId);
    if (actor !== null && actor !== undefined) out[unit.id] = actor;
  }
  return out;
}

/** Structured-clone view of a Unit handed to the RulesModule. */
export interface UnitView {
  id: UnitId;
  armyId: ArmyId;
  factionId: DocId;
  type: string;
  name: string;
  profile: UnitProfile;
  stats: Record<string, number>;
  orders: OrderQueue | null;
  formation: string;
  sceneId: DocId | null;
  modelRange: readonly [number, number] | null;
  leaderTokenId: DocId | null;
}

export interface ArmyView {
  id: ArmyId;
  factionId: DocId;
  name: string;
  supply: Record<string, Json>;
  units: readonly UnitView[];
}

/** §10 logistics panel attrition forecast (pure, client-side). */
export interface Forecast {
  summary: string;
  rows: Array<{ label: string; value: number }>;
  data: Record<string, Json>;
}

/** §12 RulesModule — verbatim responsibilities. */
export interface RulesModule {
  schema: RulesSchema;
  validateOrder(ctx: RulesContext, unit: UnitView, order: Order): OkOrErr;
  resolveTurn(
    ctx: RulesContext,
    pool: ModelPool,
    units: UnitView[],
    orders: Map<UnitId, OrderQueue>,
    rng: PRNG,
    emit: (e: SimEvent) => void,
  ): void;
  /** Realtime mode tick (§5A). */
  tick?(
    ctx: RulesContext,
    pool: ModelPool,
    units: UnitView[],
    orders: Map<UnitId, OrderQueue>,
    rng: PRNG,
    emit: (e: SimEvent) => void,
    dtSeconds: number,
  ): void;
  /** Detection radius in grid units (§5A DetectionGrid). */
  detection(ctx: RulesContext, unit: UnitView): number;
  forecast?(ctx: RulesContext, army: ArmyView): Forecast;
  migrate?(pool: ModelPool, fromVersion: string): ModelPool;
}
