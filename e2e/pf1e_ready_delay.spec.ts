/**
 * P07/D-194 — delay & ready in the combat tracker (browser). Drives the real UI: import the
 * PF1e core pack, drop two bestiary tokens, start, set deterministic initiatives by hand, then
 * exercise the Delay / Ready / Fire-ready controls and assert the initiative order, the spent
 * standard action, the readied badge and the fired note — all through the same `push` the other
 * tracker controls use (no synthetic RNG; the delay/ready transitions are dice-free).
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

async function importShippedCore(page: Page): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { zipSync } = await import("fflate");
  const files = Object.fromEntries(
    ["manifest.json", "packs/bestiary.json", "packs/spells.json"].map(
      (path) => [
        path,
        readFileSync(new URL(`../systems/pf1e-core/${path}`, import.meta.url)),
      ],
    ),
  );
  expect(
    await surfaceCallArg(
      page,
      "app",
      "importPackageZip",
      Array.from(zipSync(files)),
    ),
  ).toMatchObject({ ok: true });
}

async function setInit(
  page: Page,
  rowIndex: number,
  value: string,
): Promise<void> {
  const input = page
    .locator(".combat .order li")
    .nth(rowIndex)
    .locator(".init");
  await input.fill(value);
  await input.dispatchEvent("change");
}

test("PF1e delay, ready and fire-ready reorder the tracker by the rule", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);
  await page.click('[data-tab="compendia"]');
  const canvas = page.locator(".canvas-host canvas");
  await page
    .locator('[data-entry-id="heavy-infantry"]')
    .dragTo(canvas, { targetPosition: { x: 160, y: 160 } });
  await page
    .locator('[data-entry-id="heavy-cavalry"]')
    .dragTo(canvas, { targetPosition: { x: 260, y: 160 } });
  await page.click('[data-tab="combat"]');
  await page.click("#combat-start");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Infantry",
    "Heavy Cavalry",
  ]);
  // Deterministic initiative: infantry 20 (goes first), cavalry 10.
  await setInit(page, 0, "20");
  await setInit(page, 1, "10");
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Infantry",
  );

  // Delay: the current combatant (infantry) drops to 5 and the cavalry acts next.
  await page
    .locator(".combat .order li")
    .first()
    .locator("[data-delay]")
    .click();
  const delayForm = page.locator("[data-delay-form]");
  await expect(delayForm).toBeVisible();
  await delayForm.locator("input[type=number]").fill("5");
  await delayForm.locator("[data-confirm-delay]").click();
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Cavalry",
    "Heavy Infantry",
  ]);
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Cavalry",
  );

  // Ready: the cavalry spends its standard action and carries a readied action.
  await page
    .locator(".combat .order li")
    .first()
    .locator("[data-ready]")
    .click();
  const readyForm = page.locator("[data-ready-form]");
  await expect(readyForm).toBeVisible();
  await readyForm.locator("[data-confirm-ready]").click();
  await expect(page.locator("[data-budget-standard]")).toHaveText("Std ✓");
  await expect(
    page.locator(".combat .order li").first().locator("[data-readied]"),
  ).toHaveText("readied");

  // End the cavalry's turn: the infantry is current, and the cavalry's ready can fire.
  await page.click("#combat-next");
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Infantry",
  );

  // Fire the ready against the current combatant: the cavalry moves to 5 + 1 and acts now.
  await page
    .locator(".combat .order li")
    .first()
    .locator("[data-fire-ready]")
    .click();
  const fireForm = page.locator("[data-fire-form]");
  await expect(fireForm).toBeVisible();
  await fireForm.locator("[data-confirm-fire]").click();
  // D-195: firing now *resolves* the readied action through the sheet's flow. The
  // bestiary tokens carry no hit points, so the resolution honestly reports that it
  // could not write damage — but the note still names the readied action, and the
  // reorder below is the same either way.
  await expect(page.locator("[data-fired-note]")).toContainText(
    "Heavy Cavalry's readied",
  );
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Cavalry",
    "Heavy Infantry",
  ]);
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Cavalry",
  );
  // The cavalry's initiative is the infantry's (5) + 1, and its ready is spent.
  await expect(
    page.locator(".combat .order li").first().locator(".init"),
  ).toHaveValue("6");
  await expect(
    page.locator(".combat .order li").first().locator("[data-readied]"),
  ).toHaveCount(0);

  expect(errors).toEqual([]);
});
