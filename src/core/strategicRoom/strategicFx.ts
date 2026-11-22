/**
 * Scalable Strategic Battle VFX & Spatial Audio Planner.
 *
 * Designed for mass-battle scale (hundreds of simultaneous spells + tens of thousands
 * of melee/ranged/charge combat events across up to 500 players and 50,000 models):
 *
 * 1. **Authoritative Spatial Aggregation (`aggregateStrategicFxCues`)**:
 *    Coalesces arbitrary numbers of spell, consumable, melee, volley, AoO, cleave, and
 *    charge events into bounded spatial grid cells (`cellFeet`, default 25 ft) while
 *    leaving 100% of authoritative rules resolution untouched. For example, 500 fireballs
 *    detonating on the same or nearby coordinates deal all 500 fireballs' mechanical
 *    damage, while collapsing into 1 representative visual/audio cue with `count: 500`
 *    and logarithmic intensity scaling (`1 + ln(count)`).
 *
 * 2. **Per-Player Viewport Culling (`planStrategicViewportFx`)**:
 *    Filters cues strictly against each viewer's live camera world frustum (padded by each
 *    cue's own AoE radius / projectile span) so players only draw and hear effects where
 *    they are actually looking on the battlefield.
 *
 * 3. **Zoom-Out Visual & Audio Fade-Out (`strategicFxZoomWeights`)**:
 *    Smoothly attenuates tactical melee/volley animations and sound effects as the camera
 *    zooms out (`camera.scale`), transitioning from crisp close-up sparks/slashes and steel
 *    clashes to muted operational cues and finally silent/minimal theater view.
 *
 * 4. **Screen-Space Deduplication & Strict Polyphony / Draw Caps**:
 *    Further clusters cues in screen-pixel buckets (so zooming out merges adjacent cells)
 *    and enforces hard per-frame visual (`maxVisualCues`) and audio (`maxSoundVoices`)
 *    budgets with priority ranking (`spell > item > volley/charge > melee`), stereo
 *    panning, and distance falloff.
 *
 * 5. **Configurable Scene Coalescence Presets (`StrategicFxCoalescence`)**:
 *    GMs can tune how aggressively simultaneous spells and combat FX merge per scene:
 *    `none` (1:1 up to published/draw caps), `low` (up to 4 casts/cue), `balanced` (up to 16),
 *    `high` (up to 64), or `extreme` (unlimited spatial cell merging for 50k-model mega-battles).
 */
import type {
  HostedFxCue,
  HostedFxPreset,
  Point,
  StrategicFxCoalescence,
} from "./protocol";

export interface StrategicFxCoalescenceProfile {
  level: StrategicFxCoalescence;
  /** Spatial deduplication grid cell size in world feet (`0` = no spatial cell rounding). */
  cellFeet: number;
  /** Maximum raw casts/events merged into a single published or screen-space visual cue. */
  maxMergedPerCue: number;
  /** Hard cap on published FX cues per resolved turn. */
  maxPublishedCues: number;
  /** Hard cap on rendered visual cues per frame. */
  maxVisualCues: number;
  /** Hard cap on simultaneous spatial WebAudio voices per turn burst. */
  maxSoundVoices: number;
  /** Screen-space visual cluster cell size in pixels (`0` = no screen-space merging). */
  visualClusterPx: number;
  /** Screen-space audio cluster cell size in pixels. */
  soundClusterPx: number;
}

export function strategicFxCoalescenceProfile(
  level: StrategicFxCoalescence | undefined = "extreme",
): StrategicFxCoalescenceProfile {
  switch (level) {
    case "none":
      return {
        level: "none",
        cellFeet: 0,
        maxMergedPerCue: 1,
        maxPublishedCues: 320,
        maxVisualCues: 160,
        maxSoundVoices: 14,
        visualClusterPx: 0,
        soundClusterPx: 28,
      };
    case "low":
      return {
        level: "low",
        cellFeet: 10,
        maxMergedPerCue: 4,
        maxPublishedCues: 288,
        maxVisualCues: 128,
        maxSoundVoices: 12,
        visualClusterPx: 14,
        soundClusterPx: 48,
      };
    case "balanced":
      return {
        level: "balanced",
        cellFeet: 15,
        maxMergedPerCue: 16,
        maxPublishedCues: 240,
        maxVisualCues: 96,
        maxSoundVoices: 10,
        visualClusterPx: 24,
        soundClusterPx: 72,
      };
    case "high":
      return {
        level: "high",
        cellFeet: 20,
        maxMergedPerCue: 64,
        maxPublishedCues: 208,
        maxVisualCues: 76,
        maxSoundVoices: 9,
        visualClusterPx: 30,
        soundClusterPx: 84,
      };
    case "extreme":
    default:
      return {
        level: "extreme",
        cellFeet: DEFAULT_FX_CELL_FEET,
        maxMergedPerCue: Number.POSITIVE_INFINITY,
        maxPublishedCues: DEFAULT_MAX_PUBLISHED_FX_CUES,
        maxVisualCues: DEFAULT_MAX_VISUAL_FX_CUES,
        maxSoundVoices: DEFAULT_MAX_SOUND_VOICES,
        visualClusterPx: DEFAULT_VISUAL_CLUSTER_PX,
        soundClusterPx: DEFAULT_SOUND_CLUSTER_PX,
      };
  }
}

