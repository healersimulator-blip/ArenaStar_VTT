import { expect, test, type Browser } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

test("GM authors a tile graph and verifies native click/right-click/double-click and pointer hover events", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Bell tile");
  await tile.getByLabel("X", { exact: true }).fill("350");
  await tile.getByLabel("Y", { exact: true }).fill("400");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("160");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Bell tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Bell trap");
  await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "right click" }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "double click" }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "hover in" }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "hover out" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Bell trap" })).toHaveCount(1);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-layer="map"]').click();
  const before = await hostCall<number>(page, "seq");
  const point = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: {
      app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number };
    } }).__stage;
    if (!stage) throw new Error("GM canvas missing");
    const rect = stage.app.canvas.getBoundingClientRect();
    return { x: rect.left + (450 - stage.camera.x) * stage.camera.scale,
      y: rect.top + (480 - stage.camera.y) * stage.camera.scale };
  });
  const outside = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: {
      app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number };
    } }).__stage;
    if (!stage) throw new Error("GM canvas missing");
    const rect = stage.app.canvas.getBoundingClientRect();
    return { x: rect.left + (900 - stage.camera.x) * stage.camera.scale,
      y: rect.top + (900 - stage.camera.y) * stage.camera.scale };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(before);
  await expect(page.locator("#chat-log")).toContainText("click by");
  const afterFirstHover = await hostCall<number>(page, "seq");
  await page.mouse.move(point.x + 6, point.y + 6);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(afterFirstHover);
  const beforeRightClick = await hostCall<number>(page, "seq");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeRightClick + 1);
  await expect(page.locator("#chat-log")).toContainText("rightClick by");
  const beforeDoubleClick = await hostCall<number>(page, "seq");
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeDoubleClick + 2);
  await expect(page.locator("#chat-log")).toContainText("doubleClick by");
  const beforeHoverOut = await hostCall<number>(page, "seq");
  await page.mouse.move(outside.x, outside.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeHoverOut + 1);
  await expect(page.locator("#chat-log")).toContainText("hoverOut by");
  const beforeHoverIn = await hostCall<number>(page, "seq");
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeHoverIn + 1);
  await expect(page.locator("#chat-log")).toContainText("hoverIn by");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const history = page.locator("[data-zone-history]");
  await history.locator("summary").click();
  await expect(history.locator("li").filter({ hasText: /: click · gm$/ })).toHaveCount(2);
  await expect(history.locator("li").filter({ hasText: /: rightClick · gm$/ })).toHaveCount(1);
  await expect(history.locator("li").filter({ hasText: /: doubleClick · gm$/ })).toHaveCount(1);
  await expect(history.locator("li").filter({ hasText: /: hoverOut · gm$/ })).toHaveCount(2);
  await expect(history.locator("li").filter({ hasText: /: hoverIn · gm$/ })).toHaveCount(2);
  await page.locator("[data-zone-reset-history]").click();
  await expect(page.locator("[data-active-zones] li").filter({ hasText: "Bell trap" })).toContainText("0 run(s)");
  await expect(page.locator("[data-zone-history]")).toHaveCount(0);
});

test("GM scene activation fires a destination-scene scene-change graph once", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const scenes = page.locator(".scenenav [data-scene]");
  await expect(scenes).toHaveCount(1);
  const sourceId = await scenes.first().getAttribute("data-scene");
  if (!sourceId) throw new Error("initial scene ID missing");

  await page.locator("#scene-add").click();
  await page.locator("#scene-new-blank").click();
  await expect(scenes).toHaveCount(2);
  const destination = scenes.nth(1);
  const destinationId = await destination.getAttribute("data-scene");
  if (!destinationId) throw new Error("destination scene ID missing");
  await destination.click();
  await expect.poll(() => hostCall<string | null>(page, "activeSceneId")).toBe(destinationId);

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Arrival marker");
  await tile.getByLabel("X", { exact: true }).fill("350");
  await tile.getByLabel("Y", { exact: true }).fill("400");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Arrival marker" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Scene arrival");
  for (const method of ["enter", "stop", "manual"]) {
    await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) }).locator("input").uncheck();
  }
  await zones.locator(".methods label").filter({ hasText: "scene change" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Scene arrival" })).toContainText("sceneChange");
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  await scenes.first().click();
  await expect.poll(() => hostCall<string | null>(page, "activeSceneId")).toBe(sourceId);
  expect((await hostCall<string[]>(page, "chatLines")).some((line) => line.includes("sceneChange by"))).toBe(false);
  const before = await hostCall<number>(page, "seq");
  await destination.click();
  await expect.poll(() => hostCall<string | null>(page, "activeSceneId")).toBe(destinationId);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 2);
  await expect(page.locator("#chat-log")).toContainText("sceneChange by");

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const history = page.locator("[data-zone-history]");
  await expect(history).toHaveCount(1);
  await history.locator("summary").click();
  await expect(history.locator("li")).toHaveText(/sceneChange ·/);
  await expect(history.locator("li")).toHaveCount(1);
});

test("GM authors a convex scene region and binds an active-zone graph to that region", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-source-kind]").selectOption("region");
  await zones.locator("[data-zone-region-create] summary").click();
  const region = zones.locator("[data-zone-region-create]");
  await region.getByLabel("Region name").fill("Courtyard trigger");
  await region.getByLabel("X", { exact: true }).fill("300");
  await region.getByLabel("Y", { exact: true }).fill("300");
  await region.getByLabel("Width").fill("200");
  await region.getByLabel("Height").fill("200");
  await region.locator("[data-zone-region-shape]").selectOption("diamond");
  await region.locator("[data-zone-create-region]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Courtyard trigger" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Courtyard crossing");
  await zones.locator(".methods label").filter({ hasText: "exit" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Courtyard crossing" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log")).toContainText("enter by");
});

test("wizard filters the current collection by a typed attribute before a count check, using the live host tile", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Attribute tile");
  await tile.getByLabel("Width").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Attribute tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Typed width filter");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="attributes"]').click();
  const attr = zones.locator("[data-zone-step]").last();
  await attr.getByLabel("Attribute path").fill("width");
  await attr.getByLabel("Attribute comparison").selectOption("gte");
  await expect(attr.getByLabel("Attribute value type")).toHaveValue("number");
  await attr.getByLabel("Attribute value", { exact: true }).fill("200");
  await zones.locator('[data-zone-add="filter"]').click();
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Width matches");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Typed width filter" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log")).toContainText("Width matches");
  await expect(zones.locator("details[open] li").filter({ hasText: "attribute filter: 1 matching" })).toHaveCount(1);
  await zones.locator("[data-zone-step]").nth(1).getByLabel("Attribute value", { exact: true }).fill("250");
  await zones.locator("[data-zone-save]").click();
  const afterEdit = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(afterEdit + 1);
  await expect(zones.locator("details[open] li").filter({ hasText: "attribute filter: 0 matching" })).toHaveCount(1);
  await expect(page.locator("#chat-log").getByText("Width matches")).toHaveCount(1);
  await expect(zones.locator("li").filter({ hasText: "Typed width filter" })).toContainText("2 run(s)");
});

test("Check Data wizard checks the triggering tile instead of the empty token collection", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Data tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("Tile width check");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="checkData"]').click();
  const check = zones.locator("[data-zone-step]").nth(1);
  await check.getByLabel("Check Data tile path").fill("width");
  await check.getByLabel("Attribute comparison").selectOption("gte");
  await check.getByLabel("Attribute value type").selectOption("number");
  await check.getByLabel("Attribute value", { exact: true }).fill("200");
  await check.getByLabel("Check Data failure landing").fill("too-small");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("The tile is wide");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("too-small");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("The tile is narrow");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("The tile is wide")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Data width: pass" })).toHaveCount(1);
  await check.getByLabel("Attribute value", { exact: true }).fill("250");
  await zones.locator("[data-zone-save]").click();
  const afterEdit = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(afterEdit + 1);
  await expect(page.locator("#chat-log").getByText("The tile is narrow")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Data width: fail" })).toHaveCount(1);
});

test("Token Trigger Count wizard branches separately for two real tokens, with undoable private history", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#add-token").click();
  await page.locator("#add-token").click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Token history tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("Per-token first fire");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="tokenTriggerCount"]').click();
  const count = zones.locator("[data-zone-step]").nth(1);
  await count.getByLabel("Token trigger count comparison").selectOption("eq");
  await count.getByLabel("Token trigger count", { exact: true }).fill("1");
  await zones.locator('[data-zone-add="filter"]').click();
  await zones.locator("[data-zone-step]").nth(2).getByLabel("On failure jump to").fill("repeat");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("first per token");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("repeat");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("already fired");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  await zones.getByLabel("Origin token").selectOption({ label: "Token 1" });
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("first per token")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "token trigger count filter: 1 matching" })).toHaveCount(1);
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("already fired")).toHaveCount(1);
  await zones.getByLabel("Origin token").selectOption({ label: "Token 2" });
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("first per token")).toHaveCount(2);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(page.locator("#chat-log").getByText("first per token")).toHaveCount(1);
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("first per token")).toHaveCount(2);
});

