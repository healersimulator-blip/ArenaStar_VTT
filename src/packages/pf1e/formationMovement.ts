/**
 * Two-tier `combat_resolver_5`-style strategic unit & per-model movement engine.
 *
 * Ports the reference's movement architecture (`Examples/combat_resolver_5.html`
 * `moveUnits` + `slotPos` / `effectiveSlotPos` + `moveTowardPoint` / `moveAvoidingHarm`
 * + `resolveMovementAoOs`):
 *
 *  1. **Virtual Unit Anchor & Wheeling (`planFormationAnchor`):**
 *     Each unit advances a virtual front-centre anchor along its ordered path (or
 *     doctrine advance vector) and smoothly wheels its formation facing toward distant
 *     destinations (`d > 60 ft`, `rotateToward(facing, targetFacing, 0.5)`), holding
 *     facing on charges (`C23b`) and close-in approaches so rear ranks never teleport
 *     or swirl across the battlefield (`I5`).
 *
 *  2. **Per-Model Formation Slot Targeting (`slotWorldPos` + `effectiveFilePromotions`):**
 *     Every living soldier owns a `(file, rank)` slot. Outer files on a wheeling
 *     march naturally trace longer arcs and lag if their individual movement budget
 *     runs out (`I1`), catching up on subsequent turns. When `reform` is active (`C3`),
 *     rear-rank survivors target their promoted `targetRank` along their own file (`I2`).
 *     In `doctrine` / `envelop` contact (`C17b`/`C39`), head-on files facing a breach in
 *     the opposing line slide laterally toward adjacent living defenders (`<= 4.5` files)
 *     or press through the breach instead of idling opposite empty air.
 *
 *  3. **Per-Model Micro-Steering (`stepModelTowardSlot`):**
 *     Each soldier steps independently toward its target slot up to its own movement
 *     budget, steering through `ANGLES = [0, +0.5, -0.5, +1.0, -1.0, +pi/2, -pi/2]`
 *     around VTT walls/closed doors, difficult terrain (`2x` movement cost), spell
 *     hazards (`routeAroundSpellHazards`), and occupied cells (`MarchReservation`),
 *     recording its walked trail for PF1e movement AoO resolution.
 */
import type { UnitView } from "../../core/rules";
import { ModelStatus, type ModelPool, type Vec2 } from "../../core/strategic";
export type { Vec2 };
import {
  pointInSpellHazard,
  routeAroundSpellHazards,
  segmentHitsSpellHazard,
  type SpellHazard,
} from "../../core/strategicRoom/hazardAvoidance";
import {
  effectiveFilePromotions,
  normalizeAngle,
  rotateToward,
  type FormationBounds,
} from "./formationSlots";
import { PF1eCondition } from "./schema";
import {
  applyUnitConditionsToStride,
  PF1E_CHARGE_MIN_FEET,
  planPF1eStride,
  stridePaceFactor,
  type PF1eStrideInput,
  type PF1eStridePace,
  type PF1eStrideResult,
} from "./stride";

const STEER_ANGLES = [0, 0.5, -0.5, 1.0, -1.0, Math.PI * 0.5, -Math.PI * 0.5] as const;

const snapPos = (v: number, quantize: boolean): number =>
  quantize ? Math.round(v * 16) / 16 : v;

const withinBounds = (b: FormationBounds | undefined, x: number, y: number): boolean =>
  !b || (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY);

export interface UnitFormationFrame {
  /** Index of the first living model (`lead`). */
  leadIdx: number;
  /** Current lead model position (`x, y`). */
  leadAt: Vec2;
  /** Current virtual front-centre anchor (`x, y`). */
  anchor: Vec2;
  /** Current unit formation facing in radians (`0` = `+x`). */
  facing: number;
  /** Total files across the unit's frontage (`F`). */
  filesPerRank: number;
  /** Whether models carry explicit deployed `(file, rank)` slots vs custom offsets. */
  explicitSlots: boolean;
  /** Per-living-model local `(forward, lateral)` offset when `explicitSlots === false`, or `(file, rank)` slot metadata. */
  models: ReadonlyArray<{
    idx: number;
    file: number;
    currentRank: number;
    targetRank: number;
    /** Signed forward offset from `anchor` along `facing` (`<= 0` for rear ranks). */
    localDepth: number;
    /** Signed lateral offset from `anchor` perpendicular to `facing`. */
    localFront: number;
  }>;
}

const EMPTY_DIFFICULT_SET: ReadonlySet<string> = new Set<string>();

/**
 * Reconstruct a unit's current `combat_resolver_5` virtual formation frame
 * (`anchor`, `facing`, `filesPerRank`, and each living soldier's slot / promoted slot)
 * directly from `ModelPool` columns without requiring extra serialized state.
 */
