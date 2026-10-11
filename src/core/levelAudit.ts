/**
 * G-15 (D-433): the floor-play check. One pure audit drives the activation pre-check (errors block,
 * warnings need an explicit "Enable anyway") and the live list in the Draft levels panel. Quick
 * fixes are ordinary undoable op plans; nothing here edits documents by itself.
 */
import type { LevelDocument, RegionDocument, SceneDocument, TokenDocument } from "./documents";
import type { Op } from "./ops";
import { inElevationBand } from "./multilevelGeometry";
import { stairDoor, stairLandingBlocked, stairLocked, stairRegionPolygon, stairSpec, type StairBehaviorV2, type StairEdge } from "./levelPlay";
import { wallEditLocked } from "./wallEditing";
import { floorSolidAt, surfaceOpenings } from "./floorSurface";

export type LevelAuditFix = "walls-all" | "lights-all" | "tokens-by-band" | "merge-stairs";
export interface LevelAuditFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  ids?: string[];
  fix?: LevelAuditFix;
}
type Point = { x: number; y: number };
/** Convex polygons (regions are convex) overlap with positive area: separating-axis test. */
export function convexOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Point, q = poly[(i + 1) % poly.length] as Point;
      const axis = { x: q.y - p.y, y: p.x - q.x };
      const project = (pts: readonly Point[]) => pts.reduce((r, pt) => {
        const d = pt.x * axis.x + pt.y * axis.y;
        return { min: Math.min(r.min, d), max: Math.max(r.max, d) };
      }, { min: Infinity, max: -Infinity });
      const ra = project(a), rb = project(b);
      if (ra.max <= rb.min + 1e-6 || rb.max <= ra.min + 1e-6) return false;
    }
  }
  return true;
}
const centroid = (pts: readonly Point[]): Point => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const names = (levels: readonly LevelDocument[], ids: readonly string[]) => ids.map((id) => levels.find((l) => l._id === id)?.name ?? id).join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sameGeometry = (a: RegionDocument, b: RegionDocument) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && (a.rotation ?? 0) === (b.rotation ?? 0) && JSON.stringify(a.shape) === JSON.stringify(b.shape);

