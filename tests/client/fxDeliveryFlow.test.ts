/**
 * D-295 (SQ-13/A10) — the delivery *flow*: preload before the cue, a slow client that
 * is told what it missed, local mute/reduced-motion that never touch anyone else, and
 * a failed decode that does not take the rest of the timeline down with it.
 *
 * The policy is pinned in `tests/core/fxDelivery.test.ts`; this file is about the
 * player honouring it against a controlled `fetchAsset`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The media path ends in a Pixi texture; this file is about *when* bytes are asked
// for and what the viewer is told, so the decoder is stubbed rather than simulated.
vi.mock("pixi.js", () => ({ Texture: { from: () => ({ destroy: () => undefined }) } }));
vi.stubGlobal("Image", class {
  src = "";
  decode(): Promise<void> { return Promise.resolve(); }
});
vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
/**
 * D-297: sound sections now really start an element, so the audio decoder is a double
 * too — `audios` is what those tests read the applied gain from.
 */
const audios: Array<{ src: string; volume: number; loop: boolean; currentTime: number; duration: number;
  play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
vi.stubGlobal("Audio", class {
  src: string; volume = 1; loop = false; currentTime = 0; duration = 2;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor(src: string) { this.src = src; audios.push(this); }
});

import { FxPlayer } from "../../src/client/fxPlayer";
import { createEventBus } from "../../src/core/events";
import { setFxViewPrefs } from "../../src/core/fxPrefs";
import { fxSounds, resetFxSounds, stopFxSounds } from "../../src/client/fxSounds";
import { DEFAULT_SOUND_MIX } from "../../src/core/fxSound";
import type { ClientEvents, ClientSync } from "../../src/client/sync";
import type { Stage } from "../../src/canvas/stage";
import type { Camera } from "../../src/canvas/camera";
import type { FxStartMsg } from "../../src/core/messages";
import type { ResolvedFxSection } from "../../src/core/fx";
import type { FxDeliveryReport } from "../../src/core/fxDelivery";

const SCENE = "sc-1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
  const bus = createEventBus<ClientEvents>();
  const camera: Camera = { x: 0, y: 0, scale: 1 };
  const cameraWrites: Camera[] = [];
  const spawned: Array<{ runId: string; kind: string; elapsed: number }> = [];
  const fxLayer = {
    clear: vi.fn(),
    count: 0,
    spawn: (runId: string, section: { kind: string }, elapsed: number) => {
      spawned.push({ runId, kind: section.kind, elapsed });
    },
  };
  const stage = {
    camera,
    viewport: { width: 800, height: 600 },
    setCamera: (next: Camera) => { cameraWrites.push({ ...next }); Object.assign(camera, next); },
    getFxLayer: () => fxLayer,
    onFrame: () => () => undefined,
  } as unknown as Stage;
  /** Every asset resolves only when the test says so; a rejected hash models a dead pack. */
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; started: number }>();
  const inFlight = new Map<string, Promise<Uint8Array>>();
  const requests: string[] = [];
  const fails = new Set<string>();
  const reports: FxDeliveryReport[] = [];
  const errors: string[] = [];
  /** D-308: what this viewer told the host about the run's media. */
  const mediaAcks: Array<{ runId: string; assetId: string; state: string; reason?: string; ms?: number }> = [];
  const player = new FxPlayer({
    client: { clockOffset: () => ({ offsetMs: 0 }), requestFxSync: vi.fn(),
      reportFxMedia: (ack: { runId: string; assetId: string; state: string; reason?: string; ms?: number }) =>
        mediaAcks.push(ack) } as unknown as ClientSync,
    bus, stage,
    fetchAsset: (hash: string) => {
      // The real fetcher dedups in-flight requests per hash; the double here must too,
      // or a prefetch plus the cue-time call would look like two requests.
      const existing = inFlight.get(hash);
      if (existing) return existing;
      requests.push(hash);
      if (fails.has(hash)) return Promise.reject(new Error(`asset not found: ${hash}`));
      const promise = new Promise<Uint8Array>((resolve, reject) => {
        pending.set(hash, { resolve: () => resolve(new Uint8Array(4)), reject, started: Date.now() });
      });
      inFlight.set(hash, promise);
      return promise;
    },
    sceneId: () => SCENE,
    onError: (message) => errors.push(message),
    onDelivery: (report) => reports.push(report),
    macroName: () => "Test timeline",
  });
  return {
    bus, player, reports, errors, requests, cameraWrites, spawned, mediaAcks,
    fail: (hash: string) => fails.add(hash),
    /** Let a fetch finish, then let the microtask queue drain. */
    resolveAsset: async (hash: string) => {
      const job = pending.get(hash);
      if (!job) throw new Error(`no pending fetch for ${hash}`);
      job.resolve();
      await sleep(20);
    },
    pendingCount: () => pending.size,
    send: (sections: ResolvedFxSection[], opts: { persistent?: boolean } = {}) => {
      bus.emit("fx", { kind: "fx.start", runId: "run-1", macroId: "macro-1", sceneId: SCENE,
        atHostTime: Date.now() + 40, sections, ...opts } satisfies FxStartMsg);
    },
  };
}

