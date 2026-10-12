/* eslint-disable @typescript-eslint/no-non-null-assertion -- explicit fixtures and required renderer readbacks; absence fails the test */
import { expect, test } from "@playwright/test";
import type { Stage } from "../src/canvas/stage";
import type { RegionDocument, TokenDocument } from "../src/core/documents";
import { entry, waitForSurface, surfaceCallArg } from "./lib";

test("native vector cover clips actual token pixels, preserves holes and never overrides visibility", async ({
  page,
}) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const result = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    stage.app.ticker.stop();
    const token: TokenDocument = {
      _id: "native-cover-token",
      type: "token",
      name: "Covered name",
      ownership: { default: 1 },
      flags: {},
      system: {},
      x: 200,
      y: 200,
      width: 100,
      height: 100,
      rotation: 0,
      img: "",
      hidden: false,
      disposition: "neutral",
      vision: true,
      light: { radius: 0, color: "#ffffff", alpha: 0 },
      elevation: 0,
    };
    const region: RegionDocument = {
      _id: "roof",
      type: "region",
      name: "Roof",
      ownership: { default: 1 },
      flags: {},
      system: {},
      x: 200,
      y: 150,
      width: 50,
      height: 100,
      shape: {
        kind: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      fauxOverhead: {
        kind: "fauxOverhead",
        coverZ: 10,
        affectedElevation: { bottom: 0, top: 10 },
      },
    };
    stage.setTokenVisibility(null);
    stage.setFauxOverhead([region]);
    stage.syncTokens(
      [token],
      new Map([[token._id, [{ code: "HIDDEN CHIP", tint: 0xff0000 }]]]),
    );
    const layer = stage.root.getChildByLabel("tokens")!;
    const frame = layer.getLocalBounds().rectangle.clone();
    frame.x = 0;
    frame.y = 0;
    frame.width = 400;
    frame.height = 400;
    const alpha = (x: number, y: number): number => {
      stage.render();
      const { pixels, width } = stage.app.renderer.extract.pixels({
        target: layer,
        frame,
        resolution: 1,
      });
      return pixels[(y * width + x) * 4 + 3]!;
    };
    const partial = {
      left: alpha(180, 200),
      right: alpha(220, 200),
      pickLeft: stage.tokenPointVisible(token._id, { x: 180, y: 200 }),
      pickRight: stage.tokenPointVisible(token._id, { x: 220, y: 200 }),
      marquee: stage.tokenMarqueeSelectable(token._id),
      badgesVisible: layer
        .getChildByLabel(`token:${token._id}`)!
        .getChildByLabel("badges")!.visible,
    };
    region.fauxOverhead!.footprint = {
      version: 2,
      components: [
        {
          outer: region.shape.points.map(([x, y]) => ({ x, y })),
          holes: [
            [
              { x: 0.2, y: 0.2 },
              { x: 0.8, y: 0.2 },
              { x: 0.8, y: 0.8 },
              { x: 0.2, y: 0.8 },
            ],
          ],
        },
      ],
    };
    stage.setFauxOverhead([region]);
    const hole = {
      center: alpha(225, 200),
      rim: alpha(205, 200),
      pick: stage.tokenPointVisible(token._id, { x: 225, y: 200 }),
    };
    region.fauxOverhead!.footprint.components.push({
      outer: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.6, y: 0.6 },
        { x: 0.4, y: 0.6 },
      ],
      holes: [],
    });
    stage.setFauxOverhead([region]);
    const filledHole = alpha(225, 200);
    const outer = region.shape.points.map(([x, y]) => ({ x, y }));
    const openings = [0.1, 0.7].map((y) => [
      { x: 0.2, y }, { x: 0.8, y }, { x: 0.8, y: y + 0.2 }, { x: 0.2, y: y + 0.2 },
    ]);
    region.fauxOverhead!.footprint = { version: 2, components: [
      { outer, holes: [] }, { outer, holes: openings },
    ] };
    stage.setFauxOverhead([region]);
    const localHolesOnly = [alpha(225, 170), alpha(225, 230)];
    region.fauxOverhead!.footprint.components.shift();
    stage.setFauxOverhead([region]);
    const twoOpenings = [alpha(225, 170), alpha(225, 230)];
    stage.syncTokens([{ ...token, elevation: 10 }]);
    const above = alpha(225, 200);
    stage.setTokenVisibility(new Set());
    const denied = alpha(180, 200);
    stage.setTokenVisibility(null);
    stage.setFauxOverhead([]);
    stage.syncTokens([token]);
    const removed = alpha(225, 200);
    const maskCount = layer.children.filter((child) =>
      child.label.startsWith("overheadMask:"),
    ).length;
    return { renderer: stage.rendererName, partial, hole, filledHole, localHolesOnly, twoOpenings, above, denied, removed, maskCount };
  });
  if (result.renderer === "canvas") {
    // G-05 (D-429): Canvas2D has no inverse masks. The whole token hides while a cover overlaps
    // it, so no covered pixel is ever revealed (the old inverted cut-out showed exactly those).
    expect(result.partial).toEqual({ left: 0, right: 0, pickLeft: false, pickRight: false, marquee: false, badgesVisible: false });
    expect(result.hole).toEqual({ center: 0, rim: 0, pick: false });
    expect(result.filledHole).toBe(0);
    expect(result.localHolesOnly).toEqual([0, 0]);
    expect(result.twoOpenings).toEqual([0, 0]);
  } else {
    expect(result.partial.left).toBeGreaterThan(0);
    expect(result.partial.right).toBe(0);
    expect(result.partial.pickLeft).toBe(true);
    expect(result.partial.pickRight).toBe(false);
    expect(result.partial.marquee).toBe(false);
    expect(result.partial.badgesVisible).toBe(false);
    expect(result.hole.center).toBeGreaterThan(0);
    expect(result.hole.rim).toBe(0);
    expect(result.hole.pick).toBe(true);
    expect(result.filledHole).toBe(0);
    expect(result.localHolesOnly).toEqual([0, 0]);
    expect(result.twoOpenings.every((alpha) => alpha > 0)).toBe(true);
  }
  expect(result.above).toBeGreaterThan(0);
  expect(result.denied).toBe(0);
  expect(result.removed).toBeGreaterThan(0);
  expect(result.maskCount).toBe(0);
});

