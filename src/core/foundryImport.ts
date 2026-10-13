/**
 * G-30 (D-449): bring a Foundry VTT scene (the JSON from "Export Data") into a world, with its floors.
 *
 * Three source shapes are read:
 *  - **Foundry V14 core levels**: `levels[]` on the scene (`elevation`, `visibility`, `background`,
 *    `foreground`), `levels: [ids]` on placeables and Change Level regions;
 *  - **the Levels module (Foundry V10–V13)**: `flags.levels.sceneLevels`, wall heights
 *    (`flags["wall-height"]`), `flags.levels.rangeTop` on tiles and lights, stair/elevator drawings
 *    (`flags.levels.drawingMode`) and stair regions made by its region migration; when a scene has no
 *    level list, floors are inferred from the bands its walls and tiles use;
 *  - **a flat scene**: walls, lights, tiles and tokens with no floors.
 *
 * Clean-room: written from Foundry's public data model and the behaviour recorded in the gap analysis
 * (T11); no module code is used. The plan is pure — the GM previews the report and the scene is
 * created by one undoable create, left as floor drafts (floor play is turned on after the check).
 * Foundry image paths are server paths, so images arrive only through files the GM picks; every
 * other image stays empty and is listed (the path is kept in `flags.foundry.src`).
 */
import { parseLightAnimation } from "./lightAnimation";
import type {
  LevelDocument,
  LevelScope,
  LightDocument,
  RegionDocument,
  SceneDocument,
  SceneGrid,
  TileDocument,
  TokenDocument,
  WallDocument,
} from "./documents";
import type { StairBehaviorV2 } from "./levelPlay";
import { sceneLevelsError } from "./levels";

export type FoundrySource = "foundry-levels" | "levels-module" | "inferred" | "flat";

export interface FoundryImportOptions {
  /** The new scene's id. */
  sceneId: string;
  /** Fresh ids for the floors and embedded documents (Foundry ids are not reused). */
  nextId: () => string;
  /** Picked files: lower-case file name (see {@link foundryImageName}) → stored image reference. */
  images?: ReadonlyMap<string, string>;
  /** Diagonal rule when the export does not name one (Foundry V12+ does). */
  diagonals?: SceneGrid["diagonals"];
}

export interface FoundryImportFloor {
  id: string;
  name: string;
  bottom: number | null;
  top: number | null;
  walls: number;
  lights: number;
  tiles: number;
  tokens: number;
  stairs: number;
}

export interface FoundryImportReport {
  name: string;
  source: FoundrySource;
  floors: FoundryImportFloor[];
  counts: { walls: number; lights: number; tiles: number; tokens: number; stairs: number };
  /** Walls and lights scoped to every floor. */
  everyFloor: { walls: number; lights: number };
  /** Every image path the scene uses, and whether a picked file supplies it. */
  images: Array<{ path: string; name: string; uses: number; linked: boolean }>;
  skipped: Array<{ what: string; count: number }>;
  notes: string[];
}

export type FoundryImportResult =
  | { ok: true; scene: SceneDocument; report: FoundryImportReport }
  | { ok: false; error: string };

type Rec = Record<string, unknown>;
const EPS = 1e-6;
const MAX_FLOORS = 32;
const MAX_STAIR_FLOORS = 8;

const rec = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((r): r is Rec => r !== undefined) : []);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function importedLightAnimation(value: unknown): import("./documents").LightAnimation | undefined {
  const raw = rec(value);
  if (!raw) return undefined;
  const parsed = parseLightAnimation({
    type: raw.type,
    speed: num(raw.speed) ?? 3,
    intensity: num(raw.intensity) ?? 0.5,
    ...(typeof raw.reverse === "boolean" ? { reverse: raw.reverse } : {}),
  });
  return parsed.ok ? parsed.value ?? undefined : undefined;
}
const levelsFlags = (doc: Rec) => rec(rec(doc.flags)?.levels);
const printable = (s: string, max: number) => [...s].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim().slice(0, max);

/** The lower-case file name a Foundry image path is matched by. */
export function foundryImageName(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? "";
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(base).toLowerCase();
  } catch {
    return base.toLowerCase();
  }
}

/** The one scene in a file: a scene export, or a world/adventure export holding exactly one scene. */
function sceneOf(raw: unknown): Rec | string {
  const r = rec(raw);
  if (!r) return "This is not a Foundry scene export (expected a JSON object).";
  if (Array.isArray(r.scenes)) {
    const scenes = recs(r.scenes);
    if (scenes.length !== 1) return `The file holds ${scenes.length} scenes. Export a single scene from Foundry (right-click it → Export Data).`;
    return scenes[0] as Rec;
  }
  if (num(r.width) === undefined || !["walls", "tokens", "tiles", "lights"].some((k) => Array.isArray(r[k])))
    return "This is not a Foundry scene export (no size, walls, tiles or tokens).";
  return r;
}

const tileSrc = (t: Rec) => text(rec(t.texture)?.src) ?? text(t.img);