const image = (startMs: number, assetId = "aa".repeat(32)): ResolvedFxSection =>
  ({ id: `i-${startMs}`, kind: "image", startMs, durationMs: 1_500, x: 50, y: 50,
    assetId, mime: "image/png" });
const sound = (startMs: number, assetId = "bb".repeat(32)): ResolvedFxSection =>
  ({ id: `s-${startMs}`, kind: "sound", startMs, durationMs: 1_000, assetId, mime: "audio/mpeg" });

const resetMix = () => setFxViewPrefs({ reduceMotion: false, muteSound: false, preloadAheadMs: 2_000,
  lateMedia: "delay", soundMix: { ...DEFAULT_SOUND_MIX, channels: { ...DEFAULT_SOUND_MIX.channels } } });
beforeEach(() => {
  audios.length = 0;
  resetFxSounds();
  resetMix();
});
afterEach(() => {
  resetMix();
  resetFxSounds();
  vi.restoreAllMocks();
});

describe("FX preload and late-media fallback (D-295)", () => {
  test("media is fetched before its cue, and a timeline that kept up says nothing", async () => {
    const h = harness();
    h.send([image(600)]);
    await sleep(60); // well before the section's start
    expect(h.requests).toEqual(["aa".repeat(32)]); // prefetched, not fetched at cue time
    expect(h.spawned).toHaveLength(0);
    await h.resolveAsset("aa".repeat(32));
    await sleep(700);
    expect(h.spawned.map((entry) => entry.kind)).toEqual(["image"]);
    expect(h.reports).toEqual([]); // nothing degraded: no news is the right amount
  });

  test("a slow client still gets its cue by default, and hears how late it was", async () => {
    const h = harness();
    h.send([image(200)]);
    await sleep(400); // the cue's start came and went with the bytes still in flight
    expect(h.spawned).toHaveLength(0);
    await h.resolveAsset("aa".repeat(32));
    await sleep(60);
    expect(h.spawned).toHaveLength(1); // "delay": start as soon as it loads
    expect(h.spawned[0]?.elapsed).toBeGreaterThan(150); // …at the right phase, not from 0
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.level).toBe("warn");
    expect(h.reports[0]?.message).toContain("Test timeline");
    expect(h.reports[0]?.entries[0]).toMatchObject({ kind: "image", state: "late", reason: "not-ready" });
  });

  test("a viewer who chose strict sync skips the cue instead, and the report says so", async () => {
    setFxViewPrefs({ lateMedia: "skip" });
    const h = harness();
    h.send([image(200)]);
    await sleep(400);
    await h.resolveAsset("aa".repeat(32));
    await sleep(80);
    expect(h.spawned).toHaveLength(0); // every viewer sees the same frames
    expect(h.reports[0]?.entries[0]).toMatchObject({ state: "skipped", reason: "not-ready" });
  });

  test("turning preloading off fetches lazily at cue time (and the cue arrives on time)", async () => {
    setFxViewPrefs({ preloadAheadMs: 0 });
    const h = harness();
    h.send([image(120)]);
    await sleep(40);
    expect(h.requests).toEqual([]); // nothing ahead of the cue, by choice
    await sleep(120);
    expect(h.requests).toEqual(["aa".repeat(32)]); // fetched when the section starts
    await h.resolveAsset("aa".repeat(32));
    await sleep(60);
    expect(h.spawned).toHaveLength(1);
    expect(h.reports).toEqual([]); // the fetch was not "late": it was simply not early
  });
});

