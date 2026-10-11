import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { boot, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel, generateLevels, sceneLevelsError } from "../../src/core/levels";
import { floorForElevation, floorMoveOps, levelCreationOps } from "../../src/core/levelPlay";
import { adjacentFloor, floorRoster, gmFloorRender } from "../../src/core/gmFloorView";
import { unscopedToFloorOps } from "../../src/core/levelAudit";
import { levelFocusView } from "../../src/core/levelNavigation";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import type { LightDocument, NoteDocument, SceneDocument, TileDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
const token = (id: string, levelId?: string, over: Partial<TokenDocument> = {}): TokenDocument => ({ ...base, _id: id, type: "token", name: id, x: 100, y: 100, width: 50, height: 50, rotation: 0,
  elevation: levelId === "upper" ? 10 : 0, ...(levelId ? { levelId } : {}), img: "", vision: false, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 }, ...over });
const tile = (id: string): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 0, y: 0, width: 10, height: 10, img: "https://example.invalid/t.png", above: false, occlusion: { mode: "fade", alpha: 1 } });
const wall = (id: string, scope?: WallDocument["levelScope"]): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c: [0, 0, 1, 1], door: 0, oneWay: false, move: 0, sight: 0, light: 0, sound: 0, ...(scope ? { levelScope: scope } : {}) });
const light = (id: string, scope?: LightDocument["levelScope"]): LightDocument => ({ ...base, _id: id, type: "light", name: id, x: 1, y: 1, dim: 1, bright: 1, color: "#fff", alpha: 1, ...(scope ? { levelScope: scope } : {}) });
const note = (id: string, scope?: NoteDocument["levelScope"]): NoteDocument => ({ ...base, _id: id, type: "note", name: id, x: 1, y: 1, text: "", icon: "", ...(scope ? { levelScope: scope } : {}) } as NoteDocument);
function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return { ...base, _id: DEFAULT_SCENE_ID, type: "scene", name: "Keep", active: true, img: "https://example.invalid/bg.png", width: 1000, height: 1000,
    grid: { type: "square", size: 50, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0,
    levels: [{ ...draftLevel("ground", "Ground", 0, 10, 0), tileIds: ["g-map"], useSceneBackground: true }, { ...draftLevel("upper", "Upper", 10, 20, 1), tileIds: ["u-map"] }],
    tokens: [token("hero", "ground"), token("archer", "upper"), token("loose")], tiles: [tile("g-map"), tile("u-map"), tile("prop")],
    walls: [wall("w-ground", { mode: "levels", ids: ["ground"] }), wall("w-upper", { mode: "levels", ids: ["upper"] }), wall("w-legacy")],
    lights: [light("l-upper", { mode: "levels", ids: ["upper"] }), light("l-all", { mode: "all" })], sounds: [], drawings: [], templates: [],
    notes: [note("n-upper", { mode: "levels", ids: ["upper"] }), note("n-everywhere")], regions: [], ...over };
}

