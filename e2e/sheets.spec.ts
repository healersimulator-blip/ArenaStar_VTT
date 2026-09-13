import { test, expect, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  playerCall,
  waitForSurface,
  manualFragment,
} from "./lib";

// Real WebRTC peers, with the same manual invite exchange used by normal UI.
async function connectSheetPlayer(host: Page, player: Page): Promise<string> {
  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "app");
  await host.click("#share");
  const inviteLink = await host.locator("#invite-link").inputValue();
  const fragment = manualFragment(inviteLink);
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect
    .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
    .not.toBe("");
  await host.fill(
    "#peer-code",
    await player.locator("#offer-out").inputValue(),
  );
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
    .poll(() => player.locator("#pstatus").textContent(), { timeout: 20_000 })
    .toContain("World One");
  return playerCall<string>(player, "userId");
}

test.setTimeout(90_000);

test.describe("sheets (§10 M1)", () => {
  test("GM creates + assigns an actor; the player edits it; ownership enforced", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    const playerId = await connectSheetPlayer(host, player);

    // ── GM: create a private actor; the player does NOT see it (§5) ──
    await host.click('[data-tab="actors"]');
    await host.click("#new-doc");
    await expect(host.locator("#sheet-list .sheet-row")).toHaveCount(1);
    await host.fill("#sheet-name", "Hero");
    await host.locator("#sheet-name").dispatchEvent("change");
    await expect
      .poll(() => player.locator("#sheet-list .sheet-row").count(), {
        timeout: 15_000,
      })
      .toBe(0); // default:0 → omitted from the player's projection

    // ── GM: assign it to the player (visibility crossing → materializes) ──
    await host.selectOption("#assign-owner", playerId);
    await expect
      .poll(() => player.locator("#sheet-list .sheet-row").count(), {
        timeout: 15_000,
      })
      .toBe(1);
    await expect(player.locator("#sheet-list .doc-name")).toHaveText("Hero");

    // ── player: edit the hp system field → reactive op → GM sees it ──
    await player.locator("#sheet-list .sheet-row").first().click();
    const hp = player.locator(".sys-field[data-key='hp']");
    await expect(hp).toBeVisible();
    expect(await hp.isEnabled()).toBe(true); // owned → editable
    await hp.fill("7");
    await hp.dispatchEvent("change");
    await expect
      .poll(() => host.locator(".sys-field[data-key='hp']").inputValue(), {
        timeout: 15_000,
      })
      .toBe("7");

    // ── enforcement: a second, unassigned actor never reaches the player ──
    await host.click("#new-doc");
    await expect(host.locator("#sheet-list .sheet-row")).toHaveCount(2);
    await player.waitForTimeout(1_000);
    await expect(player.locator("#sheet-list .sheet-row")).toHaveCount(1);

    // authoritative seq advanced through all of it
    await expect
      .poll(() => hostCall<number>(host, "seq"))
      .toBeGreaterThanOrEqual(6);

    await hostCtx.close();
    await playerCtx.close();
  });
});