export interface RawSimCombatEvent {
  subPhase?: string;
  type: string;
  unitId?: string;
  targetUnitId?: string;
  at?: Point;
  data?: Record<string, unknown>;
}

export interface StrategicFxAggregationInput {
  turnId: number;
  /** Explicit spell & item cues authored during turn resolution. */
  explicitCues: readonly HostedFxCue[];
  /** Raw `SimEvent`s emitted by `massBattlePf1e` (`attack`, `shot`, `opportunity`, `hero-cleave`, `arrive`, `spell`). */
  simEvents?: readonly RawSimCombatEvent[];
  /** Start-of-turn unit centroids (`unitId -> Point | null`) for projectile launch origins. */
  startCentroids?: ReadonlyMap<string, Point | null>;
  /** End-of-turn unit centroids (`unitId -> Point | null`) for impact positions. */
  endCentroids?: ReadonlyMap<string, Point | null>;
  /** Scene-level coalescence aggressiveness preset (default `extreme`). */
  coalescence?: StrategicFxCoalescence;
  /** Spatial deduplication grid cell size in world feet (`0` = no spatial cell rounding). */
  cellFeet?: number;
  /** Maximum raw casts/events merged into a single cue (`Infinity` = unlimited). */
  maxMergedPerCue?: number;
  /** Hard cap on published FX cues per resolved turn so wire metadata stays tiny (default 192). */
  maxPublishedCues?: number;
}

export interface StrategicViewportCamera {
  /** Top-left world X visible on screen (`screenToWorld(0, 0).x`). */
  x: number;
  /** Top-left world Y visible on screen (`screenToWorld(0, 0).y`). */
  y: number;
  /** Pixels per world foot (`camera.scale`). */
  scale: number;
}

export interface StrategicViewportSize {
  width: number;
  height: number;
}

export interface StrategicZoomWeights {
  /** Overall visual opacity multiplier [0 .. 1] for spell/area/item cues. */
  spellVisual: number;
  /** Visual opacity multiplier [0 .. 1] for melee/charge/volley tactical cues (fades out earlier on zoom-out). */
  combatVisual: number;
  /** Audio gain multiplier [0 .. 1] for spell/item sound effects. */
  spellAudio: number;
  /** Audio gain multiplier [0 .. 1] for combat (melee/volley/charge) sound effects. */
  combatAudio: number;
  /** Detail tier: `0` close-up individual sparks/bolts, `1` operational unit arcs/flashes, `2` macro theater. */
  lodTier: 0 | 1 | 2;
}

export interface PlannedVisualFxCue {
  cue: HostedFxCue;
  /** Coalesced count after both world-cell and screen-space clustering. */
  mergedCount: number;
  /** Final visual opacity [0 .. 1] incorporating zoom fade-out. */
  alpha: number;
  /** Bounded radius multiplier (`1 .. 1.65`) for multi-cast / mass-clash emphasis without screen blowout. */
  radiusScale: number;
  /** Current LOD tier (`0` close-up, `1` operational, `2` macro). */
  lodTier: 0 | 1 | 2;
}

export interface PlannedAudioFxVoice {
  id: string;
  preset: HostedFxPreset;
  soundCue: string;
  /** Coalesced event count represented by this single voice. */
  mergedCount: number;
  /** Final gain [0 .. 1] incorporating zoom attenuation, distance falloff, and log-count boost, pre-clamped. */
  gain: number;
  /** Stereo pan [-1 .. +1] relative to the player's viewport center. */
  pan: number;
  /** Stagger offset in milliseconds [0 .. 260] so simultaneous cues form a natural chorus instead of phase-summing. */
  delayMs: number;
}

export interface StrategicViewportFxPlan {
  visuals: PlannedVisualFxCue[];
  voices: PlannedAudioFxVoice[];
  /** Total raw event count inside the player's viewport before clustering/caps. */
  inViewRawCount: number;
  /** Number of cues rejected because they were outside the player's camera frustum. */
  culledOutOfView: number;
  /** Number of in-view cues merged or dropped by spatial deduplication & polyphony caps. */
  coalescedCount: number;
  zoom: StrategicZoomWeights;
}

