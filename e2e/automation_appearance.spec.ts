import { expect, test, type Page } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, surfaceCall, surfaceCallArg, solidPng, waitForSurface } from "./lib";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Sq9hX8AAAAASUVORK5CYII=", "base64");
async function openZone(page: Page, name: string) {
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill(name);
  await zones.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: name })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill(name);
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  return zones;
}

// The background sprite and tile texture are inspected on the real Pixi stage,
// not inferred from a saved document, a trace string or the editor's controls.
async function drawn(page: Page, tileId: string) {
  return page.evaluate((id) => {
    type View = {
      getTilesLayer(): { imageOf(id: string): string | null };
      app: { stage: { getChildByLabel(label: string, deep: boolean): { children: Array<{ texture?: { width: number; height: number } }> } | null } };
    };
    const globals = globalThis as unknown as { __stage?: View; __canvasStage?: View };
    const stage = globals.__stage ?? globals.__canvasStage;
    const images = stage?.app.stage.getChildByLabel("background", true)?.children.filter((child) => (child.texture?.width ?? 0) > 0) ?? [];
    return { tile: stage?.getTilesLayer().imageOf(id) ?? null,
      background: images.map((image) => ({ width: image.texture?.width, height: image.texture?.height })) };
  }, tileId);
}

async function ambientAlpha(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    type View={app:{stage:{getChildByLabel(label:string,deep:boolean):{alpha:number}|null}}};
    const g=globalThis as unknown as {__stage?:View;__canvasStage?:View};
    return (g.__stage??g.__canvasStage)?.app.stage.getChildByLabel("darkness",true)?.alpha??null;
  });
}

test("Scene Lighting fades the live overlay, interrupts smoothly, cuts for reduced motion and reloads", async ({page}) => {
  test.setTimeout(60_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  const zones=await openZone(page,"Twilight fade");
  await zones.locator('[data-zone-add="sceneLighting"]').click();
  await zones.getByLabel("Scene Lighting darkness").fill("1");
  await zones.getByLabel("Scene Lighting duration").fill("4000");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const run=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
    await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  await save();await expect.poll(()=>ambientAlpha(page)).toBe(0);await run();
  expect(await surfaceCall<number>(page,"gm","sceneDarkness")).toBe(1);
  await expect.poll(async()=>{const n=await ambientAlpha(page);return n!==null&&n>0.05&&n<0.95;}).toBe(true);
  // A second target supersedes the first fade without resetting to the committed 1.
  await zones.getByLabel("Scene Lighting darkness").fill("0.25");await save();
  const drawnBefore=await ambientAlpha(page);expect(drawnBefore).not.toBeNull();await run();
  const interrupted=await ambientAlpha(page);expect(interrupted).not.toBeNull();
  expect(Math.abs((interrupted??0)-(drawnBefore??0))).toBeLessThan(0.25);
  await expect.poll(()=>ambientAlpha(page),{timeout:7000}).toBe(0.25);
  // Reduced-motion change during a running fade cuts to its endpoint.
  await zones.getByLabel("Scene Lighting darkness").fill("0.8");await save();await run();
  await page.emulateMedia({reducedMotion:"reduce"});await expect.poll(()=>ambientAlpha(page)).toBe(0.8);
  await page.emulateMedia({reducedMotion:"no-preference"});
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await expect.poll(()=>ambientAlpha(page)).toBe(0.8);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Twilight fade"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Scene Lighting duration")).toHaveValue("4000");
  await zones.getByLabel("Scene Lighting duration").fill("0");await zones.getByLabel("Scene Lighting darkness").fill("0.5");
  await save();await run();await expect.poll(()=>ambientAlpha(page)).toBe(0.5);
});

test("Scene Lighting authors staged darkness, runs atomically, and undo/reload restore the real scene", async ({ page }) => {
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  const zones = await openZone(page, "Night switch");
  await zones.locator('[data-zone-add="sceneLighting"]').click();
  const lighting = zones.locator("[data-zone-step]").last();
  await lighting.getByLabel("Scene Lighting darkness").fill("0.75");
  await zones.locator('[data-zone-add="checkValue"]').click();
  const check = zones.locator("[data-zone-step]").last();
  await check.getByLabel("Check Value comparison").selectOption("eq");
  await check.getByLabel("Check Value threshold").fill("0.75");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Staged night");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect(zones.locator("li").filter({ hasText: "Night switch" })).toHaveCount(1);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(page.locator("#chat-log").getByText("Staged night")).toHaveCount(1);
  await expect.poll(() => surfaceCall<number>(page, "gm", "sceneDarkness")).toBe(0.75);
  await page.locator("#gm-settings").click();
  await expect(page.locator("[data-scene-darkness-value]")).toHaveText("75%");
  await page.locator('[data-window="settings"] [data-window-close]').click();
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(() => surfaceCall<number>(page, "gm", "sceneDarkness")).toBe(0);
  await expect(page.locator("#chat-log").getByText("Staged night")).toHaveCount(0);
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => surfaceCall<number>(page, "gm", "sceneDarkness")).toBe(0.75);
  await hostCall<number>(page, "drainOps");
  await page.reload(); await waitForSurface(page, "app");
  await expect.poll(() => surfaceCall<number>(page, "gm", "sceneDarkness")).toBe(0.75);
});

