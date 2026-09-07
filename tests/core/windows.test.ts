import { describe, expect, test } from "vitest";
import { WindowManager, MIN_WINDOW_W, MIN_WINDOW_H } from "../../src/core/windows";
import { actionForCombo, comboOf, DEFAULT_BINDINGS, isTypingTarget } from "../../src/core/keys";

describe("window manager (§10)", () => {
  test("open clamps size+position into bounds and assigns z", () => {
    const wm = new WindowManager({ width: 800, height: 600 });
    const w = wm.open({
      id: "a",
      title: "A",
      kind: "test",
      x: 900,
      y: 700,
      width: 5000,
      height: 3000,
    });
    expect(w.width).toBe(800);
    expect(w.height).toBe(600);
    expect(w.x).toBe(0);
    expect(w.y).toBe(0);
    expect(w.z).toBeGreaterThan(0);
    expect(w.minimized).toBe(false);
  });

  test("open twice focuses + restores instead of duplicating", () => {
    const wm = new WindowManager({ width: 800, height: 600 });
    wm.open({ id: "a", title: "A", kind: "test", x: 0, y: 0, width: 200, height: 150 });
    wm.toggleMinimize("a");
    const again = wm.open({
      id: "a",
      title: "A",
      kind: "test",
      x: 10,
      y: 10,
      width: 200,
      height: 150,
    });
    expect(wm.list()).toHaveLength(1);
    expect(again.minimized).toBe(false);
  });

  test("focus raises z-order; activeId follows", () => {
    const wm = new WindowManager({ width: 800, height: 600 });
    wm.open({ id: "a", title: "A", kind: "test", x: 0, y: 0, width: 200, height: 150 });
    wm.open({ id: "b", title: "B", kind: "test", x: 40, y: 40, width: 200, height: 150 });
    expect(wm.activeId()).toBe("b");
    wm.focus("a");
    expect(wm.activeId()).toBe("a");
    expect((wm.get("a") as { z: number }).z).toBeGreaterThan((wm.get("b") as { z: number }).z);
    wm.focus("a"); // no-op focus does not churn z
    expect((wm.get("a") as { z: number }).z).toBe((wm.get("a") as { z: number }).z);
  });

  test("move keeps the title bar reachable", () => {
    const wm = new WindowManager({ width: 400, height: 300 });
    wm.open({ id: "a", title: "A", kind: "test", x: 100, y: 100, width: 200, height: 150 });
    wm.move("a", -500, -500);
    const w = wm.get("a") as { x: number; y: number };
    expect(w.x).toBe(-(200 - 60)); // at most width-60 off the left
    expect(w.y).toBe(0);
    wm.move("a", 5000, 5000);
    const w2 = wm.get("a") as { x: number; y: number };
    expect(w2.x).toBe(400 - 60);
    expect(w2.y).toBe(300 - 24);
  });

  test("resize respects min sizes and the parent", () => {
    const wm = new WindowManager({ width: 400, height: 300 });
    wm.open({ id: "a", title: "A", kind: "test", x: 100, y: 100, width: 200, height: 150 });
    wm.resize("a", 10, 10);
    let w = wm.get("a") as { width: number; height: number };
    expect(w.width).toBe(MIN_WINDOW_W);
    expect(w.height).toBe(MIN_WINDOW_H);
    wm.resize("a", 5000, 5000);
    w = wm.get("a") as { width: number; height: number };
    expect(w.width).toBe(400 - 100); // bounds - position
    expect(w.height).toBe(300 - 100);
  });

  test("close removes; setBounds re-clamps everything", () => {
    const wm = new WindowManager({ width: 1000, height: 800 });
    wm.open({ id: "a", title: "A", kind: "test", x: 800, y: 700, width: 200, height: 150 });
    wm.open({ id: "b", title: "B", kind: "test", x: 0, y: 0, width: 200, height: 150 });
    wm.close("b");
    expect(wm.list().map((w) => w.id)).toEqual(["a"]);
    wm.setBounds({ width: 300, height: 200 });
    const a = wm.get("a") as { x: number; y: number; width: number; height: number };
    expect(a.x).toBeLessThanOrEqual(300 - 60);
    expect(a.width).toBeLessThanOrEqual(300);
  });

  test("listeners fire on changes and unsubscribe", () => {
    const wm = new WindowManager({ width: 800, height: 600 });
    let fired = 0;
    const off = wm.onChange(() => fired++);
    wm.open({ id: "a", title: "A", kind: "test", x: 0, y: 0, width: 200, height: 150 });
    wm.move("a", 5, 5);
    off();
    wm.close("a");
    expect(fired).toBe(2);
  });
});

describe("keybindings (§10)", () => {
  test("comboOf normalizes modifiers and case", () => {
    expect(
      comboOf({ key: "z", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
    ).toBe("Control+z");
    expect(
      comboOf({ key: "Y", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    ).toBe("Control+Shift+y");
    expect(
      comboOf({ key: "ArrowUp", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }),
    ).toBe("Alt+ArrowUp");
    expect(
      comboOf({ key: " ", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }),
    ).toBe("Space");
  });

  test("default bindings resolve via actionForCombo", () => {
    expect(actionForCombo("1")).toBe("hotbar.1");
    expect(actionForCombo("Control+z")).toBe("edit.undo");
    expect(actionForCombo("Control+y")).toBe("edit.redo");
    expect(actionForCombo("Control+Shift+`")).toBeNull();
    expect(DEFAULT_BINDINGS["hotbar.5"]).toBe("5");
  });

  test("isTypingTarget flags editable elements", () => {
    const input = { tagName: "INPUT" } as unknown as HTMLElement;
    const div = { tagName: "DIV" } as unknown as HTMLElement;
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as HTMLElement;
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});
