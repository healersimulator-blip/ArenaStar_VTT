import { expect, test } from "vitest";
import type { WallDocument } from "../../src/core/documents";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import { DEFAULT_TOOL_OPTIONS, ToolInteractionController, type ShapePreview, type ToolOptions } from "../../src/canvas/tools/controller";
import { guardedWallEditError, type WallEditPlan } from "../../src/core/wallEditing";

function harness() {
  const wall = (id: string, c: WallDocument["c"]): WallDocument => ({ _id: id, type: "wall", name: id, flags: {}, system: {}, ownership: { default: 0 }, ...wallFieldsFor("wall", c) });
  const walls = [wall("a", [0, 0, 100, 0]), wall("b", [100, 0, 100, 100])];
  let sceneId = "scene", scale = 1, nextId = 0;
  const plans: WallEditPlan[] = [], errors: string[] = [], previews: Array<ShapePreview | null> = [], created: unknown[] = [];
  const options: ToolOptions = { ...DEFAULT_TOOL_OPTIONS, placementSnap: "none", wallEditMode: "corner" };
  const tool = new ToolInteractionController({
    nextId: () => `fresh-${++nextId}`, userId: "gm", grid: () => null, options: () => options,
    createDrawing: () => {}, createWall: (wall) => created.push(wall), createLight: () => undefined, createNote: () => {}, promptText: () => {},
    measurePreview: () => {}, shapePreview: (preview) => previews.push(preview), broadcastMeasure: () => {}, fogPaint: () => {},
    wallEditing: { context: () => ({ sceneId, scale, walls }), commit: (plan) => plans.push(plan), error: (message) => errors.push(message) },
  });
  tool.activate("wall");
  const event = (x: number, y: number, ctrlKey = false) => ({ world: { x, y }, button: 0, ctrlKey });
  return { tool, walls, options, plans, errors, previews, created, event,
    changeScene: () => { sceneId = "other"; }, zoom: (value: number) => { scale = value; } };
}
test("joined-corner drag previews both walls without mutation; release submits one plan", () => {
  const h = harness(), original = structuredClone(h.walls);
  h.tool.pointerDown(h.event(100, 0));
  h.tool.pointerMove(h.event(150, 40));
  expect(h.walls).toEqual(original);
  expect(h.plans).toHaveLength(0);
  expect(h.previews.at(-1)).toMatchObject({ kind: "wallEdit", walls: [{ c: [0, 0, 150, 40] }, { c: [150, 40, 100, 100] }] });
  h.tool.pointerUp(h.event(150, 40));
  expect(h.plans).toHaveLength(1);
  expect(h.plans[0]?.ops).toHaveLength(2);
  expect(h.previews.at(-1)).toBeNull();
  expect(h.created).toHaveLength(0);
});
test("cancel, Escape, mode change and scene change discard rather than commit", () => {
  for (const stop of ["cancel", "escape", "mode", "scene"] as const) {
    const h = harness();
    h.tool.pointerDown(h.event(100, 0)); h.tool.pointerMove(h.event(150, 40));
    if (stop === "cancel") h.tool.cancel();
    else if (stop === "escape") h.tool.dismissGesture();
    else if (stop === "mode") h.tool.activate("light");
    else h.changeScene();
    h.tool.pointerUp(h.event(150, 40));
    expect(h.plans).toHaveLength(0);
    expect(h.previews.at(-1)).toBeNull();
  }
});
test("clicking an endpoint never grid-snaps or moves it; non-left releases never commit", () => {
  const h = harness();
  h.tool.pointerDown(h.event(101, 1)); h.tool.pointerUp(h.event(101, 1));
  expect(h.plans).toHaveLength(0);
  h.tool.pointerDown(h.event(100, 0)); h.tool.pointerUp({ ...h.event(150, 40), button: 2 });
  expect(h.plans).toHaveLength(0); h.tool.cancel();
});
test("separate endpoint mode moves only the selected member and keeps the other end fixed", () => {
  const h = harness(); h.options.wallMoveJoined = false;
  h.tool.pointerDown(h.event(100, 0)); h.tool.pointerUp(h.event(130, 40));
  expect(h.plans[0]?.ops).toHaveLength(1);
  expect(h.plans[0]?.preview[0]?.c).toEqual([0, 0, 130, 40]);
});
test("invalid collapse leaves all walls unchanged and surfaces an error", () => {
  const h = harness(), before = structuredClone(h.walls);
  h.tool.pointerDown(h.event(100, 0)); h.tool.pointerUp(h.event(0, 0));
  expect(h.plans).toHaveLength(0); expect(h.errors.at(-1)).toContain("collapse"); expect(h.walls).toEqual(before);
});
test("split is a click, not a drag; its preview never writes", () => {
  const h = harness(); h.options.wallEditMode = "split";
  h.tool.pointerDown(h.event(50, 2));
  expect(h.previews.at(-1)).toMatchObject({ kind: "wallEdit" }); expect(h.plans).toHaveLength(0);
  h.tool.pointerUp(h.event(50, 2));
  expect(h.plans[0]?.ops.map((op) => op.kind)).toEqual(["update", "create"]);
  h.tool.pointerDown(h.event(70, 0)); h.tool.pointerUp(h.event(85, 0));
  expect(h.plans).toHaveLength(1);
});
test("the submitted plan retains its initial wall revision even after remote changes", () => {
  const h = harness(); h.tool.pointerDown(h.event(100, 0));
  const b = h.walls[1]; if (!b) throw new Error("fixture"); b.c = [100, 0, 120, 100];
  h.tool.pointerUp(h.event(150, 20));
  const plan = h.plans[0]; if (!plan) throw new Error("missing plan");
  expect(guardedWallEditError(plan.guard, { _id: "scene", walls: h.walls }, plan.ops)).toContain("changed");
});
test("drawing snaps to existing endpoints in CSS pixels; Ctrl and checkbox bypass it", () => {
  for (const disable of ["none", "ctrl", "checkbox"] as const) {
    const h = harness(); h.options.wallEditMode = "draw";
    if (disable === "checkbox") h.options.wallEndpointSnap = false;
    h.tool.pointerDown(h.event(103, 3, disable === "ctrl"));
    h.tool.pointerUp(h.event(200, 50, disable === "ctrl"));
    expect(h.created[0]).toMatchObject({ c: disable === "none" ? [100, 0, 200, 50] : [103, 3, 200, 50] });
  }
});
test("Alt wall erasing never begins a placement or submits a stray short segment", () => {
  const h = harness(); h.options.wallEditMode = "draw";
  h.tool.pointerDown({ ...h.event(50, 0), altKey: true }); h.tool.pointerUp({ ...h.event(60, 0), altKey: true });
  expect(h.created).toHaveLength(0);
});