test("Check Variable wizard branches on a staged tile value, persists, and undo restores the prior value", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Counter tile");
  await zones.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Counter tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Charge check");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="set"]').click();
  const set = zones.locator("[data-zone-step]").nth(1);
  await set.getByLabel("Name", { exact: true }).fill("charge");
  await set.getByLabel("Variable scope").selectOption("tile");
  await set.getByLabel("Variable operation").selectOption("add");
  await zones.locator('[data-zone-add="checkVariable"]').click();
  const check = zones.locator("[data-zone-step]").nth(2);
  await check.getByLabel("Variable name").fill("charge");
  await check.getByLabel("Check Variable comparison").selectOption("gte");
  await check.getByLabel("Check Variable value", { exact: true }).fill("2");
  await check.getByLabel("Check Variable failure landing").fill("early");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Charge ready");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("early");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Charge pending");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect(zones.locator("li").filter({ hasText: "Charge check" })).toHaveCount(1);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("Charge pending")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Variable charge: 0/1" })).toHaveCount(1);
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 2);
  await expect(page.locator("#chat-log").getByText("Charge ready")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Variable charge: 1/1" })).toHaveCount(1);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(page.locator("#chat-log").getByText("Charge ready")).toHaveCount(0);
  await zones.locator("li").filter({ hasText: "Charge check" }).getByRole("button", { name: "Edit" }).click();
  await zones.locator("[data-zone-variables] summary").click();
  await expect(zones.locator("[data-zone-variables] li")).toContainText("charge: 1");
  await hostCall<number>(page, "drainOps");
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const restored = page.locator("[data-active-zones]");
  await restored.locator("li").filter({ hasText: "Charge check" }).getByRole("button", { name: "Edit" }).click();
  await restored.locator("[data-zone-variables] summary").click();
  await expect(restored.locator("[data-zone-variables] li")).toContainText("charge: 1");
  await expect(page.locator("#chat-log").getByText("Charge pending")).toHaveCount(1);
});

test("Random Number wizard rolls a bounded host value and interpolates it into real chat", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Dice tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("Die roll");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="random"]').click();
  const roll = zones.locator("[data-zone-step]").nth(1);
  await roll.getByLabel("Variable").fill("die");
  await roll.getByLabel("Minimum").fill("1");
  await roll.getByLabel("Maximum").fill("6");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Rolled {{die}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  for (let i = 1; i <= 3; i++) {
    await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + i);
  }
  const results = await page.locator("#chat-log").getByText(/^Rolled [1-6]$/).allTextContents();
  expect(results).toHaveLength(3);
  await expect(zones.locator("li").filter({ hasText: "Die roll" })).toContainText("3 run(s)");
  await expect(zones.locator("details[open] li").filter({ hasText: /die = [1-6] \(host roll\)/ })).toHaveCount(1);
});

test("Check Value wizard reads committed scene darkness and routes to an alternate landing", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Night watch tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("Night watch");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="checkValue"]').click();
  const check = zones.locator("[data-zone-step]").nth(1);
  await expect(check.getByLabel("Check Value source")).toHaveValue("darkness");
  await check.getByLabel("Check Value threshold").fill("0.5");
  await check.getByLabel("Check Value failure landing").fill("daylight");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("The shadows answer");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("daylight");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Still daylight");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("Still daylight")).toHaveCount(1);
  await page.locator("#gm-settings").click();
  const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-scene-darkness]").focus();
  await settings.locator("[data-scene-darkness]").press("End");
  await expect(settings.locator("[data-scene-darkness-value]")).toHaveText("100%");
  await settings.locator("[data-window-close]").click();
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("The shadows answer")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Value darkness: 1 gte 0.5 -> pass" })).toHaveCount(1);
});

for (const formula of [false, true]) test(`Game Time wizard stages minute changes, branches and undoes (formula ${formula})`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Clock lever tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("Clock lever");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="gameTime"]').click();
  if (formula) {
    await zones.locator("[data-zone-step]").last().getByLabel("Game Time source").selectOption("formula");
    await zones.getByLabel("Game Time formula").fill("1d1 * 60 + 30");
  } else await zones.getByLabel("Game Time minutes",{exact:true}).fill("90");
  await zones.locator('[data-zone-add="checkValue"]').click();
  const first = zones.locator("[data-zone-step]").last();
  await first.getByLabel("Check Value source").selectOption("time");
  await first.getByLabel("Check Value world time").fill("01:30");
  await zones.locator('[data-zone-add="gameTime"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Game Time minutes").fill("-30");
  await zones.locator('[data-zone-add="checkValue"]').click();
  const second = zones.locator("[data-zone-step]").last();
  await second.getByLabel("Check Value source").selectOption("time");
  await second.getByLabel("Check Value comparison").selectOption("eq");
  await second.getByLabel("Check Value world time").fill("01:00");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Lever advanced the world clock");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  if (formula) {
    await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
    await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
    await zones.locator("li").filter({hasText:"Clock lever"}).getByRole("button",{name:"Edit"}).click();
    await expect(zones.getByLabel("Game Time formula")).toHaveValue("1d1 * 60 + 30");
  }
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log")).toContainText("Lever advanced the world clock");
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Value time: 60 eq 60 -> pass" })).toHaveCount(1);
  await page.locator("#gm-settings").click();
  const settings = page.locator('[data-window="settings"]');
  await expect(settings.locator("[data-clock-readout]")).toContainText("01:00");
  await settings.locator("[data-window-close]").click();
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(page.locator("#chat-log").getByText("Lever advanced the world clock")).toHaveCount(0);
  await page.locator("#gm-settings").click();
  await expect(settings.locator("[data-clock-readout]")).toContainText("00:00");
  await settings.locator("[data-window-close]").click();
  if (formula) {
    await zones.getByLabel("Game Time formula").fill("1/0");
    const beforeSave=await hostCall<number>(page,"seq");
    await zones.locator("[data-zone-save]").click();
    await expect.poll(()=>hostCall<number>(page,"seq")).toBe(beforeSave+1);
    await zones.locator("[data-zone-run]").click();
    await expect(zones.getByRole("alert")).toBeVisible();
    expect(await hostCall<number>(page,"seq")).toBe(beforeSave+1);
    await page.locator("#gm-settings").click();
    await expect(settings.locator("[data-clock-readout]")).toContainText("00:00");
  }
});

test("Check Value wizard branches on the GM-replicated world clock, including day rollover", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Clock tile");
  await zones.locator("[data-zone-create-tile]").click();
  await zones.locator("[data-zone-name]").fill("After one");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="checkValue"]').click();
  const check = zones.locator("[data-zone-step]").nth(1);
  await check.getByLabel("Check Value source").selectOption("time");
  await check.getByLabel("Check Value world time").fill("01:00");
  await check.getByLabel("Check Value failure landing").fill("early");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Clock has passed one");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("early");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Clock has not passed one");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("Clock has not passed one")).toHaveCount(1);
  await page.locator("#gm-settings").click();
  const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-clock-hour]").click();
  await expect(settings.locator("[data-clock-readout]")).toContainText("01:00");
  await settings.locator("[data-window-close]").click();
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("Clock has passed one")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "Check Value time: 60 gte 60 -> pass" })).toHaveCount(1);
  await page.locator("#gm-settings").click();
  await settings.locator("[data-clock-day]").click();
  await expect(settings.locator("[data-clock-readout]")).toContainText("01:00");
  await settings.locator("[data-window-close]").click();
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log").getByText("Clock has passed one")).toHaveCount(2);
});

test("wizard authors host condition and inventory item-count filters with a count branch", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens", [
    { id: "condition-runner", col: 1, row: 1, size: "Medium" },
  ])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-condition-runner", patch: { conditions: ["Prone"] },
  })).toMatchObject({ ok: true });
  await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(page, "app", "pf1eActorSystem", "a-condition-runner"))
    .toMatchObject({ conditions: ["Prone"] });
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Inventory and condition tile");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Inventory and condition tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Condition and item records");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("inside");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="condition"]').click();
  const condition = zones.locator("[data-zone-step]").nth(1);
  await condition.getByLabel("Condition or effect name").fill("  prone ");
  await condition.getByLabel("Condition mode").selectOption("has");
  await zones.locator('[data-zone-add="inventory"]').click();
  const inventory = zones.locator("[data-zone-step]").nth(2);
  await inventory.getByLabel("Inventory item name").fill("*potion*");
  await inventory.getByLabel("Inventory comparison").selectOption("eq");
  await inventory.getByLabel("Inventory item count").fill("0");
  await zones.locator('[data-zone-add="filter"]').click();
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Condition and zero potions");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Condition and item records" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("Condition and zero potions")).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "condition filter: 1 matching" })).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: "inventory filter: 1 matching" })).toHaveCount(1);

  await inventory.getByLabel("Inventory comparison").selectOption("gte");
  await inventory.getByLabel("Inventory item count").fill("1");
  await zones.locator("[data-zone-save]").click();
  const afterEdit = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(afterEdit + 1);
  await expect(zones.locator("details[open] li").filter({ hasText: "inventory filter: 0 matching" })).toHaveCount(1);
  await expect(page.locator("#chat-log").getByText("Condition and zero potions")).toHaveCount(1);
  await expect(zones.locator("li").filter({ hasText: "Condition and item records" })).toContainText("2 run(s)");
});