export function buildUnitFormationFrame(
  pool: ModelPool,
  range: readonly [number, number],
  cellFeet: number,
  defaultFacing = 0,
): UnitFormationFrame | null {
  const span = Math.min(range[1], pool.count) - range[0];
  if (span <= 0) return null;
  if (span === 1) {
    const idx = range[0];
    if (((pool.status[idx] ?? 0) & ModelStatus.dead) !== 0) return null;
    const x = pool.x[idx] ?? 0;
    const y = pool.y[idx] ?? 0;
    const r = pool.rot[idx] ?? 0;
    const facing = r !== 0 ? r : defaultFacing;
    const file = pool.file[idx] ?? 0;
    const rank = pool.rank[idx] ?? 0;
    if (file === 0 && rank === 0) {
      const leadAt = { x, y };
      return {
        leadIdx: idx,
        leadAt,
        anchor: { x, y },
        facing,
        filesPerRank: 1,
        explicitSlots: false,
        models: [
          {
            idx,
            file: 0,
            currentRank: 0,
            targetRank: 0,
            localDepth: 0,
            localFront: 0,
          },
        ],
      };
    }
  }
  const living: number[] = [];
  for (let i = range[0]; i < range[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) living.push(i);
  }
  if (living.length === 0) return null;

  const leadIdx = living[0];
  if (leadIdx === undefined) return null;
  const leadAt = { x: pool.x[leadIdx] ?? 0, y: pool.y[leadIdx] ?? 0 };

  let sinSum = 0;
  let cosSum = 0;
  let anyNonZeroRot = false;
  for (const idx of living) {
    const r = pool.rot[idx] ?? 0;
    if (r !== 0) anyNonZeroRot = true;
    sinSum += Math.sin(r);
    cosSum += Math.cos(r);
  }
  const facing = anyNonZeroRot ? Math.atan2(sinSum, cosSum) : defaultFacing;
  const c = Math.cos(facing);
  const s = Math.sin(facing);

  const explicitSlots = living.some(
    (i) => (pool.rank[i] ?? 0) !== 0 || (pool.file[i] ?? 0) !== 0,
  );

  if (!explicitSlots) {
    // Custom/arbitrary model positions (e.g. hand-placed 2-model fixtures or singletons):
    // preserve exact local frame offsets relative to `leadAt` and `facing`.
    const promotions = effectiveFilePromotions(pool, range, cellFeet);
    const promoByIdx = new Map(promotions.map((p) => [p.modelIdx, p]));
    let maxFile = 0;
    for (const p of promotions) if (p.file > maxFile) maxFile = p.file;
    const filesPerRank = Math.max(1, maxFile + 1);
    const models = living.map((idx) => {
      const dx = (pool.x[idx] ?? 0) - leadAt.x;
      const dy = (pool.y[idx] ?? 0) - leadAt.y;
      const localDepth = dx * c + dy * s;
      const localFront = -dx * s + dy * c;
      const p = promoByIdx.get(idx);
      return {
        idx,
        file: p?.file ?? 0,
        currentRank: p?.currentRank ?? 0,
        targetRank: p?.targetRank ?? 0,
        localDepth,
        localFront,
      };
    });
    return {
      leadIdx,
      leadAt,
      anchor: { ...leadAt },
      facing,
      filesPerRank,
      explicitSlots: false,
      models,
    };
  }

  const promotions = effectiveFilePromotions(pool, range, cellFeet);
  const promoByIdx = new Map(promotions.map((p) => [p.modelIdx, p]));

  let maxFile = 0;
  for (const idx of living) {
    const f = pool.file[idx] ?? 0;
    if (f > maxFile) maxFile = f;
  }
  // Standard line deployments use up to 10 files (`Math.min(totalDeployed, 10)`),
  // whereas smaller squads have `maxFile + 1`. Recover the true `filesPerRank` by
  // checking if any model has `rank > 0` (meaning full width is `maxFile + 1`, typically 10
  // or 4 for column) or else `maxFile + 1`.
  const filesPerRank = Math.max(1, maxFile + 1);

  // Detect lateral handedness (`latSign = +1` when file 0 sits at negative lateral offset,
  // or `-1` when a mirrored opponent faces `Math.PI` with file 0 at world `-y`).
  let latSign = 1;
  if (living.length >= 2) {
    let minFIdx = -1;
    let maxFIdx = -1;
    for (const idx of living) {
      const f = pool.file[idx] ?? 0;
      if (minFIdx < 0 || f < (pool.file[minFIdx] ?? 0)) minFIdx = idx;
      if (maxFIdx < 0 || f > (pool.file[maxFIdx] ?? 0)) maxFIdx = idx;
    }
    if (minFIdx >= 0 && maxFIdx >= 0 && minFIdx !== maxFIdx) {
      const df = (pool.file[maxFIdx] ?? 0) - (pool.file[minFIdx] ?? 0);
      if (df > 0) {
        const dx = (pool.x[maxFIdx] ?? 0) - (pool.x[minFIdx] ?? 0);
        const dy = (pool.y[maxFIdx] ?? 0) - (pool.y[minFIdx] ?? 0);
        const latDiff = -dx * s + dy * c;
        if (latDiff < -0.1) latSign = -1;
      }
    }
  }

  // Infer virtual `anchor` from the front-most living rank (`minRank`) so an already-lagged
  // outer wing does not drag the anchor backward, while exact rectangular deployments
  // yield the exact deployment anchor `(anchor.x, anchor.y)`!
  let minRank = Infinity;
  for (const idx of living) {
    const r = pool.rank[idx] ?? 0;
    if (r < minRank) minRank = r;
  }
  let anchorSumX = 0;
  let anchorSumY = 0;
  let anchorContributors = 0;
  for (const idx of living) {
    const r = pool.rank[idx] ?? 0;
    if (r !== minRank) continue;
    const f = pool.file[idx] ?? 0;
    const depth = -r * cellFeet;
    const front = latSign * (f - (filesPerRank - 1) / 2) * cellFeet;
    anchorSumX += (pool.x[idx] ?? 0) - (depth * c - front * s);
    anchorSumY += (pool.y[idx] ?? 0) - (depth * s + front * c);
    anchorContributors++;
  }
  const anchor =
    anchorContributors > 0
      ? {
          x: anchorSumX / anchorContributors,
          y: anchorSumY / anchorContributors,
        }
      : { ...leadAt };

  const models = living.map((idx) => {
    const file = pool.file[idx] ?? 0;
    const currentRank = pool.rank[idx] ?? 0;
    const promo = promoByIdx.get(idx);
    const targetRank = promo?.targetRank ?? currentRank;
    const localDepth = -currentRank * cellFeet;
    const localFront = latSign * (file - (filesPerRank - 1) / 2) * cellFeet;
    return {
      idx,
      file,
      currentRank,
      targetRank,
      localDepth,
      localFront,
    };
  });

  return {
    leadIdx,
    leadAt,
    anchor,
    facing,
    filesPerRank,
    explicitSlots: true,
    models,
  };
}

/** Compute world target slot for one model of `frame` given `(anchor, facing)` and `usePromotedRank`. */
export function targetSlotForModel(
  _frame: UnitFormationFrame,
  modelEntry: UnitFormationFrame["models"][number],
  anchor: Vec2,
  facing: number,
  cellFeet: number,
  usePromotedRank: boolean,
  quantize = false,
): Vec2 {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  const rankDiff = usePromotedRank
    ? modelEntry.currentRank - modelEntry.targetRank
    : 0;
  const depth = modelEntry.localDepth + rankDiff * cellFeet;
  const front = modelEntry.localFront;
  return {
    x: snapPos(anchor.x + depth * c - front * s, quantize),
    y: snapPos(anchor.y + depth * s + front * c, quantize),
  };
}

export interface PlannedAnchorMove {
  frame: UnitFormationFrame;
  stride: PF1eStrideResult;
  speedScale: number;
  /** Target virtual anchor after this turn's unit-level advance. */
  targetAnchor: Vec2;
  /** Target unit formation facing after `combat_resolver_5` wheeling (`rotateToward`). */
  targetFacing: number;
  /** Anchor waypoints walked this turn (used for leg-by-leg steering when multi-waypoint). */
  walkedAnchorLegs: Vec2[];
  /** Per-model total movement budget in feet (`movePoints * paceFactor * speedScale * cellFeet`). */
  modelBudgetFeet: number;
  /** Combined difficult cells (terrain + active spell hazards). */
  difficult: ReadonlySet<string>;
}

export interface PlanAnchorMoveInput {
  pool: ModelPool;
  unit: UnitView;
  path: ReadonlyArray<Vec2>;
  pace: PF1eStridePace;
  movePoints: number;
  cellFeet: number;
  reform?: boolean;
  explicitFacing?: number;
  defaultFacing?: number;
  difficult?: ReadonlySet<string>;
  /**
   * When true, `input.difficult` already includes active `hazards` cells, so
   * `planFormationAnchorMove` reuses `input.difficult` directly without O(hazards * cells)
   * rasterization or cloning on every move validation call.
   */
  difficultIncludesHazards?: boolean;
  hazards?: readonly SpellHazard[];
  blockAt?: (fx: number, fy: number, tx: number, ty: number) => number | null;
  blockEpsilon?: number;
}

/**
 * Tier 1 (`combat_resolver_5` `moveUnits`):
 * Advance the unit's virtual anchor along the ordered path (converting lead-referenced
 * order paths into virtual-anchor coordinates transparently) and compute the unit's
 * wheeled formation facing (`rotateToward` up to `0.5 rad/round` on approaches `> 60 ft`,
 * holding facing on charges and short tactical shifts so rear ranks never whip across the field).
 */
