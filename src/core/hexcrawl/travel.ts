/**
 * **Hexcrawl travel — the party walks a clicked path, and the clock pays for it (D-269, plan §4,
 * requirement 7).**
 *
 * The party token has an assigned route (the cells the GM clicked, `setTravelRouteOps`), a
 * cursor, and seconds of progress towards the next cell. Advancing the march is a **pure
 * function of (route, terrain, terrain catalog, elapsed world time) → progress, events and the
 * party token's new position**, and it consumes the *world clock* rather than a private timer:
 * `advanceWorldClockOps` moves time, `travelAdvance` reads how much time moved and says what it
 * bought. That ordering is what makes "the party walks for three days" mean the same thing as
 * "three days pass" everywhere else — the seconds that end a `1 hour/level` buff
 * (`packages/pf1e/effects.ts`) are the seconds that carry the party over the mountains.
 *
 * Three decisions worth stating:
 *
 * - **A hex costs fractions of a day, not a fixed step, so a party can stop mid-cell.**
 *   Progress is stored in seconds and a cell is entered when its cost is paid: a party that
 *   marches 12 hours into a 3-day forest crossing is 12 hours in, and next session resumes there.
 * - **The walk says where the time went.** `TravelAdvance.spentSeconds` is the per-cell ledger of
 *   requirement 8's *time* rule: the seconds of a completed step belong to the cell the party left
 *   (the ground it walked over — a route's first cell is one the party marches *through*, and
 *   crediting the cell being entered would leave that starting hex at zero forever), a step that
 *   ended mid-crossing belongs to the cell the party is still standing in, and whatever is left of
 *   the advance after the route ends is spent where the party stopped (it camps there — the plan's
 *   "spent exploring/resting in the cell"). The invariant that makes the ledger trustworthy:
 *   **the seconds sum to the advance's own elapsed time**, so a feature's "2 hours here" and the
 *   clock's own reading can never drift apart.
 * - **Events come out of the same walk, in order.** Each border crossing is an `entering` moment
 *   and each step a `moving` moment, stamped with the clock reading they happened at; the caller
 *   feeds them to `core/hexcrawl/encounter.ts`, which is the only thing that decides whether
 *   anything fires. Travel never rolls dice.
 * - **Positions are cell centres.** The token is placed at each cell's centre as it is entered
 *   (the party's formation inside a cell is the GM's business), and a gridless scene uses the
 *   zone centres from `core/hexcrawl/cells.ts`.
 *
 * Everything here is pure: no store, no ops beyond `partyPositionOps`/`travelProgressOps`, no
 * wall clock.
 */
import type { SceneDocument, TokenDocument } from "../documents";
import type { FlatDiff, Op } from "../ops";
import { DAY_SECONDS } from "../clock";
import { cellsOf, cellCenterOf, parseCellKey } from "./cells";
import { triggersForStep, type EncounterTrigger } from "./encounter";
import {
  PF1E_TERRAIN_CATALOG,
  ROAD_COST,
  isRoadTerrain,
  secondsForCost,
  terrainCost,
  type TerrainCatalog,
} from "./terrain";
import { hexcrawlProfileOf, type TravelPace, type TravelPlan } from "./types";

/** Travel is capped per call: a month in one click is a data accident, not a march. */
export const MAX_TRAVEL_DAYS_PER_ADVANCE = 30;
/** And a cap on events, so one call cannot produce an unbounded stream (plan §9). */
export const MAX_TRAVEL_EVENTS = 512;

export interface TravelStep {
  /** The cell the party entered, and the cell it left (null for the first step). */
  cellKey: string;
  fromKey: string | null;
  /** Terrain id of the cell entered (null = the catalog default). */
  terrain: string | null;
  /** Cost of this step from `stepCostOf` (road-clamped, max of the two terrains). */
  cost: number;
  /** Seconds this step takes at the plan's pace and speed. */
  seconds: number;
  /** Clock reading when the party left `fromKey`. */
  departedAtClock: number;
  /** Clock reading when the party arrived in `cellKey`. */
  arrivedAtClock: number;
  /** Which trigger points this step produced (`triggersForStep`). */
  triggers: EncounterTrigger[];
}