test("wizard publishes a bounded per-token loop with a tile-count branch and named method route", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#add-token").click();
  await page.locator("#add-token").click();
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(2);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Two tokens zone");
  await tile.getByLabel("X", { exact: true }).fill("850");
  await tile.getByLabel("Y", { exact: true }).fill("600");
  await tile.getByLabel("Width").fill("300");
  await tile.getByLabel("Height").fill("300");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Two tokens zone" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Visitors graph");
  await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("inside");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="forEach"]').click();
  const loop = zones.locator('[data-zone-step]').nth(1);
  await loop.getByLabel(/Add inside loop/).selectOption("chat");
  await zones.locator('[data-zone-step]').nth(2).getByLabel("Text").fill("Visited {{index}}/{{currentId}}");
  await zones.locator('[data-zone-add="filter"]').click();
  const count = zones.locator('[data-zone-step]').nth(4);
  await count.getByLabel("Check").selectOption("tileCount");
  await count.getByLabel("At most").fill("1");
  await zones.locator('[data-zone-add="routeMethod"]').click();
  const route = zones.locator('[data-zone-step]').nth(5);
  await route.getByLabel("enter landing").fill("");
  await route.getByLabel("click landing", { exact: true }).fill("clicked");
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator('[data-zone-step]').nth(6).getByLabel("Landing name").fill("clicked");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator('[data-zone-step]').nth(7).getByLabel("Text").fill("Once {{count}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Visitors graph" })).toHaveCount(1);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-layer="map"]').click();
  const point = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: {
      app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number };
    } }).__stage;
    if (!stage) throw new Error("GM canvas missing");
    const rect = stage.app.canvas.getBoundingClientRect();
    return { x: rect.left + (900 - stage.camera.x) * stage.camera.scale,
      y: rect.top + (650 - stage.camera.y) * stage.camera.scale };
  });
  const before = await hostCall<number>(page, "seq");
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(before);
  await expect(page.locator("#chat-log")).toContainText("Once 1");
  const contents = await page.locator("#chat-log").innerText();
  const visited = [...contents.matchAll(/Visited ([12])\/(t-[a-f0-9]{8})/g)];
  expect(visited).toHaveLength(2);
  expect(visited.map((match) => match[1])).toEqual(["1", "2"]);
  expect(visited[0]?.[2]).not.toBe(visited[1]?.[2]);
  const after = await hostCall<number>(page, "seq");
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(after);
  const again = await page.locator("#chat-log").innerText();
  expect([...again.matchAll(/Once 1/g)]).toHaveLength(1); // tile count 2 stopped before routing
  expect([...again.matchAll(/Visited [12]\/t-[a-f0-9]{8}/g)]).toHaveLength(4);
});

test("GM authors a persistent tile counter, branches on its next fire, reloads and clears variables separately", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Counting tile");
  await zones.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Counting tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Counting trap");
  await zones.getByRole("button", { name: "Remove step 2" }).click(); // default notice is before the branch
  await zones.locator('[data-zone-add="set"]').click();
  const counter = zones.locator("[data-zone-step]").last();
  await counter.getByLabel("Name").fill("visits");
  await counter.getByLabel("Scope").selectOption("tile");
  await counter.getByLabel("Variable operation").selectOption("add");
  await counter.getByLabel("Value", { exact: true }).fill("1");
  await zones.locator('[data-zone-add="filter"]').click();
  const check = zones.locator("[data-zone-step]").last();
  await check.getByLabel("Check").selectOption("variable");
  await check.getByLabel("Variable", { exact: true }).fill("visits");
  await check.getByLabel("Equals", { exact: true }).fill("2");
  await zones.locator('[data-zone-add="chat"]').click();
  const notice = zones.locator("[data-zone-step]").last();
  await notice.getByLabel("Text").fill("Visits {{visits}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Counting trap" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(zones.locator("[data-zone-variables]")).toHaveCount(1);
  await expect(page.locator("#chat-log")).not.toContainText("Visits 1");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 2);
  await expect(page.locator("#chat-log")).toContainText("Visits 2");
  await zones.locator("[data-zone-variables] summary").click();
  await expect(zones.locator("[data-zone-variables] li")).toContainText("visits: 2");
  expect(await hostCall<number>(page, "drainOps")).toBe(await hostCall<number>(page, "seq"));
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const restored = page.locator("[data-active-zones]");
  await restored.locator("[data-zone-variables] summary").click();
  await expect(restored.locator("[data-zone-variables] li")).toContainText("visits: 2");
  await restored.locator("[data-zone-reset-history]").click();
  await expect(restored.locator("[data-zone-history]")).toHaveCount(0);
  await expect(restored.locator("[data-zone-variables] li")).toContainText("visits: 2");
  await restored.locator("[data-zone-clear-variables]").click();
  await expect(restored.locator("[data-zone-variables]")).toHaveCount(0);
});

test("wizard activates a paused tile graph and invokes it in one undoable host fire", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const create = async (name: string, x: number) => {
    const editor = zones.locator("[data-zone-tile-create]");
    await editor.getByLabel("Tile name").fill(name);
    await editor.getByLabel("X", { exact: true }).fill(String(x));
    await editor.locator("[data-zone-create-tile]").click();
    const option = zones.locator("[data-zone-tile] option").filter({ hasText: name });
    await expect(option).toHaveCount(1);
    const id = await option.getAttribute("value");
    if (!id) throw new Error(`tile ${name} missing an ID`);
    return id;
  };
  const parent = await create("Wake switch", 100);
  const child = await create("Sleeping gate", 450);
  await zones.locator("[data-zone-tile]").selectOption(child);
  await zones.locator("[data-zone-name]").fill("Sleeping tile graph");
  await zones.locator(".gates").getByLabel("Paused").check();
  await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Gate awakened {{charge}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Sleeping tile graph" })).toHaveCount(1);

  await zones.getByRole("button", { name: "New" }).click();
  await zones.locator("[data-zone-tile]").selectOption(parent);
  await zones.locator("[data-zone-name]").fill("Wake switch graph");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.locator('[data-zone-add="setActive"]').click();
  const enable = zones.locator("[data-zone-step]").last();
  await enable.getByLabel("Set tile graph activity").selectOption("activate");
  await enable.getByLabel("Activity tile").selectOption(child);
  await zones.locator('[data-zone-add="set"]').click();
  const assign = zones.locator("[data-zone-step]").last();
  await assign.getByLabel("Name", { exact: true }).fill("charge");
  await assign.getByLabel("Variable scope").selectOption("tile");
  await assign.getByLabel("Variable target").selectOption("id");
  await assign.getByLabel("Variable tile").selectOption(child);
  await assign.getByLabel("Value", { exact: true }).fill("3");
  await zones.locator('[data-zone-add="triggerTile"]').click();
  await zones.getByRole("combobox", { name: "Tile", exact: true }).selectOption(child);
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.getByLabel("Simulate method").selectOption("manual");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log")).toContainText("Gate awakened 3");
  await expect(zones.locator("details[open] li").filter({ hasText: /activate 1 graph/ })).toHaveCount(1);
  await expect(zones.locator("details[open] li").filter({ hasText: /tile variable charge = on 1 graph/ })).toHaveCount(1);
  const savedChild = zones.locator("li").filter({ hasText: "Sleeping tile graph" });
  await expect(savedChild).toContainText("1 run(s)");
  await savedChild.getByRole("button", { name: "Edit" }).click();
  await expect(zones.locator(".gates").getByLabel("Paused")).not.toBeChecked();
  await zones.locator("[data-zone-variables] summary").click();
  await expect(zones.locator("[data-zone-variables] li")).toContainText("charge: 3");
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(savedChild).toContainText("0 run(s)");
  await savedChild.getByRole("button", { name: "Edit" }).click(); // refresh the editor's unsaved copy
  await expect(zones.locator(".gates").getByLabel("Paused")).toBeChecked();
  await expect(zones.locator("[data-zone-variables]")).toHaveCount(0);
  await expect.poll(() => hostCall<string[]>(page, "chatLines")).toEqual([]);
  await expect(page.locator("#chat-log")).not.toContainText("Gate awakened");
  await hostCall<number>(page, "drainOps");
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const restored = page.locator("[data-active-zones]");
  await restored.locator("li").filter({ hasText: "Sleeping tile graph" })
    .getByRole("button", { name: "Edit" }).click();
  await expect(restored.locator(".gates").getByLabel("Paused")).toBeChecked();
  await expect(page.locator("#chat-log")).not.toContainText("Gate awakened");
});

test("a connected player's canvas click/right-click/double-click/hover invokes the published tile without a graph ID", async ({ browser }: { browser: Browser }) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Public bell");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Public bell" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Player bell");
    await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
    await zones.locator(".methods label").filter({ hasText: /^right click$/ }).locator("input").check();
    await zones.locator(".methods label").filter({ hasText: /^double click$/ }).locator("input").check();
    await zones.locator(".methods label").filter({ hasText: /^hover in$/ }).locator("input").check();
    await zones.locator(".methods label").filter({ hasText: /^hover out$/ }).locator("input").check();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator("[data-zone-save]").click();
    await expect(zones.locator("li").filter({ hasText: "Player bell" })).toHaveCount(1);
    await host.locator('[data-window="macros"] [data-window-close]').click();

    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    const before = await hostCall<number>(host, "seq");
    await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(before);
    const point = await surfaceCallArg<{ x: number; y: number } | null>(player, "playerCanvas", "screenOf", { x: 450, y: 480 });
    const outside = await surfaceCallArg<{ x: number; y: number } | null>(player, "playerCanvas", "screenOf", { x: 900, y: 900 });
    if (!point || !outside) throw new Error("player canvas point unavailable");
    await player.mouse.click(point.x, point.y);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBeGreaterThan(before);
    await expect(host.locator("#chat-log")).toContainText("click by");
    const afterFirstHover = await hostCall<number>(host, "seq");
    await player.mouse.move(point.x + 6, point.y + 6);
    await expect.poll(() => hostCall<number>(host, "seq")).toBe(afterFirstHover);
    const afterLeftClick = await hostCall<number>(host, "seq");
    await player.mouse.click(point.x, point.y, { button: "right" });
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(afterLeftClick + 1);
    await expect(host.locator("#chat-log")).toContainText("rightClick by");
    const beforeDoubleClick = await hostCall<number>(host, "seq");
    await player.mouse.dblclick(point.x, point.y);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(beforeDoubleClick + 2);
    await expect(host.locator("#chat-log")).toContainText("doubleClick by");
    const beforeHoverOut = await hostCall<number>(host, "seq");
    await player.mouse.move(outside.x, outside.y);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(beforeHoverOut + 1);
    await expect(host.locator("#chat-log")).toContainText("hoverOut by");
    const beforeHoverIn = await hostCall<number>(host, "seq");
    await player.mouse.move(point.x, point.y);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(beforeHoverIn + 1);
    await expect(host.locator("#chat-log")).toContainText("hoverIn by");
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("wizard authors a real batch barrier and GM tile trigger priority", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Batch tile");
  await tile.getByLabel("Trigger sort").fill("7");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Batch tile" })).toHaveCount(1);
  const priority = zones.getByRole("spinbutton", { name: /Selected tile trigger sort/ });
  await expect(priority).toHaveValue("7");
  await priority.fill("11");
  await priority.press("Tab");
  await expect(priority).toHaveValue("11");
  await zones.locator("[data-zone-name]").fill("Batch bell");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator('[data-zone-add="batchFlush"]').click();
  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Edit").selectOption("remove");
  await zones.locator('[data-zone-add="batchFlush"]').click();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Batch bell" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1); // both batches in one host commit
  await expect(zones.getByRole("status")).toContainText("committed");
  await expect(zones.locator("details[open] li").filter({ hasText: "batch executed" })).toHaveCount(2);
  await expect(zones.locator("details[open] li").filter({ hasText: "1 combined world update(s)" })).toHaveCount(2);
  await expect(priority).toHaveValue("11");
});

