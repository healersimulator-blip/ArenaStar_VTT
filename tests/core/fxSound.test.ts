/**
 * D-297 (SQ-09/SQ-16) — the sound policy: channels, the device-local mix, and the
 * fade curve. All pure, so these are the values the player and the panel both read.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SOUND_MIX, SOUND_CHANNELS, SOUND_CHANNEL_LABELS, SOUND_DEFAULT_CHANNEL, cueSilentForViewer,
  isSoundChannel, normalizeSoundMix, soundChannelOf, soundFadeGain, soundGain, soundSummary,
  type SoundMix,
} from "../../src/core/fxSound";

const mix = (patch: Partial<SoundMix["channels"]> = {}, muted = false): SoundMix =>
  ({ muted, channels: { ...DEFAULT_SOUND_MIX.channels, ...patch } });

describe("channels", () => {
  test("the four channels have labels and a declared order", () => {
    expect(SOUND_CHANNELS).toEqual(["sfx", "music", "ambience", "voice"]);
    for (const channel of SOUND_CHANNELS) expect(SOUND_CHANNEL_LABELS[channel]).toBeTruthy();
    expect(SOUND_DEFAULT_CHANNEL).toBe("sfx");
  });

  test("an absent or unknown channel is an effect, never an error at play time", () => {
    expect(soundChannelOf({})).toBe("sfx");
    expect(soundChannelOf({ channel: "music" })).toBe("music");
    // A hostile value can only arrive from an unvalidated import; the host rejects
    // those (`validateFxSequence`), and the client still fails safe to sfx.
    expect(soundChannelOf({ channel: "bass" as never })).toBe("sfx");
    expect(isSoundChannel("voice")).toBe(true);
    expect(isSoundChannel("bass")).toBe(false);
    expect(isSoundChannel(3)).toBe(false);
  });
});

describe("normalizeSoundMix", () => {
  test("total: junk, partial and hostile values become bounded gains", () => {
    expect(normalizeSoundMix(null)).toEqual(DEFAULT_SOUND_MIX);
    expect(normalizeSoundMix({ channels: "nope" })).toEqual(DEFAULT_SOUND_MIX);
    expect(normalizeSoundMix({ muted: "yes", channels: { music: "loud" } }))
      .toEqual({ muted: false, channels: { ...DEFAULT_SOUND_MIX.channels } });
    expect(normalizeSoundMix({ muted: true, channels: { music: 0, sfx: 5, ambience: -2, voice: 0.25 } }))
      .toEqual({ muted: true, channels: { sfx: 1, music: 0, ambience: 0, voice: 0.25 } });
    expect(normalizeSoundMix({ channels: { music: Number.NaN } }).channels.music).toBe(1);
  });
});

describe("soundFadeGain", () => {
  test("no fades means full gain for the whole section, and nothing outside it", () => {
    expect(soundFadeGain({ elapsedMs: 0, durationMs: 1_000 })).toBe(1);
    expect(soundFadeGain({ elapsedMs: 999, durationMs: 1_000 })).toBe(1);
    expect(soundFadeGain({ elapsedMs: 1_000, durationMs: 1_000 })).toBe(0); // a one-shot has ended
    expect(soundFadeGain({ elapsedMs: -5, durationMs: 1_000 })).toBe(0);
    expect(soundFadeGain({ elapsedMs: Number.NaN, durationMs: 1_000 })).toBe(0);
  });

  test("a fade-in ramps from silence and reaches full at its own length", () => {
    const fadeInMs = 400;
    expect(soundFadeGain({ elapsedMs: 0, durationMs: 2_000, fadeInMs })).toBe(0);
    expect(soundFadeGain({ elapsedMs: 100, durationMs: 2_000, fadeInMs })).toBeCloseTo(0.25, 6);
    expect(soundFadeGain({ elapsedMs: 200, durationMs: 2_000, fadeInMs })).toBeCloseTo(0.5, 6);
    expect(soundFadeGain({ elapsedMs: 400, durationMs: 2_000, fadeInMs })).toBe(1);
    expect(soundFadeGain({ elapsedMs: 1_500, durationMs: 2_000, fadeInMs })).toBe(1);
  });

  test("a fade-out ramps over the last stretch of the section", () => {
    const fadeOutMs = 500;
    expect(soundFadeGain({ elapsedMs: 1_000, durationMs: 2_000, fadeOutMs })).toBe(1);
    expect(soundFadeGain({ elapsedMs: 1_500, durationMs: 2_000, fadeOutMs })).toBeCloseTo(1, 6);
    expect(soundFadeGain({ elapsedMs: 1_750, durationMs: 2_000, fadeOutMs })).toBeCloseTo(0.5, 6);
    expect(soundFadeGain({ elapsedMs: 2_000, durationMs: 2_000, fadeOutMs })).toBe(0);
  });

  test("overlapping fades take the quieter one, so a short blip is a blip", () => {
    const shape = { durationMs: 300, fadeInMs: 200, fadeOutMs: 200 };
    expect(soundFadeGain({ ...shape, elapsedMs: 50 })).toBeCloseTo(0.25, 6); // fade-in is smaller
    expect(soundFadeGain({ ...shape, elapsedMs: 150 })).toBeCloseTo(0.75, 6); // min(0.75, 0.75)
    expect(soundFadeGain({ ...shape, elapsedMs: 250 })).toBeCloseTo(0.25, 6); // fade-out is smaller
    expect(soundFadeGain({ ...shape, elapsedMs: 100 })).toBeLessThanOrEqual(
      soundFadeGain({ ...shape, elapsedMs: 150 }));
  });

  test("a loop fades in once and then holds — a loop that faded out would go silent every cycle", () => {
    expect(soundFadeGain({ elapsedMs: 0, durationMs: 2_000, fadeInMs: 500, fadeOutMs: 500, loop: true })).toBe(0);
    expect(soundFadeGain({ elapsedMs: 250, durationMs: 2_000, fadeInMs: 500, fadeOutMs: 500, loop: true }))
      .toBeCloseTo(0.5, 6);
    expect(soundFadeGain({ elapsedMs: 1_900, durationMs: 2_000, fadeInMs: 500, fadeOutMs: 500, loop: true })).toBe(1);
    expect(soundFadeGain({ elapsedMs: 60_000, durationMs: 2_000, fadeInMs: 500, loop: true })).toBe(1);
  });
});

describe("soundGain", () => {
  test("the author's volume, the channel fader and the fade multiply", () => {
    expect(soundGain({ volume: 0.5, channel: "music", mix: mix({ music: 0.5 }), fade: 0.5 }))
      .toBeCloseTo(0.125, 6);
    expect(soundGain({ channel: "music", mix: mix() })).toBe(1); // no volume = full
    expect(soundGain({ volume: 2, mix: mix() })).toBe(1);        // clamped, never over-driven
    expect(soundGain({ volume: -1, mix: mix() })).toBe(0);
  });

  test("the master mute silences every channel; a channel fader silences only its own", () => {
    expect(soundGain({ channel: "voice", mix: mix({}, true) })).toBe(0);
    expect(soundGain({ channel: "ambience", mix: mix({ ambience: 0 }) })).toBe(0);
    expect(soundGain({ channel: "sfx", mix: mix({ ambience: 0 }) })).toBe(1);
    // A sound with no channel is an effect, so the effect fader owns it.
    expect(soundGain({ mix: mix({ sfx: 0.25 }) })).toBeCloseTo(0.25, 6);
  });

  test("an unknown channel still mixes as an effect rather than reading undefined", () => {
    expect(soundGain({ channel: "bass" as never, mix: mix({ sfx: 0.5 }) })).toBeCloseTo(0.5, 6);
  });
});

describe("cueSilentForViewer", () => {
  test("true only when there are sounds and every one of them is inaudible here", () => {
    const sections = [{ kind: "sound", channel: "music" as const, volume: 0.5 }];
    expect(cueSilentForViewer(sections, mix({ music: 0 }))).toBe(true);
    expect(cueSilentForViewer(sections, mix({ music: 0.1 }))).toBe(false);
    expect(cueSilentForViewer(sections, mix({}, true))).toBe(true);
    // A silent-by-design cue (no sound sections at all) is not "muted".
    expect(cueSilentForViewer([{ kind: "text" }], mix({}, true))).toBe(false);
    // One audible lane among silent ones is enough to be worth playing.
    expect(cueSilentForViewer([...sections, { kind: "sound", channel: "sfx" as const }],
      mix({ music: 0 }))).toBe(false);
  });
});

describe("soundSummary", () => {
  test("names the sound and its fader, with a fallback when the registry name is gone", () => {
    expect(soundSummary({ name: "Ward hum.wav", channel: "ambience" })).toBe("Ward hum.wav · Ambience");
    expect(soundSummary({ name: "  ", channel: "sfx" })).toBe("Effects");
    expect(soundSummary({ name: null, channel: "voice" })).toBe("Voice");
  });
});