test("PF1e compendium actor opens an authored sheet and recomputes after edits", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const { strToU8, zipSync } = await import("fflate");
  const { surfaceCallArg } = await import("./lib");
  const manifest = {
    id: "pf-sheet-fixture",
    name: "PF Sheet Fixture",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "fighters", type: "actors", file: "packs/fighters.json" }],
  };
  const pack = {
    name: "fighters",
    type: "actors",
    entries: [
      {
        id: "pf-fighter",
        name: "PF Fighter",
        data: {
          type: "actor",
          name: "PF Fighter",
          system: {
            pf1e: {
              abilities: { str: 16, dex: 16 },
              armorClass: { armor: 5 },
              hp: 12,
              hpMax: 20,
            },
          },
          items: [],
          effects: [],
        },
      },
      {
        id: "pf-published",
        name: "Published Warrior",
        data: {
          type: "actor",
          name: "Published Warrior",
          system: {
            pf1e: {
              abilities: { dex: 16 },
              ac: 22,
              touchAc: 16,
              flatFootedAc: 17,
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
    "packs/fighters.json": strToU8(JSON.stringify(pack)),
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
    .locator('[data-entry-id="pf-fighter"] [data-entry-import]')
    .click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "PF Fighter" })
    .click();
  const sheet = page.locator("#sheets [data-pf1e-sheet]");
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("18 / 13 / 15");
  // Never expose the nested system object as a generic [object Object] text input.
  await expect(page.locator('.sys-field[data-key="pf1e"]')).toHaveCount(0);
  await sheet.getByRole("button", { name: "attributes", exact: true }).click();
  const dex = sheet.locator('[data-pf1e-field="abilities.dex"]');
  await dex.fill("18");
  await dex.dispatchEvent("change");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("19 / 14 / 15");
  await sheet.getByRole("button", { name: "combat", exact: true }).click();
  const hp = sheet.locator('[data-pf1e-field="hp"]');
  await hp.fill("7");
  await hp.dispatchEvent("change");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet).toContainText("7 / 20");

  // New P1 editors author data, while the summary continues to derive its totals.
  await expect(
    sheet.getByRole("button", { name: "monster", exact: true }),
  ).toHaveCount(0);
  await sheet.getByRole("button", { name: "armor", exact: true }).click();
  const armor = sheet.locator('[data-pf1e-detail="armor.armorBonus"]');
  await expect(armor).toHaveValue("5");
  await armor.fill("7");
  await armor.dispatchEvent("change");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("21 / 14 / 17");
  await sheet.getByRole("button", { name: "armor", exact: true }).click();
  await armor.fill("5");
  await armor.dispatchEvent("change");
  await sheet.getByRole("button", { name: "features", exact: true }).click();
  const feats = sheet.locator('[data-pf1e-detail="feats"]');
  await feats.fill("Dodge\nCombat Reflexes");
  await feats.dispatchEvent("change");
  await expect(feats).toHaveValue("Dodge\nCombat Reflexes");
  await sheet.locator("[data-pf1e-add-monster]").click();
  await sheet.getByRole("button", { name: "monster", exact: true }).click();
  const cr = sheet.locator('[data-pf1e-detail="creature.cr"]');
  await cr.fill("1/3");
  await cr.dispatchEvent("change");
  const creatureType = sheet.locator('[data-pf1e-detail="creature.type"]');
  await creatureType.fill("humanoid");
  await creatureType.dispatchEvent("change");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await sheet.getByRole("button", { name: "monster", exact: true }).click();
  await expect(cr).toHaveValue("1/3");
  await expect(creatureType).toHaveValue("humanoid");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("19 / 14 / 15");

  await sheet.getByRole("button", { name: "weapons", exact: true }).click();
  await sheet.locator("[data-add-attack]").click();
  const attackRow = sheet.locator('[data-pf1e-attack-row="0"]');
  await attackRow.locator('[data-attack-field="name"]').fill("Longsword");
  await attackRow.locator('[data-attack-field="name"]').dispatchEvent("change");
  await attackRow.locator('[data-attack-field="damageDice"]').fill("1d8");
  await attackRow
    .locator('[data-attack-field="damageDice"]')
    .dispatchEvent("change");
  await attackRow.locator('[data-attack-field="damageBonus"]').fill("2");
  await attackRow
    .locator('[data-attack-field="damageBonus"]')
    .dispatchEvent("change");
  await attackRow.locator('[data-attack-field="twoHanded"]').check();
  await expect(sheet.locator("[data-derived-attack]")).toContainText(
    "Longsword",
  );
  await expect(sheet.locator("[data-derived-attack]")).toContainText("1d8 +6");
  await attackRow.locator('[data-attack-field="damageDice"]').fill("1d8+99");
  await attackRow
    .locator('[data-attack-field="damageDice"]')
    .dispatchEvent("change");
  await expect(sheet.getByRole("alert")).toContainText("Use NdM");
  await expect(sheet.locator("[data-derived-attack]")).toContainText("1d8 +6");
  await attackRow.locator("[data-remove-attack]").click();
  await expect(sheet.locator("[data-pf1e-attack-row]")).toHaveCount(0);
  await expect(sheet.locator("[data-derived-attack]")).toContainText(
    "Unarmed strike",
  );
  await sheet.getByRole("button", { name: "summary", exact: true }).click();

  // Popout and sidebar share the projected actor, not a stale copy captured at open.
  await page.locator("[data-open-pf1e-sheet]").click();
  const window = page.locator('[data-window^="pf1e-sheet:"]');
  await expect(window).toHaveCount(1);
  await expect(window.locator("[data-pf1e-ac]")).toHaveText("19 / 14 / 15");
  await page.locator("[data-open-pf1e-sheet]").click();
  await expect(window).toHaveCount(1);
  await page.locator("#sheet-name").fill("Renamed PF Fighter");
  await page.locator("#sheet-name").dispatchEvent("change");
  await expect(
    window.getByRole("heading", { name: "Renamed PF Fighter" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "combat", exact: true }).click();
  const popupHp = window.locator('[data-pf1e-field="hp"]');
  await popupHp.fill("9");
  await popupHp.dispatchEvent("change");
  await expect(sheet).toContainText("9 / 20");
  const tempHp = window.locator('[data-pf1e-field="tempHp"]');
  await tempHp.fill("8");
  await tempHp.dispatchEvent("change");
  const fireResistance = window.locator(
    '[data-pf1e-field="energyResistance.fire"]',
  );
  await fireResistance.fill("10");
  await fireResistance.dispatchEvent("change");
  await expect(sheet.locator("[data-temp-hp]")).toContainText("8");
  await expect(sheet.locator("[data-energy-resistance]")).toContainText(
    "fire 10",
  );
  await expect(sheet).toContainText("9 / 20");
  await window.locator("[data-window-min]").click();
  await page.locator("[data-open-pf1e-sheet]").click();
  await expect(popupHp).toBeVisible();
  await window.locator("[data-window-close]").click();
  await expect(window).toHaveCount(0);

  // A real compendium drag creates a linked token; double-click opens its actor.
  await page.click('[data-tab="compendia"]');
  const before = await hostCall<number>(page, "tokenCount");
  const canvas = page.locator(".canvas-host canvas");
  await page
    .locator('[data-entry-id="pf-fighter"]')
    .dragTo(canvas, { targetPosition: { x: 160, y: 160 } });
  await expect
    .poll(() => hostCall<number>(page, "tokenCount"))
    .toBe(before + 1);
  await canvas.dblclick({ position: { x: 160, y: 160 } });
  await expect(window).toHaveCount(1);
  await expect(window.locator("[data-pf1e-ac]")).toHaveText("18 / 13 / 15");
  await window.locator("[data-window-close]").click();

  // Published totals need an explicit preview, not an inferred component breakdown.
  await page.click('[data-tab="compendia"]');
  await page
    .locator('[data-entry-id="pf-published"] [data-entry-import]')
    .click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "Published Warrior" })
    .click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("22 / 16 / 17");
  await sheet.getByRole("button", { name: "armor", exact: true }).click();
  await sheet.locator("[data-ac-conversion] summary").click();
  for (const [field, value] of Object.entries({
    armor: "5",
    shield: "0",
    natural: "0",
    dodge: "0",
    misc: "0",
  })) {
    await sheet.locator(`[data-ac-component="${field}"]`).fill(value);
  }
  await sheet.locator("[data-preview-components]").click();
  await expect(sheet.locator("[data-ac-before]")).toHaveText("22 / 16 / 17");
  await expect(sheet.locator("[data-ac-after]")).toHaveText("18 / 13 / 15");
  // A concurrent edit in another sheet invalidates the reviewed actor snapshot.
  await page.locator("[data-open-pf1e-sheet]").click();
  await window.getByRole("button", { name: "combat", exact: true }).click();
  await window.locator('[data-pf1e-field="hp"]').fill("6");
  await window.locator('[data-pf1e-field="hp"]').dispatchEvent("change");
  await window.getByRole("button", { name: "summary", exact: true }).click();
  await expect(window).toContainText("6 / 0");
  await window.locator("[data-window-close]").click();
  await sheet.locator("[data-apply-ac-source]").click();
  await expect(sheet.getByRole("alert")).toContainText("changed");
  await expect(
    sheet.locator('[data-pf1e-detail="armor.armorBonus"]'),
  ).toBeDisabled();
  await sheet.locator("[data-preview-components]").click();
  await sheet.locator("[data-apply-ac-source]").click();
  await expect(
    sheet.locator('[data-pf1e-detail="armor.armorBonus"]'),
  ).toBeEnabled();
  await sheet.locator("[data-preview-published]").click();
  await expect(sheet.locator("[data-ac-after]")).toHaveText("22 / 16 / 17");
  await sheet.locator("[data-apply-ac-source]").click();
  await expect(
    sheet.locator('[data-pf1e-detail="armor.armorBonus"]'),
  ).toBeDisabled();
  // The token dragged above has its own linked PF Fighter (Dex 16), not the selected actor.
  await page.click('[data-tab="combat"]');
  await page.click("#combat-start");
  await page.click("#combat-init");
  const receipt = page.locator("[data-initiative-receipt] pre");
  await expect(receipt).toHaveCount(1);
  const rolled = JSON.parse((await receipt.textContent()) ?? "{}");
  expect(rolled.modifier).toBe(3);
  expect(rolled.die).toBeGreaterThanOrEqual(1);
  expect(rolled.die).toBeLessThanOrEqual(20);
  expect(rolled.total).toBe(rolled.die + 3);
  await expect(page.locator(".combat .init")).toHaveValue(String(rolled.total));
  await page.locator(".combat .init").fill("25");
  await page.locator(".combat .init").dispatchEvent("change");
  await expect(page.locator("[data-initiative-receipt]")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

/** Package the shipped data-only core sources, not a second hand-written bestiary fixture. */
async function importShippedCore(page: Page): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { zipSync } = await import("fflate");
  const { surfaceCallArg } = await import("./lib");
  const files = Object.fromEntries(
    ["manifest.json", "packs/bestiary.json", "packs/spells.json"].map(
      (path) => [
        path,
        readFileSync(new URL(`../systems/pf1e-core/${path}`, import.meta.url)),
      ],
    ),
  );
  expect(
    await surfaceCallArg(
      page,
      "app",
      "importPackageZip",
      Array.from(zipSync(files)),
    ),
  ).toMatchObject({ ok: true });
}

test("all shipped bestiary sheets match the shared derivation and open Weapons without runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { readFileSync } = await import("node:fs");
  const { derivePF1eActor } = await import("../src/packages/pf1e/actor");
  const pack = JSON.parse(
    readFileSync(
      new URL("../systems/pf1e-core/packs/bestiary.json", import.meta.url),
      "utf8",
    ),
  );
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);
  for (const item of pack.entries) {
    await page.click('[data-tab="compendia"]');
    await page
      .locator(`[data-entry-id="${item.id}"] [data-entry-import]`)
      .click();
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: item.name })
      .click();
    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    const d = derivePF1eActor({ system: item.data.system.pf1e });
    await expect(sheet.locator("[data-pf1e-ac]")).toHaveText(
      `${d.ac.normal} / ${d.ac.touch} / ${d.ac.flatFooted}`,
    );
    await sheet.getByRole("button", { name: "weapons", exact: true }).click();
    await expect(sheet.locator("[data-derived-attack]")).toHaveCount(
      d.attacks.length,
    );
    await expect(sheet.locator("[data-add-attack]")).toBeEnabled();
    await sheet.getByRole("button", { name: "summary", exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test("owned PF1e token opens a live player sheet and revocation removes private content", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player])
      page.on("pageerror", (error) => errors.push(error.message));
    const playerId = await connectSheetPlayer(host, player);
    await importShippedCore(host);
    await host.click('[data-tab="compendia"]');
    const canvas = host.locator(".canvas-host canvas");
    await host
      .locator('[data-entry-id="heavy-infantry"]')
      .dragTo(canvas, { targetPosition: { x: 160, y: 160 } });
    await expect.poll(() => hostCall<number>(host, "tokenCount")).toBe(1);
    await host.click('[data-tab="actors"]');
    await host
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "Heavy Infantry" })
      .click();
    await host.selectOption("#assign-owner", playerId);
    await expect(player.locator("#sheet-list .sheet-row")).toHaveCount(1);
    await player.locator("#sheet-list .sheet-row").click();
    const sidebar = player.locator("#sheets [data-pf1e-sheet]");
    await expect(sidebar.locator("[data-pf1e-ac]")).toHaveText("16 / 11 / 16");
    // Both application canvas paths must route the actual double-click into WindowHost.
    // Player and GM canvases have different dimensions/cameras; use the projected token position.
    await expect.poll(() => playerCall<number>(player, "tokenCount")).toBe(1);
    const pos = await playerCall<{ x: number; y: number }>(player, "tokenPos");
    const { fitRect, worldToScreen } = await import("../src/canvas/camera");
    const playerCanvas = player.locator(".canvas-host canvas");
    const viewport = await playerCanvas.evaluate((el) => ({
      width: el.clientWidth,
      height: el.clientHeight,
    }));
    const camera = fitRect(
      { x: 0, y: 0, width: 2000, height: 1500 },
      viewport,
      24,
    );
    await playerCanvas.dblclick({
      position: worldToScreen(camera, pos.x, pos.y),
    });
    const window = player.locator('[data-window^="pf1e-sheet:"]');
    await expect(window.locator("[data-pf1e-ac]")).toHaveText("16 / 11 / 16");
    await window.getByRole("button", { name: "combat", exact: true }).click();
    await window.locator('[data-pf1e-field="hp"]').fill("7");
    await window.locator('[data-pf1e-field="hp"]').dispatchEvent("change");
    await expect(host.locator("#sheets [data-pf1e-sheet]")).toContainText(
      "7 / 0",
    );
    await expect(sidebar).toContainText("7 / 0");
    await host.fill("#sheet-name", "Private renamed infantry");
    await host.locator("#sheet-name").dispatchEvent("change");
    await expect(
      window.getByRole("heading", { name: "Private renamed infantry" }),
    ).toBeVisible();

    await host.click("#gm-perms");
    const perms = host.locator('[data-window="permissions"]');
    await perms.locator("[data-perm-coll]").selectOption("actors");
    await perms
      .locator("[data-perm-doc]")
      .selectOption({ label: "Private renamed infantry" });
    const playerName = (
      await perms
        .locator(`[data-perm-users] tr[data-user="${playerId}"] td`)
        .first()
        .innerText()
    ).trim();
    const ownership = perms.getByRole("combobox", {
      name: `Ownership for ${playerName}`,
      exact: true,
    });
    await ownership.selectOption("2");
    await expect(window.locator('[data-pf1e-field="hp"]')).toBeDisabled();
    await ownership.selectOption("0");
    await expect(window.getByRole("status")).toContainText("Actor unavailable");
    await expect(window.locator("[data-pf1e-sheet]")).toHaveCount(0);
    await expect(player.locator("#sheet-list .sheet-row")).toHaveCount(0);
    await expect(window).not.toContainText("Private renamed infantry");
    await ownership.selectOption("3");
    await expect(
      window.getByRole("heading", { name: "Private renamed infantry" }),
    ).toBeVisible();
    await expect(window.locator("[data-pf1e-ac]")).toHaveText("16 / 11 / 16");
    expect(errors).toEqual([]);
  } finally {
    await hostCtx.close();
    await playerCtx.close();
  }
});

