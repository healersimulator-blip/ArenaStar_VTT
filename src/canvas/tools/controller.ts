/**
 * §10 tool gestures — the state machine behind the left rail (D-255/D-256). It is
 * deliberately free of Pixi and DOM: the shells convert pointer events to world points,
 * the controller decides what the gesture means, and the callbacks commit documents or
 * hand a preview back for the overlay. Every branch here is unit-tested in
 * `tests/ui/canvasTools.test.ts`.
 *
 * Gestures (Roll20 parity):
 *   draw    freehand / rect / ellipse / line / polygon, `Alt` = ellipse, `Shift` = grid snap
 *   text    one click, the shell opens its in-canvas editor at that point
 *   measure line or AoE (circle/cone/ray), snap modes, ctrl+click waypoints, broadcast
 *   fog     GM brushes — rect or polygon, reveal or hide
 *   wall    GM drag, grid-snapped; door variant
 *   light   GM click
 *   pin     GM click (map pin / journal link)
 */
import {
  drawingForFreehand,
  drawingForShape,
  type DrawShape,
  type DrawingStyle,
  type Point,
} from "./drawing";
import {
  measureArea,
  measureRulerPath,
  radiusMeasure,
  type MeasureShape,
} from "./measureTool";
import type { TemplateShape } from "../layers/templateGeometry";
import { snapWorldWith, type SnapMode } from "../grid/snapMode";
import type { MeasureGrid } from "../grid/measure";
import type { DrawingDocument, WallDocument } from "../../core/documents";
import type { DocId, UserId } from "../../core/ids";

export type ToolGesture = "draw" | "text" | "measure" | "fog" | "wall" | "light" | "pin";

/** Roll20's advanced hotkeys draw the wall/light layer with snapping on by default. */
export type FogBrush = "reveal" | "hide";
export type FogShape = "rect" | "poly";
export type WallKind = "wall" | "door";

export interface ToolOptions {
  drawShape: DrawShape;
  drawingStyle: DrawingStyle;
  /** Text tool font size in world pixels (Roll20's text size picker). */
  textSize: number;
  measureShape: MeasureShape;
  measureSnap: SnapMode;
  /** Roll20's "Show to others / Hide from others" for the measure tool's own line. */
  measureBroadcast: boolean;
  fogBrush: FogBrush;
  fogShape: FogShape;
  wallKind: WallKind;
  wallDoorState: 0 | 1 | 2;
  lightRadius: number;
  lightColor: string;
  /** Snap wall/light placement to the grid (Roll20: on). */
  placementSnap: SnapMode;
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  drawShape: "freehand",
  drawingStyle: { stroke: "#ffffff", fill: "transparent", strokeWidth: 3 },
  textSize: 18,
  measureShape: "line",
  measureSnap: "none",
  measureBroadcast: false,
  fogBrush: "reveal",
  fogShape: "rect",
  wallKind: "wall",
  wallDoorState: 0,
  lightRadius: 40,
  lightColor: "#ffcc66",
  placementSnap: "corner",
};

export interface ToolPointer {
  world: Point;
  button: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** What the measure overlay draws (the `svg.measure-preview` element). */
export interface MeasurePreview {
  kind: "line" | "path" | "radius";
  shape: MeasureShape;
  points: Point[];
  distance: number;
  radiusPx?: number;
  /** AoE geometry in world coords — the templates layer's own shapes. */
  area?: TemplateShape;
}

/** What the shape overlay draws: a pending drawing, a fog brush or a wall segment. */
export type ShapePreview =
  | {
      kind: "draw";
      shape: DrawShape;
      from: Point;
      to: Point;
      points: Point[];
      style: DrawingStyle;
    }
  | { kind: "fog"; brush: FogBrush; shape: FogShape; from: Point; to: Point; points: Point[] }
  | { kind: "wall"; from: Point; to: Point; door: boolean };

export interface ToolCallbacks {
  nextId: () => DocId;
  userId: UserId;
  grid: () => MeasureGrid | null;
  options: () => ToolOptions;
  createDrawing: (drawing: DrawingDocument) => void;
  createWall: (wall: Pick<WallDocument, "c" | "door">) => void;
  createLight: (light: { x: number; y: number; radius: number; color: string }) => void;
  createNote: (at: Point) => void;
  promptText: (at: Point) => void;
  measurePreview: (value: MeasurePreview | null) => void;
  shapePreview: (value: ShapePreview | null) => void;
  /** Publish the finished measurement to the other peers (Roll20's "show to others"). */
  broadcastMeasure: (points: Point[]) => void;
  /** GM fog brush: world-space polygon + which way it paints. */
  fogPaint: (value: { mode: FogBrush; poly: number[] }) => void;
}

/** Click-within-this-many-world-units of the first vertex closes a polygon. */
const CLOSE_TOLERANCE = 24;
/** A shape needs this much drag to commit (a stray click must not leave a dot). */
const MIN_SHAPE_SIZE = 2;

/** Tool-only gesture state. It is deliberately independent of Pixi and DOM events. */
export class ToolInteractionController {
  private mode: ToolGesture | null = null;
  private points: Point[] = [];
  private start: Point | null = null;
  private lastMeasure: Point[] = [];
  private lastBroadcastKey = "";
  constructor(private readonly callbacks: ToolCallbacks) {}

