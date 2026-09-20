import { drawingForFreehand, type Point } from "./drawing";
import { measureRulerPath, radiusMeasure } from "./measureTool";
import type { MeasureGrid } from "../grid/measure";
import type { DocId, UserId } from "../../core/ids";

export type ToolGesture = "draw" | "text" | "measure";
export interface ToolPointer { world: Point; button: number; ctrlKey?: boolean; }
export interface ToolCallbacks {
  nextId: () => DocId;
  userId: UserId;
  grid: () => MeasureGrid | null;
  createDrawing: (drawing: ReturnType<typeof drawingForFreehand>) => void;
  promptText: (at: Point) => void;
  measurePreview: (value: { kind: "line" | "path" | "radius"; points: Point[]; distance: number; radiusPx?: number } | null) => void;
}

/** Tool-only gesture state. It is deliberately independent of Pixi and DOM events. */
export class ToolInteractionController {
  private mode: ToolGesture | null = null;
  private points: Point[] = [];
  constructor(private readonly callbacks: ToolCallbacks) {}

  activate(mode: ToolGesture): void { this.cancel(); this.mode = mode; }
  current(): ToolGesture | null { return this.mode; }

  pointerDown(event: ToolPointer): void {
    if (!this.mode || event.button !== 0) return;
    if (this.mode === "text") { this.callbacks.promptText({ ...event.world }); return; }
    if (this.mode === "draw") { this.points = [{ ...event.world }]; return; }
    if (this.mode === "measure") {
      if (event.ctrlKey && this.points.length > 0) this.points.push({ ...event.world });
      else this.points = [{ ...event.world }];
      this.preview();
    }
  }

  pointerMove(event: ToolPointer): void {
    if (this.mode === "draw" && this.points.length > 0) {
      this.points.push({ ...event.world });
    } else if (this.mode === "measure" && this.points.length > 0) {
      const preview = [...this.points.slice(0, -1), { ...event.world }];
      if (preview.length === 1) preview.push({ ...event.world });
      this.emitMeasure(preview);
    }
  }

  pointerUp(event: ToolPointer): void {
    if (this.mode === "draw" && this.points.length > 0) {
      this.points.push({ ...event.world });
      if (this.points.length > 1) this.callbacks.createDrawing(drawingForFreehand(this.callbacks.nextId(), this.points, this.callbacks.userId));
      this.points = [];
    } else if (this.mode === "measure" && this.points.length > 0) {
      this.points.push({ ...event.world });
      this.emitMeasure(this.points);
    }
  }

  /** Add a path pivot without ending the measurement. */
  addWaypoint(world: Point): void {
    if (this.mode !== "measure") return;
    this.points.push({ ...world });
    this.preview();
  }

  commitMeasure(): void { this.points = []; this.callbacks.measurePreview(null); }
  cancel(): void { this.mode = null; this.points = []; this.callbacks.measurePreview(null); }

  private preview(): void { if (this.points.length) this.emitMeasure(this.points); }
  private emitMeasure(points: Point[]): void {
    const grid = this.callbacks.grid();
    const distance = measureRulerPath(grid, points);
    const radius = points.length === 2 ? radiusMeasure(grid, points[0]!, points[1]!) : null;
    this.callbacks.measurePreview({ kind: points.length > 2 ? "path" : "line", points, distance, ...(radius ? { radiusPx: radius.radiusPx } : {}) });
  }
}
