/**
 * §10 canvas interactions (M1) — pan/zoom, marquee select, token drag →
 * optimistic move intents.
 *
 * Pointer mapping (tool-less, D-057):
 *   left on token        → drag token (preview each frame; intent on release)
 *   left on empty space  → marquee select
 *   middle / right / shift+left → pan
 *   wheel                → zoom (cursor-pinned)
 *
 * Everything is port-injected so Node tests drive the full state machine:
 * StageLike (camera/token rendering), PointerEventSource (DOM adapter in
 * browsers) and IntentSink (ClientSync.submit). Previews are local only; the
 * authoritative move is one update Op per drag (token x/y = center, snapped
 * to grid intersections when a grid is set).
 */
import type { Camera } from "../camera";
import { screenToWorld, zoomAt } from "../camera";
import type { GridSpec } from "../grid";
import { snapPoint } from "../grid";
import { marqueeRect, tokenInMarquee, tokenRect } from "../tokens";
import type { TokenDocument } from "../../core/documents";
import type { DocId } from "../../core/ids";
import type { Op } from "../../core/ops";

// ─── Ports ────────────────────────────────────────────────────────────────────

export interface StageLike {
  readonly camera: Camera;
  setCamera(camera: Camera): void;
  syncTokens(tokens: readonly TokenDocument[]): void;
  setMarquee(a: { x: number; y: number } | null, b?: { x: number; y: number }): void;
}

export interface PointerEvt {
  x: number;
  y: number;
  button: number;
  shiftKey: boolean;
  pointerId: number;
  /** §9 ephemera (D-083): alt+click = ping, ctrl+click = ruler waypoint. */
  altKey?: boolean;
  ctrlKey?: boolean;
  preventDefault(): void;
}

export interface WheelEvt {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  preventDefault(): void;
}

export interface PointerEventSource {
  addPointerListener(
    type: "pointerdown" | "pointermove" | "pointerup",
    cb: (ev: PointerEvt) => void,
  ): void;
  removePointerListener(
    type: "pointerdown" | "pointermove" | "pointerup",
    cb: (ev: PointerEvt) => void,
  ): void;
  addWheelListener(cb: (ev: WheelEvt) => void): void;
  removeWheelListener(cb: (ev: WheelEvt) => void): void;
}

export interface IntentSink {
  submit(ops: Op[]): unknown;
}

/** A token with its owning scene (embedded refs need the parent, §4). */
export interface TokenView {
  token: TokenDocument;
  sceneId: DocId;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Topmost token under a world point (later in the array wins). */
export function pickToken(
  views: readonly TokenView[],
  world: { x: number; y: number },
): TokenView | undefined {
  for (let i = views.length - 1; i >= 0; i--) {
    const view = views[i];
    if (!view) continue;
    const rect = tokenRect(view.token);
    if (
      world.x >= rect.x &&
      world.x <= rect.x + rect.width &&
      world.y >= rect.y &&
      world.y <= rect.y + rect.height
    ) {
      return view;
    }
  }
  return undefined;
}

/** Pan by a screen-space delta (drag distance in pixels → world shift). */
export function panByScreen(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    x: camera.x - dxScreen / camera.scale,
    y: camera.y - dyScreen / camera.scale,
    scale: camera.scale,
  };
}

/** Final drag position: center + delta, snapped when a grid is set. */
export function dragTarget(
  token: Pick<TokenDocument, "x" | "y">,
  delta: { x: number; y: number },
  grid: GridSpec | null,
): { x: number; y: number } {
  const x = token.x + delta.x;
  const y = token.y + delta.y;
  if (!grid) return { x, y };
  return snapPoint(grid, x, y);
}

// ─── Controller ───────────────────────────────────────────────────────────────

export interface ControllerOptions {
  stage: StageLike;
  source: PointerEventSource;
  client: IntentSink;
  /** Current tokens (wired to the echo/replica layer by the app). */
  getTokens: () => readonly TokenView[];
  /** Active square grid, or null when the scene has none. */
  getGrid: () => GridSpec | null;
  /** Ownership gate (players drag only tokens they own; GM all). */
  canMove: (view: TokenView) => boolean;
  onSelectionChange?: (selection: readonly DocId[]) => void;
  /** §9: alt+click on the canvas emits a ping at the world point. */
  onPing?: (world: { x: number; y: number }) => void;
  /** §9: ctrl+click appends a ruler waypoint ([] clears; snapped to grid). */
  onRulerChange?: (points: ReadonlyArray<{ x: number; y: number }>) => void;
}

