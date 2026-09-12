/**
 * §8A deployment: materialize Unit docs into pool models when a campaign
 * starts with no stored checkpoint and no injected initial snapshot (D-081).
 * Pure + deterministic — same units/factions always build the same layout,
 * so a host restart that re-deploys reproduces identical anchors.
 *
 * Layout: factions (sorted by id) get lanes along x; units stack along y in
 * their army order. A unit may override its anchor via profile.anchor
 * ({x, y} JSON). Formations: line (ranks of 10), column (files of 4), wedge
 * (triangle); anything else deploys as a line. hp/hpMax 1, sys.ammo 6 — the
 * mass-battle-basic defaults the rules module expects.
 *
 * Spacing is the caller's, and `TurnChannel` passes the scene's grid distance
 * (P01, D-182) so one model lands per square. The generic 4-ft default survives
 * only for callers that have no scene; the PF1e rules that read squares
 * (threat, flanking) are documented against that contract.
 */
import type { DocId, UnitId } from "../core/ids";
import type { UnitView } from "../core/rules";
import type { FactionDocument } from "../core/strategic";
import { createModelPool, allocModel, type SysSchema } from "./pool";
import { snapshotFromPool, encodeSimSnapshot } from "./codec";

export interface DeployModelPos {
  x: number;
  y: number;
  facing: number;
}

export interface DeployUnitPlan {
  unitId: UnitId;
  anchor: { x: number; y: number };
  count: number;
  formation: string;
  positions: DeployModelPos[];
}

export interface DeployLayout {
  plans: DeployUnitPlan[];
}

export interface DeployOptions {
  /**
   * World units between neighbouring models. Production passes the **scene's**
   * grid distance (`sceneCellFeet`) so formations deploy one model per square
   * (P01): the per-model rules the sim applies on top — threat and AoN 183
   * flanking — read whole squares, and a layout that packs several models into
   * one square makes those rules describe geometry the grid never had. The 4-ft
   * default is the generic deployer's legacy spacing, kept for callers with no
   * scene (tests, the mass-battle-basic reference system).
   */
  spacing?: number;
  /** Models per rank in "line" formation (default 10). */
  filesPerRank?: number;
  /** Models per file in "column" formation (default 4). */
  rankDepth?: number;
  /** Base lane position for faction index k (default x = 150 + k * 300). */
  laneX?: (factionIndex: number) => number;
  /** Base y for unit index j within a faction (default y = 150 + j * 250). */
  laneY?: (unitIndexInFaction: number) => number;
  /** Cap per unit and total (default 100k total — the pool budget, §19). */
  maxPerUnit?: number;
  maxTotal?: number;
}

const DEFAULT_MAX_TOTAL = 100_000;

function anchorFromProfile(profile: UnitView["profile"]): { x: number; y: number } | null {
  const raw = profile.anchor;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const x = (raw as { x?: unknown }).x;
  const y = (raw as { y?: unknown }).y;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Local formation offsets for `count` models (rank/file grid or triangle). */
export function formationOffsets(
  count: number,
  formation: string,
  opts: DeployOptions,
): DeployModelPos[] {
  const spacing = opts.spacing ?? 4;
  const out: DeployModelPos[] = [];
  if (formation === "wedge") {
    let row = 0;
    let placed = 0;
    while (placed < count) {
      const inRow = Math.min(count - placed, row + 1);
      for (let i = 0; i < inRow; i++) {
        out.push({ x: 0 - row * spacing, y: (i - (inRow - 1) / 2) * spacing, facing: 0 });
      }
      placed += inRow;
      row++;
    }
    return out;
  }
  const isColumn = formation === "column";
  const width = isColumn ? Math.max(1, opts.rankDepth ?? 4) : Math.max(1, opts.filesPerRank ?? 10);
  for (let i = 0; i < count; i++) {
    const rank = Math.floor(i / width);
    const file = i % width;
    out.push({
      x: 0 - rank * spacing,
      y: (file - (Math.min(count, width) - 1) / 2) * spacing,
      facing: 0,
    });
  }
  return out;
}

/** Pure position plans for the units (no pool, no codec) — testable core. */
export function deployLayout(
  units: readonly UnitView[],
  factions: readonly FactionDocument[],
  opts: DeployOptions = {},
): DeployLayout {
  const laneX = opts.laneX ?? ((k: number) => 150 + k * 300);
  const laneY = opts.laneY ?? ((j: number) => 150 + j * 250);
  const maxPerUnit = opts.maxPerUnit ?? Number.POSITIVE_INFINITY;
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;
  const sortedFactionIds = [...factions].map((f) => f._id).sort();
  const factionIndex = new Map<DocId, number>(sortedFactionIds.map((id, k) => [id, k] as const));
  const unitIndexInFaction = new Map<DocId, number>();
  const plans: DeployUnitPlan[] = [];
  let total = 0;
  for (const unit of units) {
    const count = Math.max(
      0,
      Math.min(Math.floor(unit.stats.strength ?? 0), maxPerUnit, maxTotal - total),
    );
    const j = unitIndexInFaction.get(unit.factionId) ?? 0;
    unitIndexInFaction.set(unit.factionId, j + 1);
    const fallback = { x: laneX(factionIndex.get(unit.factionId) ?? 0), y: laneY(j) };
    const anchor = anchorFromProfile(unit.profile) ?? fallback;
    plans.push({
      unitId: unit.id,
      anchor,
      count,
      formation: unit.formation,
      positions: formationOffsets(count, unit.formation, opts),
    });
    total += count;
  }
  return { plans };
}

/** Full deployment: build the initial pool snapshot + unit model ranges. */
export function deploySnapshot(
  units: readonly UnitView[],
  factions: readonly FactionDocument[],
  sys: SysSchema = {},
  opts: DeployOptions = {},
): {
  bytes: Uint8Array;
  maxHpMax: number;
  ranges: Array<[UnitId, [number, number] | null]>;
} {
  const layout = deployLayout(units, factions, opts);
  const total = layout.plans.reduce((n, p) => n + p.count, 0);
  const pool = createModelPool(Math.max(1024, total), sys);
  const ranges: Array<[UnitId, [number, number] | null]> = [];
  let nextId = 1;
  for (let pi = 0; pi < layout.plans.length; pi++) {
    const plan = layout.plans[pi];
    if (!plan) continue;
    if (plan.count === 0) {
      ranges.push([plan.unitId, null]);
      continue;
    }
    const start = pool.count;
    for (let i = 0; i < plan.count; i++) {
      const pos = plan.positions[i];
      if (!pos) throw new Error("deploy: formation offsets shorter than count");
      allocModel(pool, {
        id: nextId++,
        unitIdx: pi,
        x: plan.anchor.x + pos.x,
        y: plan.anchor.y + pos.y,
        rot: 0,
        hp: 1,
        hpMax: 1,
        status: 0,
        facing: 64,
        sys: sys.ammo !== undefined ? { ammo: 6 } : {},
      });
    }
    ranges.push([plan.unitId, [start, pool.count]]);
  }
  return {
    bytes: encodeSimSnapshot(snapshotFromPool(pool, "", 0, sys), 1),
    maxHpMax: 1,
    ranges,
  };
}
