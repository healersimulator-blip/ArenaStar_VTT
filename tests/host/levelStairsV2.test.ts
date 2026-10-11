import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { joinHostPlayer, settle } from "../app/fakes";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import {
  floorPresentation, floorScene, levelCreationOps, remapStairLevels, stairBehaviorError, stairChoiceOps, stairChoicesHere,
  stairMarkers, stairMovementOps, stairMovementPlan, stairSpec, STAIRS_V2_FEATURE, type StairBehaviorV2,
} from "../../src/core/levelPlay";
import { levelFocusView } from "../../src/core/levelNavigation";
import { opsNeedStairsV2, requiredOpFeatures, requiredWorldFeatures } from "../../src/core/capabilities";
import { levelBindings, sceneMembershipError } from "../../src/core/levelMembership";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import type { DrawingDocument, LevelDocument, NoteDocument, RegionDocument, SceneDocument, TemplateDocument, TokenDocument, WallDocument } from "../../src/core/documents";
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
const well = (over: Partial<StairBehaviorV2> = {}): StairBehaviorV2 => ({ version: 2, levels: ["cellar", "ground", "upper"], mode: "auto", ...over });
function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return { _id: DEFAULT_SCENE_ID, type: "scene", name: "Tower", ownership: { default: 0 }, flags: {}, system: {}, active: true, img: null, width: 1000, height: 1000,
    grid: { type: "square", size: 50, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0, levelMode: "isolated", levels: levels(), tokens: [token()],
    walls: [], lights: [], sounds: [], tiles: [], regions: [region("well", well())], drawings: [], templates: [], notes: [], ...over };
}
const move = (x: number, y = 50, id = "hero"): Op => ({ kind: "update", ref: { coll: "tokens", id, parent }, diff: { x, y } });
const wall = (id: string, c: WallDocument["c"], ids: string[]): WallDocument =>
  ({ _id: id, type: "wall", name: id, ownership: { default: 0 }, flags: {}, system: {}, c, levelScope: { mode: "levels", ids }, door: 0, oneWay: false, move: 0, sight: 0, light: 0, sound: 0 });

test("v2 stairwell validation accepts the documented shape and refuses everything else; legacy stairs still validate", () => {
  const all = levels();
  expect(stairBehaviorError(well(), all)).toBeNull();
  expect(stairBehaviorError({ from: "ground", to: "upper" }, all)).toBeNull();
  expect(stairBehaviorError(well({ edges: [{ from: "upper", to: "ground" }], arrivals: [{ levelId: "ground", x: 120, y: 40 }], locked: true, label: "Spiral stair", secret: false, mode: "prompt" }), all)).toBeNull();
  for (const bad of [
    { ...well(), levels: ["ground"] }, { ...well(), levels: ["ground", "ground"] }, { ...well(), levels: ["ground", "attic"] }, { ...well(), mode: "teleport" },
    { ...well(), edges: [] }, { ...well(), edges: [{ from: "ground", to: "ground" }] }, { ...well(), edges: [{ from: "ground", to: "upper" }, { from: "ground", to: "upper" }] },
    { ...well(), arrivals: [{ levelId: "attic", x: 1, y: 1 }] }, { ...well(), arrivals: [{ levelId: "ground", x: Number.NaN, y: 1 }] }, { ...well(), label: "x".repeat(65) },
    { ...well(), label: "bad\nlabel" }, { ...well(), extra: true }, { ...well(), version: 3 }, { from: "ground", to: "ground" }, { from: "ground", to: "upper", mode: "auto" },
  ]) expect(stairBehaviorError(bad, all), JSON.stringify(bad)).not.toBeNull();
  expect(sceneLevelsError(scene({ regions: [region("bad", { ...well(), levels: ["ground", "attic"] } as StairBehaviorV2)] }))).toMatch(/stairwell connects/);
  expect(stairSpec({ from: "ground", to: "upper" })).toMatchObject({ legacy: true, mode: "auto", edges: [{ from: "ground", to: "upper" }] });
  expect(stairSpec(well()).edges).toHaveLength(6);
});

