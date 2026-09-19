/**
 * §9 explored fog — the pure half (D-250): scene flags, the flags op, whose tokens reveal
 * for whom, sight radius, and the reveal dedupe key.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import {
  flatSegments,
  fogRevealKey,
  fogSettingsOps,
  fogSightRadius,
  fogViewers,
  fogVisibleTokenIds,
  sceneFogSettings,
  tokenInSight,
} from "../../src/core/fogExploration";
import { applyDiff } from "../../src/core/diff";

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
  light: { radius: 0, color: "#fff", alpha: 0.5 },
  ...over,
});

const wall = (id: string, c: WallDocument["c"], over: Partial<WallDocument> = {}): WallDocument => ({
  _id: id,
  type: "wall",
  name: id,
  ownership: { default: 0 },
  flags: {},
  system: {},
  c,
  door: 0,
  oneWay: false,
  move: 0,
  sight: 0,
  sound: 0,
  light: 0,
  ...over,
});

const scene = (over: Partial<SceneDocument> = {}): SceneDocument => ({
  _id: "scene-1",
  type: "scene",
  name: "S",
  ownership: { default: 2 },
  flags: {},
  system: {},
  active: true,
  img: null,
  width: 2000,
  height: 1500,
  darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
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

const GM = { id: "gm", role: "GM" as const };
const REX = { id: "rex", role: "PLAYER" as const };

describe("scene fog flags", () => {
  test("absent → off, whole scene; malformed values are ignored", () => {
    expect(sceneFogSettings(scene())).toEqual({ enabled: false, rangeSquares: null });
    expect(sceneFogSettings(null)).toEqual({ enabled: false, rangeSquares: null });
    expect(sceneFogSettings(scene({ flags: { core: { fog: "yes", fogRange: "12" } } }))).toEqual({
      enabled: false,
      rangeSquares: null,
    });
    expect(sceneFogSettings(scene({ flags: { core: { fog: true, fogRange: 0 } } }))).toEqual({
      enabled: true,
      rangeSquares: null,
    });
    expect(sceneFogSettings(scene({ flags: { core: { fog: true, fogRange: 12 } } }))).toEqual({
      enabled: true,
      rangeSquares: 12,
    });
  });

  test("fogSettingsOps writes flags whole and keeps the other core flags (D-012 / D-080)", () => {
    const s = scene({ flags: { core: { scale: "strategic" }, other: { kept: 1 } } });
    const ops = fogSettingsOps(s, { enabled: true, rangeSquares: 8 });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (!op || op.kind !== "update") throw new Error("expected an update op");
    expect(op.ref).toEqual({ coll: "scenes", id: "scene-1" });
    const applied = applyDiff(s, op.diff);
    if (!applied.ok) throw new Error(applied.error);
    const next = applied.value;
    expect(next.flags).toEqual({ core: { scale: "strategic", fog: true, fogRange: 8 }, other: { kept: 1 } });
    expect(sceneFogSettings(next)).toEqual({ enabled: true, rangeSquares: 8 });

    // turning it off removes both keys and leaves the scale alone
    const offOps = fogSettingsOps(next, { enabled: false, rangeSquares: null });
    const off = offOps[0];
    if (!off || off.kind !== "update") throw new Error("expected an update op");
    const appliedOff = applyDiff(next, off.diff);
    if (!appliedOff.ok) throw new Error(appliedOff.error);
    expect(appliedOff.value.flags).toEqual({ core: { scale: "strategic" }, other: { kept: 1 } });
  });
});

describe("whose eyes reveal", () => {
  const actors: ActorDocument[] = [
    {
      _id: "a-rex",
      type: "actor",
      name: "Rex's hero",
      ownership: { default: 0, rex: 3 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    },
  ];
  const s = scene({
    tokens: [
      token("own", { ownership: { default: 0, rex: 3 } }),
      token("via-actor", { actorId: "a-rex", x: 300 }),
      token("blind", { ownership: { default: 3 }, vision: false }),
      token("npc", { ownership: { default: 0 }, x: 900, y: 700 }),
      token("hidden-npc", { ownership: { default: 0 }, hidden: true, x: 950 }),
    ],
  });

  test("a player reveals with tokens they own — directly or through the actor — and never with others'", () => {
    expect(fogViewers(s, REX, { actors }).map((v) => v.tokenId)).toEqual(["own", "via-actor"]);
    // without the actor list the actor-owned token is not theirs
    expect(fogViewers(s, REX).map((v) => v.tokenId)).toEqual(["own"]);
  });

  test("the GM's map takes every vision token (hidden ones included); no user → nobody", () => {
    expect(fogViewers(s, GM).map((v) => v.tokenId)).toEqual(["own", "via-actor", "npc", "hidden-npc"]);
    expect(fogViewers(s, null)).toEqual([]);
  });

  test("viewers carry the token centre", () => {
    expect(fogViewers(s, REX)[0]).toEqual({ tokenId: "own", x: 100, y: 100 });
  });
});

describe("sight radius + reveal key", () => {
  test("no range → the scene diagonal; a range → squares × grid, never past the diagonal", () => {
    const s = scene();
    expect(fogSightRadius(s, { enabled: true, rangeSquares: null })).toBeCloseTo(2500, 5);
    expect(fogSightRadius(s, { enabled: true, rangeSquares: 6 })).toBe(600);
    expect(fogSightRadius(s, { enabled: true, rangeSquares: 999 })).toBeCloseTo(2500, 5);
  });

  test("the key changes when an eye moves, a door opens or the range changes — not otherwise", () => {
    const door = wall("d", [0, 500, 200, 500], { sight: 1, door: 0 });
    const s = scene({ tokens: [token("t")], walls: [wall("w", [0, 0, 400, 0]), door] });
    const viewers = fogViewers(s, GM);
    const k0 = fogRevealKey(s, viewers, 2500);
    expect(fogRevealKey(scene({ ...s, name: "renamed" }), viewers, 2500)).toBe(k0);
    expect(fogRevealKey(s, viewers, 600)).not.toBe(k0);
    expect(fogRevealKey(s, [{ tokenId: "t", x: 101, y: 100 }], 2500)).not.toBe(k0);
    expect(fogRevealKey(s, [{ tokenId: "t", x: 100.2, y: 100.1 }], 2500)).toBe(k0); // sub-pixel jitter
    const opened = scene({ ...s, walls: [s.walls[0] as WallDocument, { ...door, door: 1 }] });
    expect(fogRevealKey(opened, viewers, 2500)).not.toBe(k0);
    // the order of the eyes does not matter
    const two = [{ tokenId: "a", x: 1, y: 1 }, { tokenId: "b", x: 2, y: 2 }];
    expect(fogRevealKey(s, two, 2500)).toBe(fogRevealKey(s, [...two].reverse(), 2500));
  });

  test("flatSegments packs quads for the worker", () => {
    expect([...flatSegments([{ x1: 1, y1: 2, x2: 3, y2: 4 }, { x1: 5, y1: 6, x2: 7, y2: 8 }])]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

// D-251 — what a player is shown on a fogged scene
describe("token gate", () => {
  /** A square sight polygon [x0,x1]×[y0,y1] as the worker would hand it back. */
  const square = (x0: number, y0: number, x1: number, y1: number): Float32Array =>
    new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]);

  test("tokenInSight: centre or any inset corner inside a polygon counts; degenerate polygons do not", () => {
    const sight = square(0, 0, 500, 500);
    expect(tokenInSight({ x: 250, y: 250, width: 100, height: 100 }, [sight])).toBe(true);
    // centre just outside, but the inset corner (x - w/4 = 505) is not inside either → out
    expect(tokenInSight({ x: 530, y: 250, width: 100, height: 100 }, [sight])).toBe(false);
    // centre outside, inset corner at 520 - 25 = 495 inside → half behind the edge shows
    expect(tokenInSight({ x: 520, y: 250, width: 100, height: 100 }, [sight])).toBe(true);
    // a big token whose centre is far out but whose near quarter reaches in
    expect(tokenInSight({ x: 600, y: 250, width: 500, height: 500 }, [sight])).toBe(true);
    expect(tokenInSight({ x: 900, y: 900, width: 100, height: 100 }, [sight])).toBe(false);
    expect(tokenInSight({ x: 250, y: 250, width: 100, height: 100 }, [])).toBe(false);
    expect(tokenInSight({ x: 250, y: 250, width: 100, height: 100 }, [new Float32Array([1, 2, 3, 4])])).toBe(
      false,
    );
    // any one of several polygons suffices
    expect(tokenInSight({ x: 800, y: 800, width: 100, height: 100 }, [sight, square(700, 700, 900, 900)])).toBe(
      true,
    );
  });

  test("fogVisibleTokenIds: own tokens always, others only in sight; GM/ASSISTANT everything; no user nothing", () => {
    const s = scene({
      tokens: [
        token("mine", { x: 100, y: 100, ownership: { default: 0, rex: 3 } }),
        token("mine-far", { x: 900, y: 900, ownership: { default: 0, rex: 3 }, vision: false }),
        token("orc-near", { x: 200, y: 150 }),
        token("orc-far", { x: 900, y: 100 }),
        token("friend", { x: 850, y: 850, ownership: { default: 0, ivy: 3 } }),
      ],
    });
    const sight = [square(0, 0, 400, 400)];
    const rex = { id: "rex", role: "PLAYER" as const };
    expect([...fogVisibleTokenIds(s, rex, sight)].sort()).toEqual(["mine", "mine-far", "orc-near"]);
    // no polygons yet (scene just entered): only what rex controls
    expect([...fogVisibleTokenIds(s, rex, [])].sort()).toEqual(["mine", "mine-far"]);
    // control through the actor counts as ownership, as it does for revealing
    const actor: ActorDocument = {
      _id: "actor-orc-far",
      type: "actor",
      name: "Orc",
      ownership: { default: 0, rex: 3 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    };
    const viaActor = scene({ tokens: [token("orc-far", { x: 900, y: 100, actorId: "actor-orc-far" })] });
    expect([...fogVisibleTokenIds(viaActor, rex, [], { actors: [actor] })]).toEqual(["orc-far"]);
    // the GM and the assistant are never gated
    expect(fogVisibleTokenIds(s, { id: "gm", role: "GM" }, []).size).toBe(5);
    expect(fogVisibleTokenIds(s, { id: "asst", role: "ASSISTANT" }, []).size).toBe(5);
    expect(fogVisibleTokenIds(s, null, sight).size).toBe(0);
  });
});
