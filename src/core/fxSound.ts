/**
 * D-297 (SQ-09/SQ-16) — the sound half of a timeline: channels, a per-viewer mix,
 * and the fade curve.
 *
 * A sound section used to be `assetId + volume`, which is enough to make a noise and
 * not enough to mix one: a table wants the ambient loop quieter than the sting, and
 * a viewer on a phone wants the music off without losing the dice. This module is the
 * pure policy those two needs share — which channel a sound belongs to, what this
 * device's mix is, and what the gain is at a given moment of a section.
 *
 * `normalizeSoundMix` is total (a hand-edited or older value must never yield `NaN`
 * or an unbounded channel), and the mix is *device-local* by construction: it is
 * stored next to the other FX preferences and never sent anywhere (SQ-16: per-client
 * mix "without altering authoritative mechanics or turning off other users' effects").
 */
export type FxSoundChannel = "sfx" | "music" | "ambience" | "voice";

/** Declaration order = the order the mix panel and the manager list show. */
export const SOUND_CHANNELS: readonly FxSoundChannel[] = ["sfx", "music", "ambience", "voice"];
export const SOUND_DEFAULT_CHANNEL: FxSoundChannel = "sfx";
export const SOUND_CHANNEL_LABELS: Record<FxSoundChannel, string> = {
  sfx: "Effects",
  music: "Music",
  ambience: "Ambience",
  voice: "Voice",
};

export function isSoundChannel(value: unknown): value is FxSoundChannel {
  return typeof value === "string" && (SOUND_CHANNELS as readonly string[]).includes(value);
}

/** The channel a section plays on; an absent/unknown one is an effect. */
export function soundChannelOf(section: { channel?: FxSoundChannel }): FxSoundChannel {
  return isSoundChannel(section.channel) ? section.channel : SOUND_DEFAULT_CHANNEL;
}

export interface SoundMix {
  /** The master switch the "Mute FX sounds" checkbox owns. */
  muted: boolean;
  /** Per-channel gain 0–1; every channel defaults to full. */
  channels: Record<FxSoundChannel, number>;
}

export const DEFAULT_SOUND_MIX: SoundMix = {
  muted: false,
  channels: { sfx: 1, music: 1, ambience: 1, voice: 1 },
};

function gain(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Total: unknown/partial/hostile input becomes the documented defaults. */
export function normalizeSoundMix(raw: unknown): SoundMix {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const channels = record["channels"] && typeof record["channels"] === "object"
    ? record["channels"] as Record<string, unknown> : {};
  return {
    muted: record["muted"] === true,
    channels: {
      sfx: gain(channels["sfx"], DEFAULT_SOUND_MIX.channels.sfx),
      music: gain(channels["music"], DEFAULT_SOUND_MIX.channels.music),
      ambience: gain(channels["ambience"], DEFAULT_SOUND_MIX.channels.ambience),
      voice: gain(channels["voice"], DEFAULT_SOUND_MIX.channels.voice),
    },
  };
}

/**
 * The fade multiplier at `elapsedMs` into a section.
 *
 * A fade-in ramps 0→1 over its own length and a fade-out ramps 1→0 over the *last*
 * `fadeOutMs` of the section, and where the two overlap the quieter one wins — a
 * short sound with both fades is a blip, not a fight. Outside the section (before it,
 * or after a one-shot's duration) the gain is 0, so a stale timer can never produce a
 * blip of sound.
 *
 * `loop` is the persistent case: a loop fades in once and then holds, because a loop
 * that faded out would go silent at the end of every cycle rather than when the GM
 * stops it.
 */
export function soundFadeGain(input: {
  elapsedMs: number;
  durationMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  loop?: boolean;
}): number {
  const { elapsedMs, durationMs } = input;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || elapsedMs < 0) return 0;
  const fadeIn = Number.isFinite(input.fadeInMs) ? Math.max(0, input.fadeInMs as number) : 0;
  const fadeOut = Number.isFinite(input.fadeOutMs) ? Math.max(0, input.fadeOutMs as number) : 0;
  const inGain = fadeIn <= 0 ? 1 : Math.min(1, elapsedMs / fadeIn);
  if (input.loop === true) return inGain;
  if (elapsedMs >= durationMs) return 0;
  const remaining = durationMs - elapsedMs;
  const outGain = fadeOut <= 0 ? 1 : Math.min(1, remaining / fadeOut);
  return Math.min(inGain, outGain);
}

/**
 * What this device should actually play: the author's volume × the viewer's channel
 * mix × the fade. Zero means "this viewer cannot hear it" — the player skips the cue
 * (and does not fetch its bytes) rather than starting a silent element.
 */
export function soundGain(input: {
  volume?: number;
  channel?: FxSoundChannel;
  mix: SoundMix;
  fade?: number;
}): number {
  if (input.mix.muted) return 0;
  const channel = isSoundChannel(input.channel) ? input.channel : SOUND_DEFAULT_CHANNEL;
  const volume = gain(input.volume, 1);
  const fade = input.fade === undefined ? 1 : gain(input.fade, 1);
  return Math.min(1, Math.max(0, volume * input.mix.channels[channel] * fade));
}