test("the testers' stairwell: one region serving three floors asks the mover instead of failing", () => {
  const s = scene();
  const plan = stairMovementPlan([move(150)], () => s);
  expect(plan.ops).toEqual([move(150)]); // the move itself commits; the token stands in the stairwell
  expect(plan.prompts).toEqual([{ sceneId: DEFAULT_SCENE_ID, tokenId: "hero", fromLevelId: "ground", regionIds: ["well"],
    choices: [{ levelId: "upper", name: "Upper", direction: "up" }, { levelId: "cellar", name: "Cellar", direction: "down" }] }]);
  // Today's configuration — two overlapping legacy regions — now combines instead of throwing.
  const legacy = scene({ regions: [region("up", { from: "ground", to: "upper" }), region("down", { from: "ground", to: "cellar" })] });
  expect(stairMovementPlan([move(150)], () => legacy).prompts[0]?.choices.map((c) => c.levelId)).toEqual(["upper", "cellar"]);
  // A single destination in auto mode still transitions atomically (D-428 behaviour)…
  const pair = scene({ regions: [region("pair", well({ levels: ["ground", "upper"] }))] });
  expect(stairMovementOps([move(150)], () => pair)).toEqual([move(150), { kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "upper", elevation: 10 } }]);
  // …and prompt mode always asks, even for one destination.
  const asked = scene({ regions: [region("pair", well({ levels: ["ground", "upper"], mode: "prompt" }))] });
  expect(stairMovementPlan([move(150)], () => asked)).toMatchObject({ ops: [move(150)], prompts: [{ choices: [{ levelId: "upper" }] }] });
  // Crossing without ending inside, already inside, and explicit relocations never trigger.
  expect(stairMovementPlan([move(300)], () => s).prompts).toEqual([]);
  expect(stairMovementPlan([move(160)], () => ({ ...s, tokens: [token("hero", { x: 150 })] })).prompts).toEqual([]);
  expect(stairMovementPlan([move(150), { kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "upper", elevation: 10 } }], () => s).prompts).toEqual([]);
});

test("directions, locks, arrivals and landings shape the offer", () => {
  const oneWay = scene({ regions: [region("chute", well({ edges: [{ from: "upper", to: "ground" }, { from: "ground", to: "cellar" }] }))] });
  expect(stairMovementOps([move(150)], () => oneWay).at(-1)).toMatchObject({ diff: { levelId: "cellar", elevation: -10 } });
  const locked = scene({ regions: [region("well", well({ locked: true }))] });
  expect(stairMovementPlan([move(150)], () => locked)).toMatchObject({ ops: [move(150)], prompts: [{ choices: [], reason: "locked" }] });
  // An unlocked overlapping stair still offers its own floors when another one is locked.
  const mixed = scene({ regions: [region("well", well({ locked: true })), region("ladder", well({ levels: ["ground", "upper"] }))] });
  expect(stairMovementOps([move(150)], () => mixed).at(-1)).toMatchObject({ diff: { levelId: "upper" } });
  const arrival = scene({ regions: [region("pair", well({ levels: ["ground", "upper"], arrivals: [{ levelId: "upper", x: 400, y: 420 }] }))] });
  expect(stairMovementOps([move(150)], () => arrival).at(-1)).toMatchObject({ diff: { levelId: "upper", elevation: 10, x: 400, y: 420 } });
  // A landing inside a wall removes only that choice; when nothing is left the move is refused with the reason.
  const blockedUp = scene({ walls: [wall("w-up", [155, 0, 155, 100], ["upper"])] });
  expect(stairMovementPlan([move(150)], () => blockedUp).prompts[0]?.choices.map((c) => c.levelId)).toEqual(["cellar"]);
  const blockedAll = scene({ walls: [wall("w-all", [155, 0, 155, 100], ["upper", "cellar"])] });
  expect(() => stairMovementOps([move(150)], () => blockedAll)).toThrow("Stair landing overlaps a wall");
  expect(() => stairMovementOps([move(150)], () => scene({ walls: [wall("entry", [100, 0, 100, 100], ["ground"])] }))).toThrow("A wall blocks entry to the stairs");
});