test("Scene Background and Switch Tile Image change live textures, undo, clear and survive reload", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({ name: "trap-floor.png", mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones = await openZone(page, "Image switch");
  const tileId = await zones.locator("[data-zone-tile]").inputValue();
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="sceneBackground"]').click();
  const bg = zones.locator("[data-zone-step]").nth(1).getByLabel("World action image");
  const imageOption = bg.locator("option").filter({ hasText: "trap-floor.png" });
  await expect(imageOption).toHaveCount(1);
  const hash = await imageOption.getAttribute("value");
  if (!hash) throw new Error("owned image missing");
  await bg.selectOption(hash);
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art = zones.locator("[data-zone-step]").nth(2).getByLabel("World action image");
  await art.selectOption(hash);
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect(zones.locator("li").filter({ hasText: "Image switch" })).toHaveCount(1);
  await zones.locator("li").filter({ hasText: "Image switch" }).getByRole("button", { name: "Edit" }).click();
  await expect(bg).toHaveValue(hash); await expect(art).toHaveValue(hash);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect.poll(() => hostCall<string | null>(page, "sceneImg")).toBe(hash);
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: hash, background: [{ width: 1, height: 1 }] });
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: null, background: [] });
  await expect.poll(() => hostCall<string | null>(page, "sceneImg")).toBeNull();
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: hash, background: [{ width: 1, height: 1 }] });
  await hostCall<number>(page, "drainOps");
  await page.reload(); await waitForSurface(page, "app");
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: hash, background: [{ width: 1, height: 1 }] });
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Image switch" }).getByRole("button", { name: "Edit" }).click();
  await bg.selectOption(""); await art.selectOption("");
  const seq = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-save]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: null, background: [] });
  await expect.poll(() => hostCall<string | null>(page, "sceneImg")).toBeNull();
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(() => drawn(page, tileId)).toEqual({ tile: hash, background: [{ width: 1, height: 1 }] });
});

test("a joined player receives and draws committed world art, then undo clears both canvases", async ({ browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext(), playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage(), player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await host.locator("#gm-macros").click(); await host.locator("[data-macro-fx-tab]").click();
    const wizard = host.locator("[data-fx-wizard]");
    await wizard.locator("[data-fx-share]").check();
    await wizard.locator('input[type="file"]').setInputFiles({ name: "revealed-floor.png", mimeType: "image/png", buffer: png });
    await expect(wizard.getByRole("status")).toContainText("Imported");
    await host.locator('[data-window="macros"] [data-window-close]').click();
    const zones = await openZone(host, "Shared scenery");
    const tileId = await zones.locator("[data-zone-tile]").inputValue();
    await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
    for (const kind of ["sceneBackground", "tileImage"]) {
      await zones.locator(`[data-zone-add="${kind}"]`).click();
      const field = zones.locator("[data-zone-step]").last().getByLabel("World action image");
      const hash = await field.locator("option").filter({ hasText: "revealed-floor.png" }).getAttribute("value");
      if (!hash) throw new Error("missing imported image");
      await field.selectOption(hash);
    }
    await zones.locator('[data-zone-add="sceneLighting"]').click();
    await zones.getByLabel("Scene Lighting darkness").fill("0.75");
    await zones.getByLabel("Scene Lighting duration").fill("1500");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.locator("li").filter({ hasText: "Shared scenery" })).toHaveCount(1);
    const hash = await zones.getByLabel("World action image").last().inputValue();
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
    await expect.poll(() => drawn(player, tileId)).toEqual({ tile: null, background: [] });
    await host.locator("#gm-macros").click(); await host.locator("[data-macro-zones-tab]").click();
    await zones.locator("li").filter({ hasText: "Shared scenery" }).getByRole("button", { name: "Edit" }).click();
    const before = await hostCall<number>(host, "seq");
    await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall<number>(host, "seq")).toBe(before + 1);
    for (const page of [host, player])
      await expect.poll(() => drawn(page, tileId), { timeout: 10_000 }).toEqual({ tile: hash, background: [{ width: 1, height: 1 }] });
    expect(await playerCall<string | null>(player, "sceneImg")).toBe(hash);
    for(const page of [host,player]) await expect.poll(()=>ambientAlpha(page)).toBe(0.75);
    await host.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    for (const page of [host, player])
      await expect.poll(() => drawn(page, tileId)).toEqual({ tile: null, background: [] });
    expect(await playerCall<string | null>(player, "sceneImg")).toBeNull();
    for(const page of [host,player]) await expect.poll(()=>ambientAlpha(page)).toBe(0);
  } finally { await playerCtx.close(); await hostCtx.close(); }
});


