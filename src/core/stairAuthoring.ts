/**
 * G-14 (D-450): authoring stairwells — drawing one on the map and editing one in place.
 *
 * A stairwell dragged out with the Stairs tool joins the floor the GM is looking at and the next
 * floor up (from the top floor: the next one down), travels at once both ways, and is named after
 * its floors. The GM then renames, retargets, re-directs or resizes it in place.
 */
import type { LevelDocument, RegionDocument, SceneDocument } from "./documents";
import type { StairBehaviorV2, StairEdge } from "./levelPlay";

export type StairDirections = "both" | "up" | "down";
export interface StairArea { x: number; y: number; width: number; height: number }

const UNIT_SQUARE: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Floors bottom to top, as the editors list them. */
export function floorsBottomUp(scene: Pick<SceneDocument, "levels">): LevelDocument[] {
  return [...(scene.levels ?? [])].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || a._id.localeCompare(b._id));
}

/** One-way moves between the chosen floors ("both" needs none). */
export function stairEdgesFor(ids: readonly string[], directions: StairDirections, floorZ: (id: string) => number): StairEdge[] | undefined {
  if (directions === "both") return undefined;
  return ids.flatMap((from) => ids.filter((to) => to !== from && (directions === "up" ? floorZ(to) > floorZ(from) : floorZ(to) < floorZ(from))).map((to) => ({ from, to })));
}

/** How a stairwell's moves read in the editor; "custom" when no single direction describes them. */
export function stairDirectionsOf(stairs: Pick<StairBehaviorV2, "levels" | "edges">, floorZ: (id: string) => number): StairDirections | "custom" {
  if (!stairs.edges) return "both";
  const key = (edges: readonly StairEdge[]) => edges.map((e) => `${e.from}\u0000${e.to}`).sort().join("\u0001");
  const have = key(stairs.edges);
  for (const directions of ["up", "down"] as const) if (key(stairEdgesFor(stairs.levels, directions, floorZ) ?? []) === have) return directions;
  return have === key(stairEdgesFor(stairs.levels, "up", floorZ)?.concat(stairEdgesFor(stairs.levels, "down", floorZ) ?? []) ?? []) ? "both" : "custom";
}

/** The stairwell the Stairs tool makes from a dragged rectangle, or why it cannot. */
export function drawnStairwell(scene: Pick<SceneDocument, "levels">, area: StairArea, options: { id: string; levelId?: string | null | undefined }): RegionDocument | string {
  const floors = floorsBottomUp(scene);
  if (floors.length < 2) return "Stairs join floors: add at least two floors to this scene first (Scenes → Draft levels).";
  if (![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width < 1 || area.height < 1) return "Drag a larger area for the stairs.";
  const at = Math.max(0, floors.findIndex((f) => f._id === options.levelId));
  const here = floors[at] as LevelDocument;
  const other = (floors[at + 1] ?? floors[at - 1]) as LevelDocument;
  const [lower, upper] = here.floorZ <= other.floorZ ? [here, other] : [other, here];
  const x = Math.round(area.x), y = Math.round(area.y);
  return {
    _id: options.id, type: "region", name: `Stairs ${lower.name} ↔ ${upper.name}`.slice(0, 128), ownership: { default: 0 }, flags: {}, system: {}, hidden: true,
    x, y, width: Math.max(1, Math.round(area.x + area.width) - x), height: Math.max(1, Math.round(area.y + area.height) - y), rotation: 0,
    shape: { kind: "polygon", points: UNIT_SQUARE.map(([px, py]) => [px, py] as [number, number]) },
    stairs: { version: 2, levels: [lower._id, upper._id], mode: "auto" },
  };
}

export interface StairEdit {
  name: string;
  /** Shown to players in the stair chooser; empty removes it. */
  label: string;
  levels: string[];
  directions: StairDirections | "custom";
  area: StairArea;
}

/** The region update for an in-place edit (rename, retarget, re-direct, move/resize), or why it is refused. */
export function stairEditDiff(region: RegionDocument, scene: Pick<SceneDocument, "levels">, edit: StairEdit):
  { name: string; x: number; y: number; width: number; height: number; stairs: StairBehaviorV2 } | string {
  const stairs = region.stairs;
  if (!stairs || !("version" in stairs)) return "Convert these stairs to a stairwell first.";
  const name = edit.name.trim(), label = edit.label.trim();
  if (!name || name.length > 128) return "Stairs need a name of 1–128 characters.";
  if (label.length > 64 || [...label].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return "The label for players takes up to 64 printable characters.";
  const floors = floorsBottomUp(scene);
  const ids = floors.map((f) => f._id).filter((id) => edit.levels.includes(id));
  if (ids.length < 2) return "Choose at least two floors.";
  if (ids.length > 8) return "A stairwell connects at most 8 floors.";
  const { x, y, width, height } = edit.area;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return "The stairs need a positive width and height.";
  const floorZ = (id: string) => floors.find((f) => f._id === id)?.floorZ ?? 0;
  let edges: StairEdge[] | undefined;
  if (edit.directions === "custom") {
    edges = stairs.edges?.filter((e) => ids.includes(e.from) && ids.includes(e.to));
    if (stairs.edges && !edges?.length) return "None of the stairs' one-way moves are left between these floors: choose a direction.";
  } else {
    edges = stairEdgesFor(ids, edit.directions, floorZ);
    if (edges && !edges.length) return "Those floors have no up/down direction between them.";
  }
  const arrivals = stairs.arrivals?.filter((a) => ids.includes(a.levelId));
  const next: StairBehaviorV2 = { ...stairs, levels: ids };
  if (edges) next.edges = edges; else delete next.edges;
  if (arrivals?.length) next.arrivals = arrivals; else delete next.arrivals;
  if (label) next.label = label; else delete next.label;
  return { name, x, y, width, height, stairs: next };
}
