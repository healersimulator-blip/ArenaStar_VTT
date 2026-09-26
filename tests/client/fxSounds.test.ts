/**
 * D-297 (SQ-09/SQ-17) — the device-local live-sound registry the settings panel
 * reads and the player fills. The two properties that matter: a registration is
 * removed exactly once (no ghost rows, no double stop), and a stop silences *this*
 * device only — it never touches another registration or anything host-side.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fxSoundLabel, fxSounds, registerFxSound, resetFxSounds, setFxSoundGain,
  stopFxSounds, subscribeFxSounds } from "../../src/client/fxSounds";

const entry = (id: string, patch: Partial<Parameters<typeof registerFxSound>[0]> = {}) => ({
  id, runId: id.split(":")[0] ?? id, index: 0, name: null, channel: "sfx" as const,
  gain: 1, persistent: false, startedAt: 1, stop: vi.fn(), ...patch,
});

afterEach(() => { resetFxSounds(); });

describe("registerFxSound", () => {
  test("registers, reports and unregisters exactly once", () => {
    const stop = vi.fn();
    const off = registerFxSound(entry("run-1:0", { stop }));
    expect(fxSounds().map((sound) => sound.id)).toEqual(["run-1:0"]);
    off();
    off(); // idempotent: a teardown path may run twice
    expect(fxSounds()).toEqual([]);
    expect(stop).not.toHaveBeenCalled(); // unregistering is not stopping
  });

  test("subscribers are told on add, gain change and removal, and never see the stop closure", () => {
    const seen: string[][] = [];
    const off = subscribeFxSounds((sounds) => seen.push(sounds.map((sound) => sound.id)));
    registerFxSound(entry("run-1:0", { name: "sting.wav" }));
    setFxSoundGain("run-1:0", 0.4);
    expect(fxSounds()[0]?.gain).toBeCloseTo(0.4, 6);
    setFxSoundGain("run-1:0", 5); // clamped
    expect(fxSounds()[0]?.gain).toBe(1);
    setFxSoundGain("run-1:0", Number.NaN); // ignored, keeps the previous gain
    expect(fxSounds()[0]?.gain).toBe(1);
    registerFxSound(entry("run-1:1"));
    stopFxSounds({ runId: "run-1" });
    off();
    // Every emit is reported, including the two gain writes that were actually
    // applied — the panel shows a live percentage, so it must not miss one.
    expect(seen).toEqual([[], ["run-1:0"], ["run-1:0"], ["run-1:0"], ["run-1:0", "run-1:1"], []]);
    expect(seen.filter((row) => row.length === 1)).toHaveLength(3);
    // The panel gets a view without the element's teardown closure.
    expect(Object.keys(fxSounds()[0] ?? {}).every((key) => key in {
      id: 1, runId: 1, index: 1, name: 1, channel: 1, gain: 1, persistent: 1, startedAt: 1,
    })).toBe(true);
  });

  test("the list is bounded, oldest first, so a stuck loop cannot grow it forever", () => {
    for (let index = 0; index < 70; index += 1) {
      registerFxSound(entry(`run-${index}:0`, { startedAt: index }));
    }
    const sounds = fxSounds();
    expect(sounds).toHaveLength(64);
    expect(sounds[0]?.id).toBe("run-6:0");
    expect(sounds.at(-1)?.id).toBe("run-69:0");
  });

  test("a reused ID is a different row: an old teardown cannot delete the new element", () => {
    const first = registerFxSound(entry("run-1:0"));
    const second = registerFxSound(entry("run-1:0", { gain: 0.5 }));
    first(); // the previous element's teardown runs late
    expect(fxSounds()).toHaveLength(1);
    expect(fxSounds()[0]?.gain).toBeCloseTo(0.5, 6);
    second();
    expect(fxSounds()).toEqual([]);
  });

  test("a stop that throws does not take the rest of the list with it", () => {
    registerFxSound(entry("run-1:0", { stop: () => { throw new Error("element already gone"); } }));
    registerFxSound(entry("run-1:1"));
    expect(stopFxSounds({ runId: "run-1" })).toBe(2);
    expect(fxSounds()).toEqual([]);
  });
});

describe("stopFxSounds", () => {
  test("stops by run, by channel, or everything — and counts honestly", () => {
    registerFxSound(entry("run-1:0", { stop: vi.fn(), channel: "music" }));
    registerFxSound(entry("run-1:1", { stop: vi.fn(), channel: "sfx" }));
    registerFxSound(entry("run-2:0", { stop: vi.fn(), channel: "music" }));
    expect(stopFxSounds({ channel: "music" })).toBe(2);
    expect(fxSounds().map((sound) => sound.id)).toEqual(["run-1:1"]);
    expect(stopFxSounds({ channel: "voice" })).toBe(0);
    expect(stopFxSounds({ channel: "bass" as never })).toBe(0); // an unknown channel matches nothing
    expect(stopFxSounds()).toBe(1);
    expect(fxSounds()).toEqual([]);
  });
});

describe("fxSoundLabel", () => {
  test("prefers the world's own name and falls back to the channel", () => {
    expect(fxSoundLabel("Ward hum.wav", "ambience")).toBe("Ward hum.wav · Ambience");
    expect(fxSoundLabel(null, "music")).toBe("Music");
  });
});
