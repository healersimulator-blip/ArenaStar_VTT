import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

/**
 * G-27 (D-447): an area happens on its caster's floor. From the edge of Floor 2's traced stairwell
 * the caster's 30 ft spread over the well catches a goblin on Floor 2 and the goblin standing in the
 * well below, but not the goblin under the solid floor, though it is within 30 ft. Without a caster
 * (no floor), the preview keeps the old flat behaviour.
 */
test("a spread on Floor 2 reaches the floor below only through the stairwell", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  // Caster at (350, 550); goblins at (650, 650) upstairs, (550, 450) in the well and (850, 450) under the floor.
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "caster", col: 3, row: 5 }, { id: "goblinUp", col: 6, row: 6, owner: "gm" },
    { id: "goblinWell", col: 5, row: 4, owner: "gm" }, { id: "goblinUnder", col: 8, row: 4, owner: "gm" }]);
  const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`).toString("base64")}`;
  const red = await surfaceCallArg<string>(page, "gm", "seedTile", { name: "Ground RED", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
    img: svg('<rect width="100" height="100" fill="#ff0000"/>') });
  const blue = await surfaceCallArg<string>(page, "gm", "seedTile", { name: "Upper BLUE", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
    img: svg('<path fill="#0000ff" fill-rule="evenodd" d="M0 0H100V100H0Z M40 40V60H60V40Z"/>') });
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("2");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel(`Floor map tile ${red}`, { exact: true }).check(); await rows.nth(1).getByLabel(`Floor map tile ${blue}`, { exact: true }).check();
  await editor.locator("[data-level-visibility-presets]").getByRole("button", { name: "Down to ground", exact: true }).click();
  const surface = rows.nth(1).locator("[data-level-surface]");
  await surface.getByRole("button", { name: "Trace from floor art", exact: true }).click();
  await expect(surface.locator("[data-surface-status]")).toHaveText("1 solid area · 1 opening");
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
  const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
  if (!ground || !upper) throw new Error("levels missing");
  const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
  for (const [id, level] of [["caster", upper], ["goblinUp", upper], ["goblinWell", ground], ["goblinUnder", ground]] as const) {
    await bindings.getByLabel("Membership object", { exact: true }).selectOption(id); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(level);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
  }
  const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
  await play.getByLabel("Enable isolated floor play", { exact: true }).click();
  const preflight = play.locator("[data-level-preflight]");
  await expect(preflight.or(play.getByRole("status").filter({ hasText: "enabled" }))).toBeVisible();
  if (await preflight.isVisible()) await preflight.getByRole("button", { name: "Enable anyway", exact: true }).click();
  await expect(play.getByRole("status")).toContainText("enabled");

  type Preview = { ok: boolean; affectedTokenIds: string[] };
  const spread = { kind: "spread", originCol: 5, originRow: 5, radiusFt: 30 };
  await expect.poll(async () => [...(await surfaceCallArg<Preview>(page, "gm", "pf1eAreaPreviewShow", { ...spread, casterTokenId: "caster" })).affectedTokenIds].sort())
    .toEqual(["caster", "goblinUp", "goblinWell"]);
  // No caster, no floor: every token in the cells, as before floors existed.
  const flat = await surfaceCallArg<Preview>(page, "gm", "pf1eAreaPreviewShow", spread);
  expect(flat.ok).toBe(true);
  expect([...flat.affectedTokenIds].sort()).toEqual(["caster", "goblinUnder", "goblinUp", "goblinWell"]);
});
