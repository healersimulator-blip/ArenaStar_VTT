import { expect, test } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";


test("production scene regions persist as convex scene geometry and draw on the map", async ({ page }) => {
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  const scene = await hostCall<{ id: string }>(page, "sceneChildren");
  const region = { _id: "e2e-courtyard", type: "region" as const, name: "Courtyard",
    ownership: { default: 1 as const }, flags: {}, system: {}, x: 220, y: 180, width: 240, height: 160,
    rotation: 30, shape: { kind: "polygon" as const, points: [[0.5, 0], [1, 1], [0, 1]] as Array<[number, number]> } };
  const before = await hostCall<number>(page, "seq");
  await surfaceCallArg(page, "app", "authorRegion", { sceneId: scene.id, region });
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  const saved = await hostCall<{ regions: Array<{ id: string; shape: typeof region.shape; rotation: number }> }>(page, "sceneChildren");
  expect(saved.regions).toEqual([{ id: "e2e-courtyard", name: "Courtyard", x: 220, y: 180, width: 240,
    height: 160, rotation: 30, shape: region.shape, hidden: false }]);
  const rendered = await page.evaluate(() => {
    type RegionGraphic = { rotation: number; getLocalBounds(): { width: number; height: number } };
    type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): RegionGraphic | null } } };
    const g = globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage };
    const graphic = (g.__stage ?? g.__canvasStage)?.app.stage.getChildByLabel("region:e2e-courtyard", true);
    if (!graphic) return null;
    const bounds = graphic.getLocalBounds();
    return { rotation: graphic.rotation, width: bounds.width, height: bounds.height };
  });
  expect(rendered).not.toBeNull();
  expect(rendered?.rotation).toBeCloseTo(Math.PI / 6);
  expect(rendered?.width).toBeGreaterThan(0);
  expect(rendered?.height).toBeGreaterThan(0);
});

test("image-alpha tile authoring stores the mask and only opaque pixels trigger movement", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const fx = page.locator("[data-fx-wizard]");
  await fx.locator("[data-fx-share]").check();
  const halfTransparentPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR4nGP4DwEMACLmBvoI+gInAAAAAElFTkSuQmCC", "base64");
  await fx.locator('input[type="file"]').setInputFiles({ name: "half-mask.png", mimeType: "image/png", buffer: halfTransparentPng });
  await expect(fx.getByRole("status")).toContainText("Imported");
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]"), creator = zones.locator("[data-zone-tile-create]");
  await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Alpha trigger");
  for (const [field, value] of [["X", 200], ["Y", 400], ["Width", 200], ["Height", 100]] as const)
    await creator.getByLabel(field, { exact: true }).fill(String(value));
  await creator.getByLabel("Trigger shape").selectOption("alpha");
  const imageOption = creator.locator("[data-zone-alpha-image] option").filter({ hasText: "half-mask.png" });
  await expect(imageOption).toHaveCount(1);
  const imageHash = await imageOption.getAttribute("value");
  if (!imageHash) throw new Error("imported alpha image missing a hash");
  await creator.locator("[data-zone-alpha-image]").selectOption(imageHash);
  await creator.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Alpha trigger" })).toHaveCount(1);
  const persisted = await hostCall<{ tiles: Array<{ name: string; img: string; triggerZone?: { kind: string; imageHash?: string; rows?: number[][][] } }> }>(page, "sceneChildren");
  const savedMask = persisted.tiles.find((tile) => tile.name === "Alpha trigger");
  expect(savedMask?.img).toBe(imageHash);
  expect(savedMask?.triggerZone?.kind).toBe("alpha");
  expect(savedMask?.triggerZone?.imageHash).toBe(imageHash);
  expect(savedMask?.triggerZone?.rows).toHaveLength(64);
  expect(savedMask?.triggerZone?.rows?.every((row) => JSON.stringify(row) === JSON.stringify([[0, 32]]))).toBe(true);

  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "alpha-runner", col: 3, row: 2, size: "Medium" }]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await zones.locator("[data-zone-name]").fill("Alpha only");
  for (const method of ["enter", "exit", "stop", "create", "rotate", "click", "manual"])
    await zones.getByRole("checkbox", { name: method, exact: true }).setChecked(method === "enter");
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Entered opaque pixels");
  await zones.locator("[data-zone-save]").click(); await expect(zones.getByRole("alert")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const drag = async (fromPoint: { x: number; y: number }, toPoint: { x: number; y: number }) => {
    const from = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", fromPoint);
    const to = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", toPoint);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
  };
  // The 100×100 token ends fully on the transparent half of the tile image.
  await drag({ x: 350, y: 250 }, { x: 350, y: 450 });
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 350, y: 450 });
  await expect(page.locator("#chat-log")).not.toContainText("Entered opaque pixels");
  // Sliding left enters only the non-transparent half; the trigger runs once.
  await drag({ x: 350, y: 450 }, { x: 250, y: 450 });
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 250, y: 450 });
  await expect(page.locator("#chat-log")).toContainText("Entered opaque pixels");
});

