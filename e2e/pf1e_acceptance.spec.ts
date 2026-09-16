// Checklist: V05 — the full two-peer mass-battle acceptance flow.
/**
 * V05 — "import/activate real zips, deploy 10k, resolve 20 turns, move/cast/attack
 * with a hero, inspect exact analytics and CSV, assert clean rules boot/console
 * and joiner state. Browser package activation alone does not satisfy this."
 *
 * The other PF1e specs each prove one slice: `pf1e_mass_battles.spec.ts` that the
 * built `rules.js` imports and takes the worker's rules slot, `pf1e_join.spec.ts`
 * that a joiner adopts the announced battle, and
 * `tests/packages/pf1eMassBattleScale.test.ts` that 10k models resolve inside
 * budget in Node. What none of them did was run the *whole* flow through the
 * shipped artifact in a browser, which is the thing this checklist item is about:
 * that the rules bundle a GM actually installs can carry a real campaign end to
 * end and report figures exact enough to build the CSV from.
 *
 * So this reads `rules.js` out of the built zip — the same bytes the importer
 * receives — loads it through the same `loadRules` entry point activation uses,
 * and drives 10 000 models for 20 turns with a hero that moves, casts and
 * attacks. The per-unit analytics are read back off the wire, so a broken
 * analytics path fails here rather than only in a UI nobody clicked.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { entry, manualFragment } from "./lib";

const distPackages = fileURLToPath(
  new URL("../dist/packages", import.meta.url),
);
const pkgPath = (name: string): string => join(distPackages, name);
const DIST_ZIPS = ["pf1e-core-1.0.0.zip", "pf1e-mass-battles-1.0.0.zip"];

const UNITS_PER_FACTION = 10;
const MODELS_PER_UNIT = 500;
const EXPECTED_MODELS = UNITS_PER_FACTION * MODELS_PER_UNIT * 2; // 10 000
const TURNS = 20;

/** The rules entry name comes off the shipped manifest, never restated here. */
const RULES_ENTRY: string = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../systems/pf1e-mass-battles/manifest.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { rules?: { entry?: string } }
).rules?.entry ?? "rules.js";

/** The shipped rules artifact's own source text, exactly as the zip carries it. */
const shippedRulesSource = (): string => {
  const zip = unzipSync(readFileSync(pkgPath("pf1e-mass-battles-1.0.0.zip")));
  const bytes = zip[RULES_ENTRY];
  if (!bytes) {
    throw new Error(
      `${RULES_ENTRY} missing from the shipped zip (has: ${Object.keys(zip).join(", ")})`,
    );
  }
  return strFromU8(bytes);
};

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

/** `massBattleAcceptance` lives on the root surface, beside the other smokes. */
const rootCall = <T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as {
          __vttE2E?: Record<string, unknown> | undefined;
        }
      ).__vttE2E;
      const fn = surface?.[m];
      if (typeof fn !== "function")
        throw new Error(`root surface missing: ${m}`);
      return (fn as (...x: unknown[]) => T)(...a);
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

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (
      globalThis as { __vttE2E?: { gm?: Record<string, () => T> } }
    ).__vttE2E;
    const fn = surface?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn() as T;
  }, method);

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

interface AcceptanceResult {
  ok: boolean;
  error?: string;
  rulesVersion: string;
  reportRulesVersion: string;
  modelsDeployed: number;
  expectedModels: number;
  unitsPerFaction: number;
  modelsPerUnit: number;
  turnsResolved: number;
  firstPoolHash: string;
  lastPoolHash: string;
  distinctPoolHashes: number;
  heroUnitId: string | null;
  heroOrders: { move: boolean; cast: boolean; attack: boolean };
  meleeEvents: number;
  spellEvents: number;
  moveEvents: number;
  eventsTotal: number;
  perTurnMs: number[];
  analyticsArmies: Array<{ armyId: string; unitCount: number }>;
  analyticsUnits: Record<
    string,
    {
      totalAttacks: number;
      hits: number;
      netDamageDealt: number;
      killsCount: number;
      deathsCount: number;
    }
  >;
  csv: { lines: number; header: string; firstRows: string[] };
}

interface SimInfo {
  sceneId: string;
  packageId: string | null;
  version: string;
  schema: Record<string, string>;
}

const requireBuiltZips = (): void => {
  for (const zip of DIST_ZIPS) {
    if (!existsSync(pkgPath(zip))) {
      throw new Error(
        `${zip} missing — run \`pnpm build:systems\` before \`pnpm test:e2e\``,
      );
    }
  }
};

/** Import + activate both shipped zips and reboot into the package's rules. */
const installShippedRules = async (
  page: Page,
): Promise<{ source: string; packageId: string | null }> => {
  for (const zip of DIST_ZIPS) {
    const imported = await appCall<{ ok: boolean; error?: string }>(
      page,
      "importPackageZip",
      Array.from(readFileSync(pkgPath(zip))),
    );
    expect(imported, `${zip} import: ${imported.error ?? ""}`).toEqual({
      ok: true,
    });
  }
  const activated = await appCall<{ ok: boolean; error?: string }>(
    page,
    "activatePackage",
    "pf1e-mass-battles",
  );
  expect(activated, activated.error ?? "").toEqual({ ok: true });
  // activation applies on world reload (§12)
  await page.reload();
  await waitForApp(page);
  return appCall<{ source: string; packageId: string | null }>(
    page,
    "rulesBoot",
  );
};