export interface TravelAdvance {
  /** The plan after the elapsed time, or null when the route was completed. */
  plan: TravelPlan | null;
  /** The cell the party stands in now (null when there is no route at all). */
  cellKey: string | null;
  /** Every step taken during this advance, in order. */
  steps: TravelStep[];
  /** True when the party reached the end of its route. */
  arrived: boolean;
  /** Elapsed seconds that did not fit inside the route (the party waits at the end). */
  leftoverSeconds: number;
  /**
   * Seconds of this advance charged to each cell, keyed by cell key (requirement 8's *time*
   * rule — see the module note). The values sum to `elapsedSeconds` whenever the party had a
   * route at all, and the map is empty when it had none.
   */
  spentSeconds: Record<string, number>;
}

/**
 * Advance a march by `elapsedSeconds` of world time.
 *
 * `catalog` is passed in rather than defaulted so a caller cannot price a march with the stock
 * table while the world uses a custom one; `travelTerrainCatalog` supplies the world's (an
 * unset `hexTerrain` setting falls back to the PF1e table).
 */
export function travelAdvance(opts: {
  scene: SceneDocument;
  /**
   * The committed route, as read from the profile — typed nullable on purpose: the caller reads
   * `flags.core.hexcrawl.travel`, which is absent on a map the party has not marched on yet, and
   * a pure function that trusts its input here would throw in the middle of a GM's click.
   */
  plan: TravelPlan | null;
  elapsedSeconds: number;
  catalog: TerrainCatalog;
  /** Clock reading at the *start* of the advance; events are stamped from here. */
  startClock: number;
}): TravelAdvance {
  const { scene, catalog } = opts;
  const plan = opts.plan;
  if (!plan || plan.path.length === 0) {
    return {
      plan: null,
      cellKey: null,
      steps: [],
      arrived: false,
      leftoverSeconds: Math.max(0, Math.trunc(opts.elapsedSeconds)),
      spentSeconds: {},
    };
  }
  const elapsed = Math.min(
    Math.max(0, Math.trunc(opts.elapsedSeconds)),
    MAX_TRAVEL_DAYS_PER_ADVANCE * DAY_SECONDS,
  );
  const steps: TravelStep[] = [];
  const spentSeconds: Record<string, number> = {};
  const charge = (key: string | null, seconds: number): void => {
    if (key === null || seconds <= 0) return;
    spentSeconds[key] = (spentSeconds[key] ?? 0) + Math.round(seconds);
  };
  let cursor = Math.max(0, Math.min(plan.cursor, plan.path.length - 1));
  let progress = Math.max(0, plan.progressSeconds);
  const startClock = Math.max(0, Math.trunc(opts.startClock));
  // `clock` is the reading *before* the step currently being walked: it moves only when a step
  // completes, so a partial step's arrival stays a fraction of the way through a cell.
  let clock = startClock;
  let remaining = elapsed;
  const terrainOf = (key: string | null): string | null =>
    key === null
      ? null
      : (cellsOf(scene).find((c) => c.key === key)?.terrain ?? null);

  let currentKey = plan.path[cursor] ?? null;
  if (currentKey === null) {
    return {
      plan: null,
      cellKey: null,
      steps: [],
      arrived: false,
      leftoverSeconds: elapsed,
      spentSeconds: {},
    };
  }
  // A route may begin at the party's own cell without naming it; the first *step* is what the
  // path lists, so a single-cell plan is immediately "arrived".
  while (remaining > 0 && cursor < plan.path.length - 1) {
    const nextKey = plan.path[cursor + 1] as string;
    const from = terrainOf(currentKey);
    const to = terrainOf(nextKey);
    const cost = stepCostOf(catalog, from, to);
    const seconds = secondsForCost(plan.speedPerDay, cost, {
      pace: plan.pace,
      daySeconds: DAY_SECONDS,
    });
    const need = Math.max(0, seconds - progress);
    if (remaining < need) {
      // The step does not finish: the party is left mid-crossing, and the clock has advanced by
      // exactly the seconds that were available. Those seconds are spent *in the cell it is
      // still standing in* — it has not arrived anywhere yet.
      charge(currentKey, remaining);
      progress += remaining;
      remaining = 0;
      break;
    }
    clock = clock + need;
    remaining -= need;
    // The seconds of a step that *did* finish belong to the ground the party walked over.
    charge(currentKey, need);
    steps.push({
      cellKey: nextKey,
      fromKey: currentKey,
      terrain: to,
      cost,
      seconds,
      // When the party left the cell it is leaving: the arrival time minus the step's own
      // duration, which is what makes a resumed mid-hex march report honestly (`need` is only the
      // part that was walked during *this* advance).
      departedAtClock: Math.max(0, clock - seconds),
      arrivedAtClock: clock,
      triggers: triggersForStep(currentKey, nextKey),
    });
    currentKey = nextKey;
    cursor += 1;
    progress = 0;
    if (steps.length >= MAX_TRAVEL_EVENTS) break;
  }

  const arrived = cursor >= plan.path.length - 1;
  // The route is finished: `travel` clears so the map stops drawing a march that is over. The
  // party keeps the ground it stands on, and the caller's `stepSecondsOf` still reports the cell
  // it is in.
  const nextPlan: TravelPlan | null = arrived
    ? null
    : { ...plan, cursor, progressSeconds: Math.round(progress) };
  // Time left over after the party reached its destination is time spent standing there. `remaining`
  // is 0 for a mid-crossing stop (already charged above), so this only fires on arrival — and it is
  // what keeps `spentSeconds` summing to the advance's own elapsed time.
  charge(currentKey, remaining);
  return {
    plan: nextPlan,
    cellKey: currentKey,
    steps,
    arrived,
    leftoverSeconds: remaining,
    spentSeconds,
  };
}

