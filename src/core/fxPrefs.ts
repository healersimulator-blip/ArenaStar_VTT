/**
 * D-295 (SQ-13/A10) — per-viewer FX preferences, stored **on this device only**.
 *
 * Two rules shape this file. First, every knob here is a *local* choice: muting an
 * FX sound or reducing camera motion must never turn off another player's effect,
 * and nothing here is ever sent to the host or written into a document (SQ-16 asks
 * for exactly that: "without altering authoritative mechanics or turning off other
 * users' effects"). Second, the values are remembered per browser profile, like the
 * GM's other view preferences — a player who muted sounds on a phone should not
 * have to mute them again after a reconnect.
 *
 * `normalizeFxViewPrefs` is deliberately total: a hand-edited or older stored value
 * must never produce `NaN`, an unbounded preload window or an unknown fallback mode.
 */
import type { AssetManifestEntry } from "./documents";

export interface FxViewPrefs {
  /**
   * Camera cues do not animate on this device: a pan **cuts** to its resolved
   * destination and a shake is skipped entirely. A cut is still the cue the GM
   * asked for (the table looks at the right place) without the motion.
   */
  reduceMotion: boolean;
  /** Sound sections do not start on this device; visuals in the same timeline still do. */
  muteSound: boolean;
  /** How far ahead of a section's start this client may prefetch its media (0–8000 ms). */
  preloadAheadMs: number;
  /**
   * What to do when a section's media is not in hand at its start time:
   * `delay` starts it as soon as the bytes arrive (the frame jumps to the right
   * phase), `skip` drops that cue so every viewer stays frame-aligned. Either way
   * the degradation is reported to the viewer.
   */
  lateMedia: "delay" | "skip";
}

export const FX_VIEW_PREFS_KEY = "vtt-fx-view-prefs";
/** 8 s is the longest preload window: beyond that a "preload" is a download. */
export const MAX_PRELOAD_AHEAD_MS = 8_000;

export const DEFAULT_FX_VIEW_PREFS: FxViewPrefs = {
  reduceMotion: false,
  muteSound: false,
  preloadAheadMs: 2_000,
  lateMedia: "delay",
};

/** Storage subset this module needs — `localStorage`, or a test double. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Total: unknown/partial/hostile input becomes the documented defaults. */
export function normalizeFxViewPrefs(raw: unknown): FxViewPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FX_VIEW_PREFS };
  const record = raw as Record<string, unknown>;
  return {
    reduceMotion: record["reduceMotion"] === true,
    muteSound: record["muteSound"] === true,
    preloadAheadMs: clampInt(record["preloadAheadMs"], 0, MAX_PRELOAD_AHEAD_MS,
      DEFAULT_FX_VIEW_PREFS.preloadAheadMs),
    lateMedia: record["lateMedia"] === "skip" ? "skip" : "delay",
  };
}

/**
 * The OS-level "reduce motion" switch, when the shell can read it. It only seeds the
 * *default* for a profile that has never chosen: a viewer who turns motion back on
 * must not have it silently re-disabled on the next load.
 */
export function prefersReducedMotion(query: ((media: string) => { matches: boolean }) | null =
  typeof globalThis.matchMedia === "function" ? (media: string) => globalThis.matchMedia(media) : null,
): boolean {
  try {
    return query?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

function storageOrNull(storage?: PrefsStorage | null): PrefsStorage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readFxViewPrefs(storage?: PrefsStorage | null): FxViewPrefs {
  const target = storageOrNull(storage);
  if (!target) return { ...DEFAULT_FX_VIEW_PREFS, reduceMotion: prefersReducedMotion() };
  try {
    const raw = target.getItem(FX_VIEW_PREFS_KEY);
    if (raw === null) return { ...DEFAULT_FX_VIEW_PREFS, reduceMotion: prefersReducedMotion() };
    return normalizeFxViewPrefs(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_FX_VIEW_PREFS };
  }
}

// ─── Module-level current prefs + change subscription ─────────────────────────

let current: FxViewPrefs | null = null;
const listeners = new Set<(prefs: FxViewPrefs) => void>();

/** The live value for this page: loaded once, then whatever the viewer last chose. */
export function fxViewPrefs(): FxViewPrefs {
  current ??= readFxViewPrefs();
  return current;
}

/** Write a partial change (persisting it) and tell every subscriber. */
export function setFxViewPrefs(patch: Partial<FxViewPrefs>, storage?: PrefsStorage | null): FxViewPrefs {
  const next = normalizeFxViewPrefs({ ...fxViewPrefs(), ...patch });
  current = next;
  const target = storageOrNull(storage);
  try {
    target?.setItem(FX_VIEW_PREFS_KEY, JSON.stringify(next));
  } catch {
    // A shell without storage still gets the change for this visit.
  }
  for (const listener of [...listeners]) listener(next);
  return next;
}

export function subscribeFxViewPrefs(listener: (prefs: FxViewPrefs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Registry fitness (SQ-13: pack missing / unsupported codec / audience) ────

/** What this browser can decode: `<audio|video>.canPlayType` returns "" when it cannot. */
export type CanPlay = (mime: string) => string | undefined;

export type FxAssetFitness = "ready" | "missing" | "unsupported-codec";

/** Does this client's registry have the media, and can this browser decode it? */
export function fxAssetFitness(
  entry: Pick<AssetManifestEntry, "mime"> | undefined,
  mime: string,
  canPlay?: CanPlay | null,
): FxAssetFitness {
  if (!entry) return "missing";
  if (!canPlay) return "ready";
  const kind = entry.mime.startsWith("audio/") ? "audio" : entry.mime.startsWith("video/") ? "video" : null;
  if (kind === null) return "ready"; // images are decoded by `Image.decode`, not canPlayType
  try {
    return (canPlay(entry.mime || mime) ?? "") === "" ? "unsupported-codec" : "ready";
  } catch {
    return "ready"; // a probe that throws must not block playback
  }
}

/**
 * `canPlayType` needs a real element; a shell without `document` (unit tests, a
 * worker) reports "no opinion" rather than guessing. Probes are per-mime and cached —
 * asking the DOM on every cue of every timeline is a needless layout hit.
 */
export function domCanPlay(): CanPlay | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const cache = new Map<string, string>();
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  return (mime: string) => {
    const hit = cache.get(mime);
    if (hit !== undefined) return hit;
    let answer: string;
    try {
      answer = mime.startsWith("audio/") ? audio.canPlayType(mime) : video.canPlayType(mime);
    } catch {
      answer = ""; // a probe that throws is "no opinion", not a refusal
    }
    cache.set(mime, answer);
    return answer;
  };
}