test("Scene Background targets another saved scene without switching scenes; undo and reload preserve the choice", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  const sourceId = await hostCall<string>(page, "activeSceneId");
  await page.locator("#scene-add").click(); await page.locator("#scene-new-blank").click();
  const remote = page.locator(`[data-scene]:not([data-scene="${sourceId}"])`);
  await expect(remote).toHaveCount(1);
  const remoteId = await remote.getAttribute("data-scene");
  if (!remoteId) throw new Error("remote scene missing");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({ name: "remote-map.png", mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones = await openZone(page, "Remote map switch");
  await zones.locator('[data-zone-add="sceneBackground"]').click();
  const step = zones.locator("[data-zone-step]").last();
  await step.getByLabel("Background scene").selectOption(remoteId);
  const image = step.getByLabel("World action image");
  const hash = await image.locator("option").filter({ hasText: "remote-map.png" }).getAttribute("value");
  if (!hash) throw new Error("image missing");
  await image.selectOption(hash);
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Remote map switch" })).toHaveCount(1);
  await zones.locator("li").filter({ hasText: "Remote map switch" }).getByRole("button", { name: "Edit" }).click();
  await expect(step.getByLabel("Background scene")).toHaveValue(remoteId);
  const remoteImage = () => surfaceCallArg<string | null>(page, "app", "sceneImgById", remoteId);
  await zones.locator("[data-zone-run]").click();
  await expect.poll(remoteImage).toBe(hash);
  expect(await hostCall(page, "activeSceneId")).toBe(sourceId);
  expect(await hostCall(page, "sceneImg")).toBeNull();
  expect((await drawn(page, "unused")).background).toEqual([]);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(remoteImage).toBeNull();
  await zones.locator("[data-zone-run]").click(); await expect.poll(remoteImage).toBe(hash);
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  expect(await remoteImage()).toBe(hash); expect(await hostCall(page, "activeSceneId")).toBe(sourceId);
  await page.locator(`[data-scene="${remoteId}"]`).click();
  await expect.poll(() => drawn(page, "unused")).toEqual({ tile: null, background: [{ width: 1, height: 1 }] });
});


test("Switch Tile Image authors an ordered list and cycles, wraps, numbers, randomizes and undoes live art", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  for (const [name, buffer] of [["cycle-first.png", png], ["cycle-second.png", solidPng(2, 2)]] as const) {
    await wizard.locator('input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer });
    await expect(wizard.getByRole("status")).toContainText(name);
  }
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones = await openZone(page, "Cycling tile art");
  const tileId = await zones.locator("[data-zone-tile]").inputValue();
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const action = zones.locator("[data-zone-step]").last();
  await action.getByLabel("Tile image source").selectOption("list");
  await action.getByLabel("Add tile list image", { exact: true }).click();
  await action.getByLabel("Add tile list image", { exact: true }).click();
  const first = await action.getByLabel("Tile list image 1", { exact: true }).inputValue();
  const second = await action.getByLabel("Tile list image 2", { exact: true }).inputValue();
  expect(first).not.toBe(second);
  const save = async () => {
    const before = await hostCall<number>(page, "seq");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  };
  await save();
  await zones.locator("li").filter({ hasText: "Cycling tile art" }).getByRole("button", { name: "Edit" }).click();
  await expect(action.getByLabel("Tile image source")).toHaveValue("list");
  await expect(action.getByLabel("Tile list image 2", { exact: true })).toHaveValue(second);
  const run = async (expected?: string) => {
    const before = await hostCall<number>(page, "seq");
    await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
    if (expected) await expect.poll(async () => (await drawn(page, tileId)).tile).toBe(expected);
    else await expect.poll(async () => [first, second].includes((await drawn(page, tileId)).tile ?? "")).toBe(true);
  };
  await run(first); await run(second); await run(first);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(async () => (await drawn(page, tileId)).tile).toBe(second);
  for (const [mode, expected] of [["previous", first], ["last", second], ["first", first], ["other", second], ["random", undefined]] as const) {
    await action.getByLabel("Tile image selection").selectOption(mode); await save(); await run(expected);
  }
  await action.getByLabel("Tile image selection").selectOption("index");
  await action.getByLabel("Tile image number").fill("2"); await save(); await run(second);
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await expect.poll(async () => (await drawn(page, tileId)).tile).toBe(second);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Cycling tile art" }).getByRole("button", { name: "Edit" }).click();
  await expect(action.getByLabel("Tile image selection")).toHaveValue("index");
  await expect(action.getByLabel("Tile image number")).toHaveValue("2");
  await expect(action.getByLabel("Tile list image 1", { exact: true })).toHaveValue(first);
  await action.getByLabel("Tile image selection").selectOption("numbers");
  await action.getByLabel("Tile image numbers", { exact: true }).fill("[2]"); await save(); await run(second);
  await action.getByLabel("Tile image numbers", { exact: true }).fill("1-2"); await save(); await run();
  await action.getByLabel("Tile image selection").selectOption("formula");
  await action.getByLabel("Tile image formula", { exact: true }).fill("1d1 + 1"); await save(); await run(second);
  await action.getByLabel("Tile image formula", { exact: true }).fill("floor(3 / 2)"); await save(); await run(first);
  await action.getByLabel("Tile image formula", { exact: true }).fill("1d1 + 2"); await save();
  const beforeInvalid = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect(zones.locator("details").filter({ hasText: "Host trace:" })).toContainText("rejected");
  expect(await hostCall<number>(page, "seq")).toBe(beforeInvalid);
  expect((await drawn(page, tileId)).tile).toBe(first);
  await action.getByLabel("Tile image formula", { exact: true }).fill("1d1 + 1"); await save();
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Cycling tile art" }).getByRole("button", { name: "Edit" }).click();
  await expect(action.getByLabel("Tile image selection")).toHaveValue("formula");
  await expect(action.getByLabel("Tile image formula", { exact: true })).toHaveValue("1d1 + 1");
  await run(second);
});


for (const formula of [false, true]) test(`Rotation authors ${formula ? "dice/math" : "fixed"} relative tile angles, renders turns, undoes and reloads`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({ name: "rotating-tile.png", mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones = await openZone(page, "Rotating tile");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art = zones.getByLabel("World action image");
  const hash = await art.locator("option").filter({ hasText: "rotating-tile.png" }).getAttribute("value");
  if (!hash) throw new Error("missing image"); await art.selectOption(hash);
  await zones.locator('[data-zone-add="rotate"]').click();
  await zones.getByLabel("Rotation mode", { exact: true }).selectOption("add");
  if (formula) {
    await zones.getByLabel("Rotation angle source", { exact: true }).selectOption("formula");
    await zones.getByLabel("Rotation formula", { exact: true }).fill("1d1 - 91");
  } else await zones.getByLabel("Rotation angle", { exact: true }).fill("-90");
  const beforeSave = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-save]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeSave + 1);
  const drawnAngle = () => page.evaluate(() => {
    type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): { rotation: number } | null } } };
    const g = globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage };
    const sprite = (g.__stage ?? g.__canvasStage)?.app.stage.getChildByLabel("tileImg", true);
    return sprite ? Math.round(sprite.rotation * 180 / Math.PI) : null;
  });
  const run = async (angle: number) => {
    const seq = await hostCall<number>(page, "seq"); await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
    await expect.poll(drawnAngle).toBe(angle);
  };
  await run(270); await run(180);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(drawnAngle).toBe(270);
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await expect.poll(drawnAngle).toBe(270);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Rotating tile" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.getByLabel("Rotation mode", { exact: true })).toHaveValue("add");
  if (formula) await expect(zones.getByLabel("Rotation formula", { exact: true })).toHaveValue("1d1 - 91");
  else await expect(zones.getByLabel("Rotation angle", { exact: true })).toHaveValue("-90");
  await run(180);
  if (formula) {
    const save = async () => {
      const seq = await hostCall<number>(page, "seq");
      await zones.locator("[data-zone-save]").click();
      await expect(zones.getByRole("alert")).toHaveCount(0);
      await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
    };
    await zones.getByLabel("Rotation formula", { exact: true }).fill("1 / 0"); await save();
    const seq = await hostCall<number>(page, "seq");
    await zones.locator("[data-zone-run]").click();
    await expect(zones.locator("details").filter({ hasText: "Host trace:" })).toContainText("rejected");
    expect(await hostCall<number>(page, "seq")).toBe(seq); expect(await drawnAngle()).toBe(180);
    await zones.getByLabel("Rotation angle source", { exact: true }).selectOption("fixed");
    await save(); await run(270);
    await zones.getByLabel("Rotation angle source", { exact: true }).selectOption("formula");
    await zones.getByLabel("Rotation formula", { exact: true }).fill("0");
    await save(); await run(270); // valid zero-angle formula is a no-op, not an error
  }
});