test("production movement sweeps use the scene hex footprint instead of square artwork bounds", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "hex-sweep-runner", col: 0, row: 0, size: "Medium" }]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  const sceneId = await hostCall<string | null>(page, "activeSceneId");
  if (!sceneId) throw new Error("active scene is unavailable");
  const inject = async (ops: unknown[]) => page.evaluate((payload: { ops: unknown[] }) => {
    const surface = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: never[]): void } } } } }).__vttE2E?.app;
    if (!surface?.gm?.client) throw new Error("GM test client is unavailable");
    surface.gm.client.submit(payload.ops as never[]);
  }, { ops });
  const tile = { _id: "hex-corner-trigger", type: "tile", name: "Hex corner", ownership: { default: 0 },
    flags: {}, system: {}, x: 90, y: 90, width: 8, height: 8, img: "", above: false,
    occlusion: { mode: "roof", alpha: 0.5 } };
  await inject([
    { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { grid: {
      type: "hex", size: 50, distance: 5, units: "ft", diagonals: "euclidean", hexLayout: "oddQ",
    } } },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: sceneId }, data: tile },
  ]);
  await expect.poll(() => hostCall<{ tiles: Array<{ name: string }> }>(page, "sceneChildren"))
    .toMatchObject({ tiles: [expect.objectContaining({ name: "Hex corner" })] });
  await inject([{ kind: "create", coll: "automations", data: {
    _id: "hex-corner-graph", type: "automation", name: "Hex corner graph", ownership: { default: 0 },
    flags: {}, system: {}, definition: { version: 1, sceneId, tileId: tile._id, methods: ["enter"], gates: {},
      steps: [{ id: "hex-chat", kind: "chat", audience: "gm", content: "hex footprint entered" }] },
  } }]);
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(0);

  // A 100×100 square token would overlap this tile at (51,51); its flat-top
  // hex footprint does not. The committed host sweep must use SceneGrid.hexLayout.
  const beforeHexMove = await hostCall<number>(page, "seq");
  await inject([{ kind: "update", ref: { coll: "tokens", id: "hex-sweep-runner", parent: { coll: "scenes", id: sceneId } },
    diff: { x: 51, y: 51 } }]);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeHexMove + 1);
  expect(await hostCall<string[]>(page, "chatLines")).not.toContain("hex footprint entered");

  // Move away while still on the hex scene, then switch to square and move back.
  await inject([{ kind: "update", ref: { coll: "tokens", id: "hex-sweep-runner", parent: { coll: "scenes", id: sceneId } },
    diff: { x: 0, y: 0 } }]);
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 0, y: 0 });
  const beforeSquareMove = await hostCall<number>(page, "seq");
  await inject([
    { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { grid: {
      type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ",
    } } },
    { kind: "update", ref: { coll: "tokens", id: "hex-sweep-runner", parent: { coll: "scenes", id: sceneId } },
      diff: { x: 51, y: 51 } },
  ]);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeSquareMove + 2);
  await expect.poll(() => hostCall<string[]>(page, "chatLines")).toContain("hex footprint entered");
});

test("triangle zone movement triggers only when the token footprint intersects the authored polygon", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "polygon-runner", col: 3, row: 2, size: "Medium" }]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]"), creator = zones.locator("[data-zone-tile-create]");
  await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Triangle trigger");
  for (const [field, value] of [["X", 175], ["Y", 375], ["Width", 200], ["Height", 100]] as const)
    await creator.getByLabel(field, { exact: true }).fill(String(value));
  await creator.getByLabel("Trigger shape").selectOption("triangle");
  await creator.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Triangle trigger" })).toHaveCount(1);
  await expect.poll(() => hostCall<{ tiles: Array<{ name: string; triggerZone?: unknown }> }>(page, "sceneChildren"))
    .toMatchObject({ tiles: [expect.objectContaining({ name: "Triangle trigger",
      triggerZone: { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] } })] });
  await zones.locator("[data-zone-name]").fill("Polygon only");
  for (const method of ["enter", "exit", "stop", "create", "rotate", "click", "manual"])
    await zones.getByRole("checkbox", { name: method, exact: true }).setChecked(method === "enter");
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Entered triangle");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  const drag = async (fromPoint: { x: number; y: number }, toPoint: { x: number; y: number }) => {
    const from = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", fromPoint);
    const to = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", toPoint);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
  };
  // This endpoint overlaps the tile's rectangle but the token's 100×100 footprint only touches the triangle boundary.
  await drag({ x: 350, y: 250 }, { x: 350, y: 350 });
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 350, y: 350 });
  await expect(page.locator("#chat-log")).not.toContainText("Entered triangle");
  // Move into the triangle interior; the same graph now fires from authoritative movement.
  await drag({ x: 350, y: 350 }, { x: 250, y: 450 });
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 250, y: 450 });
  await expect(page.locator("#chat-log")).toContainText("Entered triangle");
});