test("attached prefab parts follow their parent; summons use stairs like any token", () => {
  const rider = token("rider", { x: 55, y: 50, flags: { prefab: { instanceId: "cart", rootId: "hero", parentId: "hero" } } });
  const cart = scene({ regions: [region("pair", well({ levels: ["ground", "upper"], arrivals: [{ levelId: "upper", x: 400, y: 400 }] }))], tokens: [token("hero", { flags: { prefab: { instanceId: "cart", rootId: "hero" } } }), rider] });
  const ops = stairMovementOps([move(150), move(155, 50, "rider")], () => cart);
  expect(ops.slice(2)).toEqual([
    { kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "upper", elevation: 10, x: 400, y: 400 } },
    { kind: "update", ref: { coll: "tokens", id: "rider", parent }, diff: { levelId: "upper", elevation: 10, x: 405, y: 400 } },
  ]);
  const summon = { version: 1, instanceId: "s1", presetId: "p", sceneId: DEFAULT_SCENE_ID, actorId: "a", tokenId: "hero", ownerId: "u", createdAt: 1 };
  const summoned = scene({ regions: [region("pair", well({ levels: ["ground", "upper"] }))], tokens: [token("hero", { flags: { summon: summon } })] });
  expect(stairMovementOps([move(150)], () => summoned).at(-1)).toMatchObject({ diff: { levelId: "upper" } });
});

test("choices are revalidated: still inside, still on the source floor, still allowed", () => {
  const standing = scene({ tokens: [token("hero", { x: 150 })] });
  const here = stairChoicesHere(standing, standing.tokens[0] as TokenDocument);
  expect(here.choices.map((c) => c.levelId)).toEqual(["upper", "cellar"]);
  expect(stairChoiceOps(standing, here, "cellar")).toEqual([{ kind: "update", ref: { coll: "tokens", id: "hero", parent }, diff: { levelId: "cellar", elevation: -10 } }]);
  expect(() => stairChoiceOps(scene(), here, "upper")).toThrow("no longer available"); // walked out
  expect(() => stairChoiceOps({ ...standing, tokens: [token("hero", { x: 150, levelId: "upper", elevation: 10 })] }, here, "upper")).toThrow("no longer available");
  expect(() => stairChoiceOps({ ...standing, regions: [region("well", well({ locked: true }))] }, here, "upper")).toThrow("locked");
  expect(() => stairChoiceOps({ ...standing, regions: [region("well", well({ edges: [{ from: "ground", to: "cellar" }] }))] }, here, "upper")).toThrow("no longer available");
  expect(() => stairChoiceOps(standing, here, "attic")).toThrow("no longer available");
  expect(stairChoicesHere(scene(), token()).choices).toEqual([]);
});

test("markers, copy re-keying and capability fencing", () => {
  const s = scene({ regions: [region("well", well({ label: "Spiral stair" })), region("secret", well({ levels: ["ground", "cellar"], secret: true }), { x: 600 })] });
  expect(stairMarkers(s, "ground")).toEqual([{ id: "well", points: [100, 0, 200, 0, 200, 100, 100, 100], label: "Spiral stair", up: true, down: true, locked: false }]);
  expect(stairMarkers(s, "upper")[0]).toMatchObject({ up: false, down: true });
  expect(stairMarkers(s, "ground", true)).toHaveLength(2);
  expect(floorPresentation(s, s.levels?.[1] as LevelDocument).stairs?.map((m) => m.id)).toEqual(["well"]);
  expect(remapStairLevels(well({ edges: [{ from: "ground", to: "upper" }], arrivals: [{ levelId: "upper", x: 1, y: 2 }] }), (id) => `${id}-copy`)).toMatchObject({
    levels: ["cellar-copy", "ground-copy", "upper-copy"], edges: [{ from: "ground-copy", to: "upper-copy" }], arrivals: [{ levelId: "upper-copy" }] });
  const plan = planDuplicateSceneOps({ scene: s, id: "tower-copy" });
  if (!plan.ok) throw new Error(plan.error);
  expect(sceneLevelsError(plan.copy)).toBeNull();
  const copied = plan.copy.regions?.[0]?.stairs as StairBehaviorV2;
  expect(copied.levels.every((id) => plan.copy.levels?.some((l) => l._id === id))).toBe(true);
  expect(copied.levels).not.toContain("ground");
  const create: Op = { kind: "create", coll: "regions", parent, data: region("w2", well()) };
  expect(opsNeedStairsV2([create])).toBe(true);
  expect(requiredOpFeatures([create])).toContain(STAIRS_V2_FEATURE);
  expect(opsNeedStairsV2([{ kind: "create", coll: "regions", parent, data: region("w3", { from: "ground", to: "upper" }) }])).toBe(false);
  expect(opsNeedStairsV2([{ kind: "update", ref: { coll: "regions", id: "well", parent }, diff: { "stairs.locked": true } }])).toBe(true);
  expect(opsNeedStairsV2([{ kind: "update", ref: { coll: "regions", id: "well", parent }, diff: { "-=stairs": null } }])).toBe(false);
  expect(requiredWorldFeatures([s], "GM")).toContain(STAIRS_V2_FEATURE);
  expect(requiredWorldFeatures([s], "PLAYER")).not.toContain(STAIRS_V2_FEATURE);
});

