/**
 * §10 Armies tab + Army Management Window — pure data layer.
 *
 * Everything here is environment-free (no Svelte, no DOM): the components
 * consume these helpers, the unit tests drive them directly. Documents come
 * from the local ClientSync replica; model rows read the local ModelPool
 * replica (client.simReplica) when one exists.
 */
import type {
  ArmyDocument,
  FactionDocument,
  ModelPool,
  Order,
  UnitDocument,
  Vec2,
} from "../../core/strategic";
import type { SimEvent, TurnReport } from "../../core/sim";
import type { Op } from "../../core/ops";
import type { DocumentStore } from "../../core/store";
import { collectLeaderActors } from "../../core/rules";
import type {
  RulesContext,
  RulesGridContext,
  RulesWallsContext,
} from "../../core/rules";
import type { WallDocument } from "../../core/documents";
import { worldSettingsFrom } from "../../core/worldSettings";

// ─── Armies tab cards ─────────────────────────────────────────────────────────

export interface ArmyCard {
  id: string;
  name: string;
  factionId: string;
  factionName: string;
  color: string;
  unitCount: number;
  strength: number;
  morale: number;
  supplyLevel: number;
}

export function armyCards(
  armies: readonly ArmyDocument[],
  factions: readonly FactionDocument[],
): ArmyCard[] {
  const byId = new Map(factions.map((f) => [f._id, f] as const));
  return armies.map((army) => {
    const faction = byId.get(army.factionId);
    const strength = army.units.reduce(
      (acc, u) => acc + (u.stats.strength ?? 0),
      0,
    );
    const morale =
      army.units.length === 0
        ? 0
        : army.units.reduce((acc, u) => acc + (u.stats.morale ?? 0), 0) /
          army.units.length;
    return {
      id: army._id,
      name: army.name,
      factionId: army.factionId,
      factionName: faction?.name ?? army.factionId,
      color: faction?.color ?? "#9aa0a8",
      unitCount: army.units.length,
      strength,
      morale: Number(morale.toFixed(1)),
      supplyLevel: Number(army.supply.level ?? 0),
    };
  });
}

// ─── Hierarchy tree (Army → echelons by unit type → Units) ───────────────────

export type TreeRow =
  | { kind: "army"; depth: 0; army: ArmyDocument }
  | {
      kind: "echelon";
      depth: 1;
      armyId: string;
      type: string;
      count: number;
      strength: number;
    }
  | { kind: "unit"; depth: 2; armyId: string; unit: UnitDocument };

/**
 * Flatten the §10 hierarchy. Echelons are system-defined; with the §4A flat
 * army.units list the echelon level groups by unit `type` (the system's
 * order of battle), which mass-battle-basic defines in schema.unitTypes.
 */
export function flattenTree(army: ArmyDocument): TreeRow[] {
  const rows: TreeRow[] = [{ kind: "army", depth: 0, army }];
  const groups = new Map<string, UnitDocument[]>();
  for (const unit of army.units) {
    const list = groups.get(unit.type);
    if (list) list.push(unit);
    else groups.set(unit.type, [unit]);
  }
  const types = [...groups.keys()].sort();
  for (const type of types) {
    const units = groups.get(type) ?? [];
    rows.push({
      kind: "echelon",
      depth: 1,
      armyId: army._id,
      type,
      count: units.length,
      strength: units.reduce((acc, u) => acc + (u.stats.strength ?? 0), 0),
    });
    for (const unit of units)
      rows.push({ kind: "unit", depth: 2, armyId: army._id, unit });
  }
  return rows;
}

/**
 * Drag-and-drop reorganisation (§10: "emits Ops"): moving a Unit between
 * armies = delete from the old embedded list + create under the new parent.
 * Model ranges are scene-pool indices, not army state, so they carry over.
 */
export function moveUnitOps(
  unit: UnitDocument,
  fromArmyId: string,
  toArmyId: string,
): Op[] {
  if (fromArmyId === toArmyId) return [];
  return [
    {
      kind: "delete",
      ref: {
        coll: "units",
        id: unit._id,
        parent: { coll: "armies", id: fromArmyId },
      },
    },
    {
      kind: "create",
      coll: "units",
      parent: { coll: "armies", id: toArmyId },
      data: unit,
    },
  ];
}

// ─── Roster grid ──────────────────────────────────────────────────────────────