test("circle zones apply elevation ranges and dispatch authoritative elevation changes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "elevation-runner", col: 3, row: 2, size: "Medium" }]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]"), creator = zones.locator("[data-zone-tile-create]");
  await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Upper gallery");
  for (const [field, value] of [["X", 250], ["Y", 150], ["Width", 200], ["Height", 200]] as const)
    await creator.getByLabel(field, { exact: true }).fill(String(value));
  await creator.getByLabel("Trigger shape").selectOption("circle");
  await creator.getByLabel("Limit trigger elevation").check();
  await creator.getByLabel(/Min elevation/).fill("5");
  await creator.getByLabel(/Max elevation/).fill("10");
  await creator.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Upper gallery" })).toHaveCount(1);
  const saved = await hostCall<{ tiles: Array<{ name: string; triggerZone?: { kind: string; points?: unknown[] };
    triggerElevation?: { min: number; max: number } }> }>(page, "sceneChildren");
  expect(saved.tiles.find((tile) => tile.name === "Upper gallery")).toMatchObject({
    triggerZone: { kind: "polygon", points: expect.any(Array) }, triggerElevation: { min: 5, max: 10 },
  });
  await zones.locator("[data-zone-name]").fill("Elevation only");
  for (const method of ["enter", "exit", "stop", "elevation", "create", "rotate", "click", "manual"])
    await zones.getByRole("checkbox", { name: method, exact: true }).setChecked(method === "elevation");
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Changed elevation in range");
  await zones.locator("[data-zone-save]").click(); await expect(zones.getByRole("alert")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const sceneId = await hostCall<string | null>(page, "activeSceneId");
  if (!sceneId) throw new Error("active scene is unavailable");
  await page.evaluate((payload: { sceneId: string; tokenId: string }) => {
    const surface = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: never[]): void } } } } }).__vttE2E?.app;
    if (!surface?.gm?.client) throw new Error("GM test client is unavailable");
    surface.gm.client.submit([{ kind: "update", ref: { coll: "tokens", id: payload.tokenId,
      parent: { coll: "scenes", id: payload.sceneId } }, diff: { elevation: 6 } }] as never[]);
  }, { sceneId, tokenId: "elevation-runner" });
  await expect(page.locator("#chat-log")).toContainText("Changed elevation in range");
});

/**
 * MATT §5.4 Move — end-to-end: the wizard authors a movement-automation graph
 * whose Move step repositions the token collection, and the committed move is
 * host-authoritative (the e2e host hook reads the host store, not the canvas).
 *
 * The destination is chosen outside the anchor tile so the committed move's
 * own movement-trigger dispatch has no sibling to cascade into; the bounded
 * cascade (ping-pong depth cap) is covered by the host fixtures in
 * tests/host/sync.test.ts.
 */
for (const snap of [false, true]) test(`wizard: Move action relocates tokens on the host (snap ${snap})`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  // Token lands at world (550, 550): col 5, Medium footprint (1 cell), grid 100.
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens", [
    { id: "mover-runner", col: 5, row: 5, size: "Medium" },
  ])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);

  if (snap) {
    await page.locator('[data-canvas-layer="gm"]').click();
    await page.locator('[data-canvas-tool="wall"]').click();
    await page.locator('[data-canvas-wall-kind="door"]').click();
    await page.locator('[data-canvas-door-state="closed"]').click();
    const from = await surfaceCallArg<{x:number;y:number}>(page, "app", "screenOf", {x:400,y:300});
    const to = await surfaceCallArg<{x:number;y:number}>(page, "app", "screenOf", {x:400,y:700});
    await page.mouse.move(from.x,from.y); await page.mouse.down();
    await page.mouse.move(to.x,to.y,{steps:6}); await page.mouse.up();
    await expect.poll(() => hostCall<unknown[]>(page, "walls")).toHaveLength(1);
  }

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  // Anchor tile covering the token: 450..650 on both axes.
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Mover staging tile");
  await tile.getByLabel("X", { exact: true }).fill("450");
  await tile.getByLabel("Y", { exact: true }).fill("450");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Mover staging tile" })).toHaveCount(1);

  await zones.locator("[data-zone-name]").fill("Mover");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("inside");
  await zones.locator('[data-zone-add="move"]').click();
  const moveStep = zones.locator("[data-zone-step]").nth(2);
  await moveStep.getByLabel("Move X", {exact:true}).fill("300");
  await moveStep.getByLabel("Move Y", {exact:true}).fill("400");
  if (snap) {
    await moveStep.getByLabel("Move snap to grid").check();
    await moveStep.getByLabel("Move wall collision").selectOption("footprint");
    await moveStep.getByLabel("Move duration").fill("1200");
    await moveStep.getByLabel("Move speed").fill("0.01"); // explicit duration overrides an otherwise excessive speed duration
  }
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Moved to the point");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Mover" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);

  if (snap) {
    const seq = await hostCall<number>(page, "seq");
    await zones.locator("[data-zone-run]").click();
    await expect(zones.locator("details").filter({ hasText: "Host trace:" })).toContainText("blocked by a movement wall");
    expect(await hostCall<number>(page, "seq")).toBe(seq);
    expect(await hostCall<{x:number;y:number}>(page, "tokenPos")).toMatchObject({x:550,y:550});
    await page.locator('[data-window="macros"] [data-window-close]').click();
    const midpoint = await surfaceCallArg<{x:number;y:number}>(page, "app", "screenOf", {x:400,y:500});
    await page.mouse.click(midpoint.x,midpoint.y);
    await expect.poll(async () => (await hostCall<Array<{door:number}>>(page, "walls"))[0]?.door).toBe(1);
    await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
    await zones.locator("li").filter({ hasText: "Mover" }).getByRole("button", { name: "Edit" }).click();
    await expect(zones.locator("[data-zone-run]")).toBeVisible();
  }
  const before = await hostCall<number>(page, "seq");
  if (snap) {
    const samples = await page.evaluate(async () => {
      type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): { children: Array<{ x: number }> } | null } } };
      const g = globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage };
      const token = (g.__stage ?? g.__canvasStage)?.app.stage.getChildByLabel("tokens", true)?.children[0];
      if (!token) throw new Error("missing token view");
      const values: number[] = []; const at = performance.now();
      (document.querySelector("[data-zone-run]") as HTMLButtonElement).click();
      await new Promise<void>((resolve) => { const frame = () => {
        values.push(token.x); if (performance.now()-at < 1600) requestAnimationFrame(frame); else resolve();
      }; requestAnimationFrame(frame); });
      return values;
    });
    expect(samples.some((x) => x > 320 && x < 480)).toBe(true);
    expect(samples.at(-1)).toBe(300); // drawn top-left; authoritative center is 350
  } else await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(before);
  await expect(page.locator("#chat-log").getByText("Moved to the point")).toHaveCount(1);
  await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
    .toMatchObject(snap ? { x: 350, y: 450 } : { x: 300, y: 400 });
});

