/** G-09 pass-through stairs and G-11 door-linked stairs (D-437). */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import {
  remapStairLevels, segmentPolygonSpan, stairBehaviorError, stairChoiceOps, stairChoicesHere, stairLocked, stairMarkers, stairMovementOps, stairMovementPlan,
  stairSpec, type StairBehaviorV2,
} from "../../src/core/levelPlay";
import { levelPlayAudit } from "../../src/core/levelAudit";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import type { LevelDocument, RegionDocument, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import type { StairOfferMsg } from "../../src/core/messages";
import type { Op } from "../../src/core/ops";

const parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
const levels = (): LevelDocument[] => [draftLevel("cellar", "Cellar", -10, 0, 0), draftLevel("ground", "Ground", 0, 10, 1), draftLevel("upper", "Upper", 10, 20, 2)];
function token(id = "hero", over: Partial<TokenDocument> = {}): TokenDocument {
  return { _id: id, type: "token", name: id, flags: {}, system: {}, ownership: { default: 0 }, x: 50, y: 50, width: 20, height: 20, rotation: 0, elevation: 0, levelId: "ground",
    img: "", vision: true, hidden: false, disposition: "neutral", light: { radius: 0, color: "#fff", alpha: 0 }, ...over };
}
function region(id: string, stairs: RegionDocument["stairs"], over: Partial<RegionDocument> = {}): RegionDocument {
  return { _id: id, type: "region", name: `Region ${id}`, ownership: { default: 0 }, flags: {}, system: {}, hidden: true, x: 100, y: 0, width: 100, height: 100,
    shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, ...(stairs ? { stairs } : {}), ...over };
}
const well = (over: Partial<StairBehaviorV2> = {}): StairBehaviorV2 => ({ version: 2, levels: ["cellar", "ground", "upper"], mode: "auto", trigger: "cross", ...over });
const pair = (over: Partial<StairBehaviorV2> = {}): StairBehaviorV2 => well({ levels: ["ground", "upper"], ...over });
const wall = (id: string, c: WallDocument["c"], ids: string[], over: Partial<WallDocument> = {}): WallDocument =>
  ({ _id: id, type: "wall", name: id, ownership: { default: 0 }, flags: {}, system: {}, c, levelScope: { mode: "levels", ids }, door: 0, oneWay: false, move: 0, sight: 0, light: 0, sound: 0, ...over });
const gate = (state: 0 | 1 | 2, over: Partial<WallDocument> = {}) => wall("gate", [300, 200, 400, 200], ["ground"], { door: state, move: 1, sight: 1, ...over });
function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return { _id: DEFAULT_SCENE_ID, type: "scene", name: "Tower", ownership: { default: 0 }, flags: {}, system: {}, active: true, img: null, width: 1000, height: 1000,
    grid: { type: "square", size: 50, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0, levelMode: "isolated", levels: levels(), tokens: [token()],
    walls: [], lights: [], sounds: [], tiles: [], regions: [region("well", well())], drawings: [], templates: [], notes: [], ...over };
}
const move = (x: number, y = 50, id = "hero"): Op => ({ kind: "update", ref: { coll: "tokens", id, parent }, diff: { x, y } });
const at = (diff: Record<string, unknown>, id = "hero"): Op => ({ kind: "update", ref: { coll: "tokens", id, parent }, diff } as Op);

test("validation: trigger and door are optional, shape-checked, and a dangling door never fails a level transaction", () => {
  const all = levels();
  expect(stairBehaviorError(well(), all)).toBeNull();
  expect(stairBehaviorError(well({ trigger: "end", door: "gate-1" }), all)).toBeNull();
  for (const bad of [{ ...well(), trigger: "teleport" }, { ...well(), trigger: true }, { ...well(), door: "" }, { ...well(), door: "bad id" }, { ...well(), door: 7 }])
    expect(stairBehaviorError(bad, all), JSON.stringify(bad)).not.toBeNull();
  expect(sceneLevelsError(scene({ regions: [region("well", well({ door: "deleted-wall" }))] }))).toBeNull();
  expect(stairSpec(well())).toMatchObject({ trigger: "cross" });
  expect(stairSpec(well({ trigger: undefined } as unknown as Partial<StairBehaviorV2>))).toMatchObject({ trigger: "end" });
  expect(stairSpec({ from: "ground", to: "upper" })).toMatchObject({ trigger: "end", legacy: true });
});

test("segment span: entry and exit parameters against convex polygons in either winding", () => {
  const square = [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 }];
  expect(segmentPolygonSpan(square, { x: 50, y: 50 }, { x: 300, y: 50 })).toEqual({ enter: 0.2, exit: 0.6 });
  expect(segmentPolygonSpan([...square].reverse(), { x: 50, y: 50 }, { x: 300, y: 50 })).toEqual({ enter: 0.2, exit: 0.6 });
  expect(segmentPolygonSpan(square, { x: 50, y: 150 }, { x: 300, y: 150 })).toBeNull();
  expect(segmentPolygonSpan(square, { x: 50, y: 50 }, { x: 90, y: 50 })).toBeNull();
});