type Mode = "idle" | "pan" | "marquee" | "drag";

const RULER_MAX_WAYPOINTS = 12;

export class CanvasController {
  private mode: Mode = "idle";
  private startScreen = { x: 0, y: 0 };
  private startCamera: Camera = { x: 0, y: 0, scale: 1 };
  private startWorld = { x: 0, y: 0 };
  private grabbed: TokenView | null = null;
  private readonly selection = new Set<DocId>();
  private rulerPoints: Array<{ x: number; y: number }> = [];

  private readonly onDown = (ev: PointerEvt): void => this.pointerDown(ev);
  private readonly onMove = (ev: PointerEvt): void => this.pointerMove(ev);
  private readonly onUp = (ev: PointerEvt): void => this.pointerUp(ev);
  private readonly onWheel = (ev: WheelEvt): void => this.wheel(ev);

  constructor(private readonly options: ControllerOptions) {
    options.source.addPointerListener("pointerdown", this.onDown);
    options.source.addPointerListener("pointermove", this.onMove);
    options.source.addPointerListener("pointerup", this.onUp);
    options.source.addWheelListener(this.onWheel);
  }

  get selected(): readonly DocId[] {
    return [...this.selection];
  }

  get ruler(): ReadonlyArray<{ x: number; y: number }> {
    return this.rulerPoints;
  }

  /** Clear the active ruler (Escape) — emits the empty list. */
  clearRuler(): void {
    if (this.rulerPoints.length === 0) return;
    this.rulerPoints = [];
    this.options.onRulerChange?.([]);
  }

  private pointerDown(ev: PointerEvt): void {
    const camera = this.options.stage.camera;
    const world = screenToWorld(camera, ev.x, ev.y);
    if (ev.button === 0 && ev.altKey && this.options.onPing) {
      // §9 ping: ephemeral broadcast, never a selection/drag
      this.options.onPing(world);
      return;
    }
    if (ev.button === 0 && ev.ctrlKey && this.options.onRulerChange) {
      // §9 ruler waypoint: snapped append (max 12, §4A)
      const grid = this.options.getGrid();
      const snapped = grid ? snapPoint(grid, world.x, world.y) : { x: world.x, y: world.y };
      if (this.rulerPoints.length < RULER_MAX_WAYPOINTS) {
        this.rulerPoints = [...this.rulerPoints, snapped];
        this.options.onRulerChange(this.rulerPoints);
      }
      return;
    }
    const wantsPan = ev.button === 1 || ev.button === 2 || ev.shiftKey;
    if (wantsPan) {
      ev.preventDefault();
      this.mode = "pan";
      this.startScreen = { x: ev.x, y: ev.y };
      this.startCamera = { ...camera };
      return;
    }
    const hit = pickToken(this.options.getTokens(), world);
    if (hit) {
      this.selection.clear();
      this.selection.add(hit.token._id);
      this.options.onSelectionChange?.(this.selected);
      if (this.options.canMove(hit)) {
        ev.preventDefault();
        this.mode = "drag";
        this.grabbed = hit;
        this.startWorld = world;
      } else {
        this.mode = "idle"; // select-only (not owned)
      }
      return;
    }
    this.mode = "marquee";
    this.startWorld = world;
    this.options.stage.setMarquee(world, world);
  }

  private pointerMove(ev: PointerEvt): void {
    switch (this.mode) {
      case "pan": {
        const dx = ev.x - this.startScreen.x;
        const dy = ev.y - this.startScreen.y;
        this.options.stage.setCamera(panByScreen(this.startCamera, dx, dy));
        return;
      }
      case "drag": {
        if (!this.grabbed) return;
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        const delta = { x: world.x - this.startWorld.x, y: world.y - this.startWorld.y };
        this.options.stage.syncTokens(this.preview(delta));
        return;
      }
      case "marquee": {
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        this.options.stage.setMarquee(this.startWorld, world);
        return;
      }
      case "idle":
        return;
    }
  }