test("Move trigger policy suppresses only its own committed path and survives editor reload", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page,"app");
  await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"policy-runner",col:5,row:5,size:"Medium"}]);
  await expect.poll(() => hostCall<number>(page,"tokenCount")).toBe(1);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]");
  const create = async (name:string,x:number,y:number) => {
    await zones.getByRole("button",{name:"New",exact:true}).click();
    const tile=zones.locator("[data-zone-tile-create]");
    if ((await tile.getAttribute("open")) === null) await tile.locator("summary").click();
    await tile.getByLabel("Tile name").fill(name);
    await tile.getByLabel("X",{exact:true}).fill(String(x)); await tile.getByLabel("Y",{exact:true}).fill(String(y));
    await tile.getByLabel("Width").fill("100"); await tile.getByLabel("Height").fill("100");
    await tile.locator("[data-zone-create-tile]").click();
    await expect(zones.locator("[data-zone-tile] option").filter({hasText:name})).toHaveCount(1);
    await zones.locator("[data-zone-name]").fill(name);
    await zones.getByRole("button",{name:"Remove step 2"}).click();
    await zones.getByRole("button",{name:"Remove step 1"}).click();
  };
  const save = async () => { const before=await hostCall<number>(page,"seq");
    await zones.locator("[data-zone-save]").click(); await expect(zones.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => hostCall<number>(page,"seq")).toBe(before+1);
  };
  await create("Policy destination",200,400);
  await zones.locator(".methods").getByLabel("stop",{exact:true}).uncheck();
  await zones.locator(".methods").getByLabel("manual",{exact:true}).uncheck();
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text",{exact:true}).fill("Destination fired"); await save();
  await create("Policy mover",500,500);
  await zones.locator(".methods").getByLabel("enter",{exact:true}).uncheck();
  await zones.locator(".methods").getByLabel("stop",{exact:true}).uncheck();
  await zones.getByLabel("Origin token").selectOption({label:"policy-runner"});
  await zones.getByLabel("Simulate method").selectOption("manual");
  await zones.locator('[data-zone-add="move"]').click();
  await zones.getByLabel("Move targets").selectOption("triggering");
  await zones.getByLabel("Move X",{exact:true}).fill("250"); await zones.getByLabel("Move Y",{exact:true}).fill("450");
  await zones.getByLabel("Move trigger tiles").uncheck(); await save();
  const run = async (x:number,y:number) => {
    await zones.locator("[data-zone-run]").click();
    await expect.poll(() => hostCall(page,"tokenPos")).toMatchObject({x,y});
  };
  await run(250,450);
  await expect(page.locator("#chat-log")).not.toContainText("Destination fired");
  await expect(zones.locator("li").filter({hasText:"Policy destination"})).toContainText("0 run(s)");
  await zones.getByLabel("Move X",{exact:true}).fill("550"); await zones.getByLabel("Move Y",{exact:true}).fill("550"); await save(); await run(550,550);
  await zones.getByLabel("Move trigger tiles").check();
  await zones.getByLabel("Move X",{exact:true}).fill("250"); await zones.getByLabel("Move Y",{exact:true}).fill("450"); await save(); await run(250,450);
  await expect(page.locator("#chat-log")).toContainText("Destination fired");
  await expect(zones.locator("li").filter({hasText:"Policy destination"})).toContainText("1 run(s)");
  await hostCall(page,"drainOps"); await page.reload(); await waitForSurface(page,"app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Policy mover"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move trigger tiles")).toBeChecked();
});

test("dragging an animated token interrupts it from its rendered waypoint, not the committed endpoint", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "interrupt-runner", col: 5, row: 5, size: "Medium" }]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  const tile = zones.locator("[data-zone-tile-create]");
  if (await tile.getAttribute("open") === null) await tile.locator("summary").click();
  await tile.getByLabel("Tile name").fill("Interrupt staging");
  for (const [label, value] of [["X", 450], ["Y", 450], ["Width", 200], ["Height", 200]] as const)
    await tile.getByLabel(label, { exact: true }).fill(String(value));
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Interrupt staging" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Animated move");
  for (const method of ["enter", "exit", "stop", "elevation", "create", "rotate", "click"])
    await zones.locator(".methods").getByLabel(method, { exact: true }).uncheck();
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("inside");
  await zones.locator('[data-zone-add="move"]').click();
  const move = zones.locator("[data-zone-step]").nth(2);
  await move.getByLabel("Move X", { exact: true }).fill("850");
  await move.getByLabel("Move Y", { exact: true }).fill("550");
  await move.getByLabel("Move duration").fill("5000");
  await move.getByLabel("Move trigger tiles").uncheck();
  await zones.getByLabel("Origin token").selectOption({ label: "interrupt-runner" });
  await zones.getByLabel("Simulate method").selectOption("manual");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  const fireSeq = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(fireSeq);
  await expect(page.locator("#chat-log")).toContainText("manual by gm");
  await expect.poll(() => hostCall<{ x: number; y: number }>(page, "tokenPos")).toMatchObject({ x: 850, y: 550 });
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-tool="select"]').click();
  await page.waitForTimeout(650);
  const drawn = await page.evaluate(() => {
    type Stage = { app: { stage: { getChildByLabel(label: string, deep: boolean): { children: Array<{ x: number; y: number }> } | null } } };
    const stage = (globalThis as unknown as { __stage?: Stage; __canvasStage?: Stage }).__stage ??
      (globalThis as unknown as { __canvasStage?: Stage }).__canvasStage;
    const token = stage?.app.stage.getChildByLabel("tokens", true)?.children[0];
    if (!token) throw new Error("animated token is not rendered");
    return { x: token.x, y: token.y };
  });
  const start = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: drawn.x + 50, y: drawn.y + 50 });
  const end = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: drawn.x - 50, y: drawn.y + 50 });
  const seqBeforeInterrupt = await hostCall<number>(page, "seq");
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 3 }); await page.mouse.up();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(seqBeforeInterrupt);
  const interrupted = await hostCall<{ x: number; y: number }>(page, "tokenPos");
  expect(interrupted.y).toBe(550);
  expect(interrupted.x).toBeLessThan(850);
  expect(interrupted.x).toBeGreaterThan(350);
});

