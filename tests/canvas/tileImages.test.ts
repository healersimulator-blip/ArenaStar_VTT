import { describe, expect, test, vi } from "vitest";
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { TilesLayer } from "../../src/canvas/layers/TilesLayer";
import type { RegionDocument, TileDocument } from "../../src/core/documents";

const tile = (img: string): TileDocument => ({ _id: "tile", type: "tile", name: "Tile", ownership: { default: 0 },
  flags: {}, system: {}, x: 100, y: 200, width: 300, height: 400, rotation: 90,
  above: false, img, occlusion: { mode: "roof", alpha: 0.5 } });
const region: RegionDocument = { _id: "region", type: "region", name: "Courtyard", ownership: { default: 0 }, flags: {}, system: {},
  x: 40, y: 60, width: 180, height: 100, rotation: 15,
  shape: { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] } };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const below = new Container(), above = new Container();
  const pending: Array<{ image: string; resolve: (texture: Texture | null) => void }> = [];
  const layer = new TilesLayer(below, above, { loadTexture: (image) => new Promise((resolve) => pending.push({ image, resolve })) });
  return { layer, below, above, pending };
}

describe("live tile image reconciliation", () => {
  test("tile rotation animates placeholder and late image together, with movement and interruptions",async()=>{
    const clock=vi.spyOn(performance,"now").mockReturnValue(0);
    try {
      const f=fixture(),original={...tile("first"),rotation:0};f.layer.sync([original],[]);
      const moving={...original,x:300,rotation:270,flags:{arenaRotation:{rotation:270,durationMs:1000},arenaMove:{x:300,y:200,durationMs:1000}}};
      f.layer.sync([moving],[]);clock.mockReturnValue(500);f.layer.tick(500);
      expect(f.below.children[0]?.rotation).toBeCloseTo(315*Math.PI/180);
      f.pending[0]?.resolve(Texture.WHITE);await flush();
      const sprite=f.below.children.find((c)=>c instanceof Sprite);if(!sprite)throw new Error("missing sprite");
      expect(sprite.rotation).toBeCloseTo(315*Math.PI/180);expect(sprite.x).toBe(350);
      f.layer.sync([moving],[]);expect(sprite.rotation).toBeCloseTo(315*Math.PI/180);
      const back={...moving,rotation:0,flags:{...moving.flags,arenaRotation:{rotation:0,durationMs:1000}}};
      f.layer.sync([back],[]);clock.mockReturnValue(1000);f.layer.tick(1000);
      expect(sprite.rotation).toBeCloseTo(337.5*Math.PI/180);expect(sprite.x).toBe(450);
      clock.mockReturnValue(1500);f.layer.tick(1500);expect(sprite.rotation).toBe(0);
      f.layer.sync([original],[]);expect(sprite.x).toBe(250);expect(sprite.rotation).toBe(0);f.layer.destroy();
    } finally {clock.mockRestore();}
  });

  test("tile sprites animate committed endpoints, do not restart on refresh, and cut on Undo", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const f = fixture(); const original = tile("first");
      f.layer.sync([original], []); f.pending[0]?.resolve(Texture.WHITE); await flush();
      const sprite = f.below.children.find((child) => child instanceof Sprite) as Sprite;
      const moved = { ...original, x: 300, flags: { arenaMove: { x: 300, y: 200, durationMs: 1000 } } };
      f.layer.sync([moved], []); expect(sprite.x).toBe(250);
      clock.mockReturnValue(500); f.layer.tick(500); expect(sprite.x).toBe(350);
      f.layer.sync([moved], []); expect(sprite.x).toBe(350);
      clock.mockReturnValue(1000); f.layer.tick(1000); expect(sprite.x).toBe(450);
      f.layer.sync([original], []); expect(sprite.x).toBe(250);
      f.layer.destroy();
    } finally { clock.mockRestore(); }
  });

  test("replaces art on the same tile, draws immediately, and clears without a later world update", async () => {
    const f = fixture();
    f.layer.sync([tile("first")], []);
    f.pending[0]?.resolve(Texture.WHITE); await flush();
    expect(f.layer.imageOf("tile")).toBe("first");
    const old = f.below.children.find((child) => child instanceof Sprite) as Sprite;
    expect(old.position.x).toBe(250); expect(old.position.y).toBe(400);
    expect(old.width).toBe(300); expect(old.height).toBe(400);
    expect(old.rotation).toBeCloseTo(Math.PI / 2);
    f.layer.sync([tile("next")], []);
    expect(old.destroyed).toBe(true); expect(f.layer.imageOf("tile")).toBeNull();
    f.pending[1]?.resolve(Texture.EMPTY); await flush();
    expect(f.layer.imageOf("tile")).toBe("next");
    expect((f.below.children.find((child) => child instanceof Sprite) as Sprite).texture).toBe(Texture.EMPTY);
    f.layer.sync([tile("")], []);
    expect(f.layer.imageOf("tile")).toBeNull();
    expect(f.below.children.filter((child) => child instanceof Sprite)).toHaveLength(0);
    f.layer.destroy();
  });

  test("late old loads cannot overwrite a newer image, including A→B→A", async () => {
    const f = fixture();
    for (const image of ["a", "b", "a"]) f.layer.sync([tile(image)], []);
    f.pending[2]?.resolve(Texture.WHITE); await flush();
    f.pending[1]?.resolve(Texture.EMPTY); f.pending[0]?.resolve(Texture.EMPTY); await flush();
    expect(f.layer.imageOf("tile")).toBe("a");
    expect((f.below.children.find((child) => child instanceof Sprite) as Sprite).texture).toBe(Texture.WHITE);
    expect(f.below.children.filter((child) => child instanceof Sprite)).toHaveLength(1);
    f.layer.destroy();
  });

  test("first-class regions render rotated convex outlines and are removed on projection loss", () => {
    const f = fixture();
    f.layer.sync([], [], [region]);
    expect(f.below.children).toHaveLength(1);
    expect(f.below.children[0]).toBeInstanceOf(Graphics);
    expect(f.below.children[0]?.getLocalBounds().width).toBeGreaterThan(0);
    expect(f.below.children[0]?.rotation).toBeCloseTo(15 * Math.PI / 180);
    f.layer.sync([], [], []);
    expect(f.below.children).toHaveLength(0);
    f.layer.destroy();
  });

  test("clear/delete/recreate/destroy discard pending views; unchanged images do not refetch", async () => {
    const f = fixture();
    f.layer.sync([tile("a")], []); f.layer.sync([tile("a")], []);
    expect(f.pending).toHaveLength(1);
    f.layer.sync([tile("")], []);
    f.pending[0]?.resolve(Texture.WHITE); await flush();
    expect(f.layer.imageOf("tile")).toBeNull();
    f.layer.sync([tile("b")], []);
    f.layer.sync([], []);
    f.layer.sync([tile("b")], []); // same ID, a different view
    f.pending[1]?.resolve(Texture.WHITE); await flush();
    expect(f.layer.imageOf("tile")).toBeNull();
    f.pending[2]?.resolve(Texture.EMPTY); await flush();
    expect(f.layer.imageOf("tile")).toBe("b");
    f.layer.sync([tile("c")], []); f.layer.destroy();
    f.pending[3]?.resolve(Texture.WHITE); await flush();
    expect(f.below.children).toHaveLength(0); expect(f.layer.imageOf("tile")).toBeNull();
  });
});
