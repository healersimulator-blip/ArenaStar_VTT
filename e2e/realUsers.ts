/** Real-user acceptance helpers. Hooks only seed/read fixtures; measured actions use UI. */
import { expect, type Browser, type Page } from "@playwright/test";
import { entry, manualFragment, playerCall, waitForSurface } from "./lib";

export async function freshTable(browser: Browser, bootNative = true) {
  const gmContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const playerContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  gm.setDefaultTimeout(15000);
  player.setDefaultTimeout(15000);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [label, page] of [["GM", gm], ["Player", player]] as const) page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()))
      warnings.push(`${label}: ${message.text().slice(0, 2000)}`);
    if (warnings.length > 100) warnings.shift();
  });
  gm.on("pageerror", (error) => errors.push(`GM: ${error.message}`));
  player.on("pageerror", (error) => errors.push(`Player: ${error.message}`));
  // Separate browser contexts mean no copied world, packages, consent or IDB state.
  if (bootNative) {
    await gm.goto(entry + "?e2e=1");
    await waitForSurface(gm, "app");
  }
  return {
    gm,
    player,
    errors,
    warnings,
    close: async () => {
      await Promise.all([playerContext.close(), gmContext.close()]);
    },
  };
}

export async function joinFromInvite(gm: Page, player: Page): Promise<string> {
  await gm.locator("#share").click();
  const fragment = manualFragment(
    await gm.locator("#invite-link").inputValue(),
  );
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await completeManualJoin(gm, player);
  return fragment;
}

export async function completeManualJoin(gm: Page, player: Page) {
  await expect
    .poll(() => player.locator("#offer-out").inputValue(), { timeout: 30000 })
    .not.toBe("");
  const previous = await gm.locator("#share-out").inputValue();
  await gm
    .locator("#peer-code")
    .fill(await player.locator("#offer-out").inputValue());
  await gm.locator("#code-apply").click();
  await expect
    .poll(() => gm.locator("#share-out").inputValue(), { timeout: 30000 })
    .not.toBe(previous);
  await player
    .locator("#answer-input")
    .fill(await gm.locator("#share-out").inputValue());
  await player.locator("#answer-apply").click();
  await waitForSurface(player, "player");
  await expect
    .poll(() => playerCall<string>(player, "connState"), { timeout: 30000 })
    .toBe("connected");
  await waitForSurface(player, "playerCanvas");
}

export async function selectActor(page: Page, name: string, player = false) {
  await page
    .locator(
      player
        ? '[data-player-dock] [data-player-tab="actors"]'
        : '[data-tab="actors"]',
    )
    .click();
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: name })
    .click();
}

export async function openCharacter(page: Page, name: string, player = false) {
  await selectActor(page, name, player);
  await page.locator("#sheets [data-open-pf1e-sheet]").click();
  const sheet = page
    .locator(".wm-window [data-pf1e-sheet]")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name, exact: true })).toBeVisible();
  return sheet;
}

export async function seedNativeCharacters(gm: Page) {
  await gm.evaluate(async () => {
    const client = (
      globalThis as unknown as {
        __vttE2E: {
          app: { gm: { client: import("../src/client/sync").ClientSync } };
        };
      }
    ).__vttE2E.app.gm.client;
    const make = (id: string, name: string, visibility: 0 | 2) => ({
      _id: id,
      type: "actor" as const,
      name,
      ownership: { default: visibility },
      flags: {},
      items: [],
      effects: [],
      system: {
        pf1e: {
          hp: 18,
          hpMax: 24,
          hitDice: 5,
          abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
          spells: {
            keyAbility: "int",
            mode: "prepared",
            casterLevel: 5,
            slotsPerDay: { 0: 4, 1: 4, 2: 3, 3: 2 },
            prepared: [
              { name: "Magic Missile", level: 1 },
              { name: "Shield", level: 1 },
            ],
          },
        },
      },
    });
    await client.submitAndWait([
      {
        kind: "create",
        coll: "actors",
        data: make("journey-wizard", "Journey Wizard", 0),
      },
      {
        kind: "create",
        coll: "actors",
        data: make("journey-observer", "Companion Wizard", 2),
      },
      {
        kind: "create",
        coll: "actors",
        data: make("journey-secret", "GM Secret Villain", 0),
      },
    ]);
    for (const id of ["journey-wizard", "journey-observer", "journey-secret"])
      if (!client.store.get("actors", id))
        throw new Error(`Fixture actor missing: ${id}`);
  });
}

export async function assignWizard(gm: Page, player: Page) {
  const userId = await playerCall<string>(player, "userId");
  await selectActor(gm, "Journey Wizard");
  await gm.locator("#assign-owner").selectOption(userId);
  await expect
    .poll(() =>
      playerCall<{ actors: Array<{ id: string }> }>(
        player,
        "codexReplicaSummary",
      ).then((summary) =>
        summary.actors.some((actor) => actor.id === "journey-wizard"),
      ),
    )
    .toBe(true);
  return userId;
}
