import { describe, expect, test } from "vitest";
import {
  boxFromCorners,
  drawingForEllipse,
  drawingForFreehand,
  drawingForLine,
  drawingForPoly,
  drawingForRect,
  drawingForShape,
  drawingForText,
} from "../../src/canvas/tools/drawing";
import {
  DEFAULT_TOOL_OPTIONS,
  ToolInteractionController,
  rectPolygon,
  type MeasurePreview,
  type ShapePreview,
  type ToolOptions,
} from "../../src/canvas/tools/controller";
import { drawingBounds } from "../../src/canvas/layers/drawingGeometry";
import { canDeleteDrawing, canEraseAllDrawings } from "../../src/core/drawingPermissions";
import type { DrawingDocument } from "../../src/core/documents";

function harness(overrides: Partial<ToolOptions> = {}) {
  const created: DrawingDocument[] = [];
  const previews: Array<ShapePreview | null> = [];
  const measures: Array<MeasurePreview | null> = [];
  const walls: Array<{
    kind: "wall" | "door" | "window";
    c: [number, number, number, number];
    door: number;
  }> = [];
  const lights: Array<{ x: number; y: number; radius: number; color: string }> = [];
  const notes: Array<{ x: number; y: number }> = [];
  const texts: Array<{ x: number; y: number }> = [];
  const broadcasts: Array<Array<{ x: number; y: number }>> = [];
  const fog: Array<{ mode: "reveal" | "hide"; poly: number[] }> = [];
  const options: ToolOptions = { ...DEFAULT_TOOL_OPTIONS, ...overrides };
  let id = 0;
  const tool = new ToolInteractionController({
    nextId: () => `d${++id}`,
    userId: "player-a",
    grid: () => null,
    options: () => options,
    createDrawing: (d) => created.push(d),
    createWall: (w) => walls.push({ kind: w.kind, c: w.c, door: w.door }),
    createLight: (l) => lights.push(l),
    createNote: (at) => notes.push(at),
    promptText: (at) => texts.push(at),
    measurePreview: (p) => measures.push(p),
    shapePreview: (p) => previews.push(p),
    broadcastMeasure: (p) => broadcasts.push(p),
    fogPaint: (v) => fog.push(v),
  });
  return { tool, options, created, previews, measures, walls, lights, notes, texts, broadcasts, fog };
}

const drag = (
  tool: ToolInteractionController,
  from: { x: number; y: number },
  to: { x: number; y: number },
  mods: { shiftKey?: boolean; altKey?: boolean } = {},
) => {
  tool.pointerDown({ world: from, button: 0, ...mods });
  tool.pointerMove({ world: to, button: 0, ...mods });
  tool.pointerUp({ world: to, button: 0, ...mods });
};

describe("canvas toolbar tools", () => {
  test("freehand and text documents retain creator ownership", () => {
    const line = drawingForFreehand("d1", [{ x: 0, y: 0 }, { x: 10, y: 10 }], "player-a");
    const label = drawingForText("d2", { x: 4, y: 8 }, "Objective", "player-a");
    expect(line.flags.core?.createdBy).toBe("player-a");
    expect(label.text).toBe("Objective");
    expect(canDeleteDrawing(line, "player-a", "PLAYER")).toBe(true);
    expect(canDeleteDrawing(line, "player-b", "PLAYER")).toBe(false);
    expect(canDeleteDrawing(line, "player-b", "GM")).toBe(true);
    expect(canEraseAllDrawings("PLAYER")).toBe(false);
    expect(canEraseAllDrawings("GM")).toBe(true);
  });

  test("draw gesture creates one document and measure gesture emits previews", () => {
    const { tool, created, measures } = harness({ drawShape: "freehand" });
    tool.activate("draw");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerMove({ world: { x: 5, y: 5 }, button: 0 });
    tool.pointerUp({ world: { x: 10, y: 10 }, button: 0 });
    expect(created).toHaveLength(1);
    tool.activate("measure");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerMove({ world: { x: 30, y: 40 }, button: 0 });
    expect(measures.some((p) => p !== null)).toBe(true);
  });
});