/** Every image path a scene uses (backgrounds, foregrounds, tiles, tokens), most-used first. */
export function foundryImagePaths(raw: unknown): Array<{ path: string; name: string; uses: number }> {
  const scene = sceneOf(raw);
  if (typeof scene === "string") return [];
  const uses = new Map<string, number>();
  const add = (path: string | undefined) => { if (path) uses.set(path, (uses.get(path) ?? 0) + 1); };
  add(text(rec(scene.background)?.src) ?? text(scene.img));
  add(typeof scene.foreground === "string" ? text(scene.foreground) : text(rec(scene.foreground)?.src));
  for (const l of recs(scene.levels)) { add(text(rec(l.background)?.src)); add(text(rec(l.foreground)?.src)); }
  for (const t of recs(scene.tiles)) add(tileSrc(t));
  for (const k of recs(scene.tokens)) add(text(rec(k.texture)?.src) ?? text(k.img));
  return [...uses].map(([path, n]) => ({ path, name: foundryImageName(path), uses: n })).sort((a, b) => b.uses - a.uses || a.path.localeCompare(b.path));
}

function gridOf(scene: Rec, diagonals: SceneGrid["diagonals"] | undefined): SceneGrid {
  const g = rec(scene.grid);
  const size = clamp(num(g?.size) ?? num(scene.grid) ?? 100, 10, 1000);
  const type = num(g?.type) ?? num(scene.gridType) ?? 1;
  const distance = num(g?.distance) ?? num(scene.gridDistance) ?? 5;
  const units = text(g?.units) ?? text(scene.gridUnits) ?? "ft";
  const rule = num(g?.diagonals);
  const hexLayouts: Record<number, SceneGrid["hexLayout"]> = { 2: "oddR", 3: "evenR", 4: "oddQ", 5: "evenQ" };
  return {
    type: type === 0 ? "gridless" : type >= 2 && type <= 5 ? "hex" : "square",
    size,
    distance: distance > 0 ? distance : 5,
    units: units.slice(0, 32),
    // Foundry V12+: 0 equidistant, 1 exact, 2 approximate, 4/5 alternating (5/10/5 and 10/5/10).
    diagonals: rule === 0 ? "555" : rule === 1 || rule === 2 ? "euclidean" : rule === 4 || rule === 5 ? "5105" : (diagonals ?? "5105"),
    hexLayout: hexLayouts[type] ?? "oddR",
  };
}

interface RawFloor { srcId?: string; name?: string; bottom: number | null; top: number | null; visible?: string[]; background?: string; foreground?: string }
interface Floor extends FoundryImportFloor { srcId?: string; visible?: string[]; background?: string; foreground?: string; sort: number }

/** Levels module (V10–V13) floor list: `[[bottom, top, name], …]` (values may be strings). */
function levelsModuleFloors(scene: Rec): RawFloor[] {
  const rows = levelsFlags(scene)?.sceneLevels;
  if (!Array.isArray(rows)) return [];
  const out: RawFloor[] = [];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [rec(row)?.bottom, rec(row)?.top, rec(row)?.name];
    const bottom = num(cells[0]), name = text(cells[2]);
    if (bottom === undefined) continue;
    out.push({ bottom, top: num(cells[1]) ?? null, ...(name ? { name } : {}) });
  }
  return out;
}

/** Foundry V14 core levels (JSON writes ±Infinity as null). */
function coreFloors(scene: Rec): RawFloor[] {
  return recs(scene.levels).map((l): RawFloor => {
    const band = rec(l.elevation);
    const visible = rec(l.visibility)?.levels;
    const srcId = text(l._id), name = text(l.name), background = text(rec(l.background)?.src), foreground = text(rec(l.foreground)?.src);
    return {
      ...(srcId ? { srcId } : {}),
      ...(name ? { name } : {}),
      bottom: num(band?.bottom) ?? null,
      top: num(band?.top) ?? null,
      ...(Array.isArray(visible) ? { visible: visible.filter((v): v is string => typeof v === "string") } : {}),
      ...(background ? { background } : {}),
      ...(foreground ? { foreground } : {}),
    };
  });
}

const wallBand = (w: Rec): { bottom?: number; top?: number } => {
  const height = rec(rec(w.flags)?.["wall-height"]);
  const legacy = rec(rec(w.flags)?.wallHeight);
  const bottom = num(height?.bottom) ?? num(legacy?.wallHeightBottom);
  const top = num(height?.top) ?? num(legacy?.wallHeightTop);
  return { ...(bottom !== undefined ? { bottom } : {}), ...(top !== undefined ? { top } : {}) };
};
/** A tile, light or drawing's Levels band: core `elevation` (or the old `rangeBottom`) to `rangeTop`. */
const docBand = (d: Rec): { bottom?: number; top?: number } | null => {
  const flags = levelsFlags(d);
  if (!flags) return null;
  const bottom = num(d.elevation) ?? num(flags.rangeBottom);
  const top = num(flags.rangeTop);
  return { ...(bottom !== undefined ? { bottom } : {}), ...(top !== undefined ? { top } : {}) };
};

/** No level list: floors are the tall bands (≥ 1.5 grid distances) that walls and tiles use. */
function inferredFloors(scene: Rec, distance: number): RawFloor[] {
  const bands = new Map<number, number>();
  const consider = (b: number | undefined, t: number | undefined) => {
    if (b === undefined || t === undefined || t - b < 1.5 * distance - EPS) return;
    bands.set(b, Math.max(bands.get(b) ?? -Infinity, t));
  };
  for (const w of recs(scene.walls)) { const band = wallBand(w); consider(band.bottom, band.top); }
  for (const t of recs(scene.tiles)) { const band = docBand(t); if (band) consider(band.bottom, band.top); }
  return [...bands].map(([bottom, top]) => ({ bottom, top }));
}