// A real canvas drag supplies the host boundary contact; no synthetic entry payload.
test("Move relative to entry maps rotated unequal tiles, renders and survives reload, Undo and Revert",async({page})=>{
  test.setTimeout(120_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"entry-runner",col:1,row:4,size:"Medium"}]);
  await expect.poll(()=>hostCall<number>(page,"tokenCount")).toBe(1);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]"),creator=zones.locator("[data-zone-tile-create]");
  const create=async(name:string,x:number,y:number,width:number,height:number)=>{
    if(await creator.getAttribute("open")===null)await creator.locator("summary").click();
    await creator.getByLabel("Tile name").fill(name);
    for(const [field,value] of [["X",x],["Y",y],["Width",width],["Height",height],["Rotation °",90]] as const)await creator.getByLabel(field,{exact:true}).fill(String(value));
    await creator.locator("[data-zone-create-tile]").click();await expect(zones.locator("[data-zone-tile] option").filter({hasText:name})).toHaveCount(1);
    return zones.locator("[data-zone-tile]").inputValue();
  };
  const source=await create("Entry source",200,400,200,100),destination=await create("Entry destination",500,500,300,200);
  await zones.locator("[data-zone-tile]").selectOption(source);await zones.locator("[data-zone-name]").fill("Relative entry transfer");
  for(const method of ["enter","exit","stop","create","rotate","click","manual"])await zones.getByRole("checkbox",{name:method,exact:true}).setChecked(method==="enter");
  await zones.getByRole("button",{name:"Remove step 2"}).click();
  await zones.locator('[data-zone-add="chat"]').click();await zones.locator("[data-zone-step]").last().getByLabel("Text",{exact:true}).fill("Entry transfer committed");
  await zones.locator('[data-zone-add="move"]').click();await zones.getByLabel("Move targets",{exact:true}).selectOption("triggering");
  await zones.getByLabel("Move destination source",{exact:true}).selectOption("tiles");await zones.getByLabel("Move destination entity",{exact:true}).selectOption(destination);
  await zones.getByLabel("Move destination positioning",{exact:true}).selectOption("entry");
  await zones.getByLabel("Move X",{exact:true}).fill("25");await zones.getByLabel("Move Y",{exact:true}).fill("-25");
  await zones.getByLabel("Move duration",{exact:true}).fill("500");await zones.getByLabel("Move trigger tiles",{exact:true}).uncheck();
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  await save();await page.locator('[data-window="macros"] [data-window-close]').click();
  const rendered=()=>page.evaluate(()=>{
    type Node={x:number;y:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
    const view=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage.getChildByLabel("tokens",true)?.children[0];return view?{x:view.x,y:view.y}:null;
  });
  const at=async(x:number,y:number)=>{await expect.poll(()=>hostCall<{x:number;y:number}>(page,"tokenPos")).toMatchObject({x,y});await expect.poll(rendered).toEqual({x:x-50,y:y-50});};
  const cross=async()=>{
    await page.locator('[data-canvas-tool="select"]').click();
    const a=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:150,y:450}),b=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:550,y:450});
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();
    // Source 90° contact (250,450) -> local (.5,1), destination 90° -> (550,600), then offsets.
    await at(575,575);
  };
  await at(150,450);await cross();
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(550,450);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(150,450);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");await at(150,450);
  const edit=async()=>{await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();await zones.locator("li").filter({hasText:"Relative entry transfer"}).getByRole("button",{name:"Edit"}).click();};
  await edit();await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveValue("entry");
  await zones.getByRole("combobox",{name:"Origin token",exact:true}).selectOption("entry-runner");
  const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();
  await expect(zones.locator("details").filter({hasText:"Host trace:"})).toContainText("host-observed enter event");expect(await hostCall<number>(page,"seq")).toBe(seq);await at(150,450);
  await page.locator('[data-window="macros"] [data-window-close]').click();await cross();
  await page.getByTestId("action-revert-card").filter({hasText:"Relative entry transfer"}).filter({has:page.getByTestId("action-revert")}).first().getByTestId("action-revert").click();await at(550,450);
  await edit();await zones.getByLabel("Move destination source",{exact:true}).selectOption("coordinates");
  await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveCount(0);await save();
});