test.describe("V05 — two-peer mass-battle acceptance", () => {
  test("the shipped rules artifact carries a 10k / 20-turn campaign with a hero, exact analytics and CSV", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(300_000);
    requireBuiltZips();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e.message ?? e)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      // ── import/activate the real zips, and prove the rules boot is clean ──
      const boot = await installShippedRules(page);
      expect(boot).toMatchObject({
        source: "package",
        packageId: "pf1e-mass-battles",
      });
      expect(pageErrors).toEqual([]);

      // ── the whole acceptance flow, driven by the shipped artifact ────────
      const result = await rootCall<AcceptanceResult>(
        page,
        "massBattleAcceptance",
        {
          rulesSource: shippedRulesSource(),
          unitsPerFaction: UNITS_PER_FACTION,
          modelsPerUnit: MODELS_PER_UNIT,
          turns: TURNS,
          seed: 0x5eed,
        },
      );
      expect(result.error ?? "").toBe("");
      expect(result.ok).toBe(true);

      // deploy: every model the two armies authored actually landed
      expect(result.modelsDeployed).toBe(EXPECTED_MODELS);
      expect(result.modelsDeployed).toBe(result.expectedModels);

      // 20 turns resolved, and the report names the artifact that resolved them
      expect(result.turnsResolved).toBe(TURNS);
      expect(result.perTurnMs).toHaveLength(TURNS);
      expect(result.rulesVersion).toBeTruthy();
      expect(result.reportRulesVersion).toBe(result.rulesVersion);

      // Genuine combat on EVERY turn, not a battle that settles early: all twenty
      // pool hashes are distinct. A fixed unit-to-unit target pairing wipes the
      // paired enemy inside four turns, after which each attack resolves "0 hits,
      // 0 damage, 0 kills" and the last sixteen turns are the "empty late-turn
      // work" the V06 golden gate forbids — a 20-turn campaign in name only. So
      // this is an equality, not a floor.
      expect(result.distinctPoolHashes).toBe(TURNS);
      expect(result.firstPoolHash).toBeTruthy();
      expect(result.lastPoolHash).not.toBe(result.firstPoolHash);
      expect(result.meleeEvents).toBeGreaterThan(0);

      // ── the hero moved, cast and attacked ────────────────────────────────
      expect(result.heroUnitId).toBeTruthy();
      expect(result.heroOrders).toEqual({
        move: true,
        cast: true,
        attack: true,
      });
      expect(result.moveEvents).toBeGreaterThan(0);
      expect(result.spellEvents).toBeGreaterThan(0);

      // ── exact analytics, per army and per unit ───────────────────────────
      expect(result.analyticsArmies).toHaveLength(2);
      for (const army of result.analyticsArmies) {
        expect(army.unitCount).toBe(UNITS_PER_FACTION);
      }
      expect(Object.keys(result.analyticsUnits)).toHaveLength(
        UNITS_PER_FACTION * 2,
      );
      const totals = Object.values(result.analyticsUnits).reduce(
        (acc, u) => ({
          attacks: acc.attacks + u.totalAttacks,
          hits: acc.hits + u.hits,
          damage: acc.damage + u.netDamageDealt,
        }),
        { attacks: 0, hits: 0, damage: 0 },
      );
      expect(totals.attacks).toBeGreaterThan(0);
      expect(totals.damage).toBeGreaterThan(0);
      // internal consistency the UI and the CSV both depend on
      expect(totals.hits).toBeLessThanOrEqual(totals.attacks);

      // ── the CSV is derived from those exact figures ──────────────────────
      // The exporter writes one header, one row per unit in the report, and a
      // TOTALS row it appends itself — so the line count is exact, not a floor.
      expect(result.csv.header).toContain("Unit ID");
      expect(result.csv.header).toContain("Hit %");
      expect(result.csv.lines).toBe(
        Object.keys(result.analyticsUnits).length + 2,
      );
      expect(result.csv.firstRows.length).toBeGreaterThan(0);
      // every data row carries the exporter's full column set. `exportAnalyticsToCsv`
      // authors 14 headers (Unit ID, Attacks, Hits, Misses, Hit %, Misfires, Damage,
      // Kills, Heals, DR Absorbed, DR Bypassed, SR Blocked, Saves Passed, Saves
      // Failed); the count is read off that header rather than hardcoded twice, so a
      // column added to the exporter cannot silently make this check a lie.
      const columnCount = result.csv.header.split(",").length;
      expect(columnCount).toBe(14);
      for (const row of result.csv.firstRows) {
        expect(row.split(",")).toHaveLength(columnCount);
      }

      // clean boot and console for the whole run
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test("the joiner adopts the announced battle and decodes the campaign with a clean console", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(240_000);
    requireBuiltZips();

    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const hostErrors: string[] = [];
    const playerErrors: string[] = [];
    const hostConsole: string[] = [];
    const playerConsole: string[] = [];
    // The app dials the public Nostr relays it is configured with. Where the run
    // has no route to the internet those sockets fail, which is the transport
    // reporting an environment fact, not a defect in the rules boot or the
    // replication under test here. Everything else on the console still counts.
    const isOfflineRelayNoise = (text: string): boolean =>
      text.startsWith("WebSocket connection to 'wss://") &&
      text.includes("failed: Error in connection establishment");
    const record = (sink: string[], text: string): void => {
      if (!isOfflineRelayNoise(text)) sink.push(text);
    };
    host.on("pageerror", (e) => hostErrors.push(String(e.message ?? e)));
    player.on("pageerror", (e) => playerErrors.push(String(e.message ?? e)));
    host.on("console", (m) => {
      if (m.type() === "error") record(hostConsole, m.text());
    });
    player.on("console", (m) => {
      if (m.type() === "error") record(playerConsole, m.text());
    });

    try {
      await host.goto(entry + "?e2e=1");
      await waitForApp(host);
      const boot = await installShippedRules(host);
      expect(boot).toMatchObject({
        source: "package",
        packageId: "pf1e-mass-battles",
      });

      // the GM's own welcome announces the PF1e battle and its column contract
      const gmInfo = await appCall<SimInfo | null>(host, "simInfo");
      expect(gmInfo).not.toBeNull();
      expect(gmInfo?.packageId).toBe("pf1e-mass-battles");
      expect(gmInfo?.schema).toMatchObject({
        ac: "u8",
        fort: "i8",
        profileIdx: "u16",
        pfCondition: "u32",
      });

      // ── the joiner comes in over real manual signaling ───────────────────
      await host.click("#share");
      const inviteLink = await host.locator("#invite-link").inputValue();
      await player.goto(
        `${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`,
      );
      await expect
        .poll(() => player.locator("#offer-out").inputValue(), {
          timeout: 20_000,
        })
        .not.toBe("");
      await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
      await host.click("#code-apply");
      await expect
        .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
        .not.toBe("");
      await player.fill(
        "#answer-input",
        await host.locator("#share-out").inputValue(),
      );
      await player.click("#answer-apply");
      await expect
        .poll(() => playerCall<string>(player, "connState"), { timeout: 20_000 })
        .toBe("connected");

      const playerUserId = await playerCall<string>(player, "userId");
      expect(playerUserId).toBeTruthy();

      // joiner state: the SAME announced battle, not a mass-battle-basic guess
      await expect
        .poll(
          async () =>
            (await playerCall<SimInfo | null>(player, "simInfo"))?.packageId,
          { timeout: 15_000 },
        )
        .toBe("pf1e-mass-battles");
      const plInfo = await playerCall<SimInfo | null>(player, "simInfo");
      expect(plInfo?.sceneId).toBe(gmInfo?.sceneId);
      expect(plInfo?.schema).toEqual(gmInfo?.schema);
      expect(plInfo?.version).toBe(gmInfo?.version);

      // ── a real campaign both peers can see ───────────────────────────────
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
      await expect
        .poll(
          () =>
            gmCall<{ armies: number }>(host, "armySnapshot").then(
              (s) => s.armies,
            ),
        )
        .toBe(2);

      // The joiner only receives §5A strategic frames for a faction it has
      // ownership on — without this grant the campaign resolves entirely on the
      // host and the joiner's replica never advances, which is a silent
      // replication gap rather than a visible failure.
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
        .selectOption("2"); // OBSERVER
      await expect
        .poll(() =>
          gmCall<Record<string, Record<string, number>>>(
            host,
            "factionOwnership",
          ).then((o) => o[factionDocId as string]?.[playerUserId] ?? 0),
        )
        .toBe(2);
      await perms.locator("[data-window-close]").click();
      await expect(perms).toHaveCount(0);

      await expect(win.locator("#campaign-start")).toBeEnabled();
      await host.click("#campaign-start");
      await expect
        .poll(() => gmCall<number | null>(host, "simCount"), { timeout: 20_000 })
        .toBe(10);
      await expect
        .poll(() => playerCall<number | null>(player, "simCount"), {
          timeout: 20_000,
        })
        .toBe(10);

      // a resolved turn reaches the joiner through the delta path
      await win.locator("[data-campaign-advance]").click();
      await expect
        .poll(() => playerCall<number>(player, "simVersion"), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);

      // clean rules boot and console on BOTH sides of the wire
      expect(hostErrors).toEqual([]);
      expect(playerErrors).toEqual([]);
      expect(hostConsole).toEqual([]);
      expect(playerConsole).toEqual([]);
    } finally {
      await hostCtx.close();
      await playerCtx.close();
    }
  });
});
