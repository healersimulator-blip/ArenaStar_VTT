/**
 * Slice E (D-438): roof rules. Covers the "under" test from art, zones or the rotated
 * rectangle, the four fade modes, GM hover, roof groups, reveal through fog, validation and
 * whose tokens open roofs.
 */
import { describe, expect, test } from "vitest";
import type { SceneDocument, TileDocument, TokenDocument } from "../../src/core/documents";
import {
  ROOF_IDLE,
  describeRoof,
  resolveRoofs,
  roofArtMaskFromRgba,
  roofCovers,
  roofOutline,
  roofViewerTokens,
  tileRoofError,
  visionTouchesOutline,
  type RoofInputs,
} from "../../src/core/roofs";

const tile = (id: string, over: Partial<TileDocument> = {}): TileDocument => ({
  _id: id, type: "tile", name: id, ownership: { default: 0 }, flags: {}, system: {},
  x: 100, y: 100, width: 200, height: 200, img: "", above: true,
  occlusion: { mode: "roof", alpha: 0.25 }, ...over,
});
const inputs = (over: Partial<RoofInputs> = {}): RoofInputs => ({ viewers: [], gridSize: 100, masks: true, ...over });
/** A flat square polygon (vision) around a centre. */
const square = (cx: number, cy: number, half: number): Float32Array =>
  new Float32Array([cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half]);

describe("validation", () => {
  test("legacy and new roof fields pass; malformed ones are refused with a reason", () => {
    expect(tileRoofError({ occlusion: { mode: "roof", alpha: 0.5 } })).toBeNull();
    expect(tileRoofError({ occlusion: { mode: "fade", alpha: 0 } })).toBeNull();
    expect(tileRoofError({ occlusion: { mode: "radial", alpha: 1, radius: 2.5 }, roofGroup: { id: "inn_1", role: "follower" }, revealInFog: true })).toBeNull();
    expect(tileRoofError({})).toBeNull();
    expect(tileRoofError({ occlusion: { mode: "glass", alpha: 0.5 } })).toMatch(/mode/);
    expect(tileRoofError({ occlusion: { mode: "roof", alpha: 1.5 } })).toMatch(/alpha/);
    expect(tileRoofError({ occlusion: { mode: "radial", alpha: 0.5, radius: 0 } })).toMatch(/radius/);
    expect(tileRoofError({ occlusion: { mode: "roof", alpha: 0.5, colour: "red" } })).toMatch(/only mode/);
    expect(tileRoofError({ roofGroup: { id: "has space", role: "source" } })).toMatch(/group id/);
    expect(tileRoofError({ roofGroup: { id: "inn", role: "leader" } })).toMatch(/role/);
    expect(tileRoofError({ roofGroup: { id: "inn", role: "source", extra: 1 } })).toMatch(/\{id, role\}/);
    expect(tileRoofError({ revealInFog: "yes" })).toMatch(/revealInFog/);
  });
});

describe("under: art, zones, rotated rectangle", () => {
  test("a rotated roof is tested on its rotated outline, not its bounding box", () => {
    const diamond = tile("d", { rotation: 45 });
    // The unrotated rect corner (110, 110) lies outside the 45° diamond.
    expect(roofCovers(diamond, { x: 110, y: 110 })).toBe(false);
    expect(roofCovers(diamond, { x: 200, y: 200 })).toBe(true);
    // The diamond's top tip pokes above the unrotated rect.
    expect(roofCovers(diamond, { x: 200, y: 70 })).toBe(true);
    expect(roofOutline(diamond)).toHaveLength(4);
  });

  test("a polygon or alpha trigger zone shapes the roof when there is no readable art", () => {
    const triangle = tile("t", { triggerZone: { kind: "polygon", points: [[0, 0], [1, 0], [0, 1]] } });
    expect(roofCovers(triangle, { x: 120, y: 120 })).toBe(true);
    expect(roofCovers(triangle, { x: 280, y: 280 })).toBe(false);
    const rows = Array.from({ length: 64 }, (_unused, row) => row < 32 ? [[0, 64] as [number, number]] : []);
    const top = tile("a", { triggerZone: { kind: "alpha", width: 64, height: 64, imageHash: "0".repeat(64), rows } });
    expect(roofCovers(top, { x: 200, y: 150 })).toBe(true);
    expect(roofCovers(top, { x: 200, y: 250 })).toBe(false);
    expect(roofOutline(top)).toHaveLength(4);
  });

  test("readable art wins: transparent pixels are not roof", () => {
    // 2×2 art: left column opaque, right column transparent.
    const art = roofArtMaskFromRgba([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 200, 0, 0, 0, 10], 2, 2);
    expect(art).not.toBeNull();
    const roof = tile("r");
    expect(roofCovers(roof, { x: 150, y: 150 }, art)).toBe(true);
    expect(roofCovers(roof, { x: 250, y: 150 }, art)).toBe(false);
    expect(roofCovers(roof, { x: 350, y: 150 }, art)).toBe(false);
    expect(roofArtMaskFromRgba([0, 0, 0], 1, 1)).toBeNull();
  });
});

