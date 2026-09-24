/**
 * D-297 (SQ-09/SQ-17) — what is playing **on this device**.
 *
 * Two different truths exist about a live sound, and conflating them would be a lie.
 * The host owns the durable instances a GM can stop for the whole table (the Live FX
 * manager, `fx.stop`/`fx.stopMatching`). This registry is the *local* half: the
 * elements this browser is actually playing right now — a one-shot sting that no
 * longer exists anywhere, or a persistent loop someone else may still hear. Stopping
 * here silences this device and nothing else, which is exactly what SQ-09's
 * "per-user/local routing" asks for and the opposite of turning off another player's
 * effect (SQ-16).
 *
 * It is a module-level registry rather than a prop because the panel that needs it
 * (the device FX settings) lives in two different shells with no shared parent, and
 * because the player that fills it must not keep a UI reference alive.
 */
import { SOUND_CHANNEL_LABELS, isSoundChannel, type FxSoundChannel } from "../core/fxSound";

export interface LiveFxSound {
  /** `runId:index` — stable while this element lives, so a panel can key rows on it. */
  id: string;
  runId: string;
  index: number;
  /** What the asset is called in the world's registry, when it is known. */
  name: string | null;
  channel: FxSoundChannel;
  /** The gain this device is applying right now (volume × channel mix × fade). */
  gain: number;
  /** A persistent loop keeps playing until stopped; a one-shot ends on its own. */
  persistent: boolean;
  startedAt: number;
}

interface Registration extends LiveFxSound {
  stop: () => void;
}

const registrations = new Map<string, Registration>();
const listeners = new Set<(sounds: LiveFxSound[]) => void>();
/** Never let a runaway timeline turn this into an unbounded list. */
const MAX_LIVE_SOUNDS = 64;

/** The list without the teardown closures: a panel never gets a way to stop by hand. */
function snapshot(): LiveFxSound[] {
  const out: LiveFxSound[] = [];
  const sorted = [...registrations.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const { id, runId, index, name, channel, gain, persistent, startedAt } of sorted) {
    out.push({ id, runId, index, name, channel, gain, persistent, startedAt });
  }
  return out;
}

function emit(): void {
  const sounds = snapshot();
  for (const listener of [...listeners]) listener(sounds);
}

/**
 * Register a playing element; the returned function removes it (idempotent).
 *
 * The removal is **identity-checked**: a stopped run may legitimately reuse its own
 * ID (the player keeps a run epoch for exactly that reason), and the old element's
 * teardown must not delete the new one's row. A run that reuses an ID is a different
 * element even when the key matches.
 */
export function registerFxSound(entry: Registration): () => void {
  registrations.set(entry.id, entry);
  // Oldest first: a stuck loop must not starve a new cue out of the list.
  while (registrations.size > MAX_LIVE_SOUNDS) {
    const first = registrations.keys().next().value;
    if (first === undefined) break;
    registrations.delete(first);
  }
  emit();
  return () => {
    if (registrations.get(entry.id) !== entry) return; // someone else owns this row now
    registrations.delete(entry.id);
    emit();
  };
}

/** Update the gain a live element is applying (a mix change mid-playback). */
export function setFxSoundGain(id: string, gain: number): void {
  const entry = registrations.get(id);
  if (!entry || !Number.isFinite(gain)) return;
  const next = Math.min(1, Math.max(0, gain));
  if (next === entry.gain) return;
  entry.gain = next;
  emit();
}

export function fxSounds(): LiveFxSound[] {
  return snapshot();
}

export function subscribeFxSounds(listener: (sounds: LiveFxSound[]) => void): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

/**
 * Stop what this device is playing — everything, one run's cues, or one channel.
 * Returns how many elements were stopped so a caller can say so honestly.
 */
export function stopFxSounds(filter: { runId?: string; channel?: FxSoundChannel } = {}): number {
  if (filter.channel !== undefined && !isSoundChannel(filter.channel)) return 0;
  let stopped = 0;
  for (const entry of [...registrations.values()]) {
    if (filter.runId !== undefined && entry.runId !== filter.runId) continue;
    if (filter.channel !== undefined && entry.channel !== filter.channel) continue;
    registrations.delete(entry.id);
    try {
      entry.stop();
    } catch {
      // A half-torn-down element must not block the rest of the list.
    }
    stopped += 1;
  }
  if (stopped > 0) emit();
  return stopped;
}

/** Test/turn-down helper: drop the list without calling stops (the player owns those). */
export function resetFxSounds(): void {
  registrations.clear();
  listeners.clear();
}

export function fxSoundLabel(name: string | null, channel: FxSoundChannel): string {
  const label = SOUND_CHANNEL_LABELS[channel];
  return name ? `${name} · ${label}` : label;
}