export function planFormationAnchorMove(
  input: PlanAnchorMoveInput,
): PlannedAnchorMove | { refusal: string; stride: PF1eStrideResult; leadAt: Vec2 } {
  const {
    pool,
    unit,
    path,
    pace,
    movePoints,
    cellFeet,
    reform = false,
    explicitFacing,
    defaultFacing = 0,
    hazards = [],
    blockAt,
    blockEpsilon = 1e-3,
  } = input;

  const range = unit.modelRange ?? [0, 0];
  const frame = buildUnitFormationFrame(pool, range, cellFeet, defaultFacing);
  if (!frame) {
    return {
      leadAt: { x: 0, y: 0 },
      refusal: `${pace}: unit has no living models`,
      stride: {
        to: { x: 0, y: 0 },
        traveled: 0,
        terrainExtra: 0,
        terrainSquares: 0,
        hitWall: false,
        refusal: `${pace}: unit has no living models`,
        legs: 0,
      },
    };
  }

  let difficult: ReadonlySet<string>;
  if (input.difficultIncludesHazards && input.difficult) {
    difficult = input.difficult;
  } else if ((!input.difficult || input.difficult.size === 0) && hazards.length === 0) {
    difficult = EMPTY_DIFFICULT_SET;
  } else {
    const built = new Set<string>(input.difficult ?? []);
    for (const hazard of hazards) {
      // Only area hazards (`radius >= cellFeet * 0.5`) cover full 5-ft grid squares as
      // difficult terrain; pinpoint test fixtures (`radius: 1` on one model) apply the
      // `ENTANGLED` condition to that model without double-taxing adjacent squares!
      if (hazard.radius < cellFeet * 0.5) continue;
      const minC = Math.floor((hazard.at.x - hazard.radius) / cellFeet);
      const maxC = Math.floor((hazard.at.x + hazard.radius) / cellFeet);
      const minR = Math.floor((hazard.at.y - hazard.radius) / cellFeet);
      const maxR = Math.floor((hazard.at.y + hazard.radius) / cellFeet);
      for (let c = minC; c <= maxC; c++) {
        for (let r = minR; r <= maxR; r++) {
          if (
            pointInSpellHazard(hazard, {
              x: (c + 0.5) * cellFeet,
              y: (r + 0.5) * cellFeet,
            })
          ) {
            built.add(`${c},${r}`);
          }
        }
      }
    }
    difficult = built;
  }

  // `order.path` in ArenaStar is authored relative to `leadAt` (`pool.x[firstLiving]`).
  // When `path` is a single waypoint at a lateral angle (`|y_wp - leadAt.y| > 0.01`), check
  // whether the caller targeted the unit's centroid/anchor (`y_wp == frame.anchor.y`) vs
  // `leadAt` (`y_wp == frame.leadAt.y`)! Specifically:
  //  - If `path` is aligned with `leadAt` (e.g. `path.y === leadAt.y` or `path.x === leadAt.x`),
  //    translating by `(frame.anchor - frame.leadAt)` keeps the march strictly straight!
  //  - If `path[0]` matches `frame.anchor.y` on a horizontal march (e.g. `anchor.y = 100` while
  //    `leadAt.y = 92.5`), treat `path` as already anchored at `frame.anchor` so a straight
  //    eastward march toward `(80, 100)` does not introduce a spurious `+7.5 ft` diagonal skew!
  const firstWp = path[0];
  const pathTargetsAnchorY =
    firstWp !== undefined &&
    Math.abs(frame.anchor.y - frame.leadAt.y) > 0.1 &&
    Math.abs(firstWp.y - frame.anchor.y) < 0.05 &&
    Math.abs(firstWp.x - frame.anchor.x) > 0.1;
  const pathTargetsAnchorX =
    firstWp !== undefined &&
    Math.abs(frame.anchor.x - frame.leadAt.x) > 0.1 &&
    Math.abs(firstWp.x - frame.anchor.x) < 0.05 &&
    Math.abs(firstWp.y - frame.anchor.y) > 0.1;
  const anchorOffsetX = pathTargetsAnchorX ? 0 : frame.anchor.x - frame.leadAt.x;
  const anchorOffsetY = pathTargetsAnchorY ? 0 : frame.anchor.y - frame.leadAt.y;

  let anchorPath: Vec2[] = path.map((wp) => ({
    x: wp.x + anchorOffsetX,
    y: wp.y + anchorOffsetY,
  }));

  // `combat_resolver_5` C13: steer the virtual anchor around active spell hazards on
  // marches/withdrawals (charges and runs stay straight so `planPF1eStride` enforces CRB p.188).
  // Note: `combat_resolver_5` `entersLiveHarm` / `harmDetourPoint` only forces an outward
  // flee when the unit itself is inside the spell's area (`pointInSpellHazard(h, anchor, 0)`),
  // while using `clearance` to skirt around hazards that lie ahead on the path!
  const nonPinpointHazards = hazards.filter((h) => h.radius >= cellFeet * 0.5);
  if (nonPinpointHazards.length > 0 && (pace === "march" || pace === "withdraw")) {
    let clearance = cellFeet;
    for (const m of frame.models) {
      clearance = Math.max(
        clearance,
        Math.hypot(
          (pool.x[m.idx] ?? 0) - frame.anchor.x,
          (pool.y[m.idx] ?? 0) - frame.anchor.y,
        ) + cellFeet,
      );
    }
    const routed: Vec2[] = [];
    let cursor = frame.anchor;
    for (const wp of anchorPath) {
      const seg = routeAroundSpellHazards(cursor, wp, nonPinpointHazards, clearance);
      routed.push(...seg);
      cursor = seg.at(-1) ?? cursor;
    }
    anchorPath = routed.slice(0, 12);
  }

  const anchorMovePoints = reform && pace === "march" ? movePoints * 0.5 : movePoints;
  const rawStride: PF1eStrideInput = {
    from: frame.anchor,
    path: anchorPath,
    pace,
    movePoints: anchorMovePoints,
    cellFeet,
    difficult,
    // Virtual anchor represents the formation command post (`combat_resolver_5` `moveUnits`):
    // individual soldiers handle wall clipping / doorway steering in `stepModelAlongWaypoints`,
    // except when the formation is a single model or charging straight ahead.
    blockAt:
      frame.models.length === 1 || pace === "charge" || pace === "run"
        ? blockAt
        : undefined,
    blockEpsilon,
  };

  const cond = applyUnitConditionsToStride(rawStride, pool, unit);
  if (cond.refusal !== null) {
    const failed: PF1eStrideResult = {
      to: { ...frame.leadAt },
      traveled: 0,
      terrainExtra: 0,
      terrainSquares: 0,
      hitWall: false,
      refusal: cond.refusal,
      legs: path.length,
    };
    return { refusal: cond.refusal, stride: failed, leadAt: frame.leadAt };
  }

  const walkedAnchorLegs: Vec2[] = [];
  const anchorStride = planPF1eStride(cond.input, (x, y) =>
    walkedAnchorLegs.push({ x, y }),
  );
  if (anchorStride.refusal !== null) {
    return {
      refusal: anchorStride.refusal,
      stride: { ...anchorStride, to: { ...frame.leadAt } },
      leadAt: frame.leadAt,
    };
  }

  const targetAnchor = anchorStride.to;
  const adx = targetAnchor.x - frame.anchor.x;
  const ady = targetAnchor.y - frame.anchor.y;

  // `combat_resolver_5` `moveUnits` wheeling rule (I5 + C23b):
  // - Explicit `order.facing` rotates smoothly toward requested facing (`maxStep = 0.5`).
  // - Charges (`pace === "charge"`) hold facing during the slam so the formation stays coherent.
  // - Long oblique marches (`totalOrderDist > 60 ft` and lateral deviation `> 0.15 rad`)
  //   wheel `facing` toward the march heading (`maxStep = 0.5 rad/turn`), while short
  //   tactical shifts (`<= 60 ft`) dress ranks without whipping rear ranks sideways!
  let targetFacing = frame.facing;
  if (explicitFacing !== undefined) {
    targetFacing = rotateToward(frame.facing, explicitFacing, 0.5);
  } else if (pace !== "charge") {
    const finalWp = anchorPath.at(-1);
    if (finalWp) {
      const orderDx = finalWp.x - frame.anchor.x;
      const orderDy = finalWp.y - frame.anchor.y;
      const orderDist = Math.hypot(orderDx, orderDy);
      if (orderDist > 60 && (Math.abs(adx) > 1e-3 || Math.abs(ady) > 1e-3)) {
        const desiredHeading = Math.atan2(ady, adx);
        if (Math.abs(normalizeAngle(desiredHeading - frame.facing)) > 0.15) {
          targetFacing = rotateToward(frame.facing, desiredHeading, 0.5);
        }
      }
    }
  }

  // Note: when `reform` is active on a `march`, the anchor advances at half speed while
  // every individual soldier retains its FULL march budget (`movePoints * speedScale * cellFeet`)
  // so rear ranks have the movement surplus needed to close into promoted front slots (`C3`)!
  const modelBudgetFeet =
    movePoints * stridePaceFactor(pace) * cond.speedScale * cellFeet;

  const leadDest = {
    x: frame.leadAt.x + adx,
    y: frame.leadAt.y + ady,
  };

  return {
    frame,
    stride: {
      ...anchorStride,
      to: leadDest,
    },
    speedScale: cond.speedScale,
    targetAnchor,
    targetFacing,
    walkedAnchorLegs,
    modelBudgetFeet,
    difficult,
  };
}