test("new tokens land on a floor; player-made drawings, templates and notes belong to the floor being viewed", () => {
  const s = scene({ tokens: [token("hero", { flags: { prefab: { instanceId: "p", rootId: "hero" } }, levelId: "upper", elevation: 12 })] });
  const create = (data: Partial<TokenDocument>): Op => ({ kind: "create", coll: "tokens", parent, data: token(data._id ?? "new", data) });
  const strip = (op: Op) => { if (op.kind === "create" && !Object.hasOwn(op.data, "keepLevel")) delete (op.data as Partial<TokenDocument>).levelId; return op; };
  const stamped = (ops: Op[], preferred: string | null = null) => levelCreationOps(ops, () => s, () => preferred).map((op) => op.kind === "create" ? op.data : null);
  expect(stamped([strip(create({ elevation: 0 }))])[0]).toMatchObject({ levelId: "ground", elevation: 0 }); // band
  expect(stamped([strip(create({ elevation: 0 }))], "upper")[0]).toMatchObject({ levelId: "upper", elevation: 10 }); // viewed floor, feet moved into band
  expect(stamped([strip(create({ elevation: 500 }))])[0]).toMatchObject({ levelId: "cellar", elevation: -10 }); // lowest floor
  expect(stamped([strip(create({ flags: { prefab: { instanceId: "p", rootId: "hero", parentId: "hero" } } }))], "cellar")[0]).toMatchObject({ levelId: "upper" }); // prefab parent wins
  expect(stamped([create({ levelId: "cellar", elevation: -5 })], "upper")[0]).toMatchObject({ levelId: "cellar", elevation: -5 }); // explicit untouched
  const { levelMode: _mode, ...flat } = s; void _mode;
  expect(levelCreationOps([strip(create({}))], () => flat)).toEqual([strip(create({}))]); // only isolated scenes
  const drawing = { _id: "d", type: "drawing", name: "d", ownership: { default: 0 }, flags: {}, system: {}, kind: "rect", points: [], box: [0, 0, 10, 10], stroke: "#fff", fill: "", strokeWidth: 1, text: null } as DrawingDocument;
  expect(stamped([{ kind: "create", coll: "drawings", parent, data: drawing }], "upper")[0]).toMatchObject({ levelScope: { mode: "levels", ids: ["upper"] } });
  expect(stamped([{ kind: "create", coll: "drawings", parent, data: drawing }])[0]).not.toHaveProperty("levelScope");
});

