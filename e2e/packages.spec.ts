import { expect, test, type Browser, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entry } from "./lib";

/**
 * §12 package loader e2e: import a package ZIP through the GM UI
 * (manifest.json + single-entry rules module), activate it world-scoped,
 * reload — the SimWorker imports the entry from a blob URL (D-086) — and a
 * full campaign turn resolves under the PACKAGE's rules with its
 * rulesVersion stamped on the TurnReport.
 */

const RULES_JS = [
  "export default {",
  "  schema: { version: '9.9.9', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move', 'hold'], subPhases: ['move'] },",
  "  validateOrder() { return { ok: true }; },",
  "  resolveTurn(ctx, pool, units, orders, rng, emit) {",
  "    const ordered = [...units].sort((a, b) => (a.id < b.id ? -1 : 1));",
  "    for (const unit of ordered) {",
  "      const q = orders.get(unit.id);",
  "      const order = q ? (q.active ?? q.pending[0]) : null;",
  "      if (!order || order.kind !== 'move') continue;",
  "      emit({ subPhase: 'move', type: 'pkg-move', unitId: unit.id, text: unit.name + ' executes package movement' });",
  "    }",
  "  },",
  "  detection() { return 5; },",
  "};",
].join("\n");

const SYSTEM_MANIFEST = {
  id: "probe-rules",
  name: "Probe Rules",
  version: "9.9.9",
  type: "system",
  rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
};

const DATA_MANIFEST = {
  id: "tables-pkg",
  name: "Tables Pack",
  version: "1.0.0",
  type: "data",
  packs: [{ name: "lines", type: "tables", file: "packs/lines.json" }],
};

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** Boot (worker + §12 package gate) can outlast page load — wait for it. */
const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const app = (globalThis as { __vttE2E?: { app?: { rulesBoot: () => unknown } } }).__vttE2E
          ?.app;
        return typeof app?.rulesBoot === "function";
      }),
    )
    .toBe(true);

const gmCallArg = <T>(page: Page, method: string, arg: unknown): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as {
          __vttE2E?: { gm?: Record<string, (...x: unknown[]) => T> };
        }
      ).__vttE2E;
      const fn = surface?.gm?.[m];
      if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
      return fn(a);
    },
    { m: method, a: arg },
  );

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { gm?: Record<string, () => T> } }).__vttE2E;
    const fn = surface?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn();
  }, method);

const appCall = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as {
          __vttE2E?: { app?: Record<string, (...x: unknown[]) => T> };
        }
      ).__vttE2E;
      const fn = surface?.app?.[m];
      if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
      return fn(...a);
    },
    { m: method, a: args },
  );