test("GM enables and removes a native cover through the region editor", async ({
  page,
}) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.getByRole("button", { name: "Add token", exact: true }).click();
  await surfaceCallArg(page, "app", "authorRegion", {
    sceneId: "scene-1",
    region: {
      _id: "editor-roof",
      type: "region",
      name: "Native bridge cover",
      ownership: { default: 1 },
      flags: {},
      system: {},
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      shape: {
        kind: "polygon",
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    },
  });
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  await page.locator("[data-zone-source-kind]").selectOption("region");
  await page.locator("[data-zone-tile]").selectOption("editor-roof");
  const editor = page.locator("[data-faux-overhead-editor]");
  await editor.locator(":scope > summary").click();
  await editor.getByLabel("Enable solid cover").check();
  await editor.getByLabel("Cover height").fill("12");
  await editor.locator("[data-faux-apply]").click();
  // Masks exist only where the renderer supports inverse masks (G-05); covers exist everywhere.
  const coverState = () => page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    const masks = stage.root.getChildByLabel("tokens")!.children.filter((c) => c.label.startsWith("overheadMask:")).length;
    return { covers: stage.fauxOverheadCoverCount(), masked: stage.rendererName === "canvas" || masks > 0 };
  });
  await expect.poll(coverState).toEqual({ covers: 1, masked: true });
  await editor.getByLabel("Enable solid cover").uncheck();
  await editor.locator("[data-faux-apply]").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __stage: Stage }).__stage.root
            .getChildByLabel("tokens")!
            .children.filter((c) => c.label.startsWith("overheadMask:")).length,
      ),
    )
    .toBe(0);
  await expect.poll(async () => (await coverState()).covers).toBe(0);
  await page.getByRole("button", { name: "Undo (Ctrl+Z)", exact: true }).click();
  await expect(editor.getByLabel("Enable solid cover")).toBeChecked();
  await expect.poll(coverState).toEqual({ covers: 1, masked: true });
  await page.getByRole("button", { name: "Redo (Ctrl+Y)", exact: true }).click();
  await expect(editor.getByLabel("Enable solid cover")).not.toBeChecked();

});
