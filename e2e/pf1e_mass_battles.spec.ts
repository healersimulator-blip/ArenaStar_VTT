import { expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entry } from "./lib";

/**
 * §1.8 / §12 — the PF1e packages, in the browser, from the shipped artifacts.
 *
 * This spec used to assert `{ok:true, hits:15}` from a `page.evaluate` that computed nothing: the
 * "10,000-model battle" it claimed to run never reached the sim. Two things replaced that:
 *
 *  • the scale and fidelity gate (10k models, 24 measured turns, pool/wire/determinism budgets and
 *    the turn-cost measurement) now runs in `tests/packages/pf1eMassBattleScale.test.ts`, against
 *    the same runner code the SimWorker uses. It lives there because it has to run *everywhere* —
 *    no browser binaries — and its budgets must not depend on the machine CI happens to use.
 *  • what only a browser can prove lives here: the built `rules.js` bundle (an IIFE exposing one
 *    `export default`) imports in a real Worker, activates world-scoped, and takes over the SimWorker
 *    rules slot, while the data package's compendia appear in the host.
 *
 * It reads `dist/packages/*.zip`, i.e. exactly what a GM would drop into the importer, so the gate
 * covers the artifact that ships rather than a fixture assembled for the test.
 */

const distPackages = fileURLToPath(
  new URL("../dist/packages", import.meta.url),
);
const pkgPath = (name: string): string => join(distPackages, name);
const DIST_ZIPS = ["pf1e-core-1.0.0.zip", "pf1e-mass-battles-1.0.0.zip"];

const appCall = <T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as {
          __vttE2E?: { app?: Record<string, (...x: unknown[]) => T> };
        }
      ).__vttE2E;
      const fn = surface?.app?.[m];
      if (typeof fn !== "function")
        throw new Error(`app surface missing: ${m}`);
      return fn(...a);
    },
    { m: method, a: args },
  );

const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const app = (
          globalThis as { __vttE2E?: { app?: { rulesBoot: () => unknown } } }
        ).__vttE2E?.app;
        return typeof app?.rulesBoot === "function";
      }),
    )
    .toBe(true);

interface PackageRow {
  id: string;
  name: string;
  version: string;
  type: string;
  packCount: number;
  active: boolean;
}

test.describe("Pathfinder 1e packages (§1.8 browser half)", () => {
  test("shipped zips import, activate the SimWorker rules slot, and unload cleanly", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);

    for (const zip of DIST_ZIPS) {
      if (!existsSync(pkgPath(zip))) {
        throw new Error(
          `${zip} missing — run \`pnpm build:systems\` before \`pnpm test:e2e\``,
        );
      }
    }

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e.message ?? e)));
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      // The app boots on built-in rules and with no packages installed.
      expect(
        (await appCall<Record<string, string>>(page, "rulesBoot")).source,
      ).toBe("builtin");
      expect(await appCall<PackageRow[]>(page, "packages")).toEqual([]);

      for (const zip of DIST_ZIPS) {
        const bytes = Array.from(readFileSync(pkgPath(zip)));
        const imported = await appCall<{ ok: boolean; error?: string }>(
          page,
          "importPackageZip",
          bytes,
        );
        expect(imported, `${zip} import: ${imported.error ?? ""}`).toEqual({
          ok: true,
        });
      }

      const rows = await appCall<PackageRow[]>(page, "packages");
      expect(rows.map((r) => r.id).sort()).toEqual([
        "pf1e-core",
        "pf1e-mass-battles",
      ]);
      const core = rows.find((r) => r.id === "pf1e-core") as PackageRow;
      expect(core.type).toBe("data");
      expect(core.packCount).toBe(2); // spells + bestiary
      expect(rows.find((r) => r.id === "pf1e-mass-battles")?.type).toBe(
        "system",
      );

      // A data package cannot take the rules slot (it has no rules.js to import).
      const dataOnly = await appCall<{ ok: boolean; error?: string }>(
        page,
        "activatePackage",
        "pf1e-core",
      );
      expect(dataOnly.ok).toBe(false);
      expect(dataOnly.error).toContain("data-only");

      // …and the system package can: its bundle is imported by the SimWorker from a blob URL.
      const activated = await appCall<{ ok: boolean; error?: string }>(
        page,
        "activatePackage",
        "pf1e-mass-battles",
      );
      expect(activated, activated.error ?? "").toEqual({ ok: true });

      const boot = await appCall<{
        source: string;
        packageId: string | null;
        version: string;
        error: string | null;
      }>(page, "rulesBoot");
      expect(boot).toEqual({
        source: "package",
        packageId: "pf1e-mass-battles",
        version: "1.0.0",
        error: null,
      });

      // The row is the world's active rules package — the same id `rulesBoot` reports.
      const activeRow = (await appCall<PackageRow[]>(page, "packages")).find(
        (r) => r.id === "pf1e-mass-battles",
      );
      expect(activeRow?.active).toBe(true);

      const deactivated = await appCall<{ ok: boolean; error?: string }>(
        page,
        "deactivatePackage",
      );
      expect(deactivated, deactivated.error ?? "").toEqual({ ok: true });
      expect(
        (await appCall<Record<string, string>>(page, "rulesBoot")).source,
      ).toBe("builtin");
      expect(
        (await appCall<PackageRow[]>(page, "packages")).find(
          (r) => r.id === "pf1e-mass-battles",
        )?.active,
      ).toBe(false);

      // Nothing threw in the page while importing/activating untrusted-by-default package code.
      expect(pageErrors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