test("wizard authors a current-collection edit and atomic Trigger Tile call with origin context", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const createTile = async (name: string, x: number) => {
    const editor = zones.locator("[data-zone-tile-create]");
    await editor.getByLabel("Tile name").fill(name);
    await editor.getByLabel("X", { exact: true }).fill(String(x));
    await editor.getByLabel("Y", { exact: true }).fill("400");
    await editor.getByLabel("Width").fill("180");
    await editor.getByLabel("Height").fill("160");
    await editor.locator("[data-zone-create-tile]").click();
    const option = zones.locator("[data-zone-tile] option").filter({ hasText: name });
    await expect(option).toHaveCount(1);
    const id = await option.getAttribute("value");
    if (!id) throw new Error(`tile ${name} did not receive a host ID`);
    return id;
  };
  const parentTile = await createTile("Relay parent", 350);
  const childTile = await createTile("Relay child", 650);
  await zones.locator("[data-zone-tile]").selectOption(childTile);
  await zones.locator("[data-zone-name]").fill("Relay child graph");
  await zones.locator(".methods label").filter({ hasText: "enter" }).locator("input").uncheck();
  await zones.locator(".methods label").filter({ hasText: "stop" }).locator("input").uncheck();
  await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Child of {{originMethod}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Relay child graph" })).toHaveCount(1);

  await zones.getByRole("button", { name: "New" }).click();
  await zones.locator("[data-zone-tile]").selectOption(parentTile);
  await zones.locator("[data-zone-name]").fill("Relay parent graph");
  await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
  await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Parent {{method}}");
  await zones.locator('[data-zone-add="collection"]').click();
  const collection = zones.locator("[data-zone-step]").last();
  await collection.getByLabel("Change current collection").selectOption("replace");
  await collection.getByLabel("Entities").selectOption("tile");
  await zones.locator('[data-zone-add="filter"]').click();
  const filter = zones.locator("[data-zone-step]").last();
  await filter.getByLabel("At least").fill("1");
  await filter.getByLabel("At most").fill("1");
  await zones.locator('[data-zone-add="triggerTile"]').click();
  const call = zones.locator("[data-zone-step]").last();
  await call.getByLabel("Target tiles").selectOption("id");
  await call.getByRole("combobox", { name: "Tile", exact: true }).selectOption(childTile);
  await call.getByLabel("Pass tokens").selectOption("triggering");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Relay parent graph" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);

  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-layer="map"]').click();
  const point = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: {
      app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number };
    } }).__stage;
    if (!stage) throw new Error("GM canvas missing");
    const rect = stage.app.canvas.getBoundingClientRect();
    return { x: rect.left + (440 - stage.camera.x) * stage.camera.scale,
      y: rect.top + (480 - stage.camera.y) * stage.camera.scale };
  });
  const before = await hostCall<number>(page, "seq");
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1); // parent AND child in one envelope
  await expect(page.locator("#chat-log")).toContainText("Parent click");
  await expect(page.locator("#chat-log")).toContainText("Child of click");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  await expect(zones.locator("li").filter({ hasText: "Relay parent graph" })).toContainText("1 run(s)");
  await expect(zones.locator("li").filter({ hasText: "Relay child graph" })).toContainText("1 run(s)");
});

test("GM binds a region to a named tile graph through the redirect step, keeping the region as origin", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  // The child lives on a tile the token never touches: only the region's redirect reaches it.
  await zones.locator("[data-zone-tile-create] summary").click();
  const tileEditor = zones.locator("[data-zone-tile-create]");
  await tileEditor.getByLabel("Tile name").fill("Relay landing");
  await tileEditor.getByLabel("X", { exact: true }).fill("650");
  await tileEditor.getByLabel("Y", { exact: true }).fill("400");
  await tileEditor.getByLabel("Width").fill("180");
  await tileEditor.getByLabel("Height").fill("160");
  await tileEditor.locator("[data-zone-create-tile]").click();
  const landingOption = zones.locator("[data-zone-tile] option").filter({ hasText: "Relay landing" });
  await expect(landingOption).toHaveCount(1);
  const landingId = await landingOption.getAttribute("value");
  if (!landingId) throw new Error("the created tile did not receive a host ID");
  await zones.locator("[data-zone-tile]").selectOption(landingId);
  await zones.locator("[data-zone-name]").fill("Landing graph");
  await zones.locator(".methods label").filter({ hasText: "stop" }).locator("input").uncheck();
  await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Child {{method}}@{{originSource}}");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Landing graph" })).toHaveCount(1);

  await zones.locator("[data-zone-source-kind]").selectOption("region");
  await zones.locator("[data-zone-region-create] summary").click();
  const regionEditor = zones.locator("[data-zone-region-create]");
  await regionEditor.getByLabel("Region name").fill("Relay court");
  await regionEditor.getByLabel("X", { exact: true }).fill("300");
  await regionEditor.getByLabel("Y", { exact: true }).fill("300");
  await regionEditor.getByLabel("Width").fill("200");
  await regionEditor.getByLabel("Height").fill("200");
  await regionEditor.locator("[data-zone-create-region]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Relay court" })).toHaveCount(1);

  // `New` resets the source kind to a tile, so the region is re-selected for the parent graph.
  await zones.getByRole("button", { name: "New" }).click();
  await zones.locator("[data-zone-source-kind]").selectOption("region");
  const courtOption = zones.locator("[data-zone-tile] option").filter({ hasText: "Relay court" });
  await expect(courtOption).toHaveCount(1);
  const courtId = await courtOption.getAttribute("value");
  if (!courtId) throw new Error("the created region did not receive a host ID");
  await zones.locator("[data-zone-tile]").selectOption(courtId);
  await zones.locator("[data-zone-name]").fill("Court relay");
  await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Parent {{method}}");
  await zones.locator('[data-zone-add="redirect"]').click();
  const relay = zones.locator("[data-zone-step]").last();
  const targetOption = relay.getByLabel("Redirect target graph").locator("option")
    .filter({ hasText: "Landing graph" });
  await expect(targetOption).toHaveCount(1);
  const targetId = await targetOption.getAttribute("value");
  if (!targetId) throw new Error("the child graph has no host ID");
  await relay.getByLabel("Redirect target graph").selectOption(targetId);
  await relay.getByLabel("Redirect method").selectOption("inherit");
  await relay.getByLabel("Redirect token source").selectOption("triggering");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Court relay" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);

  // Re-opening the saved graph offers the child, never the graph itself (a self-redirect loops).
  await zones.locator("li").filter({ hasText: "Court relay" }).getByRole("button", { name: "Edit" }).click();
  const options = zones.locator("[data-zone-step]").last().getByLabel("Redirect target graph").locator("option");
  await expect(options.filter({ hasText: "Landing graph" })).toHaveCount(1);
  await expect(options.filter({ hasText: "Court relay" })).toHaveCount(0);

  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect(page.locator("#chat-log")).toContainText("Parent enter");
  await expect(page.locator("#chat-log")).toContainText("Child enter@region");
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(zones.locator("li").filter({ hasText: "Court relay" })).toContainText("1 run(s)");
  await expect(zones.locator("li").filter({ hasText: "Landing graph" })).toContainText("1 run(s)");
});

