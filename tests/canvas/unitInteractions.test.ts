import { describe, expect, test } from "vitest";
import {
  captureWaypoints,
  cellDistance,
  measurePath,
  measureSegment,
  type MeasureGrid,
} from "../../src/canvas/grid/measure";
import {
  attackOrderOps,
  contextActions,
  holdOrderOps,
  moveOrderOps,
  orderShortcut,
  retreatOrderOps,
  type EmitOptions,
  type UnitOrderRef,
} from "../../src/canvas/interactions/unitOrders";
import {
  orderOverlayGeometry,
  orderVisibility,
  type OverlayUnit,
} from "../../src/canvas/interactions/orderOverlays";
import {
  UnitInteractionController,
  type UnitInteractionPorts,
} from "../../src/canvas/interactions/unitController";
import type { PointerEventSource, PointerEvt } from "../../src/canvas/interactions";
import type { Op } from "../../src/core/ops";
import type { Order, OrderQueue } from "../../src/core/strategic";
import { err, ok } from "../../src/core/result";

const REFS: UnitOrderRef[] = [
  { unitId: "u-a", armyId: "army-1" },
  { unitId: "u-b", armyId: "army-1" },
];

function opts(over: Partial<EmitOptions> = {}): EmitOptions {
  return { units: REFS, ctx: { issuedBy: "pl", issuedTurn: 3 }, ...over };
}

describe("measurement (§9 / §9A ruler)", () => {
  test("cellDistance: 555 / 5105 / euclidean", () => {
    expect(cellDistance("555", 3, 0)).toBe(3);
    expect(cellDistance("555", 3, 3)).toBe(3); // diagonals cost 1
    expect(cellDistance("5105", 3, 0)).toBe(3);
    expect(cellDistance("5105", 1, 1)).toBe(1); // first diagonal 5
    expect(cellDistance("5105", 2, 2)).toBe(3); // 5-10-5
    expect(cellDistance("5105", 4, 3)).toBe(5); // max(4,3)=4 + floor(3/2)=1
    expect(cellDistance("euclidean", 3, 4)).toBeCloseTo(5);
  });

  test("measureSegment/measurePath in world units", () => {
    const grid: MeasureGrid = { type: "square", size: 5, diagonals: "555" };
    // 3 cells right, 3 up → 555: 3 cells → 15 world units
    expect(measureSegment(grid, { x: 0, y: 0 }, { x: 15, y: 15 })).toBe(15);
    expect(
      measurePath(grid, [
        { x: 0, y: 0 },
        { x: 15, y: 0 },
        { x: 15, y: 15 },
      ]),
    ).toBe(30);
    expect(
      measurePath(null, [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ]),
    ).toBeCloseTo(5);
  });

  test("captureWaypoints: spacing, cap, reference stability", () => {
    const a = captureWaypoints([], { x: 0, y: 0 }, 5);
    expect(a).toEqual([{ x: 0, y: 0 }]);
    const same = captureWaypoints(a, { x: 3, y: 0 }, 5);
    expect(same).toBe(a); // too close → same ref
    const grown = captureWaypoints(a, { x: 6, y: 0 }, 5);
    expect(grown).toHaveLength(2);
    let path = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: 0 }));
    path = captureWaypoints(path, { x: 130, y: 0 }, 5);
    expect(path).toHaveLength(12); // capped
  });
});

