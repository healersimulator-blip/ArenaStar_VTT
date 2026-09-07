/**
 * §9A unit interactions — drag-select Units (not Models), right-click context
 * orders, drag unit→unit = attack, drag on map = move with waypoints (ruler),
 * keyboard shortcuts. Port-injected like the M1 CanvasController: Node tests
 * drive the full state machine through fakes; browsers wire DOM adapters.
 *
 * Pointer mapping (strategic scenes; coexists with the token controller):
 *   left on unit, release in place   → select (shift toggles)
 *   left on unit, drag to unit       → attack order (selection-wide)
 *   left on unit, drag to empty      → move order, waypoints ≥ spacing, ruler length
 *   left on empty, drag              → marquee box-select of units
 *   right on unit                    → context menu actions (onContextMenu)
 *   right on empty (selection)       → move-here; shift+right appends a waypoint
 *   armed mode + left click          → fulfil (move dest / attack target / retreat point)
 */
import type { Camera } from "../camera";
import { screenToWorld } from "../camera";
import type { MeasureGrid } from "../grid/measure";
import { captureWaypoints, measurePath } from "../grid/measure";
import type { WorldRect } from "../tokens";
import {
  attackOrderOps,
  moveOrderOps,
  retreatOrderOps,
  type EmitOptions,
  type OrderPreview,
  type OrderValidator,
  type ShortcutOutcome,
  type UnitOrderRef,
  orderShortcut,
} from "./unitOrders";
import type { Op } from "../../core/ops";
import type { PointerEventSource, PointerEvt } from "./index";
import type { Vec2 } from "../../core/strategic";

export interface UnitInteractionPorts {
  readonly camera: () => Camera;
  setMarquee(a: { x: number; y: number } | null, b?: { x: number; y: number }): void;
  /** World point → unit id (ModelLayer.hitTest). */
  hitTest(wx: number, wy: number): string | null;
  /** World rect → unit ids (ModelLayer.unitsInRect). */
  unitsInRect(rect: WorldRect): Set<string>;
  /** Unit → army for embedded ops refs; null = unknown/not commandable. */
  unitRef(unitId: string): UnitOrderRef | null;
  /** Ownership gate: owning faction or GM. */
  canCommand(unitId: string): boolean;
  submit(ops: Op[]): unknown;
  /** Current issue context (user + turn number). */
  issueContext(): { issuedBy: string; issuedTurn: number };
  validate?: OrderValidator;
  getGrid?: () => MeasureGrid | null;
  onSelectionChange?(ids: readonly string[]): void;
  onOrderPreview?(preview: OrderPreview | null): void;
  onContextMenu?(at: Vec2, onUnit: string | null, selection: readonly string[]): void;
  onInvalidOrder?(unitId: string, error: string): void;
  /** Pending order queue of a unit (shift+right-click waypoint append). */
  getPendingOrders?(unitId: string): readonly import("../../core/strategic").Order[] | null;
  /** Unit anchor for previews (wired to ModelLayer bboxes by the app). */
  getUnitAnchor?(unitId: string): Vec2 | null;
}

export interface UnitInteractionOptions {
  /** Drag distance (world units) before a unit press becomes an order drag. */
  dragThreshold?: number;
  /** Minimum waypoint spacing (world units) while dragging a move path. */
  waypointSpacing?: number;
}

type Mode = "idle" | "marquee" | "unitDrag" | "armed";

export class UnitInteractionController {
  private mode: Mode = "idle";
  private startWorld: Vec2 = { x: 0, y: 0 };
  private startUnit: string | null = null;
  private armed: {
    mode: "move" | "attack" | "retreat";
    pace: "march" | "run" | "charge" | undefined;
  } | null = null;
  private waypoints: Vec2[] = [];
  private readonly selection = new Set<string>();
  private readonly dragThreshold: number;
  private readonly waypointSpacing: number;

  private readonly onDown = (ev: PointerEvt): void => this.pointerDown(ev);
  private readonly onMove = (ev: PointerEvt): void => this.pointerMove(ev);
  private readonly onUp = (ev: PointerEvt): void => this.pointerUp(ev);

  constructor(
    private readonly ports: UnitInteractionPorts,
    options: UnitInteractionOptions = {},
  ) {
    this.dragThreshold = options.dragThreshold ?? 1.5;
    this.waypointSpacing = options.waypointSpacing ?? 6;
  }