test("PF1e equal-total initiative roll-offs persist in the tracker across rounds", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);
  await page.click('[data-tab="compendia"]');
  const canvas = page.locator(".canvas-host canvas");
  await page
    .locator('[data-entry-id="heavy-infantry"]')
    .dragTo(canvas, { targetPosition: { x: 160, y: 160 } });
  await page
    .locator('[data-entry-id="heavy-cavalry"]')
    .dragTo(canvas, { targetPosition: { x: 260, y: 160 } });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(2);
  await page.click('[data-tab="combat"]');
  await page.click("#combat-start");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Infantry",
    "Heavy Cavalry",
  ]);
  await expect(page.locator("#combat-init")).toBeVisible();
  // Scope deterministic RNG to the synchronous real DOM handler, restoring it before
  // any other browser task can run. No production hook or persistent RNG override.
  const remaining = await page.evaluate(() => {
    const old = Math.random;
    const dice = [10, 10, 1, 20];
    Math.random = () => ((dice.shift() ?? NaN) - 0.5) / 20;
    try {
      const button = document.querySelector<HTMLButtonElement>("#combat-init");
      if (!button) throw new Error("Missing initiative button");
      button.click();
      return dice.length;
    } finally {
      Math.random = old;
    }
  });
  expect(remaining).toBe(0);
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Cavalry",
    "Heavy Infantry",
  ]);
  const receipts = await page
    .locator("[data-initiative-receipt] pre")
    .allTextContents();
  expect(receipts.map((raw) => JSON.parse(raw))).toMatchObject([
    { die: 10, total: 10, modifier: 0, tiePolicy: "pf1e", tieRolls: [20] },
    { die: 10, total: 10, modifier: 0, tiePolicy: "pf1e", tieRolls: [1] },
  ]);
  await page.click("#combat-next");
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Infantry",
  );
  await page.click("#combat-next");
  await expect(page.locator(".combat .round")).toContainText("Round 2");
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Cavalry",
  );
  expect(errors).toEqual([]);
});

