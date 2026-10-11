import { expect, test } from "@playwright/test";
import { entry, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

test("player switches host-authorized token floors, picking follows focus and reassignment withdraws a floor", async ({ browser }) => {
  test.setTimeout(120000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "lower", col: 1, row: 1 }, { id: "upper", col: 4, row: 4 }]);
    await host.locator('[data-tab="scenes"]').click();
    const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
    await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click();
    await expect(editor.getByRole("status")).toContainText("Draft saved");
    const ids = await editor.locator("[data-level-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-level-id") ?? ""));
    const base = ids[0], upper = ids[1]; if (!base || !upper) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    async function assign(token: string, level: string) {
      await bindings.getByLabel("Membership object", { exact: true }).selectOption(token);
      await bindings.getByLabel("Token destination level", { exact: true }).selectOption(level);
      await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click();
      await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    }
    await assign("lower", base); await assign("upper", upper);
    await host.click("#share");
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue()); await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue()); await player.click("#answer-apply");
    await waitForSurface(player, "playerCanvas");
    const select = player.getByLabel("Player floor focus", { exact: true }); await expect(select).toBeVisible();
    const drawn = () => surfaceCall<string[]>(player, "playerCanvas", "drawnTokens");
    const picked = () => surfaceCall<string[]>(player, "playerCanvas", "pickableTokens");
    await expect.poll(drawn).toEqual(["lower", "upper"]);
    await select.selectOption(upper); await expect(select).toHaveValue(upper);
    await expect.poll(drawn).toEqual(["upper"]); await expect.poll(picked).toEqual(["upper"]);
    await select.selectOption(base); await expect.poll(drawn).toEqual(["lower"]); await expect.poll(picked).toEqual(["lower"]);
    await select.selectOption(""); await expect.poll(drawn).toEqual(["lower", "upper"]);
    await select.selectOption(upper); await expect.poll(drawn).toEqual(["upper"]);
    // The share window must not obstruct the scene editor.
    await host.getByRole("button", { name: "Close session panel", exact: true }).click();
    await assign("upper", base);
    await expect(select).toHaveValue(""); await expect(select.locator("option")).toHaveCount(2);
    await expect.poll(drawn).toEqual(["lower", "upper"]);
  } finally { await pc.close(); await hc.close(); }
});