test("Move authors absolute tile centers and relative offsets, renders, undoes and reloads", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({ name: "moving-tile.png", mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones = await openZone(page, "Moving tile");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art = zones.getByLabel("World action image");
  const hash = await art.locator("option").filter({ hasText: "moving-tile.png" }).getAttribute("value");
  if (!hash) throw new Error("missing image"); await art.selectOption(hash);
  await zones.locator('[data-zone-add="move"]').click();
  await zones.getByLabel("Move X", { exact: true }).fill("400");
  await zones.getByLabel("Move Y", { exact: true }).fill("300");
  const save = async () => {
    const seq = await hostCall<number>(page, "seq"); await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
  };
  const position = () => page.evaluate(() => {
    type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): { x: number; y: number } | null } } };
    const g = globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage };
    const sprite = (g.__stage ?? g.__canvasStage)?.app.stage.getChildByLabel("tileImg", true);
    return sprite ? { x: sprite.x, y: sprite.y } : null;
  });
  const run = async (x: number, y: number) => {
    const seq = await hostCall<number>(page, "seq"); await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
    await expect.poll(position).toEqual({ x, y });
  };
  await save(); await run(400, 300);
  await zones.getByLabel("Move mode", { exact: true }).selectOption("add");
  await zones.getByLabel("Move X", { exact: true }).fill("-50");
  await zones.getByLabel("Move Y", { exact: true }).fill("25");
  await save(); await run(350, 325); await run(300, 350);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(position).toEqual({ x: 350, y: 325 });
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await expect.poll(position).toEqual({ x: 350, y: 325 });
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Moving tile" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.getByLabel("Move mode", { exact: true })).toHaveValue("add");
  await expect(zones.getByLabel("Move X", { exact: true })).toHaveValue("-50");
  await run(300, 350);
  await zones.getByLabel("Move X", { exact: true }).fill("-10000"); await save();
  const seq = await hostCall<number>(page, "seq"); await zones.locator("[data-zone-run]").click();
  await expect(zones.locator("details").filter({ hasText: "Host trace:" })).toContainText("rejected");
  expect(await hostCall<number>(page, "seq")).toBe(seq); expect(await position()).toEqual({ x: 300, y: 350 });
  await zones.getByLabel("Move mode", { exact: true }).selectOption("set");
  await zones.getByLabel("Move X", { exact: true }).fill("276");
  await zones.getByLabel("Move Y", { exact: true }).fill("324");
  await zones.getByLabel("Move snap to grid", { exact: true }).check();
  await save(); await run(250, 350);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(position).toEqual({ x: 300, y: 350 });
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Moving tile" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.getByLabel("Move snap to grid", { exact: true })).toBeChecked();
  await run(250, 350);
  await zones.getByLabel("Move X", { exact: true }).fill("676");
  await zones.getByLabel("Move duration", { exact: true }).fill("");
  await zones.getByLabel("Move speed", { exact: true }).fill("2");
  await zones.getByLabel("Move wall collision", { exact: true }).selectOption("block");
  await save();
  const animationSeq = await hostCall<number>(page, "seq");
  const samples = await page.evaluate(async () => {
    type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): { x: number } | null } } };
    const g = globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage };
    const sprite = (g.__stage ?? g.__canvasStage)?.app.stage.getChildByLabel("tileImg", true);
    if (!sprite) throw new Error("missing drawn tile");
    const points: Array<{ at: number; x: number }> = [];
    const at = performance.now();
    (document.querySelector("[data-zone-run]") as HTMLButtonElement).click();
    await new Promise<void>((resolve) => {
      const frame = () => { points.push({ at: performance.now() - at, x: sprite.x });
        if (performance.now() - at < 2400) requestAnimationFrame(frame); else resolve(); };
      requestAnimationFrame(frame);
    });
    return points;
  });
  expect(await hostCall<number>(page, "seq")).toBe(animationSeq + 1);
  expect(samples.some((p) => p.at > 300 && p.at < 1600 && p.x > 270 && p.x < 630)).toBe(true);
  expect(samples.at(-1)?.x).toBe(650);
  await hostCall(page, "drainOps"); await page.reload(); await waitForSurface(page, "app");
  await expect.poll(position).toEqual({ x: 650, y: 350 });
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({ hasText: "Moving tile" }).getByRole("button", { name: "Edit" }).click();
  await expect(zones.getByLabel("Move duration", { exact: true })).toHaveValue("");
  await expect(zones.getByLabel("Move speed", { exact: true })).toHaveValue("2");
  await expect(zones.getByLabel("Move wall collision", { exact: true })).toHaveValue("block");
  await zones.getByLabel("Move X", { exact: true }).fill("276"); await save();
  await zones.locator("[data-zone-run]").click();
  await expect.poll(async () => { const p = await position(); return !!p && p.x < 640 && p.x > 270; }).toBe(true);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(position).toEqual({ x: 650, y: 350 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await run(250, 350); // authored duration is cut on a reduced-motion device
  await zones.getByLabel("Move X source", {exact:true}).selectOption("formula");
  await zones.getByLabel("Move X formula", {exact:true}).fill("1d1 * 400 + 26");
  await zones.getByLabel("Move X mode", {exact:true}).selectOption("set");
  await zones.getByLabel("Move Y source", {exact:true}).selectOption("formula");
  await zones.getByLabel("Move Y formula", {exact:true}).fill("1d1 * 100");
  await zones.getByLabel("Move Y mode", {exact:true}).selectOption("add");
  await save(); await run(450,450);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Moving tile"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move X formula",{exact:true})).toHaveValue("1d1 * 400 + 26");
  await expect(zones.getByLabel("Move Y mode",{exact:true})).toHaveValue("add");
  await run(450,550);
  await zones.getByLabel("Move X formula",{exact:true}).fill("1/0");await save();
  const failedSeq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
  await expect(zones.locator("details").filter({hasText:"Host trace:"})).toContainText("rejected");
  expect(await hostCall<number>(page,"seq")).toBe(failedSeq);expect(await position()).toEqual({x:450,y:550});
});

