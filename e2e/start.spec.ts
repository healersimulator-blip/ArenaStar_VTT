/**
 * D-249 — start screen, New-world wizard and starter worlds, driven through the DOM on the
 * plain entry (no `?e2e=1`: Root boots nothing until the GM chooses, and the e2e surface is
 * not installed here — every assertion is what the tester sees).
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { entry } from "./lib";

const RULES_JS = [
  "export default {",
  "  schema: { version: '9.9.9', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
  "  validateOrder() { return { ok: true }; },",
  "  resolveTurn() {},",
  "  detection() { return 5; },",
  "};",
].join("\n");
const RULESET_MANIFEST = {
  id: "probe-rules",
  name: "Probe Rules",
  version: "9.9.9",
  type: "system",
  dependencies: ["probe-core"],
  rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
};
const CONTENT_MANIFEST = {
  id: "probe-core",
  name: "Probe Core",
  version: "1.0.0",
  type: "data",
  packs: [{ name: "lines", type: "tables", file: "packs/lines.json" }],
};
const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
/** `pnpm build:worlds` output — `test:e2e` runs it; a bare `playwright test` must too. */
const starterZip = (): string => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((n) => /^pf1e-mass-battles-starter-.*\.zip$/.test(n));
  if (!name) throw new Error(`no starter world under dist/worlds — run \`pnpm build:worlds\` first`);
  return join(distWorlds, name);
};

const expectHosting = async (page: Page, worldName: string): Promise<void> => {
  await expect(page.locator("#status")).toContainText(worldName, { timeout: 20_000 });
  await expect(page.locator("canvas").first()).toBeVisible();
};

