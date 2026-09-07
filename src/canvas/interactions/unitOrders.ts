/**
 * §9A unit orders — gesture/keyboard intents → OrderQueue update Ops.
 *
 * Orders live on embedded Unit documents (§4A): one update Op per unit with
 * the parent army ref. Gestures REPLACE the pending queue (the order editor
 * in the Armies tab owns full queue editing); the RulesModule's validateOrder
 * gates every emitted order when a validator is wired.
 */
import type { Order, OrderQueue, Vec2 } from "../../core/strategic";
import type { Json } from "../../core/documents";

/** pace of a §4A move order, extracted without touching the §0 contract. */
type MovePace = Extract<Order, { kind: "move" }>["pace"];
import type { Op } from "../../core/ops";
import type { OkOrErr } from "../../core/result";
import { measurePath, type MeasureGrid } from "../grid/measure";

/** Max waypoints per §4A Order grammar (mass-battle-basic: path ≤ 12). */
export const MAX_WAYPOINTS = 12;

export interface UnitOrderRef {
  unitId: string;
  armyId: string;
}

export interface IssueContext {
  issuedBy: string;
  issuedTurn: number;
}

export type OrderValidator = (unitId: string, order: Order) => OkOrErr | null;

export interface EmitOptions {
  units: readonly UnitOrderRef[];
  ctx: IssueContext;
  validate?: OrderValidator | undefined;
  /** Called with the first validation failure (order editor feedback). */
  onInvalid?: ((unitId: string, order: Order, error: string) => void) | undefined;
}

function queueWith(order: Order, ctx: IssueContext): OrderQueue {
  return { pending: [order], issuedBy: ctx.issuedBy, issuedTurn: ctx.issuedTurn };
}

function emit(units: readonly UnitOrderRef[], order: Order, options: EmitOptions): Op[] {
  const ops: Op[] = [];
  for (const unit of units) {
    if (options.validate) {
      const verdict = options.validate(unit.unitId, order);
      if (verdict && !verdict.ok) {
        options.onInvalid?.(unit.unitId, order, verdict.error);
        continue;
      }
    }
    ops.push({
      kind: "update",
      ref: {
        coll: "units",
        id: unit.unitId,
        parent: { coll: "armies", id: unit.armyId },
      },
      // Order[] is JSON-serializable by construction (§4A); the named
      // interface just lacks Json's index signature.
      diff: { "orders.pending": queueWith(order, options.ctx).pending as unknown as Json },
    });
  }
  return ops;
}

/** Drag-on-map: move order with waypoints (path capped at MAX_WAYPOINTS). */
export function moveOrderOps(
  path: ReadonlyArray<Vec2>,
  pace: MovePace,
  options: EmitOptions,
): Op[] {
  const trimmed = path
    .slice(0, MAX_WAYPOINTS)
    .map((p) => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
  if (trimmed.length === 0) return [];
  return emit(options.units, { kind: "move", path: trimmed, pace }, options);
}

/** Drag unit → unit (or context attack): attack order. */
export function attackOrderOps(targetUnitId: string, options: EmitOptions): Op[] {
  return emit(options.units, { kind: "attack", targetUnitId }, options);
}

/** Hold stance (shortcut "h" / context). */
export function holdOrderOps(stance: string, options: EmitOptions): Op[] {
  return emit(options.units, { kind: "hold", stance }, options);
}

/** Retreat toward a point (shortcut "r" arms point pick; context uses unit anchor). */
export function retreatOrderOps(toward: Vec2, options: EmitOptions): Op[] {
  return emit(
    options.units,
    { kind: "retreat", toward: { x: +toward.x.toFixed(3), y: +toward.y.toFixed(3) } },
    options,
  );
}

// ─── Keyboard shortcuts (§9A: "keyboard shortcuts for common orders") ────────

export type ShortcutOutcome =
  | { kind: "ops"; ops: Op[] }
  /** Needs pointer input next: move destination / attack target / retreat point. */
  | { kind: "arm"; mode: "move" | "attack" | "retreat"; pace?: MovePace }
  | { kind: "none" };

export const ORDER_SHORTCUTS: Readonly<Record<string, { action: string; label: string }>> = {
  m: { action: "move", label: "Move (march)" },
  c: { action: "charge", label: "Move (charge)" },
  a: { action: "attack", label: "Attack…" },
  h: { action: "hold", label: "Hold" },
  r: { action: "retreat", label: "Retreat toward…" },
};

/**
 * Apply a keyboard shortcut for the current selection. `m`/`c`/`a`/`r` arm a
 * pointer mode (destination/target needed); `h` commits immediately.
 */
export function orderShortcut(
  key: string,
  selection: readonly UnitOrderRef[],
  options: EmitOptions,
): ShortcutOutcome {
  if (selection.length === 0) return { kind: "none" };
  const entry = ORDER_SHORTCUTS[key];
  if (!entry) return { kind: "none" };
  switch (entry.action) {
    case "move":
      return { kind: "arm", mode: "move", pace: "march" };
    case "charge":
      return { kind: "arm", mode: "move", pace: "charge" };
    case "attack":
      return { kind: "arm", mode: "attack" };
    case "retreat":
      return { kind: "arm", mode: "retreat" };
    case "hold":
      return { kind: "ops", ops: holdOrderOps("defend", options) };
    default:
      return { kind: "none" };
  }
}

// ─── Context menu (§9A: "right-click context orders") ────────────────────────

export interface ContextAction {
  id: string;
  label: string;
  /** Arguments the shell needs to fulfil the action, pre-resolved. */
  arm?: "move" | "attack" | "retreat";
  targetUnitId?: string;
  at?: Vec2;
}

/** Menu entries for a right-click. `onUnit` = right-clicked unit (or null). */
export function contextActions(
  at: Vec2,
  onUnit: string | null,
  selection: readonly string[],
): ContextAction[] {
  const out: ContextAction[] = [];
  if (onUnit) {
    if (selection.length > 0)
      out.push({ id: "attack", label: "Attack", arm: "attack", targetUnitId: onUnit });
    out.push(
      { id: "hold", label: "Hold" },
      { id: "retreat", label: "Retreat toward here", arm: "retreat", at },
    );
  } else if (selection.length > 0) {
    out.push(
      { id: "move", label: "Move here", arm: "move", at },
      { id: "charge", label: "Charge here", arm: "move", at },
      { id: "retreat", label: "Retreat toward here", arm: "retreat", at },
      { id: "hold", label: "Hold" },
    );
  }
  return out;
}

// ─── Order preview (live while dragging; the ruler readout) ──────────────────

export type OrderPreview =
  | { kind: "move"; from: Vec2; points: Vec2[]; pace: string; lengthWorld: number }
  | { kind: "attack"; from: Vec2; to: Vec2 }
  | { kind: "retreat"; from: Vec2; to: Vec2 };

export function previewLength(
  grid: MeasureGrid | null,
  from: Vec2,
  points: ReadonlyArray<Vec2>,
): number {
  return measurePath(grid, [from, ...points]);
}