export interface ModelStepCallbacks {
  bounds?: FormationBounds;
  quantize?: boolean;
  difficult?: ReadonlySet<string>;
  hazards?: readonly SpellHazard[];
  blockAt?: (fx: number, fy: number, tx: number, ty: number) => number | null;
  blockEpsilon?: number;
  /**
   * Optional cell/blocker check for `(px, py)` (e.g. hosted `MarchReservation` or other-unit
   * occupancy). Returning `true` means `modelIdx` cannot enter `(px, py)`.
   */
  isBlockedAt?: (modelIdx: number, fromX: number, fromY: number, px: number, py: number) => boolean;
  /**
   * Optional final cell claim when `modelIdx` settles at `(finalX, finalY)`.
   * Returning `false` rolls back to the last claimable step along its walked trail.
   */
  commitPosition?: (modelIdx: number, startX: number, startY: number, finalX: number, finalY: number) => boolean;
  /**
   * When true (multi-waypoint user-drawn route), do not auto-steer around occupied
   * squares mid-leg so an explicit leg drawn into a blocker stops short of that blocker.
   */
  explicitMultiWaypoint?: boolean;
  allowLateralSlotFallback?: boolean;
}

export interface ModelMoveOutcome {
  modelIdx: number;
  from: Vec2;
  to: Vec2;
  movedFeet: number;
  terrainSquares: number;
  terrainExtraFeet: number;
  hitWall: boolean;
  blockedByOccupancy: boolean;
  slid: boolean;
  trail: Vec2[];
}

/**
 * Tier 2 (`combat_resolver_5` `moveTowardPoint` + `moveAvoidingHarm`):
 * Step a single model from its current `(x, y)` through `waypoints` toward its target
 * formation slot up to `budgetFeet`, micro-steering around walls, hazards, difficult
 * ground, and occupied squares.
 */