export function levelPlayAudit(scene: SceneDocument): LevelAuditFinding[] {
  const levels = [...(scene.levels ?? [])].sort((a, b) => a.sort - b.sort || a._id.localeCompare(b._id));
  const findings: LevelAuditFinding[] = [];
  if (!levels.length) return [{ code: "no-levels", severity: "error", message: "Save at least one level before enabling floor play." }];
  const walls = scene.walls.filter((w) => w.levelScope === undefined);
  if (walls.length) findings.push({ code: "unassigned-walls", severity: "warning", fix: "walls-all", ids: walls.map((w) => w._id),
    message: `${plural(walls.length, "wall")} ${walls.length === 1 ? "has" : "have"} no floor. In floor play they neither show nor block movement or sight.` });
  const lights = scene.lights.filter((l) => l.levelScope === undefined);
  if (lights.length) findings.push({ code: "unassigned-lights", severity: "warning", fix: "lights-all", ids: lights.map((l) => l._id),
    message: `${plural(lights.length, "light")} ${lights.length === 1 ? "has" : "have"} no floor and will not light any floor.` });
  const floorless = scene.tokens.filter((t) => t.levelId === undefined);
  if (floorless.length) findings.push({ code: "floorless-tokens", severity: "warning", fix: "tokens-by-band", ids: floorless.map((t) => t._id),
    message: `${plural(floorless.length, "token")} ${floorless.length === 1 ? "has" : "have"} no floor. Players cannot see ${floorless.length === 1 ? "it" : "them"} in floor play.` });
  for (const level of levels) if (!(level.tileIds?.length) && level.useSceneBackground !== true)
    findings.push({ code: "floor-without-art", severity: "warning", ids: [level._id], message: `${level.name} has no map art: assign tiles or the scene background.` });
  // G-21 (D-444): an opening in a traced floor with no floor anywhere beneath it.
  for (const level of levels) {
    if (!level.surface) continue;
    const below = levels.filter((l) => l._id !== level._id && l.floorZ < level.floorZ);
    const voids = surfaceOpenings(level.surface).filter((p) => !below.some((l) => floorSolidAt(l, p)));
    if (voids.length) findings.push({ code: "opening-over-void", severity: "warning", ids: [level._id],
      message: `${level.name} has ${plural(voids.length, "opening")} with no floor beneath ${voids.length === 1 ? "it" : "them"}.` });
  }
  const assigned = new Set(levels.flatMap((l) => l.tileIds ?? []));
  const loose = scene.tiles.filter((t) => !t.hidden && !assigned.has(t._id));
  if (loose.length && assigned.size) findings.push({ code: "unassigned-tiles", severity: "info", ids: loose.map((t) => t._id),
    message: `${plural(loose.length, "visible tile")} ${loose.length === 1 ? "is" : "are"} on no floor and will not be drawn in floor play.` });
  const stairs = (scene.regions ?? []).filter((r) => r.stairs);
  if (!stairs.length) {
    if (levels.length > 1) findings.push({ code: "no-stairs", severity: "info", message: "No stairs yet: players cannot change floors on their own (the GM still can)." });
    return findings;
  }
  const edges: StairEdge[] = stairs.flatMap((r) => r.stairs ? stairSpec(r.stairs).edges : []);
  const reachable = new Set(edges.map((e) => e.to));
  for (const level of levels) if (levels.length > 1 && !reachable.has(level._id) && !edges.some((e) => e.from === level._id))
    findings.push({ code: "isolated-floor", severity: "info", ids: [level._id], message: `No stairs connect ${level.name}.` });
  for (const region of stairs) {
    const spec = stairSpec(region.stairs as NonNullable<RegionDocument["stairs"]>);
    const polygon = stairRegionPolygon(region);
    const label = spec.label ?? region.name;
    if (!polygon) { findings.push({ code: "stairs-geometry", severity: "error", ids: [region._id], message: `Stairs ${label} have invalid geometry.` }); continue; }
    const missing = spec.edges.filter((e) => !edges.some((r) => r.from === e.to && r.to === e.from));
    if (missing.length) findings.push({ code: "one-way-stairs", severity: "info", ids: [region._id],
      message: `Stairs ${label}: no way back from ${names(levels, [...new Set(missing.map((e) => e.to))])}.` });
    const blocked = [...new Set(spec.edges.map((e) => e.to))].filter((levelId) => {
      const at = spec.arrivals.find((a) => a.levelId === levelId) ?? centroid(polygon);
      return stairLandingBlocked(scene, levelId, at);
    });
    if (blocked.length) findings.push({ code: "landing-blocked", severity: "warning", ids: [region._id],
      message: `Stairs ${label}: the landing on ${names(levels, blocked)} is inside a wall; arrivals there will be refused.` });
    const door = stairDoor(scene, spec);
    if (spec.door && !door) findings.push({ code: "stairs-door-missing", severity: "warning", ids: [region._id],
      message: `Stairs ${label} are linked to a door that no longer exists or is no longer a door; they ignore it until you link another.` });
    if (stairLocked(scene, spec)) findings.push({ code: "stairs-locked", severity: "info", ids: [region._id],
      message: spec.locked ? `Stairs ${label} are locked.` : `Stairs ${label} are locked until their door opens.` });
  }
  const seen = new Set<string>();
  for (const a of stairs) for (const b of stairs) {
    if (a._id >= b._id || seen.has(`${a._id}|${b._id}`)) continue;
    const pa = stairRegionPolygon(a), pb = stairRegionPolygon(b);
    const sa = stairSpec(a.stairs as NonNullable<RegionDocument["stairs"]>), sb = stairSpec(b.stairs as NonNullable<RegionDocument["stairs"]>);
    const shared = sa.levels.filter((id) => sb.levels.includes(id) && sa.edges.some((e) => e.from === id) && sb.edges.some((e) => e.from === id));
    if (!pa || !pb || !shared.length || !convexOverlap(pa, pb)) continue;
    seen.add(`${a._id}|${b._id}`);
    const mergeable = sa.legacy && sb.legacy && sameGeometry(a, b);
    findings.push({ code: "overlapping-stairs", severity: "info", ids: [a._id, b._id], ...(mergeable ? { fix: "merge-stairs" as const } : {}),
      message: `Stairs ${sa.label ?? a.name} and ${sb.label ?? b.name} overlap on ${names(levels, shared)}: players there are asked to choose a floor.${mergeable ? " Merge them into one stairwell to edit them together." : ""}` });
  }
  return findings;
}

