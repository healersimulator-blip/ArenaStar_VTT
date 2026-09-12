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
  setMarquee(
    a: { x: number; y: number } | null,
    b?: { x: number; y: number },
  ): void;
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
  /** Optional for non-DOM sources; activation never requires movement ownership. */
  addDoubleClickListener?(cb: (ev: PointerEvt) => void): void;
  removeDoubleClickListener?(cb: (ev: PointerEvt) => void): void;
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
export function panByScreen(
  camera: Camera,
  dxScreen: number,
  dyScreen: number,
): Camera {
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
  /** App-owned actor sheet/navigation callback; the canvas knows nothing about PF1e. */
  onTokenActivate?: (view: TokenView) => void;
  /**
   * P06/D-185 — asked **before** a drag's move Op commits, with the position that would be
   * submitted (`to` is the snapped target when the scene has a grid). Returning `"cancel"`
   * suppresses the Op and snaps the token back to where it was, so a UI that must resolve
   * an interrupt first (an attack of opportunity decided by the queue) can stop the move
   * without the canvas knowing what an interrupt is. The canvas stays PF1e-free: the app
   * supplies the verdict, this hook only guarantees the ordering.
   *
   * P06/D-186 — `move.commit` is the same Op the controller would have submitted, deferred
   * until the caller says so. A listener that cancels to resolve an interrupt asynchronously
   * calls it once it is done (D-186's auto-resolved attacks of opportunity: the attack
   * resolves *before* the mover leaves the square, then the move commits), and a listener
   * that never calls it leaves the token where it started — the cancellation stays a real
   * cancellation. Only the first call does anything, and it always uses the snapped target
   * this hook was asked about, so the move cannot drift while the verdict is being decided.
   */
  onTokenMove?: (move: {
    view: TokenView;
    from: { x: number; y: number };
    to: { x: number; y: number };
    /** True when `to` is a grid-snapped point (the scene has a usable grid). */
    snapped: boolean;
    /** Commit this exact move (idempotent; no-op after the first call or after a cancel). */
    commit: () => void;
  }) => "cancel" | undefined;
  onSelectionChange?: (selection: readonly DocId[]) => void;
  /** §9: alt+click on the canvas emits a ping at the world point. */
  onPing?: (world: { x: number; y: number }) => void;
  /**
   * T01: right-CLICK (no drag) on a token opens its context menu with the screen point
   * (canvas-local coordinates for positioning the menu) and the world point. A right
   * DRAG still pans (D-057) and never opens a menu; right-click on empty space does
   * not open one either.
   */
  onContextMenu?: (at: {
    screen: { x: number; y: number };
    world: { x: number; y: number };
    tokenId: string;
  }) => void;
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
  private dragged = false;
  /** Button that started the current pan (0 for shift+left), to detect right-clicks. */
  private panButton = 0;
  private readonly selection = new Set<DocId>();
  private rulerPoints: Array<{ x: number; y: number }> = [];

  private readonly onDown = (ev: PointerEvt): void => this.pointerDown(ev);
  private readonly onMove = (ev: PointerEvt): void => this.pointerMove(ev);
  private readonly onUp = (ev: PointerEvt): void => this.pointerUp(ev);
  private readonly onWheel = (ev: WheelEvt): void => this.wheel(ev);

  private readonly onDoubleClick = (ev: PointerEvt): void => {
    if (
      ev.button !== 0 ||
      ev.shiftKey ||
      ev.altKey ||
      ev.ctrlKey ||
      this.mode !== "idle" ||
      this.dragged
    )
      return;
    const hit = pickToken(
      this.options.getTokens(),
      screenToWorld(this.options.stage.camera, ev.x, ev.y),
    );
    if (hit && this.options.onTokenActivate) {
      ev.preventDefault();
      this.options.onTokenActivate(hit);
    }
  };

  constructor(private readonly options: ControllerOptions) {
    options.source.addPointerListener("pointerdown", this.onDown);
    options.source.addPointerListener("pointermove", this.onMove);
    options.source.addPointerListener("pointerup", this.onUp);
    options.source.addWheelListener(this.onWheel);
    if (options.onTokenActivate)
      options.source.addDoubleClickListener?.(this.onDoubleClick);
  }

  get selected(): readonly DocId[] {
    return [...this.selection];
  }

  /** Scene switches / explicit clear cancel stale selection gestures without submitting movement. */
  clearSelection(): void {
    this.selection.clear();
    this.grabbed = null;
    this.dragged = false;
    this.mode = "idle";
    this.options.stage.setMarquee(null);
    this.options.onSelectionChange?.([]);
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
    this.dragged = false;
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
      const snapped = grid
        ? snapPoint(grid, world.x, world.y)
        : { x: world.x, y: world.y };
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
      this.panButton = ev.button;
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
        this.startScreen = { x: ev.x, y: ev.y };
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
        if (
          Math.abs(ev.x - this.startScreen.x) > 4 ||
          Math.abs(ev.y - this.startScreen.y) > 4
        )
          this.dragged = true;
        // With activation enabled a click must not snap an off-grid token or emit a move.
        if (this.options.onTokenActivate && !this.dragged) return;
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        const delta = {
          x: world.x - this.startWorld.x,
          y: world.y - this.startWorld.y,
        };
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
        if (
          Math.abs(ev.x - this.startScreen.x) > 4 ||
          Math.abs(ev.y - this.startScreen.y) > 4
        )
          this.dragged = true;
        if (this.options.onTokenActivate && !this.dragged) return;
        const camera = this.options.stage.camera;
        const world = screenToWorld(camera, ev.x, ev.y);
        const delta = {
          x: world.x - this.startWorld.x,
          y: world.y - this.startWorld.y,
        };
        const target = dragTarget(grabbed.token, delta, this.options.getGrid());
        // P06/D-185: the verdict is asked before the Op exists. A cancel restores the
        // token to its committed position and submits nothing; D-186 lets the listener
        // commit that same Op later (once an interrupt it had to resolve is done).
        const op: Op = {
          kind: "update",
          ref: {
            coll: "tokens",
            id: grabbed.token._id,
            parent: { coll: "scenes", id: grabbed.sceneId },
          },
          diff: { x: target.x, y: target.y },
        };
        let committed = false;
        const commit = (): void => {
          if (committed) return;
          committed = true;
          this.options.client.submit([op]);
          this.options.stage.syncTokens(
            this.options.getTokens().map((v) => v.token),
          );
        };
        const verdict = this.options.onTokenMove?.({
          view: grabbed,
          from: { x: grabbed.token.x, y: grabbed.token.y },
          to: { x: target.x, y: target.y },
          snapped: this.options.getGrid() !== null,
          commit,
        });
        if (verdict === "cancel") {
          this.options.stage.syncTokens(
            this.options.getTokens().map((v) => v.token),
          );
          return;
        }
        commit();
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
      case "pan": {
        // T01: a right-click that never dragged is a context-menu gesture, not a pan.
        if (this.panButton === 2 && this.options.onContextMenu) {
          const moved =
            Math.abs(ev.x - this.startScreen.x) > 4 ||
            Math.abs(ev.y - this.startScreen.y) > 4;
          if (!moved) {
            const camera = this.options.stage.camera;
            const world = screenToWorld(camera, ev.x, ev.y);
            const hit = pickToken(this.options.getTokens(), world);
            if (hit) {
              this.mode = "idle";
              this.panButton = 0;
              this.options.onContextMenu({
                screen: { x: ev.x, y: ev.y },
                world: { x: world.x, y: world.y },
                tokenId: hit.token._id,
              });
              return;
            }
          }
        }
        this.mode = "idle";
        this.panButton = 0;
        return;
      }
      default:
        this.mode = "idle";
    }
  }

  private wheel(ev: WheelEvt): void {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0015);
    this.options.stage.setCamera(
      zoomAt(this.options.stage.camera, ev.x, ev.y, factor),
    );
  }

  /** Tokens with the dragged one offset by the live delta (local preview). */
  private preview(delta: { x: number; y: number }): TokenDocument[] {
    const out: TokenDocument[] = [];
    for (const view of this.options.getTokens()) {
      if (this.grabbed && view.token._id === this.grabbed.token._id) {
        out.push({
          ...view.token,
          x: view.token.x + delta.x,
          y: view.token.y + delta.y,
        });
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
    if (this.options.onTokenActivate)
      this.options.source.removeDoubleClickListener?.(this.onDoubleClick);
    this.mode = "idle";
    this.grabbed = null;
    this.rulerPoints = [];
  }
}

// ─── DOM adapter (browsers) ───────────────────────────────────────────────────

type PointerType = "pointerdown" | "pointermove" | "pointerup";

export function domPointerSource(
  canvas: HTMLCanvasElement,
): PointerEventSource {
  const pointerWrapped = new Map<
    PointerType,
    Map<(ev: PointerEvt) => void, EventListener>
  >();
  const doubleClickWrapped = new Map<(ev: PointerEvt) => void, EventListener>();
  const wheelWrapped = new Map<(ev: WheelEvt) => void, EventListener>();

  const pointerList = (
    type: PointerType,
  ): Map<(ev: PointerEvt) => void, EventListener> => {
    let list = pointerWrapped.get(type);
    if (!list) {
      list = new Map();
      pointerWrapped.set(type, list);
    }
    return list;
  };

  // Right-drag pans and right-click opens the token menu (D-057/T01): either way the
  // browser's own context menu would cover the canvas, so it is suppressed here.
  const suppressMenu = (ev: MouseEvent): void => ev.preventDefault();
  canvas.addEventListener("contextmenu", suppressMenu);

  return {
    addDoubleClickListener(cb) {
      const wrapped = (ev: MouseEvent): void => {
        const rect = canvas.getBoundingClientRect();
        cb({
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
          button: ev.button,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          ctrlKey: ev.ctrlKey,
          pointerId: 0,
          preventDefault: () => ev.preventDefault(),
        });
      };
      doubleClickWrapped.set(cb, wrapped as EventListener);
      canvas.addEventListener("dblclick", wrapped as EventListener);
    },
    removeDoubleClickListener(cb) {
      const wrapped = doubleClickWrapped.get(cb);
      if (wrapped) {
        canvas.removeEventListener("dblclick", wrapped);
        doubleClickWrapped.delete(cb);
      }
    },
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
      canvas.addEventListener("wheel", wrapped as EventListener, {
        passive: false,
      });
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
