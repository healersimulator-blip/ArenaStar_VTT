/**
 * P09/D-202 — the misfire fold through the real sheet. A musketeer with a
 * broken early musket (authored misfire minimum 20 — so the broken
 * escalation makes the effective value 24) resolves against a dummy: every
 * natural face but a 20 misfires, and the second misfire of a broken early
 * firearm explodes (DC 12 Reflex half, the gun destroyed). The die is the
 * host's real d20, so the test retries the Attack until a non-20 appears
 * (95% per click — a bounded loop, not a seeded die).
 *
 * P09/D-218+D-219 — discriminating fixtures: ammo 1→0→reload→1 with provoke
 * note, Quick Clear standard vs move (grit), Expert Loading avert (grit),
 * and burst geometry + DC 12 Reflex half (5-ft burst, 4 squares from a
 * chosen corner). Pure helper tests run alongside the sheet UI so a single
 * Chromium shard covers the gap.
 */
import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

test.describe("PF1e firearms misfire (P09/D-202)", () => {
  test("a broken early musket misfires and explodes through the resolve panel", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const { strToU8, zipSync } = await import("fflate");
    const manifest = {
      id: "pf-firearms-fixture",
      name: "PF Firearms Fixture",
      version: "1.0.0",
      type: "data",
      packs: [
        { name: "shooters", type: "actors", file: "packs/shooters.json" },
      ],
    };
    const pack = {
      name: "shooters",
      type: "actors",
      entries: [
        {
          id: "pf-musketeer",
          name: "PF Musketeer",
          data: {
            type: "actor",
            name: "PF Musketeer",
            system: {
              pf1e: {
                abilities: { str: 12, dex: 16, con: 14 },
                baseAttack: 6,
                hp: 20,
                hpMax: 20,
                attacks: [
                  {
                    name: "Musket",
                    ranged: true,
                    rangeIncrementFt: 40,
                    damageDice: "1d12",
                    damageBonus: 1,
                    damageType: "piercing",
                    firearm: { generation: "early", misfireMinimum: 20 },
                    broken: true,
                  },
                ],
              },
            },
            items: [],
            effects: [],
          },
        },
        {
          id: "pf-target",
          name: "PF Target",
          data: {
            type: "actor",
            name: "PF Target",
            system: {
              pf1e: {
                abilities: { dex: 14, con: 12 },
                hp: 12,
                hpMax: 12,
                armorClass: { armor: 4 },
              },
            },
            items: [],
            effects: [],
          },
        },
      ],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "packs/shooters.json": strToU8(JSON.stringify(pack)),
    });
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(
        page,
        "app",
        "importPackageZip",
        Array.from(zip),
      ),
    ).toMatchObject({ ok: true });
    await page.click('[data-tab="compendia"]');
    await page
      .locator('[data-entry-id="pf-musketeer"] [data-entry-import]')
      .click();
    await page.locator('[data-entry-id="pf-target"] [data-entry-import]').click();
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Musketeer" })
      .click();
    await page.click("[data-open-pf1e-sheet]");
    await page.click('[data-tab="chat"]');
    const sheet = page.locator(".wm-window [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "combat", exact: true }).click();
    const resolve = sheet.locator("[data-pf1e-resolve]");
    await resolve
      .locator("[data-pf1e-resolve-target]")
      .selectOption({ label: "PF Target" });

    // Retry until a natural face below 20 appears: the effective misfire
    // value is 20 + 4 (broken) = 24, so any non-20 misfires — and the gun is
    // already broken, so the misfire explodes.
    const card = page
      .locator("#chat-log .line")
      .filter({ hasText: "PF Musketeer: Musket vs PF Target" });
    let sawMisfire = false;
    for (let attempt = 0; attempt < 8 && !sawMisfire; attempt++) {
      await resolve.locator("[data-pf1e-resolve-attack]").click();
      await expect(card.last()).toContainText(/hits\.|misses\.|CRITS!/);
      const text = (await card.last().textContent()) ?? "";
      sawMisfire = text.includes("misfire");
      if (sawMisfire) {
        expect(text).toContain("misfire value 24");
        expect(text).toContain("automatically misses");
        expect(text).toContain("explodes");
        expect(text).toContain("DC 12 Reflex half");
        expect(text).toContain("destroyed by the explosion");
        // The explosion damages no target: the misfire is an auto-miss, so
        // the target's HP never moves on this card.
        expect(text).not.toMatch(/PF Target 12 → \d+ HP/);
      }
    }
    expect(sawMisfire).toBe(true);
    expect(runtimeErrors).toEqual([]);
  });
});

