/**
 * D-295 (SQ-13/A10) — the policy half of FX delivery: a per-viewer preload plan, a
 * bounded late-media fallback, and a report that says what actually happened. The
 * player owns sockets and timers; everything decided *here* is pure and pinned here.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_FX_VIEW_PREFS, FX_VIEW_PREFS_KEY, MAX_PRELOAD_AHEAD_MS, fxAssetFitness, fxViewPrefs,
  normalizeFxViewPrefs, prefersReducedMotion, readFxViewPrefs, setFxViewPrefs, subscribeFxViewPrefs,
} from "../../src/core/fxPrefs";
import {
  fxFitnessIssues, fxMediaCues, fxPreloadPlan, lateMediaDecision, summarizeDelivery, summarizeSkips,
  type FxDeliveryEntry,
} from "../../src/core/fxDelivery";
import type { ResolvedFxSection } from "../../src/core/fx";

const image = (assetId: string, startMs: number, durationMs = 2_000, x = 100, y = 100): ResolvedFxSection =>
  ({ id: `i-${assetId}-${startMs}`, kind: "image", startMs, durationMs, x, y, assetId, mime: "image/png" });
const sound = (assetId: string, startMs: number, durationMs = 1_000): ResolvedFxSection =>
  ({ id: `s-${assetId}-${startMs}`, kind: "sound", startMs, durationMs, assetId, mime: "audio/mpeg" });
const text: ResolvedFxSection = { id: "t", kind: "text", startMs: 0, durationMs: 500, x: 0, y: 0, text: "hi" };
const camera: ResolvedFxSection = { id: "c", kind: "camera", mode: "shake", startMs: 0,
  durationMs: 500, intensity: 0.5 };

describe("fxMediaCues", () => {
  test("carries only sections that need bytes, in timeline order, with their own index", () => {
    const cue = fxMediaCues([text, image("aa", 0), camera, sound("bb", 1_500)]);
    expect(cue.map((entry) => [entry.kind, entry.assetId, entry.startMs])).toEqual([
      ["image", "aa", 0], ["sound", "bb", 1_500],
    ]);
    expect(cue.map((entry) => entry.index)).toEqual([1, 3]); // points back at the real sections
  });
});

describe("fxPreloadPlan", () => {
  test("starts a fetch now when the need is inside the window, and waits otherwise", () => {
    // aa is due 800 ms after the cue (500 + the 300 ms host lead) — fetch immediately,
    // because waiting would leave less lead time than the viewer allows.
    const plan = fxPreloadPlan([image("aa", 500), sound("bb", 20_000), image("cc", 0)],
      { leadMs: 300, aheadMs: 2_000 });
    expect(plan.map((entry) => [entry.assetId, entry.waitMs]))
      .toEqual([["aa", 0], ["cc", 0], ["bb", 18_300]]);
    // The far-out cue is fetched 2 s before its own start, not dropped and not queued now.
    expect(2_000 + (plan[2]?.waitMs ?? 0)).toBe(20_300);
  });

  test("preloading can be turned off: the cue is then fetched lazily at play time", () => {
    expect(fxPreloadPlan([image("aa", 1_500)], { leadMs: 300, aheadMs: 0 })).toEqual([]);
  });

  test("one entry per asset, and the earliest need wins the deadline", () => {
    const plan = fxPreloadPlan([image("aa", 20_000), image("aa", 100)], { leadMs: 300, aheadMs: 1_000 });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.waitMs).toBe(0); // the second need is 400 ms out, inside the window
  });

  test("a section that starts with the timeline still gets the transport lead", () => {
    expect(fxPreloadPlan([image("aa", 0)], { leadMs: 300, aheadMs: 2_000 })[0]?.waitMs).toBe(0);
    expect(fxPreloadPlan([image("aa", -1_000)], { leadMs: 300, aheadMs: 2_000 })[0]?.waitMs).toBe(0);
  });
});

describe("lateMediaDecision", () => {
  test("delay keeps the cue (the frame jumps to the right phase), skip drops it", () => {
    expect(lateMediaDecision("delay", 900)).toEqual({ start: true });
    expect(lateMediaDecision("skip", 900)).toEqual({ start: false, reason: "not-ready" });
  });
});

describe("summarizeDelivery", () => {
  const ready: FxDeliveryEntry = { index: 0, kind: "image", state: "ready", reason: "preload" };

  test("a timeline that played as authored says nothing at all", () => {
    expect(summarizeDelivery([ready])).toBeNull();
    expect(summarizeDelivery([])).toBeNull();
  });

  test("one readable line, with the worst lateness and a count of what was lost", () => {
    const summary = summarizeDelivery([
      ready,
      { index: 1, kind: "sound", state: "skipped", reason: "muted" },
      { index: 2, kind: "image", state: "late", reason: "not-ready", lateMs: 480 },
      { index: 3, kind: "image", state: "late", reason: "not-ready", lateMs: 120 },
    ], "Fireball");
    expect(summary?.level).toBe("warn");
    expect(summary?.message).toContain("Fireball: 3 of 4 cue(s) degraded");
    expect(summary?.message).toContain("2× image not loaded in time");
    expect(summary?.message).toContain("sound muted on this device");
    expect(summary?.message).toContain("up to 480 ms late");
  });

  test("failures name the cause a viewer can act on", () => {
    const summary = summarizeDelivery([
      { index: 0, kind: "sound", state: "failed", reason: "unsupported-codec", detail: "video format unsupported" },
    ], "Chant");
    expect(summary?.message).toContain("sound unsupported format");
  });
});

describe("per-viewer preferences (device-local, total parsing)", () => {
  test("normalize is total: garbage, partial and hostile input become the documented value", () => {
    expect(normalizeFxViewPrefs(null)).toEqual(DEFAULT_FX_VIEW_PREFS);
    expect(normalizeFxViewPrefs({ reduceMotion: "yes", muteSound: 1 })).toMatchObject({
      reduceMotion: false, muteSound: false });
    expect(normalizeFxViewPrefs({ preloadAheadMs: Number.NaN }).preloadAheadMs)
      .toBe(DEFAULT_FX_VIEW_PREFS.preloadAheadMs);
    expect(normalizeFxViewPrefs({ preloadAheadMs: 1e9 }).preloadAheadMs).toBe(MAX_PRELOAD_AHEAD_MS);
    expect(normalizeFxViewPrefs({ preloadAheadMs: -50 }).preloadAheadMs).toBe(0);
    expect(normalizeFxViewPrefs({ lateMedia: "explode" }).lateMedia).toBe("delay");
    expect(normalizeFxViewPrefs({ lateMedia: "skip" }).lateMedia).toBe("skip");
  });

  test("a viewer's choice is remembered, and a bad stored value never breaks the load", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readFxViewPrefs(storage).lateMedia).toBe("delay");
    setFxViewPrefs({ muteSound: true, preloadAheadMs: 500, lateMedia: "skip" }, storage);
    expect(JSON.parse(store.get(FX_VIEW_PREFS_KEY) ?? "{}")).toMatchObject({
      muteSound: true, preloadAheadMs: 500, lateMedia: "skip" });
    expect(readFxViewPrefs(storage)).toMatchObject({ muteSound: true, lateMedia: "skip" });
    store.set(FX_VIEW_PREFS_KEY, "{ not json");
    expect(readFxViewPrefs(storage)).toMatchObject({ muteSound: false, lateMedia: "delay" });
  });

  test("stored values reach subscribers, so a change obeys the very next cue", () => {
    const seen: boolean[] = [];
    const off = subscribeFxViewPrefs((prefs) => seen.push(prefs.reduceMotion));
    setFxViewPrefs({ reduceMotion: true });
    off();
    setFxViewPrefs({ reduceMotion: false });
    expect(seen).toEqual([true]);
    expect(fxViewPrefs().reduceMotion).toBe(false);
  });

  test("the OS switch seeds a default but never overrides a stored choice", () => {
    const reduce = (media: string) => ({ matches: media.includes("reduce") });
    expect(prefersReducedMotion(reduce)).toBe(true);
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion(null)).toBe(false);
    const store = new Map<string, string>([[FX_VIEW_PREFS_KEY, JSON.stringify({ reduceMotion: false })]]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => undefined };
    expect(readFxViewPrefs(storage).reduceMotion).toBe(false);
  });

  test("an absent storage backend is not an error (and prefers-reduced-motion survives)", () => {
    expect(readFxViewPrefs(null)).toEqual({ ...DEFAULT_FX_VIEW_PREFS, reduceMotion: prefersReducedMotion() });
    expect(setFxViewPrefs({ lateMedia: "skip" }, null).lateMedia).toBe("skip");
    setFxViewPrefs({ lateMedia: "delay" }); // leave the module state as the app expects
  });
});

describe("registry fitness (pack missing / unsupported codec / audience)", () => {
  const canPlayOnlyWebm = (mime: string) => (mime.includes("webm") ? "probably" : "");

  test("classifies an absent asset, a decodable one and one this browser refuses", () => {
    expect(fxAssetFitness(undefined, "image/png")).toBe("missing");
    expect(fxAssetFitness({ mime: "image/png" }, "image/png", canPlayOnlyWebm)).toBe("ready");
    expect(fxAssetFitness({ mime: "video/x-matroska" }, "video/x-matroska", canPlayOnlyWebm))
      .toBe("unsupported-codec");
    // The probe is the authority, not the container: a browser that only plays WebM
    // is told so before the cue, which is what "unsupported codec" means for a viewer.
    expect(fxAssetFitness({ mime: "audio/ogg" }, "audio/ogg", canPlayOnlyWebm)).toBe("unsupported-codec");
    expect(fxAssetFitness({ mime: "audio/ogg" }, "audio/ogg", null)).toBe("ready"); // no DOM, no opinion
  });

  test("a probe that throws is not a reason to refuse to play", () => {
    const bomb = () => { throw new Error("no DOM"); };
    expect(fxAssetFitness({ mime: "video/webm" }, "video/webm", bomb)).toBe("ready");
  });

  test("authoring warns about missing media, an undecodable codec and a GM-only asset in a scene timeline", () => {
    const issues = fxFitnessIssues(
      [image("aaaa1111", 0), image("cccc3333", 0), sound("dddd4444", 0)], {
        entries: {
          aaaa1111: { mime: "video/x-matroska", visibility: "gm" },
          cccc3333: { mime: "image/png" },
        },
        canPlay: canPlayOnlyWebm,
        audience: "scene",
      });
    expect(issues).toHaveLength(3);
    expect(issues.some((issue) => issue.includes("cannot be decoded"))).toBe(true);
    expect(issues.some((issue) => issue.includes("is GM-only media"))).toBe(true);
    expect(issues.some((issue) => issue.includes("is not in this world's registry"))).toBe(true);
  });

  test("a GM-only audience is not warned about GM-only media, and an unknown asset is named", () => {
    expect(fxFitnessIssues([image("aaaa1111", 0)], {
      entries: { aaaa1111: { mime: "image/png", visibility: "gm" } }, audience: "gm",
    })).toEqual([]);
    const issues = fxFitnessIssues([image("deadbeef", 0)], { entries: {} });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("deadbeef");
  });
});

describe("summarizeSkips (the requester's half of SQ-13)", () => {
  const none = { audience: 0, rights: 0, anchor: 0, media: 0 };

  test("nothing to explain when everyone the scene has received it", () => {
    expect(summarizeSkips(none, 4)).toBeNull();
  });

  test("names every reason, and says when it reached nobody at all", () => {
    const line = summarizeSkips({ audience: 2, rights: 1, anchor: 0, media: 3 }, 5, "Ward");
    expect(line).toBe("Ward: reached 5 viewer(s) — 6 skipped (2 outside its audience, 1 without read rights, 3 without media rights)");
    expect(summarizeSkips({ audience: 1, rights: 0, anchor: 0, media: 0 }, 0, "Ward"))
      .toBe("Ward: reached no one — 1 skipped (1 outside its audience)");
  });
});