/**
 * Sort, drop duplicate bottoms and make the bands fit ArenaStar's rule (no overlaps): a top at or
 * just under the next bottom (Levels tops are inclusive, e.g. 0–9 then 10–19) meets it; a genuine
 * gap stays; an overlap is clipped. The highest floor keeps its own top (or none).
 */
function normalizeFloors(raw: RawFloor[], notes: string[]): RawFloor[] {
  const sorted = [...raw].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity));
  const out: RawFloor[] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && (last.bottom ?? -Infinity) === (f.bottom ?? -Infinity)) { notes.push(`Two floors start at ${f.bottom ?? "−∞"}; “${f.name ?? "unnamed"}” was merged into the first.`); continue; }
    out.push({ ...f });
  }
  let clipped = 0;
  for (let i = 0; i < out.length; i++) {
    const f = out[i] as RawFloor, next = out[i + 1];
    const bottom = f.bottom ?? -Infinity;
    if (next && next.bottom !== null) {
      const top = f.top ?? Infinity;
      if (top > next.bottom + EPS && Number.isFinite(top)) clipped++;
      f.top = top <= bottom || top >= next.bottom - 1 - EPS ? next.bottom : top;
    } else {
      f.top = f.top !== null && f.top > bottom ? f.top : null;
    }
  }
  if (clipped) notes.push(`${clipped} overlapping floor band(s) were clipped where the next floor starts.`);
  return out;
}

const regionUnitSquare: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** A Foundry region shape (V12+) as a box and normalized polygon; holes and empty shapes are refused. */
function regionShapeBox(shape: Rec, ox: number, oy: number): { x: number; y: number; width: number; height: number; rotation: number; points: Array<[number, number]> } | null {
  if (shape.hole === true) return null;
  const type = shape.type;
  let pts: Array<[number, number]> = [];
  if (type === "rectangle") {
    const x = num(shape.x), y = num(shape.y), w = num(shape.width), h = num(shape.height);
    if (x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) return null;
    return { x: x - ox, y: y - oy, width: w, height: h, rotation: num(shape.rotation) ?? 0, points: regionUnitSquare };
  }
  if (type === "polygon") {
    const flat = Array.isArray(shape.points) ? shape.points.map(num) : [];
    for (let i = 0; i + 1 < flat.length; i += 2) { const px = flat[i], py = flat[i + 1]; if (px !== undefined && py !== undefined) pts.push([px, py]); }
  } else if (type === "ellipse" || type === "circle") {
    const cx = num(shape.x), cy = num(shape.y);
    const rx = type === "circle" ? num(shape.radius) : num(shape.radiusX), ry = type === "circle" ? num(shape.radius) : num(shape.radiusY);
    if (cx === undefined || cy === undefined || !rx || !ry) return null;
    pts = Array.from({ length: 16 }, (_, i) => [cx + rx * Math.cos((i / 16) * 2 * Math.PI), cy + ry * Math.sin((i / 16) * 2 * Math.PI)] as [number, number]);
  }
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
  if (width <= 0 || height <= 0) return null;
  return { x: minX - ox, y: minY - oy, width, height, rotation: 0, points: pts.map(([px, py]) => [(px - minX) / width, (py - minY) / height]) };
}

/** `"0,Ground|10,First"` → elevations (the Levels elevator's floor list). */
const elevatorElevations = (list: unknown): number[] =>
  typeof list === "string" ? list.split("|").map((part) => num(part.split(",")[0])).filter((n): n is number => n !== undefined) : [];