describe("order intents → ops (§9A)", () => {
  test("moveOrderOps replaces pending with one capped, rounded move order", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ x: i * 1.11111, y: 0 }));
    const ops = moveOrderOps(long, "march", opts());
    expect(ops).toHaveLength(2);
    const first = ops[0];
    expect(first).toMatchObject({
      kind: "update",
      ref: { coll: "units", id: "u-a", parent: { coll: "armies", id: "army-1" } },
    });
    const pending = (first as { diff: Record<string, unknown> }).diff["orders.pending"] as Order[];
    expect(pending).toHaveLength(1);
    const order = pending[0];
    if (order?.kind !== "move") throw new Error("expected move");
    expect(order.pace).toBe("march");
    expect(order.path).toHaveLength(12); // §4A cap
    expect(order.path[0]).toEqual({ x: 0, y: 0 }); // 3-decimal rounding
    expect(moveOrderOps([], "march", opts())).toEqual([]);
  });

  test("attack/hold/retreat ops carry the §4A order shapes", () => {
    const firstPending = (ops: Op[]): Order => {
      const op = ops[0] as unknown as { diff: Record<string, Order[]> };
      const order = op.diff["orders.pending"]?.[0];
      if (!order) throw new Error("no pending order");
      return order;
    };
    expect(firstPending(attackOrderOps("u-enemy", opts()) as Op[])).toMatchObject({
      kind: "attack",
      targetUnitId: "u-enemy",
    });
    expect(firstPending(holdOrderOps("defend", opts()))).toMatchObject({
      kind: "hold",
      stance: "defend",
    });
    expect(firstPending(retreatOrderOps({ x: 10.5555, y: -2.4444 }, opts()))).toMatchObject({
      kind: "retreat",
      toward: { x: 10.556, y: -2.444 },
    });
  });

  test("validator gates orders and reports the first failure per unit", () => {
    const seen: Array<[string, string]> = [];
    const ops = moveOrderOps([{ x: 0, y: 0 }], "march", {
      ...opts(),
      validate: (unitId, order) =>
        order.kind === "move" && unitId === "u-a" ? err("move: empty path") : ok,
      onInvalid: (unitId, _order, error) => seen.push([unitId, error]),
    });
    expect(ops).toHaveLength(1); // u-a blocked, u-b passes
    expect(seen).toEqual([["u-a", "move: empty path"]]);
  });

  test("shortcuts: h commits, m/c/a/r arm, unknown/empty do nothing", () => {
    expect(orderShortcut("h", REFS, opts()).kind).toBe("ops");
    expect(orderShortcut("m", REFS, opts())).toMatchObject({
      kind: "arm",
      mode: "move",
      pace: "march",
    });
    expect(orderShortcut("c", REFS, opts())).toMatchObject({
      kind: "arm",
      mode: "move",
      pace: "charge",
    });
    expect(orderShortcut("a", REFS, opts())).toMatchObject({ kind: "arm", mode: "attack" });
    expect(orderShortcut("r", REFS, opts())).toMatchObject({ kind: "arm", mode: "retreat" });
    expect(orderShortcut("x", REFS, opts()).kind).toBe("none");
    expect(orderShortcut("h", [], opts()).kind).toBe("none");
  });

  test("contextActions per §9A right-click cases", () => {
    const onUnit = contextActions({ x: 1, y: 1 }, "u-b", ["u-a"]);
    expect(onUnit[0]).toMatchObject({ id: "attack", targetUnitId: "u-b" });
    expect(contextActions({ x: 1, y: 1 }, "u-b", []).map((a) => a.id)).toEqual(["hold", "retreat"]);
    const empty = contextActions({ x: 5, y: 5 }, null, ["u-a"]);
    expect(empty.map((a) => a.id)).toEqual(["move", "charge", "retreat", "hold"]);
    expect(contextActions({ x: 5, y: 5 }, null, [])).toEqual([]);
  });
});

