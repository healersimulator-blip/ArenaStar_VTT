/**
 * D-464 — three workspace layouts over one table.
 *
 * The user picks how the same world *looks and is arranged*: the first-party **Modern** shell, a
 * **Foundry**-like layout, or a **Roll20**-like layout. The choice is a device preference — it is
 * not written to the world, not shared with other players, and never changes a permission or a
 * document. These checks pin the contract that lets the rest of the suite stay layout-agnostic:
 * every sidebar tab, every GM action and the scene strip remain reachable in each layout, the
 * choice survives a reload, and the picker is reachable from the chrome and the main menu.
 */
import { expect, test, type Page } from "@playwright/test";
import { chromeAction, entry, hostCall, openSceneNav, waitForSurface } from "./lib";

const TABS = ["chat", "actors", "scenes", "images", "journals", "combat", "tables", "playlists", "compendia", "placeables", "macros", "settings"];
const STORAGE_KEY = "arenastar.workspace-ui.v1";

async function boot(page: Page): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await expect(page.locator("#status")).toContainText("World One");
}

async function pick(page: Page, profile: "modern" | "foundry" | "roll20"): Promise<void> {
  if (!(await page.locator("[data-workspace-picker]").isVisible())) await chromeAction(page, "gm-workspace");
  const picker = page.locator("[data-workspace-picker]");
  await expect(picker).toBeVisible();
  await picker.locator(`[data-workspace-mode="${profile}"]`).click();
  await expect(page.locator("main.gm-app")).toHaveAttribute("data-ui-profile", profile);
  await picker.locator("[data-workspace-done]").click();
  await expect(picker).toHaveCount(0);
}

/** Clicks a sidebar tab, going through the Roll20 overflow menu when the strip hides it. */
async function openTab(page: Page, id: string): Promise<void> {
  const tab = page.locator(`[data-tab="${id}"]`);
  if (!(await tab.first().isVisible())) await page.locator("[data-workspace-more-tabs]").click();
  await tab.first().click();
  await expect(page.locator(`.tabbody[data-active-tab="${id}"]`)).toBeVisible();
}

