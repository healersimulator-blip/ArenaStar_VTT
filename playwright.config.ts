import { defineConfig } from "@playwright/test";

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
        // unreachable (the npm registry alone is enough to get one: `@sparticuz/chromium`).
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