test("a player fires a handout's tile link from the journals window without receiving the anchor", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    // A CONCEALED tile with one manual graph over it: the player can never see the tile,
    // and the graph is not published for canvas triggers — the handout is the only route.
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tileEditor = zones.locator("[data-zone-tile-create]");
    await tileEditor.getByLabel("Tile name").fill("Hidden gate");
    await tileEditor.getByLabel("Concealed trap tile").check();
    await tileEditor.getByLabel("X", { exact: true }).fill("350");
    await tileEditor.getByLabel("Y", { exact: true }).fill("400");
    await tileEditor.getByLabel("Width").fill("200");
    await tileEditor.getByLabel("Height").fill("160");
    await tileEditor.locator("[data-zone-create-tile]").click();
    const gateOption = zones.locator("[data-zone-tile] option").filter({ hasText: "Hidden gate" });
    await expect(gateOption).toHaveCount(1);
    const gateId = await gateOption.getAttribute("value");
    if (!gateId) throw new Error("the concealed tile did not receive a host ID");
    await zones.locator("[data-zone-tile]").selectOption(gateId);
    await zones.locator("[data-zone-name]").fill("Gate relay");
    await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").uncheck();
    await zones.locator(".methods label").filter({ hasText: "manual" }).locator("input").check();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text")
      .fill("Gate opened by {{user}} from {{originSource}}");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.locator("li").filter({ hasText: "Gate relay" })).toHaveCount(1);
    await host.locator('[data-window="macros"] [data-window-close]').click();

    // The handout carries the MATT-style link naming that tile id.
    await host.locator('[data-tab="journals"]').click();
    await host.locator("#journal-create").click();
    await host.locator("#journal-edit-btn").click();
    await host.locator("#journal-edit")
      .fill("# The gate\n\nSay the word, then @Tile[" + gateId + "]{open the gate}.");
    await host.locator("#journal-save").click();
    await expect(host.locator(".journals .page")).toContainText("open the gate");

    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");

    // The player's handouts reader shows the label as a button; the anchor id is nowhere
    // in their shell (the host blanked every link target before delivery).
    await player.locator("[data-player-handouts]").click();
    const handouts = player.locator('[data-window="handouts"]');
    await handouts.locator("[data-handout-journal]").first().click();
    const link = handouts.locator('[data-journal-tile-link="0"]');
    await expect(link).toHaveText("open the gate");
    const playerShell = await player.content();
    expect(playerShell).not.toContain(gateId);

    const before = await hostCall<number>(host, "seq");
    const playerId = await playerCall<string>(player, "userId");
    await link.click();
    // the GM sees the line in the chat UI; the player only sees the neutral mirrored copy
    const line = "Gate opened by " + playerId + " from journal";
    await host.locator('[data-tab="chat"]').click();
    await expect(host.locator("#chat-log")).toContainText(line);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(before + 1);
    await expect(player.locator("#chat-log")).not.toContainText("Gate opened");
    expect(await player.content()).not.toContain(gateId);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("wizard deletes one persistent variable, keeps its sibling, undoes and reloads the deletion", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Variable tile");
  await zones.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Variable tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Variable eraser");
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  for (const name of ["charge", "keep"]) {
    await zones.locator('[data-zone-add="set"]').click();
    const step = zones.locator("[data-zone-step]").last();
    await step.getByLabel("Name", { exact: true }).fill(name);
    await step.getByLabel("Variable scope").selectOption("tile");
    await step.getByLabel("Value", { exact: true }).fill("9");
  }
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect(zones.locator("li").filter({ hasText: "Variable eraser" })).toHaveCount(1);
  await zones.getByLabel("Simulate method").selectOption("manual");
  await zones.locator("[data-zone-run]").click();
  await zones.locator("[data-zone-variables] summary").click();
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["charge: 9", "keep: 9"]);

  const charge = zones.locator("[data-zone-step]").nth(1);
  await charge.getByLabel("Variable operation").selectOption("delete");
  await expect(charge.getByLabel("Value", { exact: true })).toHaveCount(0);
  // Switching back seeds a valid numeric assignment; switching to Delete omits value again.
  await charge.getByLabel("Variable operation").selectOption("assign");
  await expect(charge.getByLabel("Value", { exact: true })).toHaveValue("0");
  await charge.getByLabel("Variable operation").selectOption("delete");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await zones.locator("li").filter({ hasText: "Variable eraser" }).getByRole("button", { name: "Edit" }).click();
  await expect(charge.getByLabel("Variable operation")).toHaveValue("delete");
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["keep: 9"]);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["charge: 9", "keep: 9"]);
  await zones.locator("[data-zone-run]").click();
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["keep: 9"]);
  await hostCall<number>(page, "drainOps");
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Variable eraser" }).getByRole("button", { name: "Edit" }).click();
  await expect(charge.getByLabel("Variable operation")).toHaveValue("delete");
  await expect(charge.getByLabel("Value", { exact: true })).toHaveCount(0);
  await zones.locator("[data-zone-variables] summary").click();
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["keep: 9"]);
  // Repeated deletion of an absent name still commits only the normal graph fire.
  const reloadedSeq = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(reloadedSeq + 1);
  await expect(zones.locator("[data-zone-variables] li")).toHaveText(["keep: 9"]);
});