export function planFoundryImport(raw: unknown, options: FoundryImportOptions): FoundryImportResult {
  const source = sceneOf(raw);
  if (typeof source === "string") return { ok: false, error: source };
  const width = num(source.width), height = num(source.height);
  if (!width || !height || width <= 0 || height <= 0) return { ok: false, error: "The scene has no size (width and height)." };
  const name = printable(text(source.name) ?? "Imported scene", 128) || "Imported scene";
  const grid = gridOf(source, options.diagonals);
  const pxPerUnit = grid.size / grid.distance;
  const notes: string[] = [];
  const skipped = new Map<string, number>();
  const skip = (what: string, n = 1) => skipped.set(what, (skipped.get(what) ?? 0) + n);
  const tally = new Map<string, number>();
  const count = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);

  // Foundry places the map inside a padding margin; ArenaStar's origin is the map's corner.
  const padding = clamp(num(source.padding) ?? 0.25, 0, 0.5);
  const ox = Math.ceil((width * padding) / grid.size) * grid.size;
  const oy = Math.ceil((height * padding) / grid.size) * grid.size;
  if (grid.type === "hex" && padding > 0) notes.push("Hex scene: positions were shifted by the square-grid padding rule — check that tokens sit in their hexes.");

  const images = options.images ?? new Map<string, string>();
  const imageUses = new Map<string, number>();
  /** The stored reference for a Foundry image path, or "" (kept in flags) when no file was picked. */
  const image = (path: string | undefined): string => {
    if (!path) return "";
    imageUses.set(path, (imageUses.get(path) ?? 0) + 1);
    return images.get(foundryImageName(path)) ?? "";
  };
  const srcFlags = (path: string | undefined, ref: string) => (path && !ref ? { foundry: { src: path.slice(0, 1024) } } : {});

  // ── Floors ────────────────────────────────────────────────────────────────────────────────
  let kind: FoundrySource = "flat";
  let rawFloors = coreFloors(source);
  if (rawFloors.length >= 2) kind = "foundry-levels";
  else if ((rawFloors = levelsModuleFloors(source)).length >= 2) kind = "levels-module";
  else if ((rawFloors = inferredFloors(source, grid.distance)).length >= 2) kind = "inferred";
  else rawFloors = [];
  rawFloors = normalizeFloors(rawFloors, notes);
  // One floor is no floors: a V14 scene's single default level only carries the map.
  let singleFloorMap: string | undefined;
  if (rawFloors.length < 2) { singleFloorMap = rawFloors[0]?.background ?? coreFloors(source)[0]?.background; rawFloors = []; kind = "flat"; }
  if (kind === "inferred") notes.push("The scene has no level list; floors were inferred from the wall and tile heights. Check the bands and names.");
  if (rawFloors.length > MAX_FLOORS) return { ok: false, error: `The scene has ${rawFloors.length} floors; at most ${MAX_FLOORS} are supported.` };
  const floors: Floor[] = rawFloors.map((f, i) => ({
    id: options.nextId(),
    name: printable(f.name ?? "", 128) || (f.bottom !== null ? `Level ${i + 1} (${f.bottom})` : `Level ${i + 1}`),
    bottom: f.bottom, top: f.top, sort: i,
    walls: 0, lights: 0, tiles: 0, tokens: 0, stairs: 0,
    ...(f.srcId ? { srcId: f.srcId } : {}), ...(f.visible ? { visible: f.visible } : {}),
    ...(f.background ? { background: f.background } : {}), ...(f.foreground ? { foreground: f.foreground } : {}),
  }));
  const hasFloors = floors.length >= 2;
  const bySrc = new Map(floors.flatMap((f) => (f.srcId ? [[f.srcId, f] as const] : [])));
  const inBand = (f: Floor, z: number) => (f.bottom === null || z >= f.bottom - EPS) && (f.top === null || z < f.top - EPS);
  /** The floor holding an elevation; in a gap, the floor below; under everything, the lowest. */
  const floorAt = (z: number): Floor => floors.find((f) => inBand(f, z)) ?? [...floors].reverse().find((f) => f.bottom !== null && f.bottom <= z) ?? (floors[0] as Floor);
  /** Floors whose whole band lies in a Levels range (its top is inclusive). */
  const within = (b: number, t: number) => floors.filter((f) => (f.bottom ?? -Infinity) >= b - EPS && (f.top ?? Infinity) <= t + 1 + EPS);
  const scopeOf = (members: Floor[]): LevelScope => {
    const ids = [...new Set(members)].sort((a, b) => a.sort - b.sort);
    return ids.length === floors.length ? { mode: "all" } : { mode: "levels", ids: ids.map((f) => f.id) };
  };
  const bandScope = (b: number | undefined, t: number | undefined): LevelScope => {
    const lo = b ?? -Infinity, hi = t ?? Infinity;
    const inside = within(lo, hi);
    return scopeOf(inside.length ? inside : [floorAt(Number.isFinite(lo) ? lo : Number.isFinite(hi) ? hi : 0)]);
  };
  /** V14 `levels: [ids]` on a placeable, mapped to the new floors. */
  const listed = (doc: Rec): Floor[] => (Array.isArray(doc.levels) ? doc.levels.flatMap((id) => (typeof id === "string" && bySrc.has(id) ? [bySrc.get(id) as Floor] : [])) : []);
  const tallyScope = (scope: LevelScope, field: "walls" | "lights") => {
    if (scope.mode === "all") { count(`every:${field}`); return; }
    for (const id of scope.ids) { const f = floors.find((x) => x.id === id); if (f) f[field]++; }
  };

  // The floor that shows the scene's own map image.
  const backgroundElevation = num(levelsFlags(source)?.backgroundElevation);
  const mapFloor = hasFloors
    ? (backgroundElevation !== undefined ? floors.find((f) => f.bottom === backgroundElevation) : undefined) ?? floors.find((f) => (f.bottom ?? -Infinity) >= 0) ?? (floors[0] as Floor)
    : undefined;

  // ── Walls ─────────────────────────────────────────────────────────────────────────────────
  const walls: WallDocument[] = [];
  let limited = 0, oneWay = 0, secret = 0;
  for (const w of recs(source.walls)) {
    const c = Array.isArray(w.c) ? w.c.map(num) : [];
    const [x0, y0, x1, y1] = c;
    if (c.length < 4 || x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || (x0 === x1 && y0 === y1)) { skip("walls without valid coordinates"); continue; }
    const door = num(w.door) ?? 0;
    const legacy = w.sight === undefined && w.sense !== undefined; // Foundry ≤ V9
    const codes = [num(w.move), legacy ? num(w.sense) : num(w.sight), num(w.sound), legacy ? num(w.sense) : num(w.light) ?? num(w.sight)];
    // NONE (0) permits; NORMAL/LIMITED/PROXIMITY/DISTANCE block (default NORMAL). A door's blocking axes follow its state.
    const axis = (code: number | undefined): 0 | 1 | 2 => ((code ?? 20) === 0 ? 2 : door ? 1 : 0);
    if (codes.some((code) => code !== undefined && code !== 0 && code !== 20 && !(legacy && code === 1))) limited++;
    if ((num(w.dir) ?? 0) !== 0) oneWay++;
    if (door === 2) secret++;
    const state = num(w.ds);
    const doc: WallDocument = {
      _id: options.nextId(), type: "wall", name: "", ownership: { default: 0 }, flags: {}, system: {},
      c: [x0 - ox, y0 - oy, x1 - ox, y1 - oy], door: door && (state === 1 || state === 2) ? state : 0, oneWay: false,
      move: axis(codes[0]), sight: axis(codes[1]), sound: axis(codes[2]), light: axis(codes[3]),
    };
    if (hasFloors) {
      const members = listed(w);
      const band = wallBand(w);
      doc.levelScope = members.length ? scopeOf(members) : band.bottom === undefined && band.top === undefined ? { mode: "all" } : bandScope(band.bottom, band.top);
      tallyScope(doc.levelScope, "walls");
    }
    walls.push(doc);
  }
  if (limited) notes.push(`${limited} wall(s) with limited, proximity or distance senses now simply block.`);
  if (oneWay) notes.push(`${oneWay} one-way wall(s) now block both ways.`);
  if (secret) notes.push(`${secret} secret door(s) are ordinary doors.`);

  // ── Lights ────────────────────────────────────────────────────────────────────────────────
  const lights: LightDocument[] = [];
  let cones = 0;
  for (const l of recs(source.lights)) {
    const cfg = rec(l.config) ?? l;
    if (l.hidden === true) { skip("switched-off lights"); continue; }
    if (cfg.negative === true || (num(cfg.luminosity) ?? 0.5) < 0) { skip("darkness sources"); continue; }
    const x = num(l.x), y = num(l.y);
    const dimU = num(cfg.dim) ?? 0, brightU = num(cfg.bright) ?? 0;
    const dim = Math.max(dimU, brightU) * pxPerUnit, bright = Math.min(brightU, Math.max(dimU, brightU)) * pxPerUnit;
    if (x === undefined || y === undefined || dim <= 0) { skip("lights without a position or radius"); continue; }
    const angle = clamp(num(cfg.angle) ?? 360, 1, 360);
    if (angle < 360) cones++;
    const color = text(cfg.color) ?? text(cfg.tintColor);
    const animation = importedLightAnimation(cfg.animation);
    const doc: LightDocument = {
      _id: options.nextId(), type: "light", name: "", ownership: { default: 0 }, flags: {}, system: {},
      x: x - ox, y: y - oy, dim, bright,
      ...(angle < 360 ? { angle, rotation: num(l.rotation) ?? 0 } : {}),
      ...(animation ? { animation } : {}),
      color: color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#ffffff",
      alpha: clamp(num(cfg.alpha) ?? num(cfg.tintAlpha) ?? 0.5, 0, 1),
    };
    if (hasFloors) {
      const members = listed(l);
      const band = docBand(l);
      doc.levelScope = members.length ? scopeOf(members) : band ? bandScope(band.bottom ?? 0, band.top ?? band.bottom ?? 0) : { mode: "all" };
      tallyScope(doc.levelScope, "lights");
    }
    lights.push(doc);
  }
  if (cones) notes.push(`${cones} cone light(s) keep their imported direction and beam width.`);

  // ── Tiles (floor art) ─────────────────────────────────────────────────────────────────────
  const tiles: TileDocument[] = [];
  const art = new Map<Floor, string[]>();
  const addArt = (f: Floor, id: string) => { art.set(f, [...(art.get(f) ?? []), id]); f.tiles++; };
  let unflagged = 0;
  const foregroundElevation = num(source.foregroundElevation);
  for (const t of recs(source.tiles)) {
    const x = num(t.x), y = num(t.y), w = num(t.width), h = num(t.height);
    if (x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) { skip("tiles without a size"); continue; }
    const path = tileSrc(t);
    const ref = image(path);
    const occlusion = rec(t.occlusion);
    const modes = Array.isArray(occlusion?.modes) ? occlusion.modes.map(num) : [];
    const elevation = num(t.elevation) ?? docBand(t)?.bottom ?? 0;
    let above = t.overhead === true || t.roof === true ||
      (typeof t.overhead !== "boolean" && foregroundElevation !== undefined && elevation >= foregroundElevation);
    const mode = t.roof === true ? 2 : num(occlusion?.mode) ?? modes.find((m) => m !== undefined && m !== 0) ?? 1;
    let floor: Floor | undefined;
    if (hasFloors) {
      const members = listed(t);
      const band = docBand(t);
      floor = members.length ? members.find((f) => inBand(f, elevation)) ?? [...members].sort((a, b) => a.sort - b.sort)[0]
        : band ? floorAt(band.bottom ?? 0) : mapFloor;
      if (!members.length && !band) unflagged++;
      // A Levels floor is an overhead tile at the floor's base: on its own floor it lies under the tokens.
      if (floor && floor.bottom !== null && Math.abs(elevation - floor.bottom) < EPS && floor !== floors[0]) above = false;
    }
    const doc: TileDocument = {
      _id: options.nextId(), type: "tile", name: printable(path ? foundryImageName(path) : "Tile", 128) || "Tile", ownership: { default: 0 }, flags: srcFlags(path, ref), system: {},
      x: x - ox, y: y - oy, width: w, height: h, img: ref, above,
      occlusion: { mode: mode === 2 ? "roof" : mode === 3 ? "radial" : mode === 4 ? "vision" : "fade", alpha: mode === 0 ? 1 : clamp(num(occlusion?.alpha) ?? 0, 0, 1) },
      ...(num(t.rotation) ? { rotation: num(t.rotation) as number } : {}),
      ...(t.hidden === true ? { hidden: true } : {}),
      ...(num(t.sort) ?? num(t.z) ? { sort: Math.round(num(t.sort) ?? num(t.z) ?? 0) } : {}),
    };
    tiles.push(doc);
    if (floor) addArt(floor, doc._id);
  }
  if (unflagged && mapFloor) notes.push(`${unflagged} tile(s) without floor data were put on ${mapFloor.name}, the floor with the map.`);

  // V14: each floor's own background and foreground become full-scene floor art.
  let sceneImagePath: string | undefined = text(rec(source.background)?.src) ?? text(source.img) ?? singleFloorMap;
  for (const f of floors) {
    if (f.background && f === mapFloor && !sceneImagePath) sceneImagePath = f.background;
    else if (f.background) {
      const ref = image(f.background);
      const doc: TileDocument = { _id: options.nextId(), type: "tile", name: `${f.name} map`.slice(0, 128), ownership: { default: 0 }, flags: srcFlags(f.background, ref), system: {},
        x: 0, y: 0, width, height, img: ref, above: false, occlusion: { mode: "fade", alpha: 1 }, sort: -1000 };
      tiles.push(doc); addArt(f, doc._id);
    }
    if (f.foreground) {
      const ref = image(f.foreground);
      const doc: TileDocument = { _id: options.nextId(), type: "tile", name: `${f.name} foreground`.slice(0, 128), ownership: { default: 0 }, flags: srcFlags(f.foreground, ref), system: {},
        x: 0, y: 0, width, height, img: ref, above: true, occlusion: { mode: "fade", alpha: 0.25 } };
      tiles.push(doc); addArt(f, doc._id);
    }
  }

  // ── Tokens ────────────────────────────────────────────────────────────────────────────────
  const tokens: TokenDocument[] = [];
  let withActors = 0, lifted = 0, tokenCones = 0;
  const feet = /^(ft|feet|foot|')$/i.test(grid.units.trim());
  for (const k of recs(source.tokens)) {
    const x = num(k.x), y = num(k.y);
    if (x === undefined || y === undefined) { skip("tokens without a position"); continue; }
    const w = (num(k.width) ?? 1) * grid.size, h = (num(k.height) ?? 1) * grid.size;
    if (w <= 0 || h <= 0) { skip("tokens without a size"); continue; }
    const path = text(rec(k.texture)?.src) ?? text(k.img);
    const ref = image(path);
    const sight = rec(k.sight);
    const light = rec(k.light);
    const lightDim = Math.max(num(light?.dim) ?? num(k.dimLight) ?? 0, num(light?.bright) ?? num(k.brightLight) ?? 0) * pxPerUnit;
    const lightBright = (num(light?.bright) ?? num(k.brightLight) ?? 0) * pxPerUnit;
    const lightColor = text(light?.color) ?? text(k.lightColor);
    const lightAngle = clamp(num(light?.angle) ?? 360, 1, 360);
    const lightAnimation = importedLightAnimation(light?.animation);
    if (lightDim > 0 && lightAngle < 360) tokenCones++;
    const darkvision = feet ? (sight?.visionMode === "darkvision" ? num(sight.range) : num(k.dimSight)) : undefined;
    const disposition = num(k.disposition);
    const elevation = num(k.elevation) ?? 0;
    if (text(k.actorId)) withActors++;
    const doc: TokenDocument = {
      _id: options.nextId(), type: "token", name: printable(text(k.name) ?? "Token", 128) || "Token", ownership: { default: 0 }, flags: srcFlags(path, ref), system: {},
      x: x - ox + w / 2, y: y - oy + h / 2, width: w, height: h, rotation: num(k.rotation) ?? 0,
      ...(elevation ? { elevation } : {}),
      img: ref, hidden: k.hidden === true,
      disposition: disposition === 1 ? "friendly" : disposition === -1 ? "hostile" : "neutral",
      vision: typeof sight?.enabled === "boolean" ? sight.enabled : k.vision === true,
      light: lightDim > 0
        ? { radius: lightDim, bright: Math.min(lightBright, lightDim), ...(lightAngle < 360 ? { angle: lightAngle } : {}),
            ...(lightAnimation ? { animation: lightAnimation } : {}),
            color: lightColor && /^#[0-9a-f]{6}$/i.test(lightColor) ? lightColor.toLowerCase() : "#ffffff", alpha: clamp(num(light?.alpha) ?? num(k.lightAlpha) ?? 0.5, 0, 1) }
        : { radius: 0, color: "#ffffff", alpha: 0 },
      ...(darkvision && darkvision > 0 ? { darkvision } : {}),
    };
    if (hasFloors) {
      const named = typeof k.level === "string" ? bySrc.get(k.level) : undefined;
      const floor = named ?? floorAt(elevation);
      doc.levelId = floor.id;
      floor.tokens++;
      // A token stands inside its floor's band: one outside it (a stale height) is set on the floor.
      if (!inBand(floor, elevation)) {
        lifted++;
        const z = floor.bottom ?? (floor.top !== null ? floor.top - 1 : 0);
        if (z) doc.elevation = z; else delete doc.elevation;
      }
    }
    tokens.push(doc);
  }
  if (lifted) notes.push(`${lifted} token(s) stood outside their floor's height band and were set on the floor.`);
  if (tokenCones) notes.push(`${tokenCones} token-carried cone light(s) keep their direction and beam width.`);
  if (withActors) notes.push(`${withActors} token(s) came from actors that are not imported; they are plain tokens now.`);

  // ── Stairs ────────────────────────────────────────────────────────────────────────────────
  const regions: RegionDocument[] = [];
  /** The two floors a Levels stair joins: the one at its bottom and the next one its range reaches. */
  const stairPair = (bottom: number, top: number): [Floor, Floor] | null => {
    const lower = floorAt(bottom);
    let upper = floorAt(top);
    if (upper === lower) upper = floors.find((f) => f.sort > lower.sort && f.bottom !== null && f.bottom <= top + 1 + EPS) ?? lower;
    return upper === lower ? null : [lower, upper];
  };
  const addStairs = (box: { x: number; y: number; width: number; height: number; rotation: number; points: Array<[number, number]> }, regionName: string,
    levels: Floor[], directed: "both" | "up" | "down") => {
    const ordered = [...new Set(levels)].sort((a, b) => a.sort - b.sort).slice(0, MAX_STAIR_FLOORS);
    if (ordered.length < 2) { skip("stairs that do not reach another floor"); return; }
    const low = ordered[0] as Floor, high = ordered[ordered.length - 1] as Floor;
    const stairs: StairBehaviorV2 = {
      version: 2, levels: ordered.map((f) => f.id), mode: ordered.length > 2 ? "prompt" : "auto",
      ...(directed === "up" ? { edges: [{ from: low.id, to: high.id }] } : directed === "down" ? { edges: [{ from: high.id, to: low.id }] } : {}),
    };
    regions.push({
      _id: options.nextId(), type: "region", name: printable(regionName, 128) || "Stairs", ownership: { default: 0 }, flags: {}, system: {},
      hidden: true, x: box.x, y: box.y, width: box.width, height: box.height, ...(box.rotation ? { rotation: box.rotation } : {}),
      shape: { kind: "polygon", points: box.points.map(([px, py]) => [px, py] as [number, number]) }, stairs,
    });
    for (const f of ordered) f.stairs++;
  };

  for (const d of recs(source.drawings)) {
    const flags = levelsFlags(d);
    const mode = num(flags?.drawingMode) ?? 0;
    if (!mode) { skip("drawings"); continue; }
    if (mode === 1) { skip("Levels hole drawings (trace the floor art instead)"); continue; }
    if (!hasFloors) { skip("stairs on a scene without floors"); continue; }
    const shape = rec(d.shape);
    const w = num(shape?.width) ?? num(d.width), h = num(shape?.height) ?? num(d.height);
    const x = num(d.x), y = num(d.y);
    if ((shape?.type ?? d.type) !== "r" || x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) { skip("stair drawings that are not rectangles"); continue; }
    const box = { x: x - ox, y: y - oy, width: w, height: h, rotation: num(d.rotation) ?? 0, points: regionUnitSquare };
    const label = text(d.text);
    if (mode === 3) {
      addStairs(box, label ?? "Elevator", elevatorElevations(flags?.elevatorFloors).map(floorAt), "both");
      continue;
    }
    const bottom = num(d.elevation) ?? num(flags?.rangeBottom), top = num(flags?.rangeTop);
    const pair = bottom !== undefined && top !== undefined ? stairPair(bottom, top) : null;
    if (!pair) { skip("stairs that do not reach another floor"); continue; }
    addStairs(box, label ?? "Stairs", pair, mode === 22 ? "up" : mode === 21 ? "down" : "both");
  }

  for (const r of recs(source.regions)) {
    const behaviors = recs(r.behaviors);
    const change = behaviors.find((b) => b.type === "changeLevel");
    const script = behaviors.map((b) => (b.type === "executeScript" ? text(rec(b.system)?.source) : undefined)).find((s) => s && /RegionHandler\.(stair|stairUp|stairDown|elevator)\(/.test(s));
    if (!change && !script) { skip("regions"); continue; }
    if (!hasFloors) { skip("stairs on a scene without floors"); continue; }
    const box = recs(r.shapes).map((s) => regionShapeBox(s, ox, oy)).find((b) => b !== null) ?? null;
    if (!box) { skip("stair regions without a usable shape"); continue; }
    const band = rec(r.elevation);
    const rb = num(band?.bottom), rt = num(band?.top);
    const label = text(r.name) ?? "Stairs";
    if (change) {
      // Core Change Level: the region's floors (V14 `levels`), else every floor its band touches (top inclusive).
      let members = listed(r);
      if (members.length < 2) members = floors.filter((f) => (rb === undefined || (f.top ?? Infinity) > rb + EPS) && (rt === undefined || (f.bottom ?? -Infinity) <= rt + EPS));
      const ordered = [...new Set(members)].sort((a, b) => a.sort - b.sort);
      if (ordered.length < 2) { skip("stairs that do not reach another floor"); continue; }
      // Core prompts for the destination.
      const before = regions.length;
      addStairs(box, label, ordered, "both");
      const made = regions[before];
      if (made?.stairs && "version" in made.stairs) made.stairs = { ...made.stairs, mode: "prompt" };
      continue;
    }
    const code = script as string;
    if (/RegionHandler\.elevator\(/.test(code)) {
      addStairs(box, label, elevatorElevations(/elevator\(\s*region\s*,\s*event\s*,\s*"([^"]*)"/.exec(code)?.[1]).map(floorAt), "both");
      continue;
    }
    // The Levels migration stored the drawing's range with the top raised by one.
    const pair = rb !== undefined && rt !== undefined ? stairPair(rb, rt - 1) : null;
    if (!pair) { skip("stairs that do not reach another floor"); continue; }
    addStairs(box, label, pair, /stairUp\(/.test(code) ? "up" : /stairDown\(/.test(code) ? "down" : "both");
  }

  for (const [what, key] of [["sounds", "sounds"], ["notes", "notes"], ["measured templates", "templates"]] as const) {
    const n = recs(source[key]).length;
    if (n) skip(what, n);
  }

  // ── The scene ─────────────────────────────────────────────────────────────────────────────
  const levels: LevelDocument[] = floors.map((f) => ({
    _id: f.id, type: "level", name: f.name, ownership: { default: 0 }, flags: {}, system: {},
    bottom: f.bottom, top: f.top, floorZ: f.bottom ?? (f.top !== null ? f.top - 1 : 0), sort: f.sort,
    visibleLevelIds: (f.visible ? f.visible.map((id) => bySrc.get(id)).filter((v): v is Floor => !!v) : floors).filter((v) => v.sort < f.sort).map((v) => v.id),
    ...(art.get(f)?.length ? { tileIds: art.get(f) as string[] } : {}),
    ...(f === mapFloor && sceneImagePath ? { useSceneBackground: true } : {}),
  }));
  const sceneImage = image(sceneImagePath) || null;
  const foregroundPath = typeof source.foreground === "string" ? text(source.foreground) : undefined;
  const foregroundRef = image(foregroundPath);
  const bg = rec(source.background);
  const offset = { x: num(bg?.offsetX) ?? num(source.shiftX) ?? 0, y: num(bg?.offsetY) ?? num(source.shiftY) ?? 0 };
  const tokenVision = source.tokenVision !== false;
  const fogExploration = typeof rec(source.fog)?.exploration === "boolean" ? rec(source.fog)?.exploration === true : source.fogExploration !== false;
  const scene: SceneDocument = {
    _id: options.sceneId, type: "scene", name, ownership: { default: 0 },
    flags: { core: { fog: fogExploration, tokenVision }, ...srcFlags(sceneImagePath, sceneImage ?? "") }, system: {},
    active: false, img: sceneImage, width, height, grid,
    darkness: clamp(num(rec(source.environment)?.darknessLevel) ?? num(source.darkness) ?? 0, 0, 1),
    ...(padding || offset.x || offset.y ? { background: { ...(offset.x || offset.y ? { offset } : {}), ...(padding ? { padding } : {}) } } : {}),
    ...(foregroundRef ? { foreground: { img: foregroundRef, elevation: foregroundElevation ?? 20 } } : {}),
    navigation: source.navigation !== false, tokenVision, fogExploration,
    tokens, walls, lights, sounds: [], tiles, drawings: [], templates: [], notes: [], regions,
    ...(hasFloors ? { levels } : {}),
  };
  const invalid = sceneLevelsError(scene);
  if (invalid) return { ok: false, error: `The converted scene is not valid: ${invalid}.` };

  if (hasFloors) notes.push("The floors are drafts: open Floor play on the new scene to run the check and turn it on.");
  const unlinked = [...imageUses.keys()].filter((p) => !images.has(foundryImageName(p))).length;
  if (unlinked) notes.push(`${unlinked} image(s) have no file yet: pick them to bring the art along, or set them later.`);
  const report: FoundryImportReport = {
    name, source: kind,
    floors: floors.map(({ id, name: n, bottom, top, walls: fw, lights: fl, tiles: ft, tokens: fk, stairs: fs }) => ({ id, name: n, bottom, top, walls: fw, lights: fl, tiles: ft, tokens: fk, stairs: fs })),
    counts: { walls: walls.length, lights: lights.length, tiles: tiles.length, tokens: tokens.length, stairs: regions.length },
    everyFloor: { walls: tally.get("every:walls") ?? 0, lights: tally.get("every:lights") ?? 0 },
    images: [...imageUses].map(([path, uses]) => ({ path, name: foundryImageName(path), uses, linked: images.has(foundryImageName(path)) }))
      .sort((a, b) => Number(a.linked) - Number(b.linked) || b.uses - a.uses || a.path.localeCompare(b.path)),
    skipped: [...skipped].map(([what, n]) => ({ what, count: n })),
    notes,
  };
  return { ok: true, scene, report };
}

/** The report's source line. */
export function foundrySourceLabel(source: FoundrySource): string {
  switch (source) {
    case "foundry-levels": return "Foundry V14 scene levels";
    case "levels-module": return "Levels module floors";
    case "inferred": return "Floors inferred from wall and tile heights";
    default: return "A scene without floors";
  }
}
