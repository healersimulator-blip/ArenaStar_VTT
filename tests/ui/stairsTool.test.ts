/** G-14 (D-450): the Stairs tool drags out a grid-snapped area and hands it to the shell. */
import { expect, test } from "vitest";
import { DEFAULT_TOOL_OPTIONS, ToolInteractionController, type ShapePreview } from "../../src/canvas/tools/controller";

function harness(grid: { type: "square" | "gridless"; size: number } | null) {
  const areas: Array<{ x: number; y: number; width: number; height: number }> = [];
  const previews: Array<ShapePreview | null> = [];
  const tool = new ToolInteractionController({
    nextId: () => "id", userId: "gm", grid: () => (grid ? { ...grid, diagonals: "555" } : null), options: () => DEFAULT_TOOL_OPTIONS,
    createDrawing: () => {}, createWall: () => {}, createLight: () => undefined, createNote: () => {}, promptText: () => {},
    measurePreview: () => {}, shapePreview: (p) => previews.push(p), broadcastMeasure: () => {}, fogPaint: () => {},
    createStairs: (area) => areas.push(area),
  });
  tool.activate("stairs");
  return { tool, areas, previews };
}

test("a drag snaps to grid corners, previews the area, and creates stairs in any direction", () => {
  const { tool, areas, previews } = harness({ type: "square", size: 100 });
  tool.pointerDown({ world: { x: 512, y: 288 }, button: 0 });
  tool.pointerMove({ world: { x: 290, y: 515 }, button: 0 });
  expect(previews.at(-1)).toEqual({ kind: "stairs", from: { x: 500, y: 300 }, to: { x: 300, y: 500 } });
  tool.pointerUp({ world: { x: 290, y: 515 }, button: 0 });
  expect(areas).toEqual([{ x: 300, y: 300, width: 200, height: 200 }]);
  expect(previews.at(-1)).toBeNull();
});

test("a click (or a drag inside one grid corner) makes nothing; Escape drops a drag; gridless maps use the pointer", () => {
  const snapped = harness({ type: "square", size: 100 });
  snapped.tool.pointerDown({ world: { x: 210, y: 210 }, button: 0 });
  snapped.tool.pointerUp({ world: { x: 230, y: 240 }, button: 0 });
  snapped.tool.pointerDown({ world: { x: 200, y: 200 }, button: 0 });
  snapped.tool.pointerMove({ world: { x: 400, y: 400 }, button: 0 });
  snapped.tool.dismissGesture();
  snapped.tool.pointerUp({ world: { x: 400, y: 400 }, button: 0 });
  expect(snapped.areas).toEqual([]);

  const free = harness({ type: "gridless", size: 100 });
  free.tool.pointerDown({ world: { x: 10, y: 20 }, button: 0 });
  free.tool.pointerUp({ world: { x: 75, y: 95 }, button: 0 });
  expect(free.areas).toEqual([{ x: 10, y: 20, width: 65, height: 75 }]);
});

test("D-453: the Raised area tool drags the same snapped rectangle and hands it to its own callback", () => {
  const raised: Array<{ x: number; y: number; width: number; height: number }> = [];
  const stairs: typeof raised = [];
  const previews: Array<ShapePreview | null> = [];
  const tool = new ToolInteractionController({
    nextId: () => "id", userId: "gm", grid: () => ({ type: "square", size: 100, diagonals: "555" }), options: () => DEFAULT_TOOL_OPTIONS,
    createDrawing: () => {}, createWall: () => {}, createLight: () => undefined, createNote: () => {}, promptText: () => {},
    measurePreview: () => {}, shapePreview: (p) => previews.push(p), broadcastMeasure: () => {}, fogPaint: () => {},
    createStairs: (area) => stairs.push(area), createRaised: (area) => raised.push(area),
  });
  tool.activate("raised");
  tool.pointerDown({ world: { x: 610, y: 1390 }, button: 0 });
  tool.pointerMove({ world: { x: 790, y: 1610 }, button: 0 });
  expect(previews.at(-1)).toEqual({ kind: "raised", from: { x: 600, y: 1400 }, to: { x: 800, y: 1600 } });
  tool.pointerUp({ world: { x: 790, y: 1610 }, button: 0 });
  expect(raised).toEqual([{ x: 600, y: 1400, width: 200, height: 200 }]);
  expect(stairs).toEqual([]);
  expect(DEFAULT_TOOL_OPTIONS).toMatchObject({ raisedHeight: 5, raisedSolid: true });
});