test("canvas selection creates scoped rosters, adds/removes members and rolls only selected combatants", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);
  await page.click('[data-tab="compendia"]');
  const canvas = page.locator(".canvas-host canvas");
  for (const [id, x] of [
    ["heavy-infantry", 160],
    ["heavy-cavalry", 260],
    ["siege-bombard", 360],
  ] as const) {
    await page
      .locator(`[data-entry-id="${id}"]`)
      .dragTo(canvas, { targetPosition: { x, y: 160 } });
  }
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(3);
  const seq = await hostCall<number>(page, "seq");
  const rect = await canvas.boundingBox();
  if (!rect) throw new Error("Canvas unavailable");
  await page.mouse.move(rect.x + 125, rect.y + 125);
  await page.mouse.down();
  await page.mouse.move(rect.x + 295, rect.y + 195, { steps: 6 });
  await page.mouse.up();
  expect(await hostCall<number>(page, "seq")).toBe(seq); // selection is not a move/write
  await page.click('[data-tab="combat"]');
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "2 selected",
  );
  await expect(page.locator("[data-selected-token-names]")).toHaveText(
    "Heavy Infantry, Heavy Cavalry",
  );
  await page.click("#combat-start");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Infantry",
    "Heavy Cavalry",
  ]);
  async function roll(values: number[]): Promise<void> {
    await expect(page.locator("#combat-init")).toBeVisible();
    const unused = await page.evaluate((dice) => {
      const old = Math.random;
      Math.random = () => ((dice.shift() ?? NaN) - 0.5) / 20;
      try {
        const button =
          document.querySelector<HTMLButtonElement>("#combat-init");
        if (!button) throw new Error("No roll control");
        button.click();
        return dice.length;
      } finally {
        Math.random = old;
      }
    }, values);
    expect(unused).toBe(0);
  }
  await roll([4, 12]);
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Cavalry",
  );
  const before = await page
    .locator("[data-initiative-receipt] pre")
    .allTextContents();
  await canvas.click({ position: { x: 360, y: 160 } });
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "1 selected",
  );
  await page.click("#combat-init");
  await expect(page.locator(".combat [role=alert]")).toContainText(
    "not in this encounter",
  );
  await page.click("[data-add-selected]");
  await page.click("[data-add-selected]"); // idempotent
  await expect(page.locator(".combat .order li")).toHaveCount(3);
  await roll([8]);
  const cavalry = page
    .locator(".combat .order li")
    .filter({ has: page.locator(".name", { hasText: "Heavy Cavalry" }) });
  const infantry = page
    .locator(".combat .order li")
    .filter({ has: page.locator(".name", { hasText: "Heavy Infantry" }) });
  expect(
    await cavalry.locator("[data-initiative-receipt] pre").textContent(),
  ).toBe(before[0]);
  expect(
    await infantry.locator("[data-initiative-receipt] pre").textContent(),
  ).toBe(before[1]);
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Heavy Cavalry",
  );
  await roll([12]); // selected Bombard ties unselected Cavalry: accepted, no extra dice
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Cavalry",
    "Siege Bombard",
    "Heavy Infantry",
  ]);
  expect(
    await cavalry.locator("[data-initiative-receipt] pre").textContent(),
  ).toBe(before[0]);
  await canvas.click({ position: { x: 160, y: 160 } });
  await page.click("[data-remove-selected]");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Cavalry",
    "Siege Bombard",
  ]);
  await canvas.click({ position: { x: 260, y: 160 } });
  await page.click("[data-remove-selected]");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Siege Bombard",
  ]);
  await expect(page.locator(".combat .order li.active .name")).toHaveText(
    "Siege Bombard",
  );
  await expect(page.locator(".combat .round")).toContainText("Round 1");
  await canvas.click({ position: { x: 360, y: 160 } });
  await page.click("[data-remove-selected]");
  await expect(page.locator(".combat .order li")).toHaveCount(0);
  await expect(page.locator(".combat .round")).toHaveText(
    "Round 1 · No combatants",
  );
  await page.click("#scene-add");
  await page.locator(".scenenav [data-scene]").nth(1).click();
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "0 selected",
  );
  await expect(page.locator("[data-encounter-select] option")).toHaveCount(1);
  await page.locator(".scenenav [data-scene]").first().click();
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "0 selected",
  );
  await page.click("[data-encounter-create]"); // empty selection falls back to all three scene tokens
  // PF1e encounters start through the surprise-aware transition (D-132): the
  // pre-start roll controls roll the fresh roster, then Start is legal.
  await roll([2, 19, 10]);
  await page.click("#combat-start");
  await expect(page.locator(".combat .order li")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("deleting a selected token never broadens encounter creation to remaining tokens", async ({
  page,
}) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);
  await page.click('[data-tab="compendia"]');
  const canvas = page.locator(".canvas-host canvas");
  await page
    .locator('[data-entry-id="heavy-infantry"]')
    .dragTo(canvas, { targetPosition: { x: 160, y: 160 } });
  await page
    .locator('[data-entry-id="heavy-cavalry"]')
    .dragTo(canvas, { targetPosition: { x: 260, y: 160 } });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(2);
  await canvas.click({ position: { x: 260, y: 160 } });
  await page.click('[data-tab="combat"]');
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "1 selected",
  );
  await page.click("#gm-undo"); // remove the last imported actor + token, not the first
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await expect(page.locator(".combat [role=status]")).toContainText("deleted");
  await page.click("[data-encounter-create]");
  await expect(page.locator(".combat [role=alert]")).toContainText("deleted");
  await expect(page.locator("[data-encounter-select] option")).toHaveCount(1);
  await page.click("[data-clear-combat-selection]");
  await expect(page.locator("[data-combat-selection]")).toContainText(
    "0 selected",
  );
  await page.click("#combat-start");
  await expect(page.locator(".combat .order .name")).toHaveText([
    "Heavy Infantry",
  ]);
});