test("GM door open/close fires a door-method graph anchored over the door, once per change", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  // Find a clear sight lane on the starter map, so the door cannot be confused with an existing
  // wall when the canvas tool later clicks it (the same probe walls.spec.ts uses).
  let lane: { x: number; y: number } | null = null;
  for (let x = 200; x <= 1800 && !lane; x += 200) {
    for (let y = 300; y <= 1100 && !lane; y += 200) {
      const probe = await surfaceCallArg<{ sees: boolean }>(page, "app", "wallSightProbe",
        { from: { x, y }, to: { x, y: y + 200 }, radius: 500 });
      if (probe.sees) lane = { x, y: y + 100 };
    }
  }
  if (!lane) throw new Error("no open lane found on the starter map");
  const doorMid = { x: lane.x, y: lane.y };

  // Place a real door (closed) across that lane through the rail, then click it with the same
  // tool: the second click is what the graph must see.
  await page.locator('[data-canvas-layer="gm"]').click();
  await page.locator('[data-canvas-tool="wall"]').click();
  await page.locator('[data-canvas-wall-kind="door"]').click();
  await page.locator('[data-canvas-door-state="closed"]').click();
  const screenOf = async (point: { x: number; y: number }) => {
    const at = await surfaceCallArg<{ x: number; y: number } | null>(page, "app", "screenOf", point);
    if (!at) throw new Error("screenOf returned null");
    return at;
  };
  const from = await screenOf({ x: doorMid.x - 100, y: doorMid.y });
  const to = await screenOf({ x: doorMid.x + 100, y: doorMid.y });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await hostCall<Array<{ door: number }>>(page, "walls")).length)
    .toBeGreaterThan(0);
  const placed = (await hostCall<Array<{ id: string; c: [number, number, number, number]; door: number }>>(page, "walls"))
    .find((wall) => Math.abs((wall.c[0] + wall.c[2]) / 2 - doorMid.x) < 1 &&
      Math.abs((wall.c[1] + wall.c[3]) / 2 - doorMid.y) < 1);
  if (!placed) throw new Error("the door was not placed at the probed lane");
  expect(placed.door).toBe(0);

  // Author the graph anchored on a tile that covers the door midpoint.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Door plate");
  await tile.getByLabel("X", { exact: true }).fill(String(doorMid.x - 100));
  await tile.getByLabel("Y", { exact: true }).fill(String(doorMid.y - 80));
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("160");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Door plate" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Door bell");
  // A door-only graph: drop the fresh-draft enter/stop/manual defaults, then subscribe to the
  // two change kinds the canvas click can produce.
  for (const method of ["enter", "stop", "manual"])
    await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
      .locator("input").uncheck();
  await zones.locator(".methods label").filter({ hasText: "door open" }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "door close" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Door bell" })).toHaveCount(1);
  // A graph whose only methods are host-observed offers no Simulate control, and says why.
  await zones.locator("li").filter({ hasText: "Door bell" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.locator("small").filter({ hasText: /fires? automatically/ })).toHaveCount(1);
  await expect(zones.getByText("Simulate method")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // Clicking the door is the real door change: open, then close.
  const clickDoor = async () => {
    const at = await screenOf(doorMid);
    await page.mouse.click(at.x, at.y);
  };
  const doorOf = async () =>
    (await hostCall<Array<{ id: string; door: number }>>(page, "walls")).find((wall) => wall.id === placed.id)?.door;
  await clickDoor();
  await expect.poll(doorOf).toBe(1);
  await expect(page.locator("#chat-log")).toContainText("doorOpen by");
  await clickDoor();
  await expect.poll(doorOf).toBe(0);
  await expect(page.locator("#chat-log")).toContainText("doorClose by");

  // The host history keeps one entry per change, and it is reset separately from the door state.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const history = page.locator("[data-zone-history]");
  await history.locator("summary").click();
  await expect(history.locator("li").filter({ hasText: /: doorOpen · gm$/ })).toHaveCount(1);
  await expect(history.locator("li").filter({ hasText: /: doorClose · gm$/ })).toHaveCount(1);
});

test("GM combat start/round/turn/end fires combat-method graphs in the encounter scene, once per change", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.click("#add-token");
  await page.click("#add-token");

  // Author a scene graph that hears all five MATT combat kinds.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Combat plate");
  await tile.getByLabel("X", { exact: true }).fill("300");
  await tile.getByLabel("Y", { exact: true }).fill("300");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Combat plate" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Combat alarm");
  // Drop the fresh-draft defaults, then subscribe to the five combat kinds.
  for (const method of ["enter", "stop", "manual"])
    await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
      .locator("input").uncheck();
  for (const method of ["combat start", "combat round", "combat turn start", "combat turn end", "combat end"])
    await zones.locator(".methods label").filter({ hasText: method }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Combat alarm" })).toHaveCount(1);
  // Combat-only graphs are host-observed: no Simulate control, and the panel says why.
  await zones.locator("li").filter({ hasText: "Combat alarm" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.locator("small").filter({ hasText: /fires? automatically/ })).toHaveCount(1);
  await expect(zones.getByText("Simulate method")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // Starting the tracker encounter is the real host commit: start, round and turn all begin.
  // The chat log and the tracker are separate sidebar tabs, so read each where it renders.
  const chat = async (needle: string) => {
    await page.click('[data-tab="chat"]');
    await expect(page.locator("#chat-log")).toContainText(needle);
  };
  const chatText = async () => {
    await page.click('[data-tab="chat"]');
    return page.locator("#chat-log").innerText();
  };
  const occurrences = async (needle: string) => (await chatText()).split(needle).length - 1;
  const tracker = async () => page.click('[data-tab="combat"]');
  await tracker();
  await page.click("#combat-start");
  await chat("combatStart by");
  expect(await occurrences("combatStart by")).toBe(1);
  expect(await occurrences("combatRound by")).toBe(1);
  expect(await occurrences("combatTurnStart by")).toBe(1);
  expect(await occurrences("combatTurnEnd by")).toBe(0);

  // One next-turn: the outgoing combatant ends and the next one starts — once each.
  await tracker();
  await page.click("#combat-next");
  await chat("combatTurnEnd by");
  expect(await occurrences("combatTurnEnd by")).toBe(1);
  expect(await occurrences("combatTurnStart by")).toBe(2);

  // Walk to the next round: the wrap adds exactly one round announcement.
  await tracker();
  for (let i = 0; i < 12; i++) {
    if ((await page.locator(".combat .round").innerText()).includes("Round 2")) break;
    await page.click("#combat-next");
  }
  await expect(page.locator(".combat .round")).toContainText("Round 2");
  expect(await occurrences("combatRound by")).toBe(2);
  const text = await chatText();
  expect(text.indexOf("combatStart by")).toBeLessThan(text.indexOf("combatRound by"));
  expect(text.indexOf("combatRound by")).toBeLessThan(text.indexOf("combatTurnStart by"));
  expect(text.indexOf("combatTurnStart by")).toBeLessThan(text.indexOf("combatTurnEnd by"));

  // Ending the encounter fires combatEnd once.
  await tracker();
  await page.click("#combat-end");
  await chat("combatEnd by");
  expect(await occurrences("combatEnd by")).toBe(1);

  // Host history keeps one entry per change, keyed by the method name.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const history = page.locator("[data-zone-history]");
  await history.locator("summary").click();
  // Every fire carries the current combatant's token id, so the row ends with a third field.
  await expect(history.locator("li").filter({ hasText: /: combatStart · gm · .+$/ })).toHaveCount(1);
  await expect(history.locator("li").filter({ hasText: /: combatEnd · gm · .+$/ })).toHaveCount(1);
});

test("GM lighting and world-clock changes fire their host-dispatched graph, once per committed change", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");

  // Author a scene graph that hears both environment kinds.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Dawn plate");
  await tile.getByLabel("X", { exact: true }).fill("300");
  await tile.getByLabel("Y", { exact: true }).fill("300");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Dawn plate" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Environment alarm");
  for (const method of ["enter", "stop", "manual"])
    await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
      .locator("input").uncheck();
  await zones.locator(".methods label").filter({ hasText: "lighting change" }).locator("input").check();
  await zones.locator(".methods label").filter({ hasText: "time change" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Environment alarm" })).toHaveCount(1);
  await zones.locator("li").filter({ hasText: "Environment alarm" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.locator("small").filter({ hasText: /fires? automatically/ })).toHaveCount(1);
  await expect(zones.getByText("Simulate method")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // Settings → Ambient darkness is a committed scene value; the clock buttons commit the
  // replicated world clock. Both are real world edits, not simulations.
  await page.locator("#gm-settings").click();
  const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-scene-darkness]").fill("0.4");
  await settings.locator("[data-scene-darkness]").dispatchEvent("change");
  const log = async (needle: string) => {
    await page.click('[data-tab="chat"]');
    await expect(page.locator("#chat-log")).toContainText(needle);
  };
  await log("lightingChange by");
  await settings.locator("[data-clock-hour]").click();
  await log("timeChange by");
  const chatText = async () => {
    await page.click('[data-tab="chat"]');
    return page.locator("#chat-log").innerText();
  };
  const occurrences = async (needle: string) => (await chatText()).split(needle).length - 1;
  expect(await occurrences("lightingChange by")).toBe(1);
  expect(await occurrences("timeChange by")).toBe(1);

  // A second darkness edit at the same value is not an event; a different one is.
  await settings.locator("[data-scene-darkness]").fill("0.4");
  await settings.locator("[data-scene-darkness]").dispatchEvent("change");
  await page.waitForTimeout(150);
  expect(await occurrences("lightingChange by")).toBe(1);
  await settings.locator("[data-scene-darkness]").fill("0.6");
  await settings.locator("[data-scene-darkness]").dispatchEvent("change");
  await expect.poll(() => occurrences("lightingChange by")).toBe(2);

  // Host history keeps one entry per change, keyed by the method name.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const history = page.locator("[data-zone-history]");
  await history.locator("summary").click();
  // Environment events carry no triggering token, so the row ends at the user.
  await expect(history.locator("li").filter({ hasText: /: lightingChange · gm$/ })).toHaveCount(2);
  await expect(history.locator("li").filter({ hasText: /: timeChange · gm$/ })).toHaveCount(1);
});

test("a connecting player loading the scene fires its sceneLoad graph, and a reconnect of the same scene does not", async ({ browser }: { browser: Browser }) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Arrival plate");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Arrival plate" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Arrival bell");
    for (const method of ["enter", "stop", "manual"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.locator(".methods label").filter({ hasText: "scene load" }).locator("input").check();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator("[data-zone-save]").click();
    await expect(zones.locator("li").filter({ hasText: "Arrival bell" })).toHaveCount(1);
    await zones.locator("li").filter({ hasText: "Arrival bell" }).getByRole("button", { name: "Edit" }).click();
    await expect(zones.locator("small").filter({ hasText: /fires? automatically/ })).toHaveCount(1);
    await expect(zones.getByText("Simulate method")).toHaveCount(0);
    await host.locator('[data-window="macros"] [data-window-close]').click();

    // The player's own connection load is the event: the GM's log names that player.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    await expect(host.locator("#chat-log")).toContainText(/sceneLoad by/);
    const chatText = async () => host.locator("#chat-log").innerText();
    const occurrences = (await chatText()).split("sceneLoad by").length - 1;
    expect(occurrences).toBe(1);
    // The graph is a GM-authored rule: the player's shell holds no such message. (A reload of
    // the same scene is covered deterministically by the host suite as "not a new load".)
    if ((await player.locator("#chat-log").count()) > 0)
      expect(await player.locator("#chat-log").innerText()).not.toContain("sceneLoad by");
    await host.waitForTimeout(300);
    expect((await chatText()).split("sceneLoad by").length - 1).toBe(1);

    // Host history keeps one entry for the load, keyed by the joining player's own user id.
    const playerId = await playerCall<string>(player, "userId");
    await expect(host.locator("#chat-log")).toContainText(`sceneLoad by ${playerId}`);
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const history = host.locator("[data-zone-history]");
    await history.locator("summary").click();
    await expect(history.locator("li").filter({ hasText: `: sceneLoad · ${playerId}` })).toHaveCount(1);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("a published automation macro runs its graph from the directory for the GM and for a player, without leaking the graph", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000); // two shells, a manual-signaling join and five DOM surfaces
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Bell plate");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Bell plate" })).toHaveCount(1);

    // A manual-only graph, published for players: exactly what a macro may reference.
    await zones.locator("[data-zone-name]").fill("Courtyard bell");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.getByPlaceholder("{{user}}, {{count}}, {{method}}").fill("Bell {{method}} {{user}}");
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: "Courtyard bell" });
    await expect(graphRow).toHaveCount(1);

    // Publishing stores a reference: the macro list shows it, the graph id stays in the panel.
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro/)).toHaveCount(1);
    const graphId = await graphRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    expect(graphId).toBeTruthy();

    // The directory tab and its status live beside the zones panel, inside the same window.
    const hostMacros = host.locator('[data-window="macros"]');
    await hostMacros.locator("[data-macro-automations-tab]").click();
    const macroRow = hostMacros.locator("[data-automation-macro]").filter({ hasText: "Courtyard bell" });
    await expect(macroRow).toHaveCount(1);
    await macroRow.locator("[data-automation-macro-run]").click();
    await expect(hostMacros.locator("[data-automation-status]")).toContainText("Fired Courtyard bell");
    await expect(host.locator("#chat-log")).toContainText("Bell manual gm");
    const gmRuns = (await host.locator("#chat-log").innerText()).split("Bell manual gm").length - 1;
    expect(gmRuns).toBe(1);

    // The player's own connection: they receive the macro entry, never the graph id.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    const playerId = await playerCall<string>(player, "userId");

    await player.locator("[data-player-macros]").click();
    const playerMacros = player.locator('[data-window="macros"]');
    await expect(playerMacros.locator("[data-macro-automations-tab]")).toHaveCount(1);
    await playerMacros.locator("[data-macro-automations-tab]").click();
    const playerMacro = playerMacros.locator("[data-automation-macro]").filter({ hasText: "Courtyard bell" });
    await expect(playerMacro).toHaveCount(1);
    // The callable entry carries no reference to the private graph anywhere in the shell.
    expect(await player.content()).not.toContain(graphId as string);
    await playerMacro.locator("[data-automation-macro-run]").click();
    await expect(playerMacros.locator("[data-automation-status]")).toContainText("Automation fired");

    // The graph ran under the player's identity; its GM-only line reached nobody else.
    await expect(host.locator("#chat-log")).toContainText(`Bell manual ${playerId}`);
    expect(await player.content()).not.toContain("Bell manual");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const history = host.locator("[data-zone-history]");
    await history.locator("summary").click();
    await expect(history.locator("li").filter({ hasText: `: manual · gm` })).toHaveCount(1);
    await expect(history.locator("li").filter({ hasText: `: manual · ${playerId}` })).toHaveCount(1);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("the /run chat command fires a published macro for the GM and for a player, and refuses an unpublished one", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(150_000); // two shells, a manual-signaling join and the publish/unpublish cycle
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");

    // A manual-only, published graph anchored on a fresh tile — exactly what a macro may reference.
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Command plate");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Command plate" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Command bell");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.getByPlaceholder("{{user}}, {{count}}, {{method}}").fill("Command {{method}} {{user}}");
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: "Command bell" });
    await expect(graphRow).toHaveCount(1);
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro/)).toHaveCount(1);
    const graphId = await graphRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    expect(graphId).toBeTruthy();

    // A second, deliberately unpublished graph: its macro is delivered like any other,
    // so the refusal has to come from the host. `New` clears the editor (otherwise Save
    // updates the graph just saved) and resets the methods to enter/stop/manual.
    await zones.getByRole("button", { name: "New" }).click();
    // The tile <details> is left open by the first create — only toggle it when closed.
    if (!(await zones.locator("[data-zone-create-tile]").isVisible()))
      await zones.locator("[data-zone-tile-create] summary").click();
    const draftTile = zones.locator("[data-zone-tile-create]");
    await draftTile.getByLabel("Tile name").fill("Draft plate");
    await draftTile.getByLabel("X", { exact: true }).fill("650");
    await draftTile.getByLabel("Y", { exact: true }).fill("400");
    await draftTile.getByLabel("Width").fill("200");
    await draftTile.getByLabel("Height").fill("160");
    await draftTile.locator("[data-zone-create-tile]").click();
    const draftOption = zones.locator("[data-zone-tile] option").filter({ hasText: "Draft plate" });
    await expect(draftOption).toHaveCount(1);
    const draftTileId = await draftOption.getAttribute("value");
    if (!draftTileId) throw new Error("the draft tile did not receive a host ID");
    await zones.locator("[data-zone-tile]").selectOption(draftTileId);
    await zones.locator("[data-zone-name]").fill("Command draft");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").uncheck();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Draft {{method}} {{user}}");
    await zones.locator("[data-zone-save]").click();
    const draftRow = zones.locator("li").filter({ hasText: "Command draft" });
    await expect(draftRow).toHaveCount(1);
    await draftRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro "Command draft"/)).toHaveCount(1);
    const draftGraphId = await draftRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    expect(draftGraphId).toBeTruthy();
    await host.locator('[data-window="macros"] [data-window-close]').click();

    // The GM's command line: discoverable usage, an unknown name, then a real fire.
    await host.locator('[data-tab="chat"]').click();
    const gmStatus = host.locator("[data-chat-command-status]");
    await host.locator("#chat-input").fill("/run");
    await host.locator("#chat-send").click();
    await expect(gmStatus).toHaveText("usage: /run <macro name>");
    await host.locator("#chat-input").fill("/run Nothing here");
    await host.locator("#chat-send").click();
    await expect(gmStatus).toHaveText('no macro named "Nothing here"');
    await host.locator("#chat-input").fill("/run Command bell");
    await host.locator("#chat-send").click();
    await expect(gmStatus).toHaveText("Fired Command bell");
    await expect(host.locator("#chat-log")).toContainText("Command manual gm");
    const gmRuns = (await host.locator("#chat-log").innerText()).split("Command manual gm").length - 1;
    expect(gmRuns).toBe(1);
    // The command itself never becomes a chat message.
    expect(await host.locator("#chat-log").innerText()).not.toContain("/run");

    // A joined player runs the same command from their own chat dock.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    const playerId = await playerCall<string>(player, "userId");

    const playerStatus = player.locator("[data-chat-command-status]");
    await player.locator("#chat-input").fill("/run Command bell");
    await player.locator("#chat-send").click();
    await expect(playerStatus).toHaveText("Automation fired");
    await expect(host.locator("#chat-log")).toContainText(`Command manual ${playerId}`);
    const playerRuns = (await host.locator("#chat-log").innerText()).split(`Command manual ${playerId}`).length - 1;
    expect(playerRuns).toBe(1);
    expect(await player.content()).not.toContain(graphId as string);
    expect(await player.locator("#chat-log").innerText()).not.toContain("Command manual");
    expect(await player.locator("#chat-log").innerText()).not.toContain("/run");

    // The unpublished graph's macro is delivered, and the host refuses it: no fire,
    // no line, and no refusal reason beyond the neutral one a player may hear.
    await player.locator("#chat-input").fill("/run Command draft");
    await player.locator("#chat-send").click();
    await expect(playerStatus).toHaveText("Refused: automation macro unavailable");
    expect(await host.locator("#chat-log").innerText()).not.toContain("Draft manual");
    expect(await player.content()).not.toContain(draftGraphId as string);
    // The published graph fired exactly once for each caller — the refusal added nothing.
    expect((await host.locator("#chat-log").innerText()).split("Command manual gm").length - 1).toBe(1);
    expect((await host.locator("#chat-log").innerText()).split(`Command manual ${playerId}`).length - 1).toBe(1);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("a player's macro hotbar exposes the GM's slot assignments and answers the number keys", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Slot plate");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Slot plate" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Slot bell");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("Slot {{method}} {{user}}");
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: "Slot bell" });
    await expect(graphRow).toHaveCount(1);
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro "Slot bell"/)).toHaveCount(1);
    const graphId = await graphRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    expect(graphId).toBeTruthy();

    // The GM binds the macro to slot 1 in the directory; the shell's own row follows.
    const hostMacros = host.locator('[data-window="macros"]');
    await hostMacros.locator("[data-macro-automations-tab]").click();
    const macroRow = hostMacros.locator("[data-automation-macro]").filter({ hasText: "Slot bell" });
    await expect(macroRow).toHaveCount(1);
    await macroRow.locator("[data-macro-slot]").selectOption("1");
    await expect(macroRow.locator("[data-macro-slot]")).toHaveValue("1");
    await host.locator('[data-window="macros"] [data-window-close]').click();
    const gmSlot = host.locator('[data-macro-hotbar] [data-hotbar-slot="1"]');
    await expect(gmSlot).toHaveAttribute("title", "Slot bell");
    // An unassigned slot stays inert.
    await expect(host.locator('[data-macro-hotbar] [data-hotbar-slot="2"]')).toBeDisabled();
    await gmSlot.click();
    await expect(host.locator("#chat-log")).toContainText("Slot manual gm");
    const gmRuns = (await host.locator("#chat-log").innerText()).split("Slot manual gm").length - 1;
    expect(gmRuns).toBe(1);

    // The player gets the same row from their own delivered macros: click and key both run it.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    const playerId = await playerCall<string>(player, "userId");

    const playerSlot = player.locator('[data-macro-hotbar] [data-hotbar-slot="1"]');
    await expect(playerSlot).toHaveAttribute("title", "Slot bell");
    expect(await player.content()).not.toContain(graphId as string);
    await playerSlot.click();
    await expect(host.locator("#chat-log")).toContainText(`Slot manual ${playerId}`);
    await expect.poll(() => host.locator("#chat-log").innerText()).toContain("Slot manual " + playerId);
    // The number keys are claimed only while the slot holds a macro.
    await player.locator("#chat-input").fill("1");
    await player.locator("#chat-send").click();
    await expect(host.locator("#chat-log")).toContainText("1");
    const typedRuns = (await host.locator("#chat-log").innerText()).split(`Slot manual ${playerId}`).length - 1;
    expect(typedRuns).toBe(1); // typing "1" into the chat box must not fire the slot
    await player.locator("#chat-input").fill("");
    await player.locator("#chat-input").blur();
    await player.keyboard.press("1");
    await expect
      .poll(async () => (await host.locator("#chat-log").innerText()).split(`Slot manual ${playerId}`).length - 1,
        { timeout: 20_000 })
      .toBe(2);
    await expect(player.locator("#chat-log")).not.toContainText("Slot manual");
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("a GM builds a composite from saved automation macros and runs it from the directory and /run", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  // Two published graphs on one tile, each with its own chat line.
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.locator("summary").click();
  await tile.getByLabel("Tile name").fill("Composite plate");
  await tile.getByLabel("X", { exact: true }).fill("350");
  await tile.getByLabel("Y", { exact: true }).fill("400");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("160");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Composite plate" })).toHaveCount(1);
  for (const name of ["First bell", "Second bell"]) {
    if (name === "Second bell") await zones.getByRole("button", { name: "New" }).click();
    await zones.locator("[data-zone-tile]").selectOption(
      (await zones.locator("[data-zone-tile] option").filter({ hasText: "Composite plate" }).getAttribute("value")) as string,
    );
    await zones.locator("[data-zone-name]").fill(name);
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text")
      .fill(name === "First bell" ? "First {{method}} {{user}}" : "Second {{method}} {{user}}");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.locator("li").filter({ hasText: name })).toHaveCount(1);
    await zones.locator("li").filter({ hasText: name }).locator("[data-zone-macro]").click();
    await expect(zones.getByText(new RegExp(`Published automation macro "${name}"`))).toHaveCount(1);
  }
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // The directory's automation tab lists both macros and now builds composites from them.
  await page.locator("#gm-macros").click();
  const macros = page.locator('[data-window="macros"]');
  await macros.locator("[data-macro-automations-tab]").click();
  await expect(macros.locator("[data-automation-macro]")).toHaveCount(2);
  const editor = macros.locator("[data-composite-editor]");
  await editor.locator("[data-composite-name]").fill("Opening script");
  await editor.locator("[data-composite-add]").click();
  await editor.locator("[data-composite-add]").click();
  await expect(editor.locator("[data-composite-children-list] li")).toHaveCount(2);
  // Order is explicit: the second row is re-pointed at the other macro.
  const firstChild = await editor.locator("[data-composite-child]").nth(0).inputValue();
  const secondChild = await editor.locator("[data-composite-child]").nth(1).inputValue();
  expect(firstChild).not.toBe(secondChild);
  await editor.locator("[data-composite-save]").click();
  const comboRow = macros.locator("[data-composite-macro]").filter({ hasText: "Opening script" });
  await expect(comboRow).toHaveCount(1);
  await expect(comboRow.locator("[data-composite-children]")).toHaveText("2 macro(s)");

  // Run it from the directory: both graphs fire, in order, in one request.
  const before = await hostCall<number>(page, "seq");
  await comboRow.locator("[data-composite-run]").click();
  const log = page.locator("#chat-log");
  await expect(log).toContainText("First manual gm");
  await expect(log).toContainText("Second manual gm");
  const lines = await log.innerText();
  expect(lines.indexOf("First manual gm")).toBeLessThan(lines.indexOf("Second manual gm"));
  // Each child graph fires in its own envelope (and its own undo step), so the
  // composite advances the host sequence twice — one commit per child.
  await expect.poll(() => hostCall<number>(page, "seq"), { timeout: 20_000 }).toBe(before + 2);

  // …then from the chat command, which dispatches the composite by name.
  await page.locator('[data-tab="chat"]').click();
  const status = page.locator("[data-chat-command-status]");
  await page.locator("#chat-input").fill("/run Opening script");
  await page.locator("#chat-send").click();
  await expect(status).toHaveText("Fired Opening script (2 macro(s))");
  const runs = (await page.locator("#chat-log").innerText()).split("First manual gm").length - 1;
  expect(runs).toBe(2);
  // Both children recorded two runs of their own (directory + chat command).
  await macros.locator("[data-macro-zones-tab]").click();
  await expect(zones.locator("li").filter({ hasText: "First bell" })).toContainText("2 run(s)");
  await expect(zones.locator("li").filter({ hasText: "Second bell" })).toContainText("2 run(s)");
});

