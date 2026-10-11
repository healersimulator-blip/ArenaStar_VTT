/**
 * Slice E (D-438): what the tiles layer draws for a roof state. Covers whole-tile fades,
 * openings (an inverse mask plus a masked copy), the Canvas2D fallback, GM hover, groups and
 * the copy above the fog.
 */
import { describe, expect, test } from "vitest";
import { Container, Sprite, Texture } from "pixi.js";
import { TilesLayer } from "../../src/canvas/layers/TilesLayer";
import type { TileDocument } from "../../src/core/documents";
import type { TileRect } from "../../src/canvas/ephemera";

const tile = (id: string, over: Partial<TileDocument> = {}): TileDocument => ({
  _id: id, type: "tile", name: id, ownership: { default: 0 }, flags: {}, system: {},
  x: 100, y: 100, width: 200, height: 200, img: "", above: true,
  occlusion: { mode: "roof", alpha: 0.25 }, ...over,
});
/** A 20×20 token rect centred on (x, y). */
const at = (x: number, y: number): TileRect => ({ x: x - 10, y: y - 10, width: 20, height: 20 });
const square = (cx: number, cy: number, half: number): Float32Array =>
  new Float32Array([cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half]);
const labels = (container: Container) => container.children.map((child) => child.label);

function fixture(inverseMasks = true, loadTexture?: (img: string) => Promise<Texture | null>) {
  const below = new Container(), above = new Container(), overFog = new Container();
  const layer = new TilesLayer(below, above, loadTexture ? { loadTexture } : {}, { overFog, inverseMasks });
  return { layer, below, above, overFog };
}

describe("roof drawing", () => {
  test("a roof fades as a whole for a viewer whose centre is under it, and not for one beside it", () => {
    const f = fixture();
    f.layer.sync([tile("r")], [at(200, 200)]);
    expect(f.layer.alphaOf("r")).toBe(0.25);
    expect(f.layer.roofStateOf("r")).toMatchObject({ holes: "none", under: true, reveal: false, art: false });
    // Overlapping the eaves by 5 px used to open the roof; the centre is outside now.
    f.layer.sync([tile("r")], [at(305, 200)]);
    expect(f.layer.alphaOf("r")).toBe(1);
    f.layer.destroy();
  });

  test("radial roofs get an inverse-masked opening plus a copy at the open opacity, removed when the token leaves", () => {
    const f = fixture();
    const radial = tile("r", { occlusion: { mode: "radial", alpha: 0.2, radius: 1 } });
    f.layer.sync([radial], [at(200, 200)], [], { gridSize: 50 });
    expect(f.layer.roofStateOf("r")).toMatchObject({ alpha: 1, holes: "circles", openings: 1, holeAlpha: 0.2 });
    expect(labels(f.above)).toEqual(expect.arrayContaining(["roofHole:r", "roofOpening:r", "roofOpeningMask:r"]));
    const hole = f.above.children.find((child) => child.label === "roofHole:r");
    const placeholder = f.above.children.find((child) => child.mask === hole);
    expect(placeholder).toBeDefined(); // the tile itself is clipped by the hole mask
    const opening = f.above.children.find((child) => child.label === "roofOpening:r");
    expect(opening?.alpha).toBeCloseTo(0.2);
    expect(opening?.mask).toBe(f.above.children.find((child) => child.label === "roofOpeningMask:r"));
    f.layer.sync([radial], [at(600, 600)], [], { gridSize: 50 });
    expect(labels(f.above).filter((label) => label.startsWith("roof"))).toEqual([]);
    expect(placeholder?.mask ?? null).toBeNull();
    f.layer.destroy();
  });

  test("an open opacity of 0 cuts a clean hole with no copy", () => {
    const f = fixture();
    f.layer.sync([tile("r", { occlusion: { mode: "radial", alpha: 0 } })], [at(200, 200)]);
    expect(labels(f.above)).toContain("roofHole:r");
    expect(labels(f.above)).not.toContain("roofOpening:r");
    f.layer.destroy();
  });

  test("without inverse masks (Canvas2D) radial and vision roofs fade whole and draw no openings", () => {
    const f = fixture(false);
    f.layer.sync([tile("r", { occlusion: { mode: "radial", alpha: 0.3 } }), tile("v", { x: 400, occlusion: { mode: "vision", alpha: 0.3 } })],
      [at(200, 200), at(500, 200)]);
    f.layer.setVision([square(200, 200, 100), square(500, 200, 100)]);
    expect(f.layer.alphaOf("r")).toBe(0.3);
    expect(f.layer.alphaOf("v")).toBe(0.3);
    expect(labels(f.above).filter((label) => label.startsWith("roof"))).toEqual([]);
    f.layer.destroy();
  });

  test("vision roofs open in the shape of live sight and follow it", () => {
    const f = fixture();
    f.layer.sync([tile("v", { occlusion: { mode: "vision", alpha: 0 } })], [at(200, 200)]);
    expect(f.layer.roofStateOf("v")).toMatchObject({ alpha: 0, holes: "none" }); // no sight yet → whole fade
    f.layer.setVision([square(200, 200, 50)]);
    expect(f.layer.roofStateOf("v")).toMatchObject({ alpha: 1, holes: "vision", openings: 1 });
    f.layer.setVision([]);
    expect(f.layer.roofStateOf("v")).toMatchObject({ alpha: 0, holes: "none" });
    f.layer.destroy();
  });

  test("GM hover fade opens the roof under the pointer only while switched on", () => {
    const f = fixture();
    f.layer.sync([tile("r")], []);
    f.layer.setHover({ x: 150, y: 150 });
    expect(f.layer.alphaOf("r")).toBe(1);
    f.layer.setHoverFade(true);
    expect(f.layer.alphaOf("r")).toBe(0.25);
    f.layer.setHover({ x: 50, y: 50 });
    expect(f.layer.alphaOf("r")).toBe(1);
    f.layer.setHover({ x: 150, y: 150 });
    f.layer.setHoverFade(false);
    expect(f.layer.alphaOf("r")).toBe(1);
    f.layer.destroy();
  });

  test("a group fades together from its source", () => {
    const f = fixture();
    f.layer.sync([tile("hall", { roofGroup: { id: "inn", role: "source" } }), tile("porch", { x: 300, roofGroup: { id: "inn", role: "follower" } })],
      [at(150, 150)]);
    expect(f.layer.roofStateOf("porch")).toMatchObject({ alpha: 0.25, linked: true });
    f.layer.destroy();
  });

  test("a roof flagged to show through fog is copied above the fog while sight touches it", () => {
    const f = fixture(false); // Canvas2D can draw the copy too: it needs no masks
    const roof = tile("r", { revealInFog: true });
    f.layer.sync([roof], []);
    expect(f.overFog.children).toHaveLength(0);
    f.layer.setVision([square(60, 200, 80)]);
    expect(labels(f.overFog)).toEqual(["roofOverFog:r"]);
    expect(f.layer.roofStateOf("r")?.reveal).toBe(true);
    // Moving the roof moves its copy; walking under it removes the copy.
    f.layer.sync([{ ...roof, x: 120 }], []);
    expect(f.overFog.children[0]?.position.x).toBe(220);
    f.layer.sync([{ ...roof, x: 120 }], [at(220, 200)]);
    expect(f.overFog.children).toHaveLength(0);
    f.layer.sync([roof], []);
    f.layer.setVision([]);
    expect(f.overFog.children).toHaveLength(0);
    f.layer.destroy();
  });

  test("loaded art moves openings and fog copies onto sprites; removing the tile clears everything", async () => {
    let resolve: (texture: Texture | null) => void = () => undefined;
    const f = fixture(true, () => new Promise((done) => { resolve = done; }));
    const roof = tile("r", { img: "roof.png", revealInFog: true, occlusion: { mode: "radial", alpha: 0.5 } });
    f.layer.sync([roof, tile("s", { x: 600, img: "", revealInFog: true })], [at(200, 200)]);
    f.layer.setVision([square(650, 200, 80)]);
    resolve(Texture.WHITE);
    await Promise.resolve(); await Promise.resolve();
    expect(f.above.children.find((child) => child.label === "roofOpening:r")).toBeInstanceOf(Sprite);
    expect(f.layer.roofStateOf("s")?.reveal).toBe(true);
    f.layer.sync([], []);
    expect(f.above.children).toHaveLength(0);
    expect(f.overFog.children).toHaveLength(0);
    f.layer.destroy();
  });
});

