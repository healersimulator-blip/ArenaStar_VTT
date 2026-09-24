import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("bootstrap (§15: must boot from file://)", () => {
  test("app boots and reports runtime capabilities", async ({ page }) => {
    await page.goto(entry);
    await expect(page.locator("h1")).toHaveText("VTT");
    // D-249: the start screen also lists worlds under its own h2; the capability report keeps its id.
    await expect(page.locator("#caps-h")).toContainText("Runtime capabilities");
    // The seven §0-detected capabilities live in a disclosure so routine
    // diagnostics no longer occupy the launcher until somebody asks for them.
    await expect(page.locator(".capabilities")).not.toHaveAttribute("open", "");
    await page.locator("#caps-h").click();
    await expect(page.locator(".capabilities li")).toHaveCount(7);
    await expect(page.getByText("webcrypto", { exact: true })).toBeVisible();
    await expect(page.getByText("webrtc", { exact: true })).toBeVisible();
  });
});
