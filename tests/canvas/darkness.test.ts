/**
 * Plan §2.1 (G-24) — **sight bounded by lighting**: the pure light/vision matrix.
 *
 * The rule under test, in one line:
 *
 *   effective radius = max(darkvision, min(sight, lit radius))
 *
 * and, for what a player is *shown*, an extra term: a token in the dark is visible only to an
 * eye whose darkvision reaches it (or when something lights it).
 *
 * Every case here is a table the module has to reproduce, cited in the test name:
 *
 * - PF1e darkvision: "sees in total darkness up to the listed range" (CRB p.562 "Vision and
 *   Light" table / AoN *Special Abilities, Darkvision*) — a separate sense, so it is never
 *   *reduced* by darkness and never limited by a light source.
 * - Ambient darkness (`SceneDocument.darkness`, Roll20's "Global Illumination"/darkness slider)
 *   is the scene-level term: `0` = fully lit, so every scene written before this slice behaves
 *   as it did; total darkness is `1`.
 * - Light radii are authored in **scene pixels** (`LightDocument.dim`/`bright`), token vision in
 *   **feet** (a stat block language), converted through the grid: 5 ft. per 100 px cell = 20
 *   px per foot.
 */
import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  LightDocument,
  SceneDocument,
  SceneGrid,
  TokenDocument,
} from "../../src/core/documents";
import {
  fogRevealKey,
  fogViewers,
  fogVisibleTokenIds,
  sceneDarknessOp,
  type FogViewer,
} from "../../src/core/fogExploration";
import {
  effectiveSightRadiusPx,
  feetToPixels,
  isLitAt,
  lightLevelAt,
  pixelsPerFoot,
  sceneLightSources,
  sceneLighting,
  tokenLightSourceOf,
  tokenVisionOf,
  viewerSightRadiusPx,
  withinDarkvision,
} from "../../src/canvas/vision/darkness";

const GRID: SceneGrid = {
  type: "square",
  size: 100,
  distance: 5,
  units: "ft",
  diagonals: "555",
  hexLayout: "oddQ",
};

const token = (id: string, over: Partial<TokenDocument> = {}): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 0 },
  flags: {},
  system: {},
  x: 100,
  y: 100,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  ...over,
});

const scene = (over: Partial<SceneDocument> = {}): SceneDocument => ({
  _id: "s1",
  type: "scene",
  name: "Scene",
  ownership: { default: 0 },
  flags: {},
  system: {},
  active: true,
  img: null,
  width: 1000,
  height: 1000,
  grid: GRID,
  darkness: 0,
  tokens: [],
  walls: [],
  lights: [],
  sounds: [],
  tiles: [],
  drawings: [],
  templates: [],
  notes: [],
  ...over,
});

const placedLight = (
  id: string,
  x: number,
  y: number,
  dim: number,
  bright = Math.round(dim / 2),
): LightDocument => ({
  _id: id,
  type: "light",
  name: id,
  ownership: { default: 0 },
  flags: {},
  system: {},
  x,
  y,
  dim,
  bright,
  color: "#ffcc66",
  alpha: 0.6,
});

describe("§2.1 — units: feet (stat blocks) ↔ pixels (scene geometry)", () => {
  test("the grid decides the conversion: 5 ft. per 100 px cell is 20 px per foot", () => {
    expect(pixelsPerFoot(GRID)).toBe(20);
    expect(feetToPixels(60, GRID)).toBe(1200);
    expect(feetToPixels(0, GRID)).toBe(0);
    // A 10-ft. hex at 70 px is 7 px per foot.
    expect(pixelsPerFoot({ ...GRID, size: 70, distance: 10 })).toBe(7);
    // Absent/garbage grid falls back to the 5-ft., 100-px default rather than dividing by zero.
    expect(pixelsPerFoot(null)).toBe(20);
    expect(pixelsPerFoot({ ...GRID, distance: 0 })).toBe(20);
    expect(pixelsPerFoot({ ...GRID, size: 0 })).toBe(20);
  });
});