describe("G-19 (D-443): art seen on lower floors", () => {
  test("lower-floor tiles go into the dimmed container beneath this floor's art, deepest first, as plain art", () => {
    const f = fixture();
    const lowerRoof = tile("porchRoof", { occlusion: { mode: "roof", alpha: 0.25 } });
    const ground = tile("ground", { above: false, occlusion: { mode: "fade", alpha: 0 } });
    const own = tile("own", { above: false, occlusion: { mode: "fade", alpha: 0 } });
    f.layer.setLowerFloors(new Map([["ground", 2], ["porchRoof", 1]]));
    f.layer.sync([ground, lowerRoof, own], [at(200, 200)]);
    const lower = f.below.children[0] as Container;
    expect(lower.label).toBe("lowerFloors");
    expect(lower.sortableChildren).toBe(true);
    // Imageless tiles draw a placeholder Graphics: one node per tile, keyed here by depth.
    const atDepth = (depth: number) => lower.children.find((child) => child.zIndex === -depth);
    expect(lower.children).toHaveLength(2);
    expect(atDepth(2)?.tint).toBe(0x808080);
    expect(atDepth(1)?.tint).toBe(0xa6a6a6);
    // A lower floor's roof is art seen from above: never faded or opened, never drawn in the roof layer.
    expect(f.layer.alphaOf("porchRoof")).toBe(1);
    expect(f.layer.roofStateOf("porchRoof")).toMatchObject({ alpha: 1, under: false, holes: "none" });
    expect(labels(f.above)).toEqual([]);
    // This floor's own tile stays in the normal layer, untinted.
    const ownNode = f.below.children.find((child, index) => index > 0 && child !== lower);
    expect(ownNode?.tint).toBe(0xffffff);
    expect(f.layer.lowerFloorTiles()).toEqual([{ id: "ground", depth: 2 }, { id: "porchRoof", depth: 1 }]);
    // Climbing down: the same tiles become this floor's own art again.
    f.layer.setLowerFloors(new Map());
    f.layer.sync([ground, lowerRoof], [at(200, 200)]);
    expect(lower.children).toHaveLength(0);
    expect(f.layer.roofStateOf("porchRoof")).toMatchObject({ under: true });
    expect(f.layer.lowerFloorTiles()).toEqual([]);
    f.layer.destroy();
  });
});