  activate(mode: ToolGesture): void {
    this.cancel();
    this.mode = mode;
  }

  current(): ToolGesture | null {
    return this.mode;
  }

  /** The last finished measurement (Roll20's `X` — "show last measure"). */
  get lastMeasurement(): ReadonlyArray<Point> {
    return this.lastMeasure;
  }

  private options(): ToolOptions {
    return this.callbacks.options();
  }

  /** The shape the draw gesture commits for this event (Roll20: `Alt` = ellipse). */
  private drawShapeFor(event: ToolPointer): DrawShape {
    const shape = this.options().drawShape;
    return event.altKey && shape === "rect" ? "ellipse" : shape;
  }

  private snap(point: Point, event: ToolPointer, mode: SnapMode): Point {
    const snapMode = event.shiftKey ? "corner" : mode;
    return snapWorldWith(this.callbacks.grid(), point, snapMode);
  }

  pointerDown(event: ToolPointer): void {
    if (!this.mode || event.button !== 0) return;
    const options = this.options();
    if (this.mode === "text") {
      this.callbacks.promptText({ ...event.world });
      return;
    }
    if (this.mode === "pin") {
      this.callbacks.createNote(this.snap(event.world, event, "none"));
      return;
    }
    if (this.mode === "light") {
      const at = this.snap(event.world, event, options.placementSnap);
      this.callbacks.createLight({
        x: at.x,
        y: at.y,
        radius: options.lightRadius,
        color: options.lightColor,
      });
      return;
    }
    if (this.mode === "fog") {
      if (options.fogShape === "poly") {
        // Roll20: clicking back near the first vertex closes the polygon instead of
        // adding a vertex there.
        if (this.points.length >= 3 && this.nearStart(event.world)) {
          this.finishPoly();
        } else {
          this.points.push({ ...event.world });
          this.emitFogPolyPreview(event.world);
        }
      } else {
        this.start = { ...event.world };
        this.emitFogRectPreview(event.world);
      }
      return;
    }
    if (this.mode === "wall") {
      this.start = this.snap(event.world, event, options.placementSnap);
      this.emitWallPreview(this.start);
      return;
    }
    if (this.mode === "draw") {
      const shape = this.drawShapeFor(event);
      const at = this.snap(event.world, event, "none");
      if (shape === "poly") {
        if (this.points.length >= 3 && this.nearStart(at)) {
          this.finishPoly();
          return;
        }
        this.points.push({ ...at });
        this.emitDrawPreview(at, shape);
        return;
      }
      if (shape === "freehand") {
        this.points = [{ ...at }];
        return;
      }
      this.start = { ...at };
      this.emitDrawPreview(at, shape);
      return;
    }
    if (this.mode === "measure") {
      if (event.ctrlKey && this.points.length > 0) this.points.push({ ...event.world });
      else this.points = [this.snap(event.world, event, options.measureSnap)];
      this.preview();
    }
  }