test.describe("PF1e firearms — ammo, grit and burst (P09/D-218+D-219 pure)", () => {
  test("ammo gate: 0 ⇒ refusal, 1 ⇒ consumes 1", async () => {
    const m = await import("../src/packages/pf1e/firearms");
    expect(m.firearmShotAmmo({ shotsAvailable: 0 })).toMatchObject({
      canShoot: false,
      remaining: 0,
    });
    expect(m.firearmShotAmmo({ shotsAvailable: 0 }).refusal).toContain(
      "no shot loaded",
    );
    expect(m.firearmShotAmmo({ shotsAvailable: 1 })).toMatchObject({
      canShoot: true,
      remaining: 0,
      refusal: null,
    });
    expect(m.firearmShotAmmo({ shotsAvailable: 2 })).toMatchObject({
      canShoot: true,
      remaining: 1,
    });
  });

  test("Quick Clear: grit 0 ⇒ refusal, 1 ⇒ standard, spend ⇒ move +1 grit", async () => {
    const m = await import("../src/packages/pf1e/firearms");
    expect(m.quickClearReloadCost({ gritAvailable: 0 })).toMatchObject({
      action: "standard",
      gritSpent: 0,
      refusal: "Quick Clear requires at least 1 grit",
    });
    expect(m.quickClearReloadCost({ gritAvailable: 1 })).toMatchObject({
      action: "standard",
      gritSpent: 0,
      refusal: null,
    });
    expect(m.quickClearReloadCost({ gritAvailable: 1, spendGrit: true })).toMatchObject({
      action: "move",
      gritSpent: 1,
      refusal: null,
    });
    expect(m.quickClearReloadCost({ gritAvailable: 5, spendGrit: true }).cost).toContain("move action");
  });

  test("Expert Loading averts the broken early explosion; advanced never explodes; nat 20 never misfires", async () => {
    const m = await import("../src/packages/pf1e/firearms");
    const base = { generation: "early" as const, misfireMinimum: 2, broken: false };
    // First misfire breaks, second broken early explodes
    expect(
      m.pf1eMisfireVerdict({ facts: { ...base, broken: true }, die: 6 }),
    ).toMatchObject({ misfire: true, explodes: true, save: { dc: 12, half: true } });
    // Expert Loading averts
    expect(
      m.pf1eMisfireVerdict({ facts: { ...base, broken: true, expertLoading: true }, die: 6 }),
    ).toMatchObject({ misfire: true, explodes: false, save: null });
    // Advanced never explodes
    expect(
      m.pf1eMisfireVerdict({ facts: { ...base, generation: "advanced", broken: true }, die: 6 }),
    ).toMatchObject({ misfire: true, explodes: false });
    // Natural 20 gate: value 24 still doesn't misfire on a 20
    expect(
      m.pf1eMisfireVerdict({ facts: { ...base, misfireMinimum: 20, broken: true }, die: 20 }),
    ).toEqual({ misfire: false });
    // Reload entry provokes
    expect(m.firearmReloadEntry()?.id).toBe("load-firearm");
    expect(m.firearmReloadEntry()?.provokes).toBe("yes");
  });

  test("burst geometry is the 4 squares sharing a corner; DC 12 Reflex half floors", async () => {
    const m = await import("../src/packages/pf1e/firearms");
    expect(m.FIREARM_EXPLOSION_DC).toBe(12);
    expect(m.FIREARM_EXPLOSION_RADIUS_FT).toBe(5);
    expect(m.firearmExplosionSquares({ col: 3, row: 7 })).toEqual(
      expect.arrayContaining([
        { col: 2, row: 6 },
        { col: 3, row: 6 },
        { col: 2, row: 7 },
        { col: 3, row: 7 },
      ]),
    );
    expect(m.firearmExplosionSquares({ col: 0, row: 0 })).toEqual([
      { col: -1, row: -1 },
      { col: 0, row: -1 },
      { col: -1, row: 0 },
      { col: 0, row: 0 },
    ]);
    expect(m.firearmExplosionReflexOutcome({ die: 10, reflexMod: 2 })).toEqual({
      total: 12,
      success: true,
    });
    expect(m.firearmExplosionReflexOutcome({ die: 9, reflexMod: 2 })).toEqual({
      total: 11,
      success: false,
    });
    expect(m.firearmExplosionMitigatedDamage({ damageTotal: 11, success: true })).toBe(5);
    expect(m.firearmExplosionMitigatedDamage({ damageTotal: 11, success: false })).toBe(11);
    expect(m.firearmExplosionTargetDamage({ damageTotal: 9, die: 8, reflexMod: 4 })).toMatchObject({
      total: 12,
      success: true,
      dealt: 4,
    });
  });
});