test("Move follows saved token and tile destinations with offsets, native rendering and Undo", async ({page}) => {
  test.setTimeout(60_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"destination-token",col:5,row:5,size:"Medium"}]);
  await expect.poll(()=>hostCall<number>(page,"tokenCount")).toBe(1);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-fx-tab]").click();
  const wizard=page.locator("[data-fx-wizard]");await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({name:"entity-mover.png",mimeType:"image/png",buffer:png});
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones=await openZone(page,"Entity follower"), moverId=await zones.locator("[data-zone-tile]").inputValue();
  const creator=zones.locator("[data-zone-tile-create]");
  if(await creator.getAttribute("open")===null)await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Destination marker");
  await creator.getByLabel("X",{exact:true}).fill("600");await creator.getByLabel("Y",{exact:true}).fill("200");
  await creator.getByLabel("Width").fill("200");await creator.getByLabel("Height").fill("100");
  await creator.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({hasText:"Destination marker"})).toHaveCount(1);
  const anchorId=await zones.locator("[data-zone-tile]").inputValue();
  await zones.locator("[data-zone-tile]").selectOption(moverId);
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art=zones.getByLabel("World action image");const hash=await art.locator("option").filter({hasText:"entity-mover.png"}).getAttribute("value");
  if(!hash)throw new Error("missing image");await art.selectOption(hash);
  await zones.locator('[data-zone-add="move"]').click();
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("tokens");
  await zones.getByLabel("Move destination entity",{exact:true}).selectOption({label:"destination-token"});
  await zones.getByLabel("Move X",{exact:true}).fill("-25");await zones.getByLabel("Move Y",{exact:true}).fill("50");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const position=()=>page.evaluate(()=>{
    type View={app:{stage:{getChildByLabel(label:string,deep:boolean):{x:number;y:number}|null}}};
    const g=globalThis as unknown as {__stage?:View;__canvasStage?:View};
    const sprite=(g.__stage??g.__canvasStage)?.app.stage.getChildByLabel("tileImg",true);
    return sprite?{x:sprite.x,y:sprite.y}:null;
  });
  const run=async(x:number,y:number)=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);await expect.poll(position).toEqual({x,y});};
  await save();await run(525,600);
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("tiles");
  await zones.getByLabel("Move destination entity",{exact:true}).selectOption(anchorId);
  await zones.getByLabel("Move X source",{exact:true}).selectOption("formula");
  await zones.getByLabel("Move X formula",{exact:true}).fill("-1d1 * 25");
  await save();await run(675,250);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(position).toEqual({x:525,y:600});
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Entity follower"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move destination source",{exact:true})).toHaveValue("tiles");
  await expect(zones.getByLabel("Move destination entity",{exact:true})).toHaveValue(anchorId);
  await run(675,250);
});

test("Move follows live Roll Table coordinate text with rendered offsets, reload, Undo and Revert",async({page})=>{
  test.setTimeout(120_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await page.locator('[data-tab="tables"]').click();await page.locator("#table-create").click();
  const editTable=async(text:string)=>{
    await page.locator('[data-tab="tables"]').click();
    for(const range of ["1–2","3–4","5–6"]) {
      const seq=await hostCall<number>(page,"seq"),input=page.getByLabel(`Result ${range}`,{exact:true});
      await input.fill(text);await input.press("Tab");await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);
    }
  };
  await editTable('{"x":600,"y":400}');
  await page.locator("#gm-macros").click();await page.locator("[data-macro-fx-tab]").click();
  const wizard=page.locator("[data-fx-wizard]");await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({name:"table-mover.png",mimeType:"image/png",buffer:png});
  await expect(wizard.getByRole("status")).toContainText("Imported");await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones=await openZone(page,"Table destination mover");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art=zones.getByLabel("World action image"),hash=await art.locator("option").filter({hasText:"table-mover.png"}).getAttribute("value");if(!hash)throw new Error("missing image");await art.selectOption(hash);
  await zones.locator('[data-zone-add="rollTable"]').click();
  const tableStep=zones.locator("[data-zone-step]").last();await tableStep.getByRole("combobox",{name:"Roll table",exact:true}).selectOption({index:1});
  await tableStep.getByRole("combobox",{name:"Audience",exact:true}).selectOption("gm");
  await zones.locator('[data-zone-add="move"]').click();await zones.getByLabel("Move destination source",{exact:true}).selectOption("rollTable");
  await zones.getByLabel("Move X source",{exact:true}).selectOption("formula");await zones.getByLabel("Move X formula",{exact:true}).fill("-1d1 * 25");
  await zones.getByLabel("Move Y",{exact:true}).fill("50");await zones.getByLabel("Move duration",{exact:true}).fill("500");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const position=()=>page.evaluate(()=>{
    type View={app:{stage:{getChildByLabel(label:string,deep:boolean):{x:number;y:number}|null}}};
    const sprite=(globalThis as unknown as {__stage?:View}).__stage?.app.stage.getChildByLabel("tileImg",true);return sprite?{x:sprite.x,y:sprite.y}:null;
  });
  const run=async(x:number,y:number)=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);await expect.poll(position).toEqual({x,y});};
  const openSaved=async()=>{await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();await zones.locator("li").filter({hasText:"Table destination mover"}).getByRole("button",{name:"Edit"}).click();};
  await save();await run(575,450);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(position).toBeNull();
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");await openSaved();
  await expect(zones.getByLabel("Move destination source",{exact:true})).toHaveValue("rollTable");
  await expect(zones.getByLabel("Move X formula",{exact:true})).toHaveValue("-1d1 * 25");
  await expect(zones.getByLabel("Move X mode",{exact:true})).toHaveCount(0);await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveCount(0);
  await run(575,450);
  await page.locator('[data-window="macros"] [data-window-close]').click();await editTable('{"y":600,"x":400}');await openSaved();
  await run(375,650);await page.locator('[data-window="macros"] [data-window-close]').click();await page.locator('[data-tab="chat"]').click();
  await page.getByTestId("action-revert-card").filter({hasText:"Table destination mover"}).filter({has:page.getByTestId("action-revert")}).first().getByTestId("action-revert").click();
  await expect.poll(position).toEqual({x:575,y:450});
  await editTable('{"x":"bad","y":400}');await openSaved();
  const reject=async(message:string)=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
    await expect(zones.locator("details").filter({hasText:"Host trace:"})).toContainText(message);expect(await hostCall<number>(page,"seq")).toBe(seq);expect(await position()).toEqual({x:575,y:450});};
  await reject("must contain exactly numeric");
  await zones.getByRole("button",{name:"Remove step 3"}).click();await save();await reject("this graph invocation");
  // Switching away removes the result-only schema field, not just its visible controls.
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("coordinates");await save();
});

