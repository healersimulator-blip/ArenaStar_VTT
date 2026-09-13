/**
 * P08/D-201 — the mounted fold through the real sheet: authoring the
 * rider↔mount linkage (the Mount editor), and the resolve panel's
 * higher-ground hint (+1 melee vs a smaller, on-foot target — A.11) appearing
 * and disappearing with the linkage.
 *
 * The compendium imports a Medium rider (longsword), a Large warhorse, and a
 * Medium on-foot dummy. The rider's sheet folds the bonus only while linked.
 */
import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

test.describe("PF1e mounted combat (P08/D-201)", () => {
  test("the mount linkage authors through the sheet and folds the +1 higher-ground bonus", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const { strToU8, zipSync } = await import("fflate");
    const manifest = {
      id: "pf-mounted-fixture",
      name: "PF Mounted Fixture",
      version: "1.0.0",
      type: "data",
      packs: [{ name: "riders", type: "actors", file: "packs/riders.json" }],
    };
    const pack = {
      name: "riders",
      type: "actors",
      entries: [
        {
          id: "pf-rider",
          name: "PF Rider",
          data: {
            type: "actor",
            name: "PF Rider",
            system: {
              pf1e: {
                abilities: { str: 16, dex: 14, con: 14 },
                baseAttack: 6,
                hp: 30,
                hpMax: 30,
                attacks: [
                  {
                    name: "Longsword",
                    damageDice: "1d8",
                    damageBonus: 1,
                    damageType: "slashing",
                    critThreatMin: 19,
                    critMultiplier: 2,
                  },
                ],
              },
            },
            items: [],
            effects: [],
          },
        },
        {
          id: "pf-warhorse",
          name: "PF Warhorse",
          data: {
            type: "actor",
            name: "PF Warhorse",
            system: {
              pf1e: {
                size: "Large",
                abilities: { str: 18, dex: 13, con: 17 },
                hp: 19,
                hpMax: 19,
              },
            },
            items: [],
            effects: [],
          },
        },
        {
          id: "pf-footman",
          name: "PF Footman",
          data: {
            type: "actor",
            name: "PF Footman",
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
      "packs/riders.json": strToU8(JSON.stringify(pack)),
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
    for (const id of ["pf-rider", "pf-warhorse", "pf-footman"]) {
      await page.locator(`[data-entry-id="${id}"] [data-entry-import]`).click();
    }
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Rider" })
      .click();
    await page.click("[data-open-pf1e-sheet]");
    await page.click('[data-tab="chat"]');
    const sheet = page.locator(".wm-window [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "combat", exact: true }).click();

    // Author the linkage: the mount select lists the other PF1e actors.
    const mountBlock = sheet.locator("[data-pf1e-mount]");
    await expect(mountBlock).toBeVisible();
    const mountSelect = mountBlock.locator("[data-pf1e-mount-select]");
    await expect(mountSelect).toContainText("PF Warhorse");
    await mountSelect.selectOption({ label: "PF Warhorse" });
    // The linked rider can now state training and the saddle.
    await expect(mountBlock.locator("[data-pf1e-mount-trained]")).toBeVisible();
    await expect(mountBlock.locator("[data-pf1e-mount-saddle]")).toBeVisible();

    // The resolve panel picks the on-foot, Medium dummy: the fold's hint
    // appears — the Large mount grants +1 on melee attacks (A.11).
    const resolve = sheet.locator("[data-pf1e-resolve]");
    await resolve
      .locator("[data-pf1e-resolve-target]")
      .selectOption({ label: "PF Footman" });
    const mountedNote = sheet.locator("[data-pf1e-mounted-bonus]");
    await expect(mountedNote).toBeVisible();
    await expect(mountedNote).toContainText("+1 on melee attacks");

    // Unlink: the hint disappears with the linkage.
    await mountSelect.selectOption({ label: "— none —" });
    await expect(mountedNote).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
});
