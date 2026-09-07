import { describe, expect, test } from "vitest";
import { fitRect, screenToWorld, worldToScreen, zoomAt } from "../../src/canvas/camera";
import { snapToGrid, squareGridLines } from "../../src/canvas/grid";
import { dispositionColor, marqueeRect, tokenInMarquee, tokenRect } from "../../src/canvas/tokens";
import {
  installHostLifecycle,
  type Drainable,
  type LifecycleTarget,
} from "../../src/host/lifecycle";

describe("camera (§9)", () => {
  test("world ⇄ screen round-trips", () => {
    const cam = { x: 100, y: 200, scale: 1.5 };
    const screen = worldToScreen(cam, 250, 400);
    expect(screen).toEqual({ x: 225, y: 300 });
    const world = screenToWorld(cam, screen.x, screen.y);
    expect(world).toEqual({ x: 250, y: 400 });
  });

  test("zoomAt pins the world point under the cursor", () => {
    const cam = { x: 0, y: 0, scale: 1 };
    const cursor = { x: 160, y: 120 };
    const before = screenToWorld(cam, cursor.x, cursor.y);
    const zoomed = zoomAt(cam, cursor.x, cursor.y, 2);
    const after = screenToWorld(zoomed, cursor.x, cursor.y);
    expect(after).toEqual(before);
    expect(zoomed.scale).toBe(2);
  });

  test("zoomAt clamps to limits", () => {
    const cam = { x: 0, y: 0, scale: 9.5 };
    expect(zoomAt(cam, 0, 0, 2).scale).toBe(10);
    expect(zoomAt({ ...cam, scale: 0.2 }, 0, 0, 0.5).scale).toBe(0.1);
  });

  test("fitRect centers the rect with padding", () => {
    const cam = fitRect({ x: 0, y: 0, width: 640, height: 480 }, { width: 320, height: 240 }, 20);
    // 640×480 into 320×240 minus padding → scale 0.4375; centers of both align
    const center = screenToWorld(cam, 160, 120);
    expect(center.x).toBeCloseTo(320, 5);
    expect(center.y).toBeCloseTo(240, 5);
  });
});

describe("grid geometry (§9, M1 square subset)", () => {
  test("lines align to cell multiples and cover the viewport", () => {
    const lines = squareGridLines(
      { type: "square", size: 100 },
      { x: -30, y: 250, width: 260, height: 100 },
    );
    expect(lines.verticals).toEqual([0, 100, 200]);
    expect(lines.horizontals).toEqual([300]); // viewport ends at y=350
  });

  test("degenerate viewport and invalid size", () => {
    // viewport spans world [1, 11]: the first multiple of 64 (64) lies outside
    const none = squareGridLines(
      { type: "square", size: 64 },
      { x: 1, y: 1, width: 10, height: 10 },
    );
    expect(none.verticals).toEqual([]);
    expect(() =>
      squareGridLines({ type: "square", size: 0 }, { x: 0, y: 0, width: 10, height: 10 }),
    ).toThrow();
  });

  test("snapToGrid lands on intersections", () => {
    expect(snapToGrid({ type: "square", size: 100 }, 49, 151)).toEqual({ x: 0, y: 200 });
    // Math.round(-0.5) === 0 (JS ties round toward +Infinity)
    expect(snapToGrid({ type: "square", size: 100 }, 50, -50)).toEqual({ x: 100, y: 0 });
    expect(snapToGrid({ type: "square", size: 100 }, -50, -150)).toEqual({ x: 0, y: -100 }); // round(-1.5) = -1
  });
});

describe("token layout math (§9/§10)", () => {
  test("token x/y is the center; rect is top-left", () => {
    expect(tokenRect({ x: 320, y: 240, width: 64, height: 64 })).toEqual({
      x: 288,
      y: 208,
      width: 64,
      height: 64,
    });
  });

  test("marquee normalizes drag corners; hit test covers partial overlap", () => {
    const rect = marqueeRect({ x: 300, y: 200 }, { x: 100, y: 50 });
    expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    const token = { x: 110, y: 60, width: 64, height: 64 };
    expect(tokenInMarquee(token, rect)).toBe(true); // corner overlaps
    expect(tokenInMarquee({ x: 500, y: 400, width: 64, height: 64 }, rect)).toBe(false);
  });

  test("disposition colors are distinct per disposition", () => {
    const colors = new Set(
      ["friendly", "hostile", "neutral"].map((d) => dispositionColor(d as never)),
    );
    expect(colors.size).toBe(3);
  });
});

describe("host lifecycle (§6.5)", () => {
  function makeTarget(): LifecycleTarget & {
    fire(type: string): void;
    listeners: Map<string, Array<() => void>>;
  } {
    const listeners = new Map<string, Array<() => void>>();
    return {
      listeners,
      addEventListener: (type, listener) => {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      removeEventListener: (type, listener) => {
        const list = (listeners.get(type) ?? []).filter((l) => l !== listener);
        listeners.set(type, list);
      },
      fire: (type) => {
        for (const listener of listeners.get(type) ?? []) listener();
      },
    };
  }

  test("beforeunload/pagehide drain the persister", async () => {
    const target = makeTarget();
    let drains = 0;
    const persister: Drainable = { drain: () => ((drains += 1), Promise.resolve()) };
    const remove = installHostLifecycle(persister, target);
    target.fire("beforeunload");
    target.fire("pagehide");
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(2);
    remove();
  });

  test("hidden visibility drains; remove() stops all handling", async () => {
    const target = makeTarget();
    let drains = 0;
    const persister: Drainable = { drain: () => ((drains += 1), Promise.resolve()) };
    const visibilityListeners: Array<() => void> = [];
    const documentLike = {
      visibilityState: "visible",
      addEventListener: (_t: string, l: () => void) => visibilityListeners.push(l),
      removeEventListener: (_t: string, l: () => void) => {
        const i = visibilityListeners.indexOf(l);
        if (i >= 0) visibilityListeners.splice(i, 1);
      },
    };
    (target as unknown as { document?: unknown }).document = documentLike;
    const remove = installHostLifecycle(persister, target);

    const fireVisibility = (): void => {
      for (const l of visibilityListeners) l();
    };
    fireVisibility(); // still visible → no drain
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(0);
    documentLike.visibilityState = "hidden";
    fireVisibility(); // hidden → drain
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(1);

    remove();
    target.fire("beforeunload");
    fireVisibility();
    await new Promise((r) => setTimeout(r, 0));
    expect(drains).toBe(1); // unchanged after remove
  });

  test("interval tick drains periodically", async () => {
    const target = makeTarget();
    let drains = 0;
    const persister: Drainable = { drain: () => ((drains += 1), Promise.resolve()) };
    const remove = installHostLifecycle(persister, target, { flushIntervalMs: 5 });
    await new Promise((r) => setTimeout(r, 18));
    remove();
    const after = drains;
    await new Promise((r) => setTimeout(r, 12));
    expect(drains).toBe(after); // interval cleared
    expect(after).toBeGreaterThanOrEqual(2);
  });
});