for (const tagChoice of [false,true]) test(`Move random positioning in rotated destination tiles (${tagChoice?"random tag choice":"explicit entity"}) renders, reloads and reverts`,async({page})=>{
  test.setTimeout(90_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-fx-tab]").click();
  const wizard=page.locator("[data-fx-wizard]");await wizard.locator("[data-fx-share]").check();await wizard.locator('input[type="file"]').setInputFiles({name:"random-mover.png",mimeType:"image/png",buffer:png});
  await expect(wizard.getByRole("status")).toContainText("Imported");await page.locator('[data-window="macros"] [data-window-close]').click();
  const zones=await openZone(page,"Random destination mover"),moverId=await zones.locator("[data-zone-tile]").inputValue();
  const markers=[{name:"North marker",x:400,y:300,width:200,height:100,rotation:90},{name:"South marker",x:650,y:500,width:200,height:100,rotation:45}];
  const markerIds:string[]=[];
  for(const marker of markers) {
    const creator=zones.locator("[data-zone-tile-create]");if(await creator.getAttribute("open")===null)await creator.locator("summary").click();
    await creator.getByLabel("Tile name").fill(marker.name);
    for(const field of ["X","Y","Width","Height","Rotation"] as const)await creator.getByLabel(field==="Rotation"?"Rotation °":field,{exact:true}).fill(String(marker[field.toLowerCase() as keyof typeof marker]));
    await creator.locator("[data-zone-create-tile]").click();await expect(zones.locator("[data-zone-tile] option").filter({hasText:marker.name})).toHaveCount(1);
    markerIds.push(await zones.locator("[data-zone-tile]").inputValue());
  }
  await zones.locator("[data-zone-tile]").selectOption(moverId);
  const selection=zones.locator('[data-zone-step="select"]');
  if(tagChoice) {
    const sceneId=await hostCall<string>(page,"activeSceneId");await selection.getByLabel("Current collection").selectOption("ids");
    await selection.getByLabel("Pinned entities",{exact:true}).selectOption(markerIds.map((id)=>JSON.stringify([sceneId,"tiles",id])));
    await zones.locator('[data-zone-add="tags"]').click();await zones.locator("[data-zone-step]").last().getByLabel("Tags",{exact:true}).fill("random-destination");
    await zones.locator('[data-zone-add="select"]').click();await zones.locator("[data-zone-step]").last().getByLabel("Current collection").selectOption("tile");
  } else await selection.getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="tileImage"]').click();
  const art=zones.getByLabel("World action image"),hash=await art.locator("option").filter({hasText:"random-mover.png"}).getAttribute("value");if(!hash)throw new Error("missing image");await art.selectOption(hash);
  await zones.locator('[data-zone-add="move"]').click();
  await zones.getByLabel("Move destination source",{exact:true}).selectOption(tagChoice?"tag":"tiles");
  if(tagChoice)await zones.getByLabel("Move destination tags",{exact:true}).fill("random-destination");
  else await zones.getByLabel("Move destination entity",{exact:true}).selectOption(markerIds[0]??"");
  await zones.getByLabel("Move destination positioning",{exact:true}).selectOption("random");
  await zones.getByLabel("Move X",{exact:true}).fill("-25");await zones.getByLabel("Move Y",{exact:true}).fill("50");
  await zones.getByLabel("Move duration",{exact:true}).fill("250");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const position=()=>page.evaluate(()=>{
    type Node={x:number;y:number;getChildByLabel(label:string,deep:boolean):Node|null};
    const root=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage,sprite=root?.getChildByLabel("tileImg",true);
    return sprite?{x:sprite.x,y:sprite.y}:null;
  });
  const settled=()=>page.evaluate((id)=>{
    type View={app:{stage:{getChildByLabel(label:string,deep:boolean):{x:number;y:number}|null}};getTilesLayer():{views:Map<string,{tile:{x:number;y:number;width:number;height:number}}>}};
    const view=(globalThis as unknown as {__stage?:View}).__stage,sprite=view?.app.stage.getChildByLabel("tileImg",true),doc=view?.getTilesLayer().views.get(id)?.tile;
    return !!sprite&&!!doc&&Math.abs(sprite.x-(doc.x+doc.width/2))<1e-7&&Math.abs(sprite.y-(doc.y+doc.height/2))<1e-7;
  },moverId);
  const contains=(point:{x:number;y:number}|null)=>point!==null&&(tagChoice?markers:markers.slice(0,1)).some((marker)=>{
    // Remove authored world-axis offsets, then inverse-rotate into the destination rectangle.
    const dx=point.x+25-(marker.x+marker.width/2),dy=point.y-50-(marker.y+marker.height/2),angle=marker.rotation*Math.PI/180;
    return Math.abs(dx*Math.cos(angle)+dy*Math.sin(angle))<=marker.width/2+1e-6&&Math.abs(-dx*Math.sin(angle)+dy*Math.cos(angle))<=marker.height/2+1e-6;
  });
  await save();
  if(tagChoice) {
    const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
    await expect(zones.locator("details").filter({hasText:"Host trace:"})).toContainText("matched 2");expect(await hostCall<number>(page,"seq")).toBe(seq);
    await expect.poll(position).toBeNull(); // earlier image write rolled back too
    await zones.getByLabel("Move destination choice",{exact:true}).selectOption("random");await save();
  }
  const run=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);
    await expect.poll(settled).toBe(true);await expect.poll(async()=>contains(await position())).toBe(true);};
  await run();await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await expect.poll(async()=>contains(await position())).toBe(true);const previous=await position();
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Random destination mover"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveValue("random");
  if(tagChoice)await expect(zones.getByLabel("Move destination choice",{exact:true})).toHaveValue("random");
  await run();await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(position).toEqual(previous);
  await run();await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.getByTestId("action-revert-card").filter({hasText:"Random destination mover"}).filter({has:page.getByTestId("action-revert")}).first().getByTestId("action-revert").click();
  await expect.poll(position).toEqual(previous);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Random destination mover"}).getByRole("button",{name:"Edit"}).click();
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("coordinates");await save();
  await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveCount(0);
  await expect(zones.getByLabel("Move destination choice",{exact:true})).toHaveCount(0);
});