describe("order overlays (§9A)", () => {
  const queue = (order: Order | null): OrderQueue | null =>
    order ? { pending: [order], issuedBy: "pl", issuedTurn: 1 } : null;
  const units: OverlayUnit[] = [
    {
      id: "u-a",
      factionId: "f-red",
      color: 0xff0000,
      anchor: { x: 10, y: 10 },
      orders: queue({
        kind: "move",
        path: [
          { x: 20, y: 10 },
          { x: 20, y: 20 },
        ],
        pace: "march",
      }),
    },
    {
      id: "u-b",
      factionId: "f-red",
      color: 0xff0000,
      anchor: { x: 40, y: 40 },
      orders: queue({ kind: "attack", targetUnitId: "u-c" }),
    },
    {
      id: "u-c",
      factionId: "f-blue",
      color: 0x0000ff,
      anchor: { x: 60, y: 60 },
      orders: queue({ kind: "move", path: [{ x: 50, y: 60 }], pace: "charge" }),
    },
    {
      id: "u-d",
      factionId: "f-blue",
      color: 0x0000ff,
      anchor: { x: 0, y: 60 },
      orders: queue({ kind: "hold", stance: "x" }),
    },
  ];

  test("geometry: paths, charges, target lines; hold draws nothing", () => {
    const g = orderOverlayGeometry(units, () => true);
    expect(g.paths).toHaveLength(1); // u-a march
    expect(g.paths[0]?.points).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ]);
    expect(g.charges).toHaveLength(1); // u-c charge
    expect(g.targets).toHaveLength(1); // u-b → u-c
    expect(g.targets[0]).toMatchObject({ unitId: "u-b", targetUnitId: "u-c" });
  });

  test("owning faction sees own orders only; GM sees all", () => {
    const red = orderOverlayGeometry(units, orderVisibility(new Set(["f-red"])));
    expect(red.paths).toHaveLength(1);
    expect(red.charges).toHaveLength(0);
    expect(red.targets).toHaveLength(1); // own attack line (target anchor known)
    const gm = orderOverlayGeometry(units, orderVisibility(null));
    expect(gm.paths).toHaveLength(1);
    expect(gm.charges).toHaveLength(1);
    expect(gm.targets).toHaveLength(1);
  });

  test("retreat orders render as grey paths", () => {
    const g = orderOverlayGeometry(
      [
        {
          id: "u-r",
          factionId: "f",
          color: 0xffffff,
          anchor: { x: 0, y: 0 },
          orders: queue({ kind: "retreat", toward: { x: 9, y: 9 } }),
        },
      ],
      () => true,
    );
    expect(g.paths[0]?.pace).toBe("retreat");
    expect(g.paths[0]?.color).toBe(0x9aa0a8);
  });
});

// ─── controller (fake ports, full state machine) ─────────────────────────────

function pendingAt(ops: Op[] | undefined, index: number): Order {
  const op = ops?.[index] as unknown as { diff: Record<string, Order[]> } | undefined;
  const order = op?.diff["orders.pending"]?.[0];
  if (!order) throw new Error("no pending order");
  return order;
}

interface Harness {
  controller: UnitInteractionController;
  submitted: Op[][];
  previews: unknown[];
  menus: Array<{ at: { x: number; y: number }; onUnit: string | null }>;
  invalid: Array<[string, string]>;
  dispatch(ev: Partial<PointerEvt> & { phase?: "pointerdown" | "pointermove" | "pointerup" }): void;
}