/**
 * The cost of crossing one border: the worse of the two terrains, **unless either side carries a
 * road** — the road rule from `terrain.ts`, which is a property of the step rather than of a
 * cell (a highway hex beside a mountain hex is a fast crossing *because of the road*).
 */
export function stepCostOf(
  catalog: TerrainCatalog,
  from: string | null,
  to: string | null,
): number {
  if (isRoadTerrain(catalog, from) || isRoadTerrain(catalog, to))
    return ROAD_COST;
  return Math.max(terrainCost(catalog, from), terrainCost(catalog, to));
}

/** Seconds to walk one border, terrain read from the scene's authored cells. */
export function stepSecondsOf(
  scene: SceneDocument,
  catalog: TerrainCatalog,
  fromKey: string,
  toKey: string,
  speedPerDay: number,
  pace: TravelPace,
): number {
  const terrainOf = (key: string): string | null =>
    cellsOf(scene).find((c) => c.key === key)?.terrain ?? null;
  const cost = stepCostOf(catalog, terrainOf(fromKey), terrainOf(toKey));
  return secondsForCost(speedPerDay, cost, { pace, daySeconds: DAY_SECONDS });
}

/**
 * Seconds for a whole route at the current pace — the itinerary the GM reads *before* committing
 * ("3 days 6 hours to the keep"). Terrain comes from the scene's authored cells, so an unkeyed
 * map prices as default terrain.
 */
export function routeSeconds(opts: {
  scene: SceneDocument;
  path: readonly string[];
  speedPerDay: number;
  pace: TravelPace;
  catalog: TerrainCatalog;
}): number {
  let total = 0;
  for (let i = 0; i < opts.path.length - 1; i++) {
    total += stepSecondsOf(
      opts.scene,
      opts.catalog,
      opts.path[i] as string,
      opts.path[i + 1] as string,
      opts.speedPerDay,
      opts.pace,
    );
  }
  return total;
}

/** The terrain catalog a scene should be priced with (the world's `hexTerrain`, else stock). */
export function travelTerrainCatalog(worldCatalog: unknown): TerrainCatalog {
  return (worldCatalog as TerrainCatalog | null) ?? PF1E_TERRAIN_CATALOG;
}

// ─── ops ─────────────────────────────────────────────────────────────────────

/**
 * Move the party token to a world point. The token may be owned by anyone (a party token is
 * usually the GM's), so the caller submits this through the ordinary intent path and the host's
 * ownership rules apply — travel is a convenience, not a privilege escalation.
 */
