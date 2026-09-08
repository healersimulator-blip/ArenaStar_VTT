import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("combat tracker (§10)", () => {
  test("start combat from tokens, roll initiative, advance turns", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    // two tokens on the canvas
    await page.click("#add-token");
    await page.click("#add-token");
    await page.click('[data-tab="combat"]');
    await page.click("#combat-start");
    await expect(page.locator(".combat .round")).toContainText(/Round 1/);
    // roll initiative assigns numbers to both rows
    await page.click("#combat-init");
    await expect(page.locator(".combat .order li")).toHaveCount(2);
    const inits = await page
      .locator(".combat .init")
      .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
    expect(inits.filter((v) => v !== "").length).toBe(2);
    // next turn thrice wraps to round 2
    await page.click("#combat-next");
    await page.click("#combat-next");
    await expect(page.locator(".combat .round")).toContainText(/Round 2/);
    // delay flags, then defeat strikes through
    await page
      .locator(".combat .order li")
      .first()
      .locator("button", { hasText: "Mark delayed" })
      .click();
    await expect(page.locator(".combat .order li.delayed")).toHaveCount(1);
    await page
      .locator(".combat .order li")
      .first()
      .locator("button", { hasText: "Defeat" })
      .click();
    await expect(page.locator(".combat .order li.defeated")).toHaveCount(1);
  });
});

test("round wrap clears a delayed marker before that combatant's next turn", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry + "?e2e=1");
  for (let i = 0; i < 3; i++) await page.click("#add-token");
  await page.click('[data-tab="combat"]');
  await page.click("#combat-start");
  const rows = page.locator(".combat .order li");
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const input = rows.nth(i).locator(".init");
    await input.fill(String(30 - 10 * i));
    await input.dispatchEvent("change");
  }
  await page.click("#combat-next");
  await page.click("#combat-next");
  await expect(page.locator(".combat .round")).toContainText("Turn 3/3");
  await rows.nth(1).getByRole("button", { name: "Mark delayed", exact: true }).click();
  await expect(rows.nth(1)).toHaveClass(/delayed/);
  await expect(page.locator(".combat .round")).toContainText("Turn 3/3");
  await page.click("#combat-next");
  await expect(page.locator(".combat .round")).toContainText("Round 2");
  await expect(page.locator(".combat .order li.delayed")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("encounters retain progress independently and follow the active scene", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry + "?e2e=1");
  await page.click("#add-token");
  await page.click("#add-token");
  await page.click('[data-tab="combat"]');
  await page.click("#combat-start");
  const select = page.locator("[data-encounter-select]");
  const first = await select.inputValue();
  await page.click("#combat-next");
  await expect(page.locator(".combat .round")).toContainText("Turn 2/2");
  await page.fill("[data-encounter-name]", "Second encounter");
  await page.click("[data-encounter-create]");
  const second = await select.inputValue();
  expect(second).not.toBe(first);
  await page.click("#combat-start");
  await expect(page.locator(".combat .round")).toContainText("Turn 1/2");
  await select.selectOption(first);
  await expect(page.locator(".combat .round")).toContainText("Turn 2/2");
  await page.click("#scene-add");
  await page.locator(".scenenav [data-scene]").nth(1).click();
  await expect(select.locator("option")).toHaveCount(1);
  await expect(page.locator("#combat-start")).toBeDisabled();
  await page.click("#add-token");
  await page.click("#combat-start");
  await expect(page.locator(".combat .round")).toContainText("Turn 1/1");
  await page.locator(".scenenav [data-scene]").first().click();
  await expect(select).toHaveValue(first);
  await expect(page.locator(".combat .round")).toContainText("Turn 2/2");
  await select.selectOption(second);
  await expect(page.locator(".combat .round")).toContainText("Turn 1/2");
  expect(errors).toEqual([]);
});