test("presentation objects: unscoped show on every floor, scoped only on theirs; bindings and validation include them", () => {
  const note = (id: string, scope?: NoteDocument["levelScope"]): NoteDocument => ({ _id: id, type: "note", name: id, ownership: { default: 2 }, flags: {}, system: {}, x: 1, y: 1, text: "", icon: "", ...(scope ? { levelScope: scope } : {}) } as NoteDocument);
  const template = (id: string, scope?: TemplateDocument["levelScope"]): TemplateDocument => ({ _id: id, type: "template", name: id, ownership: { default: 2 }, flags: {}, system: {}, kind: "circle", x: 1, y: 1, distance: 10, direction: 0, width: 0, ...(scope ? { levelScope: scope } : {}) });
  const s = scene({ notes: [note("legacy"), note("upstairs", { mode: "levels", ids: ["upper"] }), note("everywhere", { mode: "all" })],
    templates: [template("blast", { mode: "levels", ids: ["ground"] })], regions: [region("well", well()), region("roof", undefined, { levelScope: { mode: "levels", ids: ["upper"] }, hidden: false, ownership: { default: 2 } })] });
  expect(sceneLevelsError(s)).toBeNull();
  const ground = floorPresentation(s, s.levels?.[1] as LevelDocument);
  expect(ground.offFloor).toEqual({ regions: ["roof"], drawings: [], templates: [], notes: ["upstairs"] });
  const view = { isolated: true, levelId: "ground", tokenIds: ["hero"], presentation: ground };
  const rendered = floorScene(s, view);
  expect(rendered.notes.map((n) => n._id)).toEqual(["legacy", "everywhere"]);
  expect(rendered.templates.map((t) => t._id)).toEqual(["blast"]);
  expect(rendered.regions?.map((r) => r._id)).toEqual([]); // stairs never ride the presentation regions; roof is upstairs
  const { offFloor: _off, ...olderHost } = ground; void _off;
  expect(floorScene(s, { ...view, presentation: olderHost }).notes).toEqual([]); // older host: hidden as before
  const upper = floorScene(s, { ...view, levelId: "upper", presentation: floorPresentation(s, s.levels?.[2] as LevelDocument) });
  expect(upper.notes.map((n) => n._id)).toEqual(["legacy", "upstairs", "everywhere"]);
  expect(upper.regions?.map((r) => r._id)).toEqual(["roof"]);
  expect(levelBindings(s, "upper")).toMatchObject({ notes: ["upstairs"], regions: ["roof"], templates: [] });
  expect(sceneMembershipError({ ...s, notes: [note("bad", { mode: "levels", ids: ["attic"] })] })).not.toBeNull();
  expect(sceneLevelsError({ ...s, levels: undefined, levelMode: undefined, regions: [], notes: [note("orphan", { mode: "all" })] })).toMatch(/explicit draft level/);
  // A player only learns IDs they could already read.
  const secret = { ...s, notes: [...s.notes, { ...note("gm-only", { mode: "levels", ids: ["upper"] }), visible: false }] };
  const focus = levelFocusView(secret, [], { id: "p1", role: "PLAYER" }, null);
  expect(focus.presentation).toBeUndefined(); // no owned token: no floor at all
  const owned = { ...secret, ownership: { default: 2 as const }, tokens: [token("hero", { ownership: { default: 0, p1: 3 } })] };
  expect(levelFocusView(owned, [], { id: "p1", role: "PLAYER" }, null).presentation?.offFloor?.notes).toEqual(["upstairs"]);
});

