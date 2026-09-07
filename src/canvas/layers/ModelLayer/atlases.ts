/**
 * §7 sprite atlases for §9A models (D-085): per (unit type × faction palette)
 * frames packed 4×4 into atlas textures, hash-addressed, with a hard cap of
 * 16 atlas textures bound per frame. Pure layout/budget math — the pixi
 * texture work stays in the ModelLayer (browser-only).
 */
export interface AtlasEntry {
  unitType: string;
  /** Packed 0xrrggbb faction tint baked into the frame art. */
  palette: number;
}

export const ATLAS_FRAME = 16;
export const ATLAS_COLS = 4;
export const ATLAS_FRAMES_PER_ATLAS = ATLAS_COLS * ATLAS_COLS; // 16
export const MAX_BOUND_ATLASES = 16;

/** FNV-1a 32-bit → 8 hex chars (content-addressed keys, no crypto dep). */
export function fnv8(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Hash-addressed frame key for one (unitType, palette) sprite. */
export function atlasKey(entry: AtlasEntry): string {
  return `m-${fnv8(entry.unitType)}-${entry.palette.toString(16).padStart(6, "0")}`;
}

export interface AtlasFramePlan {
  entry: AtlasEntry;
  key: string;
  slot: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface AtlasPlan {
  /** Hash of the member frame keys (the atlas texture's address). */
  baseKey: string;
  frames: AtlasFramePlan[];
}

export interface PlanOptions {
  frameSize?: number;
  cols?: number;
  maxAtlases?: number;
}

/** Frame rect for a slot inside an atlas grid (top-left origin). */
export function atlasFrameRect(
  slot: number,
  frameSize = ATLAS_FRAME,
  cols = ATLAS_COLS,
): { x: number; y: number; width: number; height: number } {
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  return { x: col * frameSize, y: row * frameSize, width: frameSize, height: frameSize };
}

/**
 * Dedupe entries by key, pack ≤16 frames per atlas (input order), and cap the
 * plan list at maxAtlases — later overflow entries are DROPPED (they fall
 * back to the tinted stand marker) so the bind budget always holds.
 */
export function planAtlases(
  entries: readonly AtlasEntry[],
  options: PlanOptions = {},
): { plans: AtlasPlan[]; dropped: AtlasEntry[] } {
  const frameSize = options.frameSize ?? ATLAS_FRAME;
  const cols = options.cols ?? ATLAS_COLS;
  const perAtlas = cols * cols;
  const maxAtlases = options.maxAtlases ?? MAX_BOUND_ATLASES;

  const seen = new Set<string>();
  const unique: AtlasEntry[] = [];
  for (const e of entries) {
    const k = atlasKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }

  const plans: AtlasPlan[] = [];
  const dropped: AtlasEntry[] = [];
  for (let i = 0; i < unique.length; i += perAtlas) {
    const chunk = unique.slice(i, i + perAtlas);
    if (plans.length >= maxAtlases) {
      dropped.push(...chunk);
      continue;
    }
    const frames = chunk.map((entry, slot) => ({
      entry,
      key: atlasKey(entry),
      slot,
      rect: atlasFrameRect(slot, frameSize, cols),
    }));
    plans.push({
      baseKey: `atl-${fnv8(frames.map((f) => f.key).join("|"))}`,
      frames,
    });
  }
  return { plans, dropped };
}

export interface BindDecision {
  /** Atlas ids to keep bound (recency order, newest last). */
  keep: string[];
  /** Atlas ids to unbind (LRU first). */
  evict: string[];
  /** New atlas ids to bind (in plan order). */
  admit: string[];
}

/**
 * LRU bind budget: `bound` is ordered oldest→newest, `wanted` carries the
 * current recency order (last use). Keeps ≤ max atlas textures bound.
 */
export function bindDecision(
  bound: readonly string[],
  wanted: readonly string[],
  max = MAX_BOUND_ATLASES,
): BindDecision {
  // `wanted` is oldest→newest by last use: the NEWEST `max` entries win the
  // budget; older still-bound atlases are evicted, fresh overflow unbuilt.
  const finalists = wanted.slice(Math.max(0, wanted.length - max));
  const finalSet = new Set(finalists);
  const keep: string[] = [];
  const admit: string[] = [];
  for (const id of wanted) {
    if (finalSet.has(id)) (bound.includes(id) ? keep : admit).push(id);
  }
  const keepSet = new Set(keep);
  const evict = bound.filter((id) => !keepSet.has(id));
  return { keep: finalists, evict, admit };
}
