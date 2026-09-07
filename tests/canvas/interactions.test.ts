import { describe, expect, test } from "vitest";
import {
  CanvasController,
  dragTarget,
  panByScreen,
  pickToken,
  type IntentSink,
  type PointerEventSource,
  type PointerEvt,
  type StageLike,
  type TokenView,
  type WheelEvt,
} from "../../src/canvas/interactions";
import type { TokenDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { Camera } from "../../src/canvas/camera";
import type { SquareGrid } from "../../src/canvas/grid";

// ─── fakes ────────────────────────────────────────────────────────────────────

function token(id: string, x: number, y: number, over: Partial<TokenDocument> = {}): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x,
    y,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#fff", alpha: 0.5 },
    ...over,
  };
}

function view(t: TokenDocument, sceneId = "s1"): TokenView {
  return { token: t, sceneId };
}

class FakeSource implements PointerEventSource {
  readonly pointer: {
    pointerdown: Array<(ev: PointerEvt) => void>;
    pointermove: Array<(ev: PointerEvt) => void>;
    pointerup: Array<(ev: PointerEvt) => void>;
  } = {
    pointerdown: [],
    pointermove: [],
    pointerup: [],
  };
  wheel: Array<(ev: WheelEvt) => void> = [];

  addPointerListener(
    type: "pointerdown" | "pointermove" | "pointerup",
    cb: (ev: PointerEvt) => void,
  ): void {
    this.pointer[type].push(cb);
  }
  removePointerListener(
    type: "pointerdown" | "pointermove" | "pointerup",
    cb: (ev: PointerEvt) => void,
  ): void {
    this.pointer[type] = this.pointer[type].filter((c) => c !== cb);
  }
  addWheelListener(cb: (ev: WheelEvt) => void): void {
    this.wheel.push(cb);
  }
  removeWheelListener(cb: (ev: WheelEvt) => void): void {
    this.wheel = this.wheel.filter((c) => c !== cb);
  }

  down(x: number, y: number, opts: Partial<PointerEvt> = {}): void {
    for (const cb of [...this.pointer.pointerdown]) {
      cb({
        x,
        y,
        button: 0,
        shiftKey: false,
        pointerId: 1,
        preventDefault: () => undefined,
        ...opts,
      });
    }
  }
  move(x: number, y: number): void {
    for (const cb of [...this.pointer.pointermove]) {
      cb({ x, y, button: 0, shiftKey: false, pointerId: 1, preventDefault: () => undefined });
    }
  }
  up(x: number, y: number): void {
    for (const cb of [...this.pointer.pointerup]) {
      cb({ x, y, button: 0, shiftKey: false, pointerId: 1, preventDefault: () => undefined });
    }
  }
  spin(x: number, y: number, deltaY: number): void {
    for (const cb of [...this.wheel]) {
      cb({ x, y, deltaX: 0, deltaY, preventDefault: () => undefined });
    }
  }
}

class FakeStage implements StageLike {
  cameraValue: Camera = { x: 0, y: 0, scale: 1 };
  tokenRenders: TokenDocument[][] = [];
  marquees: Array<{ a: { x: number; y: number } | null; b?: { x: number; y: number } }> = [];

  get camera(): Camera {
    return this.cameraValue;
  }
  setCamera(camera: Camera): void {
    this.cameraValue = camera;
  }
  syncTokens(tokens: readonly TokenDocument[]): void {
    this.tokenRenders.push([...tokens]);
  }
  setMarquee(a: { x: number; y: number } | null, b?: { x: number; y: number }): void {
    this.marquees.push({ a, ...(b !== undefined ? { b } : {}) });
  }
}

class RecordingClient implements IntentSink {
  readonly submitted: Op[][] = [];
  submit(ops: Op[]): unknown {
    this.submitted.push(ops);
    return ops.length;
  }
}