describe("§2.1 — a token's own vision model", () => {
  test("absent sight is unlimited; absent darkvision is none (CRB p.562)", () => {
    expect(tokenVisionOf(token("t"))).toEqual({ sightFeet: null, darkvisionFeet: 0 });
    expect(tokenVisionOf(token("t", { sight: 60, darkvision: 60 }))).toEqual({
      sightFeet: 60,
      darkvisionFeet: 60,
    });
    // 0 / negative / garbage are "not authored", never a zero-foot sense that would blind a token.
    expect(tokenVisionOf(token("t", { sight: 0, darkvision: -30 }))).toEqual({
      sightFeet: null,
      darkvisionFeet: 0,
    });
    expect(tokenVisionOf(token("t", { sight: Number.NaN })).sightFeet).toBeNull();
  });

  test("a token's carried light: radius 0 is no light, bright defaults to half the dim", () => {
    expect(tokenLightSourceOf(token("t"))).toBeNull();
    expect(tokenLightSourceOf(token("t", { light: { radius: 0, color: "#fff", alpha: 0.5 } }))).toBeNull();
    expect(tokenLightSourceOf(token("t", { light: { radius: 200, color: "#fff", alpha: 0.5 } }))).toEqual({
      id: "token:t",
      x: 100,
      y: 100,
      bright: 100,
      dim: 200,
      color: "#fff",
      alpha: 0.5,
    });
    // A torch lit with no colour authored keeps the layer's default tone: the field is absent,
    // not `undefined`-valued, so `JSON.stringify` of a persisted source stays clean. (The
    // document model requires the pair, but a scene persisted before it did not, and the
    // lighting layer default must stay reachable — hence the cast.)
    const bare = { radius: 200 } as unknown as TokenDocument["light"];
    expect(tokenLightSourceOf(token("t", { light: bare }))).toEqual({
      id: "token:t",
      x: 100,
      y: 100,
      bright: 100,
      dim: 200,
    });
    // An authored bright radius wins; one larger than the dim radius is clamped (bright ⊆ dim).
    expect(
      tokenLightSourceOf(token("t", { light: { radius: 200, bright: 150, color: "#fff", alpha: 0.5 } })),
    ).toMatchObject({ bright: 150, dim: 200 });
    expect(
      tokenLightSourceOf(token("t", { light: { radius: 200, bright: 400, color: "#fff", alpha: 0.5 } })),
    ).toMatchObject({ bright: 200, dim: 200 });
  });

  test("the scene's lights are the placed ones plus every carried torch", () => {
    const s = scene({
      lights: [placedLight("l1", 400, 400, 300)],
      tokens: [token("a", { light: { radius: 120, color: "#fff", alpha: 0.5 } }), token("b")],
    });
    const sources = sceneLightSources(s);
    expect(sources.map((l) => l.id)).toEqual(["l1", "token:a"]);
    expect(sceneLighting(s).lights).toHaveLength(2);
    // Darkness is clamped: a scene cannot be more than totally dark or less than lit.
    expect(sceneLighting({ ...s, darkness: 5 }).darkness).toBe(1);
    expect(sceneLighting({ ...s, darkness: -2 }).darkness).toBe(0);
  });
});

