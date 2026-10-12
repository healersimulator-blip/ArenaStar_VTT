/** G-30 (D-449): Foundry scene exports (Levels module, V14 core levels, flat) become draft floors. */
import { describe, expect, test } from "vitest";
import tower from "../fixtures/foundry/levels-tower.json";
import cabin from "../fixtures/foundry/core-cabin.json";
import { foundryImageName, foundryImagePaths, planFoundryImport, type FoundryImportResult } from "../../src/core/foundryImport";
import type { SceneDocument } from "../../src/core/documents";

const ids = () => { let n = 0; return () => `imp-${++n}`; };
const plan = (raw: unknown, images?: Map<string, string>) => planFoundryImport(raw, { sceneId: "scene-imp", nextId: ids(), ...(images ? { images } : {}) });
const ok = (result: FoundryImportResult) => { if (!result.ok) throw new Error(result.error); return result; };
const floorNamed = (scene: SceneDocument, name: string) => { const f = scene.levels?.find((l) => l.name === name); if (!f) throw new Error(name); return f; };
const HASH = "a".repeat(64);

describe("Levels module scene (Foundry V10–V13)", () => {
  const { scene, report } = ok(plan(tower, new Map([["tower ground.png", HASH]])));
  const ground = floorNamed(scene, "Ground"), upper = floorNamed(scene, "Upper");

  test("floors come from the level list; inclusive tops meet the next floor; the map floor shows the background", () => {
    expect(report.source).toBe("levels-module");
    expect(scene.levels?.map((l) => [l.name, l.bottom, l.top, l.floorZ])).toEqual([["Ground", 0, 10, 0], ["Upper", 10, 19, 10]]);
    expect(upper.visibleLevelIds).toEqual([ground._id]);
    expect(ground.visibleLevelIds).toEqual([]);
    expect(ground.useSceneBackground).toBe(true);
    expect(scene.img).toBe(HASH); // the picked file
    expect(scene.levelMode).toBeUndefined(); // drafts: floor play is turned on after the check
    expect(scene.active).toBe(false);
    expect(scene.grid).toMatchObject({ type: "square", size: 100, distance: 5, units: "ft" });
  });

  test("walls: the padding margin is removed, heights become floor scopes, doors keep their state", () => {
    const walls = scene.walls;
    expect(walls.map((w) => w.c)).toEqual([[0, 0, 500, 0], [0, 100, 500, 100], [0, 200, 500, 200], [0, 300, 500, 300], [0, 400, 500, 400]]);
    expect(walls.map((w) => w.levelScope)).toEqual([
      { mode: "all" },
      { mode: "levels", ids: [ground._id] },
      { mode: "levels", ids: [upper._id] },
      { mode: "all" },
      { mode: "all" },
    ]);
    expect(walls[2]).toMatchObject({ door: 2, move: 1, sight: 1, sound: 1, light: 1 }); // locked door
    expect(walls[0]).toMatchObject({ door: 0, move: 0, sight: 0, sound: 0, light: 0 });
    expect(walls[3]).toMatchObject({ move: 2, sight: 2, sound: 2, light: 2 });
    expect(walls[4]).toMatchObject({ sight: 0, oneWay: false }); // limited sight blocks; one-way is two-way
    expect(report.notes.join(" ")).toContain("1 wall(s) with limited");
    expect(report.notes.join(" ")).toContain("1 one-way wall(s)");
  });

  test("lights: radii in pixels, Levels ranges become floors, unflagged lights shine on every floor; off and dark ones are skipped", () => {
    expect(scene.lights.map((l) => [l.x, l.y, l.dim, l.bright, l.levelScope])).toEqual([
      [200, 200, 600, 300, { mode: "levels", ids: [ground._id] }],
      [300, 200, 400, 200, { mode: "levels", ids: [upper._id] }],
      [400, 200, 400, 0, { mode: "all" }],
    ]);
    expect(scene.lights[0]).toMatchObject({ color: "#ff8800", alpha: 0.4 });
    expect(report.skipped).toEqual(expect.arrayContaining([{ what: "switched-off lights", count: 1 }, { what: "darkness sources", count: 1 }]));
    expect(report.notes.join(" ")).toContain("1 cone light(s)");
    expect(report.everyFloor).toEqual({ walls: 3, lights: 1 });
  });

  test("tiles: a Levels floor tile is floor art under the tokens; roofs stay overhead; unflagged tiles go to the map floor", () => {
    const [floorArt, barrel, roof] = scene.tiles;
    expect(floorArt).toMatchObject({ x: 0, y: 0, width: 1000, height: 800, above: false, img: "", flags: { foundry: { src: "worlds/w/maps/tower-upper.webp" } } });
    expect(barrel).toMatchObject({ x: 100, y: 100, above: false });
    expect(roof).toMatchObject({ above: true, occlusion: { mode: "roof", alpha: 0.3 } });
    expect(upper.tileIds).toEqual([floorArt?._id, roof?._id]);
    expect(ground.tileIds).toEqual([barrel?._id]);
    expect(report.notes.join(" ")).toContain("1 tile(s) without floor data were put on Ground");
  });

  test("tokens: centred, on the floor their elevation is in, with vision and light", () => {
    const [guard, hero] = scene.tokens;
    expect(guard).toMatchObject({ name: "Guard", x: 200, y: 200, width: 100, height: 100, elevation: 10, levelId: upper._id, disposition: "hostile", vision: true, darkvision: 60 });
    expect(hero).toMatchObject({ name: "Hero", x: 400, y: 400, levelId: ground._id, disposition: "friendly", light: { radius: 400, bright: 200, color: "#ffeeaa", alpha: 0.5 } });
    expect(guard?.actorId).toBeUndefined();
    expect(report.notes.join(" ")).toContain("1 token(s) came from actors");
  });

  test("stair, one-way stair and elevator drawings become stairwells; holes and plain drawings are skipped", () => {
    const regions = scene.regions ?? [];
    expect(regions.map((r) => [r.name, r.x, r.y, r.width, r.height])).toEqual([["Main stairs", 550, 50, 100, 200], ["Stairs", 750, 50, 100, 100], ["Lift", 750, 250, 100, 100]]);
    expect(regions[0]?.stairs).toEqual({ version: 2, levels: [ground._id, upper._id], mode: "auto" });
    expect(regions[1]?.stairs).toEqual({ version: 2, levels: [ground._id, upper._id], mode: "auto", edges: [{ from: ground._id, to: upper._id }] });
    expect(regions[2]?.stairs).toEqual({ version: 2, levels: [ground._id, upper._id], mode: "auto" });
    expect(report.skipped).toEqual(expect.arrayContaining([
      { what: "Levels hole drawings (trace the floor art instead)", count: 1 }, { what: "drawings", count: 1 }, { what: "sounds", count: 1 },
    ]));
    expect(report.floors.map((f) => [f.name, f.walls, f.lights, f.tiles, f.tokens, f.stairs])).toEqual([["Ground", 1, 1, 1, 1, 3], ["Upper", 1, 1, 2, 1, 3]]);
  });

  test("the report lists every image and which ones have a file", () => {
    expect(report.images.find((i) => i.path === "worlds/w/maps/Tower%20Ground.png")).toMatchObject({ name: "tower ground.png", linked: true });
    expect(report.images.filter((i) => !i.linked).map((i) => i.name).sort()).toEqual(["barrel.webp", "guard.webp", "hero.webp", "roof.webp", "tower-upper.webp"]);
    expect(foundryImagePaths(tower).map((i) => i.name).sort()).toEqual(["barrel.webp", "guard.webp", "hero.webp", "roof.webp", "tower ground.png", "tower-upper.webp"]);
    expect(foundryImageName("worlds/x/My%20Map.WebP?v=2")).toBe("my map.webp");
  });
});