describe("fade modes", () => {
  test("roof: only a viewer whose centre is under the roof opens it; a token beside the eaves does not", () => {
    const roof = tile("r");
    expect(resolveRoofs([roof], inputs({ viewers: [{ x: 200, y: 200 }] })).get("r")).toMatchObject({ alpha: 0.25, under: true, holes: null });
    // Centre 10 px outside the right edge: the old bounding-box overlap would have opened it.
    expect(resolveRoofs([roof], inputs({ viewers: [{ x: 310, y: 200 }] })).get("r")).toMatchObject({ alpha: 1, under: false });
  });

  test("fade is always translucent; floor tiles are idle", () => {
    const states = resolveRoofs([tile("f", { occlusion: { mode: "fade", alpha: 0.4 } }), tile("floor", { above: false })], inputs());
    expect(states.get("f")).toMatchObject({ alpha: 0.4, holes: null });
    expect(states.get("floor")).toBe(ROOF_IDLE);
  });

  test("radial opens a circle per viewer under it; Canvas2D falls back to a whole-roof fade", () => {
    const radial = tile("r", { occlusion: { mode: "radial", alpha: 0.1, radius: 1.5 } });
    const state = resolveRoofs([radial], inputs({ viewers: [{ x: 150, y: 150 }, { x: 250, y: 250 }, { x: 900, y: 900 }], gridSize: 50 })).get("r");
    expect(state).toMatchObject({ alpha: 1, holeAlpha: 0.1, under: true });
    expect(state?.holes).toEqual({ kind: "circles", circles: [{ x: 150, y: 150, r: 75 }, { x: 250, y: 250, r: 75 }] });
    expect(resolveRoofs([radial], inputs({ viewers: [{ x: 150, y: 150 }], masks: false })).get("r")).toMatchObject({ alpha: 0.1, holes: null });
  });

  test("vision opens what viewers see, but only with live sight, masks and a real token under it", () => {
    const vision = tile("v", { occlusion: { mode: "vision", alpha: 0 } });
    const sight = [square(200, 200, 80)];
    expect(resolveRoofs([vision], inputs({ viewers: [{ x: 200, y: 200 }], vision: sight })).get("v")).toMatchObject({ alpha: 1, holes: { kind: "vision" }, holeAlpha: 0 });
    expect(resolveRoofs([vision], inputs({ viewers: [{ x: 200, y: 200 }] })).get("v")).toMatchObject({ alpha: 0, holes: null });
    expect(resolveRoofs([vision], inputs({ viewers: [{ x: 200, y: 200 }], vision: sight, masks: false })).get("v")).toMatchObject({ alpha: 0, holes: null });
    expect(resolveRoofs([vision], inputs({ hover: { x: 200, y: 200 }, vision: sight })).get("v")).toMatchObject({ alpha: 0, holes: null, under: true });
  });

  test("the GM's hover point opens a roof like a viewer, including a radial circle", () => {
    const roof = tile("r"), radial = tile("c", { x: 400, occlusion: { mode: "radial", alpha: 0.3 } });
    const states = resolveRoofs([roof, radial], inputs({ hover: { x: 150, y: 150 } }));
    expect(states.get("r")).toMatchObject({ alpha: 0.25, under: true });
    expect(states.get("c")).toMatchObject({ alpha: 1, under: false });
    expect(resolveRoofs([radial], inputs({ hover: { x: 450, y: 150 } })).get("c")?.holes).toEqual({ kind: "circles", circles: [{ x: 450, y: 150, r: 200 }] });
  });
});

describe("roof groups (G-25)", () => {
  const hall = tile("hall", { roofGroup: { id: "inn", role: "source" } });
  const porch = tile("porch", { x: 300, roofGroup: { id: "inn", role: "follower" } });
  const chimney = tile("chimney", { x: 500, occlusion: { mode: "radial", alpha: 0.5 }, roofGroup: { id: "inn", role: "follower" } });
  const barn = tile("barn", { x: 900, roofGroup: { id: "barn", role: "source" } });

  test("a source with a viewer under it fades every member as a whole, independent of tile order", () => {
    for (const order of [[hall, porch, chimney, barn], [barn, chimney, porch, hall]]) {
      const states = resolveRoofs(order, inputs({ viewers: [{ x: 200, y: 200 }] }));
      expect(states.get("hall")).toMatchObject({ alpha: 0.25, under: true, linked: false });
      expect(states.get("porch")).toMatchObject({ alpha: 0.25, under: false, linked: true });
      expect(states.get("chimney")).toMatchObject({ alpha: 0.5, holes: null, linked: true });
      expect(states.get("barn")).toMatchObject({ alpha: 1, linked: false });
    }
  });

  test("a follower opens only itself", () => {
    const states = resolveRoofs([hall, porch, chimney], inputs({ viewers: [{ x: 400, y: 200 }] }));
    expect(states.get("porch")).toMatchObject({ alpha: 0.25, under: true });
    expect(states.get("hall")).toMatchObject({ alpha: 1, linked: false });
    expect(states.get("chimney")).toMatchObject({ alpha: 1, linked: false });
  });
});