test("PF1e sheet roll buttons post attacks, damage and saves to chat with their breakdown (A06)", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const { strToU8, zipSync } = await import("fflate");
  const { surfaceCallArg } = await import("./lib");
  const manifest = {
    id: "pf-roll-fixture",
    name: "PF Roll Fixture",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "fighters", type: "actors", file: "packs/fighters.json" }],
  };
  const pack = {
    name: "fighters",
    type: "actors",
    entries: [
      {
        id: "pf-roller",
        name: "PF Roller",
        data: {
          type: "actor",
          name: "PF Roller",
          system: {
            pf1e: {
              abilities: { str: 16, dex: 14, con: 14 },
              baseAttack: 6,
              saves: { fort: 8, ref: 5, will: 2 },
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
    ],
  };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/fighters.json": strToU8(JSON.stringify(pack)),
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
  await page.locator('[data-entry-id="pf-roller"] [data-entry-import]').click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "PF Roller" })
    .click();
  // Roll cards land in the sidebar chat panel, and only one sidebar tab body
  // is mounted at a time — so the sheet must float in a window while chat is
  // the active tab.
  await page.click("[data-open-pf1e-sheet]");
  await page.click('[data-tab="chat"]');
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await sheet.getByRole("button", { name: "combat", exact: true }).click();

  // The authored line rolls at BAB 6 + Str 3 (+9) and threatens 19–20; the
  // unarmed fallback is absent, so nothing provokes.
  const group = sheet.locator('[data-pf1e-attack="Longsword"]');
  await expect(group).toContainText("1d20 + 9");
  await expect(group.locator("[data-pf1e-provokes]")).toHaveCount(0);
  await expect(group).toContainText("threat range 19–20");

  // Attack: one public roll card with the breakdown flavor line.
  const chat = page.locator("#chat-log .rollcard");
  await group.getByRole("button", { name: "Attack", exact: true }).click();
  await expect(chat).toHaveCount(1);
  await expect(chat.first()).toContainText("1d20 + 9");
  await expect(chat.first().locator(".flavor")).toContainText(
    "Longsword +9 = BAB 6 + Str +3, size +0",
  );

  // Damage and crit: dice + static per multiplier step (CRB p.179).
  await group.getByRole("button", { name: "Damage", exact: true }).click();
  await expect(chat).toHaveCount(2);
  await expect(chat.nth(1)).toContainText("1d8 + 4");
  await group.getByRole("button", { name: "Crit ×2", exact: true }).click();
  await expect(chat).toHaveCount(3);
  await expect(chat.nth(2)).toContainText("1d8 + 4 + 1d8 + 4");

  // Saves roll at their derived totals (authored base + ability).
  await sheet.getByRole("button", { name: "Fortitude 1d20 + 10" }).click();
  await expect(chat).toHaveCount(4);
  await expect(chat.nth(3).locator(".flavor")).toContainText("Fortitude +10");

  expect(runtimeErrors).toEqual([]);
});