export function stepModelAlongWaypoints(
  pool: ModelPool,
  modelIdx: number,
  waypoints: ReadonlyArray<Vec2>,
  budgetFeet: number,
  cellFeet: number,
  pace: PF1eStridePace,
  callbacks: ModelStepCallbacks = {},
): ModelMoveOutcome {
  const startX = pool.x[modelIdx] ?? 0;
  const startY = pool.y[modelIdx] ?? 0;
  const quantize = callbacks.quantize ?? false;
  const difficult = callbacks.difficult;
  const hazards = callbacks.hazards ?? [];
  const blockAt = callbacks.blockAt;
  const blockEps = callbacks.blockEpsilon ?? 1e-3;
  const bounds = callbacks.bounds;
  const isBlockedAt = callbacks.isBlockedAt;

  const trail: Vec2[] = [{ x: startX, y: startY }];
  if (!(budgetFeet > 0) || waypoints.length === 0) {
    return {
      modelIdx,
      from: { x: startX, y: startY },
      to: { x: startX, y: startY },
      movedFeet: 0,
      terrainSquares: 0,
      terrainExtraFeet: 0,
      hitWall: false,
      blockedByOccupancy: false,
      slid: false,
      trail,
    };
  }

  // Expand waypoints around active spell hazards for individual soldiers on marches/withdrawals
  // (`combat_resolver_5` `moveAvoidingHarm` / `harmDetourPoint`).
  // Only area hazards (`radius >= cellFeet * 0.5`) generate avoidance detours; pinpoint
  // fixtures (`radius: 1` on a single model) already apply `ENTANGLED` directly.
  const soldierAvoidHazards =
    hazards.length > 0 ? hazards.filter((h) => h.radius >= cellFeet * 0.5) : [];
  let effectiveWaypoints: readonly Vec2[] = waypoints;
  if (soldierAvoidHazards.length > 0 && (pace === "march" || pace === "withdraw")) {
    const detoured: Vec2[] = [];
    let cursor = { x: startX, y: startY };
    for (const wp of waypoints) {
      const seg = routeAroundSpellHazards(cursor, wp, soldierAvoidHazards, cellFeet);
      detoured.push(...seg);
      cursor = seg.at(-1) ?? cursor;
    }
    effectiveWaypoints = detoured;
  }

  let curX = startX;
  let curY = startY;
  let remaining = budgetFeet;
  let movedFeet = 0;
  let terrainSquares = 0;
  let terrainExtraFeet = 0;
  let hitWall = false;
  let blockedByOccupancy = false;
  let everSawOccOnDirect = false;
  let slid = false;
  const hasDifficult = difficult !== undefined && difficult.size > 0;
  const visitedRoughCells = hasDifficult ? new Set<string>() : null;
  const startCellKey = hasDifficult
    ? `${Math.floor(startX / cellFeet)},${Math.floor(startY / cellFeet)}`
    : "";

  const allowedAngles: readonly number[] =
    pace === "charge" || pace === "run" ? [0] : STEER_ANGLES;
  const baseStep = Math.min(2.5, cellFeet * 0.5);

  // Fast-path for unobstructed straight leg when no mid-step steering is required:
  // uses exact `planPF1eStride` arithmetic across open or difficult ground so straight
  // marches match `stride.ts` bit-for-bit (`x = 25`, `terrainSquares = 1`), and clips
  // straight against continuous walls when no doorway/corner bypass exists around the wall!
  // Also applies when `hazards` exist elsewhere on the map as long as none intersect the
  // segment `(curX, curY) -> wp`!
  const firstFastWp = effectiveWaypoints.length === 1 ? effectiveWaypoints[0] : undefined;
  const fastWpHitsHazard =
    firstFastWp !== undefined &&
    hazards.length > 0 &&
    hazards.some(
      (h) =>
        pointInSpellHazard(h, { x: curX, y: curY }, cellFeet) ||
        segmentHitsSpellHazard(h, { x: curX, y: curY }, firstFastWp, cellFeet),
    );
  if (
    firstFastWp !== undefined &&
    !fastWpHitsHazard &&
    !callbacks.commitPosition
  ) {
    const wp = firstFastWp;
    const dx = (wp?.x ?? curX) - curX;
    const dy = (wp?.y ?? curY) - curY;
    const dist = Math.hypot(dx, dy);
    if (wp && dist > 1e-6) {
      const wallFrac = blockAt ? blockAt(curX, curY, wp.x, wp.y) : null;
      // Check if any square along the direct line is occupied by `isBlockedAt`
      let occAlongDirect = false;
      if (isBlockedAt) {
        const occStep = Math.max(baseStep, cellFeet * 0.5);
        const steps = Math.max(1, Math.ceil(Math.min(remaining, dist) / occStep));
        const maxD = Math.min(remaining, dist);
        let prevX = curX;
        let prevY = curY;
        for (let s = 1; s <= steps; s++) {
          const d = (maxD * s) / steps;
          const sx = curX + (dx / dist) * d;
          const sy = curY + (dy / dist) * d;
          if (isBlockedAt(modelIdx, prevX, prevY, sx, sy)) {
            occAlongDirect = true;
            break;
          }
          prevX = sx;
          prevY = sy;
        }
      }

      // Check whether any lateral offset (`±1..3` cells) has an unobstructed line around the wall
      // (e.g. a doorway or short pillar) so soldiers only enter micro-steering when a real opening exists!
      let wallHasBypass = false;
      if (wallFrac !== null && blockAt && pace !== "charge" && pace !== "run") {
        const ux0 = dx / dist;
        const uy0 = dy / dist;
        const px0 = -uy0;
        const py0 = ux0;
        for (const mult of [1, -1, 2, -2, 3, -3]) {
          const off = mult * cellFeet;
          const bx = curX + px0 * off;
          const by = curY + py0 * off;
          if (
            withinBounds(bounds, bx, by) &&
            blockAt(curX, curY, bx, by) === null &&
            blockAt(bx, by, wp.x, wp.y) === null
          ) {
            wallHasBypass = true;
            break;
          }
        }
      }

      if (!occAlongDirect && (wallFrac === null || !wallHasBypass)) {
        const directStride = planPF1eStride({
          from: { x: curX, y: curY },
          path: [wp],
          pace: "march",
          movePoints: remaining / cellFeet,
          cellFeet,
          ...(difficult && difficult.size > 0 ? { difficult } : {}),
          ...(blockAt ? { blockAt } : {}),
          blockEpsilon: blockEps,
        });
        const nx = snapPos(directStride.to.x, quantize);
        const ny = snapPos(directStride.to.y, quantize);
        if (withinBounds(bounds, nx, ny)) {
          curX = nx;
          curY = ny;
          movedFeet = Math.hypot(curX - startX, curY - startY);
          if (movedFeet > 0) trail.push({ x: curX, y: curY });
          return {
            modelIdx,
            from: { x: startX, y: startY },
            to: { x: curX, y: curY },
            movedFeet,
            terrainSquares: directStride.terrainSquares,
            terrainExtraFeet: directStride.terrainExtra,
            hitWall: directStride.hitWall,
            blockedByOccupancy: false,
            slid: false,
            trail,
          };
        }
      }
    }
  }

  for (const wp of effectiveWaypoints) {
    let guard = 0;
    const maxIters = Math.ceil(budgetFeet / Math.max(0.5, baseStep)) + 16;
    while (remaining > 1e-3 && guard++ < maxIters) {
      const dx = wp.x - curX;
      const dy = wp.y - curY;
      const distToWp = Math.hypot(dx, dy);
      if (distToWp <= 1e-3) break;

      const ux = dx / distToWp;
      const uy = dy / distToWp;
      const inc = Math.min(baseStep, remaining, distToWp);

      let bestX = curX;
      let bestY = curY;
      let bestScore = Infinity;
      let bestAngle = 0;
      let bestCost = inc;
      let bestStepDist = 0;
      let bestRoughKey: string | null = null;
      let found = false;
      let sawWallOnDirect = false;
      let sawOccOnDirect = false;
      const directToWpBlockedByWall =
        blockAt !== undefined && blockAt(curX, curY, wp.x, wp.y) !== null;

      for (const a of allowedAngles) {
        if (a !== 0) {
          if (sawOccOnDirect && callbacks.explicitMultiWaypoint) continue;
          // If the direct step hit an occupied square (`sawOccOnDirect`), only swerve around
          // the blocker when `wp` itself is NOT inside a blocked square AND a clear bypass
          // exists from the swerved step toward `wp` (prevents jittering sideways in front of
          // a solid enemy wall or swerving into a blocked destination!).
          if (sawOccOnDirect && isBlockedAt) {
            if (isBlockedAt(modelIdx, wp.x, wp.y, wp.x, wp.y)) continue;
            const caProbe = Math.cos(a);
            const saProbe = Math.sin(a);
            const vxProbe = ux * caProbe - uy * saProbe;
            const vyProbe = ux * saProbe + uy * caProbe;
            const probeX = curX + vxProbe * inc;
            const probeY = curY + vyProbe * inc;
            if (isBlockedAt(modelIdx, probeX, probeY, wp.x, wp.y)) continue;
          }
          // Only steer sideways around an obstacle/opening when the direct line to `wp` is
          // blocked by a wall (`directToWpBlockedByWall`) AND the stepped position has a clear
          // line to `wp` (e.g. doorway opening), OR when avoiding an occupied square (`sawOccOnDirect`).
          // That prevents troops from sliding laterally along a continuous wall when approaching it!
          if (directToWpBlockedByWall && !sawOccOnDirect && blockAt) {
            const caProbe = Math.cos(a);
            const saProbe = Math.sin(a);
            const vxProbe = ux * caProbe - uy * saProbe;
            const vyProbe = ux * saProbe + uy * caProbe;
            const probeX = curX + vxProbe * inc;
            const probeY = curY + vyProbe * inc;
            if (blockAt(probeX, probeY, wp.x, wp.y) !== null) continue;
          } else if (!directToWpBlockedByWall && !sawOccOnDirect) {
            if (!hasDifficult && hazards.length === 0) continue;
            // Only test sideways steering on unobstructed segments if `a === 0` actually
            // encountered difficult ground or a live spell hazard!
            const directPx = curX + ux * inc;
            const directPy = curY + uy * inc;
            let directHitsRough = false;
            if (hasDifficult && difficult) {
              const directKey = `${Math.floor(directPx / cellFeet)},${Math.floor(directPy / cellFeet)}`;
              directHitsRough = directKey !== startCellKey && difficult.has(directKey);
            }
            const directHitsHarm =
              hazards.length > 0 &&
              hazards.some((h) => pointInSpellHazard(h, { x: directPx, y: directPy }));
            if (!directHitsRough && !directHitsHarm) continue;
          }
        }
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const vx = ux * ca - uy * sa;
        const vy = ux * sa + uy * ca;
        let stepDist = inc;
        let px = curX + vx * stepDist;
        let py = curY + vy * stepDist;

        const wallFrac = blockAt ? blockAt(curX, curY, px, py) : null;
        if (wallFrac !== null) {
          if (a === 0) {
            sawWallOnDirect = true;
            const clipped = Math.max(0, wallFrac * stepDist - blockEps);
            if (clipped > 1e-4) {
              stepDist = clipped;
              px = curX + vx * stepDist;
              py = curY + vy * stepDist;
            } else {
              continue;
            }
          } else {
            continue;
          }
        }

        let qx = distToWp <= inc && a === 0 && wallFrac === null ? snapPos(wp.x, quantize) : snapPos(px, quantize);
        let qy = distToWp <= inc && a === 0 && wallFrac === null ? snapPos(wp.y, quantize) : snapPos(py, quantize);

        if (!withinBounds(bounds, qx, qy)) continue;
        if (blockAt && blockAt(curX, curY, qx, qy) !== null) {
          if (a === 0) sawWallOnDirect = true;
          continue;
        }
        if (isBlockedAt && isBlockedAt(modelIdx, curX, curY, qx, qy)) {
          if (a === 0) {
            sawOccOnDirect = true;
            everSawOccOnDirect = true;
            // Probe crisp integer-foot total travel from `(startX, startY)` first (`1 ft`
            // sweep parity with `MarchReservation`, e.g. `x = 4` before `[5, 10)` or `x = 9`
            // before `[10, 15)`) so halted formations dress on exact whole-foot ranks!
            const traveledSoFar = Math.hypot(curX - startX, curY - startY);
            const nextWholeTotal = Math.floor(traveledSoFar + 1e-4) + 1;
            const candidates: number[] = [];
            for (let t = Math.floor(traveledSoFar + stepDist); t >= nextWholeTotal; t--) {
              const c = t - traveledSoFar;
              if (c > 1e-3 && c < stepDist) candidates.push(c);
            }
            let chosenSub = 0;
            for (const cand of candidates) {
              if (cand > remaining + 1e-5) continue;
              const sx = snapPos(curX + vx * cand, quantize);
              const sy = snapPos(curY + vy * cand, quantize);
              if (
                withinBounds(bounds, sx, sy) &&
                (!blockAt || blockAt(curX, curY, sx, sy) === null) &&
                !isBlockedAt(modelIdx, curX, curY, sx, sy)
              ) {
                chosenSub = cand;
                break;
              }
            }
            if (chosenSub > 0) {
              qx = snapPos(curX + vx * chosenSub, quantize);
              qy = snapPos(curY + vy * chosenSub, quantize);
            } else {
              continue;
            }
          } else {
            continue;
          }
        }

        let cellKey: string | null = null;
        let entersDifficult = false;
        if (hasDifficult && difficult) {
          cellKey = `${Math.floor(qx / cellFeet)},${Math.floor(qy / cellFeet)}`;
          entersDifficult = cellKey !== startCellKey && difficult.has(cellKey);
        }
        const hard = entersDifficult ? 2 : 1;
        const actualDist = Math.hypot(qx - curX, qy - curY);
        if (actualDist <= 1e-5) continue;

        const stepCost = actualDist * hard;
        if (stepCost > remaining + 1e-5) {
          if (hard === 2 && a === 0) {
            // Partial step into difficult ground with remaining budget (`stride.ts` parity)
            const room = remaining / 2;
            if (room <= 1e-4) continue;
            const rx = snapPos(curX + vx * room, quantize);
            const ry = snapPos(curY + vy * room, quantize);
            if (!withinBounds(bounds, rx, ry)) continue;
            if (blockAt && blockAt(curX, curY, rx, ry) !== null) continue;
            if (isBlockedAt && isBlockedAt(modelIdx, curX, curY, rx, ry)) continue;
            const rDist = Math.hypot(rx - curX, ry - curY);
            if (rDist <= 1e-5) continue;
            const score = Math.hypot(wp.x - rx, wp.y - ry) + Math.abs(a) * 0.4 + 3;
            if (score < bestScore) {
              bestScore = score;
              bestX = rx;
              bestY = ry;
              bestAngle = a;
              bestStepDist = rDist;
              bestCost = remaining;
              bestRoughKey = cellKey;
              found = true;
            }
            continue;
          }
          continue;
        }

        const inHarm = hazards.some((h) => pointInSpellHazard(h, { x: qx, y: qy }));
        const score =
          Math.hypot(wp.x - qx, wp.y - qy) +
          Math.abs(a) * 0.4 +
          (hard - 1) * 3 +
          (inHarm ? 6 : 0);
        if (score < bestScore) {
          bestScore = score;
          bestX = qx;
          bestY = qy;
          bestAngle = a;
          bestStepDist = actualDist;
          bestCost = stepCost;
          bestRoughKey = entersDifficult ? cellKey : null;
          found = true;
        }
      }

      if (!found) {
        if (sawWallOnDirect) hitWall = true;
        if (sawOccOnDirect) blockedByOccupancy = true;
        break;
      }

      if (bestAngle !== 0) slid = true;
      curX = bestX;
      curY = bestY;
      trail.push({ x: curX, y: curY });
      movedFeet += bestStepDist;
      if (bestRoughKey !== null && visitedRoughCells) {
        terrainExtraFeet += bestCost - bestStepDist;
        if (!visitedRoughCells.has(bestRoughKey)) {
          visitedRoughCells.add(bestRoughKey);
          terrainSquares++;
        }
      }
      remaining = Math.max(0, remaining - bestCost);
      if (
        sawWallOnDirect &&
        bestAngle === 0 &&
        remaining > 1e-3 &&
        Math.hypot(wp.x - curX, wp.y - curY) > 1e-2
      ) {
        // Check if any non-zero steering angle from `(curX, curY)` has a clear line to `wp`
        let canSteerAround = false;
        if (allowedAngles.length > 1 && blockAt) {
          const rdx = wp.x - curX;
          const rdy = wp.y - curY;
          const rd = Math.hypot(rdx, rdy) || 1;
          const rux = rdx / rd;
          const ruy = rdy / rd;
          const stepProbe = Math.min(baseStep, remaining, rd);
          for (const a of allowedAngles) {
            if (a === 0) continue;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const px = curX + (rux * ca - ruy * sa) * stepProbe;
            const py = curY + (rux * sa + ruy * ca) * stepProbe;
            if (
              withinBounds(bounds, px, py) &&
              blockAt(curX, curY, px, py) === null &&
              blockAt(px, py, wp.x, wp.y) === null
            ) {
              canSteerAround = true;
              break;
            }
          }
        }
        if (!canSteerAround) {
          hitWall = true;
          break;
        }
      }
    }
    if (
      hitWall ||
      remaining <= 1e-3 ||
      (blockedByOccupancy && callbacks.explicitMultiWaypoint)
    ) {
      break;
    }
  }

  // Ensure final settled square is claimable when per-model square uniqueness is enforced
  // (e.g. hosted `MarchReservation` where models can pass through friendly ranks mid-stride
  // but must settle in distinct 5-ft squares at end of move).
  if (callbacks.commitPosition) {
    if (!callbacks.commitPosition(modelIdx, startX, startY, curX, curY)) {
      blockedByOccupancy = true;
      let settled = false;
      // When the formation wheeled (`allowLateralSlotFallback`) and the soldier collided
      // only with a friendly model that settled into the same quantized 5-ft square (`!sawOccOnDirect`),
      // try nearest open 5-ft neighbour around its target slot first so wheeled formations dress smoothly!
      if (!everSawOccOnDirect && callbacks.allowLateralSlotFallback) {
        const cCol = Math.floor(curX / cellFeet);
        const cRow = Math.floor(curY / cellFeet);
        const fracX = startX - Math.floor(startX / cellFeet) * cellFeet;
        const fracY = startY - Math.floor(startY / cellFeet) * cellFeet;
        let bestAlt: Vec2 | null = null;
        let bestAltDist = Infinity;
        for (let dc = -2; dc <= 2; dc++) {
          for (let dr = -2; dr <= 2; dr++) {
            if (dc === 0 && dr === 0) continue;
            const ax = snapPos((cCol + dc) * cellFeet + fracX, quantize);
            const ay = snapPos((cRow + dr) * cellFeet + fracY, quantize);
            if (!withinBounds(bounds, ax, ay)) continue;
            if (blockAt && blockAt(startX, startY, ax, ay) !== null) continue;
            if (isBlockedAt && isBlockedAt(modelIdx, startX, startY, ax, ay)) continue;
            const stepNeeded = Math.hypot(ax - startX, ay - startY);
            if (stepNeeded > budgetFeet + 1e-3) continue;
            const dSlot = Math.hypot(ax - curX, ay - curY);
            if (dSlot < bestAltDist) {
              bestAltDist = dSlot;
              bestAlt = { x: ax, y: ay };
            }
          }
        }
        if (
          bestAlt &&
          callbacks.commitPosition(modelIdx, startX, startY, bestAlt.x, bestAlt.y)
        ) {
          curX = bestAlt.x;
          curY = bestAlt.y;
          trail.push({ x: curX, y: curY });
          movedFeet = Math.hypot(curX - startX, curY - startY);
          slid = true;
          settled = true;
        }
      }
      // Otherwise (or if no neighbour fit), roll back along the model's walked `trail`
      // preferring crisp integer-foot travel from `(startX, startY)` so rear ranks halt
      // cleanly 1 ft behind the square boundary (`x = -1` behind `x = 4` in cell `[0, 5)`).
      let settledIdx = trail.length - 1;
      while (settledIdx >= 0 && !settled) {
        const segTo = trail[settledIdx];
        if (!segTo) {
          settledIdx--;
          continue;
        }
        const segFrom = (settledIdx > 0 ? trail[settledIdx - 1] : segTo) ?? segTo;
        const segLen = Math.hypot(segTo.x - segFrom.x, segTo.y - segFrom.y);
        const distFromStartToSegFrom = Math.hypot(
          segFrom.x - startX,
          segFrom.y - startY,
        );
        const maxWholeFromStart = Math.floor(
          distFromStartToSegFrom + segLen - 1e-4,
        );
        const minWholeFromStart = Math.ceil(distFromStartToSegFrom - 1e-4);
        const probeLengths: number[] = [];
        for (let t = maxWholeFromStart; t >= minWholeFromStart; t--) {
          const rem = t - distFromStartToSegFrom;
          if (rem >= -1e-4 && rem <= segLen + 1e-4) {
            probeLengths.push(Math.max(0, Math.min(segLen, rem)));
          }
        }
        probeLengths.push(0);
        for (const rem of probeLengths) {
          const frac = segLen > 0 ? rem / segLen : 0;
          const candX = snapPos(
            segFrom.x + (segTo.x - segFrom.x) * frac,
            quantize,
          );
          const candY = snapPos(
            segFrom.y + (segTo.y - segFrom.y) * frac,
            quantize,
          );
          if (callbacks.commitPosition(modelIdx, startX, startY, candX, candY)) {
            curX = candX;
            curY = candY;
            trail.length = Math.max(1, settledIdx);
            const lastPt = trail[trail.length - 1];
            if (!lastPt || lastPt.x !== curX || lastPt.y !== curY) {
              trail.push({ x: curX, y: curY });
            }
            let recomputed = 0;
            for (let k = 1; k < trail.length; k++) {
              const pa = trail[k - 1];
              const pb = trail[k];
              if (pa && pb) {
                recomputed += Math.hypot(pb.x - pa.x, pb.y - pa.y);
              }
            }
            movedFeet = recomputed;
            settled = true;
            break;
          }
        }
        settledIdx--;
      }
    }
  }

  return {
    modelIdx,
    from: { x: startX, y: startY },
    to: { x: curX, y: curY },
    movedFeet,
    terrainSquares,
    terrainExtraFeet,
    hitWall,
    blockedByOccupancy,
    slid,
    trail,
  };
}