test("Move live Tagger destinations see staged tags, reject ambiguity, narrow refs and survive Undo/reload",async({page})=>{
  test.setTimeout(90_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  const zones=await openZone(page,"Tag destination follower"),moverId=await zones.locator("[data-zone-tile]").inputValue();
  const creator=zones.locator("[data-zone-tile-create]");
  if(await creator.getAttribute("open")===null)await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Live destination marker");
  await creator.getByLabel("X",{exact:true}).fill("600");await creator.getByLabel("Y",{exact:true}).fill("200");
  await creator.getByLabel("Width").fill("200");await creator.getByLabel("Height").fill("100");
  await creator.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({hasText:"Live destination marker"})).toHaveCount(1);
  const anchorId=await zones.locator("[data-zone-tile]").inputValue(),sceneId=await hostCall<string>(page,"activeSceneId");
  const anchorRef=JSON.stringify([sceneId,"tiles",anchorId]),moverRef=JSON.stringify([sceneId,"tiles",moverId]);
  await zones.locator("[data-zone-tile]").selectOption(moverId);
  const first=zones.locator('[data-zone-step="select"]');
  await first.getByLabel("Current collection").selectOption("ids");
  await first.getByLabel("Pinned entities",{exact:true}).selectOption(anchorRef);
  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Tags",{exact:true}).fill("destination");
  await zones.locator('[data-zone-add="select"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Current collection").selectOption("tile");
  await zones.locator('[data-zone-add="move"]').click();
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("tag");
  await zones.getByLabel("Move destination tags",{exact:true}).fill("DEST*");
  await zones.getByLabel("Move destination pattern",{exact:true}).selectOption("wildcard");
  await zones.getByLabel("Move destination case sensitive",{exact:true}).uncheck();
  await zones.getByLabel("Move destination types",{exact:true}).selectOption("tiles");
  await zones.getByLabel("Move X source",{exact:true}).selectOption("formula");
  await zones.getByLabel("Move X formula",{exact:true}).fill("-1d1 * 25");
  await zones.getByLabel("Move Y",{exact:true}).fill("50");
  const positions=()=>page.evaluate(()=>{
    type Node={x:number;y:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
    const stage=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage;
    return stage?.getChildByLabel("tilesBelow",true)?.children.map((child)=>[child.x,child.y]).sort((a,b)=>(a[0]??0)-(b[0]??0));
  });
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const run=async(x:number)=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
    await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);await expect.poll(positions).toEqual([[x,300],[700,250]]);};
  await save();await run(675);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(positions).toEqual([[200,200],[700,250]]);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Tag destination follower"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move destination source",{exact:true})).toHaveValue("tag");
  await expect(zones.getByLabel("Move destination tags",{exact:true})).toHaveValue("DEST*");
  await expect(zones.getByLabel("Move destination pattern",{exact:true})).toHaveValue("wildcard");
  await expect(zones.getByLabel("Move destination case sensitive",{exact:true})).not.toBeChecked();
  await run(675);
  // Two staged matches must fail before either the tag edit or move is committed.
  await first.getByLabel("Pinned entities",{exact:true}).selectOption([anchorRef,moverRef]);await save();
  const rejected=async(count:number)=>{const seq=await hostCall<number>(page,"seq"),before=await positions();await zones.locator("[data-zone-run]").click();
    await expect(zones.locator("details").filter({hasText:"Host trace:"})).toContainText(`matched ${count}`);
    expect(await hostCall<number>(page,"seq")).toBe(seq);expect(await positions()).toEqual(before);};
  await rejected(2);
  await zones.getByLabel("Include Move destination refs",{exact:true}).selectOption(anchorRef);
  await zones.getByLabel("Move X formula",{exact:true}).fill("-1d1 * 125");
  await zones.getByLabel("Move duration",{exact:true}).fill("500");await save();await run(575);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(positions).toEqual([[675,300],[700,250]]);
  await zones.getByLabel("Move destination tags",{exact:true}).fill("missing*");await save();await rejected(0);
});

