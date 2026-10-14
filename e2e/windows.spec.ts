import { expect, test } from "@playwright/test";
import { chromeAction, entry, hostCall, openSceneNav, waitForSurface } from "./lib";

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
    // D-465: the roster shows presence and the player colour; the host is online in its own world.
    const gmRow = page.locator("[data-perm-users] tbody tr").first();
    await expect(gmRow).toHaveAttribute("data-online", "true");
    await expect(gmRow.locator("[data-perm-color]")).toHaveCount(1);
    await expect(gmRow.getByRole("combobox", { name: /^Role for / })).toBeDisabled(); // not your own role
    await page.click("[data-window-close]");

    await page.click('[data-tab="journals"]');
    await page.click("#journal-create");
    await page.click("#journal-popout");
    const popout = page.locator('[data-window^="journal:"]');
    await expect(popout).toBeVisible();
    await expect(popout.locator("[data-secret]")).toHaveCount(1);
  });

  test("D-465: the roster assigns a character and a token to a player and removes an offline one", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // An offline player plus one actor and one token to hand out.
    const playerId = "roster-player";
    await page.evaluate((id) => {
      type Surface = {
        app: {
          activeSceneId(): string | null;
          seedPreviewUser(input: { id: string; name: string }): { ok: boolean; error?: string };
          gm: { client: { submit(ops: unknown[]): string } };
        } | null;
      };
      const app = (globalThis as unknown as { __vttE2E?: Surface }).__vttE2E?.app;
      if (!app) throw new Error("GM E2E app is unavailable");
      const seeded = app.seedPreviewUser({ id, name: "Rook Player" });
      if (!seeded.ok) throw new Error(seeded.error ?? "could not seed the player");
      const sceneId = app.activeSceneId();
      if (!sceneId) throw new Error("no active scene");
      app.gm.client.submit([
        { kind: "create", coll: "actors", data: { _id: "actor-rook", type: "actor", name: "Rook", ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [] } },
        // A GM-only token (the "Add token" button makes one open to everyone, which needs no grant).
        { kind: "create", coll: "tokens", parent: { coll: "scenes", id: sceneId }, data: {
          _id: "token-guard", type: "token", name: "Guard", ownership: { default: 0 }, flags: {}, system: {},
          x: 300, y: 300, rotation: 0, width: 100, height: 100, img: "", hidden: false, disposition: "neutral", vision: true,
          light: { radius: 0, color: "#ffffff", alpha: 0.5 },
        } },
      ]);
    }, playerId);
    await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
    await chromeAction(page, "gm-perms");
    const perms = page.locator('[data-window="permissions"]');
    const row = perms.locator(`[data-perm-users] tr[data-user="${playerId}"]`);
    await expect(row).toHaveAttribute("data-online", "false");
    expect(((await row.locator("td").first().innerText()) ?? "").trim()).toBe("Rook Player");

    // Character: the user's `character` plus OWNER on the actor, in one submit.
    await row.locator("[data-perm-character]").selectOption("actor-rook");
    const readback = () =>
      page.evaluate((id) => {
        type Store = { get(coll: string, docId: string): { character?: string; ownership?: Record<string, number> } | undefined; getAll(coll: "scenes"): Array<{ active?: boolean; tokens: Array<{ _id: string; ownership: Record<string, number> }> }> };
        const store = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { store?: Store } } } } }).__vttE2E?.app?.gm?.client?.store;
        if (!store) throw new Error("no store");
        const scenes = store.getAll("scenes");
        const scene = scenes.find((s) => s.active) ?? scenes[0];
        return {
          character: store.get("users", id)?.character ?? null,
          actorLevel: store.get("actors", "actor-rook")?.ownership?.[id] ?? null,
          tokenLevels: (scene?.tokens ?? []).map((t) => t.ownership[id] ?? null),
        };
      }, playerId);
    await expect.poll(readback).toEqual({ character: "actor-rook", actorLevel: 3, tokenLevels: [null] });

    // Token control: the expander lists the active scene's tokens; ticking one grants OWNER on it.
    await expect(row.locator("[data-perm-tokens]")).toHaveText(/0 of 1/);
    await row.locator("[data-perm-tokens]").click();
    const tokenBox = perms.locator(`[data-perm-tokens-for="${playerId}"] [data-perm-token="token-guard"]`);
    await expect(tokenBox).toHaveAttribute("data-perm-token-via", "none");
    await tokenBox.check();
    await expect.poll(readback).toEqual({ character: "actor-rook", actorLevel: 3, tokenLevels: [3] });
    await expect(row.locator("[data-perm-tokens]")).toHaveText(/1 of 1/);
    await tokenBox.uncheck();
    await expect.poll(readback).toEqual({ character: "actor-rook", actorLevel: 3, tokenLevels: [null] });

    // Offline players can be removed from the world (with a confirmation step).
    await row.locator("[data-perm-remove]").click();
    await row.locator("[data-perm-remove-confirm]").click();
    await expect(row).toHaveCount(0);
    await expect(page.locator("[data-perm-users] tbody tr[data-user]")).toHaveCount(1);
    await perms.locator("[data-window-close]").click();

    // World settings embeds the same roster (compact) and links to the full window.
    await chromeAction(page, "gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings.locator("[data-perm-users] tbody tr[data-user]")).toHaveCount(1);
    await settings.locator("[data-settings-open-players]").click();
    await expect(page.locator('[data-window="permissions"] [data-perm-users]')).toBeVisible();
  });

  test("D-465: the Scene settings window edits size, grid size, line colour and opacity of the active scene", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await chromeAction(page, "gm-scene-settings");
    const panel = page.locator("[data-scene-settings-panel]");
    await expect(panel).toBeVisible();
    const grid = () =>
      page.evaluate(() => {
        type Scene = { active?: boolean; width: number; height: number; grid: { size: number; color?: string; alpha?: number } };
        const store = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { store?: { getAll(coll: "scenes"): Scene[] } } } } } }).__vttE2E?.app?.gm?.client?.store;
        const scenes = store?.getAll("scenes") ?? [];
        const scene = scenes.find((s) => s.active) ?? scenes[0];
        if (!scene) throw new Error("no scene");
        return { width: scene.width, height: scene.height, size: scene.grid.size, color: scene.grid.color ?? null, alpha: scene.grid.alpha ?? null };
      });
    const before = await grid();
    await panel.locator("[data-scene-grid-size]").fill("80");
    await panel.locator("[data-scene-grid-size]").press("Tab");
    await expect.poll(grid).toEqual({ ...before, size: 80 });
    await expect(panel.locator("[data-scene-cells]")).toContainText("cells of 80 px");
    await panel.locator("[data-scene-grid-color]").fill("#aa3366");
    await panel.locator("[data-scene-grid-alpha]").fill("0.8");
    await expect.poll(grid).toEqual({ ...before, size: 80, color: "#aa3366", alpha: 0.8 });
    await panel.locator("[data-scene-grid-style-reset]").click();
    await expect.poll(grid).toEqual({ ...before, size: 80 });
    await expect(panel.locator("[data-scene-grid-style-reset]")).toBeDisabled();
    // Scene size in pixels, read back as whole cells.
    await panel.locator("[data-scene-width]").fill("2400");
    await panel.locator("[data-scene-width]").press("Tab");
    await panel.locator("[data-scene-height]").fill("1600");
    await panel.locator("[data-scene-height]").press("Tab");
    await expect.poll(grid).toEqual({ ...before, size: 80, width: 2400, height: 1600 });
    await expect(panel.locator("[data-scene-cells]")).toContainText("= 30 × 20 cells of 80 px");
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