describe("Foundry V14 core levels", () => {
  const { scene, report } = ok(plan(cabin));
  const basement = floorNamed(scene, "Basement"), down = floorNamed(scene, "Downstairs"), up = floorNamed(scene, "Upstairs");

  test("levels keep their bands and visibility; each floor's background is floor art; the map floor uses the scene image", () => {
    expect(report.source).toBe("foundry-levels");
    expect(scene.levels?.map((l) => [l.name, l.bottom, l.top])).toEqual([["Basement", -10, 0], ["Downstairs", 0, 10], ["Upstairs", 10, null]]);
    expect(up.visibleLevelIds).toEqual([down._id]);
    expect(down.visibleLevelIds).toEqual([]);
    expect(down.useSceneBackground).toBe(true);
    expect(scene.img).toBeNull(); // no file picked; the path is kept
    expect(scene.flags.foundry).toEqual({ src: "a/Down.webp" });
    const named = (n: string) => scene.tiles.find((t) => t.name === n);
    expect(basement.tileIds).toEqual([named("Basement map")?._id]);
    expect(up.tileIds).toEqual([named("Upstairs map")?._id]);
    expect(down.tileIds).toEqual([named("rug.webp")?._id, named("Downstairs foreground")?._id]);
    expect(named("Downstairs foreground")).toMatchObject({ above: true });
    expect(scene.grid.diagonals).toBe("euclidean");
  });

  test("placeable level lists become scopes; tokens use their level or elevation", () => {
    expect(scene.walls.map((w) => w.levelScope)).toEqual([{ mode: "levels", ids: [down._id, up._id] }, { mode: "all" }]);
    expect(scene.lights[0]?.levelScope).toEqual({ mode: "levels", ids: [up._id] });
    expect(scene.tokens.map((t) => [t.name, t.levelId])).toEqual([["Cat", up._id], ["Rat", basement._id]]);
  });

  test("Change Level regions become prompting stairwells; other regions are skipped", () => {
    const [stairs, trapdoor] = scene.regions ?? [];
    expect(stairs).toMatchObject({ name: "Stairs", x: 500, y: 500, width: 100, height: 200, stairs: { version: 2, levels: [down._id, up._id], mode: "prompt" } });
    expect(trapdoor).toMatchObject({ name: "Trapdoor", x: 700, y: 700, width: 100, height: 100, stairs: { levels: [basement._id, down._id], mode: "prompt" } });
    expect(trapdoor?.shape.points).toEqual([[0, 0], [1, 0], [0.5, 1]]);
    expect(report.skipped).toEqual([{ what: "regions", count: 1 }]);
  });
});