test("Move Original Destination uses the host-observed drag endpoint after a staged detour",async({page})=>{
  test.setTimeout(120_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"original-runner",col:1,row:4,size:"Medium"}]);
  await expect.poll(()=>hostCall<number>(page,"tokenCount")).toBe(1);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]"),creator=zones.locator("[data-zone-tile-create]");
  await creator.locator("summary").click();await creator.getByLabel("Tile name").fill("Original endpoint trigger");
  for(const [field,value] of [["X",200],["Y",400],["Width",200],["Height",100]] as const)await creator.getByLabel(field,{exact:true}).fill(String(value));
  await creator.locator("[data-zone-create-tile]").click();await expect(zones.locator("[data-zone-tile] option").filter({hasText:"Original endpoint trigger"})).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Restore original endpoint");
  await zones.getByRole("button",{name:"Remove step 2"}).click();
  for(const method of ["enter","exit","stop","create","rotate","click","manual"])await zones.getByRole("checkbox",{name:method,exact:true}).setChecked(method==="enter");
  const addMove=async()=>{await zones.locator('[data-zone-add="move"]').click();return zones.locator("[data-zone-step]").last();};
  const detour=await addMove();await detour.getByLabel("Move targets",{exact:true}).selectOption("triggering");
  await detour.getByLabel("Move X",{exact:true}).fill("900");await detour.getByLabel("Move Y",{exact:true}).fill("700");
  await detour.getByLabel("Move trigger tiles",{exact:true}).uncheck();
  const back=await addMove();await back.getByLabel("Move targets",{exact:true}).selectOption("triggering");
  await back.getByLabel("Move destination source",{exact:true}).selectOption("original");
  await back.getByLabel("Move X",{exact:true}).fill("25");await back.getByLabel("Move Y",{exact:true}).fill("-25");
  await back.getByLabel("Move trigger tiles",{exact:true}).uncheck();
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  await save();await page.locator('[data-window="macros"] [data-window-close]').click();
  const sprite=()=>page.evaluate(()=>{
    type Node={x:number;y:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
    const token=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage.getChildByLabel("tokens",true)?.children[0];return token?{x:token.x,y:token.y}:null;
  });
  const at=async(x:number,y:number)=>{await expect.poll(()=>hostCall<{x:number;y:number}>(page,"tokenPos")).toMatchObject({x,y});await expect.poll(sprite).toEqual({x:x-50,y:y-50});};
  const drag=async()=>{await page.locator('[data-canvas-tool="select"]').click();
    const from=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:150,y:450}),to=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:650,y:450});
    await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:10});await page.mouse.up();await at(675,425);};
  await at(150,450);await drag();
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(650,450);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(150,450);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");await at(150,450);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Restore original endpoint"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.locator('[data-zone-step]').nth(2).getByLabel("Move destination source",{exact:true})).toHaveValue("original");
  await page.locator('[data-window="macros"] [data-window-close]').click();await drag();
  const card=page.locator('[data-testid="action-revert-card"]').filter({hasText:"Restore original endpoint"});
  await card.getByTestId("action-revert").click();await at(650,450);
});

test("Stop Token Movement settles on the entry boundary, snaps, then Original Destination resumes the host path",async({page})=>{
  test.setTimeout(120_000);await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  await surfaceCallArg(page,"app","pf1ePlaceTokens",[{id:"stop-runner",col:0,row:4,size:"Medium"}]);await expect.poll(()=>hostCall<number>(page,"tokenCount")).toBe(1);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]"),creator=zones.locator("[data-zone-tile-create]");await creator.locator("summary").click();
  await creator.getByLabel("Tile name").fill("Stop movement trigger");
  for(const [field,value] of [["X",200],["Y",400],["Width",200],["Height",100]] as const)await creator.getByLabel(field,{exact:true}).fill(String(value));
  await creator.locator("[data-zone-create-tile]").click();await expect(zones.locator("[data-zone-tile] option").filter({hasText:"Stop movement trigger"})).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Stop then resume");
  while(await zones.locator("[data-zone-step]").count()>0){const count=await zones.locator("[data-zone-step]").count();await zones.getByRole("button",{name:`Remove step ${count}`}).click();}
  for(const method of ["enter","exit","stop","create","rotate","click","manual"])await zones.getByRole("checkbox",{name:method,exact:true}).setChecked(method==="enter");
  const once=zones.getByLabel("Once per token",{exact:true});if(await once.isChecked())await once.uncheck();
  await zones.locator('[data-zone-add="stopMovement"]').click();await zones.getByLabel("Stop movement snap to grid",{exact:true}).check();
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  await save();await page.locator('[data-window="macros"] [data-window-close]').click();
  const sprite=()=>page.evaluate(()=>{type Node={x:number;y:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
    const token=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage.getChildByLabel("tokens",true)?.children[0];return token?{x:token.x,y:token.y}:null;});
  const at=async(x:number,y:number)=>{await expect.poll(()=>hostCall<{x:number;y:number}>(page,"tokenPos")).toMatchObject({x,y});await expect.poll(sprite).toEqual({x:x-50,y:y-50});};
  const drag=async()=>{await page.locator('[data-canvas-tool="select"]').click();const from=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:50,y:450}),to=await surfaceCallArg<{x:number;y:number}>(page,"app","screenOf",{x:650,y:450});
    await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:10});await page.mouse.up();};
  await at(50,450);const movementSeq=await hostCall<number>(page,"seq");await drag();await at(150,450);expect(await hostCall<number>(page,"seq")).toBe(movementSeq+2);
  // The history-only graph commit undoes first; the stop and original endpoint were atomic in the movement envelope.
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(150,450);
  await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await at(50,450);
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");await at(50,450);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Stop then resume"}).getByRole("button",{name:"Edit"}).click();
  await zones.locator('[data-zone-add="move"]').click();const move=zones.locator("[data-zone-step]").last();
  await move.getByLabel("Move targets",{exact:true}).selectOption("triggering");await move.getByLabel("Move destination source",{exact:true}).selectOption("original");
  await move.getByLabel("Move X",{exact:true}).fill("25");await move.getByLabel("Move Y",{exact:true}).fill("-25");await save();
  await page.locator('[data-window="macros"] [data-window-close]').click();await drag();await at(675,425);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Stop then resume"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Stop movement snap to grid",{exact:true})).toBeVisible();
  await expect(zones.locator('[data-zone-step]').last().getByLabel("Move destination source",{exact:true})).toHaveValue("original");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const card=page.locator('[data-testid="action-revert-card"]').filter({hasText:"Stop then resume"});await card.getByTestId("action-revert").click();await at(650,450);
});