export interface ExecuteFormationMoveInput extends PlanAnchorMoveInput {
  bounds?: FormationBounds;
  strictBounds?: boolean;
  quantize?: boolean;
  callbacks?: Omit<ModelStepCallbacks, "bounds" | "quantize" | "difficult" | "hazards" | "blockAt" | "blockEpsilon">;
  /**
   * Optional enemy model indices for `combat_resolver_5` C17b/C39 breach-sliding and
   * C23b/C40 charge convergence when advancing into contact.
   */
  enemyModelIndices?: readonly number[];
  reachFt?: number;
  allowBreachSlide?: boolean;
}

export interface ExecutedFormationMove {
  unit: UnitView;
  leadFrom: Vec2;
  leadTo: Vec2;
  startFacing: number;
  targetAnchor: Vec2;
  targetFacing: number;
  traveled: number;
  terrainSquares: number;
  terrainExtraFeet: number;
  hitWall: boolean;
  blockedByOccupancy: boolean;
  reformedModels: number;
  ranksClosed: number;
  outcomes: ModelMoveOutcome[];
}

/**
 * Plan and execute (or dry-run into per-model `outcomes` before committing to `pool`)
 * a complete `combat_resolver_5` two-tier unit movement:
 *  - Tier 1 advances & wheels the virtual formation anchor;
 *  - Tier 2 computes each living model's rotated/promoted/breach-adjusted target slot
 *    and micro-steers that soldier individually within its own movement budget!
 */
