/**
 * §5A strategic projection: per-faction visibility of pools, deltas and
 * TurnReports. GM receives everything (no filtering). Filtering is
 * index-based and computed once per faction per delta, never per user.
 */
import type { FactionDocument, ModelPool } from "../core/strategic";
import type { DocId } from "../core/ids";
import type { SimDelta, SimEvent, TurnReport } from "../core/sim";
import type { SysSchema } from "../sim/pool";
import { projectSimDelta } from "../sim/codec";
import type { DetectionGrid } from "../core/detection";

/** factionId → allies (shared vision) from the factions collection. */
export function alliesOf(factions: readonly FactionDocument[]): Map<DocId, DocId[]> {
  const map = new Map<DocId, DocId[]>();
  for (const f of factions) {
    map.set(
      f._id,
      f.allies.filter((a): a is DocId => typeof a === "string"),
    );
  }
  return map;
}

/** Which of the pool's models may `factionId` (plus allies) observe? */
export function factionVisibility(
  grid: DetectionGrid,
  pool: ModelPool,
  factions: readonly FactionDocument[],
  factionId: DocId,
): Uint8Array {
  const allies = alliesOf(factions).get(factionId) ?? [];
  return grid.visibleModels(pool, factionId, allies);
}

/** Project a decoded SimDelta to one faction's visible indices. */
export function projectDeltaForFaction(
  delta: SimDelta,
  visible: Uint8Array,
  sys: SysSchema,
): SimDelta {
  return projectSimDelta(delta, (i) => (visible[i] ?? 0) !== 0, sys);
}

/** UnitId → factionId map from UnitViews (host side). */
export function unitFactions(
  units: ReadonlyArray<{ id: DocId; factionId: DocId }>,
): Map<DocId, DocId> {
  return new Map(units.map((u) => [u.id, u.factionId]));
}

/**
 * Is `unitId` detected by `factionId`? A unit is visible when any of its
 * live models stands in a cell the faction (or allies) detect.
 */
export function makeUnitVisibility(
  grid: DetectionGrid,
  pool: ModelPool,
  units: ReadonlyArray<{
    id: DocId;
    factionId: DocId;
    modelRange: readonly [number, number] | null;
  }>,
  factions: readonly FactionDocument[],
  factionId: DocId,
): (unitId: DocId) => boolean {
  const allies = alliesOf(factions).get(factionId) ?? [];
  const who = [factionId, ...allies];
  const cache = new Map<DocId, boolean>();
  return (unitId: DocId): boolean => {
    const hit = cache.get(unitId);
    if (hit !== undefined) return hit;
    const unit = units.find((u) => u.id === unitId);
    let visible = false;
    if (unit) {
      const [s, e] = unit.modelRange ?? [0, 0];
      for (let i = s; i < e && i < pool.count; i++) {
        if (grid.detectedAt(pool.x[i] ?? 0, pool.y[i] ?? 0, who)) {
          visible = true;
          break;
        }
      }
    }
    cache.set(unitId, visible);
    return visible;
  };
}

/**
 * Project a TurnReport: events whose subject (or target) is undetected are
 * replaced by "unknown enemy" stubs; detected-subject events with hidden
 * targets keep the subject but drop target references (§5A).
 */
export function projectReportForFaction(
  report: TurnReport,
  isVisible: (unitId: DocId) => boolean,
): TurnReport {
  const events = report.events.map((e) => {
    const subjectVisible = e.unitId !== "" && isVisible(e.unitId);
    const targetVisible = !e.targetUnitId || e.targetUnitId === "" || isVisible(e.targetUnitId);
    if (!subjectVisible) {
      return {
        subPhase: e.subPhase,
        type: "unknown",
        unitId: "",
        text: "unknown enemy activity",
      };
    }
    if (!targetVisible) {
      const scrubbed: SimEvent = {
        ...e,
        text: e.text.replace(/\s\S+$/, " an unknown enemy"),
      };
      delete scrubbed.targetUnitId;
      delete scrubbed.modelIndices;
      return scrubbed;
    }
    return e;
  });
  return { ...report, events };
}

/**
 * §5A: which factions does a user command or observe? Faction ownership
 * level ≥ OBSERVER grants observe; army.commander membership grants command
 * of that army's faction. GM handled by the caller (receives everything).
 */
export function userFactions(
  userId: string,
  factions: readonly FactionDocument[],
  armies: ReadonlyArray<{ factionId: DocId; commander: readonly string[] }>,
): DocId[] {
  const out = new Set<DocId>();
  for (const f of factions) {
    const level = f.ownership[userId] ?? f.ownership.default;
    if (level >= 2) out.add(f._id); // OBSERVER or OWNER
  }
  for (const a of armies) {
    if (a.commander.includes(userId)) out.add(a.factionId);
  }
  return [...out];
}
