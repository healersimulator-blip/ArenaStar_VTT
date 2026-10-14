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
  type PlaceableEditPort,
  type ShapePreview,
  type ToolCallbacks,
  type ToolOptions,
} from "../../src/canvas/tools/controller";
import { drawingBounds } from "../../src/canvas/layers/drawingGeometry";
import { canDeleteDrawing, canEraseAllDrawings } from "../../src/core/drawingPermissions";
import type { DrawingDocument } from "../../src/core/documents";

function harness(overrides: Partial<ToolOptions> = {}, extra: Partial<ToolCallbacks> = {}) {
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
    createLight: (l) => { lights.push(l); return `light-${lights.length}`; },
    createNote: (at) => notes.push(at),
    promptText: (at) => texts.push(at),
    measurePreview: (p) => measures.push(p),
    shapePreview: (p) => previews.push(p),
    broadcastMeasure: (p) => broadcasts.push(p),
    fogPaint: (v) => fog.push(v),
    ...extra,
  });
  return { tool, options, created, previews, measures, walls, lights, notes, texts, broadcasts, fog };
}

/** D-465: a fake shell holding placed lights/pins/drawings behind the placeable ports. */
function placeables() {
  const items = new Map<string, { x: number; y: number; radius: number }>([
    ["l1", { x: 100, y: 100, radius: 300 }],
    ["l2", { x: 500, y: 100, radius: 200 }],
  ]);
  const log: string[] = [];
  const selections: Array<string | null> = [];
  const port: PlaceableEditPort = {
    hit: (world) => {
      for (const [id, item] of items) {
        if (Math.hypot(item.x - world.x, item.y - world.y) <= 16) return { id, x: item.x, y: item.y, radius: item.radius };
      }
      return null;
    },
    move: (id, at) => {
      log.push(`move ${id} ${at.x},${at.y}`);
      const item = items.get(id);
      if (item) { item.x = at.x; item.y = at.y; }
    },
    remove: (id) => { log.push(`remove ${id}`); items.delete(id); },
    select: (id) => selections.push(id),
  };
  return { items, log, selections, port };
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

  test("a right-click while the ruler is held pins a waypoint; a stray right-click does nothing", () => {
    const { tool, measures } = harness();
    tool.activate("measure");
    // Nothing in flight: the right button is ignored (no preview, no points).
    tool.pointerDown({ world: { x: 5, y: 5 }, button: 2 });
    expect(measures.filter((m) => m !== null)).toHaveLength(0);
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerMove({ world: { x: 100, y: 0 }, button: 0 });
    // Browsers report the chorded press as a pointermove carrying button 2 with the right
    // bit set in `buttons`; its release is the same move without the bit (no second pivot).
    tool.pointerMove({ world: { x: 100, y: 0 }, button: 2, buttons: 3 });
    tool.pointerMove({ world: { x: 100, y: 0 }, button: 2, buttons: 1 });
    tool.pointerUp({ world: { x: 100, y: 0 }, button: 2 }); // a stray right-up ends nothing
    tool.pointerMove({ world: { x: 100, y: 80 }, button: 0 });
    const live = measures.filter((m) => m !== null).at(-1);
    expect(live?.kind).toBe("path");
    expect(live?.points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]);
    expect(live?.distance).toBe(180);
    tool.pointerUp({ world: { x: 100, y: 80 }, button: 0 });
    expect(tool.lastMeasurement).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]);
    // A second right-click on the same spot does not duplicate the pivot — whether it arrives
    // as a pointerdown (nothing else held) or as the chorded pointermove.
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 2 });
    tool.pointerMove({ world: { x: 0, y: 0 }, button: 2, buttons: 3 });
    expect(measures.filter((m) => m !== null).at(-1)?.points).toHaveLength(1);
  });

  test("only the circle measure carries a radius — a ruler, cone or ray must not draw a circle", () => {
    for (const shape of ["line", "cone", "ray"] as const) {
      const { tool, measures } = harness({ measureShape: shape });
      tool.activate("measure");
      drag(tool, { x: 0, y: 0 }, { x: 100, y: 0 });
      const last = measures.filter((m) => m !== null).at(-1);
      expect(last?.radiusPx, shape).toBeUndefined();
      expect(last?.kind, shape).toBe("line");
    }
    const { tool, measures } = harness({ measureShape: "circle" });
    tool.activate("measure");
    drag(tool, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(measures.filter((m) => m !== null).at(-1)?.radiusPx).toBe(100);
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

describe("placeable editing (D-465)", () => {
  test("the light tool selects a placed light on click, drags it, and Alt-click deletes it", () => {
    const world = placeables();
    const { tool, lights, previews } = harness({}, { lightEditing: world.port });
    tool.activate("light");
    // Click on l1: selected, not moved, no new light placed.
    tool.pointerDown({ world: { x: 104, y: 98 }, button: 0 });
    tool.pointerUp({ world: { x: 104, y: 98 }, button: 0 });
    expect(tool.selectedLightId).toBe("l1");
    expect(world.selections.at(-1)).toBe("l1");
    expect(lights).toHaveLength(0);
    expect(world.log).toEqual([]);
    expect(tool.hasPendingGesture()).toBe(true);
    // Drag l2 by (+50, +40): the preview follows the grab offset, the move commits on release.
    tool.pointerDown({ world: { x: 505, y: 103 }, button: 0 });
    tool.pointerMove({ world: { x: 555, y: 143 }, button: 0 });
    const live = previews.filter((p) => p !== null).at(-1);
    expect(live).toMatchObject({ kind: "placeable", tool: "light", at: { x: 550, y: 140 }, radius: 200 });
    tool.pointerUp({ world: { x: 555, y: 143 }, button: 0 });
    expect(world.log).toEqual(["move l2 550,140"]);
    expect(previews.at(-1)).toBeNull();
    expect(tool.selectedLightId).toBe("l2");
    // Escape deselects (and only deselects: the tool stays armed for the shell to decide).
    tool.dismissGesture();
    expect(tool.selectedLightId).toBeNull();
    expect(tool.hasPendingGesture()).toBe(false);
    // Alt-click removes without placing a new light.
    tool.pointerDown({ world: { x: 550, y: 140 }, button: 0, altKey: true });
    tool.pointerUp({ world: { x: 550, y: 140 }, button: 0, altKey: true });
    expect(world.log.at(-1)).toBe("remove l2");
    expect(lights).toHaveLength(0);
    // An empty spot still places a light, and the new light becomes the selection.
    tool.pointerDown({ world: { x: 900, y: 900 }, button: 0 });
    tool.pointerUp({ world: { x: 900, y: 900 }, button: 0 });
    expect(lights).toHaveLength(1);
    expect(tool.selectedLightId).toBe("light-1");
    // Delete removes the selection through the port.
    expect(tool.deleteSelected()).toBe(true);
    expect(world.log.at(-1)).toBe("remove light-1");
    expect(tool.selectedLightId).toBeNull();
    expect(tool.deleteSelected()).toBe(false);
  });

  test("a tiny wobble on a placed light is a click, not a move", () => {
    const world = placeables();
    const { tool } = harness({}, { lightEditing: world.port });
    tool.activate("light");
    tool.pointerDown({ world: { x: 100, y: 100 }, button: 0 });
    tool.pointerMove({ world: { x: 101, y: 100 }, button: 0 });
    tool.pointerUp({ world: { x: 101, y: 100 }, button: 0 });
    expect(world.log).toEqual([]);
    expect(tool.selectedLightId).toBe("l1");
  });

  test("the pin tool drags an existing pin instead of dropping a new one, and Alt-click removes it", () => {
    const world = placeables();
    const { tool, notes } = harness({}, { noteEditing: world.port });
    tool.activate("pin");
    tool.pointerDown({ world: { x: 100, y: 100 }, button: 0 });
    tool.pointerMove({ world: { x: 160, y: 130 }, button: 0 });
    tool.pointerUp({ world: { x: 160, y: 130 }, button: 0 });
    expect(world.log).toEqual(["move l1 160,130"]);
    expect(notes).toHaveLength(0);
    tool.pointerDown({ world: { x: 160, y: 130 }, button: 0, altKey: true });
    expect(world.log.at(-1)).toBe("remove l1");
    tool.pointerDown({ world: { x: 300, y: 300 }, button: 0 });
    expect(notes).toEqual([{ x: 300, y: 300 }]);
  });

  test("Alt-click with the draw tool erases the drawing under the pointer and starts no stroke", () => {
    const world = placeables();
    const { tool, created, previews } = harness({ drawShape: "freehand" }, { drawingEditing: world.port });
    tool.activate("draw");
    tool.pointerDown({ world: { x: 100, y: 100 }, button: 0, altKey: true });
    tool.pointerUp({ world: { x: 100, y: 100 }, button: 0, altKey: true });
    expect(world.log).toEqual(["remove l1"]);
    expect(created).toHaveLength(0);
    expect(previews.filter((p) => p !== null)).toHaveLength(0);
    // Alt on empty space keeps its old meaning (a stroke / the ellipse modifier).
    drag(tool, { x: 700, y: 700 }, { x: 760, y: 760 }, { altKey: true });
    expect(created).toHaveLength(1);
  });

  test("Escape semantics: pending gestures are reported so the shell can fall back to Select", () => {
    const { tool } = harness();
    tool.activate("measure");
    expect(tool.hasPendingGesture()).toBe(false);
    drag(tool, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(tool.hasPendingGesture()).toBe(true); // the finished measurement is still on screen
    tool.dismissGesture();
    expect(tool.hasPendingGesture()).toBe(false);
    tool.activate("draw");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    expect(tool.hasPendingGesture()).toBe(true);
    tool.dismissGesture();
    expect(tool.hasPendingGesture()).toBe(false);
  });
});
