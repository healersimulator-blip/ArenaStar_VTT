import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("bootstrap (§15: must boot from file://)", () => {
  test("app boots and reports runtime capabilities", async ({ page }) => {
    await page.goto(entry);
    await expect(page.locator("h1")).toHaveText("VTT");
    await expect(page.locator("section h2")).toContainText("Runtime capabilities");
    // The seven §0-detected capabilities render with an explicit state.
    await expect(page.locator("li")).toHaveCount(7);
    await expect(page.getByText("webcrypto", { exact: true })).toBeVisible();
    await expect(page.getByText("webrtc", { exact: true })).toBeVisible();
  });
});
