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
  fxFitnessIssues, fxMediaCues, fxMediaReport, fxPreloadPlan, lateMediaDecision, summarizeDelivery,
  summarizeMedia, summarizeSkips,
  type FxDeliveryEntry,
} from "../../src/core/fxDelivery";
import type { FxMediaAckState } from "../../src/core/messages";
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

  // D-303: a targeted section is not a preflight skip — everyone was entitled — so the
  // line has to report it separately, and a run that withheld a section from someone
  // must produce a line at all (before this, nothing was said and the author never
  // learned whether their targeting did anything).
  test("targeted sections and outright silence are their own sentences", () => {
    expect(summarizeSkips(none, 3, "Ward", { targeted: 0, empty: 0 })).toBeNull();
    expect(summarizeSkips(none, 3, "Ward", { targeted: 2, empty: 0 }))
      .toBe("Ward: reached 3 viewer(s) — 2 saw it without its targeted sections");
    expect(summarizeSkips(none, 0, "Ward", { targeted: 0, empty: 1 }))
      .toBe("Ward: reached no one — 1 left with none of it");
    // Both at once, and mixed with a genuine preflight skip: the skip total stays its
    // own number so "6 skipped" never counts a viewer who was entitled.
    expect(summarizeSkips({ audience: 1, rights: 0, anchor: 0, media: 0 }, 2, "Ward",
      { targeted: 1, empty: 2 }))
      .toBe("Ward: reached 2 viewer(s) — 1 skipped (1 outside its audience, 1 saw it without its targeted sections, 2 left with none of it)");
    // An explicit zero is the same as an omitted field: "nothing to explain" stays quiet.
    expect(summarizeSkips(none, 4, "Ward", { targeted: 0 })).toBeNull();
  });
});

describe("the table's own answer about the media (D-308, SQ-13)", () => {
  const assets = [
    { assetId: "img", index: 1, kind: "image" as const, mime: "image/png" },
    { assetId: "snd", index: 3, kind: "sound" as const, mime: "audio/mpeg" },
  ];
  const acks = (rows: Record<string, Record<string, FxMediaAckState>>) =>
    ({ bySession: new Map(Object.entries(rows).map(([id, states]) => [id, new Map(Object.entries(states))])) });

  test("counts per asset, names the worst one by the author's own section number", () => {
    const report = fxMediaReport(assets, 3, acks({
      a: { img: "ready", snd: "ready" },
      b: { img: "unsupported" },
      c: { img: "ready", snd: "late" },
    }));
    expect(report.assets[0]).toMatchObject({ index: 1, ready: 2, unsupported: 1, silent: 0 });
    expect(report.assets[1]).toMatchObject({ index: 3, ready: 1, late: 1, silent: 1 });
    expect(report.viewers).toBe(3);
    expect(report.spoke).toBe(3);
    expect(report.complete).toBe(false); // c never reported `snd`, b never did either
    const line = summarizeMedia(report, "Lantern");
    expect(line.level).toBe("warn");
    // The worst asset is the one two viewers lack; the asset is named by section, not id.
    expect(line.message).toContain("section 4 (sound, audio/mpeg)");
    expect(line.message).not.toContain("snd");
    expect(line.message).toContain("media not in hand for 2 of 3 viewer(s)");
    expect(line.message).toContain("started late for 1");
    expect(line.message).toContain("have not reported yet");
  });

  test("an all-clear is still an answer, and a slow fetch is part of it", () => {
    const report = fxMediaReport(assets, 2, {
      ...acks({ a: { img: "ready", snd: "ready" }, b: { img: "ready", snd: "ready" } }),
      fetchMs: new Map([["a", new Map([["img", 1_240]])]]),
    });
    expect(report.complete).toBe(true);
    expect(report.spoke).toBe(2);
    const line = summarizeMedia(report, "Lantern");
    expect(line.level).toBe("info");
    expect(line.message).toBe("Lantern: media in hand — every viewer holds all 2 asset(s) × 2 viewer(s); slowest fetch 1240 ms");
  });

  test("an ok timeline with nobody reporting says so rather than nothing", () => {
    const report = fxMediaReport(assets, 2, acks({}));
    expect(report.complete).toBe(false);
    expect(report.spoke).toBe(0);
    const line = summarizeMedia(report, "Lantern");
    expect(line.level).toBe("warn");
    expect(line.message).toContain("no answer yet for 2 of 2 viewer(s)");
    expect(line.message).toContain("no word from 2");
  });

  test("a correction is marked, and the counts are the newest ones", () => {
    // The first line said one viewer could not decode it; a recovery arrives before the
    // window closes, so the second (and last) line for this run says so.
    const report = fxMediaReport(assets, 1, acks({ a: { img: "ready", snd: "ready" } }),
      { corrected: true });
    const line = summarizeMedia(report, "Lantern");
    expect(line.level).toBe("info");
    expect(line.message.endsWith("(corrected)")).toBe(true);
  });
});