test("a GM declares typed inputs on a macro and a player supplies them from the chat line and the directory", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(150_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");

    // A published manual graph whose chat line interpolates the invocation arguments.
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.locator("summary").click();
    await tile.getByLabel("Tile name").fill("Args plate");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Args plate" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Args bell");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text")
      .fill("rounds={{arg.rounds}} label={{arg.label}}");
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: "Args bell" });
    await expect(graphRow).toHaveCount(1);
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro "Args bell"/)).toHaveCount(1);
    const graphId = await graphRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    expect(graphId).toBeTruthy();

    // The GM declares two inputs in the directory: a required number and an optional string.
    const macros = host.locator('[data-window="macros"]');
    await macros.locator("[data-macro-automations-tab]").click();
    const macroRow = macros.locator("[data-automation-macro]").filter({ hasText: "Args bell" });
    await expect(macroRow).toHaveCount(1);
    await macroRow.locator('[data-automation-inputs]').click();
    const editor = macros.locator("[data-automation-inputs-editor]");
    await editor.locator("[data-automation-input-add]").click();
    await editor.getByLabel("Input 1 name").fill("rounds");
    const numberOption = editor.getByLabel("Input 1 type").locator("option").filter({ hasText: "number" });
    await expect(numberOption).toHaveCount(1);
    await editor.getByLabel("Input 1 type").selectOption((await numberOption.getAttribute("value")) as string);
    await editor.getByLabel("Input 1 required").check();
    await editor.locator("[data-automation-input-add]").click();
    await editor.getByLabel("Input 2 name").fill("label");
    await editor.locator("[data-automation-input-save]").click();
    // The declaration reached the document, and the row now shows the count.
    await expect(macroRow.locator('[data-automation-inputs]')).toContainText("Inputs (2)");

    // Run from the directory asks for the declared values first.
    await macroRow.locator("[data-automation-macro-run]").click();
    const runEditor = macros.locator("[data-automation-run-editor]");
    await runEditor.getByLabel("rounds").fill("2");
    await runEditor.getByLabel("label").fill("open now");
    await runEditor.locator("[data-automation-run-with]").click();
    await host.locator('[data-window="macros"] [data-window-close]').click();
    await host.locator('[data-tab="chat"]').click();
    await expect(host.locator("#chat-log")).toContainText("rounds=2 label=open now");
    // A bad value is refused before anything is sent.
    await host.locator("#chat-input").fill("/run Args bell rounds=abc");
    await host.locator("#chat-send").click();
    await expect(host.locator("[data-chat-command-status]")).toHaveText("invalid rounds");
    expect((await host.locator("#chat-log").innerText()).split("rounds=").length - 1).toBe(1);

    // The player calls the same macro from their own chat line, with named then positional values.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    expect(await player.content()).not.toContain(graphId as string);

    const status = player.locator("[data-chat-command-status]");
    // The delivered entry carries the declared schema (a caller needs it) and never the id.
    const playerCallable = await playerCall<string>(player, "macroCallable");
    expect(playerCallable).toContain('"rounds"');
    expect(playerCallable).toContain('"required":true');
    expect(playerCallable).not.toContain(graphId as string);
    // A missing required input is refused locally, by the same binder the host enforces.
    await player.locator("#chat-input").fill("/run Args bell");
    await player.locator("#chat-send").click();
    await expect(status).toHaveText("missing rounds");
    // Named values…
    await player.locator("#chat-input").fill('/run Args bell rounds=5 label="the vault"');
    await player.locator("#chat-send").click();
    await expect(status).toHaveText("Automation fired");
    await expect(host.locator("#chat-log")).toContainText("rounds=5 label=the vault");
    // …and positional values for the same schema.
    await player.locator("#chat-input").fill('/run "Args bell" 7 door');
    await player.locator("#chat-send").click();
    await expect(host.locator("#chat-log")).toContainText("rounds=7 label=door");
    // The player never sees the GM-only line, and no argument text became a message of its own.
    expect(await player.locator("#chat-log").innerText()).not.toContain("rounds=");
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("a macro's token input defaults to the caller's selected token on both shells", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    // One tabletop token, at the scene centre, visible and movable by players (D-061 default).
    await host.locator("#add-token").click();
    await expect.poll(() => hostCall<number>(host, "tokenCount")).toBe(1);

    // A published manual graph that reports the token it was handed.
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-zones-tab]").click();
    const zones = host.locator("[data-active-zones]");
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.locator("summary").click();
    await tile.getByLabel("Tile name").fill("Selection plate");
    await tile.getByLabel("X", { exact: true }).fill("700");
    await tile.getByLabel("Y", { exact: true }).fill("700");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Selection plate" })).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill("Select bell");
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) })
        .locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").check();
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill("struck {{arg.target}}");
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: "Select bell" });
    await expect(graphRow).toHaveCount(1);
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(/Published automation macro "Select bell"/)).toHaveCount(1);

    // The GM declares one required token input, defaulted from the caller's selection.
    const macros = host.locator('[data-window="macros"]');
    await macros.locator("[data-macro-automations-tab]").click();
    const macroRow = macros.locator("[data-automation-macro]").filter({ hasText: "Select bell" });
    await expect(macroRow).toHaveCount(1);
    await macroRow.locator("[data-automation-inputs]").click();
    const editor = macros.locator("[data-automation-inputs-editor]");
    await editor.locator("[data-automation-input-add]").click();
    await editor.getByLabel("Input 1 name").fill("target");
    await editor.getByLabel("Input 1 type").selectOption("token");
    await editor.getByLabel("Input 1 from selection").check();
    await editor.getByLabel("Input 1 required").check();
    await editor.locator("[data-automation-input-save]").click();
    await expect(macroRow.locator("[data-automation-inputs]")).toContainText("Inputs (1)");

    // With nothing selected the run form refuses locally and fires nothing.
    await macroRow.locator("[data-automation-macro-run]").click();
    const runEditor = macros.locator("[data-automation-run-editor]");
    await expect(runEditor.locator("[data-automation-run-selected]")).toContainText("select a token");
    await runEditor.locator("[data-automation-run-with]").click();
    await expect(runEditor.locator("[data-automation-run-error]")).toHaveText("select a token for target");
    // Select the token on the GM canvas, then run with the field left blank.
    await host.locator('[data-window="macros"] [data-window-close]').click();
    const tokenWorld = await hostCall<{ x: number; y: number } | null>(host, "tokenPos");
    if (!tokenWorld) throw new Error("the tabletop token is missing");
    const tokenAt = await surfaceCallArg<{ x: number; y: number }>(host, "app", "screenOf",
      { x: tokenWorld.x, y: tokenWorld.y });
    await host.locator('[data-canvas-tool="select"]').click();
    // A token's document point is its centre, so the canvas hit test wants that exact point.
    await host.mouse.click(tokenAt.x, tokenAt.y);
    await host.locator("#gm-macros").click();
    await macros.locator("[data-macro-automations-tab]").click();
    await expect(macroRow).toHaveCount(1);
    await macroRow.locator("[data-automation-macro-run]").click();
    await host.locator('[data-automation-run-editor] [data-automation-run-with]').click();
    await host.locator('[data-window="macros"] [data-window-close]').click();
    await host.locator('[data-tab="chat"]').click();
    const fired = host.locator("#chat-log");
    await expect(fired).toContainText("struck ");
    const firstLine = (await fired.innerText()).match(/struck\s+(\S+)/)?.[1];
    expect(firstLine).toBeTruthy();

    // Clearing the selection removes the default: the same `/run` is refused locally.
    const empty = await surfaceCallArg<{ x: number; y: number }>(host, "app", "screenOf", { x: 100, y: 100 });
    await host.mouse.click(empty.x, empty.y);
    await host.locator("#chat-input").fill("/run Select bell");
    await host.locator("#chat-send").click();
    await expect(host.locator("[data-chat-command-status]")).toHaveText("select a token for target");
    expect((await fired.innerText()).split("struck ").length - 1).toBe(1);

    // The player: no selection yet, so their own `/run` is refused with the same local reason.
    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    const status = player.locator("[data-chat-command-status]");
    await player.locator("#chat-input").fill("/run Select bell");
    await player.locator("#chat-send").click();
    await expect(status).toHaveText("select a token for target");

    // Selecting the one token the player can see makes the identical command fire with *that* token.
    const pickable = await surfaceCall<string[]>(player, "playerCanvas", "pickableTokens");
    expect(pickable).toContain(firstLine as string);
    const playerWorld = await playerCall<{ x: number; y: number } | null>(player, "tokenPos");
    if (!playerWorld) throw new Error("the player replica holds no token");
    const playerAt = await surfaceCallArg<{ x: number; y: number }>(player, "playerCanvas", "screenOf",
      { x: playerWorld.x, y: playerWorld.y });
    await player.mouse.click(playerAt.x, playerAt.y);
    await player.locator("#chat-input").fill("/run Select bell");
    await player.locator("#chat-send").click();
    await expect(status).toHaveText("Automation fired");
    await expect.poll(async () => (await fired.innerText()).split("struck ").length - 1).toBe(2);
    expect((await fired.innerText()).match(/struck\s+(\S+)/g)).toEqual([
      `struck ${firstLine as string}`, `struck ${firstLine as string}`,
    ]);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});