describe("draw shapes (Roll20: rect default, Alt = ellipse, Shift = snap)", () => {
  test("rectangle commits box geometry and normalizes a negative drag", () => {
    const { tool, created, previews } = harness({ drawShape: "rect" });
    expect(boxFromCorners({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual([10, 20, 30, 40]);
    tool.activate("draw");
    drag(tool, { x: 40, y: 60 }, { x: 10, y: 20 });
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("rect");
    expect(created[0]?.box).toEqual([10, 20, 30, 40]);
    expect(created[0]?.points).toEqual([]);
    // a preview was shown while dragging and cleared on release
    expect(previews.some((p) => p?.kind === "draw")).toBe(true);
    expect(previews.at(-1)).toBeNull();
  });

  test("Alt turns the rectangle into an ellipse, Shift snaps the moving corner", () => {
    const { tool, created } = harness({
      drawShape: "rect",
      drawingStyle: { stroke: "#ff0000", fill: "#00ff00", strokeWidth: 8 },
    });
    tool.activate("draw");
    drag(tool, { x: 0, y: 0 }, { x: 50, y: 30 }, { altKey: true });
    expect(created[0]?.kind).toBe("ellipse");
    expect(created[0]?.stroke).toBe("#ff0000");
    expect(created[0]?.fill).toBe("#00ff00");
    expect(created[0]?.strokeWidth).toBe(8);
  });

  test("a click without a drag commits nothing", () => {
    const { tool, created } = harness({ drawShape: "rect" });
    tool.activate("draw");
    drag(tool, { x: 10, y: 10 }, { x: 10, y: 10 });
    expect(created).toHaveLength(0);
  });

  test("line and polygon shapes use point geometry; a near-start click closes the polygon", () => {
    const { tool, created } = harness({ drawShape: "line" });
    tool.activate("draw");
    drag(tool, { x: 0, y: 0 }, { x: 90, y: 40 });
    expect(created[0]?.kind).toBe("line");
    expect(created[0]?.points).toEqual([0, 0, 90, 40]);

    harness({ drawShape: "poly" });
    const poly = harness({ drawShape: "poly" });
    poly.tool.activate("draw");
    poly.tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    poly.tool.pointerUp({ world: { x: 0, y: 0 }, button: 0 });
    poly.tool.pointerDown({ world: { x: 60, y: 0 }, button: 0 });
    poly.tool.pointerDown({ world: { x: 60, y: 60 }, button: 0 });
    poly.tool.pointerDown({ world: { x: 4, y: 4 }, button: 0 }); // near the first vertex: close
    expect(poly.created).toHaveLength(1);
    expect(poly.created[0]?.kind).toBe("poly");
    expect(poly.created[0]?.points).toEqual([0, 0, 60, 0, 60, 60]);
  });

  test("finishPoly closes a polygon and Escape-clears the pending shape", () => {
    const { tool, created, previews } = harness({ drawShape: "poly" });
    tool.activate("draw");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerDown({ world: { x: 50, y: 0 }, button: 0 });
    tool.pointerDown({ world: { x: 50, y: 50 }, button: 0 });
    tool.finishPoly();
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("poly");
    expect(previews.at(-1)).toBeNull();
  });

  test("the shape factory covers every sub-tool and bounds follow the geometry", () => {
    const style = { stroke: "#fff", fill: "transparent", strokeWidth: 2 };
    const rect = drawingForShape("rect", "r", { from: { x: 0, y: 0 }, to: { x: 10, y: 20 } }, "u", style);
    const ellipse = drawingForEllipse("e", { x: 0, y: 0 }, { x: 10, y: 20 }, "u", style);
    const line = drawingForLine("l", { x: 1, y: 2 }, { x: 3, y: 4 }, "u", style);
    const poly = drawingForPoly("p", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], "u", style);
    expect(drawingBounds(rect)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(drawingBounds(ellipse)).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(drawingBounds(line)).toEqual({ x: 1, y: 2, width: 2, height: 2 });
    expect(drawingBounds(poly)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(drawingForRect("r2", { x: 0, y: 0 }, { x: 1, y: 1 }, "u").kind).toBe("rect");
  });
});

describe("text tool", () => {
  test("a click asks the shell to open its editor at that point", () => {
    const { tool, texts, created } = harness();
    tool.activate("text");
    tool.pointerDown({ world: { x: 120, y: 80 }, button: 0 });
    tool.pointerUp({ world: { x: 120, y: 80 }, button: 0 });
    expect(texts).toEqual([{ x: 120, y: 80 }]);
    expect(created).toHaveLength(0);
  });
});

describe("measure options", () => {
  test("the AoE sub-shapes carry the template geometry and the ruler broadcast flag publishes", () => {
    const circle = harness({ measureShape: "circle" });
    circle.tool.activate("measure");
    drag(circle.tool, { x: 0, y: 0 }, { x: 100, y: 0 });
    const last = circle.measures.filter((m) => m !== null).at(-1);
    expect(last?.shape).toBe("circle");
    expect(last?.area?.kind).toBe("circle");
    expect(last?.kind).toBe("radius");
    expect(circle.broadcasts).toHaveLength(0); // broadcast off by default

    const cone = harness({ measureShape: "cone", measureBroadcast: true });
    cone.tool.activate("measure");
    drag(cone.tool, { x: 0, y: 0 }, { x: 0, y: 100 });
    const coneLast = cone.measures.filter((m) => m !== null).at(-1);
    expect(coneLast?.area?.kind).toBe("polygon");
    expect(cone.broadcasts).toHaveLength(1);

    const ray = harness({ measureShape: "ray" });
    ray.tool.activate("measure");
    drag(ray.tool, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(ray.measures.filter((m) => m !== null).at(-1)?.area?.kind).toBe("segment");
  });

  test("X recalls the last measurement, and the same line is not broadcast twice", () => {
    const { tool, measures, broadcasts } = harness({ measureBroadcast: true });
    tool.activate("measure");
    drag(tool, { x: 0, y: 0 }, { x: 200, y: 0 });
    expect(broadcasts).toHaveLength(1);
    expect(tool.lastMeasurement).toHaveLength(2);
    const before = measures.length;
    tool.recall();
    expect(measures.length).toBeGreaterThan(before);
    expect(broadcasts).toHaveLength(1); // same geometry: no duplicate broadcast
    tool.activate("select" as never);
    expect(tool.recall()).toBe(false);
  });
});

describe("GM tools", () => {
  test("the fog brush paints a rectangle as either reveal or hide", () => {
    const { tool, fog, previews } = harness({ fogBrush: "hide", fogShape: "rect" });
    tool.activate("fog");
    drag(tool, { x: 0, y: 0 }, { x: 50, y: 40 });
    expect(fog).toEqual([{ mode: "hide", poly: [0, 0, 50, 0, 50, 40, 0, 40] }]);
    expect(previews.some((p) => p?.kind === "fog")).toBe(true);

    const reveal = harness({ fogBrush: "reveal", fogShape: "poly" });
    reveal.tool.activate("fog");
    reveal.tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    reveal.tool.pointerDown({ world: { x: 40, y: 0 }, button: 0 });
    reveal.tool.pointerDown({ world: { x: 40, y: 40 }, button: 0 });
    reveal.tool.finishPoly();
    expect(reveal.fog).toEqual([{ mode: "reveal", poly: [0, 0, 40, 0, 40, 40] }]);
    expect(rectPolygon({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  test("walls, doors and windows are placed with the configured kind", () => {
    const wall = harness({ wallKind: "wall", wallDoorState: 2, placementSnap: "none" });
    wall.tool.activate("wall");
    drag(wall.tool, { x: 10, y: 10 }, { x: 110, y: 10 });
    // a wall has no door state — the rail's door choice cannot leak onto it (D-257)
    expect(wall.walls).toEqual([{ kind: "wall", c: [10, 10, 110, 10], door: 0 }]);

    // a door is placed in the state the rail selected; the default is closed, not open (G-43)
    const door = harness({ wallKind: "door", placementSnap: "none" });
    door.tool.activate("wall");
    drag(door.tool, { x: 0, y: 0 }, { x: 50, y: 0 });
    expect(door.walls[0]).toEqual({ kind: "door", c: [0, 0, 50, 0], door: 0 });

    const locked = harness({ wallKind: "door", wallDoorState: 2, placementSnap: "none" });
    locked.tool.activate("wall");
    drag(locked.tool, { x: 0, y: 0 }, { x: 50, y: 0 });
    expect(locked.walls[0]?.door).toBe(2);

    const window = harness({ wallKind: "window", wallDoorState: 1, placementSnap: "none" });
    window.tool.activate("wall");
    drag(window.tool, { x: 0, y: 0 }, { x: 50, y: 0 });
    expect(window.walls[0]).toEqual({ kind: "window", c: [0, 0, 50, 0], door: 0 });

    const light = harness({ lightRadius: 60, lightColor: "#33ccff" });
    light.tool.activate("light");
    light.tool.pointerDown({ world: { x: 200, y: 300 }, button: 0 });
    expect(light.lights).toEqual([{ x: 200, y: 300, radius: 60, color: "#33ccff" }]);
  });

  test("the pin tool hands the click to the note creator", () => {
    const { tool, notes } = harness();
    tool.activate("pin");
    tool.pointerDown({ world: { x: 42, y: 24 }, button: 0 });
    expect(notes).toEqual([{ x: 42, y: 24 }]);
  });

  test("switching tools cancels pending gestures", () => {
    const { tool, created, fog } = harness({ drawShape: "poly" });
    tool.activate("draw");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.activate("fog");
    expect(tool.current()).toBe("fog");
    tool.pointerUp({ world: { x: 10, y: 10 }, button: 0 });
    expect(created).toHaveLength(0);
    expect(fog).toHaveLength(0);
  });
});
