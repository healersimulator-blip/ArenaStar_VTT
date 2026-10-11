/**
 * G-21 (D-444): solid floors with openings.
 *
 * A floor's `surface` says where its plane (at `floorZ`) is solid. Elsewhere it is open:
 * stairwells, holes, a courtyard, the air beside a tower top. A floor without a surface is solid
 * everywhere, which is how every floor behaved before. The surface is the *physical* floor: what
 * blocks sight and light between floors (G-20, G-22) and what holds a token up (G-23). Art
 * transparency alone decides what is *drawn* through it (G-19).
 *
 * A surface is usually traced from the floor's own map art: the opaque pixels are solid. Tracing
 * samples the art on a grid and repairs diagonal-only contacts so every ring is simple. It walks
 * the rectilinear boundaries and coarsens the grid until the result fits the vertex budget. The
 * result is always a valid `RegionShapeV2`, or nothing.
 */
import type { LevelDocument, LevelSurface, SceneDocument, TileDocument } from "./documents";
import { regionShapeV2Error, shapeContains, type RegionShapeV2, type SpatialPoint } from "./multilevelGeometry";
import type { RoofArtMask } from "./roofs";
import type { SpatialSurface } from "./spatial/kernel";

export type { LevelSurface };

/** Per-floor vertex budget: 32 floors × 128 stays inside the spatial kernel's 4,096 vertices. */
export const SURFACE_MAX_VERTICES = 128;
const BOUND = 1_000_000;

export function levelSurfaceError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Floor surface must be an object";
  const s = value as Partial<LevelSurface>;
  const keys = Object.keys(s);
  if (keys.some((k) => !["x", "y", "width", "height", "footprint", "source"].includes(k))) return "Floor surface accepts only x, y, width, height, footprint and source";
  if (![s.x, s.y].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= BOUND)) return "Floor surface position must be finite";
  if (![s.width, s.height].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= BOUND)) return "Floor surface size must be between 1 and 1,000,000";
  if (s.source !== undefined && s.source !== "art" && s.source !== "drawn") return "Floor surface source must be art or drawn";
  const shape = regionShapeV2Error(s.footprint);
  if (shape) return `Floor surface: ${shape}`;
  const vertices = (s.footprint as RegionShapeV2).components.reduce((n, c) => n + c.outer.length + c.holes.reduce((m, h) => m + h.length, 0), 0);
  if (vertices > SURFACE_MAX_VERTICES) return `Floor surface exceeds ${SURFACE_MAX_VERTICES} vertices`;
  return null;
}

/** Is the floor solid at this scene point? Without a surface, a floor is solid everywhere. */
export function floorSolidAt(level: Pick<LevelDocument, "surface">, point: SpatialPoint): boolean {
  const s = level.surface;
  if (!s) return true;
  return shapeContains(s.footprint, { x: (point.x - s.x) / s.width, y: (point.y - s.y) / s.height });
}

/** Floor planes for the spatial kernel: one surface per floor, solid everywhere unless traced. */
export function floorSurfaces(scene: Pick<SceneDocument, "levels" | "width" | "height">): SpatialSurface[] {
  const whole: RegionShapeV2 = { version: 2, components: [{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], holes: [] }] };
  // "Everywhere" reaches well past the scene edges, so nothing sees around a floor.
  const pad = Math.max(scene.width, scene.height, 1);
  return (scene.levels ?? []).filter((l) => Number.isFinite(l.floorZ)).map((l) => ({
    id: `floor:${l._id}`,
    footprint: l.surface?.footprint ?? whole,
    transform: l.surface ? { x: l.surface.x, y: l.surface.y, width: l.surface.width, height: l.surface.height, rotation: 0 }
      : { x: -pad, y: -pad, width: scene.width + 2 * pad, height: scene.height + 2 * pad, rotation: 0 },
    planes: [{ z: l.floorZ, blocks: ["move", "sight", "light", "sound"], supportsMovement: true }],
  }));
}