test.describe("workspace layouts (D-464)", () => {
  test("the modern shell is the default and keeps every tab, tool and action reachable", async ({ page }) => {
    await boot(page);
    const main = page.locator("main.gm-app");
    await expect(main).toHaveAttribute("data-ui-profile", "modern");
    await expect(main).toHaveAttribute("data-sidebar-open", "true"); // chat is showing, as on any tabletop
    await expect(page.locator("#chat-input")).toBeVisible();
    await expect(page.locator("[data-workspace-picker]")).toHaveCount(0); // a normal world opens on the table, not a chooser

    // Twelve document tabs in the rail — none of them behind a "more" menu.
    for (const id of TABS) await expect(page.locator(`nav[data-workspace-tabs] [data-tab="${id}"]`)).toBeVisible();
    await expect(page.locator("[data-workspace-more-tabs]")).toHaveCount(0);
    await page.locator("[data-workspace-sidebar-toggle]").click();
    await expect(main).toHaveAttribute("data-sidebar-open", "false");
    await expect(page.locator("#chat-input")).toBeHidden();
    await page.locator('[data-tab="compendia"]').click(); // selecting a tab reopens the drawer
    await expect(main).toHaveAttribute("data-sidebar-open", "true");
    await expect(page.locator('.tabbody[data-active-tab="compendia"]')).toBeVisible();
    // Re-selecting the open tab keeps it open; the chevron is what collapses the drawer.
    await page.locator('[data-tab="compendia"]').click();
    await expect(main).toHaveAttribute("data-sidebar-open", "true");
    await page.locator('[data-tab="chat"]').click();

    // GM tools: all eleven tactical tools on the rail, table actions behind "More tools".
    await expect(page.locator("[data-canvas-toolbar] [data-canvas-tool]")).toHaveCount(11);
    await expect(page.locator('[data-canvas-tool="wall"]')).toBeVisible();
    await expect(page.locator("[data-rules-status]")).toHaveText(/strategic rules: built-in/);

    // Secondary chrome actions live in the main menu with their ids intact.
    await expect(page.locator("#gm-perms")).toHaveCount(0);
    await chromeAction(page, "gm-perms");
    await expect(page.locator('[data-window="permissions"]')).toBeVisible();
    await page.locator('[data-window="permissions"] [data-window-close]').click();
    await expect(page.locator("[data-workspace-menu-panel]")).toHaveCount(0); // the menu closes after an action

    // The scene strip is a popover under the crumb.
    await expect(page.locator("[data-workspace-scene-menu]")).toBeHidden();
    await openSceneNav(page);
    await expect(page.locator('[data-testid="scene-nav"] [data-scene]')).toHaveCount(1);
    await expect(page.locator("#scene-add")).toBeVisible();
  });

  test("Foundry and Roll20 layouts rearrange the same controls and the choice stays on this device", async ({ page }) => {
    await boot(page);
    const main = page.locator("main.gm-app");
    const before = await hostCall<number>(page, "seq");

    await pick(page, "foundry");
    await expect(page.locator("[data-foundry-controls] [data-foundry-control]").first()).toBeVisible();
    for (const id of TABS) await expect(page.locator(`[data-tab="${id}"]`)).toBeVisible();
    await expect(page.locator("[data-workspace-scene-menu]")).toBeVisible(); // scene pills are pinned to the canvas
    await expect(page.locator("#scene-add")).toBeVisible();
    await openTab(page, "combat");
    await expect(main).toHaveAttribute("data-sidebar-open", "true");
    await chromeAction(page, "gm-settings"); // hidden command bar → main menu
    await expect(page.locator('[data-window="settings"]')).toBeVisible();
    await page.locator('[data-window="settings"] [data-window-close]').click();
    await expect(page.locator("[data-canvas-toolbar] [data-canvas-tool]").first()).toBeVisible();

    await pick(page, "roll20");
    await expect(main).toHaveAttribute("data-ui-scheme", "light");
    await expect(page.locator("[data-canvas-layer]").first()).toBeVisible(); // the layers dock
    await expect(page.locator("[data-workspace-more-tabs]")).toBeVisible(); // seven-tab strip + overflow
    await openTab(page, "actors");
    await openTab(page, "chat");
    await page.locator("[data-workspace-sidebar-toggle]").click();
    await expect(main).toHaveAttribute("data-sidebar-open", "false");
    await page.locator("[data-workspace-sidebar-toggle]").click();
    await expect(main).toHaveAttribute("data-sidebar-open", "true");
    await chromeAction(page, "gm-workspace");
    await page.locator("[data-workspace-scheme]").selectOption("dark");
    await expect(main).toHaveAttribute("data-ui-scheme", "dark");
    await page.locator("[data-workspace-done]").click();

    // Presentation only: nothing was written to the world.
    expect(await hostCall<number>(page, "seq")).toBe(before);
    expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key) ?? "null", STORAGE_KEY)))
      .toMatchObject({ version: 1, profile: "roll20", roll20Scheme: "dark" });

    await page.reload();
    await waitForSurface(page, "app");
    await expect(main).toHaveAttribute("data-ui-profile", "roll20");
    await expect(main).toHaveAttribute("data-ui-scheme", "dark");

    // Back to the default from the main menu, with the drawer state remembered per layout.
    await page.locator("[data-workspace-menu]").click();
    await page.getByRole("menuitem", { name: /Workspace layout/ }).click();
    await page.locator('[data-workspace-mode="modern"]').click();
    await page.locator("[data-workspace-done]").click();
    await expect(main).toHaveAttribute("data-ui-profile", "modern");
    await expect(main).toHaveAttribute("data-sidebar-open", "true");
  });
});