export const DEFAULT_FX_CELL_FEET = 25;
export const DEFAULT_MAX_PUBLISHED_FX_CUES = 192;
export const DEFAULT_MAX_VISUAL_FX_CUES = 64;
export const DEFAULT_MAX_SOUND_VOICES = 8;
export const DEFAULT_SOUND_CLUSTER_PX = 96;
export const DEFAULT_VISUAL_CLUSTER_PX = 36;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function isSpellOrItemPreset(preset: HostedFxPreset): boolean {
  return preset !== "melee" && preset !== "volley" && preset !== "charge";
}

function presetPriority(preset: HostedFxPreset): number {
  switch (preset) {
    case "fireball":
    case "cone-of-cold":
    case "lightning-bolt":
    case "black-tentacles":
    case "burning-entanglement":
      return 50;
    case "burning-hands":
    case "entangle":
      return 42;
    case "heal":
    case "buff":
      return 34;
    case "volley":
    case "charge":
      return 22;
    case "melee":
      return 15;
  }
}

function defaultSoundCueFor(preset: HostedFxPreset): string {
  switch (preset) {
    case "fireball":
    case "burning-hands":
      return "blast";
    case "lightning-bolt":
      return "thunder";
    case "cone-of-cold":
      return "frost";
    case "entangle":
    case "burning-entanglement":
    case "black-tentacles":
      return "vines";
    case "heal":
      return "chime";
    case "buff":
    case "charge":
      return "horn";
    case "volley":
      return "volley";
    case "melee":
      return "clash";
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function numField(data: Record<string, unknown> | undefined, key: string): number {
  const v = data?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface MutableBucket {
  preset: HostedFxPreset;
  soundCue: string;
  sumX: number;
  sumY: number;
  weightSum: number;
  fromSumX: number;
  fromSumY: number;
  fromCount: number;
  dirSumX: number;
  dirSumY: number;
  dirCount: number;
  maxRadius: number;
  count: number;
  rawImpact: number;
  firstId: string;
}

/**
 * Coalesces explicit spell/item cues AND tens of thousands of raw `SimEvent`s into
 * a compact, spatially deduplicated list of `HostedFxCue`s for a resolved turn.
 */
export function aggregateStrategicFxCues(
  input: StrategicFxAggregationInput,
): HostedFxCue[] {
  const profile = strategicFxCoalescenceProfile(input.coalescence);
  const rawCell = input.cellFeet ?? profile.cellFeet;
  const cellFeet = rawCell <= 0 ? 0 : Math.max(5, rawCell);
  const maxMerged = Math.max(1, input.maxMergedPerCue ?? profile.maxMergedPerCue);
  const maxCues = Math.max(1, input.maxPublishedCues ?? profile.maxPublishedCues);
  const activeBuckets = new Map<string, MutableBucket>();
  const allBuckets: Array<{ bucket: MutableBucket; splitIndex: number; splitSpreadFt: number }> = [];
  const splitCounts = new Map<string, number>();

  const addSample = (sample: {
    id: string;
    preset: HostedFxPreset;
    at: Point;
    from?: Point;
    dir?: Point;
    radius: number;
    count: number;
    impact: number;
    soundCue?: string;
  }): void => {
    if (!Number.isFinite(sample.at.x) || !Number.isFinite(sample.at.y)) return;
    // Directional cones/lines also bucket by coarse octant so opposite-aimed bolts in one cell stay distinct.
    let dirOct = "";
    if (sample.dir && (sample.dir.x !== 0 || sample.dir.y !== 0)) {
      const oct = Math.round((Math.atan2(sample.dir.y, sample.dir.x) / Math.PI) * 4);
      dirOct = `:${oct}`;
    }
    const baseKey =
      cellFeet <= 0
        ? `raw:${allBuckets.length}:${sample.id}`
        : `${sample.preset}:${Math.floor(sample.at.x / cellFeet)},${Math.floor(sample.at.y / cellFeet)}${dirOct}`;

    let remCount = Math.max(1, Math.round(sample.count));
    const unitImpact = Math.max(0, sample.impact) / remCount;
    while (remCount > 0) {
      let b = cellFeet <= 0 ? undefined : activeBuckets.get(baseKey);
      const room = b ? Math.max(0, maxMerged - b.count) : maxMerged;
      if (!b || room <= 0) {
        const splitIdx = splitCounts.get(baseKey) ?? 0;
        splitCounts.set(baseKey, splitIdx + 1);
        b = {
          preset: sample.preset,
          soundCue: sample.soundCue ?? defaultSoundCueFor(sample.preset),
          sumX: 0,
          sumY: 0,
          weightSum: 0,
          fromSumX: 0,
          fromSumY: 0,
          fromCount: 0,
          dirSumX: 0,
          dirSumY: 0,
          dirCount: 0,
          maxRadius: sample.radius,
          count: 0,
          rawImpact: 0,
          firstId: splitIdx === 0 ? sample.id : `${sample.id}-c${splitIdx}`,
        };
        allBuckets.push({
          bucket: b,
          splitIndex: splitIdx,
          splitSpreadFt: Math.min(18, Math.max(3.5, sample.radius * 0.35)),
        });
        if (cellFeet > 0) activeBuckets.set(baseKey, b);
      }
      const take = Number.isFinite(maxMerged) ? Math.min(remCount, Math.max(1, maxMerged - b.count)) : remCount;
      b.sumX += sample.at.x * take;
      b.sumY += sample.at.y * take;
      b.weightSum += take;
      b.count += take;
      b.rawImpact += unitImpact * take;
      if (sample.radius > b.maxRadius) b.maxRadius = sample.radius;
      if (sample.from && Number.isFinite(sample.from.x) && Number.isFinite(sample.from.y)) {
        b.fromSumX += sample.from.x * take;
        b.fromSumY += sample.from.y * take;
        b.fromCount += take;
      }
      if (sample.dir && Number.isFinite(sample.dir.x) && Number.isFinite(sample.dir.y)) {
        b.dirSumX += sample.dir.x * take;
        b.dirSumY += sample.dir.y * take;
        b.dirCount += take;
      }
      remCount -= take;
      if (cellFeet <= 0) break;
    }
  };

  // 1. Fold explicit spell & item cues (e.g. 500 simultaneous fireballs on the same coordinates!)
  const coveredSpellUnits = new Set<string>();
  for (const cue of input.explicitCues) {
    if (cue.turnId !== input.turnId) continue;
    const unitMatch = /^fx-spell-\d+-(.+)$/.exec(cue.id);
    if (unitMatch?.[1]) coveredSpellUnits.add(`${unitMatch[1]}:${cue.preset}`);
    addSample({
      id: cue.id,
      preset: cue.preset,
      at: cue.at,
      ...(cue.from ? { from: cue.from } : {}),
      ...(cue.dir ? { dir: cue.dir } : {}),
      radius: cue.radius,
      count: cue.count ?? 1,
      impact: (cue.intensity ?? 1) * 25,
      ...(cue.soundCue ? { soundCue: cue.soundCue } : {}),
    });
  }

  // 2. Fold raw simulation combat & movement events (`attack`, `shot`, `opportunity`, `hero-cleave`, `arrive`, `spell`)
  const lookupEnd = (unitId: string | undefined): Point | null =>
    (unitId ? input.endCentroids?.get(unitId) ?? input.startCentroids?.get(unitId) : null) ?? null;
  const lookupStart = (unitId: string | undefined): Point | null =>
    (unitId ? input.startCentroids?.get(unitId) ?? input.endCentroids?.get(unitId) : null) ?? null;

  const events = input.simEvents ?? [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const data = ev.data;

    if (ev.type === "attack" || ev.type === "shot") {
      const targetAt = ev.at ?? lookupEnd(ev.targetUnitId) ?? lookupStart(ev.targetUnitId);
      const attackerAt = lookupEnd(ev.unitId) ?? lookupStart(ev.unitId);
      const attacks = Math.max(
        1,
        numField(data, "totalAttacks") || numField(data, "hits") || 1,
      );
      const dmg = numField(data, "netDamageDealt") + numField(data, "killsCount") * 12;
      if (ev.type === "shot") {
        const at = targetAt ?? attackerAt;
        if (!at) continue;
        addSample({
          id: `fx-shot-${input.turnId}-${ev.unitId ?? i}`,
          preset: "volley",
          at,
          ...(attackerAt && (attackerAt.x !== at.x || attackerAt.y !== at.y)
            ? { from: attackerAt }
            : {}),
          radius: 18,
          count: attacks,
          impact: Math.max(4, dmg + attacks * 1.5),
          soundCue: "volley",
        });
      } else {
        const at =
          targetAt && attackerAt
            ? { x: (attackerAt.x + targetAt.x) * 0.5, y: (attackerAt.y + targetAt.y) * 0.5 }
            : (targetAt ?? attackerAt);
        if (!at) continue;
        addSample({
          id: `fx-melee-${input.turnId}-${ev.unitId ?? i}`,
          preset: "melee",
          at,
          ...(attackerAt ? { dir: { x: at.x - attackerAt.x, y: at.y - attackerAt.y } } : {}),
          radius: 14,
          count: attacks,
          impact: Math.max(5, dmg + attacks * 2),
          soundCue: "clash",
        });
      }
      continue;
    }

    if (ev.type === "opportunity" || ev.type === "hero-cleave") {
      const at = ev.at ?? lookupEnd(ev.targetUnitId) ?? lookupEnd(ev.unitId);
      if (!at) continue;
      const dmg = numField(data, "damage") + numField(data, "netDamageDealt");
      addSample({
        id: `fx-react-${input.turnId}-${ev.unitId ?? i}`,
        preset: "melee",
        at,
        radius: 12,
        count: 1,
        impact: Math.max(6, dmg + 4),
        soundCue: "clash",
      });
      continue;
    }

    if (ev.type === "arrive" && data?.pace === "charge") {
      const to = ev.at ?? lookupEnd(ev.unitId);
      const from = lookupStart(ev.unitId);
      if (!to) continue;
      addSample({
        id: `fx-charge-${input.turnId}-${ev.unitId ?? i}`,
        preset: "charge",
        at: to,
        ...(from && (from.x !== to.x || from.y !== to.y) ? { from } : {}),
        radius: 16,
        count: 1,
        impact: 18,
        soundCue: "horn",
      });
      continue;
    }

    if (ev.type === "spell") {
      const rawSpellId = typeof data?.spellId === "string" ? data.spellId : "fireball";
      if (ev.unitId && coveredSpellUnits.has(`${ev.unitId}:${rawSpellId}`)) continue;
      const preset: HostedFxPreset =
        rawSpellId === "burning-hands" ||
        rawSpellId === "lightning-bolt" ||
        rawSpellId === "cone-of-cold" ||
        rawSpellId === "entangle" ||
        rawSpellId === "burning-entanglement" ||
        rawSpellId === "black-tentacles"
          ? rawSpellId
          : "fireball";
      const ex = numField(data, "epicenterX");
      const ey = numField(data, "epicenterY");
      const at =
        typeof data?.epicenterX === "number" && typeof data?.epicenterY === "number"
          ? { x: ex, y: ey }
          : (ev.at ?? lookupEnd(ev.unitId));
      if (!at) continue;
      const radius = Math.max(10, numField(data, "spellRadius") || 20);
      const dmg = numField(data, "damageDealt") + numField(data, "killsCount") * 15;
      addSample({
        id: `fx-simspell-${input.turnId}-${ev.unitId ?? i}`,
        preset,
        at,
        radius,
        count: 1,
        impact: Math.max(25, dmg),
      });
    }
  }

  if (allBuckets.length === 0) return [];

  // 3. Finalize & rank buckets so high-priority spells/volleys/heavy clashes always survive `maxPublishedCues`
  const GOLDEN_ANGLE = 2.399963229728653;
  const ranked = allBuckets.map(({ bucket: b, splitIndex, splitSpreadFt }) => {
    const inv = 1 / Math.max(1, b.weightSum);
    let cx = b.sumX * inv;
    let cy = b.sumY * inv;
    // When `maxMergedPerCue` splits e.g. 500 identical-coordinate fireballs into multiple cues,
    // fan secondary bursts out in a tight deterministic golden-angle spiral so they don't stack 100% identically!
    if (splitIndex > 0) {
      const dist = Math.min(splitSpreadFt * 1.8, Math.sqrt(splitIndex) * (splitSpreadFt * 0.42));
      const ang = splitIndex * GOLDEN_ANGLE;
      cx += Math.cos(ang) * dist;
      cy += Math.sin(ang) * dist;
    }
    const at = { x: round1(cx), y: round1(cy) };
    const from =
      b.fromCount > 0
        ? { x: round1(b.fromSumX / b.fromCount), y: round1(b.fromSumY / b.fromCount) }
        : undefined;
    let dir: Point | undefined;
    if (b.dirCount > 0) {
      const dx = b.dirSumX / b.dirCount;
      const dy = b.dirSumY / b.dirCount;
      const len = Math.hypot(dx, dy);
      if (len > 1e-4) dir = { x: round1(dx / len), y: round1(dy / len) };
    }
    // Bounded logarithmic intensity in [0.25 .. 3.0]
    const intensity =
      Math.round(
        Math.min(
          3,
          Math.max(
            0.25,
            0.55 + Math.log1p(b.count - 1) * 0.35 + Math.log1p(b.rawImpact / 30) * 0.3,
          ),
        ) * 100,
      ) / 100;
    const score =
      presetPriority(b.preset) * 100 + Math.log1p(b.count) * 25 + Math.log1p(b.rawImpact) * 10;
    const cue: HostedFxCue = {
      id: b.firstId,
      turnId: input.turnId,
      preset: b.preset,
      at,
      ...(from ? { from } : {}),
      ...(dir ? { dir } : {}),
      radius: round1(b.maxRadius),
      ...(b.count > 1 ? { count: b.count } : {}),
      intensity,
      soundCue: b.soundCue,
    };
    return { cue, score };
  });

  ranked.sort((a, b) => b.score - a.score || a.cue.id.localeCompare(b.cue.id));
  return ranked.slice(0, maxCues).map((r) => r.cue);
}

/**
 * Computes zoom-dependent visual opacity & audio gain weights from `camera.scale` (px per foot).
 *
 * - Zoomed in (`scale >= 1.5`, ~150%+): full close-up combat & spell detail (`lodTier = 0`).
 * - Operational zoom (`scale ~ 0.35 .. 1.5`): unit-level combat flashes/volleys & attenuated
 *   battlefield sound (`lodTier = 1`).
 * - Theater zoom-out (`scale < 0.35`, down to `0.02`): combat clutter & clashing sounds fade
 *   cleanly to 0 while major spells step down to subtle strategic pulses and fade to silence at
 *   extreme theater zoom (`lodTier = 2`).
 */
export function strategicFxZoomWeights(scale: number): StrategicZoomWeights {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const lodTier: 0 | 1 | 2 = s >= 1.5 ? 0 : s >= 0.35 ? 1 : 2;
  return {
    spellVisual: 0.2 + 0.8 * smoothstep(0.03, 0.75, s),
    combatVisual: smoothstep(0.12, 1.35, s),
    spellAudio: smoothstep(0.06, 0.95, s),
    combatAudio: smoothstep(0.22, 1.65, s),
    lodTier,
  };
}

function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  // Fast AABB reject
  if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX) return false;
  if (Math.max(ay, by) < minY || Math.min(ay, by) > maxY) return false;
  if (ax >= minX && ax <= maxX && ay >= minY && ay <= maxY) return true;
  if (bx >= minX && bx <= maxX && by >= minY && by <= maxY) return true;
  //Liang-Barsky clip
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

/**
 * True iff `cue` (including its AoE radius or projectile/bolt span) intersects the player's
 * current world viewport frustum.
 */
export function cueInCameraViewport(
  cue: HostedFxCue,
  camera: StrategicViewportCamera,
  viewport: StrategicViewportSize,
): boolean {
  if (viewport.width <= 0 || viewport.height <= 0 || !(camera.scale > 0)) return false;
  const minX = camera.x;
  const minY = camera.y;
  const maxX = camera.x + viewport.width / camera.scale;
  const maxY = camera.y + viewport.height / camera.scale;
  const pad = Math.max(15, cue.radius * 1.35);

  if (
    cue.at.x >= minX - pad &&
    cue.at.x <= maxX + pad &&
    cue.at.y >= minY - pad &&
    cue.at.y <= maxY + pad
  ) {
    return true;
  }

  // Projectile volleys & charge trails remain visible if their flight segment crosses the screen
  if (cue.from) {
    if (
      segmentIntersectsRect(
        cue.from.x,
        cue.from.y,
        cue.at.x,
        cue.at.y,
        minX - 15,
        minY - 15,
        maxX + 15,
        maxY + 15,
      )
    ) {
      return true;
    }
  }

  // Directional line/cone spells (`lightning-bolt`, `cone-of-cold`) extend `radius` along `dir`
  if (cue.dir && (cue.dir.x !== 0 || cue.dir.y !== 0)) {
    const len = Math.hypot(cue.dir.x, cue.dir.y) || 1;
    const tipX = cue.at.x + (cue.dir.x / len) * cue.radius;
    const tipY = cue.at.y + (cue.dir.y / len) * cue.radius;
    const widthPad = cue.preset === "lightning-bolt" ? 10 : cue.radius * 0.75;
    if (
      segmentIntersectsRect(
        cue.at.x,
        cue.at.y,
        tipX,
        tipY,
        minX - widthPad,
        minY - widthPad,
        maxX + widthPad,
        maxY + widthPad,
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Per-player viewport FX & spatial audio planner.
 *
 * - Discriminates strictly by where THIS player's camera is currently looking (`cueInCameraViewport`).
 * - Applies zoom-out visual & audio attenuation (`strategicFxZoomWeights`).
 * - Clusters nearby effects in screen-pixel space so zooming out merges overlapping effects
 *   instead of stacking hundreds of animations or sounds on the same pixel.
 * - Enforces hard `maxVisualCues` and `maxSoundVoices` concurrency caps.
 */
export function planStrategicViewportFx(input: {
  cues: readonly HostedFxCue[];
  turnId: number;
  camera: StrategicViewportCamera;
  viewport: StrategicViewportSize;
  coalescence?: StrategicFxCoalescence;
  maxMergedPerCue?: number;
  maxVisualCues?: number;
  maxSoundVoices?: number;
  visualClusterPx?: number;
  soundClusterPx?: number;
  muteSound?: boolean;
  masterVolume?: number;
}): StrategicViewportFxPlan {
  const profile = strategicFxCoalescenceProfile(input.coalescence);
  const zoom = strategicFxZoomWeights(input.camera.scale);
  const maxMerged = Math.max(1, input.maxMergedPerCue ?? profile.maxMergedPerCue);
  const maxVisuals = Math.max(0, input.maxVisualCues ?? profile.maxVisualCues);
  const maxVoices =
    input.muteSound === true
      ? 0
      : Math.max(0, input.maxSoundVoices ?? profile.maxSoundVoices);
  const masterVol = clamp01(input.masterVolume ?? 1);
  const rawVisCell = input.visualClusterPx ?? profile.visualClusterPx;
  const visCellPx = rawVisCell <= 0 ? 0 : Math.max(6, rawVisCell);
  const sndCellPx = Math.max(18, input.soundClusterPx ?? profile.soundClusterPx);

  let culledOutOfView = 0;
  let inViewRawCount = 0;
  const inView: HostedFxCue[] = [];

  for (const cue of input.cues) {
    if (cue.turnId !== input.turnId) continue;
    if (!cueInCameraViewport(cue, input.camera, input.viewport)) {
      culledOutOfView++;
      continue;
    }
    inView.push(cue);
    inViewRawCount += Math.max(1, cue.count ?? 1);
  }

  // Screen-space visual clustering: merge cues of the same preset landing in the same screen cell
  interface VisCluster {
    rep: HostedFxCue;
    repScore: number;
    mergedCount: number;
    maxRadius: number;
    maxIntensity: number;
  }
  const activeVis = new Map<string, VisCluster>();
  const allVis: VisCluster[] = [];
  for (const cue of inView) {
    const isSpell = isSpellOrItemPreset(cue.preset);
    const baseAlpha = isSpell ? zoom.spellVisual : zoom.combatVisual;
    if (baseAlpha <= 0.015) continue;

    const cCount = Math.max(1, cue.count ?? 1);
    const cInt = cue.intensity ?? 1;
    const score = presetPriority(cue.preset) * 100 + Math.log1p(cCount) * 20 + cInt * 10;

    if (visCellPx <= 0) {
      allVis.push({
        rep: cue,
        repScore: score,
        mergedCount: cCount,
        maxRadius: cue.radius,
        maxIntensity: cInt,
      });
      continue;
    }

    const sx = (cue.at.x - input.camera.x) * input.camera.scale;
    const sy = (cue.at.y - input.camera.y) * input.camera.scale;
    const bx = Math.floor(sx / visCellPx);
    const by = Math.floor(sy / visCellPx);
    const key = `${cue.preset}:${bx},${by}`;

    const existing = activeVis.get(key);
    if (!existing || existing.mergedCount + cCount > maxMerged) {
      const vc: VisCluster = {
        rep: cue,
        repScore: score,
        mergedCount: cCount,
        maxRadius: cue.radius,
        maxIntensity: cInt,
      };
      allVis.push(vc);
      activeVis.set(key, vc);
    } else {
      existing.mergedCount += cCount;
      if (cue.radius > existing.maxRadius) existing.maxRadius = cue.radius;
      if (cInt > existing.maxIntensity) existing.maxIntensity = cInt;
      if (score > existing.repScore) {
        existing.rep = cue;
        existing.repScore = score;
      }
    }
  }

  const sortedVis = allVis.sort((a, b) => {
    const scoreA = a.repScore + Math.log1p(a.mergedCount) * 15;
    const scoreB = b.repScore + Math.log1p(b.mergedCount) * 15;
    return scoreB - scoreA || a.rep.id.localeCompare(b.rep.id);
  });

  const visuals: PlannedVisualFxCue[] = sortedVis.slice(0, maxVisuals).map((vc) => {
    const isSpell = isSpellOrItemPreset(vc.rep.preset);
    const zoomFactor = isSpell ? zoom.spellVisual : zoom.combatVisual;
    const intensityBoost = Math.min(1.25, 0.8 + vc.maxIntensity * 0.18);
    const alpha = clamp01(zoomFactor * intensityBoost);
    const radiusScale = Math.min(1.65, 1 + Math.log1p(vc.mergedCount - 1) * 0.085);
    return {
      cue:
        vc.maxRadius !== vc.rep.radius
          ? { ...vc.rep, radius: vc.maxRadius }
          : vc.rep,
      mergedCount: vc.mergedCount,
      alpha,
      radiusScale,
      lodTier: zoom.lodTier,
    };
  });

  // Screen-space audio clustering & listener attenuation around the player's viewport center
  const voices: PlannedAudioFxVoice[] = [];
  if (maxVoices > 0 && masterVol > 0.005) {
    interface SndCluster {
      rep: HostedFxCue;
      soundCue: string;
      mergedCount: number;
      bestScore: number;
      sx: number;
      sy: number;
    }
    const sndClusters = new Map<string, SndCluster>();
    const halfW = Math.max(1, input.viewport.width * 0.5);
    const halfH = Math.max(1, input.viewport.height * 0.5);
    const maxScreenDist = Math.hypot(halfW, halfH) * 1.25;

    for (const cue of inView) {
      const isSpell = isSpellOrItemPreset(cue.preset);
      const zoomAudio = isSpell ? zoom.spellAudio : zoom.combatAudio;
      if (zoomAudio <= 0.015) continue;

      const soundCue = cue.soundCue ?? defaultSoundCueFor(cue.preset);
      const sx = (cue.at.x - input.camera.x) * input.camera.scale;
      const sy = (cue.at.y - input.camera.y) * input.camera.scale;
      const distPx = Math.hypot(sx - halfW, sy - halfH);
      const distGain = clamp01(1 - (distPx / maxScreenDist) * 0.78);
      if (distGain <= 0.02) continue;

      const bx = Math.floor(sx / sndCellPx);
      const by = Math.floor(sy / sndCellPx);
      const key = `${soundCue}:${bx},${by}`;
      const cCount = Math.max(1, cue.count ?? 1);
      const score =
        presetPriority(cue.preset) * 100 +
        distGain * 45 +
        Math.log1p(cCount) * 18 +
        (cue.intensity ?? 1) * 8;

      const existing = sndClusters.get(key);
      if (!existing) {
        sndClusters.set(key, {
          rep: cue,
          soundCue,
          mergedCount: cCount,
          bestScore: score,
          sx,
          sy,
        });
      } else {
        existing.mergedCount += cCount;
        if (score > existing.bestScore) {
          existing.rep = cue;
          existing.bestScore = score;
          existing.sx = sx;
          existing.sy = sy;
        }
      }
    }

    const sortedSnd = [...sndClusters.values()].sort(
      (a, b) => b.bestScore - a.bestScore || a.rep.id.localeCompare(b.rep.id),
    );
    const chosen = sortedSnd.slice(0, maxVoices);
    // Soft polyphony headroom scale so 8 simultaneous voices never clip before the compressor
    const headroom = chosen.length > 1 ? 1 / Math.sqrt(chosen.length * 0.65) : 1;

    chosen.forEach((sc, idx) => {
      const isSpell = isSpellOrItemPreset(sc.rep.preset);
      const zoomAudio = isSpell ? zoom.spellAudio : zoom.combatAudio;
      const distPx = Math.hypot(sc.sx - halfW, sc.sy - halfH);
      const distGain = clamp01(1 - (distPx / maxScreenDist) * 0.78);
      // Logarithmic chorus boost: 500 fireballs on one spot is slightly fuller (+28% max), NEVER 500x louder!
      const countBoost = Math.min(1.28, 0.82 + Math.log1p(sc.mergedCount) * 0.08);
      const baseTypeGain = isSpell ? 0.58 : 0.36;
      const gain = clamp01(baseTypeGain * zoomAudio * distGain * countBoost * headroom * masterVol);
      if (gain <= 0.01) return;
      const pan = Math.max(-0.9, Math.min(0.9, (sc.sx - halfW) / halfW));
      voices.push({
        id: sc.rep.id,
        preset: sc.rep.preset,
        soundCue: sc.soundCue,
        mergedCount: sc.mergedCount,
        gain: Math.round(gain * 1000) / 1000,
        pan: Math.round(pan * 100) / 100,
        delayMs: idx * 28,
      });
    });
  }

  const coalescedCount = Math.max(0, inViewRawCount - visuals.length);
  return {
    visuals,
    voices,
    inViewRawCount,
    culledOutOfView,
    coalescedCount,
    zoom,
  };
}
