import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https, { type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const preview = new URL("../dist/ui-demo.html", import.meta.url).href;
let server: Server, tls: string, served: string;
test.use({ ignoreHTTPSErrors: true });
test.beforeAll(async () => {
  tls = mkdtempSync(join(tmpdir(), "ui-adapters-tls-"));
  const key = join(tls, "key.pem"), cert = join(tls, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key,
    "-out", cert, "-subj", "/CN=localhost"], { stdio: "ignore" });
  const html = readFileSync(fileURLToPath(preview));
  server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  served = `https://localhost:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tls) rmSync(tls, { recursive: true, force: true });
});

async function choose(page: Page, id: string) {
  const panel = page.locator("[data-appearance-panel]");
  await panel.locator(`[data-theme-activate="${id}"]`).click();
  const confirm = panel.locator("[data-theme-confirm]");
  await expect.poll(async () => (await confirm.count()) > 0 ||
    (await page.locator("main.gm-app").getAttribute("data-ais-theme")) === id, { timeout: 10_000 }).toBe(true);
  if (await confirm.count()) {
    await expect(confirm).toBeDisabled();
    await panel.locator("[data-theme-consent]").check();
    await confirm.click();
  }
  await expect(page.locator("main.gm-app")).toHaveAttribute("data-ais-theme", id, { timeout: 15_000 });
  await expect(panel.locator("[data-appearance-error]")).toHaveCount(0);
}
const accent = (page: Page) => page.locator("main.gm-app").evaluate((node) => getComputedStyle(node).getPropertyValue("--vtt-accent").trim());

for (const origin of ["file", "https"] as const) {
  test(`${origin}: preview opens its own world and connects all three UI appearance profiles`, async ({ page }) => {
    test.setTimeout(100_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // NO file picker, no downloaded ZIP, no test auto-host flag. This is the user's route.
    await page.goto(origin === "file" ? preview : served);
    await expect(page.locator("#status")).toContainText("tokens 3", { timeout: 25_000 });
    await expect(page.locator(".canvas-host canvas")).toBeVisible();
    const panel = page.locator("[data-appearance-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-theme-card]")).toHaveCount(3);
    await expect(page.locator('iframe[title^="AIS module:"]')).toHaveCount(0); // no imported approvals

    await choose(page, "foundry-ui-your-flavor");
    await expect(panel.locator("[data-theme-evidence]")).toContainText("Original Your Flavor token engine");
    expect(await accent(page)).toBe("#d4872c");
    await panel.locator('[data-theme-variant="foundry-ui-your-flavor"]').selectOption("ocean-depths");
    await expect.poll(() => accent(page)).toBe("#2196f3");

    await choose(page, "foundry-ui-crlngn-ui");
    await expect(panel.locator("[data-theme-evidence]")).toContainText("Original Carolingian CSS cascade");
    expect(await accent(page)).toBe("#4493ad");
    await panel.locator('[data-theme-variant="foundry-ui-crlngn-ui"]').selectOption("crlngn-theme-grass-stone");
    await expect.poll(() => accent(page)).not.toBe("#4493ad");

    await choose(page, "foundry-ui-rpg-styled-ui");
    await expect(panel.locator("[data-theme-evidence]")).toContainText("5 settings registered, compact-mode=true");
    await expect.poll(() => page.locator("main.gm-app").evaluate((node) => getComputedStyle(node).getPropertyValue("--vtt-theme-panel-image"))).toContain("blob:");
    await panel.locator("[data-appearance-density]").selectOption("comfortable");
    await expect(panel.locator("[data-theme-evidence]")).toContainText("compact-mode=false");
    await expect(page.locator("main.gm-app")).toHaveAttribute("data-ui-density", "comfortable");
    await panel.locator("[data-appearance-density]").selectOption("compact");
    await expect(page.locator("main.gm-app")).toHaveAttribute("data-ui-density", "compact");
    await panel.getByRole("button", { name: "Close interface selector" }).click();
    // Density changes restyle controls; the command bar keeps its own height (D-464 workspace chrome).
    expect((await page.locator(".app-header").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `test-results/ui-${origin}-rpg.png` });

    await page.reload();
    await expect(page.locator("#status")).toContainText("tokens 3", { timeout: 20_000 });
    await expect(page.locator("main.gm-app")).toHaveAttribute("data-ais-theme", "foundry-ui-rpg-styled-ui", { timeout: 15_000 });
    await expect(panel).toHaveCount(0); // return to play, not an import or setup loop
    await page.locator("#gm-appearance").click();
    await panel.locator("[data-appearance-reset]").click();
    await expect(page.locator("main.gm-app")).not.toHaveAttribute("data-ais-theme");
    await choose(page, "foundry-ui-your-flavor"); // retained exact consent; no re-import/reload
    await panel.getByRole("button", { name: "Close interface selector" }).click();
    await page.keyboard.press("Control+Alt+0");
    await expect(page.locator("main.gm-app")).not.toHaveAttribute("data-ais-theme");
    expect(errors).toEqual([]);
  });
}

test("theme revocation removes styling, the selector traps focus, and world copies require fresh consent", async ({ page, browser }) => {
  test.setTimeout(100_000);
  await page.goto(served);
  await expect(page.locator("[data-appearance-panel]")).toBeVisible({ timeout: 20_000 });
  await choose(page, "foundry-ui-rpg-styled-ui");
  const panel = page.locator("[data-appearance-panel]");
  for (let i = 0; i < 15; i++) await page.keyboard.press("Tab");
  expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.locator("#gm-settings").click();
  await page.locator('[data-ais-module-review="ais-foundry-ui"] [data-ais-revoke]').click();
  await expect(page.locator("main.gm-app")).not.toHaveAttribute("data-ais-theme");
  await expect.poll(() => page.locator("main.gm-app").evaluate((node) => getComputedStyle(node).getPropertyValue("--vtt-theme-panel-image"))).toBe("");
  await page.locator('[data-window="settings"] [data-window-close]').click();
  await page.locator("#gm-appearance").click();
  await choose(page, "foundry-ui-your-flavor");
  await page.keyboard.press("Escape");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-world").click()]);
  const path = await download.path();
  if (!path) throw new Error("No exported world");
  const context = await browser.newContext();
  try {
    const copy = await context.newPage();
    await copy.goto(new URL("../dist/index.html", import.meta.url).href);
    await copy.locator("#role-import").setInputFiles(path);
    await copy.locator("[data-open-copy]").click();
    await expect(copy.locator("#status")).toContainText("tokens 3", { timeout: 20_000 });
    await expect(copy.locator('iframe[title^="AIS module:"]')).toHaveCount(0);
    await expect(copy.locator("main.gm-app")).not.toHaveAttribute("data-ais-theme");
    await copy.locator("#gm-appearance").click();
    await expect(copy.locator("[data-theme-card]")).toHaveCount(3);
    await choose(copy, "foundry-ui-your-flavor");
    expect(await accent(copy)).toBe("#d4872c");
  } finally { await context.close(); }
});
