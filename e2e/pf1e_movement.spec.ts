import { expect, test } from "@playwright/test";
import { entry, gmCall, hostCall, waitForSurface } from "./lib";

/**
 * P03/D-198 — movement legality through the real drag path. A canvas drag is
 * judged by `pf1eMovePlan` inside `onTokenMove` BEFORE the opportunity queue,
 * so an illegal walk never provokes and never commits: the controller restores
 * the token's square on the "cancel" return (D-185's own contract).
 *
 * The placed actors author no speed, so the derivation's own named default
 * (30 ft) is what the walk is judged against — the same default the sheet
 * reports. Fixtures: grid 100 world units per square, 5 ft per square.
 */

type Placed = Array<{ id: string; col: number; row: number; size?: string }>;

const place = (page: import("@playwright/test").Page, tokens: Placed) =>
  page.evaluate((t) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1ePlaceTokens: (x: unknown) => { ok: boolean; placed: number } }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1ePlaceTokens(t);
  }, tokens);

/** Drag a token between world points through the real canvas. */
async function dragWorld(
  page: import("@playwright/test").Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = page.locator(".canvas-host canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const viewport = await canvas.evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }));
  const { fitRect, worldToScreen } = await import("../src/canvas/camera");
  const camera = fitRect(
    { x: 0, y: 0, width: 2000, height: 1500 },
    viewport,
    24,
  );
  const a = worldToScreen(camera, from.x, from.y);
  const b = worldToScreen(camera, to.x, to.y);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 8 });
  await page.mouse.up();
}

/** Cell centre in world units. */
const centre = (col: number, row: number): { x: number; y: number } => ({
  x: col * 100 + 50,
  y: row * 100 + 50,
});

async function sceneWith(
  page: import("@playwright/test").Page,
  tokens: Placed,
): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const placed = await place(page, tokens);
  expect(placed.ok).toBe(true);
  await expect
    .poll(async () => hostCall<number>(page, "tokenCount"))
    .toBe(tokens.length);
}

test.describe("PF1e movement legality (P03)", () => {
  test("a walk beyond speed is refused before it commits, with the named cost", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The mover (first placed, so tokenPos tracks it) at (2,2).
    await sceneWith(page, [
      { id: "mover", col: 2, row: 2 },
      { id: "far", col: 14, row: 14 },
    ]);
    const before = await hostCall<{ x: number; y: number }>(page, "tokenPos");
    expect(before).toEqual(centre(2, 2));

    // 8 orthogonal squares = 40 ft, against the derivation's 30-ft default.
    await dragWorld(page, centre(2, 2), centre(10, 2));

    // The token never moved, and the refusal is the notification's own line.
    await expect
      .poll(async () => hostCall<{ x: number; y: number }>(page, "tokenPos"))
      .toEqual(centre(2, 2));
    const notifications = await gmCall<Array<{ message: string }>>(
      page,
      "notifications",
    );
    expect(
      notifications.some((n) =>
        n.message.includes(
          "mover can't move there — the walk costs 40 ft but a move action moves 30 ft",
        ),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test("you can never end movement in an occupied square", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "mover", col: 0, row: 0 },
      { id: "blocker", col: 3, row: 0 },
    ]);

    // 15 ft — inside the budget — but the destination is blocker's square.
    await dragWorld(page, centre(0, 0), centre(3, 0));
    await expect
      .poll(async () => hostCall<{ x: number; y: number }>(page, "tokenPos"))
      .toEqual(centre(0, 0));
    const notifications = await gmCall<Array<{ message: string }>>(
      page,
      "notifications",
    );
    expect(
      notifications.some((n) =>
        n.message.includes(
          "you can never end movement in an occupied square — the destination overlaps blocker's space",
        ),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a walk inside the budget commits through the ordinary op path", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "mover", col: 0, row: 0 },
      { id: "bystander", col: 6, row: 6 },
    ]);

    // 10 ft, nothing on the path, no one threatened: a plain legal move.
    await dragWorld(page, centre(0, 0), centre(2, 0));
    await expect
      .poll(async () => hostCall<{ x: number; y: number }>(page, "tokenPos"))
      .toEqual(centre(2, 0));
    const notifications = await gmCall<Array<{ message: string }>>(
      page,
      "notifications",
    );
    expect(
      notifications.some((n) => n.message.includes("can't move there")),
    ).toBe(false);
    expect(errors).toEqual([]);
  });
});