export type RosterRow =
  | {
      kind: "unit";
      key: string;
      unit: UnitDocument;
      /** Live strength from the replica pool (null without a replica). */
      liveStrength: number | null;
    }
  | {
      kind: "model";
      key: string;
      unitId: string;
      index: number;
      modelId: number;
      x: number;
      y: number;
      hp: number;
      hpMax: number;
      status: number;
    }
  | { kind: "modelGap"; key: string; unitId: string; hidden: number };

/**
 * Rows for the roster grid: one per Unit; expanded units append their model
 * rows read from the local replica (hidden slots of a projected replica are
 * collapsed into a single gap row — their positions are zeroed).
 */
export function rosterRows(
  army: ArmyDocument,
  replica: ModelPool | null,
  expanded: ReadonlySet<string>,
): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const unit of army.units) {
    let live: number | null = null;
    if (replica && unit.modelRange) {
      const [start, end] = unit.modelRange;
      let alive = 0;
      for (let i = start; i < Math.min(end, replica.count); i++) {
        const status = replica.status[i] ?? 0;
        if ((status & (1 << 0)) !== 0 || (status & (1 << 4)) !== 0) continue; // dead | hidden
        if ((replica.hp[i] ?? 0) > 0) alive++;
      }
      live = alive;
    }
    rows.push({ kind: "unit", key: unit._id, unit, liveStrength: live });
    if (!expanded.has(unit._id) || !replica || !unit.modelRange) continue;
    const [start, end] = unit.modelRange;
    let hidden = 0;
    for (let i = start; i < Math.min(end, replica.count); i++) {
      const status = replica.status[i] ?? 0;
      if ((status & (1 << 4)) !== 0) {
        hidden++;
        continue;
      }
      rows.push({
        kind: "model",
        key: `${unit._id}#${i}`,
        unitId: unit._id,
        index: i,
        modelId: replica.id[i] ?? 0,
        x: replica.x[i] ?? 0,
        y: replica.y[i] ?? 0,
        hp: replica.hp[i] ?? 0,
        hpMax: replica.hpMax[i] ?? 0,
        status,
      });
    }
    if (hidden > 0)
      rows.push({
        kind: "modelGap",
        key: `${unit._id}#gap`,
        unitId: unit._id,
        hidden,
      });
  }
  return rows;
}

/** Virtualization math (fixed row height): which slice to render, and pads. */
export function windowRows(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): { start: number; end: number; padTop: number; padBottom: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(total, first + visible);
  return {
    start: first,
    end,
    padTop: first * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}

export type SortKey = "name" | "type" | "strength" | "morale";

/** Sorts a UNIT list (composes with filterRoster, which returns units). */
export function sortRoster(
  units: readonly UnitDocument[],
  key: SortKey,
  dir: 1 | -1,
): UnitDocument[] {
  const compare = (a: UnitDocument, b: UnitDocument): number => {
    if (key === "name") return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    if (key === "type") return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
    return (a.stats[key] ?? 0) - (b.stats[key] ?? 0);
  };
  return [...units].sort((a, b) => compare(a, b) * dir);
}

export function filterRoster(
  army: ArmyDocument,
  query: string,
): UnitDocument[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...army.units];
  return army.units.filter(
    (u) => u.name.toLowerCase().includes(q) || u.type.toLowerCase().includes(q),
  );
}

// ─── Order templates (§10 order editor) ───────────────────────────────────────

export interface OrderTemplate {
  id: "advance" | "screen" | "fallBack";
  label: string;
  /** Build the order relative to the unit's anchor + facing. */
  build(anchor: Vec2, facingDeg: number): Order;
}

export const ORDER_TEMPLATES: readonly OrderTemplate[] = [
  {
    id: "advance",
    label: "Advance",
    build(anchor, facingDeg) {
      const rad = (facingDeg * Math.PI) / 180;
      const to = {
        x: +(anchor.x + Math.cos(rad) * 12).toFixed(3),
        y: +(anchor.y + Math.sin(rad) * 12).toFixed(3),
      };
      return { kind: "move", path: [to], pace: "march" };
    },
  },
  {
    id: "screen",
    label: "Screen",
    build() {
      return { kind: "hold", stance: "screen" };
    },
  },
  {
    id: "fallBack",
    label: "Fall back",
    build(anchor, facingDeg) {
      const rad = (facingDeg * Math.PI) / 180;
      const to = {
        x: +(anchor.x - Math.cos(rad) * 12).toFixed(3),
        y: +(anchor.y - Math.sin(rad) * 12).toFixed(3),
      };
      return { kind: "retreat", toward: to };
    },
  },
];