describe("§2.1 — the light level at a point", () => {
  test("ambient light reaches everywhere; total darkness reaches nowhere without a light", () => {
    const lit = lightLevelAt({ x: 0, y: 0 }, { darkness: 0, lights: [] });
    // Ambient light *is* light: the point is lit (dim, not bright) with unlimited reach.
    expect(lit).toEqual({ ambient: true, bright: false, lit: true, litRadiusPx: Number.POSITIVE_INFINITY });
    const dark = lightLevelAt({ x: 0, y: 0 }, { darkness: 1, lights: [] });
    expect(dark).toEqual({ ambient: false, bright: false, lit: false, litRadiusPx: 0 });
    expect(isLitAt({ x: 0, y: 0 }, { darkness: 1, lights: [] })).toBe(false);
    expect(isLitAt({ x: 0, y: 0 }, { darkness: 0, lights: [] })).toBe(true);
  });

  test("inside the bright radius, the dim radius, and outside both", () => {
    const lighting = { darkness: 1, lights: [{ id: "l", x: 0, y: 0, bright: 100, dim: 300 }] };
    // At the light itself: bright, and the whole dim reach is available from here.
    expect(lightLevelAt({ x: 0, y: 0 }, lighting)).toEqual({
      ambient: false,
      bright: true,
      lit: true,
      litRadiusPx: 300,
    });
    // 150 px out: past the bright edge, inside the dim one — dim light, 150 px of reach left.
    expect(lightLevelAt({ x: 150, y: 0 }, lighting)).toEqual({
      ambient: false,
      bright: false,
      lit: true,
      litRadiusPx: 150,
    });
    // Exactly at the dim edge is lit with no reach; past it is dark.
    expect(lightLevelAt({ x: 300, y: 0 }, lighting).lit).toBe(true);
    expect(lightLevelAt({ x: 300, y: 0 }, lighting).litRadiusPx).toBe(0);
    expect(lightLevelAt({ x: 301, y: 0 }, lighting).lit).toBe(false);
    // Distance is euclidean, not per-axis: (200,200) is 282 px out, inside the dim radius.
    expect(lightLevelAt({ x: 200, y: 200 }, lighting).lit).toBe(true);
    expect(lightLevelAt({ x: 250, y: 250 }, lighting).lit).toBe(false);
  });

  test("several lights: the best reach wins, and any bright radius makes the point bright", () => {
    const lighting = {
      darkness: 1,
      lights: [
        { id: "small", x: 100, y: 0, bright: 20, dim: 60 },
        { id: "big", x: 0, y: 0, bright: 50, dim: 400 },
      ],
    };
    const at = lightLevelAt({ x: 100, y: 0 }, lighting);
    expect(at.bright).toBe(true); // inside `small`'s bright radius
    expect(at.litRadiusPx).toBe(300); // and `big` still reaches 300 px from here
  });
});

describe("§2.1 — the effective radius: max(darkvision, min(sight, light))", () => {
  const dark = { darkness: 1, lights: [] };

  test("unlit, no darkvision → nothing revealed (the whole point of the slice)", () => {
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 60, darkvisionFeet: 0 },
        lighting: dark,
        pxPerFoot: 20,
      }),
    ).toBe(0);
  });

  test("darkvision is independent of light: 60 ft. sees 1,200 px in total darkness", () => {
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 30, darkvisionFeet: 60 },
        lighting: dark,
        pxPerFoot: 20,
      }),
    ).toBe(1200);
    // …and a *smaller* darkvision never undercuts a lit, longer normal sight.
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 120, darkvisionFeet: 10 },
        lighting: { darkness: 0, lights: [] },
        pxPerFoot: 20,
      }),
    ).toBe(2400);
  });

  test("light caps normal sight; ambient light does not cap at all", () => {
    const torchAtFeet = {
      darkness: 1,
      lights: [{ id: "torch", x: 0, y: 0, bright: 100, dim: 300 }],
    };
    // Sight 60 ft. (1,200 px) but the torch only reaches 300 px from here → 300.
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 60, darkvisionFeet: 0 },
        lighting: torchAtFeet,
        pxPerFoot: 20,
      }),
    ).toBe(300);
    // Sight 5 ft. (100 px) inside a 300-px light stays 100: the light does not extend *sight*.
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 5, darkvisionFeet: 0 },
        lighting: torchAtFeet,
        pxPerFoot: 20,
      }),
    ).toBe(100);
    // Ambient light: the sight range alone, with no light term.
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: 60, darkvisionFeet: 0 },
        lighting: { darkness: 0.5, lights: [] },
        pxPerFoot: 20,
      }),
    ).toBe(1200);
  });

  test("unlimited sight in the dark is still nothing; unlimited sight in the light is the cap", () => {
    const base = { x: 0, y: 0, vision: { sightFeet: null, darkvisionFeet: 0 }, pxPerFoot: 20, capPx: 2500 };
    expect(effectiveSightRadiusPx({ ...base, lighting: dark })).toBe(0);
    expect(effectiveSightRadiusPx({ ...base, lighting: { darkness: 0, lights: [] } })).toBe(2500);
  });

  test("the scene cap bounds every sense, darkvision included", () => {
    expect(
      effectiveSightRadiusPx({
        x: 0,
        y: 0,
        vision: { sightFeet: null, darkvisionFeet: 120 },
        lighting: dark,
        pxPerFoot: 20,
        capPx: 500,
      }),
    ).toBe(500);
  });

  test("a token standing in the dark with a torch sees the torch's reach", () => {
    const s = scene({
      darkness: 1,
      grid: GRID,
      tokens: [token("t", { x: 0, y: 0, sight: 60, light: { radius: 400, color: "#fff", alpha: 0.5 } })],
    });
    // Carried light at the token's own position: dim 400 → 400 px of reach (not the 1,200 px sight).
    expect(viewerSightRadiusPx(s, s.tokens[0] as TokenDocument, 2500)).toBe(400);
    // With darkvision 60 ft. (1,200 px) the darkvision wins.
    const withDark = scene({
      ...s,
      tokens: [token("t", { x: 0, y: 0, sight: 60, darkvision: 60, light: { radius: 400, color: "#fff", alpha: 0.5 } })],
    });
    expect(viewerSightRadiusPx(withDark, withDark.tokens[0] as TokenDocument, 2500)).toBe(1200);
    // A light 400 px away gives 0 reach (300 − 400 < 0) but still counts as *lit* for the gate.
    const elsewhere = scene({ ...s, tokens: [token("t", { x: 500, y: 0, sight: 60 })] });
    expect(viewerSightRadiusPx(elsewhere, elsewhere.tokens[0] as TokenDocument, 2500)).toBe(0);
    expect(isLitAt({ x: 500, y: 0 }, sceneLighting(elsewhere))).toBe(false);
  });
});

