import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * D-480: a Chromium installed from the npm registry (`scripts/e2e/installHeadlessChromium.mjs`,
 * for sandboxes that cannot reach cdn.playwright.dev) lives in Playwright's own browsers folder
 * but needs its bundled shared libraries and fonts. Playwright's download has neither directory,
 * so detecting them is exact; the variables are set here so every runner and worker inherits them.
 */
function adoptRegistryChromium(): void {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return;
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const root = configured && configured !== "0" ? configured : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium_headless_shell-")) continue;
    const lib = join(root, entry, "al2023", "lib");
    const fonts = join(root, entry, "fonts");
    if (!existsSync(lib) || !existsSync(join(fonts, "fonts.conf"))) continue;
    if (!(process.env.LD_LIBRARY_PATH ?? "").split(":").includes(lib)) {
      process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    }
    process.env.FONTCONFIG_PATH ??= fonts;
    return;
  }
}
adoptRegistryChromium();

/**
 * §14 e2e scenarios run against the built single-file deliverable.
 * Tests navigate the file:// URL of dist/index.html directly (no server needed),
 * which doubles as the §15 "must boot from file://" check. `test:e2e` builds first.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  // Chromium is the default chain target (D-078); firefox/webkit are the
  // cross-browser acceptance runs (§19 M2) — invoke explicitly via
  // `--project=firefox` / `--project=webkit` (browsers under /opt/pw-browsers).
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // An optional local/system binary for environments where cdn.playwright.dev is
        // unreachable (the npm registry alone is enough to get one: `@sparticuz/chromium`;
        // `node scripts/e2e/installHeadlessChromium.mjs` lays it out where no override is needed).
        // CI keeps using Playwright's pinned Chromium, and nothing is relaxed unless asked for:
        // PLAYWRIGHT_CHROMIUM_NO_SANDBOX=1 is the escape hatch for containers where the Chromium
        // sandbox cannot start at all (no user namespaces), which is never set in CI.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? {
              executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
              ...(process.env.PLAYWRIGHT_CHROMIUM_NO_SANDBOX === "1"
                ? { chromiumSandbox: false }
                : {}),
            }
          : {},
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  // Standard e2e viewport: tall enough that the whole GM sidebar (incl. the
  // tab panels) is on-screen — avoids scroll-container actionability fights
  // in headless and keeps specs deterministic (D-078).
  use: { viewport: { width: 1280, height: 960 } },
});
