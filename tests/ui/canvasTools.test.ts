import { describe, expect, test } from "vitest";
import { drawingForFreehand, drawingForText } from "../../src/canvas/tools/drawing";
import { ToolInteractionController } from "../../src/canvas/tools/controller";
import { canDeleteDrawing, canEraseAllDrawings } from "../../src/core/drawingPermissions";

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
    const created: unknown[] = [];
    const previews: unknown[] = [];
    const tool = new ToolInteractionController({
      nextId: () => "d1",
      userId: "player-a",
      grid: () => null,
      createDrawing: (d) => created.push(d),
      promptText: () => undefined,
      measurePreview: (p) => previews.push(p),
    });
    tool.activate("draw");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerMove({ world: { x: 5, y: 5 }, button: 0 });
    tool.pointerUp({ world: { x: 10, y: 10 }, button: 0 });
    expect(created).toHaveLength(1);
    tool.activate("measure");
    tool.pointerDown({ world: { x: 0, y: 0 }, button: 0 });
    tool.pointerMove({ world: { x: 30, y: 40 }, button: 0 });
    expect(previews.some((p) => p !== null)).toBe(true);
  });
});