test("GM floor view filters what is drawn and picked, never the documents", () => {
  const s = scene(), before = structuredClone(s);
  const only = gmFloorRender(s, { levelId: "upper", mode: "only" });
  expect(only.scene.tokens.map((t) => t._id)).toEqual(["archer", "loose"]); // floorless stays visible: the GM must fix it
  expect(only.scene.tiles.map((t) => t._id)).toEqual(["u-map", "prop"]);
  expect(only.scene.walls.map((w) => w._id)).toEqual(["w-upper", "w-legacy"]);
  expect(only.scene.lights.map((l) => l._id)).toEqual(["l-upper", "l-all"]);
  expect(only.scene.notes.map((n) => n._id)).toEqual(["n-upper", "n-everywhere"]);
  expect(only.scene.img).toBeNull(); // the background belongs to the ground floor
  expect(only.pickable(token("hero", "ground"))).toBe(false);
  const ghost = gmFloorRender(s, { levelId: "upper", mode: "ghost" });
  expect(ghost.scene.tokens).toHaveLength(3);
  expect([...ghost.ghost.tokens]).toEqual(["hero"]);
  expect([...ghost.ghost.tiles]).toEqual(["g-map"]);
  expect(gmFloorRender(s, { levelId: "ground", mode: "only" }).scene.img).toBe(s.img);
  expect(gmFloorRender(s, { levelId: "upper", mode: "all" }).scene).toBe(s);
  expect(gmFloorRender(s, null).scene).toBe(s);
  expect(gmFloorRender(s, { levelId: "gone", mode: "only" }).scene).toBe(s);
  expect(s).toEqual(before);
  expect(adjacentFloor(s.levels ?? [], null, 1)).toBe("ground");
  expect(adjacentFloor(s.levels ?? [], null, -1)).toBe("upper");
  expect(adjacentFloor(s.levels ?? [], "ground", 1)).toBe("upper");
  expect(adjacentFloor(s.levels ?? [], "upper", 1)).toBe("upper");
  expect(floorRoster(s, (t) => t._id !== "archer")).toEqual([
    { levelId: "upper", tokens: 1, pcs: [] }, { levelId: "ground", tokens: 1, pcs: [expect.objectContaining({ _id: "hero" })] }, { levelId: null, tokens: 1, pcs: [expect.objectContaining({ _id: "loose" })] },
  ]);
});

test("build floor stamps every kind; tiles join the floor art; players' viewed floor only stamps presentation objects", () => {
  const s = scene();
  const create = (coll: Op extends infer O ? O extends { kind: "create"; coll: infer C } ? C : never : never, data: object): Op => ({ kind: "create", coll, parent, data } as Op);
  const ops = levelCreationOps([
    create("walls", wall("new-wall")), create("lights", light("new-light")), create("notes", note("new-note")),
    create("tiles", tile("new-map")), create("tiles", tile("new-prop")), create("tokens", { ...token("new-token"), elevation: 0 }),
    create("walls", wall("explicit", { mode: "all" })),
  ], () => s, () => null, () => "upper");
  const data = (id: string) => (ops.find((op) => op.kind === "create" && op.data._id === id) as Extract<Op, { kind: "create" }>).data as unknown as Record<string, unknown>;
  expect(data("new-wall").levelScope).toEqual({ mode: "levels", ids: ["upper"] });
  expect(data("new-light").levelScope).toEqual({ mode: "levels", ids: ["upper"] });
  expect(data("new-note").levelScope).toEqual({ mode: "levels", ids: ["upper"] });
  expect(data("explicit").levelScope).toEqual({ mode: "all" });
  expect(data("new-token")).toMatchObject({ levelId: "upper", elevation: 10 }); // build floor even before isolated play
  expect(ops.at(-1)).toEqual({ kind: "update", ref: { coll: "levels", id: "upper", parent }, diff: { tileIds: ["u-map", "new-map", "new-prop"] } });
  // Without a build floor and outside isolated play nothing changes.
  const plain = [create("walls", wall("w2")), create("tiles", tile("t2"))];
  expect(levelCreationOps(plain, () => s)).toEqual(plain);
  // A player's viewed floor in isolated play stamps drawings/templates/notes, never walls or tiles.
  const iso = { ...s, levelMode: "isolated" as const };
  const viewed = levelCreationOps([create("notes", note("p-note")), create("walls", wall("p-wall"))], () => iso, () => "upper");
  expect((viewed[0] as Extract<Op, { kind: "create" }>).data).toMatchObject({ levelScope: { mode: "levels", ids: ["upper"] } });
  expect((viewed[1] as Extract<Op, { kind: "create" }>).data).not.toHaveProperty("levelScope");
});