/** Solid where any of the floor's tiles is opaque. Unreadable art counts as solid over its rectangle. */
export function artSampler(tiles: readonly TileDocument[], mask: (tile: TileDocument) => RoofArtMask | null): (x: number, y: number) => boolean {
  const views = tiles.filter((t) => t.width > 0 && t.height > 0).map((t) => {
    const a = -(t.rotation ?? 0) * Math.PI / 180;
    return { t, cos: Math.cos(a), sin: Math.sin(a), cx: t.x + t.width / 2, cy: t.y + t.height / 2, m: mask(t) };
  });
  return (x, y) => views.some(({ t, cos, sin, cx, cy, m }) => {
    const dx = x - cx, dy = y - cy;
    const u = (dx * cos - dy * sin) / t.width + 0.5, v = (dx * sin + dy * cos) / t.height + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false;
    if (!m) return true;
    return m.opaque[Math.floor(v * m.height) * m.width + Math.floor(u * m.width)] === 1;
  });
}

/** Mask resolution for floor tracing: finer than a roof's, since openings can be a cell wide. */
export const FLOOR_ART_MAX_SIDE = 256;

/**
 * Trace a floor from its own art: its map tiles and, if it uses it, the scene background (taken as
 * opaque over the scene). The first grid is a quarter grid cell.
 */
export function traceLevelArt(scene: Pick<SceneDocument, "tiles" | "width" | "height" | "grid">, level: Pick<LevelDocument, "tileIds" | "useSceneBackground">,
  mask: (tile: TileDocument) => RoofArtMask | null, options: { maxVertices?: number } = {}): TraceResult {
  const own = new Set(level.tileIds ?? []);
  const tiles = scene.tiles.filter((t) => own.has(t._id));
  const background = level.useSceneBackground === true ? [{ ...(tiles[0] ?? {}), _id: ":background", x: 0, y: 0, width: scene.width, height: scene.height, rotation: 0 } as TileDocument] : [];
  const art = [...tiles, ...background];
  if (!art.length) return { surface: null, cell: 0, components: 0, openings: 0, notes: ["This floor has no map art to trace"] };
  // Axis-aligned bounds of the (rotated) art.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of art) {
    const a = (t.rotation ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const hw = (t.width * c + t.height * s) / 2, hh = (t.width * s + t.height * c) / 2, cx = t.x + t.width / 2, cy = t.y + t.height / 2;
    minX = Math.min(minX, cx - hw); minY = Math.min(minY, cy - hh); maxX = Math.max(maxX, cx + hw); maxY = Math.max(maxY, cy + hh);
  }
  const clampBox = (n: number) => Math.max(-BOUND / 2, Math.min(BOUND / 2, n));
  const box = { x: clampBox(minX), y: clampBox(minY), width: clampBox(maxX) - clampBox(minX), height: clampBox(maxY) - clampBox(minY) };
  const size = Number.isFinite(scene.grid?.size) && scene.grid.size > 0 ? scene.grid.size : 100;
  return traceSurface(artSampler(art, (t) => (t._id === ":background" ? null : mask(t))), box,
    { cell: Math.max(2, size / 4), ...(options.maxVertices !== undefined ? { maxVertices: options.maxVertices } : {}) });
}

/** One point inside each opening (hole), in scene pixels. */
export function surfaceOpenings(surface: LevelSurface): SpatialPoint[] {
  return surface.footprint.components.flatMap((c) => c.holes).map((ring) => {
    // Just off the middle of the first edge, on the hole's inner side (its winding says which).
    const a = ring[0] as SpatialPoint, b = ring[1] as SpatialPoint, len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const side = signedArea(ring) > 0 ? 1 : -1, eps = 1e-4;
    const p = { x: (a.x + b.x) / 2 - side * (b.y - a.y) / len * eps, y: (a.y + b.y) / 2 + side * (b.x - a.x) / len * eps };
    return { x: surface.x + p.x * surface.width, y: surface.y + p.y * surface.height };
  });
}

/** SVG path data (scene pixels, even-odd) for a surface preview. */
export function surfaceSvgPath(surface: LevelSurface): string {
  const ring = (points: readonly SpatialPoint[]) => points.map((p, i) => `${i ? "L" : "M"}${round(surface.x + p.x * surface.width)} ${round(surface.y + p.y * surface.height)}`).join("") + "Z";
  return surface.footprint.components.map((c) => [c.outer, ...c.holes].map(ring).join("")).join("");
}