describe("reveal through fog (G-24)", () => {
  const roof = tile("r", { revealInFog: true });

  test("shown above the fog while live sight touches the outline and nobody is under it", () => {
    expect(resolveRoofs([roof], inputs({ vision: [square(50, 200, 60)] })).get("r")?.reveal).toBe(true);
    expect(resolveRoofs([roof], inputs({ vision: [square(-200, 200, 60)] })).get("r")?.reveal).toBe(false);
    expect(resolveRoofs([roof], inputs()).get("r")?.reveal).toBe(false);
    expect(resolveRoofs([roof], inputs({ vision: [square(200, 200, 60)], viewers: [{ x: 200, y: 200 }] })).get("r")?.reveal).toBe(false);
    expect(resolveRoofs([tile("plain")], inputs({ vision: [square(50, 200, 60)] })).get("plain")?.reveal).toBe(false);
  });

  test("a group member opened by its source is not revealed over the fog", () => {
    const source = tile("s", { x: 600, roofGroup: { id: "g", role: "source" } });
    const linked = tile("l", { revealInFog: true, roofGroup: { id: "g", role: "follower" } });
    expect(resolveRoofs([source, linked], inputs({ viewers: [{ x: 700, y: 200 }], vision: [square(200, 200, 300)] })).get("l"))
      .toMatchObject({ linked: true, reveal: false });
  });

  test("the polygon test is exact: crossing, containment either way, and near misses", () => {
    const outline = roofOutline(tile("o")) ?? [];
    expect(visionTouchesOutline(square(200, 200, 20), outline)).toBe(true); // sight inside the roof
    expect(visionTouchesOutline(square(200, 200, 500), outline)).toBe(true); // roof inside sight
    expect(visionTouchesOutline(square(300, 300, 1), outline)).toBe(true); // crosses a corner
    expect(visionTouchesOutline(new Float32Array([0, 0, 99, 0, 0, 99]), outline)).toBe(false); // hypotenuse misses (100, 100)
    // A notched (concave) sight polygon whose notch holds the whole roof, without touching it.
    const notched = new Float32Array([0, 0, 600, 0, 600, 50, 50, 50, 50, 350, 600, 350, 600, 400, 0, 400]);
    expect(visionTouchesOutline(notched, outline)).toBe(false);
    expect(visionTouchesOutline(new Float32Array([0, 0, 1, 1]), outline)).toBe(false);
  });
});

describe("whose tokens open roofs", () => {
  const token = (id: string, over: Partial<TokenDocument> = {}): TokenDocument => ({
    _id: id, type: "token", name: id, ownership: { default: 0 }, flags: {}, system: {}, x: 0, y: 0, rotation: 0,
    width: 100, height: 100, img: "", hidden: false, disposition: "friendly", vision: true,
    light: { radius: 0, color: "#fff", alpha: 0.5 }, ...over,
  });
  const scene: SceneDocument = {
    _id: "s", type: "scene", name: "S", ownership: { default: 2 }, flags: {}, system: {}, active: true, img: null,
    width: 1000, height: 1000, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [
      token("mine", { ownership: { default: 0, rex: 3 } }),
      token("mine-2", { ownership: { default: 0, rex: 3 } }),
      token("blind", { ownership: { default: 0, rex: 3 }, vision: false }),
      token("theirs", { ownership: { default: 0, ann: 3 } }),
    ],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
  const ids = (tokens: readonly TokenDocument[]) => tokens.map((t) => t._id);

  test("a player's own vision tokens, narrowed by the selection; never another player's", () => {
    const rex = { id: "rex", role: "PLAYER" as const };
    expect(ids(roofViewerTokens(scene, rex, []))).toEqual(["mine", "mine-2"]);
    expect(ids(roofViewerTokens(scene, rex, [], ["mine-2"]))).toEqual(["mine-2"]);
    expect(ids(roofViewerTokens(scene, rex, [], ["theirs"]))).toEqual(["mine", "mine-2"]);
    expect(roofViewerTokens(scene, null, [])).toEqual([]);
  });

  test("a GM opens roofs for every vision token unless a selection narrows it", () => {
    const gm = { id: "gm", role: "GM" as const };
    expect(ids(roofViewerTokens(scene, gm, []))).toEqual(["mine", "mine-2", "theirs"]);
    expect(ids(roofViewerTokens(scene, gm, [], ["theirs"]))).toEqual(["theirs"]);
  });
});

test("the editor summary names the mode, group and fog reveal", () => {
  expect(describeRoof(tile("a", { above: false }))).toBe("floor tile");
  expect(describeRoof(tile("b"))).toBe("roof · fades to 25% with a token beneath");
  expect(describeRoof(tile("c", { occlusion: { mode: "radial", alpha: 0, radius: 3 }, roofGroup: { id: "inn", role: "source" }, revealInFog: true })))
    .toBe("roof · opens 3 cells around tokens (0%) · group inn (source) · shows through fog");
});