test("auto pass-through: one destination changes floor at the stairs and the route continues on the new floor", () => {
  const s = scene({ regions: [region("pair", pair())] });
  expect(stairMovementOps([move(300)], () => s)).toEqual([move(300), at({ levelId: "upper", elevation: 10 })]);
  // The new floor's walls end the route at the stop: just inside the stairs, on the nearest cell centre.
  const walled = scene({ regions: [region("pair", pair())], walls: [wall("upper-wall", [250, 0, 250, 100], ["upper"])] });
  expect(stairMovementOps([move(300)], () => walled).at(-1)).toEqual(at({ levelId: "upper", elevation: 10, x: 125, y: 75 }));
  // An arrival point wins over the continuation.
  const arrival = scene({ regions: [region("pair", pair({ arrivals: [{ levelId: "upper", x: 400, y: 420 }] }))] });
  expect(stairMovementOps([move(300)], () => arrival).at(-1)).toEqual(at({ levelId: "upper", elevation: 10, x: 400, y: 420 }));
  // Default stairs (trigger absent) still need the move to end inside.
  const endOnly = scene({ regions: [region("pair", pair({ trigger: undefined } as unknown as Partial<StairBehaviorV2>))] });
  expect(stairMovementPlan([move(300)], () => endOnly)).toEqual({ ops: [move(300)], prompts: [] });
  // Ending inside a pass-through stairwell behaves exactly like ending inside any stairwell.
  expect(stairMovementOps([move(150)], () => s)).toEqual([move(150), at({ levelId: "upper", elevation: 10 })]);
  // Gridless scenes stop one pixel inside the entry edge.
  const gridless = { ...walled, grid: { ...walled.grid, type: "gridless" } } as SceneDocument;
  expect(stairMovementOps([move(300)], () => gridless).at(-1)).toEqual(at({ levelId: "upper", elevation: 10, x: 101, y: 50 }));
});

test("prompt pass-through: the token stops inside the stairs and is asked; the choice is revalidated there", () => {
  const s = scene();
  const plan = stairMovementPlan([move(300)], () => s);
  expect(plan.ops).toEqual([move(300), at({ x: 125, y: 75 })]);
  expect(plan.prompts).toEqual([{ sceneId: DEFAULT_SCENE_ID, tokenId: "hero", fromLevelId: "ground", regionIds: ["well"],
    choices: [{ levelId: "upper", name: "Upper", direction: "up" }, { levelId: "cellar", name: "Cellar", direction: "down" }] }]);
  const stopped = { ...s, tokens: [token("hero", { x: 125, y: 75 })] };
  expect(stairChoicesHere(stopped, stopped.tokens[0] as TokenDocument).choices.map((c) => c.levelId)).toEqual(["upper", "cellar"]);
  expect(stairChoiceOps(stopped, plan.prompts[0] as NonNullable<(typeof plan.prompts)[0]>, "cellar")).toEqual([at({ levelId: "cellar", elevation: -10 })]);
  // Attached prefab parts stop with their parent, keeping their offset.
  const rider = token("rider", { x: 55, y: 50, flags: { prefab: { instanceId: "cart", rootId: "hero", parentId: "hero" } } });
  const cart = scene({ tokens: [token("hero", { flags: { prefab: { instanceId: "cart", rootId: "hero" } } }), rider] });
  expect(stairMovementPlan([move(300), move(305, 50, "rider")], () => cart).ops.slice(2)).toEqual([at({ x: 125, y: 75 }), at({ x: 130, y: 75 }, "rider")]);
  // Prompt mode with a single floor still asks.
  const asked = scene({ regions: [region("pair", pair({ mode: "prompt" }))] });
  expect(stairMovementPlan([move(300)], () => asked)).toMatchObject({ ops: [move(300), at({ x: 125, y: 75 })], prompts: [{ choices: [{ levelId: "upper" }] }] });
});

