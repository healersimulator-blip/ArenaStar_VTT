import { expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entry, manualFragment } from "./lib";

/**
 * N01/N02 (PF1e_Unified_TODO §2) — the browser half of the multiplayer gate.
 *
 * Node tests (tests/host/simAnnounce.test.ts) prove the wire contract: the
 * welcome announces the active battle (schema + scene + package), joiners
 * adopt it before their first sim frame, and a second peer receives PF1e
 * columns (signed i8 saves, u8 AC, u16 profile ids) across snapshots and
 * deltas. What only a browser can prove lives here:
 *
 *   • a REAL world that activated the pf1e-mass-battles package announces the
 *     PF1e schema on the wire after reload (rulesBoot is a world-record
 *     property; activation applies on the next boot);
 *   • a player joining through actual WebRTC manual signaling adopts the same
 *     announced battle — no mass-battle-basic guess;
 *   • the joined player's replica decodes the PF1e campaign (models arrive,
 *     versions advance) with no page errors on either side.
 */

const distPackages = fileURLToPath(
  new URL("../dist/packages", import.meta.url),
);
const pkgPath = (name: string): string => join(distPackages, name);
const DIST_ZIPS = ["pf1e-core-1.0.0.zip", "pf1e-mass-battles-1.0.0.zip"];

interface SimInfo {
  sceneId: string;
  packageId: string | null;
  version: string;
  schema: Record<string, string>;
}

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

const playerCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (
      globalThis as { __vttE2E?: { player?: Record<string, () => T> } }
    ).__vttE2E;
    const fn = surface?.player?.[m];
    if (typeof fn !== "function")
      throw new Error(`player surface missing: ${m}`);
    return fn() as T;
  }, method);

const waitForHost = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __vttE2E?: { app: unknown } }).__vttE2E?.app != null,
      ),
    )
    .toBe(true);