test("PF1e resolve-vs-target posts public rolls, a resolution card and hp writes (A06b)", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const { strToU8, zipSync } = await import("fflate");
  const { surfaceCallArg } = await import("./lib");
  const manifest = {
    id: "pf-resolve-fixture",
    name: "PF Resolve Fixture",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "fighters", type: "actors", file: "packs/fighters.json" }],
  };
  const pack = {
    name: "fighters",
    type: "actors",
    entries: [
      {
        id: "pf-striker",
        name: "PF Striker",
        data: {
          type: "actor",
          name: "PF Striker",
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
        id: "pf-dummy",
        name: "PF Dummy",
        data: {
          type: "actor",
          name: "PF Dummy",
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
    "packs/fighters.json": strToU8(JSON.stringify(pack)),
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
    .locator('[data-entry-id="pf-striker"] [data-entry-import]')
    .click();
  await page.locator('[data-entry-id="pf-dummy"] [data-entry-import]').click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "PF Striker" })
    .click();
  // The resolution cards land in the sidebar chat panel, and only one sidebar
  // tab body is mounted at a time — so the sheet floats in a window while chat
  // is the active tab.
  await page.click("[data-open-pf1e-sheet]");
  await page.click('[data-tab="chat"]');
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await sheet.getByRole("button", { name: "combat", exact: true }).click();

  // The resolve panel lists the other PF1e actor and its derived AC trio
  // (10 + Dex 2 + armor 4 = 16 normal, 12 touch, 14 flat-footed).
  const resolve = sheet.locator("[data-pf1e-resolve]");
  await expect(resolve).toBeVisible();
  const targetSelect = resolve.locator("[data-pf1e-resolve-target]");
  await targetSelect.selectOption({ label: "PF Dummy" });
  const defenseSelect = resolve.locator("[data-pf1e-resolve-defense]");
  await expect(defenseSelect).toContainText("Normal 16");
  await expect(defenseSelect).toContainText("Touch 12");
  await expect(defenseSelect).toContainText("Flat-footed 14");

  // Resolve: the attack rollcard posts publicly with its breakdown, then the
  // resolution card names the target, the defense and the verdict.
  await resolve.locator("[data-pf1e-resolve-attack]").click();
  const chat = page.locator("#chat-log");
  await expect(chat.locator(".rollcard").first()).toContainText("1d20 + 9");
  const card = page.locator("#chat-log .line", {
    hasText: "PF Striker: Longsword vs PF Dummy",
  });
  await expect(card).toHaveCount(1);
  const text = (await card.textContent()) ?? "";
  expect(text).toMatch(/hits\.|misses\.|CRITS!/);
  // A hit (or crit) also rolls damage and writes hp through the op path: the
  // card must then carry the before → after line for the 12-HP dummy (a crit
  // can take it below zero, so the after value may be negative).
  if (/hits\.|CRITS!/.test(text)) {
    expect(text).toMatch(/PF Dummy 12 → -?\d+ HP/);
  }
  expect(runtimeErrors).toEqual([]);
});

test("PF1e effect editor applies, edits, suppresses and reverts live numbers (E02)", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const { strToU8, zipSync } = await import("fflate");
  const { surfaceCallArg } = await import("./lib");
  const manifest = {
    id: "pf-effects-fixture",
    name: "PF Effects Fixture",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "heroes", type: "actors", file: "packs/heroes.json" }],
  };
  const pack = {
    name: "heroes",
    type: "actors",
    entries: [
      {
        id: "pf-hero",
        name: "PF Hero",
        data: {
          type: "actor",
          name: "PF Hero",
          system: {
            pf1e: { abilities: { str: 12 }, hp: 20, hpMax: 20 },
          },
          items: [],
          effects: [],
        },
      },
    ],
  };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/heroes.json": strToU8(JSON.stringify(pack)),
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
  await page.locator('[data-entry-id="pf-hero"] [data-entry-import]').click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "PF Hero" })
    .click();
  const sheet = page.locator("#sheets [data-pf1e-sheet]");
  await sheet.getByRole("button", { name: "effects", exact: true }).click();

  // Baseline: STR 12. Apply +4 enhancement through the editor form.
  const editor = sheet.locator("[data-pf1e-effect-editor]");
  await editor.locator("[data-pf1e-effect-name]").fill("Bull's Strength");
  const modRow = editor.locator("[data-pf1e-effect-mod]").first();
  await modRow.getByLabel("Stat").selectOption("ability.str");
  await modRow.getByLabel("Bonus type").selectOption("enhancement");
  await modRow.getByLabel("Value").fill("4");
  await editor.locator("[data-pf1e-effect-submit]").click();
  await expect(sheet.locator("[data-pf1e-effective-scores]")).toContainText(
    "STR 16",
  );
  const listed = sheet.locator("[data-pf1e-effect]");
  await expect(listed).toHaveCount(1);
  await expect(listed.first()).toContainText("Bull's Strength");

  // Edit in place: +6 — the derivation follows without a new row.
  await listed.first().locator("[data-pf1e-effect-edit]").click();
  await modRow.getByLabel("Value").fill("6");
  await editor.locator("[data-pf1e-effect-submit]").click();
  await expect(sheet.locator("[data-pf1e-effective-scores]")).toContainText(
    "STR 18",
  );

  // Suppress: authored 12 shows through again; re-enable restores.
  await listed.first().getByRole("button", { name: "Suppress" }).click();
  await expect(sheet.locator("[data-pf1e-effective-scores]")).toContainText(
    "STR 12",
  );
  await listed.first().getByRole("button", { name: "Enable" }).click();
  await expect(sheet.locator("[data-pf1e-effective-scores]")).toContainText(
    "STR 18",
  );

  // Remove: fully back to the authored actor.
  await listed.first().getByRole("button", { name: "Remove" }).click();
  await expect(sheet.locator("[data-pf1e-effective-scores]")).toContainText(
    "STR 12",
  );
  await expect(sheet.locator("[data-pf1e-effect]")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