  pointerMove(event: ToolPointer): void {
    const options = this.options();
    if (this.mode === "draw") {
      const shape = this.drawShapeFor(event);
      if (shape === "freehand" && this.points.length > 0) {
        this.points.push({ ...event.world });
      } else if (shape === "poly" && this.points.length > 0) {
        this.emitDrawPreview({ ...event.world }, shape);
      } else if (this.start) {
        this.emitDrawPreview(this.snap(event.world, event, "none"), shape);
      }
    } else if (this.mode === "measure" && this.points.length > 0) {
      // Committed waypoints + the cursor: the preview always spans the real distance, so a
      // one-point gesture (a fresh drag) is not a zero-length line at the pointer.
      const at = this.snap(event.world, event, options.measureSnap);
      this.emitMeasure([...this.points, at], false);
    } else if (this.mode === "fog" && options.fogShape === "rect" && this.start) {
      this.emitFogRectPreview({ ...event.world });
    } else if (this.mode === "fog" && options.fogShape === "poly" && this.points.length > 0) {
      this.emitFogPolyPreview({ ...event.world });
    } else if (this.mode === "wall" && this.start) {
      this.emitWallPreview(this.snap(event.world, event, options.placementSnap));
    }
  }

  pointerUp(event: ToolPointer): void {
    if (!this.mode) return;
    const options = this.options();
    if (this.mode === "draw") {
      const shape = this.drawShapeFor(event);
      if (shape === "freehand") {
        if (this.points.length > 0) {
          this.points.push({ ...event.world });
          if (this.points.length > 1) {
            this.callbacks.createDrawing(
              drawingForFreehand(
                this.callbacks.nextId(),
                this.points,
                this.callbacks.userId,
                options.drawingStyle,
              ),
            );
          }
          this.points = [];
        }
        this.callbacks.shapePreview(null);
      } else if (shape !== "poly" && this.start) {
        const from = this.start;
        const to = this.snap(event.world, event, "none");
        this.start = null;
        this.callbacks.shapePreview(null);
        if (Math.hypot(to.x - from.x, to.y - from.y) >= MIN_SHAPE_SIZE) {
          this.callbacks.createDrawing(
            drawingForShape(
              shape,
              this.callbacks.nextId(),
              { from, to },
              this.callbacks.userId,
              options.drawingStyle,
            ),
          );
        }
      }
      return;
    }
    if (this.mode === "fog" && options.fogShape === "rect" && this.start) {
      const from = this.start;
      this.start = null;
      this.callbacks.shapePreview(null);
      const poly = rectPolygon(from, { ...event.world });
      if (poly) this.callbacks.fogPaint({ mode: options.fogBrush, poly });
      return;
    }
    if (this.mode === "wall" && this.start) {
      const from = this.start;
      const to = this.snap(event.world, event, options.placementSnap);
      this.start = null;
      this.callbacks.shapePreview(null);
      if (Math.hypot(to.x - from.x, to.y - from.y) >= MIN_SHAPE_SIZE) {
        this.callbacks.createWall({
          c: [from.x, from.y, to.x, to.y],
          door: options.wallKind === "door" ? (options.wallDoorState === 0 ? 1 : options.wallDoorState) : 0,
        });
      }
      return;
    }
    if (this.mode === "measure" && this.points.length > 0) {
      const at = this.snap(event.world, event, options.measureSnap);
      const last = this.points[this.points.length - 1];
      if (last && Math.hypot(at.x - last.x, at.y - last.y) > 0.01) this.points.push(at);
      this.emitMeasure([...this.points], true);
    }
  }

  /** Add a path pivot without ending the measurement. */
  addWaypoint(world: Point): void {
    if (this.mode !== "measure") return;
    this.points.push({ ...world });
    this.preview();
  }

  /**
   * Finish the multi-click gestures early: a polygon brush / polygon drawing closes, a
   * rectangle fog brush with no drag does nothing. Called from Escape and right-click.
   */
  finishPoly(): void {
    const options = this.options();
    // Only a polygon commits this way: for every other shape Escape means "cancel".
    const polyDraw = this.mode === "draw" && options.drawShape === "poly";
    if (polyDraw && this.points.length >= 2) {
      this.callbacks.createDrawing(
        drawingForShape(
          "poly",
          this.callbacks.nextId(),
          { from: this.points[0] ?? { x: 0, y: 0 }, to: this.points.at(-1) ?? { x: 0, y: 0 }, points: this.points },
          this.callbacks.userId,
          options.drawingStyle,
        ),
      );
    } else if (
      this.mode === "fog" &&
      options.fogShape === "poly" &&
      this.points.length >= 3
    ) {
      const poly = this.points.flatMap((p) => [p.x, p.y]);
      this.callbacks.fogPaint({ mode: options.fogBrush, poly });
    }
    this.points = [];
    this.start = null;
    this.callbacks.shapePreview(null);
    this.callbacks.measurePreview(null);
  }