// ─── Reports tab ──────────────────────────────────────────────────────────────

export interface ReportFilter {
  unitId?: string;
  type?: string;
}

export function filterReportEvents(
  report: TurnReport,
  filter: ReportFilter,
): SimEvent[] {
  return report.events.filter((e: SimEvent) => {
    if (
      filter.unitId &&
      e.unitId !== filter.unitId &&
      e.targetUnitId !== filter.unitId
    )
      return false;
    if (filter.type && e.type !== filter.type) return false;
    return true;
  });
}

export function casualtySummary(events: readonly SimEvent[]): {
  casualties: number;
  routed: number;
  attacks: number;
} {
  let casualties = 0;
  let routed = 0;
  let attacks = 0;
  for (const e of events) {
    if (e.type === "casualty") casualties += Number(e.data?.count ?? 1);
    else if (e.type === "rout") routed++;
    else if (e.type === "attack") attacks++;
  }
  return { casualties, routed, attacks };
}

/** CSV export (§10 reports tab): one line per event, RFC-4180 quoting. */
export function eventsToCsv(events: readonly SimEvent[]): string {
  const cell = (v: unknown): string => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["turn,subPhase,type,unitId,targetUnitId,text"];
  for (const e of events) {
    lines.push(
      [e.subPhase, e.type, e.unitId, e.targetUnitId ?? "", e.text]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ─── Client-side RulesContext (validateOrder feedback + forecast, §10/§12) ────

type AnyStore = Pick<DocumentStore, "get" | "getAll">;

/**
 * Build a §12 RulesContext from the local replica store (client-side
 * validation + forecast). Mirrors the host TurnChannel.rulesCtx convention.
 */
export function rulesContextFromStore(
  store: AnyStore,
  sceneId: string | null,
  worldSettings?: Record<string, unknown> | undefined,
): RulesContext {
  const scene = sceneId ? store.get("scenes", sceneId) : null;
  const gridDoc = scene?.grid;
  const wallDocs = scene?.walls ?? [];
  const n = wallDocs.length;
  const walls: RulesWallsContext = {
    x1: new Float32Array(n),
    y1: new Float32Array(n),
    x2: new Float32Array(n),
    y2: new Float32Array(n),
    restriction: new Uint8Array(n),
  };
  wallDocs.forEach((wall: WallDocument, i: number) => {
    const c = wall?.c ?? [0, 0, 0, 0];
    walls.x1[i] = c[0] ?? 0;
    walls.y1[i] = c[1] ?? 0;
    walls.x2[i] = c[2] ?? 0;
    walls.y2[i] = c[3] ?? 0;
    walls.restriction[i] =
      ((wall?.move ?? 0) > 0 ? 1 : 0) |
      ((wall?.sight ?? 0) > 0 ? 2 : 0) |
      ((wall?.sound ?? 0) > 0 ? 4 : 0) |
      ((wall?.light ?? 0) > 0 ? 8 : 0);
  });
  const grid: RulesGridContext = {
    type: gridDoc?.type ?? "square",
    size: gridDoc?.size ?? 100,
    distance: gridDoc?.distance ?? 5,
    units: gridDoc?.units ?? "ft",
    diagonals: gridDoc?.diagonals ?? "555",
  };
  return {
    sceneId,
    grid,
    walls,
    factions: store.getAll("factions") as FactionDocument[],
    armies: store.getAll("armies") as ArmyDocument[],
    // M07: same convention as the host TurnChannel — leader actors keyed by unit id.
    leaderActors: collectLeaderActors({
      units: (store.getAll("armies") as ArmyDocument[]).flatMap((a) =>
        a.units.map((u) => ({
          id: u._id,
          leaderTokenId: u.leaderTokenId ?? null,
        })),
      ),
      tokens: scene?.tokens,
      getActor: (actorId) =>
        store.get("actors", actorId) as unknown as
          import("../../core/documents").Json | undefined,
    }),
    // Absent means "read the world": the replicated settings doc is the authority (D-113), and an
    // explicit argument only overrides it for callers that are simulating a context (tests, e2e).
    worldSettings: (worldSettings ??
      worldSettingsFrom(store.getAll("settings"))) as Record<string, never>,
  };
}