/** One line for the local sound list: what is playing, on which channel. */
export function soundSummary(input: { name?: string | null; channel: FxSoundChannel }): string {
  const label = SOUND_CHANNEL_LABELS[input.channel];
  const name = (input.name ?? "").trim();
  return name ? `${name} · ${label}` : label;
}

/**
 * Whether a whole cue is inaudible to this viewer — every sound on a silenced
 * channel (or the master mute) and nothing else audible. Used only for a report
 * line: a title card with no sound is not "muted", it is silent by design.
 */
export function cueSilentForViewer(sections: readonly { kind: string; channel?: FxSoundChannel;
  volume?: number }[], mix: SoundMix): boolean {
  const sounds = sections.filter((section) => section.kind === "sound");
  if (sounds.length === 0) return false;
  return sounds.every((section) => soundGain({
    ...(section.volume !== undefined ? { volume: section.volume } : {}),
    ...(section.channel !== undefined ? { channel: section.channel } : {}),
    mix,
  }) === 0);
}

// ─── D-309: where a sound is, and who is listening (SQ-09) ───────────────────
//
// A cue used to be everywhere: every viewer heard the same thing at the same gain,
// which is exactly wrong for a fountain, a footstep or a chant coming from a shrine.
// Two facts decide what one viewer hears — how far away the source is *for them*, and
// whether a wall is in the way — and neither is the host's to answer alone: the host
// owns the walls (a client is never handed them, D-301/D-307) while only the client
// knows where it is listening from. So the host resolves the source and answers the
// occlusion question per recipient, and the client does the arithmetic below.

/** A positional sound's radius, in scene units: audible at the source, silent at the rim. */
export const SOUND_RADIUS_LIMITS = { min: 1, max: 1_000 } as const;

/**
 * The low-pass a muffled sound sits behind (Hz). The number is the *dull* end of a
 * closed door, not a wall of wool: speech stays intelligible through it, which is what
 * a table wants from "you hear it through the wall".
 */
export const MUFFLE_CUTOFF_HZ = 700;
/** Above this the filter is a pass-through: a bypass without rewiring the graph. */
export const MUFFLE_OPEN_HZ = 20_000;

/**
 * Distance attenuation: full volume at the source, silence at the rim, straight line
 * between. A linear falloff is the *predictable* one — an author placing a 60 ft radius
 * can look at the map and know where it stops, which inverse-square alone would not
 * tell them (and it would be unbounded at the source).
 *
 * Nothing usable to measure from (no position, no radius, a non-finite distance) means
 * **global**: the sound plays at its authored volume, exactly as it did before D-309.
 */
export function positionalGain(distancePx: number, radiusPx: number): number {
  if (!Number.isFinite(distancePx) || !Number.isFinite(radiusPx) || radiusPx <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - distancePx / radiusPx));
}

/**
 * Stereo position: −1 hard left … +1 hard right, from the source's own x offset in
 * **screen space** (the camera has no rotation, so world x grows right for every
 * viewer). At the rim of the radius the source is fully to one side — where it is also
 * inaudible, so the exaggeration is never heard.
 */
export function positionalPan(dxPx: number, radiusPx: number): number {
  if (!Number.isFinite(dxPx) || !Number.isFinite(radiusPx) || radiusPx <= 0) return 0;
  return Math.min(1, Math.max(-1, dxPx / radiusPx));
}

/** What one listener hears of one section: the three facts the player applies. */
export interface SoundSpatial {
  /** Multiplied into the author's volume, this device's mix and the fade. */
  gain: number;
  /** −1 … +1, applied only when the author asked for `pan`. */
  pan: number;
  /** A wall stands between the source and this listener (`muffle` + the host's `occluded`). */
  muffled: boolean;
}

const GLOBAL: SoundSpatial = { gain: 1, pan: 0, muffled: false };

/**
 * The whole rule, in one pure place: a positioned section heard from a listener.
 * `listener` is the viewer's own token when they have one on this scene, and otherwise
 * where their view is centred — see `FxPlayer.listener`.
 */
export function soundSpatial(
  section: { x?: number; y?: number; radiusPx?: number; pan?: boolean; muffle?: boolean; occluded?: boolean },
  listener: { x: number; y: number } | null,
): SoundSpatial {
  if (!Number.isFinite(section.x) || !Number.isFinite(section.y) ||
      typeof section.radiusPx !== "number" || !(section.radiusPx > 0) || !listener) return GLOBAL;
  const dx = (section.x as number) - listener.x;
  const dy = (section.y as number) - listener.y;
  return {
    gain: positionalGain(Math.hypot(dx, dy), section.radiusPx),
    pan: section.pan === true ? positionalPan(dx, section.radiusPx) : 0,
    muffled: section.muffle === true && section.occluded === true,
  };
}

/**
 * Does this cue ask for anything an `<audio>` element cannot do by itself? If so the
 * player wires it through a Web Audio graph — and a device without one reports the
 * reduction rather than pretending (SQ-16's "do not offer a control that silently
 * does nothing" cuts both ways: it also must not *silently degrade*).
 */
export function soundNeedsGraph(
  section: { pan?: boolean; muffle?: boolean; occluded?: boolean },
): boolean {
  return section.pan === true || (section.muffle === true && section.occluded === true);
}