describe("§2.1 — darkvision as a target-visibility sense", () => {
  test("withinDarkvision is a plain distance test, and none means never", () => {
    const viewer = { x: 0, y: 0, darkvisionPx: 1200 };
    expect(withinDarkvision(viewer, { x: 600, y: 0 })).toBe(true);
    expect(withinDarkvision(viewer, { x: 1200, y: 0 })).toBe(true);
    expect(withinDarkvision(viewer, { x: 1201, y: 0 })).toBe(false);
    expect(withinDarkvision({ ...viewer, darkvisionPx: 0 }, { x: 1, y: 0 })).toBe(false);
  });
});

describe("§2.1 — the fog loop: what each viewer reveals", () => {
  const rex = { id: "rex", role: "PLAYER" as const };
  const withOwner: Pick<TokenDocument, "ownership"> = {
    ownership: { default: 0, rex: 3 } as TokenDocument["ownership"],
  };

  test("fogViewers carries the light-bounded radius and the darkvision range, per token", () => {
    const s = scene({
      darkness: 1,
      tokens: [
        // apart from each other, so the torch lights its bearer and not its neighbours
        token("blind", { ...withOwner, x: 0, y: 0, sight: 60 }),
        token("dwarf", { ...withOwner, x: 0, y: 2000, sight: 60, darkvision: 60 }),
        token("torch", { ...withOwner, x: 2000, y: 2000, sight: 60, light: { radius: 300, color: "#fff", alpha: 0.5 } }),
      ],
    });
    const viewers = fogViewers(s, rex);
    const byId = new Map(viewers.map((v) => [v.tokenId, v]));
    expect(byId.get("blind")?.radiusPx).toBe(0);
    expect(byId.get("blind")?.darkvisionPx).toBe(0);
    expect(byId.get("dwarf")?.radiusPx).toBe(1200);
    expect(byId.get("dwarf")?.darkvisionPx).toBe(1200);
    expect(byId.get("torch")?.radiusPx).toBe(300);
  });

  test("the reveal key changes with the lighting, not only with movement", () => {
    const s = scene({ darkness: 1, tokens: [token("t", { x: 0, y: 0 })] });
    const viewers = fogViewers(s, rex);
    const darkKey = fogRevealKey(s, viewers, 2500);
    // Ambient light raised (the GM's darkness slider): different polygons were never at risk —
    // the radii change, and the key must say so.
    expect(fogRevealKey(scene({ ...s, darkness: 0.4 }), fogViewers(scene({ ...s, darkness: 0.4 }), rex), 2500)).not.toBe(
      darkKey,
    );
    // A placed light appears.
    const lit = scene({ ...s, lights: [placedLight("l1", 0, 0, 400)] });
    expect(fogRevealKey(lit, fogViewers(lit, rex), 2500)).not.toBe(darkKey);
    // …and it moves.
    const moved = scene({ ...s, lights: [placedLight("l1", 50, 0, 400)] });
    expect(fogRevealKey(moved, fogViewers(moved, rex), 2500)).not.toBe(
      fogRevealKey(lit, fogViewers(lit, rex), 2500),
    );
  });

  test("the token gate: in sight but in the dark is not shown; darkvision or light shows it", () => {
    const everyPoly = [new Float32Array([-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000])];
    const s = scene({
      darkness: 1,
      tokens: [
        token("mine", { ...withOwner, x: 0, y: 0 }),
        token("orc", { x: 300, y: 0 }),
      ],
    });
    // Total darkness, nobody has darkvision: the orc is inside the polygon and still hidden.
    expect([...fogVisibleTokenIds(s, rex, everyPoly, { lighting: sceneLighting(s) })]).toEqual(["mine"]);
    // The same scene with ambient light: shown (pre-§2.1 behaviour, unchanged).
    const litScene = scene({ ...s, darkness: 0 });
    expect([...fogVisibleTokenIds(litScene, rex, everyPoly, { lighting: sceneLighting(litScene) })].sort()).toEqual([
      "mine",
      "orc",
    ]);
    // The orc's own torch lights it.
    const torchScene = scene({
      ...s,
      tokens: [
        token("mine", { ...withOwner, x: 0, y: 0 }),
        token("orc", { x: 300, y: 0, light: { radius: 200, color: "#fff", alpha: 0.5 } }),
      ],
    });
    expect([
      ...fogVisibleTokenIds(torchScene, rex, everyPoly, { lighting: sceneLighting(torchScene) }),
    ]).toEqual(["mine", "orc"]);
    // A darkvision eye reaching it sees it, even in the dark and unlit.
    const viewer: FogViewer = { tokenId: "mine", x: 0, y: 0, radiusPx: 1200, darkvisionPx: 1200 };
    expect([
      ...fogVisibleTokenIds(s, rex, everyPoly, { lighting: sceneLighting(s), viewers: [viewer] }),
    ]).toEqual(["mine", "orc"]);
    // …but not from farther than its range (60 ft. = 1,200 px > 300 px here, so use a short one).
    const near: FogViewer = { tokenId: "mine", x: 0, y: 0, radiusPx: 60, darkvisionPx: 60 };
    expect([...fogVisibleTokenIds(s, rex, everyPoly, { lighting: sceneLighting(s), viewers: [near] })]).toEqual([
      "mine",
    ]);
    // No lighting in the context = the pre-§2.1 gate (line of sight alone) — the fog spec's
    // older callers keep working.
    expect([...fogVisibleTokenIds(s, rex, everyPoly)].sort()).toEqual(["mine", "orc"]);
  });
});