describe("local mute and reduced motion (D-295, SQ-16)", () => {
  test("muting FX sounds skips only the sound, and never fetches its bytes", async () => {
    setFxViewPrefs({ muteSound: true });
    const h = harness();
    h.send([image(100), sound(150)]);
    await sleep(60); // the prefetch is in flight; the image's bytes land before its cue
    await h.resolveAsset("aa".repeat(32));
    await sleep(250);
    expect(h.requests).toEqual(["aa".repeat(32)]); // the muted sound was never requested
    expect(h.spawned.map((entry) => entry.kind)).toEqual(["image"]); // the visual still played
    // One report for the run, in timeline order: the muted sound and the image that played.
    expect(h.reports[0]?.entries.map((entry) => [entry.kind, entry.state]))
      .toEqual([["image", "ready"], ["sound", "skipped"]]);
    expect(h.reports[0]?.entries[1]).toMatchObject({ reason: "muted", assetId: "bb".repeat(32) });
  });

  test("reduced motion cuts a pan to its destination and skips a shake entirely", async () => {
    setFxViewPrefs({ reduceMotion: true });
    const h = harness();
    const pan: ResolvedFxSection = { id: "c1", kind: "camera", mode: "pan", startMs: 60,
      durationMs: 1_000, toX: 1_500, toY: 600 };
    const shake: ResolvedFxSection = { id: "c2", kind: "camera", mode: "shake", startMs: 80,
      durationMs: 400, intensity: 0.8 };
    h.send([pan, shake]);
    await sleep(200);
    expect(h.cameraWrites).toHaveLength(1); // one cut, no per-frame animation
    // The cut lands the viewport centre exactly on the resolved destination.
    const cut = h.cameraWrites[0];
    expect((cut?.x ?? 0) + 800 / (2 * (cut?.scale ?? 1))).toBeCloseTo(1_500, 6);
    expect((cut?.y ?? 0) + 600 / (2 * (cut?.scale ?? 1))).toBeCloseTo(600, 6);
    await sleep(250);
    expect(h.cameraWrites).toHaveLength(1); // the shake never wrote either
    expect(h.reports[0]?.entries.map((entry) => [entry.kind, entry.state, entry.reason]))
      .toEqual([["camera", "cut", "reduced-motion"], ["camera", "skipped", "reduced-motion"]]);
  });
});

describe("failures are contained (D-295, A10)", () => {
  test("a missing media cue is reported, and the rest of the timeline still plays", async () => {
    const h = harness();
    h.fail("cc".repeat(32));
    h.send([image(100, "cc".repeat(32)), image(120)]);
    await sleep(200);
    await h.resolveAsset("aa".repeat(32));
    await sleep(80);
    expect(h.spawned).toHaveLength(1); // the good section played
    expect(h.errors[0]).toContain("image failed");
    expect(h.reports[0]?.entries.find((entry) => entry.assetId === "cc".repeat(32)))
      .toMatchObject({ state: "failed", reason: "error" });
  });

  test("a stopped run reports what it never showed, and then stops reporting", async () => {
    const h = harness();
    setFxViewPrefs({ muteSound: true });
    h.send([sound(0)], { persistent: true });
    await sleep(60);
    expect(h.reports).toHaveLength(1);
    h.bus.emit("fxEnd", { kind: "fx.end", runId: "run-1", sceneId: SCENE });
    expect(h.reports).toHaveLength(1); // one report per run, never two
  });
});

