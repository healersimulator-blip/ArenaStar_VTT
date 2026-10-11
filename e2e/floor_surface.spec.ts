import { expect, test } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * G-21 (D-444): the GM traces a floor's solid area from its map art. The transparent stairwell
 * in the upper floor's art becomes an opening; the fully opaque ground floor has none. The shape
 * is saved with the draft levels, and "Solid everywhere" clears it again.
 */
test("trace a floor's solid area from its art, save it, and clear it", async ({ page: host }) => {
  test.setTimeout(120_000);
  type Surfaces = Array<{ id: string; name: string; surface: { components: number; openings: number; vertices: number; source: string | null } | null }>;
  await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
  const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`).toString("base64")}`;
  const red = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Ground RED", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
    img: svg('<rect width="100" height="100" fill="#ff0000"/>') });
  // The upper floor is blue with a transparent square stairwell (400–600 in scene pixels).
  const blue = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Upper BLUE", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
    img: svg('<path fill="#0000ff" fill-rule="evenodd" d="M0 0H100V100H0Z M40 40V60H60V40Z"/>') });
  await host.locator('[data-tab="scenes"]').click();
  const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("2");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel(`Floor map tile ${red}`, { exact: true }).check();
  await rows.nth(1).getByLabel(`Floor map tile ${blue}`, { exact: true }).check();

  const upper = rows.nth(1).locator("[data-level-surface]"), ground = rows.nth(0).locator("[data-level-surface]");
  await expect(upper.locator("[data-surface-status]")).toHaveText("Solid everywhere");
  await upper.getByRole("button", { name: "Trace from floor art", exact: true }).click();
  await expect(upper.locator("[data-surface-status]")).toHaveText("1 solid area · 1 opening");
  await expect(upper.getByRole("img", { name: "Floor 2 floor shape" })).toBeVisible();
  await expect(editor.getByRole("status").first()).toContainText("Floor 2 traced: 1 solid area · 1 opening.");
  await ground.getByRole("button", { name: "Trace from floor art", exact: true }).click();
  await expect(ground.locator("[data-surface-status]")).toHaveText("1 solid area · 0 openings");

  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click();
  await expect(editor.getByRole("status").first()).toContainText("Draft saved");
  await expect.poll(async () => (await hostCall<Surfaces>(host, "levelSurfaces")).map((l) => [l.name, l.surface])).toEqual([
    ["Ground", { components: 1, openings: 0, vertices: 4, source: "art" }],
    ["Floor 2", { components: 1, openings: 1, vertices: 8, source: "art" }],
  ]);

  // Back to solid everywhere.
  await upper.getByRole("button", { name: "Solid everywhere", exact: true }).click();
  await expect(upper.locator("[data-surface-status]")).toHaveText("Solid everywhere");
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click();
  await expect(editor.getByRole("status").first()).toContainText("Draft saved");
  await expect.poll(async () => (await hostCall<Surfaces>(host, "levelSurfaces")).map((l) => l.surface?.openings ?? null)).toEqual([0, null]);
});