for (const pinned of [false,true]) test(`Delete Entities selects a live light (${pinned ? "pins" : "tags"}), preserves another glow, undoes and reverts after reload`, async ({page}) => {
  test.setTimeout(90_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  const box=await page.locator(".canvas-host canvas").boundingBox();if(!box)throw new Error("missing canvas");
  await page.locator('[data-canvas-tool="light"]').click();
  await page.mouse.click(box.x+300,box.y+220);await page.mouse.click(box.x+450,box.y+250);
  await expect.poll(()=>hostCall<unknown[]>(page,"lights")).toHaveLength(2);
  const glows=()=>page.evaluate(()=>{
    type View={app:{stage:{getChildByLabel(label:string,deep:boolean):{children:unknown[]}|null}}};
    return (globalThis as unknown as {__stage?:View}).__stage?.app.stage.getChildByLabel("lights",true)?.children.length??0;
  });
  await expect.poll(glows).toBe(2);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-tags-tab]").click();
  const tags=page.locator("[data-tagger]");await tags.getByLabel("Placeable type").selectOption("lights");
  if(!pinned) {
  const victim=tags.locator(".result").first();await victim.locator('input[type="checkbox"]').check();
  await tags.getByLabel("Tags to edit").fill("extinguish-me");
  await tags.getByRole("button",{name:"Add",exact:true}).click();await expect(victim).toContainText("extinguish-me");
  }
  await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Light cleanup");
  await zones.locator("[data-zone-create-tile]").click();await zones.locator("[data-zone-name]").fill("Light cleanup");
  await zones.getByRole("button",{name:"Remove step 2"}).click();
  const selection=zones.locator('[data-zone-step="select"]');
  let pinnedValues:string[]=[];
  if(pinned) {
    await selection.getByLabel("Current collection").selectOption("ids");
    const pins=selection.getByLabel("Pinned entities",{exact:true});
    pinnedValues=await pins.locator("option").filter({hasText:/^lights:/}).evaluateAll((options)=>options.map((o)=>(o as HTMLOptionElement).value));
    expect(pinnedValues).toHaveLength(2);await pins.selectOption(pinnedValues);
    await zones.locator('[data-zone-add="collection"]').click();
    const remove=zones.locator("[data-zone-step]").last();
    await remove.getByLabel("Change current collection").selectOption("remove");
    await remove.getByRole("combobox",{name:"Entities",exact:true}).selectOption("ids");
    await remove.getByLabel("Pinned collection entities",{exact:true}).selectOption(pinnedValues[1]??"");
  } else {
  await selection.getByLabel("Current collection").selectOption("tag");
  await selection.getByLabel("Tags",{exact:true}).fill("extinguish-me");
  await selection.getByLabel("Collections",{exact:true}).fill("lights, sounds, templates");
  }
  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Tags",{exact:true}).fill("pending-cleanup");
  await zones.locator('[data-zone-add="delete"]').click();
  await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);
  const run=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
    await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);
    await expect.poll(()=>hostCall<unknown[]>(page,"lights")).toHaveLength(1);await expect.poll(glows).toBe(1);};
  await run();
  if(pinned) await expect(selection.getByLabel("Pinned entities",{exact:true}).locator("option").filter({hasText:"Unavailable:"})).toHaveCount(1);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();
  await expect.poll(()=>hostCall<unknown[]>(page,"lights")).toHaveLength(2);await expect.poll(glows).toBe(2);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Light cleanup"}).getByRole("button",{name:"Edit"}).click();
  if(pinned) await expect(selection.getByLabel("Pinned entities",{exact:true})).toHaveValues(pinnedValues);
  else await expect(selection.getByLabel("Collections",{exact:true})).toHaveValue("lights, sounds, templates");
  await run();await page.locator('[data-window="macros"] [data-window-close]').click();
  const receipt=page.getByTestId("action-revert-card").filter({hasText:"Light cleanup"}).filter({has:page.getByTestId("action-revert")});
  await receipt.getByTestId("action-revert").click();
  await expect.poll(()=>hostCall<unknown[]>(page,"lights")).toHaveLength(2);await expect.poll(glows).toBe(2);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-tags-tab]").click();
  await tags.getByLabel("Placeable type").selectOption("lights");
  if(!pinned)await expect(tags.locator(".result").filter({hasText:"extinguish-me"})).toHaveCount(1);
  else await expect(tags.locator(".result")).toHaveCount(2);
  await expect(tags.locator(".result").filter({hasText:"pending-cleanup"})).toHaveCount(0);
});

for (const target of ["tile","token"] as const) test(`Rotation animates a real ${target}, interrupts, cuts for reduced motion and reloads`, async ({page}) => {
  test.setTimeout(90_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  if(target==="token") {
    await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"rotor",col:5,row:5,size:"Medium"}]);
    await expect.poll(()=>hostCall<number>(page,"tokenCount")).toBe(1);
  } else {
    await page.locator("#gm-macros").click();await page.locator("[data-macro-fx-tab]").click();
    const wizard=page.locator("[data-fx-wizard]");await wizard.locator("[data-fx-share]").check();
    await wizard.locator('input[type="file"]').setInputFiles({name:"rotor.png",mimeType:"image/png",buffer:png});
    await expect(wizard.getByRole("status")).toContainText("Imported");
    await page.locator('[data-window="macros"] [data-window-close]').click();
  }
  const zones=await openZone(page,"Animated turn");
  if(target==="token")await zones.getByLabel("Origin token").selectOption({label:"rotor"});
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption(target==="tile"?"tile":"triggering");
  if(target==="tile") {
    await zones.locator('[data-zone-add="tileImage"]').click();
    const art=zones.getByLabel("World action image");
    const hash=await art.locator("option").filter({hasText:"rotor.png"}).getAttribute("value");if(!hash)throw new Error("missing art");await art.selectOption(hash);
  }
  await zones.locator('[data-zone-add="rotate"]').click();
  await zones.getByLabel("Rotation angle",{exact:true}).fill("270");await zones.getByLabel("Rotation duration",{exact:true}).fill("5000");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const run=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  const drawn=()=>page.evaluate((target)=>{
    type Node={rotation:number;label:string;children:Node[];getChildByLabel(label:string,deep?:boolean):Node|null};
    const stage=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage;
    const token=stage?.getChildByLabel("token:rotor",true);
    const node=target==="tile"?stage?.getChildByLabel("tileImg",true):token?.getChildByLabel("body");
    return {angle:node?node.rotation*180/Math.PI:null,upright:token?.children.filter((c)=>c.label!=="body").every((c)=>c.rotation===0)??true};
  },target);
  await save();await run();
  await expect.poll(async()=>{const {angle}=await drawn();return angle!==null&&angle>275&&angle<359;}).toBe(true);
  expect((await drawn()).upright).toBe(true);
  await zones.getByLabel("Rotation angle",{exact:true}).fill("90");await save();
  const before=(await drawn()).angle;if(before===null)throw new Error("missing rendered turn");await run();
  const after=(await drawn()).angle;if(after===null)throw new Error("missing interrupted turn");
  expect(Math.abs(((after-before+540)%360)-180)).toBeLessThan(60);
  await expect.poll(async()=>Math.round((await drawn()).angle??-1),{timeout:8000}).toBe(90);
  await zones.getByLabel("Rotation angle",{exact:true}).fill("180");await save();await run();
  await page.emulateMedia({reducedMotion:"reduce"});await expect.poll(async()=>(await drawn()).angle).toBe(180);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(async()=>(await drawn()).angle).toBe(90);
  await page.emulateMedia({reducedMotion:"no-preference"});await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");
  await expect.poll(async()=>(await drawn()).angle).toBe(90);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Animated turn"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Rotation duration",{exact:true})).toHaveValue("5000");
  if(target==="token")await zones.getByLabel("Origin token").selectOption({label:"rotor"});
  await zones.getByLabel("Rotation duration",{exact:true}).fill("0");await zones.getByLabel("Rotation angle",{exact:true}).fill("45");
  await save();await run();await expect.poll(async()=>(await drawn()).angle).toBe(45);expect((await drawn()).upright).toBe(true);
});