function harness(over: Partial<UnitInteractionPorts> = {}): Harness {
  const submitted: Op[][] = [];
  const previews: unknown[] = [];
  const menus: Array<{ at: { x: number; y: number }; onUnit: string | null }> = [];
  const invalid: Array<[string, string]> = [];
  const pending = new Map<string, Order[]>();
  const anchors: Record<string, { x: number; y: number }> = {
    "u-a": { x: 10, y: 10 },
    "u-b": { x: 40, y: 40 },
    "u-enemy": { x: 80, y: 80 },
  };
  const ports: UnitInteractionPorts = {
    camera: () => ({ x: 0, y: 0, scale: 1 }),
    setMarquee: () => {},
    hitTest: (x, y) => {
      for (const [id, a] of Object.entries(anchors)) {
        if (Math.hypot(x - a.x, y - a.y) <= 2) return id;
      }
      return null;
    },
    unitsInRect: (rect) => {
      const out = new Set<string>();
      for (const [id, a] of Object.entries(anchors)) {
        if (
          a.x >= rect.x &&
          a.x <= rect.x + rect.width &&
          a.y >= rect.y &&
          a.y <= rect.y + rect.height
        )
          out.add(id);
      }
      return out;
    },
    unitRef: (id) => ({ unitId: id, armyId: "army-1" }),
    canCommand: (id) => id !== "u-enemy",
    submit: (ops) => submitted.push(ops),
    issueContext: () => ({ issuedBy: "pl", issuedTurn: 3 }),
    getPendingOrders: (id) => pending.get(id) ?? null,
    getUnitAnchor: (id) => anchors[id] ?? null,
    onSelectionChange: () => {},
    onOrderPreview: (p) => previews.push(p),
    onContextMenu: (at, onUnit) => menus.push({ at, onUnit }),
    onInvalidOrder: (unitId, error) => invalid.push([unitId, error]),
    ...over,
  };
  const controller = new UnitInteractionController(ports, { dragThreshold: 2, waypointSpacing: 5 });
  const listeners = new Map<string, (ev: PointerEvt) => void>();
  const source: PointerEventSource = {
    addPointerListener: (type, cb) => listeners.set(type, cb),
    removePointerListener: (type) => listeners.delete(type),
    addWheelListener: () => {},
    removeWheelListener: () => {},
  };
  controller.attach(source);
  const dispatch = (
    ev: Partial<PointerEvt> & { phase?: "pointerdown" | "pointermove" | "pointerup" },
  ): void => {
    const phase = ev.phase ?? "pointerdown";
    const cb = listeners.get(phase);
    if (!cb) throw new Error("no listener for " + phase);
    cb({
      x: ev.x ?? 0,
      y: ev.y ?? 0,
      button: ev.button ?? 0,
      shiftKey: ev.shiftKey ?? false,
      pointerId: 1,
      preventDefault: () => {},
    });
  };
  return { controller, submitted, previews, menus, invalid, dispatch };
}