/** "2 solid areas · 3 openings" */
export function surfaceSummary(surface: LevelSurface | undefined): string {
  if (!surface) return "Solid everywhere";
  const areas = surface.footprint.components.length, openings = surface.footprint.components.reduce((n, c) => n + c.holes.length, 0);
  return `${areas} solid area${areas === 1 ? "" : "s"} · ${openings} opening${openings === 1 ? "" : "s"}`;
}

export interface TraceResult {
  surface: LevelSurface | null;
  /** The grid cell finally used, in scene pixels. */
  cell: number;
  components: number;
  openings: number;
  notes: string[];
}

/**
 * Trace the solid area of `solid(x, y)` inside `box`. `cell` is the first sampling size; it grows
 * until the shape fits the budget (16 areas, 16 openings each, `maxVertices`).
 */
export function traceSurface(solid: (x: number, y: number) => boolean, box: { x: number; y: number; width: number; height: number },
  options: { cell: number; maxVertices?: number; maxCells?: number }): TraceResult {
  const maxVertices = Math.max(4, Math.min(512, options.maxVertices ?? SURFACE_MAX_VERTICES));
  const notes: string[] = [];
  if (![box.x, box.y, box.width, box.height, options.cell].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || options.cell <= 0)
    return { surface: null, cell: options.cell, components: 0, openings: 0, notes: ["Nothing to trace"] };
  const maxCells = options.maxCells ?? 200;
  let cell = Math.max(options.cell, box.width / maxCells, box.height / maxCells);
  for (let attempt = 0; attempt < 12; attempt++, cell *= 1.5) {
    const cols = Math.max(1, Math.ceil(box.width / cell)), rows = Math.max(1, Math.ceil(box.height / cell));
    const grid = sampleGrid(solid, box, cell, cols, rows);
    if (!grid.some(Boolean)) return { surface: null, cell, components: 0, openings: 0, notes: ["No opaque art to trace"] };
    if (!clean(grid, cols + 2, rows + 2)) continue;
    const rings = boundaries(grid, cols + 2, rows + 2);
    const built = assemble(rings);
    // Over the area/opening limits: keep the largest, report the rest.
    const dropped = { areas: Math.max(0, built.length - 16), openings: 0 };
    const kept = built.sort((a, b) => b.area - a.area).slice(0, 16).map((c) => {
      dropped.openings += Math.max(0, c.holes.length - 16);
      return { ...c, holes: c.holes.sort((a, b) => b.area - a.area).slice(0, 16) };
    });
    const vertices = kept.reduce((n, c) => n + c.outer.length + c.holes.reduce((m, h) => m + h.ring.length, 0), 0);
    if (vertices > maxVertices) continue;
    // Normalize to the padded grid box: the empty border keeps every vertex strictly inside.
    const sx = box.x - cell, sy = box.y - cell, width = (cols + 2) * cell, height = (rows + 2) * cell;
    const norm = (p: SpatialPoint) => ({ x: round(p.x / (cols + 2)), y: round(p.y / (rows + 2)) });
    const footprint: RegionShapeV2 = { version: 2, components: kept.map((c) => ({ outer: c.outer.map(norm), holes: c.holes.map((h) => h.ring.map(norm)) })) };
    if (regionShapeV2Error(footprint)) continue; // never expected; a coarser grid is the safe answer
    if (dropped.areas) notes.push(`${dropped.areas} small separate area${dropped.areas === 1 ? " was" : "s were"} left out (16 at most).`);
    if (dropped.openings) notes.push(`${dropped.openings} small opening${dropped.openings === 1 ? " was" : "s were"} filled in (16 per area at most).`);
    return { surface: { x: round(sx), y: round(sy), width: round(width), height: round(height), footprint, source: "art" }, cell: round(cell),
      components: kept.length, openings: kept.reduce((n, c) => n + c.holes.length, 0), notes };
  }
  return { surface: null, cell, components: 0, openings: 0, notes: ["The art is too intricate to trace within the budget"] };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Solid samples at cell centres, with an empty one-cell border. */
function sampleGrid(solid: (x: number, y: number) => boolean, box: { x: number; y: number }, cell: number, cols: number, rows: number): boolean[] {
  const w = cols + 2, grid = new Array<boolean>(w * (rows + 2)).fill(false);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid[(r + 1) * w + c + 1] = solid(box.x + (c + 0.5) * cell, box.y + (r + 0.5) * cell);
  return grid;
}

/**
 * Drop single-cell specks and pinholes, then close diagonal-only contacts so every ring is simple.
 * False when contacts remain after a bounded number of passes; the caller then tries a coarser grid.
 */
function clean(grid: boolean[], w: number, h: number): boolean {
  const at = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h && grid[r * w + c] === true;
  for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
    const n = [at(c - 1, r), at(c + 1, r), at(c, r - 1), at(c, r + 1)];
    if (grid[r * w + c] && n.every((v) => !v)) grid[r * w + c] = false;
    else if (!grid[r * w + c] && n.every(Boolean)) grid[r * w + c] = true;
  }
  // A 2×2 block with only a diagonal pair solid would make a ring touch itself: fill it in.
  let changed = true;
  for (let pass = 0; changed && pass < 32; pass++) {
    changed = false;
    for (let r = 0; r < h - 1; r++) for (let c = 0; c < w - 1; c++) {
      const a = at(c, r), b = at(c + 1, r), d = at(c, r + 1), e = at(c + 1, r + 1);
      if ((a && e && !b && !d) || (b && d && !a && !e)) {
        grid[r * w + c] = grid[r * w + c + 1] = grid[(r + 1) * w + c] = grid[(r + 1) * w + c + 1] = true;
        changed = true;
      }
    }
  }
  return !changed;
}