test("the first stairwell along the path wins; unusable pass-throughs are walked over silently", () => {
  const near = region("near", pair(), { x: 100 }), far = region("far", well({ levels: ["ground", "cellar"] }), { x: 400 });
  expect(stairMovementOps([move(700)], () => scene({ regions: [far, near] })).at(-1)).toEqual(at({ levelId: "upper", elevation: 10 }));
  // Locked (by flag or by a closed door), blocked landing or a wall before the stairs: no stop, no notice.
  const lockedNear = region("near", pair({ locked: true }), { x: 100 });
  expect(stairMovementPlan([move(700)], () => scene({ regions: [lockedNear, far] })).ops.at(-1)).toEqual(at({ levelId: "cellar", elevation: -10 }));
  expect(stairMovementPlan([move(300)], () => scene({ regions: [lockedNear] }))).toEqual({ ops: [move(300)], prompts: [] });
  const landing = scene({ regions: [region("pair", pair())], walls: [wall("landing", [125, 0, 125, 100], ["upper"])] });
  expect(stairMovementPlan([move(300)], () => landing)).toEqual({ ops: [move(300)], prompts: [] });
  const fenced = scene({ regions: [region("pair", pair())], walls: [wall("fence", [80, 0, 80, 100], ["ground"])] });
  expect(stairMovementPlan([move(300)], () => fenced)).toEqual({ ops: [move(300)], prompts: [] });
  // A locked pass-through does not hide the stairwell the move ends in.
  const end = region("end", { version: 2, levels: ["ground", "cellar"], mode: "auto" }, { x: 400 });
  expect(stairMovementOps([move(450)], () => scene({ regions: [lockedNear, end] })).at(-1)).toEqual(at({ levelId: "cellar", elevation: -10 }));
  // Grazing a corner (the centre runs < 1 px inside) is not a crossing.
  const graze = scene({ regions: [region("pair", pair())], tokens: [token("hero", { x: 90, y: 10.2 })] });
  expect(stairMovementPlan([move(110, -9.8)], () => graze)).toEqual({ ops: [move(110, -9.8)], prompts: [] });
  // Starting inside never triggers (outside → inside only), and explicit floor edits opt out.
  expect(stairMovementPlan([move(300)], () => scene({ tokens: [token("hero", { x: 150 })] })).prompts).toEqual([]);
  expect(stairMovementPlan([move(300), at({ levelId: "upper", elevation: 10 })], () => scene()).prompts).toEqual([]);
});