export function partyPositionOps(
  scene: SceneDocument,
  tokenId: string,
  point: { x: number; y: number },
): Op[] {
  const token = (scene.tokens ?? []).find((t) => t._id === tokenId);
  if (!token) return [];
  // Both sides of this are centres (see `partyCentreOf`): a cell answers in its centre, and a
  // token *is* stored as a centre, so standing on a cell is setting the two equal.
  return [
    {
      kind: "update",
      ref: {
        coll: "tokens",
        id: tokenId,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: {
        x: Math.round(point.x),
        y: Math.round(point.y),
      } as FlatDiff,
    },
  ];
}

/**
 * Write the plan's cursor/progress back after an advance (null clears a finished route). The
 * profile's other fields are carried through unchanged, so a march never disturbs the reveal
 * set, terrain, sight or mode the GM set.
 */
export function travelProgressOps(
  scene: SceneDocument,
  plan: TravelPlan | null,
): Op[] {
  const profile = hexcrawlProfileOf(scene);
  if (!profile) return [];
  const flags = scene.flags ?? {};
  const core =
    typeof flags["core"] === "object" && flags["core"] !== null
      ? (flags["core"] as FlatDiff)
      : {};
  return [
    {
      kind: "update",
      ref: { coll: "scenes", id: scene._id },
      diff: {
        flags: {
          ...flags,
          core: {
            ...core,
            hexcrawl: {
              version: profile.version,
              revealed: profile.revealed,
              sight: {
                mode: profile.sight.mode,
                radiusCells: profile.sight.radiusCells,
                radiusWorldUnits: profile.sight.radiusWorldUnits,
              },
              partyTokenId: profile.partyTokenId,
              encounterMode: profile.encounterMode,
              daylight: {
                dawnHour: profile.daylight.dawnHour,
                duskHour: profile.daylight.duskHour,
              },
              terrain: profile.terrain,
              travel: plan
                ? {
                    path: plan.path,
                    cursor: plan.cursor,
                    progressSeconds: plan.progressSeconds,
                    speedPerDay: plan.speedPerDay,
                    pace: plan.pace,
                  }
                : null,
            },
          },
        },
      } as FlatDiff,
    },
  ];
}

/** The party token document, if the profile names one that still exists. */
export function partyTokenOf(
  scene: SceneDocument | null | undefined,
): TokenDocument | null {
  const profile = hexcrawlProfileOf(scene);
  if (!profile?.partyTokenId) return null;
  return (
    (scene?.tokens ?? []).find((t) => t._id === profile.partyTokenId) ?? null
  );
}

/**
 * **The party's world point: the token's own centre.**
 *
 * `TokenDocument.x/y` *is* the centre and `width/height` are pixels (`src/canvas/tokens.ts`,
 * `tokenRect`, and the placement helpers the browser specs drive — `pf1eMoveToken` writes
 * `(col + 0.5) * cellSize`). Phase 0b and the first cut of the overlay both read `x/y` as a
 * top-left corner and scaled `width` by the grid size, which put a real party token — a 100 px
 * token on a 100 px grid — a hundred cells away from where it was drawn. The browser gate caught
 * it (`hexPartyPoint()` returned a point outside the map), and it is the reason this reader
 * exists: one place, so a second caller cannot re-derive the geometry wrongly.
 */
export function partyCentreOf(
  scene: SceneDocument | null | undefined,
): { x: number; y: number } | null {
  const token = partyTokenOf(scene);
  return token ? { x: token.x, y: token.y } : null;
}

/**
 * The party's current cell: the cell containing its token (the caller supplies the lookup —
 * `cellAtPoint` from `cells.ts` — because gridless scenes answer from authored zones).
 */
export function partyCellOf(
  scene: SceneDocument,
  lookup: (x: number, y: number) => string | null,
): string | null {
  const centre = partyCentreOf(scene);
  return centre ? lookup(centre.x, centre.y) : null;
}

/** Whether a key is a usable cell address for this scene (a coordinate pair or a zone id). */
export function isCellKey(key: string): boolean {
  return parseCellKey(key) !== null || key.length > 0;
}

/** The world point a key names, for the token placement above. */
export function worldPointOf(
  scene: SceneDocument,
  key: string,
): { x: number; y: number } | null {
  return cellCenterOf(scene, key);
}

/**
 * A route as the points to draw: one entry per key, in order, with the world point it names.
 * Keys a scene cannot place (a zone deleted from a gridless map) are dropped rather than
 * guessed at — a route line that runs through a point that does not exist is worse than a gap.
 * `cursor` is carried through so the canvas can mark where the party currently stands.
 */
export function routePointsOf(
  scene: SceneDocument,
  path: readonly string[],
): Array<{ key: string; x: number; y: number }> {
  const out: Array<{ key: string; x: number; y: number }> = [];
  for (const key of path) {
    const point = worldPointOf(scene, key);
    if (point) out.push({ key, x: point.x, y: point.y });
  }
  return out;
}