export function planUnitModelMoves(
  input: ExecuteFormationMoveInput,
):
  | { ok: true; plan: ExecutedFormationMove }
  | { ok: false; refusal: string; leadAt: Vec2 } {
  const anchorPlan = planFormationAnchorMove(input);
  if ("refusal" in anchorPlan) {
    return {
      ok: false,
      refusal: anchorPlan.refusal,
      leadAt: anchorPlan.leadAt,
    };
  }

  const {
    pool,
    unit,
    pace,
    cellFeet,
    reform = false,
    quantize = false,
    bounds,
    hazards = [],
    blockAt,
    blockEpsilon = 1e-3,
    callbacks,
    enemyModelIndices = [],
    reachFt = cellFeet,
    allowBreachSlide = false,
  } = input;

  const {
    frame,
    targetAnchor,
    targetFacing,
    walkedAnchorLegs,
    modelBudgetFeet,
    difficult,
  } = anchorPlan;

  const outcomes: ModelMoveOutcome[] = [];
  let reformedModels = 0;
  let ranksClosed = 0;
  let anyHitWall = anchorPlan.stride.hitWall;
  let anyBlockedOcc = false;

  // Sort in ascending `targetRank` (`0, 1, 2, ...`) then `file` so front ranks step and
  // vacate/claim cells before rear ranks close up behind them (`combat_resolver_5` C3)!
  const orderedModels =
    frame.models.length <= 1
      ? frame.models
      : [...frame.models].sort(
          (a, b) => a.targetRank - b.targetRank || a.file - b.file || a.idx - b.idx,
        );

  const multiLeg = walkedAnchorLegs.length > 1;
  const startFacing = frame.facing;

  for (const m of orderedModels) {
    let waypoints: Vec2[];
    if (multiLeg) {
      const legCount = walkedAnchorLegs.length;
      waypoints = walkedAnchorLegs.map((legAnchor, k) => {
        const legFacing =
          startFacing +
          normalizeAngle(targetFacing - startFacing) * ((k + 1) / legCount);
        return targetSlotForModel(
          frame,
          m,
          legAnchor,
          legFacing,
          cellFeet,
          reform && k === legCount - 1,
          quantize,
        );
      });
    } else {
      let slot = targetSlotForModel(
        frame,
        m,
        targetAnchor,
        targetFacing,
        cellFeet,
        reform,
        quantize,
      );

      // `combat_resolver_5` C17b / C39 breach exploitation when advancing into enemy lines
      // under doctrine/envelop: if a front-rank file faces an open gap in a nearby enemy line
      // (`<= 30 ft`), slide laterally up to `4.5 * cellFeet` toward the nearest living foe.
      if (
        allowBreachSlide &&
        m.targetRank === 0 &&
        enemyModelIndices.length > 0
      ) {
        let oppDist = Infinity;
        let nearSlideIdx = -1;
        let nearSlideDist = Infinity;
        for (const eIdx of enemyModelIndices) {
          if (((pool.status[eIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
          const ex = pool.x[eIdx] ?? 0;
          const ey = pool.y[eIdx] ?? 0;
          const dSlot = Math.hypot(ex - slot.x, ey - slot.y);
          if (dSlot < oppDist) oppDist = dSlot;
          if (dSlot <= cellFeet * 4.5 && dSlot < nearSlideDist) {
            nearSlideDist = dSlot;
            nearSlideIdx = eIdx;
          }
        }
        if (oppDist > cellFeet * 1.8) {
          if (nearSlideIdx >= 0) {
            // Slide sideways up to 4.5 files toward covering enemy & press into reach (`C17b`)
            const ex = pool.x[nearSlideIdx] ?? 0;
            const ey = pool.y[nearSlideIdx] ?? 0;
            const sx = pool.x[m.idx] ?? 0;
            const sy = pool.y[m.idx] ?? 0;
            const ang = Math.atan2(ey - sy, ex - sx);
            const dNow = Math.hypot(ex - sx, ey - sy);
            const closeDist = Math.max(0, dNow - reachFt * 0.9);
            slot = {
              x: snapPos(sx + Math.cos(ang) * closeDist, quantize),
              y: snapPos(sy + Math.sin(ang) * closeDist, quantize),
            };
          } else {
            // Complete sector breach (`C17b` breakthrough `else` branch): when the entire
            // local sector (`<= 4.5` files) has been blown open, drive through the hole
            // toward the enemy formation's center of mass!
            let sumEx = 0;
            let sumEy = 0;
            let cntE = 0;
            for (const eIdx of enemyModelIndices) {
              if (((pool.status[eIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
              sumEx += pool.x[eIdx] ?? 0;
              sumEy += pool.y[eIdx] ?? 0;
              cntE++;
            }
            if (cntE > 0) {
              slot = {
                x: snapPos(sumEx / cntE, quantize),
                y: snapPos(sumEy / cntE, quantize),
              };
            }
          }
        }
      }

      waypoints = [slot];
    }

    const finalWp = waypoints.at(-1);
    if (
      input.strictBounds &&
      bounds &&
      finalWp &&
      !withinBounds(bounds, finalWp.x, finalWp.y)
    ) {
      // Check whether the soldier's unobstructed reachable step this turn would also leave `bounds`
      const startX = pool.x[m.idx] ?? 0;
      const startY = pool.y[m.idx] ?? 0;
      const dx = finalWp.x - startX;
      const dy = finalWp.y - startY;
      const dist = Math.hypot(dx, dy);
      const step = Math.min(modelBudgetFeet, dist);
      const fReachX = Math.fround(
        dist > 0 ? startX + (dx / dist) * step : startX,
      );
      const fReachY = Math.fround(
        dist > 0 ? startY + (dy / dist) * step : startY,
      );
      const reachX = snapPos(fReachX, quantize);
      const reachY = snapPos(fReachY, quantize);
      if (!withinBounds(bounds, reachX, reachY)) {
        return {
          ok: false,
          leadAt: frame.leadAt,
          refusal: "Formation would extend outside the battlefield.",
        };
      }
    }

    const outcome = stepModelAlongWaypoints(
      pool,
      m.idx,
      waypoints,
      modelBudgetFeet,
      cellFeet,
      pace,
      {
        ...(bounds ? { bounds } : {}),
        quantize,
        difficult,
        hazards,
        ...(blockAt ? { blockAt } : {}),
        blockEpsilon,
        ...(multiLeg && input.path.length > 1 ? { explicitMultiWaypoint: true } : {}),
        ...(Math.abs(normalizeAngle(targetFacing - startFacing)) > 1e-4
          ? { allowLateralSlotFallback: true }
          : {}),
        ...(callbacks?.isBlockedAt ? { isBlockedAt: callbacks.isBlockedAt } : {}),
        ...(callbacks?.commitPosition
          ? { commitPosition: callbacks.commitPosition }
          : {}),
      },
    );

    if (outcome.hitWall) anyHitWall = true;
    if (outcome.blockedByOccupancy) anyBlockedOcc = true;

    if (reform && m.targetRank < m.currentRank && outcome.movedFeet > anchorPlan.stride.traveled + cellFeet * 0.5) {
      const closed = Math.min(
        m.currentRank - m.targetRank,
        Math.max(
          1,
          Math.round((outcome.movedFeet - anchorPlan.stride.traveled) / cellFeet),
        ),
      );
      if (closed > 0) {
        reformedModels++;
        ranksClosed += closed;
      }
    }

    outcomes.push(outcome);
  }

  // PF1e CRB p.188 charge validation across the formation:
  // - At least one charging front soldier must cover >= 10 ft in a straight unobstructed line;
  // - No charging soldier may cross difficult terrain or be forced to swerve (`slid`).
  if (pace === "charge") {
    const maxMoved = outcomes.reduce((mx, o) => Math.max(mx, o.movedFeet), 0);
    if (maxMoved + 1e-4 < PF1E_CHARGE_MIN_FEET) {
      return {
        ok: false,
        leadAt: frame.leadAt,
        refusal: `charge: the march covers ${Math.round(maxMoved)} ft, and a charge must cross at least ${PF1E_CHARGE_MIN_FEET} ft of open ground (CRB p.188)`,
      };
    }
    const roughMoved = outcomes.find((o) => o.terrainSquares > 0);
    if (roughMoved) {
      return {
        ok: false,
        leadAt: frame.leadAt,
        refusal: `charge: a charge cannot cross difficult terrain (CRB p.188) — the line crosses ${roughMoved.terrainSquares} rough square(s)`,
      };
    }
    if (anyHitWall) {
      return {
        ok: false,
        leadAt: frame.leadAt,
        refusal:
          "charge: a charge requires a clear path unobstructed by walls (CRB p.188)",
      };
    }
  }

  const leadOutcome =
    outcomes.find((o) => o.modelIdx === frame.leadIdx) ?? outcomes[0];
  const maxTerrainSquares = outcomes.reduce(
    (mx, o) => Math.max(mx, o.terrainSquares),
    anchorPlan.stride.terrainSquares,
  );
  const maxTerrainExtra = outcomes.reduce(
    (mx, o) => Math.max(mx, o.terrainExtraFeet),
    anchorPlan.stride.terrainExtra,
  );
  const representativeTraveled =
    (leadOutcome?.movedFeet ?? 0) > 0
      ? (leadOutcome?.movedFeet ?? 0)
      : outcomes.reduce((mx, o) => Math.max(mx, o.movedFeet), 0);

  return {
    ok: true,
    plan: {
      unit,
      leadFrom: frame.leadAt,
      leadTo: leadOutcome ? leadOutcome.to : frame.leadAt,
      startFacing: frame.facing,
      targetAnchor,
      targetFacing,
      traveled: representativeTraveled,
      terrainSquares: maxTerrainSquares,
      terrainExtraFeet: maxTerrainExtra,
      hitWall: anyHitWall,
      blockedByOccupancy: anyBlockedOcc,
      reformedModels,
      ranksClosed,
      outcomes,
    },
  };
}

/**
 * Write a planned `ExecutedFormationMove` into `pool` (`x`, `y`, `rot`, and promoted `rank`).
 */
export function commitUnitModelMoves(
  pool: ModelPool,
  plan: ExecutedFormationMove,
  opts: { explicitFacing?: number; reform?: boolean; cellFeet: number },
): void {
  const { explicitFacing, reform = false, cellFeet } = opts;
  for (const o of plan.outcomes) {
    if (((pool.status[o.modelIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
    pool.x[o.modelIdx] = o.to.x;
    pool.y[o.modelIdx] = o.to.y;
    const mdx = o.to.x - o.from.x;
    const mdy = o.to.y - o.from.y;
    if (explicitFacing !== undefined) {
      pool.rot[o.modelIdx] = explicitFacing;
    } else if (Math.abs(mdx) > 1e-4 || Math.abs(mdy) > 1e-4) {
      const wheeled =
        Math.abs(normalizeAngle(plan.targetFacing - plan.startFacing)) > 1e-4;
      // When the formation wheeled, orient soldiers toward the actual travel direction
      // (`rotateToward(..., 0.75)`) so soldier rotation visibly reflects the turn, while
      // `buildUnitFormationFrame` averages living `rot` to track progressive wheeling!
      const desiredRot =
        wheeled && !o.slid && Math.hypot(mdx, mdy) < 0.25
          ? plan.targetFacing
          : Math.atan2(mdy, mdx);
      pool.rot[o.modelIdx] = rotateToward(
        pool.rot[o.modelIdx] ?? 0,
        desiredRot,
        0.75,
      );
    }
  }

  if (reform) {
    const range = plan.unit.modelRange ?? [0, 0];
    const promotions = effectiveFilePromotions(pool, range, cellFeet);
    for (const p of promotions) {
      if (p.targetRank < p.currentRank) {
        const out = plan.outcomes.find((o) => o.modelIdx === p.modelIdx);
        if (out && out.movedFeet > plan.traveled + cellFeet * 0.5) {
          const closed = Math.min(
            p.currentRank - p.targetRank,
            Math.max(1, Math.round((out.movedFeet - plan.traveled) / cellFeet)),
          );
          pool.rank[p.modelIdx] = Math.max(0, p.currentRank - closed);
        }
      }
    }
  }
}

/**
 * Helper to check if any living model in `range` is currently grappled/immobilized (`C31`).
 */
export function isUnitGrappled(
  pool: ModelPool,
  range: readonly [number, number],
): boolean {
  const cond = pool.sys.pfCondition;
  if (!cond) return false;
  for (let i = range[0]; i < range[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
    if (((cond[i] ?? 0) & PF1eCondition.HAZARD_GRAPPLED) !== 0) return true;
  }
  return false;
}
