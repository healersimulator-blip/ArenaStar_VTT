import { describe, expect, test } from "vitest";
import { FX_FILTER_RANGES, fxStylePlan, resolveFxSequence, validateFxSequence,
  type FxSequence } from "../../src/core/fx";
import { fxFollowAnchors, fxPosition } from "../../src/canvas/layers/FxLayer";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";

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