test.describe("Package loader (§12)", () => {
  test("zip import via GM UI, activation persists across reload, campaign runs the package", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);

    const dir = join(tmpdir(), `vtt-pkg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, "probe-rules.zip");
    writeFileSync(
      zipPath,
      zipOf({ "manifest.json": JSON.stringify(SYSTEM_MANIFEST), "rules.js": RULES_JS }),
    );

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      // boots on built-in rules
      expect((await appCall<Record<string, string>>(page, "rulesBoot")).source).toBe("builtin");

      // ── GM UI: import the package zip through the file input ────────────
      await page.click("#gm-extras");
      const win = page.locator('[data-window="gmextras"]');
      await expect(win).toBeVisible();
      await page.setInputFiles("#pkg-file", zipPath);
      const row = win.locator('[data-pkg-row][data-pkg-id="probe-rules"]');
      await expect(row).toBeVisible();
      await expect(win.locator("[data-pkg-active]")).toHaveCount(0);

      // ── API negatives: not-a-zip rejected; data-only cannot activate ────
      const bad = await appCall<{ ok: boolean; error?: string }>(
        page,
        "importPackageZip",
        [1, 2, 3, 4],
      );
      expect(bad.ok).toBe(false);
      const dataZip = Array.from(
        zipOf({ "manifest.json": JSON.stringify(DATA_MANIFEST), "packs/lines.json": "[1,2,3]" }),
      );
      const dataRes = await appCall<{ ok: boolean; error?: string }>(
        page,
        "importPackageZip",
        dataZip,
      );
      expect(dataRes.ok).toBe(true);
      const list = await appCall<Array<{ id: string; type: string; active: boolean }>>(
        page,
        "packages",
      );
      expect(list.map((p) => p.id).sort()).toEqual(["probe-rules", "tables-pkg"]);
      const dataActivate = await appCall<{ ok: boolean; error?: string }>(
        page,
        "activatePackage",
        "tables-pkg",
      );
      expect(dataActivate.ok).toBe(false);
      if (!dataActivate.ok) expect(dataActivate.error).toContain("data-only");

      // ── activate the system package through the panel button ────────────
      await row.locator("[data-pkg-activate]").click();
      await expect(row.locator("[data-pkg-active]")).toHaveCount(1);

      // ── reload: the world boots with the package (worker blob import) ───
      await page.reload();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = (
              globalThis as { __vttE2E?: { app?: { rulesBoot: () => Record<string, string> } } }
            ).__vttE2E?.app;
            return app ? app.rulesBoot() : null;
          }),
        )
        .toEqual({ source: "package", packageId: "probe-rules", version: "9.9.9", error: null });

      // ── campaign under package rules ─────────────────────────────────────
      await page.click("#gm-extras");
      await expect(win).toBeVisible();
      await page.fill("#faction-name", "Probes");
      await page.click("#faction-create");
      await expect
        .poll(() => gmCall<Record<string, number>>(page, "armySnapshot").then((s) => s.factions))
        .toBe(1);
      await win.locator("[data-spawn-faction]").selectOption({ index: 0 });
      await page.fill("[data-spawn-name]", "Probe Host");
      await page.fill("[data-spawn-count]", "100");
      await page.click("#mass-spawn");
      await expect
        .poll(() => gmCall<Record<string, number>>(page, "armySnapshot").then((s) => s.armies))
        .toBe(1);

      await expect(win.locator("#campaign-start")).toBeEnabled();
      await page.click("#campaign-start");
      await expect.poll(() => gmCall<number>(page, "simCount")).toBe(100);
      await expect.poll(() => gmCall<string>(page, "turnPhase")).toBe("orders");

      // one move order so the package's resolveTurn emits
      await win.locator("[data-unit-check]").first().check();
      await win.locator("[data-batch-template]").first().click();
      await expect
        .poll(() =>
          gmCall<Record<string, number>>(page, "armySnapshot").then((s) => s.pendingOrders),
        )
        .toBeGreaterThanOrEqual(1);

      await page.click("[data-campaign-advance]");
      await expect
        .poll(() => gmCall<string>(page, "turnPhase"), { timeout: 30_000 })
        .toBe("report");

      // §12 proof: the report is stamped with the PACKAGE's rulesVersion and
      // carries its custom event type
      await expect.poll(() => gmCall<string>(page, "reportRulesVersion")).toBe("9.9.9");
      const byType = await gmCall<Record<string, number>>(page, "reportByType");
      expect(byType.pkgMove ?? byType["pkg-move"] ?? 0).toBeGreaterThanOrEqual(1);

      // ── pinned-per-campaign guard once checkpoints exist ─────────────────
      const reActivate = await appCall<{ ok: boolean; error?: string }>(
        page,
        "activatePackage",
        "probe-rules",
      );
      expect(reActivate.ok).toBe(false);
      if (!reActivate.ok) expect(reActivate.error).toContain("campaign already started");
      const deactivate = await appCall<{ ok: boolean; error?: string }>(page, "deactivatePackage");
      expect(deactivate.ok).toBe(false);
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sandboxed iframe module API: game/Hooks/canvas.tokens/ChatMessage/ui.notifications/settings", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);

    const RULES_JS = [
      "export default {",
      "  schema: { version: '1.0.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
      "  validateOrder() { return { ok: true }; },",
      "  resolveTurn() {},",
      "  detection() { return 5; },",
      "};",
    ].join("\n");
    const MODULE_JS = [
      "var localStorageBlocked = false;",
      "try { window.localStorage.setItem('x', '1'); } catch (e) { localStorageBlocked = true; }",
      "var parentBlocked = false;",
      "try { void window.parent.document.title; } catch (e) { parentBlocked = true; }",
      "Hooks.on('ready', function () {",
      "  game.info().then(function (info) {",
      "    return game.settings.set('probe', { localStorageBlocked: localStorageBlocked, parentBlocked: parentBlocked, world: info.worldId, pkg: info.packageId });",
      "  }).then(function () { ui.notifications.notify('module ready', 'info'); })",
      "  .catch(function (e) { ui.notifications.notify('module error ' + e.message, 'error'); });",
      "});",
      "var moved = false;",
      "Hooks.on('snapshot', function () {",
      "  if (moved) return;",
      "  canvas.tokens.list().then(function (res) {",
      "    if (!res.tokens || res.tokens.length === 0) return;",
      "    moved = true;",
      "    var t = res.tokens[0];",
      "    canvas.tokens.move(t.id, t.x + 120, t.y + 40).then(function () {",
      "      return ChatMessage.create({ content: 'module moved ' + t.name, flavor: 'module' });",
      "    }).then(function () { ui.notifications.notify('module moved ' + t.name, 'info'); })",
      "    .catch(function (e) { ui.notifications.notify('module rpc failed ' + e.message, 'error'); });",
      "  });",
      "});",
      "Hooks.on('turnPhase', function (p) { ui.notifications.notify('phase:' + p.phase, 'info'); });",
    ].join("\n");
    const MANIFEST = {
      id: "module-probe",
      name: "Module Probe",
      version: "1.0.0",
      type: "system",
      rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
      module: { entry: "module.js" },
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      const zip = Array.from(
        zipOf({
          "manifest.json": JSON.stringify(MANIFEST),
          "rules.js": RULES_JS,
          "module.js": MODULE_JS,
        }),
      );
      const imported = await appCall<{ ok: boolean; error?: string }>(
        page,
        "importPackageZip",
        zip,
      );
      expect(imported.ok).toBe(true);
      const activated = await appCall<{ ok: boolean; error?: string }>(
        page,
        "activatePackage",
        "module-probe",
      );
      expect(activated.ok).toBe(true);

      // reload: package rules gate + module iframe boot
      await page.reload();
      await waitForApp(page);

      // module booted, ran its ready hook and stored its sandbox probes
      await expect
        .poll(() =>
          gmCall<Array<{ message: string }>>(page, "notifications").then((n) =>
            n.some((x) => x.message === "module ready"),
          ),
        )
        .toBe(true);
      const probe = await gmCallArg<{
        localStorageBlocked: boolean;
        parentBlocked: boolean;
        pkg: string;
      }>(page, "moduleSetting", "probe");
      expect(probe).toMatchObject({
        localStorageBlocked: true,
        parentBlocked: true,
        pkg: "module-probe",
      });

      // tokens intent: add a token (default scene center 1000/750), the
      // module moves it +120/+40 via RPC on the ops hook — the module may win
      // the race with our first read, so assert the ABSOLUTE final position
      await page.click("#add-token");
      await expect
        .poll(() => appCall<{ x: number; y: number } | null>(page, "tokenPos"))
        .toEqual({ x: 1120, y: 790 });
      await expect
        .poll(() =>
          gmCall<Array<{ message: string }>>(page, "notifications").then((n) =>
            n.some((x) => x.message === "module moved Token 1"),
          ),
        )
        .toBe(true);

      // ChatMessage.create landed a real message document in the store
      await expect(page.getByText("module moved Token 1").first()).toBeVisible({ timeout: 10_000 });

      // notifications render in the DOM toast stack
      await expect(page.locator("[data-notify]").first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("trusted in-page execution opt-in: ungranted stays in the iframe; GM grant promotes; revoke demotes", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);

    // one module source, two tiers: it probes its OWN realm and reports it
    const RULES_JS = [
      "export default {",
      "  schema: { version: '1.0.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
      "  validateOrder() { return { ok: true }; },",
      "  resolveTurn() {},",
      "  detection() { return 5; },",
      "};",
    ].join("\n");
    const MODULE_JS = [
      "function probe() {",
      "  var inPage = window.parent === window;",
      "  var hasLocalStorage = true;",
      "  try { window.localStorage.setItem('vtt-trust-probe', '1'); } catch (e) { hasLocalStorage = false; }",
      "  return { inPage: inPage, hasLocalStorage: hasLocalStorage };",
      "}",
      "Hooks.on('ready', function () {",
      "  game.settings.set('tier', probe()).then(function () {",
      "    return game.info();",
      "  }).then(function (info) {",
      "    ui.notifications.notify('module ready ' + (probe().inPage ? 'inPage' : 'iframe') + ' ' + info.packageId, 'info');",
      "  }).catch(function (e) { ui.notifications.notify('module error ' + e.message, 'error'); });",
      "});",
    ].join("\n");
    const MANIFEST = {
      id: "trust-probe",
      name: "Trust Probe",
      version: "1.0.0",
      type: "system",
      rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
      module: { entry: "module.js", trusted: true },
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      const zip = Array.from(
        zipOf({
          "manifest.json": JSON.stringify(MANIFEST),
          "rules.js": RULES_JS,
          "module.js": MODULE_JS,
        }),
      );
      expect(
        (await appCall<{ ok: boolean; error?: string }>(page, "importPackageZip", zip)).ok,
      ).toBe(true);

      // activate via API, then use the panel: the package shows its request
      expect(
        (await appCall<{ ok: boolean; error?: string }>(page, "activatePackage", "trust-probe")).ok,
      ).toBe(true);
      await page.click("#gm-extras");
      const win = page.locator('[data-window="gmextras"]');
      await expect(win).toBeVisible();
      const row = win.locator('[data-pkg-row][data-pkg-id="trust-probe"]');
      await expect(row.locator("[data-pkg-trust-requested]")).toBeVisible();

      // reload WITHOUT granting: module runs in the sandboxed iframe tier
      await page.reload();
      await waitForApp(page);
      await expect.poll(() => gmCall<string>(page, "moduleMode")).toBe("iframe");
      await expect
        .poll(() =>
          gmCall<Array<{ message: string }>>(page, "notifications").then((n) =>
            n.some((x) => x.message === "module ready iframe trust-probe"),
          ),
        )
        .toBe(true);
      const sandboxTier = await gmCallArg<{ inPage: boolean; hasLocalStorage: boolean }>(
        page,
        "moduleSetting",
        "tier",
      );
      expect(sandboxTier).toEqual({ inPage: false, hasLocalStorage: false });

      // grant through the two-step panel consent
      await page.click("#gm-extras");
      await expect(win).toBeVisible();
      const grantBtn = row.locator("[data-trust-grant]");
      await grantBtn.click(); // arms
      await expect(grantBtn).toHaveText("Confirm grant?");
      await grantBtn.click(); // confirms
      await expect(row.locator("[data-pkg-trusted]")).toBeVisible();

      // reload: the SAME module source now runs in-page
      await page.reload();
      await waitForApp(page);
      await expect.poll(() => gmCall<string>(page, "moduleMode")).toBe("inPage");
      await expect
        .poll(() =>
          gmCall<Array<{ message: string }>>(page, "notifications").then((n) =>
            n.some((x) => x.message === "module ready inPage trust-probe"),
          ),
        )
        .toBe(true);
      const trustedTier = await gmCallArg<{ inPage: boolean; hasLocalStorage: boolean }>(
        page,
        "moduleSetting",
        "tier",
      );
      expect(trustedTier).toEqual({ inPage: true, hasLocalStorage: true });

      // revoke: back to the sandboxed tier after reload
      await page.click("#gm-extras");
      await expect(win).toBeVisible();
      await row.locator("[data-trust-revoke]").click();
      await expect(row.locator("[data-pkg-trust-requested]")).toBeVisible();
      await page.reload();
      await waitForApp(page);
      await expect.poll(() => gmCall<string>(page, "moduleMode")).toBe("iframe");
    } finally {
      await ctx.close();
    }
  });

  test("compendia: read-only packs indexed, searchable, import + drag import", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(120_000);

    const MANIFEST = {
      id: "monster-bestiary",
      name: "Monster Bestiary",
      version: "1.0.0",
      type: "data",
      packs: [
        { name: "monsters", type: "actors", file: "packs/monsters.json" },
        { name: "encounters", type: "rollTables", file: "packs/encounters.json" },
      ],
    };
    const MONSTERS = {
      name: "monsters",
      type: "actors",
      entries: [
        {
          id: "goblin-warrior",
          name: "Goblin Warrior",
          keywords: ["goblin", "humanoid"],
          img: "",
          data: {
            type: "actor",
            name: "Goblin Warrior",
            system: { hp: 7 },
            items: [],
            effects: [],
          },
        },
        {
          id: "goblin-shaman",
          name: "Goblin Shaman",
          keywords: ["goblin", "caster"],
          data: { type: "actor", name: "Goblin Shaman", system: { hp: 5 }, items: [], effects: [] },
        },
        {
          id: "dire-wolf",
          name: "Dire Wolf",
          keywords: ["beast"],
          data: { type: "actor", name: "Dire Wolf", system: { hp: 22 }, items: [], effects: [] },
        },
      ],
    };
    const ENCOUNTERS = {
      name: "encounters",
      type: "rollTables",
      entries: [
        {
          id: "road-ambush",
          name: "Road Ambush",
          data: {
            type: "rollTable",
            name: "Road Ambush",
            formula: "1d6",
            results: [],
          },
        },
      ],
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      const zip = Array.from(
        zipOf({
          "manifest.json": JSON.stringify(MANIFEST),
          "packs/monsters.json": JSON.stringify(MONSTERS),
          "packs/encounters.json": JSON.stringify(ENCOUNTERS),
        }),
      );
      const imported = await appCall<{ ok: boolean; error?: string }>(
        page,
        "importPackageZip",
        zip,
      );
      expect(imported.ok).toBe(true);

      // open the compendia tab: both packs indexed with all entries
      await page.click('[data-tab="compendia"]');
      await expect
        .poll(() => gmCall<{ packs: number; entries: number }>(page, "compendiumStats"))
        .toEqual({ packs: 2, entries: 4 });
      await expect(page.locator("[data-entry-id]")).toHaveCount(4);

      // search "gob" — ranked filter to the two goblins
      await page.fill("#compendium-search", "gob");
      await expect(page.locator("[data-entry-id]")).toHaveCount(2);
      await expect(page.locator('[data-entry-id="goblin-warrior"]')).toBeVisible();
      // keyword search: "beast" finds the wolf via keywords
      await page.fill("#compendium-search", "beast");
      await expect(page.locator("[data-entry-id]")).toHaveCount(1);
      await expect(page.locator('[data-entry-id="dire-wolf"]')).toBeVisible();

      // import button → world-owned actor copy via create op
      await page.fill("#compendium-search", "goblin shaman");
      await page.locator('[data-entry-id="goblin-shaman"] [data-entry-import]').click();
      await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(1);

      // drag import onto the canvas → actor copy + linked token at the drop
      await page.fill("#compendium-search", "");
      const before = await appCall<number>(page, "tokenCount");
      await page.locator('[data-entry-id="goblin-warrior"]').dragTo(page.locator(".canvas-host"));
      await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(2);
      await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(before + 1);
      const dropped = await gmCall<{ name: string; actorId: string; img: string }[]>(
        page,
        "importedTokens",
      );
      expect(dropped.at(-1)?.name).toBe("Goblin Warrior");
      expect(dropped.at(-1)?.actorId).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  test("schema migrations run on world load when the system package is upgraded", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);

    const RULES_V1 = [
      "export default {",
      "  schema: { version: '1.0.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
      "  validateOrder() { return { ok: true }; },",
      "  resolveTurn() {},",
      "  detection() { return 5; },",
      "};",
    ].join("\n");
    const RULES_V2 = RULES_V1.replace("'1.0.0'", "'1.1.0'");
    const MANIFEST_V1 = {
      id: "evolving-rules",
      name: "Evolving Rules",
      version: "1.0.0",
      type: "system",
      rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
    };
    const MANIFEST_V2 = {
      ...MANIFEST_V1,
      version: "1.1.0",
      migrations: [
        {
          from: "1.0.0",
          to: "1.1.0",
          transforms: {
            army: [
              { op: "default", path: "units.*.stats.drill", value: 1 },
              { op: "set", path: "system.schemaNote", value: "v1.1" },
            ],
          },
        },
      ],
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      // v1 active; no migrations recorded; world version baseline 1.0.0
      const zipV1 = Array.from(
        zipOf({ "manifest.json": JSON.stringify(MANIFEST_V1), "rules.js": RULES_V1 }),
      );
      expect((await appCall<{ ok: boolean }>(page, "importPackageZip", zipV1)).ok).toBe(true);
      expect((await appCall<{ ok: boolean }>(page, "activatePackage", "evolving-rules")).ok).toBe(
        true,
      );
      await page.reload();
      await waitForApp(page);
      expect(
        (await appCall<unknown | null>(page, "migrationBoot")) as { from: string } | null,
      ).toBeNull();

      // create an army with a unit in the OLD format (no stats.drill)
      await page.click("#gm-extras");
      const win = page.locator('[data-window="gmextras"]');
      await expect(win).toBeVisible();
      await page.fill("#faction-name", "Migrate");
      await page.click("#faction-create");
      await expect
        .poll(() => gmCall<Record<string, number>>(page, "armySnapshot").then((s) => s.factions))
        .toBe(1);
      await win.locator("[data-spawn-faction]").selectOption({ index: 0 });
      await page.fill("[data-spawn-name]", "Old Host");
      await page.fill("[data-spawn-count]", "10");
      await page.click("#mass-spawn");
      await expect
        .poll(() => gmCall<Record<string, number>>(page, "armySnapshot").then((s) => s.armies))
        .toBe(1);
      const before = await gmCall<{ schemaNote: unknown; drill: unknown } | null>(
        page,
        "firstArmyProbe",
      );
      expect(before).toEqual({ schemaNote: null, drill: null });

      // upgrade: import v1.1.0 (same id) with a declarative migration, reload
      const zipV2 = Array.from(
        zipOf({ "manifest.json": JSON.stringify(MANIFEST_V2), "rules.js": RULES_V2 }),
      );
      expect((await appCall<{ ok: boolean }>(page, "importPackageZip", zipV2)).ok).toBe(true);
      await page.reload();
      await waitForApp(page);

      // §12: migration ran on load — record + documents upgraded
      const boot = await appCall<{
        systemId: string;
        from: string;
        to: string;
        applied: string[];
        changedDocs: number;
        error: string | null;
      } | null>(page, "migrationBoot");
      expect(boot).toEqual({
        systemId: "evolving-rules",
        from: "1.0.0",
        to: "1.1.0",
        applied: ["1.0.0→1.1.0"],
        changedDocs: expect.any(Number),
        error: null,
      });
      if (boot) expect(boot.changedDocs).toBeGreaterThanOrEqual(1);
      const after = await gmCall<{ schemaNote: unknown; drill: unknown } | null>(
        page,
        "firstArmyProbe",
      );
      expect(after).toEqual({ schemaNote: "v1.1", drill: 1 });

      // second reload: versions current → no migration
      await page.reload();
      await waitForApp(page);
      expect(
        (await appCall<unknown | null>(page, "migrationBoot")) as { from: string } | null,
      ).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