  attach(source: PointerEventSource): void {
    source.addPointerListener("pointerdown", this.onDown);
    source.addPointerListener("pointermove", this.onMove);
    source.addPointerListener("pointerup", this.onUp);
  }

  detach(source: PointerEventSource): void {
    source.removePointerListener("pointerdown", this.onDown);
    source.removePointerListener("pointermove", this.onMove);
    source.removePointerListener("pointerup", this.onUp);
    this.mode = "idle";
    this.armed = null;
    this.waypoints = [];
    this.ports.onOrderPreview?.(null);
  }

  get selected(): readonly string[] {
    return [...this.selection];
  }

  setSelection(ids: readonly string[]): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.ports.onSelectionChange?.(this.selected);
  }

  /** Keyboard shortcut for the current selection (§9A). */
  shortcut(key: string): ShortcutOutcome {
    const refs = this.commandableSelection();
    const outcome = orderShortcut(key, refs, this.emitOptions(refs));
    if (outcome.kind === "arm") {
      this.armed = { mode: outcome.mode, pace: outcome.pace };
      this.mode = "armed";
    } else if (outcome.kind === "ops" && outcome.ops.length > 0) {
      this.ports.submit(outcome.ops);
    }
    return outcome;
  }

  // ─── pointer state machine ────────────────────────────────────────────────

  private pointerDown(ev: PointerEvt): void {
    const world = screenToWorld(this.ports.camera(), ev.x, ev.y);
    if (ev.button === 2) {
      this.rightDown(world, ev.shiftKey);
      return;
    }
    if (ev.button !== 0) return;
    if (this.mode === "armed" && this.armed) {
      this.fulfilArmed(world);
      return;
    }
    const hit = this.ports.hitTest(world.x, world.y);
    if (hit) {
      this.mode = "unitDrag";
      this.startUnit = hit;
      this.startWorld = world;
      this.waypoints = [];
      // RTS semantics: pressing a unit already in the selection keeps it (the
      // drag then issues to the whole selection); a fresh press selects alone.
      if (!this.selection.has(hit)) {
        if (!ev.shiftKey) this.selection.clear();
        this.selection.add(hit);
        this.ports.onSelectionChange?.(this.selected);
      } else if (ev.shiftKey) {
        this.selection.delete(hit); // shift-click toggles OFF when already in
        this.ports.onSelectionChange?.(this.selected);
        this.mode = "idle";
        return;
      }
      return;
    }
    this.mode = "marquee";
    this.startWorld = world;
    this.ports.setMarquee(world, world);
  }

  private pointerMove(ev: PointerEvt): void {
    const world = screenToWorld(this.ports.camera(), ev.x, ev.y);
    switch (this.mode) {
      case "marquee":
        this.ports.setMarquee(this.startWorld, world);
        return;
      case "unitDrag": {
        if (!this.startUnit) return;
        const dist = Math.hypot(world.x - this.startWorld.x, world.y - this.startWorld.y);
        if (dist < this.dragThreshold && this.waypoints.length === 0) return; // still a click
        this.waypoints = captureWaypoints(this.waypoints, world, this.waypointSpacing);
        const target = this.ports.hitTest(world.x, world.y);
        const anchor = this.ports.getUnitAnchor?.(this.startUnit) ?? this.startWorld;
        const preview: OrderPreview =
          target && target !== this.startUnit
            ? { kind: "attack", from: anchor, to: this.ports.getUnitAnchor?.(target) ?? world }
            : {
                kind: "move",
                from: anchor,
                points: [...this.waypoints],
                pace: "march",
                lengthWorld: measurePath(this.grid(), [anchor, ...this.waypoints]),
              };
        this.ports.onOrderPreview?.(preview);
        return;
      }
      default:
        return;
    }
  }

  private pointerUp(ev: PointerEvt): void {
    const world = screenToWorld(this.ports.camera(), ev.x, ev.y);
    switch (this.mode) {
      case "marquee": {
        this.ports.setMarquee(null);
        const x = Math.min(this.startWorld.x, world.x);
        const y = Math.min(this.startWorld.y, world.y);
        if (
          Math.abs(world.x - this.startWorld.x) < 1e-6 &&
          Math.abs(world.y - this.startWorld.y) < 1e-6
        ) {
          this.selection.clear(); // click on empty space clears
          this.ports.onSelectionChange?.(this.selected);
          this.mode = "idle";
          return;
        }
        const rect: WorldRect = {
          x,
          y,
          width: Math.abs(world.x - this.startWorld.x),
          height: Math.abs(world.y - this.startWorld.y),
        };
        const hits = this.ports.unitsInRect(rect);
        for (const id of hits) this.selection.add(id);
        this.ports.onSelectionChange?.(this.selected);
        this.mode = "idle";
        return;
      }
      case "unitDrag": {
        const unit = this.startUnit;
        this.startUnit = null;
        this.mode = "idle";
        this.ports.onOrderPreview?.(null);
        if (!unit) return;
        const dist = Math.hypot(world.x - this.startWorld.x, world.y - this.startWorld.y);
        if (dist < this.dragThreshold && this.waypoints.length === 0) return; // plain select
        const target = this.ports.hitTest(world.x, world.y);
        const refs = this.commandableSelection(unit);
        if (target && target !== unit) {
          this.ports.submit(attackOrderOps(target, this.emitOptions(refs)));
          return;
        }
        const path = captureWaypoints(this.waypoints, world, this.waypointSpacing);
        this.ports.submit(moveOrderOps([...path, world], "march", this.emitOptions(refs)));
        return;
      }
      default:
        this.mode = "idle";
    }
  }

  // ─── right-click: context orders ──────────────────────────────────────────

  private rightDown(world: Vec2, shiftKey: boolean): void {
    if (this.mode === "armed") {
      this.armed = null; // right-click cancels an armed mode
      this.mode = "idle";
      this.ports.onOrderPreview?.(null);
      return;
    }
    const hit = this.ports.hitTest(world.x, world.y);
    if (hit) {
      this.ports.onContextMenu?.(world, hit, this.selected);
      return;
    }
    const refs = this.commandableSelection();
    if (refs.length === 0) return;
    if (shiftKey) {
      // shift+right-click appends a waypoint to the existing pending move
      for (const ref of refs) {
        const queue = this.ports.getPendingOrders?.(ref.unitId) ?? null;
        const last = queue?.[queue.length - 1];
        if (!last || last.kind !== "move") continue;
        const path = captureWaypoints(last.path, world, this.waypointSpacing);
        this.ports.submit(moveOrderOps([...path, world], last.pace, this.emitOptions([ref])));
      }
      return;
    }
    this.ports.submit(moveOrderOps([world], "march", this.emitOptions(refs)));
  }

  // ─── armed-mode fulfilment (shortcuts m/c/a/r) ────────────────────────────

  private fulfilArmed(world: Vec2): void {
    const armed = this.armed;
    this.armed = null;
    this.mode = "idle";
    if (!armed) return;
    const refs = this.commandableSelection();
    if (refs.length === 0) return;
    if (armed.mode === "attack") {
      const target = this.ports.hitTest(world.x, world.y);
      if (target) this.ports.submit(attackOrderOps(target, this.emitOptions(refs)));
      return;
    }
    if (armed.mode === "retreat") {
      this.ports.submit(retreatOrderOps(world, this.emitOptions(refs)));
      return;
    }
    this.ports.submit(moveOrderOps([world], armed.pace ?? "march", this.emitOptions(refs)));
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private grid(): MeasureGrid | null {
    return this.ports.getGrid?.() ?? null;
  }

  private emitOptions(refs: readonly UnitOrderRef[]): EmitOptions {
    return {
      units: refs,
      ctx: this.ports.issueContext(),
      validate: this.ports.validate,
      onInvalid: (unitId, _order, error) => this.ports.onInvalidOrder?.(unitId, error),
    };
  }

  /** Selection filtered to commandable units (ownership gate). */
  private commandableSelection(alsoInclude?: string): UnitOrderRef[] {
    const out: UnitOrderRef[] = [];
    const seen = new Set<string>();
    const ids = alsoInclude ? [...this.selection, alsoInclude] : [...this.selection];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!this.ports.canCommand(id)) continue;
      const ref = this.ports.unitRef(id);
      if (ref) out.push(ref);
    }
    return out;
  }
}