  private pointerUp(ev: PointerEvt): void {
    switch (this.mode) {
      case "drag": {
        const grabbed = this.grabbed;
        this.grabbed = null;
        this.mode = "idle";
        if (!grabbed) return;
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        const delta = { x: world.x - this.startWorld.x, y: world.y - this.startWorld.y };
        const target = dragTarget(grabbed.token, delta, this.options.getGrid());
        this.options.client.submit([
          {
            kind: "update",
            ref: {
              coll: "tokens",
              id: grabbed.token._id,
              parent: { coll: "scenes", id: grabbed.sceneId },
            },
            diff: { x: target.x, y: target.y },
          },
        ]);
        this.options.stage.syncTokens(this.options.getTokens().map((v) => v.token));
        return;
      }
      case "marquee": {
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        this.selection.clear();
        const rect = marqueeRect(this.startWorld, world);
        for (const view of this.options.getTokens()) {
          if (tokenInMarquee(view.token, rect)) {
            this.selection.add(view.token._id);
          }
        }
        this.options.stage.setMarquee(null);
        this.options.onSelectionChange?.(this.selected);
        this.mode = "idle";
        return;
      }
      default:
        this.mode = "idle";
    }
  }

  private wheel(ev: WheelEvt): void {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0015);
    this.options.stage.setCamera(zoomAt(this.options.stage.camera, ev.x, ev.y, factor));
  }

  /** Tokens with the dragged one offset by the live delta (local preview). */
  private preview(delta: { x: number; y: number }): TokenDocument[] {
    const out: TokenDocument[] = [];
    for (const view of this.options.getTokens()) {
      if (this.grabbed && view.token._id === this.grabbed.token._id) {
        out.push({ ...view.token, x: view.token.x + delta.x, y: view.token.y + delta.y });
      } else {
        out.push(view.token);
      }
    }
    return out;
  }

  destroy(): void {
    this.options.source.removePointerListener("pointerdown", this.onDown);
    this.options.source.removePointerListener("pointermove", this.onMove);
    this.options.source.removePointerListener("pointerup", this.onUp);
    this.options.source.removeWheelListener(this.onWheel);
    this.mode = "idle";
    this.grabbed = null;
    this.rulerPoints = [];
  }
}

// ─── DOM adapter (browsers) ───────────────────────────────────────────────────

type PointerType = "pointerdown" | "pointermove" | "pointerup";

export function domPointerSource(canvas: HTMLCanvasElement): PointerEventSource {
  const pointerWrapped = new Map<PointerType, Map<(ev: PointerEvt) => void, EventListener>>();
  const wheelWrapped = new Map<(ev: WheelEvt) => void, EventListener>();

  const pointerList = (type: PointerType): Map<(ev: PointerEvt) => void, EventListener> => {
    let list = pointerWrapped.get(type);
    if (!list) {
      list = new Map();
      pointerWrapped.set(type, list);
    }
    return list;
  };

  return {
    addPointerListener(type, cb) {
      const wrapped = (ev: PointerEvent): void => {
        const rect = canvas.getBoundingClientRect();
        cb({
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
          button: ev.button,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          ctrlKey: ev.ctrlKey,
          pointerId: ev.pointerId,
          preventDefault: () => ev.preventDefault(),
        });
      };
      pointerList(type).set(cb, wrapped as EventListener);
      canvas.addEventListener(type, wrapped as EventListener);
    },
    removePointerListener(type, cb) {
      const list = pointerWrapped.get(type);
      const wrapped = list?.get(cb);
      if (list && wrapped) {
        canvas.removeEventListener(type, wrapped);
        list.delete(cb);
      }
    },
    addWheelListener(cb) {
      const wrapped = (ev: WheelEvent): void => {
        const rect = canvas.getBoundingClientRect();
        cb({
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
          deltaX: ev.deltaX,
          deltaY: ev.deltaY,
          preventDefault: () => ev.preventDefault(),
        });
      };
      wheelWrapped.set(cb, wrapped as EventListener);
      canvas.addEventListener("wheel", wrapped as EventListener, { passive: false });
    },
    removeWheelListener(cb) {
      const wrapped = wheelWrapped.get(cb);
      if (wrapped) {
        canvas.removeEventListener("wheel", wrapped);
        wheelWrapped.delete(cb);
      }
    },
  };
}

// §9A strategic unit interactions (Unit 27)
export * from "./unitOrders";
export * from "./orderOverlays";
export * from "./unitController";