describe("UnitInteractionController (§9A)", () => {
  test("click selects a unit; shift adds; empty click clears", () => {
    const h = harness();
    h.dispatch({ x: 10, y: 10, phase: "pointerdown" });
    h.dispatch({ x: 10, y: 10, phase: "pointerup" });
    expect(h.controller.selected).toEqual(["u-a"]);
    h.dispatch({ x: 40, y: 40, shiftKey: true, phase: "pointerdown" });
    h.dispatch({ x: 40, y: 40, phase: "pointerup" });
    expect(h.controller.selected).toEqual(["u-a", "u-b"]);
    h.dispatch({ x: 100, y: 100, phase: "pointerdown" });
    h.dispatch({ x: 100, y: 100, phase: "pointerup" });
    expect(h.controller.selected).toEqual([]);
  });

  test("marquee drag box-selects units", () => {
    const h = harness();
    h.dispatch({ x: 5, y: 5, phase: "pointerdown" });
    h.dispatch({ x: 45, y: 45, phase: "pointermove" });
    h.dispatch({ x: 45, y: 45, phase: "pointerup" });
    expect(h.controller.selected).toEqual(["u-a", "u-b"]);
  });

  test("drag unit → enemy unit submits attack ops for the commandable selection", () => {
    const h = harness();
    h.controller.setSelection(["u-a", "u-b"]);
    h.dispatch({ x: 10, y: 10, phase: "pointerdown" });
    h.dispatch({ x: 30, y: 30, phase: "pointermove" });
    h.dispatch({ x: 80, y: 80, phase: "pointerup" });
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toHaveLength(2); // both selected units
    const order = pendingAt(h.submitted[0], 0);
    expect(order).toMatchObject({ kind: "attack", targetUnitId: "u-enemy" });
  });

  test("drag unit → empty submits a move order with spaced waypoints + release point", () => {
    const h = harness();
    h.dispatch({ x: 10, y: 10, phase: "pointerdown" });
    h.dispatch({ x: 16, y: 10, phase: "pointermove" }); // ≥5 from start? from last captured…
    h.dispatch({ x: 23, y: 10, phase: "pointermove" });
    h.dispatch({ x: 27, y: 10, phase: "pointerup" }); // final point always appended
    const order = pendingAt(h.submitted[0], 0);
    if (order?.kind !== "move") throw new Error("expected move");
    expect(order.path[0]?.x).toBeGreaterThanOrEqual(15); // first capture ≥ spacing from drag start
    expect(order.path[order.path.length - 1]).toEqual({ x: 27, y: 10 });
  });

  test("drag previews expose the ruler length and attack target", () => {
    const h = harness();
    h.dispatch({ x: 10, y: 10, phase: "pointerdown" });
    h.dispatch({ x: 20, y: 10, phase: "pointermove" });
    const move = h.previews.at(-1) as { kind: string; lengthWorld: number };
    expect(move.kind).toBe("move");
    expect(move.lengthWorld).toBeGreaterThan(0);
    h.dispatch({ x: 80, y: 80, phase: "pointermove" });
    const atk = h.previews.at(-1) as { kind: string; to: { x: number; y: number } };
    expect(atk.kind).toBe("attack");
    expect(atk.to).toEqual({ x: 80, y: 80 });
    h.dispatch({ x: 80, y: 80, phase: "pointerup" });
    expect(h.previews.at(-1)).toBeNull(); // preview cleared
  });

  test("right-click on empty = move-here for selection; on unit opens context menu", () => {
    const h = harness();
    h.controller.setSelection(["u-a"]);
    h.dispatch({ x: 55, y: 55, button: 2, phase: "pointerdown" });
    const order = pendingAt(h.submitted[0], 0);
    expect(order).toMatchObject({ kind: "move", path: [{ x: 55, y: 55 }] });
    h.dispatch({ x: 40, y: 40, button: 2, phase: "pointerdown" });
    expect(h.menus).toEqual([{ at: { x: 40, y: 40 }, onUnit: "u-b" }]);
  });

  test("shortcuts: h holds now; m arms move; click commits; right-click cancels", () => {
    const h = harness();
    h.controller.setSelection(["u-a"]);
    expect(h.controller.shortcut("h").kind).toBe("ops");
    expect(h.submitted[0]?.[0]).toMatchObject({ kind: "update" });
    expect(h.controller.shortcut("m")).toMatchObject({ kind: "arm" });
    h.dispatch({ x: 50, y: 12, phase: "pointerdown" }); // armed fulfil on empty
    const order = pendingAt(h.submitted[1], 0);
    expect(order).toMatchObject({ kind: "move", path: [{ x: 50, y: 12 }] });
    // arm + cancel
    expect(h.controller.shortcut("a")).toMatchObject({ kind: "arm" });
    h.dispatch({ x: 10, y: 10, button: 2, phase: "pointerdown" });
    h.dispatch({ x: 80, y: 80, phase: "pointerdown" }); // normal click again
    expect(h.submitted).toHaveLength(2); // nothing new
  });

  test("ownership gate: enemy units never receive orders", () => {
    const h = harness();
    h.controller.setSelection(["u-enemy"]);
    expect(h.controller.shortcut("h").kind).toBe("none"); // selection fully filtered
    expect(h.submitted).toHaveLength(0);
  });

  test("validator failures surface via onInvalidOrder and block submit", () => {
    const h = harness({
      validate: (_id, order) => (order.kind === "attack" ? err("attack: no target in range") : ok),
    });
    h.controller.setSelection(["u-a"]);
    h.dispatch({ x: 10, y: 10, phase: "pointerdown" });
    h.dispatch({ x: 80, y: 80, phase: "pointerup" });
    expect(h.submitted[0]).toHaveLength(0);
    expect(h.invalid).toEqual([["u-a", "attack: no target in range"]]);
  });
});