describe("sound channels, fades and the device-local list (D-297, SQ-09)", () => {
  const music = (startMs: number, patch: Partial<Extract<ResolvedFxSection, { kind: "sound" }>> = {}) =>
    ({ ...sound(startMs) as Extract<ResolvedFxSection, { kind: "sound" }>, ...patch });

  test("the element plays the author's volume times this device's channel fader", async () => {
    setFxViewPrefs({ soundMix: { muted: false, channels: { sfx: 1, music: 0.5, ambience: 1, voice: 1 } } });
    const h = harness();
    h.send([music(0, { volume: 0.5, channel: "music" })]);
    await sleep(60);
    await h.resolveAsset("bb".repeat(32));
    await sleep(60);
    expect(audios).toHaveLength(1);
    expect(audios[0]?.volume).toBeCloseTo(0.25, 6); // 0.5 authored × 0.5 fader
    expect(audios[0]?.play).toHaveBeenCalledTimes(1);
    expect(h.reports).toEqual([]); // a sound this device can hear is not a degradation
  });

  test("a channel fader at zero skips the cue and never spends the bytes", async () => {
    setFxViewPrefs({ soundMix: { muted: false, channels: { sfx: 1, music: 0, ambience: 1, voice: 1 } } });
    const h = harness();
    h.send([image(60), music(80, { channel: "music" })]);
    await sleep(50);
    await h.resolveAsset("aa".repeat(32));
    await sleep(160);
    expect(h.requests).toEqual(["aa".repeat(32)]); // the silenced channel was not fetched
    expect(audios).toHaveLength(0);
    expect(h.spawned.map((entry) => entry.kind)).toEqual(["image"]); // the visual still played
    expect(h.reports[0]?.entries[1]).toMatchObject({ kind: "sound", state: "skipped", reason: "muted" });
  });

  test("a fade-in ramps the element's volume from silence up to full", async () => {
    const h = harness();
    // Long enough that the one-shot is still playing when the fades are checked:
    // the registry row lives exactly as long as the element does.
    h.send([music(0, { durationMs: 3_000, fadeInMs: 800 })]);
    await sleep(60);
    await h.resolveAsset("bb".repeat(32));
    await sleep(200); // roughly a quarter of the way through the fade
    const early = audios[0]?.volume ?? 1;
    expect(early).toBeGreaterThan(0.02);
    expect(early).toBeLessThan(0.95);
    await sleep(900); // the fade has finished and the section has not
    expect(audios[0]?.volume).toBeCloseTo(1, 6);
    expect(fxSounds()[0]?.gain).toBeCloseTo(1, 6);
    expect(h.reports).toEqual([]);
  });

  test("a fader moved mid-cue reaches the element and the live list", async () => {
    setFxViewPrefs({ soundMix: { muted: false, channels: { sfx: 1, music: 1, ambience: 1, voice: 1 } } });
    const h = harness();
    // A loop with a short fade-in settles at volume × fader, so the fader move is the
    // only thing changing the number when it is measured.
    h.send([music(0, { channel: "music", fadeInMs: 100 })], { persistent: true });
    await sleep(60);
    await h.resolveAsset("bb".repeat(32));
    await sleep(200);
    expect(audios[0]?.volume).toBeCloseTo(1, 2);
    setFxViewPrefs({ soundMix: { muted: false, channels: { sfx: 1, music: 0.25, ambience: 1, voice: 1 } } });
    await sleep(160);
    expect(audios[0]?.volume).toBeCloseTo(0.25, 2);
    expect(fxSounds()[0]?.gain).toBeCloseTo(0.25, 2);
    expect(fxSounds()[0]?.channel).toBe("music");
    expect(fxSounds()[0]?.name).toBeNull(); // the harness supplies no asset-name lookup
  });

  test("a persistent loop is listed as a loop, and stopping from this device pauses it", async () => {
    const h = harness();
    h.send([music(0, { channel: "ambience" })], { persistent: true });
    await sleep(60);
    await h.resolveAsset("bb".repeat(32));
    await sleep(60);
    const [live] = fxSounds();
    expect(live).toMatchObject({ channel: "ambience", persistent: true, runId: "run-1" });
    expect(audios[0]?.loop).toBe(true);
    expect(stopFxSounds({ channel: "ambience" })).toBe(1);
    expect(audios[0]?.pause).toHaveBeenCalledTimes(1);
    expect(fxSounds()).toEqual([]);
    // The host-run timeline is untouched by a local stop: its cue is still playing
    // for everyone else, and this player's run ends only when the host says so.
    expect(h.reports).toEqual([]);
  });

  test("a host stop clears the device-local list too", async () => {
    const h = harness();
    h.send([music(0)], { persistent: true });
    await sleep(60);
    await h.resolveAsset("bb".repeat(32));
    await sleep(60);
    expect(fxSounds()).toHaveLength(1);
    h.bus.emit("fxEnd", { kind: "fx.end", runId: "run-1", sceneId: SCENE });
    expect(fxSounds()).toEqual([]);
    expect(audios[0]?.pause).toHaveBeenCalledTimes(1);
  });
});