describe("§2.1 — the GM's darkness control", () => {
  test("sceneDarknessOp clamps to 0…1 and targets the scene", () => {
    const s = scene();
    expect(sceneDarknessOp(s, 1)).toEqual({
      kind: "update",
      ref: { coll: "scenes", id: "s1" },
      diff: { darkness: 1 },
    });
    expect(sceneDarknessOp(s, 3).diff).toEqual({ darkness: 1 });
    expect(sceneDarknessOp(s, -1).diff).toEqual({ darkness: 0 });
    expect(sceneDarknessOp(s, Number.NaN).diff).toEqual({ darkness: 0 });
  });
});

describe("§2.1 — audit: darkness and vision are read, not assumed", () => {
  test("an actor's darkvision is not a scene fact (the token is the carrier)", () => {
    // The document model deliberately keeps the sense on the *token* (plan §2.1's "extend the
    // token's vision settings, not a new document type"). Actors have no vision field at all
    // (`PF1eActorSystem` carries size/hp/attacks/…), so a DMG's darkvision reaches the canvas
    // only through the token that represents it — which is the token editor's job, not an
    // actor-derived value read here.
    const actor: ActorDocument = {
      _id: "a1",
      type: "actor",
      name: "Dwarf",
      ownership: { default: 0 },
      flags: {},
      system: { pf1e: { senses: [{ kind: "darkvision", rangeFt: 60 }] } },
      items: [],
      effects: [],
    };
    const pf1e = (actor.system.pf1e ?? {}) as Record<string, unknown>;
    expect("sight" in pf1e).toBe(false);
    expect(token("t").darkvision).toBeUndefined();
  });
});
