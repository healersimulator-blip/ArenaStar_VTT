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
    await page.locator(".combat .order li").first().locator("button", { hasText: "Delay" }).click();
    await expect(page.locator(".combat .order li.delayed")).toHaveCount(1);
    await page
      .locator(".combat .order li")
      .first()
      .locator("button", { hasText: "Defeat" })
      .click();
    await expect(page.locator(".combat .order li.defeated")).toHaveCount(1);
  });
});