function makeHarness(
  tokens: TokenView[],
  opts: { grid?: SquareGrid | null; canMove?: boolean } = {},
) {
  const stage = new FakeStage();
  const source = new FakeSource();
  const client = new RecordingClient();
  const selectionChanges: string[][] = [];
  const pings: Array<{ x: number; y: number }> = [];
  const rulerChanges: Array<Array<{ x: number; y: number }>> = [];
  const controller = new CanvasController({
    stage,
    source,
    client,
    getTokens: () => tokens,
    getGrid: (): SquareGrid | null =>
      opts.grid === undefined ? { type: "square", size: 100 } : opts.grid,
    canMove: () => opts.canMove ?? true,
    onSelectionChange: (sel) => selectionChanges.push([...sel]),
    onPing: (world) => pings.push({ x: world.x, y: world.y }),
    onRulerChange: (points) => rulerChanges.push([...points]),
  });
  return { stage, source, client, controller, selectionChanges, pings, rulerChanges };
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("interaction math (§10)", () => {
  const views = [view(token("a", 50, 50)), view(token("b", 300, 200))];

  test("pickToken hits topmost (later wins) and misses outside", () => {
    expect(pickToken(views, { x: 10, y: 10 })?.token._id).toBe("a");
    expect(pickToken(views, { x: 260, y: 180 })?.token._id).toBe("b");
    expect(pickToken(views, { x: 500, y: 500 })).toBeUndefined();
  });

  test("panByScreen shifts the world opposite the drag, scaled", () => {
    const panned = panByScreen({ x: 100, y: 100, scale: 2 }, 40, -20);
    expect(panned).toEqual({ x: 80, y: 110, scale: 2 });
  });

  test("dragTarget snaps to grid intersections when a grid is given", () => {
    const grid: SquareGrid = { type: "square", size: 100 };
    // 100+30=130→100 ; 100−60=40→0
    expect(dragTarget({ x: 100, y: 100 }, { x: 30, y: -60 }, grid)).toEqual({ x: 100, y: 0 });
    expect(dragTarget({ x: 100, y: 100 }, { x: 60, y: 60 }, grid)).toEqual({ x: 200, y: 200 });
    expect(dragTarget({ x: 100, y: 100 }, { x: 33, y: 21 }, null)).toEqual({ x: 133, y: 121 });
  });
});

// ─── controller state machine ─────────────────────────────────────────────────

describe("CanvasController (§10)", () => {
  test("token drag: preview follows the pointer; release submits one snapped move op", () => {
    const t = token("hero", 100, 100);
    const h = makeHarness([view(t)]);
    h.source.down(100, 100); // on the token (center 100,100 = screen 100,100)
    h.source.move(140, 130); // world delta +40,+30
    h.source.up(140, 130);

    expect(h.client.submitted).toHaveLength(1);
    const op = h.client.submitted[0]?.[0];
    expect(op).toMatchObject({
      kind: "update",
      ref: { coll: "tokens", id: "hero", parent: { coll: "scenes", id: "s1" } },
    });
    // snapped: center+delta = (140,130) → snap → (100,100)
    if (op?.kind === "update") expect(op.diff).toEqual({ x: 100, y: 100 });
    else throw new Error("expected update op");

    // live preview rendered the UNSNAPPED position during the drag
    const duringDrag = h.stage.tokenRenders[0]?.[0];
    expect(duringDrag).toMatchObject({ _id: "hero", x: 140, y: 130 });
  });

  test("drag without grid submits the raw delta", () => {
    const t = token("free", 200, 200);
    const h = makeHarness([view(t)], { grid: null });
    h.source.down(200, 200);
    h.source.move(250, 220);
    h.source.up(250, 220);
    const op = h.client.submitted[0]?.[0];
    if (op?.kind === "update") expect(op.diff).toEqual({ x: 250, y: 220 });
    else throw new Error("expected update op");
  });

  test("unowned tokens select but never drag or submit", () => {
    const t = token("enemy", 100, 100);
    const h = makeHarness([view(t)], { canMove: false });
    h.source.down(100, 100);
    h.source.move(150, 150);
    h.source.up(150, 150);
    expect(h.client.submitted).toHaveLength(0);
    expect(h.stage.tokenRenders).toHaveLength(0); // no previews
    expect(h.selectionChanges).toEqual([["enemy"]]); // selection still works
  });

  test("empty-space drag = marquee; only banded tokens are selected", () => {
    const a = token("a", 50, 50); // rect 0..100 (left of the band)
    const b = token("b", 250, 250); // rect 200..300 (inside)
    const c = token("c", 500, 500); // rect 450..550 (beyond)
    const h = makeHarness([view(a), view(b), view(c)]);
    // start at (150,150): empty space (between a and b) → marquee, not drag
    h.source.down(150, 150);
    h.source.move(340, 340);
    h.source.up(340, 340);
    expect(h.controller.selected).toEqual(["b"]);
    const lastMarquee = h.stage.marquees[h.stage.marquees.length - 1];
    expect(lastMarquee?.a).toBeNull(); // cleared on release
  });

  test("marquee normalizes reversed drags", () => {
    const a = token("a", 50, 50);
    const h = makeHarness([view(a)]);
    h.source.down(300, 300);
    h.source.up(20, 20); // dragged up-left
    expect(h.controller.selected).toEqual(["a"]);
  });

  test("middle-drag pans the camera; wheel zooms at the cursor", () => {
    const h = makeHarness([]);
    h.source.down(200, 150, { button: 1 });
    h.source.move(180, 170); // drag left-down 20px
    h.source.up(180, 170);
    expect(h.stage.cameraValue).toEqual({ x: 20, y: -20, scale: 1 });

    h.source.spin(200, 150, -100); // zoom in
    expect(h.stage.cameraValue.scale).toBeGreaterThan(1);
    h.source.spin(200, 150, 100); // and back out
    expect(h.stage.cameraValue.scale).toBeCloseTo(1, 5);
  });

  test("click on empty space clears the selection via empty marquee", () => {
    const a = token("a", 50, 50);
    const h = makeHarness([view(a)]);
    h.source.down(10, 10);
    h.source.up(10, 10); // zero-size marquee over empty space (a spans 0..100: 10,10 IS on a? no: a center 50,50 → rect 0..100: (10,10) hits a)
    expect(h.controller.selected).toEqual(["a"]); // actually inside a
    // now truly empty:
    h.source.down(400, 400);
    h.source.up(410, 410);
    expect(h.controller.selected).toEqual([]);
  });

  test("destroy removes all listeners", () => {
    const h = makeHarness([]);
    h.controller.destroy();
    h.source.down(100, 100);
    h.source.move(200, 200);
    h.source.up(200, 200);
    h.source.spin(100, 100, -100);
    expect(h.stage.tokenRenders).toHaveLength(0);
    expect(h.stage.cameraValue).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

// ─── §9 ephemera interactions (D-083) ────────────────────────────────────────

describe("canvas ephemera interactions (§9)", () => {
  test("alt+click emits a ping at the world point; no selection or drag starts", () => {
    const h = makeHarness([view(token("a", 50, 50))]);
    h.source.down(40, 40, { altKey: true });
    expect(h.pings).toEqual([{ x: 40, y: 40 }]);
    expect(h.selectionChanges).toHaveLength(0); // ping is not a selection
    expect(h.stage.marquees).toHaveLength(0);
    // a following plain click on EMPTY space still works (mode stayed idle)
    h.source.down(400, 300);
    expect(h.stage.marquees.length).toBeGreaterThanOrEqual(1);
  });

  test("ctrl+click appends snapped ruler waypoints and clearRuler emits []", () => {
    const h = makeHarness([]);
    h.source.down(95, 5, { ctrlKey: true }); // snaps to (100, 0)
    h.source.down(295, 105, { ctrlKey: true }); // snaps to (300, 100)
    expect(h.controller.ruler).toEqual([
      { x: 100, y: 0 },
      { x: 300, y: 100 },
    ]);
    expect(h.rulerChanges).toEqual([
      [{ x: 100, y: 0 }],
      [
        { x: 100, y: 0 },
        { x: 300, y: 100 },
      ],
    ]);
    h.controller.clearRuler();
    expect(h.rulerChanges.at(-1)).toEqual([]);
    expect(h.controller.ruler).toHaveLength(0);
  });

  test("ruler waypoints cap at 12; destroy resets state", () => {
    const h = makeHarness([]);
    for (let i = 0; i < 15; i++) {
      h.source.down(i * 100 + 50, 50, { ctrlKey: true });
    }
    expect(h.controller.ruler).toHaveLength(12);
    h.controller.destroy();
    expect(h.controller.ruler).toHaveLength(0);
  });
});