  /**
   * Escape with a gesture in flight (Roll20): a measure stops being drawn but stays
   * recallable with `X`; a polygon closes; anything else is dropped.
   */
  dismissGesture(): void {
    if (this.mode === "measure") {
      this.points = [];
      this.start = null;
      this.callbacks.measurePreview(null);
      this.callbacks.shapePreview(null);
      return;
    }
    this.finishPoly();
  }

  /** Roll20's `X`: re-show (and re-broadcast) the last measurement. */
  recall(): boolean {
    if (this.mode !== "measure" || this.lastMeasure.length < 2) return false;
    this.points = this.lastMeasure.map((p) => ({ ...p }));
    this.emitMeasure(this.points, true);
    return true;
  }

  commitMeasure(): void {
    this.points = [];
    this.lastMeasure = [];
    this.callbacks.measurePreview(null);
  }

  cancel(): void {
    this.mode = null;
    this.points = [];
    this.start = null;
    this.callbacks.measurePreview(null);
    this.callbacks.shapePreview(null);
  }

  private nearStart(world: Point): boolean {
    const first = this.points[0];
    if (!first) return false;
    return Math.hypot(world.x - first.x, world.y - first.y) <= CLOSE_TOLERANCE;
  }

  private preview(): void {
    if (this.points.length) this.emitMeasure([...this.points], false);
  }

  private emitMeasure(points: Point[], finished: boolean): void {
    const grid = this.callbacks.grid();
    const options = this.options();
    const distance = measureRulerPath(grid, points);
    const [first, second] = points;
    const area = first && second ? measureArea(options.measureShape, grid, first, second) : null;
    const radius =
      points.length === 2 && first && second ? radiusMeasure(grid, first, second) : null;
    this.callbacks.measurePreview({
      kind: points.length > 2 ? "path" : options.measureShape === "circle" ? "radius" : area ? "line" : "line",
      shape: options.measureShape,
      points,
      distance,
      ...(radius ? { radiusPx: radius.radiusPx } : {}),
      ...(area ? { area } : {}),
    });
    if (finished) {
      this.lastMeasure = points.map((p) => ({ ...p }));
      const key = this.lastMeasure.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(";");
      if (options.measureBroadcast && key !== this.lastBroadcastKey) {
        this.lastBroadcastKey = key;
        this.callbacks.broadcastMeasure(this.lastMeasure.map((p) => ({ ...p })));
      }
    }
  }

  private emitDrawPreview(to: Point, shape: DrawShape): void {
    const from = this.points[0] ?? this.start;
    if (!from) return;
    this.callbacks.shapePreview({
      kind: "draw",
      shape,
      from,
      to,
      points: this.points.map((p) => ({ ...p })).concat(shape === "poly" ? [{ ...to }] : []),
      style: this.options().drawingStyle,
    });
  }

  private emitFogRectPreview(to: Point): void {
    if (!this.start) return;
    this.callbacks.shapePreview({
      kind: "fog",
      brush: this.options().fogBrush,
      shape: "rect",
      from: this.start,
      to,
      points: [],
    });
  }

  private emitFogPolyPreview(to: Point): void {
    this.callbacks.shapePreview({
      kind: "fog",
      brush: this.options().fogBrush,
      shape: "poly",
      from: this.points[0] ?? to,
      to,
      points: this.points.map((p) => ({ ...p })).concat([{ ...to }]),
    });
  }

  private emitWallPreview(to: Point): void {
    if (!this.start) return;
    this.callbacks.shapePreview({
      kind: "wall",
      from: this.start,
      to,
      door: this.options().wallKind === "door",
    });
  }
}

/** Axis-aligned rectangle as a flat polygon; null when the drag has no area. */
export function rectPolygon(from: Point, to: Point): number[] | null {
  if (Math.abs(to.x - from.x) < MIN_SHAPE_SIZE || Math.abs(to.y - from.y) < MIN_SHAPE_SIZE) {
    return null;
  }
  const x1 = Math.min(from.x, to.x);
  const y1 = Math.min(from.y, to.y);
  const x2 = Math.max(from.x, to.x);
  const y2 = Math.max(from.y, to.y);
  return [x1, y1, x2, y1, x2, y2, x1, y2];
}
