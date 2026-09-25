import { describe, expect, test } from "vitest";
import { FX_FILTER_RANGES, fxFilterStrength, fxSectionsForViewer, fxStylePlan, resolveFxSequence,
  validateFxSequence, type FxSequence } from "../../src/core/fx";
import { fxFollowAnchors, fxPosition } from "../../src/canvas/layers/FxLayer";
import type { SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";

const hash = "a".repeat(64);
const sound = "b".repeat(64);
const source: TokenDocument = {
  _id: "caster", type: "token", name: "Caster", flags: {}, system: {}, ownership: { default: 2 },
  x: 120, y: 150, width: 80, height: 100, rotation: 0, hidden: false, img: "",
  vision: true, disposition: "friendly", light: { radius: 0, color: "#fff", alpha: 0 },
};
const scene: SceneDocument = {
  _id: "s", type: "scene", name: "Arena", flags: {}, system: {}, ownership: { default: 2 }, active: true,
  width: 1000, height: 1000, grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  darkness: 0, img: null, tokens: [source], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
};

/** A visual section, so blend/filter cases read as one line each. */
const visual = (patch: Record<string, unknown> = {}): FxSequence => ({
  version: 1, sections: [{ kind: "image", id: "glow", assetId: hash,
    at: { kind: "point", x: 100, y: 100 }, startMs: 0, durationMs: 1000, ...patch } as never] });

const sequence: FxSequence = { version: 1, sections: [
  { kind: "text", id: "title", text: "Charge", at: { kind: "source" }, startMs: 0, durationMs: 1000, fadeOutMs: 200 },
  { kind: "image", id: "impact", assetId: hash, at: { kind: "target" }, startMs: 500, durationMs: 1200, scale: 1.4 },
  { kind: "sound", id: "whoosh", assetId: sound, startMs: 500, durationMs: 800, volume: 0.7,
    channel: "music", fadeInMs: 200, fadeOutMs: 300 },
] };

describe("versioned audiovisual timeline", () => {
  test("valid parallel sections and authoritative host anchor resolution", () => {
    expect(validateFxSequence(sequence).ok).toBe(true);
    const result = resolveFxSequence(sequence, scene, source, source, (id) => id === hash ? "video/webm" : "audio/ogg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sections[0]).toMatchObject({ kind: "text", x: 120, y: 150, startMs: 0 });
    expect(result.sections[1]).toMatchObject({ kind: "image", x: 120, y: 150, mime: "video/webm", startMs: 500 });
    expect("at" in (result.sections[0] ?? {})).toBe(false); // do not send author-only anchor extras
    // D-297: the channel and fades are part of the host-approved cue — they are a
    // document fact, while the *gain* each viewer applies to them is not.
    expect(result.sections[2]).toMatchObject({ kind: "sound", mime: "audio/ogg", volume: 0.7,
      channel: "music", fadeInMs: 200, fadeOutMs: 300 });
  });

  test("bounded one-shot section replays expand into host-clock cues, distinct from motion cycles", () => {
    const replay: FxSequence = { version: 1, sections: [
      { kind: "text", id: "pulse", text: "Pulse", at: { kind: "source" },
        startMs: 100, durationMs: 300, repeatCount: 3, repeatDelayMs: 150 },
      { kind: "sound", id: "beep", assetId: sound, startMs: 50, durationMs: 250,
        repeatCount: 2, repeatDelayMs: 0 },
      { kind: "wait", id: "rest", startMs: 0, durationMs: 200 },
    ] };
    const resolved = resolveFxSequence(replay, scene, source, undefined, () => "audio/ogg");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.sections.map((s) => [s.id, s.startMs, s.durationMs])).toEqual([
      ["pulse", 100, 300], ["pulse@2", 550, 300], ["pulse@3", 1000, 300],
      ["beep", 50, 250], ["beep@2", 300, 250], ["rest", 0, 200],
    ]);
    expect(resolved.sections.every((s) => !Object.hasOwn(s, "repeatCount") && !Object.hasOwn(s, "repeatDelayMs")))
      .toBe(true); // recipients get concrete cues, not authoring controls
    const original = replay.sections[0];
    expect(original?.repeatCount).toBe(3); // never mutates the saved definition
    const bad = (fields: Record<string, unknown>, kind = "text") => validateFxSequence({
      version: 1, sections: [{ kind, id: "bad", text: "Pulse", at: { kind: "source" },
        startMs: 0, durationMs: 300, ...fields }],
    }).ok;
    for (const invalid of [
      { repeatCount: 1 }, { repeatCount: 9 }, { repeatCount: 2.5 }, { repeatCount: Number.NaN },
      { repeatDelayMs: 1 }, { repeatCount: 2, repeatDelayMs: -1 },
      { repeatCount: 2, repeatDelayMs: 1.5 }, { repeatCount: 2, repeatDelayMs: 30_001 },
      { repeatCount: 3, repeatDelayMs: 30_000, startMs: 1_000 },
      { repeatCount: 2, script: "eval()" },
    ]) expect(bad(invalid)).toBe(false);
    expect(validateFxSequence({ version: 1, persistent: true, sections: [
      { kind: "text", id: "repeat", text: "x", at: { kind: "source" },
        startMs: 0, durationMs: 400, repeatCount: 2 },
    ] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [
      { kind: "wait", id: "wait", startMs: 0, durationMs: 100, repeatCount: 2 },
    ] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: Array.from({ length: 9 }, (_, i) => ({
      kind: "text", id: `burst-${i}`, text: "x", at: { kind: "source" },
      startMs: 0, durationMs: 300, repeatCount: 8,
    })) }).ok).toBe(false); // max 64 resolved cues, including all lanes
    expect(validateFxSequence({ version: 1, sections: [
      { kind: "text", id: "pulse@2", text: "x", at: { kind: "source" }, startMs: 0, durationMs: 300 },
    ] }).ok).toBe(false); // generated replay IDs cannot collide with authored IDs
  });

  test("host resolves a projectile target; eased movement and stretch have separate render rules", () => {
    const motion: FxSequence = { version: 1, sections: [
      { kind: "image", id: "projectile", assetId: hash, at: { kind: "source" },
        to: { kind: "target" }, easing: "easeIn", startMs: 0, durationMs: 1000,
        fadeInMs: 200, tint: "#ff0000" },
      { kind: "image", id: "beam", assetId: hash, at: { kind: "source" },
        to: { kind: "point", x: 500, y: 400 }, stretch: true, startMs: 500, durationMs: 700 },
      { kind: "text", id: "pulse", text: "Glow", at: { kind: "point", x: 200, y: 200 },
        to: { kind: "point", x: 400, y: 200 }, repeats: 2, startMs: 0, durationMs: 1000 },
    ] };
    const target = { ...source, x: 520, y: 350 };
    const prepared = resolveFxSequence(motion, scene, source, target, () => "image/webp");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const image = prepared.sections[0];
    const beam = prepared.sections[1];
    const pulse = prepared.sections[2];
    expect(image).toMatchObject({ kind: "image", x: 120, y: 150, toX: 520, toY: 350, tint: "#ff0000" });
    expect(beam).toMatchObject({ x: 120, y: 150, toX: 500, toY: 400, stretch: true });
    expect("at" in (image ?? {})).toBe(false);
    expect("to" in (image ?? {})).toBe(false);
    if (image?.kind !== "image" || beam?.kind !== "image" || pulse?.kind !== "text") return;
    expect(fxPosition(image, 500)).toEqual({ x: 220, y: 200 });
    expect(fxPosition(beam, 350)).toEqual({ x: 120, y: 150 });
    expect(fxPosition(pulse, 250)).toEqual({ x: 300, y: 200 });
    expect(fxPosition(pulse, 500)).toEqual({ x: 200, y: 200 });
    const missing = resolveFxSequence(motion, scene, source, undefined, () => "image/png");
    expect(missing).toMatchObject({ ok: false, error: "FX target token is required" });
  });

  test("a followed visual transmits only bound visible token IDs and tracks both anchors locally", () => {
    const follow: FxSequence = { version: 1, persistent: true, sections: [
      { kind: "image", id: "beam", at: { kind: "source" }, to: { kind: "target" },
        assetId: hash, follow: true, stretch: true, startMs: 0, durationMs: 900 },
    ] };
    const target = { ...source, _id: "target", x: 420 };
    const result = resolveFxSequence(follow, scene, source, target, () => "image/png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const beam = result.sections[0];
    expect(beam).toMatchObject({ x: 120, y: 150, toX: 420, toY: 150,
      followTokenId: "caster", followToTokenId: "target" });
    if (beam?.kind !== "image") return;
    const latest = fxFollowAnchors(beam, (id) => id === "caster" ? { x: 240, y: 320 }
      : id === "target" ? { x: 600, y: 320 } : undefined);
    expect(latest).toEqual({ from: { x: 240, y: 320 }, to: { x: 600, y: 320 } });
    if (latest) expect(fxPosition(beam, 400, latest)).toEqual({ x: 240, y: 320 }); // stretch holds its origin
    expect(fxFollowAnchors(beam, (id) => id === "caster" ? { x: 240, y: 320 } : undefined))
      .toBeUndefined(); // target became hidden in the recipient's fog
    expect(validateFxSequence({ ...follow, sections: [
      { ...follow.sections[0], at: { kind: "point", x: 1, y: 1 }, to: undefined },
    ] }).ok).toBe(false);
    expect(validateFxSequence({ ...follow, sections: [
      { ...follow.sections[0], follow: "yes" },
    ] }).ok).toBe(false);
  });

  test("rejects arbitrary URLs, unknown fields and runaway timelines", () => {
    const bad = (sections: unknown[]) => validateFxSequence({ version: 1, sections });
    expect(bad([{ kind: "image", id: "a", assetId: "https://evil", at: { kind: "point", x: 1, y: 1 }, startMs: 0, durationMs: 100 }]).ok).toBe(false);
    expect(bad([{ kind: "text", id: "a", text: "Hello", at: { kind: "point", x: 1, y: 1, secret: "not sent" }, startMs: 0, durationMs: 100 }]).ok).toBe(false);
    expect(bad([{ kind: "text", id: "a", text: "Hello", at: { kind: "source" }, startMs: 0, durationMs: 100, ops: [{ kind: "delete" }] }]).ok).toBe(false);
    expect(bad([{ kind: "image", id: "a", assetId: hash, at: { kind: "source" },
      to: { kind: "target", secret: "bad" }, startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "image", id: "a", assetId: hash, at: { kind: "source" },
      stretch: true, startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "image", id: "a", assetId: hash, at: { kind: "source" },
      to: { kind: "target" }, stretch: true, repeats: 3, startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "image", id: "a", assetId: hash, at: { kind: "source" },
      tint: "javascript:bad", startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "wait", id: "a", startMs: 59_000, durationMs: 4000 }]).ok).toBe(false);
    expect(bad([{ kind: "wait", id: "a", startMs: 0, durationMs: 100 }, { kind: "wait", id: "a", startMs: 100, durationMs: 100 }]).ok).toBe(false);
  });

  test("persistent timelines require bounded recurring media, not an unbounded wait or zero-frame loop", () => {
    expect(validateFxSequence({ ...sequence, persistent: true }).ok).toBe(true);
    expect(validateFxSequence({ version: 1, persistent: true, sections: [
      { kind: "wait", id: "w", startMs: 0, durationMs: 1000 },
    ] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, persistent: true, sections: [
      { kind: "text", id: "t", text: "Loop", at: { kind: "point", x: 0, y: 0 },
        startMs: 0, durationMs: 1 },
    ] }).ok).toBe(false);
    expect(validateFxSequence({ ...sequence, persistent: "untrusted" }).ok).toBe(false);
  });

  test("camera cues resolve a host-side destination, and a shake carries no anchor", () => {
    const camera: FxSequence = { version: 1, sections: [
      { kind: "camera", id: "look", mode: "pan", to: { kind: "target" }, easing: "easeInOut",
        zoom: 1.5, startMs: 0, durationMs: 1200 },
      { kind: "camera", id: "impact", mode: "shake", intensity: 0.6, startMs: 400, durationMs: 600 },
      { kind: "text", id: "title", text: "Steady", at: { kind: "point", x: 300, y: 300 },
        startMs: 0, durationMs: 900 },
    ] };
    expect(validateFxSequence(camera).ok).toBe(true);
    const result = resolveFxSequence(camera, scene, source, source, () => "image/png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The client is told where to look — never given an anchor to resolve itself.
    expect(result.sections[0]).toMatchObject({ kind: "camera", mode: "pan", toX: 120, toY: 150, zoom: 1.5 });
    expect("to" in (result.sections[0] ?? {})).toBe(false);
    expect(result.sections[1]).toMatchObject({ kind: "camera", mode: "shake", intensity: 0.6 });
    expect("toX" in (result.sections[1] ?? {})).toBe(false);
    // A camera cue is view-only: it changes no document and needs no media.
    expect(resolveFxSequence(camera, scene, source, source, () => undefined).ok).toBe(true);
  });

  test("a camera cue cannot loop, replay, crowd a timeline or leave the scene", () => {
    const bad = (sections: unknown[], persistent = false) =>
      validateFxSequence({ version: 1, persistent, sections });
    const pan = { kind: "camera", id: "p", mode: "pan", to: { kind: "point", x: 10, y: 10 },
      startMs: 0, durationMs: 500 };
    expect(bad([{ kind: "text", id: "t", text: "Loop", at: { kind: "point", x: 1, y: 1 },
      startMs: 0, durationMs: 500 }, pan], true).ok).toBe(false); // persistent = a view held forever
    expect(bad([{ ...pan, repeatCount: 3 }]).ok).toBe(false); // a view claim never replays
    expect(bad([{ ...pan, intensity: 0.5 }]).ok).toBe(false); // pan fields are not shake fields
    expect(bad([{ kind: "camera", id: "s", mode: "shake", startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "camera", id: "s", mode: "shake", intensity: 2, startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ kind: "camera", id: "s", mode: "shake", intensity: 0.5,
      to: { kind: "point", x: 1, y: 1 }, startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad([{ ...pan, durationMs: 50 }]).ok).toBe(false);
    expect(bad([{ ...pan, zoom: 40 }]).ok).toBe(false);
    expect(bad([{ ...pan, easing: "bounce" }]).ok).toBe(false);
    expect(bad([{ kind: "camera", id: "x", mode: "orbit", startMs: 0, durationMs: 500 }]).ok).toBe(false);
    expect(bad(Array.from({ length: 9 }, (_, i) => ({ ...pan, id: `p${i}`, startMs: i * 1000 }))).ok).toBe(false);
    // …and the destination is bounded by the scene, exactly like every other anchor.
    const off: FxSequence = { version: 1, sections: [{ kind: "camera", id: "p", mode: "pan",
      to: { kind: "point", x: 5000, y: 10 }, startMs: 0, durationMs: 500 }] };
    expect(validateFxSequence(off).ok).toBe(true); // in-range as data…
    expect(resolveFxSequence(off, scene, source, undefined, () => undefined).ok).toBe(false); // …out of the scene in fact
  });

  test("missing target, off-scene point and SVG are explicit errors", () => {
    expect(resolveFxSequence(sequence, scene, source, undefined, () => "image/png").ok).toBe(false);
    const off: FxSequence = { version: 1, sections: [{ kind: "text", id: "t", startMs: 0, durationMs: 100,
      text: "No", at: { kind: "point", x: 1200, y: 200 } }] };
    expect(resolveFxSequence(off, scene, undefined, undefined, () => undefined).ok).toBe(false);
    const png: FxSequence = { version: 1, sections: [{ kind: "image", id: "a", assetId: hash,
      at: { kind: "point", x: 30, y: 40 }, startMs: 0, durationMs: 100 }] };
    expect(resolveFxSequence(png, scene, undefined, undefined, () => "image/svg+xml").ok).toBe(false);
  });
});

describe("sound channels and fades (D-297)", () => {
  const withSound = (patch: Record<string, unknown>): FxSequence => ({ version: 1, sections: [
    { kind: "sound", id: "hum", assetId: sound, startMs: 0, durationMs: 1_000, ...patch } as never,
  ] });

  test("the four channels are accepted and an unknown one is refused, not silently ignored", () => {
    for (const channel of ["sfx", "music", "ambience", "voice"])
      expect(validateFxSequence(withSound({ channel })).ok).toBe(true);
    const bad = validateFxSequence(withSound({ channel: "bass" }));
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toContain("channel");
    // An absent channel is the default effect, so old timelines keep working.
    const plain = validateFxSequence(withSound({}));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.sequence.sections[0]).not.toHaveProperty("channel");
  });

  test("fades must fit inside the section, and zero is a legal fade", () => {
    expect(validateFxSequence(withSound({ fadeInMs: 400, fadeOutMs: 600 })).ok).toBe(true);
    expect(validateFxSequence(withSound({ fadeInMs: 1_000, fadeOutMs: 1_000 })).ok).toBe(true);
    expect(validateFxSequence(withSound({ fadeInMs: 0, fadeOutMs: 0 })).ok).toBe(true);
    for (const patch of [{ fadeInMs: 1_001 }, { fadeOutMs: 2_000 }, { fadeInMs: -1 },
      { fadeOutMs: Number.NaN }, { fadeInMs: "fast" }]) {
      const checked = validateFxSequence(withSound(patch));
      expect(checked.ok, JSON.stringify(patch)).toBe(false);
      expect(checked.ok ? "" : checked.error).toContain("fade");
    }
  });

  test("a channel or fade on a non-sound section is still an unknown field", () => {
    const wrong = { version: 1, sections: [
      { kind: "text", id: "t", text: "hi", at: { kind: "source" }, startMs: 0, durationMs: 500,
        channel: "music" }] } as unknown as FxSequence;
    expect(validateFxSequence(wrong).ok).toBe(false);
  });
});

describe("camera paths (D-298, SQ-15)", () => {
  const path = (patch: Record<string, unknown> = {}): FxSequence => ({ version: 1, sections: [
    { kind: "camera", id: "tour", mode: "path", startMs: 0, durationMs: 2_000,
      points: [{ kind: "point", x: 200, y: 200 }, { kind: "source" }, { kind: "target" }],
      ...patch } as never,
  ] });

  test("2–8 waypoint anchors are accepted; fewer, more or a non-anchor is refused", () => {
    expect(validateFxSequence(path()).ok).toBe(true);
    expect(validateFxSequence(path({ points: [{ kind: "point", x: 1, y: 1 }] })).ok).toBe(false);
    expect(validateFxSequence(path({ points: Array.from({ length: 9 }, (_, i) => ({ kind: "point", x: i, y: i })) })).ok)
      .toBe(false);
    expect(validateFxSequence(path({ points: "gate" })).ok).toBe(false);
    expect(validateFxSequence(path({ points: [{ kind: "point", x: 1, y: 1 }, { kind: "nope", x: 2, y: 2 }] })).ok)
      .toBe(false);
    for (const bad of [{ zoom: 0.05 }, { zoom: 11 }, { easing: "springy" }, { intensity: 0.5 }, { to: { kind: "source" } }]) {
      const checked = validateFxSequence(path(bad));
      expect(checked.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("camera invariants still hold: one section, ≥100 ms, never in a persistent timeline", () => {
    expect(validateFxSequence(path({ durationMs: 50 })).ok).toBe(false);
    expect(validateFxSequence(path({ durationMs: 100 })).ok).toBe(true);
    expect(validateFxSequence({ ...path(), persistent: true }).ok).toBe(false);
    expect(validateFxSequence(path({ repeatCount: 2 })).ok).toBe(false); // a camera never replays
  });

  test("the host resolves every waypoint and refuses one outside the scene", () => {
    const checked = resolveFxSequence(path(), scene, source, source, () => undefined);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const section = checked.sections[0] as Extract<typeof checked.sections[number], { mode: "path" }>;
    expect(section.points).toEqual([{ x: 200, y: 200 }, { x: 120, y: 150 }, { x: 120, y: 150 }]);
    expect("points" in section && section.points.every((point) => "kind" in point === false)).toBe(true);
    const outside = path({ points: [{ kind: "point", x: 5_000, y: 10 }, { kind: "point", x: 20, y: 20 }] });
    expect(resolveFxSequence(outside, scene, source, source, () => undefined).ok).toBe(false);
  });

  test("a path whose waypoints all resolve to the same place is refused as a no-op tour", () => {
    const stationary = path({ points: [{ kind: "source" }, { kind: "source" }, { kind: "source" }] });
    expect(validateFxSequence(stationary).ok).toBe(true); // authored, it looks like a tour…
    const resolved = resolveFxSequence(stationary, scene, source, source, () => undefined);
    expect(resolved.ok).toBe(false); // …resolved, it never goes anywhere
    if (!resolved.ok) expect(resolved.error).toContain("two different waypoints");
  });
});

describe("FX appearance: blend modes and one bounded filter (§SQ-05)", () => {
  test("every supported blend is accepted and an unknown one is refused by name", () => {
    for (const blend of ["normal", "add", "multiply", "screen", "overlay", "darken", "lighten"]) {
      expect(validateFxSequence(visual({ blend })).ok, blend).toBe(true);
    }
    const bad = validateFxSequence(visual({ blend: "glow" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("FX blend must be normal, add, multiply, screen, overlay, darken or lighten");
  });

  test("a filter carries its kind and an optional strength; both are checked", () => {
    expect(validateFxSequence(visual({ filter: { kind: "blur", strength: 12 } })).ok).toBe(true);
    expect(validateFxSequence(visual({ filter: { kind: "grayscale" } })).ok).toBe(true); // strength is optional
    const kind = validateFxSequence(visual({ filter: { kind: "sepia" } }));
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.error).toBe("FX filter must be blur, grayscale, brightness or saturate");
    // Each kind has its own range: 8 px of blur is legitimate, 8× of brightness is not.
    expect(validateFxSequence(visual({ filter: { kind: "blur", strength: 32 } })).ok).toBe(true);
    expect(validateFxSequence(visual({ filter: { kind: "blur", strength: 33 } })).ok).toBe(false);
    expect(validateFxSequence(visual({ filter: { kind: "blur", strength: 0 } })).ok).toBe(false);
    expect(validateFxSequence(visual({ filter: { kind: "brightness", strength: 2 } })).ok).toBe(true);
    expect(validateFxSequence(visual({ filter: { kind: "brightness", strength: 8 } })).ok).toBe(false);
    expect(validateFxSequence(visual({ filter: { kind: "saturate", strength: -0.5 } })).ok).toBe(false);
    expect(validateFxSequence(visual({ filter: { kind: "grayscale", strength: "all" } })).ok).toBe(false);
    // An unknown key inside the filter object is not a place to smuggle a setting.
    expect(validateFxSequence(visual({ filter: { kind: "blur", radius: 4 } })).ok).toBe(false);
  });

  test("a filter kind's range is the one the wizard offers, so authoring cannot lie to the host", () => {
    // The panel's min/max/default come from the same table the host validates against.
    expect(FX_FILTER_RANGES.blur.max).toBe(32);
    expect(FX_FILTER_RANGES.grayscale.default).toBe(1);
    for (const [kind, range] of Object.entries(FX_FILTER_RANGES)) {
      expect(validateFxSequence(visual({ filter: { kind, strength: range.default } })).ok, kind).toBe(true);
      expect(validateFxSequence(visual({ filter: { kind, strength: range.min } })).ok, kind).toBe(true);
      expect(validateFxSequence(visual({ filter: { kind, strength: range.max } })).ok, kind).toBe(true);
    }
  });

  test("appearance belongs to a visual section: a sound, text and camera cannot carry it", () => {
    // Text genuinely can — it is a visual — while sound and camera/wait cannot.
    expect(validateFxSequence({ version: 1, sections: [{ kind: "text", id: "t", text: "hi",
      at: { kind: "source" }, startMs: 0, durationMs: 500, blend: "screen" } as never] }).ok).toBe(true);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "sound", id: "s", assetId: sound,
      startMs: 0, durationMs: 500, blend: "add" } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "wait", id: "w",
      startMs: 0, durationMs: 500, filter: { kind: "blur" } } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "camera", id: "c", mode: "pan",
      to: { kind: "point", x: 10, y: 10 }, startMs: 0, durationMs: 500, blend: "add" } as never] }).ok).toBe(false);
  });

  test("the style plan fills in a default, clamps, and never invents a filter", () => {
    expect(fxStylePlan({})).toEqual({ blend: "normal" });
    expect(fxStylePlan({ blend: "add" })).toEqual({ blend: "add" });
    expect(fxStylePlan({ filter: { kind: "grayscale" } })).toEqual({ blend: "normal", filter: { kind: "grayscale", strength: 1 } });
    expect(fxStylePlan({ filter: { kind: "blur" } }).filter).toEqual({ kind: "blur", strength: 8 });
    // A cue that never passed the host must still render something sane.
    expect(fxStylePlan({ filter: { kind: "blur", strength: 500 } }).filter).toEqual({ kind: "blur", strength: 32 });
    expect(fxStylePlan({ filter: { kind: "brightness", strength: -3 } }).filter).toEqual({ kind: "brightness", strength: 0 });
    expect(fxStylePlan({ filter: { kind: "nonsense" as never } })).toEqual({ blend: "normal" });
  });

  test("resolving a visual keeps its appearance: the host adds anchors, not style", () => {
    const resolved = resolveFxSequence(visual({ blend: "screen", filter: { kind: "saturate", strength: 0.5 } }),
      scene, source, source, () => "image/png");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.sections[0]).toMatchObject({ blend: "screen", filter: { kind: "saturate", strength: 0.5 } });
  });
});

describe("camera targeting: one run, different views (§SQ-15/SQ-18, D-300)", () => {
  const camera = (patch: Record<string, unknown> = {}) => ({
    kind: "camera", id: "look", mode: "pan", to: { kind: "point", x: 300, y: 300 },
    startMs: 0, durationMs: 1000, ...patch });
  const cue = (patch: Record<string, unknown> = {}) => ({ version: 1,
    sections: [{ kind: "text", id: "t", text: "Now", at: { kind: "point", x: 10, y: 10 },
      startMs: 0, durationMs: 500 }, camera(patch)] });

  test("the three audiences are accepted on a camera section, and only there", () => {
    for (const audience of ["scene", "gm", "caller"]) {
      expect(validateFxSequence(cue({ audience })).ok, audience).toBe(true);
    }
    const bad = validateFxSequence(cue({ audience: "party" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("a camera section's audience must be scene, gm or caller");
    // A visual or sound section has no targeted delivery, so the field is unknown there.
    expect(validateFxSequence({ version: 1, sections: [{ kind: "image", id: "i", assetId: hash,
      at: { kind: "point", x: 1, y: 1 }, startMs: 0, durationMs: 500, audience: "gm" } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "sound", id: "s", assetId: sound,
      startMs: 0, durationMs: 500, audience: "gm" } as never] }).ok).toBe(false);
  });

  test("one run, one payload per viewer: an excluded viewer never receives the section", () => {
    const resolved = resolveFxSequence(cue({ audience: "gm" }) as FxSequence, scene, source, source, () => undefined);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const gm = fxSectionsForViewer(resolved.sections, { id: "gm-1", isGm: true }, "gm-1");
    const player = fxSectionsForViewer(resolved.sections, { id: "p-1", isGm: false }, "gm-1");
    expect(gm).toHaveLength(2);
    expect(player).toHaveLength(1);
    expect(player[0]?.kind).toBe("text");
    // The exclusion is the *payload*: nothing about the destination survives it.
    expect(JSON.stringify(player)).not.toContain("300");
  });

  test("scene is the default, caller means the requester, and nothing else is touched", () => {
    const resolved = resolveFxSequence(cue() as FxSequence, scene, source, source, () => undefined);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // Nothing to exclude: the host hands back the very same array (no allocation).
    expect(fxSectionsForViewer(resolved.sections, { id: "p", isGm: false }, "p")).toBe(resolved.sections);
    const requested = resolveFxSequence(cue({ audience: "caller" }) as FxSequence, scene, source, source, () => undefined);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(fxSectionsForViewer(requested.sections, { id: "p", isGm: false }, "p")).toHaveLength(2);
    // A GM who is not the caller is not "the caller", even though they are a GM.
    expect(fxSectionsForViewer(requested.sections, { id: "gm-2", isGm: true }, "p")).toHaveLength(1);
    // A targeted *shake* is filtered by the same rule as a pan.
    const shake = resolveFxSequence({ version: 1, sections: [{ kind: "camera", id: "s", mode: "shake",
      intensity: 0.5, audience: "gm", startMs: 0, durationMs: 500 }] } as FxSequence,
      scene, source, source, () => undefined);
    expect(shake.ok).toBe(true);
    if (!shake.ok) return;
    expect(fxSectionsForViewer(shake.sections, { id: "p", isGm: false }, "p")).toHaveLength(0);
  });
});

describe("effect masks and cutouts (§SQ-19/SQ-05, D-301)", () => {
  const masked = (mask: unknown) => ({ version: 1, sections: [{ kind: "image", id: "aura", assetId: hash,
    at: { kind: "point", x: 200, y: 200 }, startMs: 0, durationMs: 1000, mask } as never] });

  test("four shapes are accepted; a point is refused because it has nothing to mask with", () => {
    expect(validateFxSequence(masked({ kind: "circle", length: 15 })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "cone", length: 30, spread: 90 })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "ray", length: 60, width: 5, angle: 45 })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "rect", length: 20, width: 10 })).ok).toBe(true);
    const point = validateFxSequence(masked({ kind: "point" }));
    expect(point.ok).toBe(false);
    if (!point.ok) expect(point.error).toContain("cannot be a point");
    const unknown = validateFxSequence(masked({ kind: "star", length: 5 }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe("an FX mask must be a circle, cone, ray or rect");
  });

  test("each shape takes only its own fields, so a stale width is a refusal and not a shrug", () => {
    expect(validateFxSequence(masked({ kind: "circle", length: 10, width: 4 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "circle", length: 10, angle: 30 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "cone", length: 10, width: 4 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "ray", length: 10 })).ok).toBe(false); // no width
    expect(validateFxSequence(masked({ kind: "rect", length: 10, width: 4, spread: 90 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "rect", length: 10, width: 4, opacity: 1 })).ok).toBe(false);
  });

  test("metrics are bounded in scene units, and invert is a boolean", () => {
    expect(validateFxSequence(masked({ kind: "circle", length: 0.4 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "circle", length: 5_001 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "ray", length: 20, width: 0 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "cone", length: 20, spread: 400 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "cone", length: 20, spread: 0 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "ray", length: 20, width: 4, angle: -400 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "circle", length: 10, invert: "yes" })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "circle", length: 10, invert: true })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "circle", length: "ten" })).ok).toBe(false);
  });

  test("a region animates by its own two rules: a growth in scene units and a turn in degrees", () => {
    expect(validateFxSequence(masked({ kind: "circle", length: 10, lengthTo: 40 })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "rect", length: 10, width: 4, lengthTo: 30, spinDeg: 90 })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "cone", length: 20, spinDeg: -3600 })).ok).toBe(true);
    // A growth is measured in the same scene units as the region itself, so it has the
    // same bounds — and a turn is bounded like the visual's own spin.
    expect(validateFxSequence(masked({ kind: "circle", length: 10, lengthTo: 0.4 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "circle", length: 10, lengthTo: 5_001 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "cone", length: 20, spinDeg: 3_601 })).ok).toBe(false);
    expect(validateFxSequence(masked({ kind: "cone", length: 20, spinDeg: "sweep" })).ok).toBe(false);
    // A circle has no facing, so it takes no turn — a field the shape cannot use.
    const circleTurn = validateFxSequence(masked({ kind: "circle", length: 10, spinDeg: 90 }));
    expect(circleTurn.ok).toBe(false);
    if (!circleTurn.ok) expect(circleTurn.error).toContain("an FX circle mask takes only");
  });

  test("a wall-bounded region is trimmed against the scene's own sight, and cannot animate", () => {
    const wall = (c: [number, number, number, number], patch: Partial<WallDocument> = {}): WallDocument =>
      ({ _id: `w-${c[0]}-${c[1]}`, type: "wall", name: "W", ownership: { default: 0 },
        flags: {}, system: {}, c, door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0, ...patch });
    // A vertical wall 200 px (10 units) east of the anchor at (200, 200), spanning far
    // past the mask's 300 px reach on BOTH sides — a shorter wall would leave a real gap
    // around its ends, which is correct visibility rather than a missed trim.
    const walled: SceneDocument = { ...scene, walls: [wall([400, -200, 400, 1_000])] };
    const at200 = masked({ kind: "circle", length: 15, walls: true });
    const trimmed = resolveFxSequence(at200 as FxSequence, walled, source, source, () => "image/png");
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    const mask = (trimmed.sections[0] as Extract<typeof trimmed.sections[number], { mask?: unknown }>)
      .mask as { area: Array<{ x: number; y: number }> };
    // The authored reach is 15 units = 300 px; the wall is 200 px away and the anchor sits
    // at (200, 200), so the region reaches 300 px west and stops at 200 px east.
    const reachOf = (pick: (point: { x: number; y: number }) => number, most: boolean) =>
      most ? Math.max(...mask.area.map(pick)) : Math.min(...mask.area.map(pick));
    expect(reachOf((point) => point.x, true)).toBeCloseTo(200, 0);
    expect(reachOf((point) => point.x, false)).toBeCloseTo(-300, 0);
    expect(Math.max(...mask.area.map((point) => Math.hypot(point.x, point.y)))).toBeCloseTo(300, 0);
    // It touches the wall rather than stopping short of it — the trim is the wall's own line.
    expect(mask.area.some((point) => Math.abs(point.x - 200) < 0.5)).toBe(true);
    // Offsets from the anchor, like any other resolved mask: the shape travels with it.
    expect(mask.area.every((point) => Math.abs(point.x) <= 300.5)).toBe(true);

    // Nothing in reach is nothing to trim: the authored circle stands exactly as it was.
    const open = resolveFxSequence(masked({ kind: "circle", length: 15, walls: true }) as FxSequence,
      scene, source, source, () => "image/png");
    if (!open.ok) return;
    const plain = (open.sections[0] as Extract<typeof open.sections[number], { mask?: unknown }>)
      .mask as { area: Array<{ x: number; y: number }> };
    expect(plain.area).toHaveLength(16);
    expect(Math.max(...plain.area.map((point) => point.x))).toBeCloseTo(300, 3);

    // The same sight rule the fog uses: a window (sight: 2 = passes) never trims, a closed
    // door does, and opening that door stops trimming — doors obey state here too.
    const places = (patch: Partial<WallDocument>) => resolveFxSequence(
      masked({ kind: "circle", length: 15, walls: true }) as FxSequence,
      { ...scene, walls: [wall([400, -200, 400, 1_000], patch)] }, source, source, () => "image/png");
    const maxX = (result: ReturnType<typeof resolveFxSequence>) => {
      if (!result.ok) return null;
      const found = (result.sections[0] as Extract<typeof result.sections[number], { mask?: unknown }>)
        .mask as { area: Array<{ x: number; y: number }> };
      return Math.max(...found.area.map((point) => point.x));
    };
    // `door`: 0 closed | 1 open | 2 locked, and `sight`: 0 always blocks | 1 conditional | 2 passes.
    expect(maxX(places({ sight: 2, door: 0 }))).toBeCloseTo(300, 0); // a window passes sight
    expect(maxX(places({ sight: 1, door: 0 }))).toBeCloseTo(200, 0); // a closed door blocks
    expect(maxX(places({ sight: 1, door: 1 }))).toBeCloseTo(300, 0); // an open door does not
    expect(maxX(places({ sight: 1, door: 2 }))).toBeCloseTo(200, 0); // a locked door does
    expect(maxX(places({ sight: 0, door: 1 }))).toBeCloseTo(200, 0); // an opaque wall, open door or not

    // A growth or a turn is refused rather than silently ignored: the trim is baked, and a
    // recipient has no walls to re-trim against.
    const growing = validateFxSequence(masked({ kind: "circle", length: 15, walls: true, lengthTo: 30 }));
    expect(growing.ok).toBe(false);
    if (!growing.ok) expect(growing.error).toContain("cannot animate");
    expect(validateFxSequence(masked({ kind: "circle", length: 15, walls: true })).ok).toBe(true);
    expect(validateFxSequence(masked({ kind: "circle", length: 15, walls: "yes" })).ok).toBe(false);
    // Walls on every side cap the region in every direction: an anchor in a 200×200 room
    // sees the room, not its authored 300 px circle — the reach is the *smaller* of the two.
    const room: SceneDocument = { ...scene, walls: [
      wall([100, 100, 300, 100]), wall([300, 100, 300, 300]),
      wall([300, 300, 100, 300]), wall([100, 300, 100, 100]),
    ] };
    const enclosed = resolveFxSequence(masked({ kind: "circle", length: 15, walls: true }) as FxSequence,
      room, source, source, () => "image/png");
    expect(enclosed.ok).toBe(true);
    if (!enclosed.ok) return;
    const inside = (enclosed.sections[0] as Extract<typeof enclosed.sections[number], { mask?: unknown }>)
      .mask as { area: Array<{ x: number; y: number }> };
    expect(inside.area.length).toBeGreaterThanOrEqual(3);
    for (const point of inside.area) {
      expect(Math.abs(point.x)).toBeLessThan(100.5);
      expect(Math.abs(point.y)).toBeLessThan(100.5);
    }

    // An anchor standing *on* a wall sees nothing at all, and that is refused rather than
    // drawn as an empty mask — "a control that would do nothing" again.
    const onWall: SceneDocument = { ...scene, walls: [wall([0, 200, 400, 200])] };
    const blind = resolveFxSequence(masked({ kind: "circle", length: 15, walls: true }) as FxSequence,
      onWall, source, source, () => "image/png");
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.error).toContain("cannot start on a wall");
  });

  test("a mask belongs to a visual: sound, wait and camera sections refuse it as unknown", () => {
    expect(validateFxSequence({ version: 1, sections: [{ kind: "sound", id: "s", assetId: sound,
      startMs: 0, durationMs: 500, mask: { kind: "circle", length: 5 } } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "wait", id: "w", startMs: 0,
      durationMs: 500, mask: { kind: "circle", length: 5 } } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "camera", id: "c", mode: "pan",
      to: { kind: "point", x: 10, y: 10 }, startMs: 0, durationMs: 500,
      mask: { kind: "circle", length: 5 } } as never] }).ok).toBe(false);
  });

  test("resolution turns an authored growth into a unit-free ratio, not a second length", () => {
    const resolved = resolveFxSequence(
      masked({ kind: "circle", length: 15, lengthTo: 60 }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const section = resolved.sections[0] as Extract<typeof resolved.sections[number], { mask?: unknown }>;
    const mask = section.mask as { area: Array<{ x: number; y: number }>; invert: boolean; animate?: unknown };
    // Four times the reach, as a ratio: a client still never learns what "15 ft" is. A
    // circle takes no turn, so the recipe carries only the growth it was given.
    expect(mask.animate).toEqual({ scale: 4 });
    const radius = Math.max(...mask.area.map((point) => Math.hypot(point.x, point.y)));
    expect(radius).toBeCloseTo(300, 3);
    // A cone's turn travels as the degrees the author wrote — the polygon already holds
    // the authored bearing, so the client only ever applies the delta.
    const turning = resolveFxSequence(
      masked({ kind: "cone", length: 20, angle: 90, spinDeg: 120 }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(turning.ok).toBe(true);
    if (!turning.ok) return;
    const cone = turning.sections[0] as Extract<typeof turning.sections[number], { mask?: unknown }>;
    expect((cone.mask as { animate?: unknown }).animate).toEqual({ spinDeg: 120 });
    // A still region carries no animation at all — not an identity recipe.
    const still = resolveFxSequence(masked({ kind: "circle", length: 15 }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    const plain = still.sections[0] as Extract<typeof still.sections[number], { mask?: unknown }>;
    expect((plain.mask as { animate?: unknown }).animate).toBeUndefined();
  });

  test("the host resolves the shape into an offset polygon against the scene's own grid", () => {
    // The fixture scene is 100 px per 5 ft, so a 15 ft circle is 300 px of radius.
    const resolved = resolveFxSequence(masked({ kind: "circle", length: 15 }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const section = resolved.sections[0] as Extract<typeof resolved.sections[number], { mask?: unknown }>;
    const mask = section.mask as { area: Array<{ x: number; y: number }>; invert: boolean };
    expect(mask.invert).toBe(false);
    expect(mask.area.length).toBeGreaterThan(8);
    const radius = Math.max(...mask.area.map((point) => Math.hypot(point.x, point.y)));
    expect(radius).toBeCloseTo(300, 3);
    // Relative to the anchor: the polygon is centred on the origin, not on (200, 200).
    const centroid = mask.area.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 });
    expect(Math.abs(centroid.x / mask.area.length)).toBeLessThan(1);
    expect(Math.abs(centroid.y / mask.area.length)).toBeLessThan(1);
    // The authored numbers are gone: what travels is the polygon.
    expect(section.mask && "kind" in section.mask).toBe(false);
    expect(JSON.stringify(resolved.sections)).not.toContain('"length"');
  });

  test("a cutout and an angle survive resolution; a shape with no metric is refused", () => {
    const cut = resolveFxSequence(masked({ kind: "rect", length: 20, width: 10, angle: 90, invert: true }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const mask = (cut.sections[0] as { mask?: { area: Array<{ x: number; y: number }>; invert: boolean } }).mask;
    expect(mask?.invert).toBe(true);
    // A 90° rect is taller than it is wide: its vertical extent is the length.
    const height = Math.max(...(mask?.area ?? []).map((point) => Math.abs(point.y)));
    const width = Math.max(...(mask?.area ?? []).map((point) => Math.abs(point.x)));
    expect(height).toBeGreaterThan(width);
    // A broken grid metric is refused: "15 ft" with no scale is not 15 px, it is a
    // document the author cannot mean. A gridless scene is read 1:1 instead, which is
    // the crosshair's own rule for a scene that has no metric by design.
    const metricless = { ...scene, grid: { ...scene.grid, distance: 0 } };
    const refused = resolveFxSequence(masked({ kind: "circle", length: 15 }) as FxSequence,
      metricless, source, source, () => "image/png");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("grid metric");
    // A gridless scene *with* a metric converts exactly the same way (the picker reads
    // the same fields), and a gridless scene without one is read 1:1 — its own rule for
    // a scene that has no scale by design.
    const gridless = { ...scene, grid: { ...scene.grid, type: "gridless" as const } };
    const sameMetric = resolveFxSequence(masked({ kind: "circle", length: 15 }) as FxSequence,
      gridless, source, source, () => "image/png");
    expect(sameMetric.ok).toBe(true);
    if (sameMetric.ok)
      expect(Math.max(...((sameMetric.sections[0] as { mask?: { area: Array<{ x: number; y: number }> } })
        .mask?.area ?? []).map((point) => Math.hypot(point.x, point.y)))).toBeCloseTo(300, 3);
    const unmeasured = { ...scene,
      grid: { ...scene.grid, type: "gridless" as const, size: 0, distance: 0 } };
    const oneToOne = resolveFxSequence(masked({ kind: "circle", length: 15 }) as FxSequence,
      unmeasured, source, source, () => "image/png");
    expect(oneToOne.ok).toBe(true);
    if (oneToOne.ok) {
      const shape = (oneToOne.sections[0] as { mask?: { area: Array<{ x: number; y: number }> } }).mask;
      expect(Math.max(...(shape?.area ?? []).map((point) => Math.hypot(point.x, point.y)))).toBeCloseTo(15, 3);
    }
  });
});

describe("animated transform: growth and spin (§SQ-05, D-302)", () => {
  const visual = (patch: Record<string, unknown> = {}) => ({ version: 1, sections: [
    { kind: "image", id: "coin", assetId: hash, at: { kind: "point", x: 200, y: 200 },
      startMs: 0, durationMs: 1000, ...patch } as never] });

  test("scaleTo and spinDeg are bounded, and a bad one names the field's own range", () => {
    expect(validateFxSequence(visual({ scaleTo: 2.5 })).ok).toBe(true);
    expect(validateFxSequence(visual({ spinDeg: 720 })).ok).toBe(true);
    expect(validateFxSequence(visual({ spinDeg: -3600 })).ok).toBe(true);
    expect(validateFxSequence(visual({ scaleTo: 0.01 })).ok).toBe(false);
    expect(validateFxSequence(visual({ scaleTo: 11 })).ok).toBe(false);
    expect(validateFxSequence(visual({ spinDeg: 3601 })).ok).toBe(false);
    expect(validateFxSequence(visual({ spinDeg: -3601 })).ok).toBe(false);
    expect(validateFxSequence(visual({ spinDeg: "fast" })).ok).toBe(false);
    // The animation is a transform, not a movement: it does not need a destination.
    expect(validateFxSequence(visual({ to: undefined, scaleTo: 2 })).ok).toBe(true);
  });

  test("neither field is a place for another kind of section to smuggle a setting", () => {
    expect(validateFxSequence({ version: 1, sections: [{ kind: "sound", id: "s", assetId: sound,
      startMs: 0, durationMs: 500, spinDeg: 90 } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "wait", id: "w", startMs: 0,
      durationMs: 500, scaleTo: 2 } as never] }).ok).toBe(false);
    expect(validateFxSequence({ version: 1, sections: [{ kind: "camera", id: "c", mode: "pan",
      to: { kind: "point", x: 10, y: 10 }, startMs: 0, durationMs: 500, spinDeg: 90 } as never] }).ok).toBe(false);
  });
});

// D-304 (SQ-05): the filter's own strength animates now — `filter.strength` is where it
// starts, `filterTo` where it ends, on the same curve the transform uses.
describe("animated filter strength (§SQ-05, D-304)", () => {
  const hash = "a".repeat(64);
  const visual = (patch: Record<string, unknown> = {}) => ({ version: 1,
    sections: [{ kind: "image", id: "ghost", assetId: hash, at: { kind: "point", x: 200, y: 200 },
      startMs: 0, durationMs: 1000, filter: { kind: "blur", strength: 2 }, ...patch } as never] });

  test("a filter animation needs a kind, and both of its ends live in that kind's range", () => {
    expect(validateFxSequence(visual({ filterTo: 16 })).ok).toBe(true);
    expect(validateFxSequence(visual({ filterTo: 1 })).ok).toBe(true); // the low end is still a blur
    // A blur that faded to 0 would be a blur that stopped existing, which is what
    // dropping the filter says — so 0 is out of range for this kind, not a special case.
    expect(validateFxSequence(visual({ filterTo: 0 })).ok).toBe(false);
    expect(validateFxSequence(visual({ filterTo: 33 })).ok).toBe(false);
    expect(validateFxSequence(visual({ filterTo: "heavy" })).ok).toBe(false);
    // The range belongs to the KIND: 1.5 is a blur and an impossible grayscale.
    expect(validateFxSequence(visual({ filter: { kind: "grayscale" }, filterTo: 1 })).ok).toBe(true);
    expect(validateFxSequence(visual({ filter: { kind: "grayscale" }, filterTo: 1.5 })).ok).toBe(false);
    // Named as itself rather than as an unknown field.
    const orphan = validateFxSequence({ version: 1, sections: [{ kind: "image", id: "g", assetId: hash,
      at: { kind: "point", x: 1, y: 1 }, startMs: 0, durationMs: 500, filterTo: 4 } as never] });
    expect(orphan.ok).toBe(false);
    expect(orphan.ok ? "" : orphan.error).toContain("filter kind to animate");
  });

  test("the plan carries an animation's end only when the author asked for one", () => {
    expect(fxStylePlan({ filter: { kind: "blur", strength: 2 } })).toEqual({ blend: "normal",
      filter: { kind: "blur", strength: 2 } });
    expect(fxStylePlan({ filter: { kind: "blur", strength: 2 }, filterTo: 16 }).filter)
      .toEqual({ kind: "blur", strength: 2, to: 16 });
    // Clamped like the start: a hand-written cue must not render past its kind's range.
    expect(fxStylePlan({ filter: { kind: "blur", strength: 2 }, filterTo: 900 }).filter)
      .toEqual({ kind: "blur", strength: 2, to: 32 });
    // Without a kind there is nothing to animate and nothing to clamp against.
    expect(fxStylePlan({ filterTo: 16 })).toEqual({ blend: "normal" });
  });

  test("the strength walks from one end to the other, eased, and pulses per cycle", () => {
    const plan = { kind: "blur" as const, strength: 2, to: 10 };
    const section = { durationMs: 1000 };
    expect(fxFilterStrength(plan, section, 0)).toBeCloseTo(2, 5);
    expect(fxFilterStrength(plan, section, 500)).toBeCloseTo(6, 5);
    expect(fxFilterStrength(plan, section, 1000)).toBeCloseTo(10, 5);
    // The section's own curve carries it, exactly like position, scale and spin.
    expect(fxFilterStrength(plan, { ...section, easing: "easeIn" }, 500)).toBeCloseTo(4, 5);
    expect(fxFilterStrength(plan, { ...section, easing: "easeOut" }, 500)).toBeCloseTo(8, 5);
    // Two cycles over one window is a pulse: each cycle runs the whole animation, so the
    // peak lands at the END of a cycle and the strength snaps back at the boundary.
    const pulsed = { ...section, repeats: 2 };
    expect(fxFilterStrength(plan, pulsed, 250)).toBeCloseTo(6, 5);
    expect(fxFilterStrength(plan, pulsed, 499)).toBeCloseTo(10, 1);
    expect(fxFilterStrength(plan, pulsed, 500)).toBeCloseTo(2, 5);
    expect(fxFilterStrength(plan, pulsed, 1000)).toBeCloseTo(10, 5);
    // A still filter is the start value, whatever the clock says.
    expect(fxFilterStrength({ kind: "grayscale", strength: 0.5 }, section, 999)).toBeCloseTo(0.5, 5);
    expect(fxFilterStrength(plan, section, Number.NaN)).toBeCloseTo(2, 5);
    expect(fxFilterStrength(plan, { durationMs: 0 }, 100)).toBeCloseTo(2, 5);
  });

  test("resolving a visual keeps its animated filter: the host adds anchors, not style", () => {
    const resolved = resolveFxSequence(
      visual({ filter: { kind: "saturate", strength: 0.2 }, filterTo: 1.8 }) as FxSequence,
      scene, source, source, () => "image/png");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.sections[0]).toMatchObject({ filter: { kind: "saturate", strength: 0.2 },
      filterTo: 1.8 });
  });
});