test.describe("start screen (D-249)", () => {
  test("wizard creates a world on the built-in ruleset; Close world lists it; Continue reopens it", async ({
    page,
  }) => {
    await page.goto(entry);
    await expect(page.locator("#role-host")).toHaveText(/Host a world/);
    await expect(page.locator("[data-world-empty]")).toBeVisible();

    await page.click("#new-world");
    const wizard = page.locator("[data-wizard]");
    await expect(wizard).toBeVisible();
    await expect(wizard).toContainText("Scenes start tactical");
    await expect(wizard.locator("#wizard-ruleset-builtin")).toBeChecked();
    await expect(wizard.locator("#wizard-ruleset-package")).toBeDisabled(); // nothing loaded yet
    await wizard.locator("#wizard-name").fill("  Wizard World ");
    await wizard.locator("#wizard-create").click();

    await expectHosting(page, "Wizard World");
    await expect(page.locator("#status [data-rules-status]")).toHaveText(/strategic rules: built-in/);
    await expect(page.locator("[data-world-name]")).toHaveText("Wizard World");

    // the sidebar has no importer any more — Close world leads back to the list
    await expect(page.locator("#import-world")).toHaveCount(0);
    await page.click("#close-world");
    const rows = page.locator("[data-world-list] [data-world-row]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Wizard World");
    await expect(rows.first()).toContainText("built-in strategic rules");
    await expect(page.locator("#role-host")).toHaveText("Continue “Wizard World”");

    await page.click("#role-host");
    await expectHosting(page, "Wizard World");

    // Open from the row too (after closing again)
    await page.click("#close-world");
    await rows.first().locator("[data-world-open]").click();
    await expectHosting(page, "Wizard World");

    // an empty name cannot be created
    await page.click("#close-world");
    await page.click("#new-world");
    await wizard.locator("#wizard-name").fill("   ");
    await expect(wizard.locator("#wizard-create")).toBeDisabled();
    await wizard.locator("#wizard-cancel").click();
    await expect(rows).toHaveCount(1);
  });

  test("wizard with a ruleset file + content pack: dependency hint, misfiled zips sorted, world boots on the package", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "webkit", "WebKit workers cannot import packages (D-086)");
    const dir = join(tmpdir(), `vtt-wizard-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const rulesetPath = join(dir, "probe-rules.zip");
    writeFileSync(rulesetPath, zipOf({ "manifest.json": JSON.stringify(RULESET_MANIFEST), "rules.js": RULES_JS }));
    const contentPath = join(dir, "probe-core.zip");
    writeFileSync(
      contentPath,
      zipOf({ "manifest.json": JSON.stringify(CONTENT_MANIFEST), "packs/lines.json": "[1,2,3]" }),
    );
    try {
      await page.goto(entry);
      await page.click("#new-world");
      const wizard = page.locator("[data-wizard]");
      await wizard.locator("#wizard-name").fill("Probe Campaign");

      // ruleset chosen → package radio selected; its declared companion is missing → hint
      await wizard.locator("#wizard-ruleset-file").setInputFiles(rulesetPath);
      await expect(wizard.locator("[data-wizard-ruleset]")).toHaveText("Probe Rules v9.9.9");
      await expect(wizard.locator("#wizard-ruleset-package")).toBeChecked();
      await expect(wizard.locator("[data-wizard-warning]")).toContainText("probe-core");

      // a content pack dropped into the ruleset slot is sorted, not refused
      await wizard.locator("#wizard-ruleset-file").setInputFiles(contentPath);
      await expect(wizard.locator("[data-wizard-error]")).toContainText("content pack");
      await expect(wizard.locator('[data-wizard-content-row][data-pkg-id="probe-core"]')).toBeVisible();
      await expect(wizard.locator("[data-wizard-ruleset]")).toHaveText("Probe Rules v9.9.9"); // untouched
      await expect(wizard.locator("[data-wizard-warning]")).toHaveCount(0); // companion satisfied

      // remove + re-add through the content slot
      await wizard.locator("[data-wizard-content-remove]").click();
      await expect(wizard.locator("[data-wizard-warning]")).toContainText("probe-core");
      await wizard.locator("#wizard-content-file").setInputFiles([contentPath]);
      await expect(wizard.locator("[data-wizard-content-row]")).toHaveCount(1);
      await expect(wizard.locator("[data-wizard-warning]")).toHaveCount(0);

      await wizard.locator("#wizard-create").click();
      await expectHosting(page, "Probe Campaign");
      await expect(page.locator("#status [data-rules-status]")).toHaveText("strategic rules: probe-rules v9.9.9");
      await expect(page.locator("[data-rules-boot-error]")).toHaveCount(0);

      // Settings shows the pair, active without any Activate/reload step
      await page.click("#gm-settings");
      const settings = page.locator('[data-window="settings"]');
      await expect(settings.locator("[data-pkg-status-ruleset]")).toContainText("Probe Rules v9.9.9 (package)");
      await expect(settings.locator("[data-pkg-status-content]")).toContainText("Probe Core v1.0.0");
      await expect(settings.locator('[data-pkg-row][data-pkg-id="probe-rules"] [data-pkg-active]')).toHaveCount(1);
      await expect(settings.locator('[data-pkg-row][data-pkg-id="probe-core"]')).toContainText("content pack");
      await expect(settings.locator("[data-pkg-missing-deps]")).toHaveCount(0);
      await expect(settings.locator("[data-pkg-reload]")).toHaveCount(0);

      // the ruleset only drives strategic scenes: the first scene is tactical and can be switched
      const scale = settings.locator("[data-scene-scale]");
      await expect(scale).toHaveValue("tactical");
      await scale.selectOption("strategic");
      await expect(scale).toHaveValue("strategic");
      await expect(page.locator("#status [data-rules-status]")).toHaveText("strategic rules: probe-rules v9.9.9");

      await page.click("#close-world");
      const row = page.locator("[data-world-list] [data-world-row]");
      await expect(row).toHaveCount(1);
      await expect(row.first()).toContainText("probe-rules v9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starter world from the build opens as a fresh copy every time, on the PF1e ruleset", async ({ page }) => {
    test.skip(test.info().project.name === "webkit", "WebKit workers cannot import packages (D-086)");
    const zipPath = starterZip();
    await page.goto(entry);

    await page.setInputFiles("#role-import", zipPath);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    await expect(dialog).toContainText("Starter world");
    await expect(dialog.locator("[data-open-contents]")).toContainText(
      "strategic ruleset Pathfinder 1e Mass Battles Engine v1.0.0 · content pack Pathfinder 1e Core",
    );
    await expect(dialog.locator("[data-open-replace]")).toHaveCount(0); // a template is never restored
    await expect(dialog.locator("#open-copy-name")).toHaveValue("Pathfinder 1e Mass Battles");
    await dialog.locator("[data-open-copy]").click();

    await expectHosting(page, "Pathfinder 1e Mass Battles");
    await expect(page.locator("#status [data-rules-status]")).toHaveText("strategic rules: pf1e-mass-battles v1.0.0");
    await expect(page.locator("[data-rules-boot-error]")).toHaveCount(0);
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings.locator("[data-pkg-status-content]")).toContainText("Pathfinder 1e Core v1.0.0");
    await expect(settings.locator("[data-scene-scale]")).toHaveValue("tactical"); // heroes-only scene by default

    // second import: another world, the template id never lands
    await page.click("#close-world");
    const rows = page.locator("[data-world-list] [data-world-row]");
    await expect(rows).toHaveCount(1);
    await page.setInputFiles("#role-import", zipPath);
    await dialog.locator("#open-copy-name").fill("Second Front");
    await dialog.locator("[data-open-copy]").click();
    await expectHosting(page, "Second Front");
    await page.click("#close-world");
    await expect(rows).toHaveCount(2);
    for (const id of await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-world-id")))) {
      expect(id).toMatch(/^w-/);
    }
  });
});