test("production group movement preplans conditional Stop once per token with separate Undo boundaries", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [
    { id: "group-stop-a", col: 0, row: 4, size: "Medium" },
    { id: "group-stop-b", col: 0, row: 5, size: "Medium" },
  ]);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(2);

  await page.locator("#gm-macros").click(); await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  const tileEditor = zones.locator("[data-zone-tile-create]");
  if ((await tileEditor.getAttribute("open")) === null) await tileEditor.locator("summary").click();
  await tileEditor.getByLabel("Tile name").fill("Group Stop boundary");
  for (const [label, value] of [["X", 200], ["Y", 400], ["Width", 200], ["Height", 200]] as const)
    await tileEditor.getByLabel(label, { exact: true }).fill(String(value));
  await tileEditor.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Group Stop boundary" })).toHaveCount(1);

  await zones.locator("[data-zone-name]").fill("Conditional group Stop");
  while (await zones.locator("[data-zone-step]").count() > 0) {
    const count = await zones.locator("[data-zone-step]").count();
    await zones.getByRole("button", { name: `Remove step ${count}` }).click();
  }
  for (const method of ["enter", "exit", "stop", "create", "rotate", "click", "manual"])
    await zones.getByRole("checkbox", { name: method, exact: true }).setChecked(method === "enter");
  const once = zones.getByLabel("Once per token", { exact: true });
  if (await once.isChecked()) await once.uncheck();

  await zones.locator('[data-zone-add="checkValue"]').click();
  const condition = zones.locator("[data-zone-step]").last();
  await condition.getByLabel("Check Value source").selectOption("direction.x");
  await condition.getByLabel("Check Value comparison").selectOption("eq");
  await condition.getByLabel("Check Value direction").selectOption("right");
  await zones.locator('[data-zone-add="stopMovement"]').click();
  await zones.getByLabel("Stop movement snap to grid", { exact: true }).check();
  const beforeSave = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeSave + 1);

  const sceneId = await hostCall<string | null>(page, "activeSceneId");
  if (!sceneId) throw new Error("active scene is unavailable");
  const beforeMove = await hostCall<number>(page, "seq");
  await page.evaluate((payload: { sceneId: string; ops: unknown[] }) => {
    const surface = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { submit(ops: never[]): void } } } } }).__vttE2E?.app;
    if (!surface?.gm?.client) throw new Error("GM test client is unavailable");
    surface.gm.client.submit(payload.ops as never[]);
  }, { sceneId, ops: [
    { kind: "update", ref: { coll: "tokens", id: "group-stop-a", parent: { coll: "scenes", id: sceneId } }, diff: { x: 650, y: 450 } },
    { kind: "update", ref: { coll: "tokens", id: "group-stop-b", parent: { coll: "scenes", id: sceneId } }, diff: { x: 650, y: 550 } },
  ] });
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeMove + 3);
  const positions = () => page.evaluate(() => {
    const surface = (globalThis as unknown as { __vttE2E?: { app?: {
      activeSceneId?: () => string | null;
      gm?: { client?: { store?: { get(coll: string, id: string): { tokens?: Array<{ _id: string; x: number; y: number }> } | undefined } } };
    } } }).__vttE2E?.app;
    const sceneId = surface?.activeSceneId?.();
    return sceneId ? (surface?.gm?.client?.store?.get("scenes", sceneId)?.tokens?.map(({ _id, x, y }) => ({ _id, x, y })) ?? []).sort((a, b) => a._id.localeCompare(b._id)) : [];
  });
  const expected = [{ _id: "group-stop-a", x: 150, y: 450 }, { _id: "group-stop-b", x: 150, y: 550 }];
  await expect.poll(positions).toEqual(expected);
  await expect(zones.locator("li").filter({ hasText: "Conditional group Stop" })).toContainText("2 run(s)");

  // Two graph-history undos leave both stopped positions intact; the group move then undoes atomically.
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(positions).toEqual(expected);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(positions).toEqual(expected);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect.poll(positions).toEqual([
    { _id: "group-stop-a", x: 50, y: 450 }, { _id: "group-stop-b", x: 50, y: 550 },
  ]);
});

