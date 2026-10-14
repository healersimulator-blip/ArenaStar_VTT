import { expect, test } from "@playwright/test";
import { chromeAction, entry, openSceneNav } from "./lib";

test.describe("window manager + GM tools (§10)", () => {
  test("windows open, drag, resize, z-order", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await chromeAction(page, "gm-perms");
    const win = page.locator('[data-window="permissions"]');
    await expect(win).toBeVisible();
    const before = await win.boundingBox();

    // drag by the title bar (far enough that a second window won't overlap)
    const title = win.locator(".wm-title");
    const tb = await title.boundingBox();
    if (!tb) throw new Error("no title box");
    await page.mouse.move(tb.x + 60, tb.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb.x + 420, tb.y + 200, { steps: 6 });
    await page.mouse.up();
    const after = await win.boundingBox();
    expect(after?.x).toBeGreaterThan((before?.x ?? 0) + 60);
    expect(after?.y).toBeGreaterThan((before?.y ?? 0) + 40);

    // resize via the corner handle (styles are imperative — let them settle)
    await page.waitForTimeout(200);
    const rb = await win.boundingBox();
    if (!rb) throw new Error("no window box");
    await page.mouse.move(rb.x + rb.width - 4, rb.y + rb.height - 4);
    await page.mouse.down();
    await page.mouse.move(rb.x + rb.width - 104, rb.y + rb.height - 84, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const resized = await win.boundingBox();
    expect(resized?.width).toBeLessThan(rb.width - 50);
    expect(resized?.height).toBeLessThan(rb.height - 50);

    // a second window opens on top; clicking the first raises it
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    const zTop = async (): Promise<number> => {
      const zs = await page.evaluate(() => {
        const els = [...document.querySelectorAll<HTMLElement>(".wm-window")];
        return Object.fromEntries(els.map((el) => [el.dataset.window ?? "", el.style.zIndex]));
      });
      return Number(zs["settings"] ?? 0) - Number(zs["permissions"] ?? 0);
    };
    expect(await zTop()).toBeGreaterThan(0);
    await win.locator(".wm-title").click();
    expect(await zTop()).toBeLessThan(0);

    // close
    await settings.locator("[data-window-close]").click();
    await expect(settings).toHaveCount(0);
  });

  test("undo/redo: token create reverts and restores", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click("#add-token");
    await expect(page.locator("#status")).toContainText("tokens 1");
    await page.click("#gm-undo");
    await expect(page.locator("#status")).toContainText("tokens 0");
    await page.click("#gm-redo");
    await expect(page.locator("#status")).toContainText("tokens 1");
  });

  test("macros: create, slot, hotbar click + key run", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click("#gm-macros");
    await page.fill("[data-macro-name]", "wave");
    await page.fill("[data-macro-command]", "/me waves a flag");
    await page.click("[data-macro-create]");
    await expect(page.locator("[data-macro]")).toHaveCount(1);
    await page.selectOption("[data-macro-slot]", "1");
    // hotbar slot shows the macro name (MC-01 renamed the slot attribute to
    // `data-hotbar-slot`, so this is one row for both shells: `MacroHotbar.svelte`)
    await expect(page.locator(".hotbar [data-hotbar-slot='1']")).toContainText("wave");
    await page.locator(".hotbar [data-hotbar-slot='1']").click();
    await expect(page.locator("#chat-log")).toContainText("waves a flag");
    // a second run via the keyboard
    await page.locator("#chat-input").click();
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("2"); // empty slot: no-op, focus must not be in an input
    await page.keyboard.press("1");
    await expect(page.locator("#chat-log .emote")).toHaveCount(2);
  });

  test("armies window mounts through normal WindowHost navigation (M14)", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    // The GM toolbar's Armies button opens the armies tab inside the standard
    // window manager chrome — the same chrome Permissions/Macros/Settings use.
    // Before M14 this surface only existed via the e2eHook harness.
    await chromeAction(page, "gm-armies");
    const win = page.locator('[data-window="armies"]');
    await expect(win).toBeVisible();
    await expect(win.locator(".armies")).toBeVisible();
    // An empty world still renders the honest empty state, and the window
    // respects the standard chrome (minimize/close buttons present).
    await expect(win.locator(".armies .empty")).toHaveText("No armies in this world yet.");
    await expect(win.locator("[data-window-min]")).toBeVisible();
    await expect(win.locator("[data-window-close]")).toBeVisible();
    await page.click('[data-window="armies"] [data-window-close]');
    await expect(win).toHaveCount(0);
  });

  test("settings: grid size op lands and scene nav switches scenes", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click("#gm-settings");
    await page.fill("[data-grid-size]", "77");
    await page.locator("[data-grid-size]").press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const surface = (
            globalThis as unknown as { __vttE2E?: { app: { gridSize(): number | null } | null } }
          ).__vttE2E;
          return surface?.app?.gridSize() ?? null;
        }),
      )
      .toBe(77);

    await openSceneNav(page); await page.click("#scene-add");
    await page.click("#scene-new-blank");
    await expect(page.locator(".scenenav [data-scene]")).toHaveCount(2);
    const second = page.locator(".scenenav [data-scene]").nth(1);
    await openSceneNav(page); await second.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const surface = (
            globalThis as unknown as {
              __vttE2E?: { app: { activeSceneId(): string | null } | null };
            }
          ).__vttE2E;
          return surface?.app?.activeSceneId() ?? null;
        }),
      )
      .not.toBe("scene-1");
  });

  test("permissions window lists users; journal popout opens in a window", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await chromeAction(page, "gm-perms");
    await expect(page.locator("[data-perm-users] tbody tr")).toHaveCount(1); // the GM
    await page.click("[data-window-close]");

    await page.click('[data-tab="journals"]');
    await page.click("#journal-create");
    await page.click("#journal-popout");
    const popout = page.locator('[data-window^="journal:"]');
    await expect(popout).toBeVisible();
    await expect(popout.locator("[data-secret]")).toHaveCount(1);
  });

  test("a window owns its pixels: above the canvas widgets, so its own modals stay clickable (D-456)", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await chromeAction(page, "gm-perms");
    const win = page.locator('[data-window="permissions"]');
    await expect(win).toBeVisible();

    // Park the window over the board's floating zoom control, the widget the canvas rail puts at
    // z 30 — the pair that used to swallow the FX binding picker's Close button.
    const zoom = page.locator(".zoom-control");
    const zoomBox = await zoom.boundingBox();
    if (!zoomBox) throw new Error("no zoom control");
    const target = { x: zoomBox.x - 40, y: zoomBox.y - 8 };
    const title = win.locator(".wm-title");
    const tb = await title.boundingBox();
    if (!tb) throw new Error("no title box");
    await page.mouse.move(tb.x + 40, tb.y + 10);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + 10, { steps: 5 });
    await page.mouse.up();

    // The centre of the zoom control now belongs to the window. Before D-456 the hit test here
    // returned the zoom control's <summary>, which is what made an in-window modal unclickable.
    const owner = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return "none";
      if (el.closest(".wm-window")) return "window";
      if (el.closest(".zoom-control")) return "zoom";
      return el.tagName.toLowerCase();
    }, { x: Math.round(zoomBox.x + zoomBox.width / 2), y: Math.round(zoomBox.y + zoomBox.height / 2) });
    expect(owner).toBe("window");
  });
});