describe("the table answers with what it actually did (D-308, SQ-13)", () => {
  test("a prefetch that arrived is reported, with what it cost", async () => {
    const h = harness();
    h.send([image(600)]);
    await sleep(60);
    await h.resolveAsset("aa".repeat(32));
    await sleep(40);
    // The answer is about the *bytes*, and it arrives before the section even starts:
    // that is the preload half of SQ-13 made visible to the requester.
    expect(h.mediaAcks).toHaveLength(1);
    expect(h.mediaAcks[0]).toMatchObject({ runId: "run-1", assetId: "aa".repeat(32), state: "ready" });
    expect(h.mediaAcks[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(h.spawned).toHaveLength(0);
  });

  test("a lazy fetch (preloading off) is reported when the section needed it", async () => {
    setFxViewPrefs({ preloadAheadMs: 0 });
    const h = harness();
    h.send([image(0)]);
    await sleep(40);
    expect(h.requests).toEqual(["aa".repeat(32)]);
    expect(h.mediaAcks).toEqual([]); // nothing is known until the bytes are
    await h.resolveAsset("aa".repeat(32));
    await sleep(60);
    expect(h.mediaAcks).toHaveLength(1);
    expect(h.mediaAcks[0]).toMatchObject({ state: "ready" });
  });

  test("a format this browser refuses is reported before a byte is fetched", async () => {
    // The probe is what the browser itself answers; a shell without one claims no opinion.
    const original = globalThis.document;
    vi.stubGlobal("document", { createElement: () => ({ canPlayType: () => "" }) });
    try {
      const h = harness();
      h.send([sound(0)]);
      await sleep(60);
      expect(h.mediaAcks).toEqual([{ runId: "run-1", assetId: "bb".repeat(32), state: "unsupported" }]);
      // No point spending a download on a codec this browser already refused.
      expect(h.requests).toEqual([]);
    } finally {
      vi.stubGlobal("document", original);
    }
  });

  test("bytes that arrive but cannot play are a failure, not silence", async () => {
    const original = globalThis.Image;
    vi.stubGlobal("Image", class {
      src = "";
      decode(): Promise<void> { return Promise.reject(new Error("image decode unsupported")); }
    });
    try {
      const h = harness();
      h.send([image(0)]);
      await sleep(40);
      await h.resolveAsset("aa".repeat(32));
      await sleep(80);
      // The bytes were in hand (the prefetch said so); the decoder refused them, and the
      // format is what it refused — the second, later answer is the true one.
      expect(h.mediaAcks.map((ack) => ack.state)).toEqual(["ready", "unsupported"]);
      expect(h.mediaAcks[1]).toMatchObject({ runId: "run-1", assetId: "aa".repeat(32) });
    } finally {
      vi.stubGlobal("Image", original);
    }
  });

  test("a sound this device muted is a local choice, and says nothing to the host", async () => {
    setFxViewPrefs({ muteSound: true });
    const h = harness();
    h.send([sound(0)]);
    await sleep(80);
    expect(h.mediaAcks).toEqual([]); // a device preference is not the table's business
    expect(h.requests).toEqual([]);
  });

  test("a GM's own draft preview is not reported: it never left this client", async () => {
    const h = harness();
    h.player.preview({ kind: "fx.start", runId: "draft-1", macroId: "macro-1", sceneId: SCENE,
      atHostTime: Date.now(), sections: [image(0)] });
    await sleep(40);
    await h.resolveAsset("aa".repeat(32));
    await sleep(60);
    expect(h.mediaAcks).toEqual([]);
  });
});