test.describe("PF1e multiplayer join (N01/N02)", () => {
  test("a joiner adopts the announced PF1e battle and receives the campaign", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(180_000);

    for (const zip of DIST_ZIPS) {
      if (!existsSync(pkgPath(zip))) {
        throw new Error(
          `${zip} missing — run \`pnpm build:systems\` before \`pnpm test:e2e\``,
        );
      }
    }

    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const hostErrors: string[] = [];
    const playerErrors: string[] = [];
    host.on("pageerror", (e) => hostErrors.push(String(e.message ?? e)));
    player.on("pageerror", (e) => playerErrors.push(String(e.message ?? e)));

    try {
      // ── host: import + activate the PF1e system package ──────────────────
      await host.goto(entry + "?e2e=1");
      await waitForHost(host);
      for (const zip of DIST_ZIPS) {
        const bytes = Array.from(readFileSync(pkgPath(zip)));
        const imported = await appCall<{ ok: boolean; error?: string }>(
          host,
          "importPackageZip",
          bytes,
        );
        expect(imported, `${zip} import: ${imported.error ?? ""}`).toEqual({
          ok: true,
        });
      }
      const activated = await appCall<{ ok: boolean; error?: string }>(
        host,
        "activatePackage",
        "pf1e-mass-battles",
      );
      expect(activated, activated.error ?? "").toEqual({ ok: true });

      // activation applies on world reload (§12): reboot into PF1e rules
      await host.reload();
      await waitForHost(host);
      const boot = await appCall<{ source: string; packageId: string | null }>(
        host,
        "rulesBoot",
      );
      expect(boot).toMatchObject({
        source: "package",
        packageId: "pf1e-mass-battles",
      });

      // N01: the host announces the PF1e battle in the GM's own welcome
      const gmInfo = await appCall<SimInfo | null>(host, "simInfo");
      expect(gmInfo).not.toBeNull();
      expect(gmInfo?.packageId).toBe("pf1e-mass-battles");
      expect(gmInfo?.sceneId).toBeTruthy();
      // the PF1e column contract, not mass-battle-basic's ammo
      expect(gmInfo?.schema).toMatchObject({
        ac: "u8",
        touchAc: "u8",
        flatFootedAc: "u8",
        fort: "i8", // signed save column
        ref: "i8",
        will: "i8",
        profileIdx: "u16",
        nonlethal: "u16",
      });
      expect(gmInfo?.schema["ammo"]).toBeUndefined();

      // ── player joins via manual signaling (join.spec flow) ───────────────
      await host.click("#share");
      const inviteLink = await host.locator("#invite-link").inputValue();
      const fragment = manualFragment(inviteLink);
      await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
      await expect
        .poll(() => player.locator("#offer-out").inputValue(), {
          timeout: 20_000,
        })
        .not.toBe("");
      const offerCode = await player.locator("#offer-out").inputValue();
      await host.fill("#peer-code", offerCode);
      await host.click("#code-apply");
      await expect
        .poll(() => host.locator("#share-out").inputValue(), {
          timeout: 20_000,
        })
        .not.toBe("");
      const answerCode = await host.locator("#share-out").inputValue();
      await player.fill("#answer-input", answerCode);
      await player.click("#answer-apply");
      await expect
        .poll(() => playerCall<string>(player, "connState"), {
          timeout: 20_000,
        })
        .toBe("connected");
      const playerUserId = await playerCall<string>(player, "userId");
      expect(playerUserId).toBeTruthy();

      // N01: the joiner adopted the SAME announced battle over the wire
      await expect
        .poll(
          async () =>
            (await playerCall<SimInfo | null>(player, "simInfo"))?.packageId,
          {
            timeout: 10_000,
          },
        )
        .toBe("pf1e-mass-battles");
      const plInfo = await playerCall<SimInfo | null>(player, "simInfo");
      expect(plInfo?.sceneId).toBe(gmInfo?.sceneId);
      expect(plInfo?.schema).toEqual(gmInfo?.schema);
      expect(plInfo?.version).toBe(gmInfo?.version);

      // ── GM: two factions + armies, grant the player vision, start ────────
      await host.click("#gm-extras");
      const win = host.locator('[data-window="gmextras"]');
      await expect(win).toBeVisible();
      await host.fill("#faction-name", "Ironhost");
      await host.click("#faction-create");
      await host.fill("#faction-name", "Emberwatch");
      await host.click("#faction-create");
      const spawnFaction = win.locator("[data-spawn-faction]");
      for (let f = 0; f < 2; f++) {
        await spawnFaction.selectOption({ index: f });
        await host.fill("[data-spawn-name]", `Host ${f}`);
        await host.fill("[data-spawn-count]", "5");
        await host.click("#mass-spawn");
      }
      interface ArmySnapshot {
        armies: number;
        units: number;
        strengths: number[];
      }
      await expect
        .poll(() =>
          appCall<ArmySnapshot>(host, "armySnapshot").then((s) => s.armies),
        )
        .toBe(2);

      await host.click("#gm-perms");
      const perms = host.locator('[data-window="permissions"]');
      await expect(perms).toBeVisible();
      await perms.locator("[data-perm-coll]").selectOption("factions");
      const docOptions = perms.locator("[data-perm-doc] option");
      const factionDocId = await docOptions.nth(1).getAttribute("value");
      expect(factionDocId).toBeTruthy();
      await perms
        .locator("[data-perm-doc]")
        .selectOption(factionDocId as string);
      const playerRow = perms.locator(
        `[data-perm-users] tr[data-user="${playerUserId}"]`,
      );
      await expect(playerRow).toHaveCount(1);
      const playerName = (
        (await playerRow.locator("td").first().textContent()) ?? ""
      ).trim();
      await perms
        .locator(`.overrides select[aria-label="Ownership for ${playerName}"]`)
        .selectOption("2"); // OBSERVER → §5A strategic frames for this faction
      await expect
        .poll(() =>
          appCall<Record<string, Record<string, number>>>(
            host,
            "factionOwnership",
          ).then((o) => o[factionDocId as string]?.[playerUserId] ?? 0),
        )
        .toBe(2);
      await perms.locator("[data-window-close]").click();
      await expect(perms).toHaveCount(0);

      // start the campaign — the joiner's PF1e replica decodes it (N02)
      await expect(win.locator("#campaign-start")).toBeEnabled();
      await host.click("#campaign-start");
      await expect
        .poll(() => appCall<number | null>(host, "simCount"), {
          timeout: 20_000,
        })
        .toBe(10);
      await expect
        .poll(() => playerCall<number | null>(player, "simCount"), {
          timeout: 20_000,
        })
        .toBe(10); // hidden slots keep indices (§5A)
      await expect
        .poll(() => playerCall<string>(player, "turnPhase"), {
          timeout: 10_000,
        })
        .toBe("orders");

      // one resolved turn: the joiner's replica advances via the delta path
      await win.locator("[data-campaign-advance]").click();
      await expect
        .poll(() => playerCall<number>(player, "simVersion"), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // no decode/runtime errors on either side of the wire
      expect(hostErrors).toEqual([]);
      expect(playerErrors).toEqual([]);
    } finally {
      await hostCtx.close();
      await playerCtx.close();
    }
  });
});