/** Directed boundary edges (solid on the right in y-down screen space), chained into rings. */
function boundaries(grid: boolean[], w: number, h: number): SpatialPoint[][] {
  const solid = (c: number, r: number) => c >= 0 && r >= 0 && c < w && r < h && grid[r * w + c] === true;
  const next = new Map<number, number>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if (!solid(c, r)) continue;
    if (!solid(c, r - 1)) next.set(key(c, r), key(c + 1, r));
    if (!solid(c + 1, r)) next.set(key(c + 1, r), key(c + 1, r + 1));
    if (!solid(c, r + 1)) next.set(key(c + 1, r + 1), key(c, r + 1));
    if (!solid(c - 1, r)) next.set(key(c, r + 1), key(c, r));
  }
  const rings: SpatialPoint[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: SpatialPoint[] = [];
    for (let k: number | undefined = start; k !== undefined && !seen.has(k); k = next.get(k)) {
      seen.add(k);
      ring.push({ x: k % (w + 1), y: Math.floor(k / (w + 1)) });
    }
    const simple = ring.filter((p, i) => {
      const a = ring[(i + ring.length - 1) % ring.length] as SpatialPoint, b = ring[(i + 1) % ring.length] as SpatialPoint;
      return (b.x - p.x) * (p.y - a.y) !== (b.y - p.y) * (p.x - a.x); // drop collinear vertices
    });
    if (simple.length >= 4) rings.push(simple);
  }
  return rings;
}

function signedArea(ring: readonly SpatialPoint[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as SpatialPoint, b = ring[(i + 1) % ring.length] as SpatialPoint;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
function inside(ring: readonly SpatialPoint[], p: SpatialPoint): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as SpatialPoint, b = ring[j] as SpatialPoint;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** Outer rings run clockwise on screen (positive area); holes go to the smallest outer that holds them. */
function assemble(rings: SpatialPoint[][]): Array<{ outer: SpatialPoint[]; area: number; holes: Array<{ ring: SpatialPoint[]; area: number }> }> {
  const outers = rings.filter((r) => signedArea(r) > 0).map((outer) => ({ outer, area: signedArea(outer), holes: [] as Array<{ ring: SpatialPoint[]; area: number }> }));
  for (const ring of rings.filter((r) => signedArea(r) < 0)) {
    // Probe a quarter cell into the solid beside the hole's first edge (solid lies right of travel):
    // inside the owner, and clear of any island within the hole, which sits a full cell away.
    const a = ring[0] as SpatialPoint, b = ring[1] as SpatialPoint;
    const probe = { x: (a.x + b.x) / 2 - Math.sign(b.y - a.y) * 0.25, y: (a.y + b.y) / 2 + Math.sign(b.x - a.x) * 0.25 };
    const owner = outers.filter((o) => inside(o.outer, probe)).sort((p, q) => p.area - q.area)[0];
    owner?.holes.push({ ring, area: -signedArea(ring) });
  }
  return outers;
}