test.describe("PF1e firearms reload (P09/D-218) — ammo 1→0→reload→1 provokes", () => {
  test("fire → empty refusal → reload (move, provokes) → fire again", async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const { strToU8, zipSync } = await import("fflate");
    const manifest = {
      id: "pf-reload-fixture",
      name: "PF Reload Fixture",
      version: "1.0.0",
      type: "data",
      packs: [{ name: "shooters", type: "actors", file: "packs/shooters.json" }],
    };
    const pack = {
      name: "shooters",
      type: "actors",
      entries: [
        {
          id: "pf-reloader",
          name: "PF Reloader",
          data: {
            type: "actor",
            name: "PF Reloader",
            system: {
              pf1e: {
                abilities: { str: 12, dex: 16, con: 14 },
                baseAttack: 6,
                hp: 20,
                hpMax: 20,
                attacks: [
                  {
                    name: "Pistol",
                    ranged: true,
                    rangeIncrementFt: 20,
                    damageDice: "1d8",
                    damageBonus: 1,
                    damageType: "piercing",
                    firearm: { generation: "early", misfireMinimum: 1, capacity: 1, loaded: 1 },
                  },
                ],
                grit: { current: 1, max: 2 },
              },
            },
            items: [],
            effects: [],
          },
        },
        {
          id: "pf-dummy",
          name: "PF Dummy",
          data: {
            type: "actor",
            name: "PF Dummy",
            system: {
              pf1e: {
                abilities: { dex: 14, con: 12 },
                hp: 30,
                hpMax: 30,
                armorClass: { armor: 4 },
              },
            },
            items: [],
            effects: [],
          },
        },
      ],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "packs/shooters.json": strToU8(JSON.stringify(pack)),
    });
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(page, "app", "importPackageZip", Array.from(zip)),
    ).toMatchObject({ ok: true });
    await page.click('[data-tab="compendia"]');
    await page.locator('[data-entry-id="pf-reloader"] [data-entry-import]').click();
    await page.locator('[data-entry-id="pf-dummy"] [data-entry-import]').click();
    await page.click('[data-tab="actors"]');
    await page.locator("#sheet-list .sheet-row").filter({ hasText: "PF Reloader" }).click();
    await page.click("[data-open-pf1e-sheet]");
    await page.click('[data-tab="chat"]');
    const sheet = page.locator(".wm-window [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "combat", exact: true }).click();
    const resolve = sheet.locator("[data-pf1e-resolve]");
    await resolve.locator("[data-pf1e-resolve-target]").selectOption({ label: "PF Dummy" });
    // The reload assertion is about the ammo/provoke state, not the attack
    // outcome. Keep the preceding shot away from natural 1 so it cannot
    // introduce the broken-firearm branch and make reload correctly refuse.
    // HostSync uses cryptoRng rather than Math.random for real dice.
    await page.evaluate(() => {
      const cryptoApi = globalThis.crypto;
      const original = cryptoApi.getRandomValues.bind(cryptoApi);
      Object.defineProperty(cryptoApi, "getRandomValues", {
        configurable: true,
        value: (array: ArrayBufferView) => {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 0x80000000;
            return array;
          }
          return original(array);
        },
      });
    });

    // Initial ammo read-out is 1/1
    await expect(sheet.locator("[data-pf1e-firearm-resolve]")).toContainText("ammo 1/1");
    await expect(sheet.locator("[data-pf1e-firearm-actions] [data-firearm-reload]")).toContainText("1/1");

    // Fire once: ammo 1→0 (consume on hit/miss/misfire)
    await resolve.locator("[data-pf1e-resolve-attack]").click();
    await expect(page.locator("#chat-log .line").filter({ hasText: "PF Reloader: Pistol vs PF Dummy" }).last()).toContainText(/hits\.|misses\.|CRITS!|misfire/);
    await expect.poll(async () => sheet.locator("[data-pf1e-firearm-resolve]").textContent()).toContain("ammo 0/1");

    // Second shot must refuse: no shot loaded (§2.9)
    await resolve.locator("[data-pf1e-resolve-attack]").click();
    await expect(sheet.locator("[data-pf1e-resolve-error]")).toContainText(/no shot loaded|impossible to attack/);

    // Reload is a move action that provokes (load-firearm, Table 7-2, UC p.135 §2.9)
    const reloadBtn = sheet.locator("[data-firearm-reload]");
    await expect(reloadBtn).toContainText(/provokes/);
    await reloadBtn.click();
    await expect(sheet.locator("[data-firearm-note]")).toContainText(/Reloaded.*provokes|Reloaded.*move/);
    await expect.poll(async () => sheet.locator("[data-pf1e-firearm-resolve]").textContent()).toContain("ammo 1/1");
    await expect(sheet.locator("[data-pf1e-resolve-error]")).toBeHidden();

    // Third shot now succeeds again (ammo gate cleared)
    await resolve.locator("[data-pf1e-resolve-attack]").click();
    await expect(page.locator("#chat-log .line").filter({ hasText: "PF Reloader: Pistol vs PF Dummy" }).last()).toContainText(/hits\.|misses\.|CRITS!|misfire/);
    expect(runtimeErrors).toEqual([]);
  });
});