describe("other shapes", () => {
  test("a flat Foundry V9 scene: legacy fields, no floors, stairs skipped", () => {
    const { scene, report } = ok(plan({
      name: "Old", width: 500, height: 500, padding: 0, grid: 50, gridType: 1, gridDistance: 5, gridUnits: "ft", img: "maps/old.jpg", shiftX: 10, shiftY: 0, darkness: 0.4,
      walls: [{ c: [0, 0, 50, 0], move: 1, sense: 2, sound: 1, door: 1, ds: 1 }],
      lights: [{ x: 10, y: 10, dim: 10, bright: 5, tintColor: "#00ff00", tintAlpha: 0.3 }],
      tokens: [{ name: "Orc", x: 0, y: 0, width: 2, height: 2, img: "tokens/orc.png", vision: true, dimSight: 30 }],
      drawings: [{ x: 0, y: 0, type: "r", width: 10, height: 10, flags: { levels: { drawingMode: 2, rangeTop: 10 } } }],
    }));
    expect(report.source).toBe("flat");
    expect(scene.levels).toBeUndefined();
    expect(scene).toMatchObject({ darkness: 0.4, img: null, background: { offset: { x: 10, y: 0 } }, grid: { size: 50 } });
    expect(scene.walls[0]).toMatchObject({ door: 1, move: 1, sight: 1, sound: 1, light: 1 });
    expect(scene.walls[0]?.levelScope).toBeUndefined();
    expect(scene.lights[0]).toMatchObject({ dim: 100, bright: 50, color: "#00ff00", alpha: 0.3 });
    expect(scene.tokens[0]).toMatchObject({ x: 50, y: 50, width: 100, height: 100, vision: true, darkvision: 30 });
    expect(scene.tokens[0]?.levelId).toBeUndefined();
    expect(report.skipped).toEqual([{ what: "stairs on a scene without floors", count: 1 }]);
  });

  test("no level list: floors are inferred from tall wall bands; overlapping bands are clipped", () => {
    const inferred = ok(plan({ name: "Keep", width: 400, height: 400, padding: 0, walls: [
      { c: [0, 0, 10, 0], flags: { "wall-height": { bottom: 0, top: 10 } } }, { c: [0, 5, 10, 5], flags: { "wall-height": { bottom: 10, top: 20 } } },
      { c: [0, 9, 10, 9], flags: { "wall-height": { bottom: 2, top: 4 } } }] }));
    expect(inferred.report.source).toBe("inferred");
    expect(inferred.scene.levels?.map((l) => [l.bottom, l.top])).toEqual([[0, 10], [10, 20]]);
    expect(inferred.scene.walls[2]?.levelScope).toEqual({ mode: "levels", ids: [inferred.scene.levels?.[0]?._id] }); // a short wall stays on its floor

    const clipped = ok(plan({ name: "Overlap", width: 400, height: 400, padding: 0, walls: [], flags: { levels: { sceneLevels: [[0, 15, "A"], [10, 20, "B"]] } } }));
    expect(clipped.scene.levels?.map((l) => [l.name, l.bottom, l.top])).toEqual([["A", 0, 10], ["B", 10, 20]]);
    expect(clipped.report.notes.join(" ")).toContain("1 overlapping floor band(s) were clipped");
  });

  test("files that are not one scene are refused with a reason; a one-scene world export is fine", () => {
    expect(plan(null)).toEqual({ ok: false, error: "This is not a Foundry scene export (expected a JSON object)." });
    expect(plan({ name: "x" })).toEqual({ ok: false, error: "This is not a Foundry scene export (no size, walls, tiles or tokens)." });
    expect(plan({ scenes: [tower, cabin] })).toEqual({ ok: false, error: "The file holds 2 scenes. Export a single scene from Foundry (right-click it → Export Data)." });
    expect(ok(plan({ scenes: [cabin] })).report.name).toBe("Cabin");
  });
});
