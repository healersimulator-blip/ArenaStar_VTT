/**
 * §9A strategic fog — client-side faction-vision helpers. The fog is derived
 * from the SAME DetectionGrid math the host projects with (core/detection);
 * the GM tab may preview it as a faction (god view off) or skip it entirely.
 */
import { DetectionGrid, poolBounds, type DetectionSource } from "./detection";
import type { FactionDocument, ModelPool, UnitDocument } from "./strategic";
import type { RulesWallsContext } from "./rules";
import type { BaseDocument } from "./documents";

/** Strategic-scene selector (§9A: flags.core.scale). */
/**
 * Dedupe key for fog redraws: buckets zoom coarsely (redraw only on bucket or
 * rect-list change) so the 300ms sync tick stays cheap while panning.
 */
export function fogSyncKey(
  rects: readonly { x: number; y: number }[],
  camera: { scale: number },
): string {
  const zoomBucket = Math.max(1, Math.round(6 / camera.scale));
  return `${zoomBucket}|${rects.length}|${rects
    .map((r) => `${Math.round(r.x)},${Math.round(r.y)}`)
    .join(";")}`;
}

export function sceneIsStrategic(scene: BaseDocument | undefined | null): boolean {
  const flags = scene?.flags as { core?: { scale?: unknown } } | undefined;
  return flags?.core?.scale === "strategic";
}

export interface StrategicFogInput {
  pool: ModelPool;
  armies: ReadonlyArray<{ factionId: string; units: readonly UnitDocument[] }>;
  factions: readonly FactionDocument[];
  /** The viewing faction (its units detect; allies share vision). */
  factionId: string;
  /** Detection radius per unit in grid units (RulesModule.detection). */
  radiusOf: (unit: UnitDocument) => number;
  walls?: RulesWallsContext | null;
  wallsVersion?: number;
  cellSize?: number;
}

export interface StrategicFog {
  grid: DetectionGrid;
  /** Units of the viewing faction + allies (their models stay visible). */
  allyUnitIds: Set<string>;
  /** Faction ids whose vision applies (viewer + allies) — pass to cell queries. */
  allyFactionIds: string[];
}

/** Build the faction fog grid from the local replica (pure; no DOM). */
export function buildStrategicFog(input: StrategicFogInput): StrategicFog {
  const cellSize = input.cellSize ?? 5;
  const allies = new Set(
    (input.factions.find((f) => f._id === input.factionId)?.allies ?? []).filter(
      (a): a is string => typeof a === "string",
    ),
  );
  const allyFactionIds = [input.factionId, ...allies];
  const allyUnitIds = new Set<string>();
  const sources: DetectionSource[] = [];
  for (const army of input.armies) {
    const isAlly = army.factionId === input.factionId || allies.has(army.factionId);
    for (const unit of army.units) {
      if (!isAlly) continue;
      allyUnitIds.add(unit._id);
      const anchor = unitAnchor(input.pool, unit);
      if (!anchor) continue;
      sources.push({ anchor, factionId: army.factionId, radius: input.radiusOf(unit) });
    }
  }
  const grid = new DetectionGrid(cellSize);
  grid.reseed(sources, poolBounds(input.pool), input.walls ?? null, input.wallsVersion ?? 0);
  return { grid, allyUnitIds, allyFactionIds };
}

/** Mean live-model position of a unit (its detection anchor), or null. */
export function unitAnchor(pool: ModelPool, unit: UnitDocument): { x: number; y: number } | null {
  const range = unit.modelRange;
  if (!range) return null;
  const [start, end] = range;
  if (start >= end) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const lo = Math.max(0, start);
  const hi = Math.min(pool.count, end);
  for (let i = lo; i < hi; i++) {
    sx += pool.x[i] ?? 0;
    sy += pool.y[i] ?? 0;
    n++;
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n };
}