test("move to floor carries attached tokens; elevation picks the floor; generated stacks validate", () => {
  const rider = token("rider", "ground", { flags: { prefab: { instanceId: "cart", rootId: "hero", parentId: "hero" } } });
  const s = scene({ tokens: [token("hero", "ground", { flags: { prefab: { instanceId: "cart", rootId: "hero" } } }), rider, token("archer", "upper")] });
  expect(floorMoveOps(s, ["hero"], "upper")).toEqual([
    { kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "upper", elevation: 10 } },
    { kind: "update", ref: { coll: "tokens", id: "rider", parent }, diff: { levelId: "upper", elevation: 10 } },
  ]);
  expect(floorMoveOps(s, ["archer"], "upper")).toEqual([]); // already there
  expect(floorMoveOps(s, ["archer"], "upper", 15)).toEqual([{ kind: "update", ref: { coll: "tokens", id: "archer", parent }, diff: { levelId: "upper", elevation: 15 } }]);
  expect(floorMoveOps(s, ["archer"], "ground", 15)).toMatchObject([{ diff: { levelId: "ground", elevation: 0 } }]); // outside the band → Floor Z
  expect(() => floorMoveOps(s, ["hero"], "attic")).toThrow("no longer exists");
  expect(floorForElevation(s, 12)?._id).toBe("upper");
  expect(floorForElevation(s, 25)).toBeNull();
  let n = 0;
  const stack = generateLevels({ floors: 3, basements: 2, height: 12, roof: true, id: () => `g${n++}` });
  expect(stack.map((l) => [l.name, l.bottom, l.top, l.floorZ, l.sort])).toEqual([
    ["Basement 2", -24, -12, -24, 0], ["Basement 1", -12, 0, -12, 1], ["Ground", 0, 12, 0, 2], ["Floor 2", 12, 24, 12, 3], ["Floor 3", 24, 36, 24, 4], ["Roof", 36, null, 36, 5],
  ]);
  expect(sceneLevelsError({ levels: stack })).toBeNull();
  expect(generateLevels({ floors: 1, basements: 1, height: 3, id: () => `h${n++}` }).map((l) => l.name)).toEqual(["Basement", "Ground"]);
  expect(() => generateLevels({ floors: 0, basements: 0, height: 10, id: () => "x" })).toThrow();
  expect(unscopedToFloorOps(s, "ground").map((op) => op.kind === "update" ? op.ref.id : "")).toEqual(["w-legacy"]);
  expect(levelFocusView({ ...s, ownership: { default: 2 } }, [], { id: "gm", role: "GM" }, "upper").levels.map((l) => l.id)).toEqual(["ground", "upper"]);
});

test("host: a GM's explicit floor focus is the build floor; the follow default never stamps", async () => {
  const app = await boot();
  try {
    const original = app.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const configured = { ...original, levels: scene().levels, tiles: [tile("g-map"), tile("u-map")] };
    await app.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    await app.gm.client.submitAndWait([{ kind: "create", coll: "walls", parent, data: wall("before-focus") }]);
    expect(app.store.get("scenes", DEFAULT_SCENE_ID)?.walls.find((w) => w._id === "before-focus")?.levelScope).toBeUndefined();
    app.gm.client.requestLevelFocus(DEFAULT_SCENE_ID, "upper"); await settle(6);
    await app.gm.client.submitAndWait([{ kind: "create", coll: "walls", parent, data: wall("built") }, { kind: "create", coll: "tiles", parent, data: tile("upper-prop") }]);
    const live = app.store.get("scenes", DEFAULT_SCENE_ID);
    expect(live?.walls.find((w) => w._id === "built")?.levelScope).toEqual({ mode: "levels", ids: ["upper"] });
    expect(live?.levels?.find((l) => l._id === "upper")?.tileIds).toEqual(["u-map", "upper-prop"]);
    expect(app.host.undo().ok).toBe(true); // the wall, the tile and the floor-art change undo together
    expect(app.store.get("scenes", DEFAULT_SCENE_ID)?.levels?.find((l) => l._id === "upper")?.tileIds).toEqual(["u-map"]);
    app.gm.client.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    await app.gm.client.submitAndWait([{ kind: "create", coll: "walls", parent, data: wall("after-focus") }]);
    expect(app.store.get("scenes", DEFAULT_SCENE_ID)?.walls.find((w) => w._id === "after-focus")?.levelScope).toBeUndefined();
  } finally { await app.close(); const db = await openVttDb(); await deleteWorldData(db, app.worldId); db.close(); }
});
