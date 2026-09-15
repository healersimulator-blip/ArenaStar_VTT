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
 * M05 — movement terrain at this scale. The platform has no terrain *layer* (nothing in
 * `src/canvas` paints movement costs), so the authored channel is the scene document's
 * `flags.pf1e.difficultCells`: squares, in **cell** coordinates, that a walker pays double
 * to enter — "each extra 5 feet of distance to move through difficult terrain costs 10 feet"
 * (CRB p.188, Movement, Difficult Terrain). The tactical scale reads the same flag through
 * the same helper and hands it to `pf1eMovePlan` (P03/D-198), so a GM authors ground once and
 * both scales price it; `null` terrain is a *named* default there ("no square was priced at
 * ×2"), never a silent ×1.
 */
export interface RulesTerrainContext {
  difficultCells: readonly { col: number; row: number }[];
}

/**
 * Read the scene's authored difficult squares. Tolerant of both authoring shapes —
 * `{ col, row }` objects and `[col, row]` pairs — and silent about entries that are not
 * finite numbers, because a malformed square must not decide a simulation: it is simply not
 * terrain. Returns `null` when the scene authors no ground at all, which is what lets the
 * consumer name the absence instead of inventing an empty-but-real terrain model.
 */
export function sceneDifficultCells(
  scene: { flags?: Record<string, unknown> } | null | undefined,
): RulesTerrainContext | null {
  const pf1e = scene?.flags?.["pf1e"];
  if (typeof pf1e !== "object" || pf1e === null) return null;
  const raw = (pf1e as Record<string, unknown>)["difficultCells"];
  if (!Array.isArray(raw)) return null;
  const cells: { col: number; row: number }[] = [];
  for (const item of raw) {
    let col: unknown;
    let row: unknown;
    if (Array.isArray(item)) {
      col = item[0];
      row = item[1];
    } else if (typeof item === "object" && item !== null) {
      col = (item as Record<string, unknown>).col;
      row = (item as Record<string, unknown>).row;
    }
    if (
      typeof col === "number" &&
      Number.isFinite(col) &&
      typeof row === "number" &&
      Number.isFinite(row)
    ) {
      cells.push({ col: Math.trunc(col), row: Math.trunc(row) });
    }
  }
  return { difficultCells: cells };
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
  /** F02 — TurnMode for the current turn (default "stepwise" when absent). */
  turnMode?: import("./strategic").TurnMode;
  /** M05 — authored movement ground; absent or `null` ⇒ this scene authors no terrain. */
  terrain?: RulesTerrainContext | null;
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
  /** F02 — squad grouping for simultaneous fan-out (ArmyWindow squadId tag). */
  squadId?: DocId | null;
  /** G-04/D-223 — Combat_Resolver_5 doctrine mode (see UnitDocument). */
  doctrine?: "advance" | "hold" | null;
  /** G-04/D-223 — excess-frontage wrap manoeuvre; `false` disables it. */
  envelop?: boolean | null;
  /** G-04/D-223 — the unit's army initiative modifier (Combat_Resolver_5 B12). */
  armyInitiative?: number | null;
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

/**
 * M10 — one castable option a rules package advertises to player order controls.
 *
 * This is a *presentation* contract over data the module already owns (its spell
 * registry), never a second source of rules truth: the payload a control builds from it is
 * still judged by `validateOrder` and executed by `resolveTurn`. `targeting` says which
 * payload shape the spell needs — `"point"` designates a remote origin (`{x, y}` in feet),
 * `"direction"` shoots away from the caster (`{dirX, dirY}`), matching CRB p.214's burst
 * versus cone/line distinction as the mass-battle module encodes it.
 */
export interface RulesCastOption {
  /** The pack entry id the order names in `data.spell`. */
  id: string;
  /** Display name (the pack's spell name), never used for resolution. */
  label: string;
  /** Payload shape this spell's order needs. */
  targeting: "point" | "direction";
}

/**
 * M10 — the order vocabulary a package accepts from normal player controls. Optional by
 * design: a module without it (the built-in mass-battle-basic demo) gets no caster
 * controls anywhere, rather than controls that would only be refused at resolve time.
 */
export interface RulesOrderVocabulary {
  casts: readonly RulesCastOption[];
}

/** §12 RulesModule — verbatim responsibilities. */
export interface RulesModule {
  schema: RulesSchema;
  validateOrder(ctx: RulesContext, unit: UnitView, order: Order): OkOrErr;
  /** M10 — castable-spell vocabulary for order UIs; absent ⇒ no caster controls. */
  orderVocabulary?(): RulesOrderVocabulary;
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