test("production canvas sweeps two rotated trigger zones in order; Undo/Redo does not re-fire", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens", [
    { id: "rotated-zone-runner", col: 0, row: 2, size: "Medium" },
  ])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  const createTile = async (name: string, x: number, rotation: number) => {
    const creator = zones.locator("[data-zone-tile-create]");
    if (await creator.getAttribute("open") === null) await creator.locator("summary").click();
    await creator.getByLabel("Tile name").fill(name);
    for (const [field, value] of [["X", x], ["Y", 200], ["Width", 100], ["Height", 100], ["Rotation °", rotation]] as const)
      await creator.getByLabel(field, { exact: true }).fill(String(value));
    await creator.locator("[data-zone-create-tile]").click();
    const option = zones.locator("[data-zone-tile] option").filter({ hasText: name });
    await expect(option).toHaveCount(1);
    const value = await option.getAttribute("value");
    if (!value) throw new Error(`missing tile id for ${name}`);
    return value;
  };
  const saveGraph = async (name: string, tileId: string, chat: string) => {
    await zones.locator("[data-zone-tile]").selectOption(tileId);
    await zones.locator("[data-zone-name]").fill(name);
    for (const method of ["enter", "exit", "stop"])
      await zones.locator(".methods").getByLabel(method, { exact: true }).check();
    await zones.locator(".methods").getByLabel("manual", { exact: true }).uncheck();
    await zones.locator("[data-zone-step]").last().getByLabel("Text", { exact: true }).fill(chat);
    const seq = await hostCall<number>(page, "seq");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
    await expect(zones.locator("li").filter({ hasText: name })).toHaveCount(1);
  };

  // Compact plates leave room for both footprint crossings within the actor's 30 ft move.
  const firstTile = await createTile("First rotated zone", 170, 45);
  await saveGraph("First crossing", firstTile, "First rotated {{method}}");
  await zones.getByRole("button", { name: "New", exact: true }).click();
  const secondTile = await createTile("Second rotated zone", 430, 135);
  await saveGraph("Second crossing", secondTile, "Second rotated {{method}}");
  await page.locator('[data-window="macros"] [data-window-close]').click();

  await page.locator('[data-canvas-tool="select"]').click();
  const start = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: 50, y: 250 });
  const stopping = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: 550, y: 250 });
  const end = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: 650, y: 250 });
  const overLimit = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: 850, y: 250 });
  const chatLines = () => hostCall<string[]>(page, "chatLines");
  const drag = async (origin: { x: number; y: number }, destination: { x: number; y: number }) => {
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.mouse.move(destination.x, destination.y, { steps: 16 });
    await page.mouse.up();
  };

  const firstEnter = "First rotated enter", firstExit = "First rotated exit";
  const secondEnter = "Second rotated enter", secondStop = "Second rotated stop", secondExit = "Second rotated exit";
  const throughAndStop = [firstEnter, firstExit, secondEnter, secondStop];
  // A GM-issued 40 ft drag crosses both zones and commits despite exceeding the
  // linked actor's ordinary walk allowance. Undo it fully before the Stop scenario.
  const gmLongPath = [firstEnter, firstExit, secondEnter, secondExit];
  const beforeGmMove = await hostCall<number>(page, "seq");
  await drag(start, overLimit);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeGmMove + 5);
  await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
    .toMatchObject({ x: 850, y: 250 });
  await expect.poll(chatLines).toEqual(gmLongPath);
  const gmUndoStates = [
    { lines: gmLongPath.slice(0, 3), x: 850 },
    { lines: gmLongPath.slice(0, 2), x: 850 },
    { lines: gmLongPath.slice(0, 1), x: 850 },
    { lines: [], x: 850 },
    { lines: [], x: 50 },
  ];
  for (const state of gmUndoStates) {
    await page.locator("#gm-undo").click();
    await expect.poll(chatLines).toEqual(state.lines);
    await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
      .toMatchObject({ x: state.x, y: 250 });
  }

  const beforeCrossing = await hostCall<number>(page, "seq");
  await drag(start, stopping);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeCrossing + 5);
  await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
    .toMatchObject({ x: 550, y: 250 });
  await expect.poll(chatLines).toEqual(throughAndStop);

  // Leave the second rotated zone: this adds its Exit after the first path's
  // Enter/Exit/Enter/Stop sequence.
  const beforeExit = await hostCall<number>(page, "seq");
  await drag(stopping, end);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeExit + 2);
  await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
    .toMatchObject({ x: 650, y: 250 });
  const allEvents = [...throughAndStop, secondExit];
  await expect.poll(chatLines).toEqual(allEvents);

  // Undo the second Exit graph/movement, then the first path's Stop/Enter/Exit/Enter
  // graphs and movement. Redo restores envelopes without triggering those mechanics.
  const undoStates = [
    { lines: throughAndStop, x: 650 },
    { lines: throughAndStop, x: 550 },
    { lines: throughAndStop.slice(0, 3), x: 550 },
    { lines: throughAndStop.slice(0, 2), x: 550 },
    { lines: throughAndStop.slice(0, 1), x: 550 },
    { lines: [], x: 550 },
    { lines: [], x: 50 },
  ];
  for (const state of undoStates) {
    await page.locator("#gm-undo").click();
    await expect.poll(chatLines).toEqual(state.lines);
    await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
      .toMatchObject({ x: state.x, y: 250 });
  }
  const redoStates = [
    { lines: [], x: 550 },
    { lines: [firstEnter], x: 550 },
    { lines: [firstEnter, firstExit], x: 550 },
    { lines: [firstEnter, firstExit, secondEnter], x: 550 },
    { lines: throughAndStop, x: 550 },
    { lines: throughAndStop, x: 650 },
    { lines: allEvents, x: 650 },
  ];
  for (const state of redoStates) {
    await page.locator("#gm-redo").click();
    await expect.poll(chatLines).toEqual(state.lines);
    await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
      .toMatchObject({ x: state.x, y: 250 });
  }
  for (const event of allEvents) expect((await chatLines()).filter((line) => line === event)).toHaveLength(1);
});