/** Band containing the token's feet, else the lowest floor (the same rule as G-07 creation). */
function floorForToken(levels: readonly LevelDocument[], token: TokenDocument): LevelDocument | undefined {
  const z = Number.isFinite(token.elevation) ? token.elevation ?? 0 : 0;
  return levels.find((l) => inElevationBand(l, z)) ?? [...levels].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity) || a.sort - b.sort)[0];
}
/** Undoable op plan for one quick fix. Locked and prefab walls are left for the GM to decide. */
export function levelAuditFixOps(scene: SceneDocument, fix: LevelAuditFix): Op[] {
  const parent = { coll: "scenes" as const, id: scene._id };
  const levels = scene.levels ?? [];
  if (fix === "walls-all") return scene.walls.filter((w) => w.levelScope === undefined && w.flags.prefab === undefined && !wallEditLocked(w))
    .map((w): Op => ({ kind: "update", ref: { coll: "walls", id: w._id, parent }, diff: { levelScope: { mode: "all" } } }));
  if (fix === "lights-all") return scene.lights.filter((l) => l.levelScope === undefined && l.flags.prefab === undefined)
    .map((l): Op => ({ kind: "update", ref: { coll: "lights", id: l._id, parent }, diff: { levelScope: { mode: "all" } } }));
  if (fix === "tokens-by-band") return scene.tokens.filter((t) => t.levelId === undefined).flatMap((t): Op[] => {
    const level = floorForToken(levels, t);
    if (!level) return [];
    const z = Number.isFinite(t.elevation) ? t.elevation ?? 0 : 0;
    return [{ kind: "update", ref: { coll: "tokens", id: t._id, parent }, diff: { levelId: level._id, ...(inElevationBand(level, z) ? {} : { elevation: level.floorZ }) } }];
  });
  // merge-stairs: identical-geometry legacy regions become the first region's version-2 stairwell.
  const legacy = (scene.regions ?? []).filter((r) => r.stairs && stairSpec(r.stairs).legacy);
  const ops: Op[] = [];
  const done = new Set<string>();
  for (const head of legacy) {
    if (done.has(head._id)) continue;
    const group = legacy.filter((r) => !done.has(r._id) && sameGeometry(head, r));
    if (group.length < 2) continue;
    group.forEach((r) => done.add(r._id));
    const edges = group.flatMap((r) => stairSpec(r.stairs as NonNullable<RegionDocument["stairs"]>).edges)
      .filter((e, i, all) => all.findIndex((o) => o.from === e.from && o.to === e.to) === i);
    const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort((a, b) => (levels.find((l) => l._id === a)?.floorZ ?? 0) - (levels.find((l) => l._id === b)?.floorZ ?? 0));
    const all = ids.length * (ids.length - 1) === edges.length;
    const stairs: StairBehaviorV2 = { version: 2, levels: ids, mode: "auto", ...(all ? {} : { edges }) };
    ops.push({ kind: "update", ref: { coll: "regions", id: head._id, parent }, diff: { stairs: stairs as unknown as import("./documents").Json, name: "Stairwell" } });
    for (const r of group.slice(1)) ops.push({ kind: "delete", ref: { coll: "regions", id: r._id, parent } });
  }
  return ops;
}
/** G-13 (D-434): put every unassigned wall and light on one floor (locked/prefab walls excluded). */
export function unscopedToFloorOps(scene: SceneDocument, levelId: string): Op[] {
  if (!scene.levels?.some((l) => l._id === levelId)) return [];
  const parent = { coll: "scenes" as const, id: scene._id };
  const scope = { mode: "levels", ids: [levelId] };
  return [
    ...scene.walls.filter((w) => w.levelScope === undefined && w.flags.prefab === undefined && !wallEditLocked(w))
      .map((w): Op => ({ kind: "update", ref: { coll: "walls", id: w._id, parent }, diff: { levelScope: scope } })),
    ...scene.lights.filter((l) => l.levelScope === undefined && l.flags.prefab === undefined)
      .map((l): Op => ({ kind: "update", ref: { coll: "lights", id: l._id, parent }, diff: { levelScope: scope } })),
  ];
}
