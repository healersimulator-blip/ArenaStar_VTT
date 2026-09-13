/**
 * P09/D-202 — the misfire fold through the real sheet. A musketeer with a
 * broken early musket (authored misfire minimum 20 — so the broken
 * escalation makes the effective value 24) resolves against a dummy: every
 * natural face but a 20 misfires, and the second misfire of a broken early
 * firearm explodes (DC 12 Reflex half, the gun destroyed). The die is the
 * host's real d20, so the test retries the Attack until a non-20 appears
 * (95% per click — a bounded loop, not a seeded die).
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