test("door-linked stairs work only while the door is open; dangling links are ignored and audited", () => {
  const linked = (state: 0 | 1 | 2, extra: Partial<SceneDocument> = {}) => scene({ regions: [region("pair", pair({ door: "gate", trigger: "end" }), { x: 300 })], walls: [gate(state)], ...extra });
  expect(stairMovementPlan([move(350)], () => linked(0))).toMatchObject({ ops: [move(350)], prompts: [{ choices: [], reason: "locked" }] });
  expect(stairMovementPlan([move(350)], () => linked(2)).prompts[0]?.reason).toBe("locked");
  expect(stairMovementOps([move(350)], () => linked(1)).at(-1)).toEqual(at({ levelId: "upper", elevation: 10 }));
  expect(stairLocked(linked(0), stairSpec(pair({ door: "gate" })))).toBe(true);
  expect(stairMarkers(linked(0), "ground")[0]?.locked).toBe(true);
  expect(stairMarkers(linked(1), "ground")[0]?.locked).toBe(false);
  // Revalidation sees the door too.
  const standing = (state: 0 | 1 | 2) => ({ ...linked(state), tokens: [token("hero", { x: 350 })] });
  const prompt = { tokenId: "hero", fromLevelId: "ground", regionIds: ["pair"] };
  expect(() => stairChoiceOps(standing(0), prompt, "upper")).toThrow("locked");
  expect(stairChoiceOps(standing(1), prompt, "upper")).toEqual([at({ levelId: "upper", elevation: 10 })]);
  // A deleted wall, or one that is no longer a door, is ignored — and the audit says so.
  const dangling = linked(0, { walls: [] });
  expect(stairMovementOps([move(350)], () => dangling).at(-1)).toEqual(at({ levelId: "upper", elevation: 10 }));
  const plainWall = linked(0, { walls: [wall("gate", [100, 0, 100, 100], ["ground"])] });
  expect(stairLocked(plainWall, stairSpec(pair({ door: "gate" })))).toBe(false);
  expect(levelPlayAudit(dangling).find((f) => f.code === "stairs-door-missing")).toMatchObject({ severity: "warning", ids: ["pair"] });
  expect(levelPlayAudit(linked(0)).find((f) => f.code === "stairs-locked")?.message).toMatch(/until their door opens/);
  expect(levelPlayAudit(linked(1)).some((f) => f.code === "stairs-locked" || f.code === "stairs-door-missing")).toBe(false);
  // Scene copies re-key the door with the walls.
  expect(remapStairLevels(pair({ door: "gate" }), (id) => id, (id) => `${id}-copy`)).toMatchObject({ door: "gate-copy" });
  const plan = planDuplicateSceneOps({ scene: linked(1), id: "tower-copy" });
  if (!plan.ok) throw new Error(plan.error);
  const copied = plan.copy.regions?.[0]?.stairs as StairBehaviorV2;
  expect(copied.door).toBe(plan.copy.walls[0]?._id);
  expect(copied.door).not.toBe("gate");
});

test("host: a pass-through stops a player's token and asks; closing the linked door withdraws the offer and marks the stairs locked", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const configured = { ...original, levelMode: "isolated" as const, levels: levels(), regions: [region("well", well({ label: "Trapdoor", door: "gate" }))],
      walls: [gate(1)], tokens: [token("hero", { ownership: { default: 0, [player.user.id]: 3 } })] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    player.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    expect(player.levelFocus?.presentation?.stairs?.[0]).toMatchObject({ id: "well", label: "Trapdoor", locked: false });
    const offers: StairOfferMsg[] = [];
    playerApp.bus.on("stairOffer", (offer) => offers.push(offer));
    await player.submitAndWait([move(300)]); await settle(6);
    const hero = () => hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "hero");
    expect(hero()).toMatchObject({ x: 150, y: 50, levelId: "ground" }); // the default scene grid is 100: nearest cell centre inside the stairs
    const offer = offers.at(-1) as StairOfferMsg;
    expect(offer).toMatchObject({ status: "open", label: "Trapdoor", choices: [{ levelId: "upper" }, { levelId: "cellar" }] });
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: { coll: "walls", id: "gate", parent }, diff: { door: 0 } }]); await settle(6);
    expect(offers.at(-1)).toMatchObject({ offerId: offer.offerId, status: "ended" });
    expect(player.levelFocus?.presentation?.stairs?.[0]).toMatchObject({ id: "well", locked: true });
    player.requestStairs(DEFAULT_SCENE_ID, "hero"); await settle(6);
    expect(offers.at(-1)).toMatchObject({ status: "locked", choices: [] });
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: { coll: "walls", id: "gate", parent }, diff: { door: 1 } }]); await settle(6);
    player.requestStairs(DEFAULT_SCENE_ID, "hero"); await settle(6);
    const again = offers.at(-1) as StairOfferMsg;
    expect(again).toMatchObject({ status: "open" });
    player.chooseStair(again.offerId, "upper"); await settle(8);
    expect(hero()).toMatchObject({ x: 150, y: 50, levelId: "upper", elevation: 10 });
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