test("host: a player in a three-floor stairwell gets a private choice, the host revalidates it, and undo never re-offers", async () => {
  const { hostApp, playerApp, share, pump } = await joinHostPlayer();
  try {
    const player = playerApp.client; if (!player?.user) throw new Error("join");
    const original = hostApp.store.get("scenes", DEFAULT_SCENE_ID); if (!original) throw new Error("scene");
    const configured = { ...original, levelMode: "isolated" as const, levels: levels(), regions: [region("well", well({ label: "Spiral stair" }))],
      tokens: [token("hero", { ownership: { default: 0, [player.user.id]: 3 } })] };
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: parent, diff: JSON.parse(JSON.stringify(configured)) }]);
    player.requestLevelFocus(DEFAULT_SCENE_ID, null); await settle(6);
    expect(player.supportsFeature(STAIRS_V2_FEATURE)).toBe(true);
    expect(player.levelFocus?.presentation?.stairs).toEqual([{ id: "well", points: [100, 0, 200, 0, 200, 100, 100, 100], label: "Spiral stair", up: true, down: true, locked: false }]);
    const offers: StairOfferMsg[] = [], gmOffers: StairOfferMsg[] = [];
    playerApp.bus.on("stairOffer", (offer) => offers.push(offer));
    hostApp.gm.bus.on("stairOffer", (offer) => gmOffers.push(offer));
    await player.submitAndWait([move(150)]); await settle(6);
    const token0 = () => hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "hero");
    expect(token0()).toMatchObject({ x: 150, levelId: "ground", elevation: 0 });
    expect(offers).toHaveLength(1); expect(gmOffers).toHaveLength(0); // only the mover is asked
    const offer = offers[0] as StairOfferMsg;
    expect(offer).toMatchObject({ status: "open", tokenId: "hero", label: "Spiral stair", choices: [{ levelId: "upper", direction: "up" }, { levelId: "cellar", direction: "down" }] });
    // A forged offer and somebody else's offer are refused without touching the token.
    player.chooseStair("forged-offer", "upper"); await settle(6);
    expect(offers.at(-1)).toMatchObject({ offerId: "forged-offer", status: "ended", error: "That stair choice is no longer available" });
    hostApp.gm.client.chooseStair(offer.offerId, "upper"); await settle(6);
    expect(gmOffers.at(-1)).toMatchObject({ status: "ended", error: "That stair choice is no longer available" });
    expect(token0()?.levelId).toBe("ground");
    player.chooseStair(offer.offerId, "cellar"); await settle(8);
    expect(token0()).toMatchObject({ x: 150, levelId: "cellar", elevation: -10 });
    expect(offers.at(-1)).toMatchObject({ offerId: offer.offerId, status: "ended" }); expect(offers.at(-1)?.error).toBeUndefined();
    expect(player.levelFocus?.levelId).toBe("cellar");
    const count = offers.length;
    expect(hostApp.host.undo().ok).toBe(true); await settle(6);
    expect(token0()).toMatchObject({ levelId: "ground" });
    expect(offers.length).toBe(count); // undo restores state without a new prompt
    // "Take stairs" while standing in the stairwell, then stay; walking out withdraws an open offer.
    player.requestStairs(DEFAULT_SCENE_ID, "hero"); await settle(6);
    const again = offers.at(-1) as StairOfferMsg;
    expect(again).toMatchObject({ status: "open", choices: [{ levelId: "upper" }, { levelId: "cellar" }] });
    player.chooseStair(again.offerId, null); await settle(6);
    expect(offers.at(-1)).toMatchObject({ offerId: again.offerId, status: "ended" }); expect(token0()?.levelId).toBe("ground");
    player.requestStairs(DEFAULT_SCENE_ID, "hero"); await settle(6);
    const third = offers.at(-1) as StairOfferMsg;
    await player.submitAndWait([move(300)]); await settle(6);
    expect(offers.at(-1)).toMatchObject({ offerId: third.offerId, status: "ended" });
    player.requestStairs(DEFAULT_SCENE_ID, "hero"); await settle(6);
    expect(offers.at(-1)).toMatchObject({ status: "none", choices: [] });
    player.requestStairs(DEFAULT_SCENE_ID, "not-a-token"); await settle(6);
    expect(offers.at(-1)).toMatchObject({ status: "none" });
    // The GM moving an NPC through the same stairwell is asked privately (players are not).
    const before = offers.length;
    await hostApp.gm.client.submitAndWait([{ kind: "create", coll: "tokens", parent, data: token("guard", { x: 50, y: 300 }) }]);
    await hostApp.gm.client.submitAndWait([move(150, 60, "guard")]); await settle(6);
    const gmOffer = gmOffers.at(-1) as StairOfferMsg;
    expect(gmOffer).toMatchObject({ status: "open", tokenId: "guard", choices: [{ levelId: "upper" }, { levelId: "cellar" }] });
    expect(offers.length).toBe(before);
    hostApp.gm.client.chooseStair(gmOffer.offerId, "upper"); await settle(8);
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "guard")).toMatchObject({ levelId: "upper", elevation: 10, x: 150, y: 60 });
    expect(hostApp.host.undo().ok).toBe(true); await settle(6); // one step restores floor and elevation together
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "guard")).toMatchObject({ levelId: "ground", elevation: 0 });
    // Locked stairs explain themselves instead of silently doing nothing.
    await hostApp.gm.client.submitAndWait([{ kind: "update", ref: { coll: "regions", id: "well", parent }, diff: { "stairs.locked": true } }]);
    await player.submitAndWait([move(150)]); await settle(6);
    expect(offers.at(-1)).toMatchObject({ status: "locked", choices: [] }); expect(token0()).toMatchObject({ x: 150, levelId: "ground" });
    // A token created without a floor lands on one (here: the band containing its feet).
    const { levelId: _omit, ...npc } = token("npc", { elevation: 0 }); void _omit; // absent, not null: msgpack turns undefined into null
    await hostApp.gm.client.submitAndWait([{ kind: "create", coll: "tokens", parent, data: npc as TokenDocument }]);
    expect(hostApp.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.find((t) => t._id === "npc")).toMatchObject({ levelId: "ground", elevation: 0 });
  } finally { pump.stop(); playerApp.close(); share.close(); await hostApp.close(); const db = await openVttDb(); await deleteWorldData(db, hostApp.worldId); db.close(); }
});
