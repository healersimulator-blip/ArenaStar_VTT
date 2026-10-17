import { expect, test } from "@playwright/test";
import { chromeAction, playerCall } from "./lib";
import {
  assignWizard,
  completeManualJoin,
  freshTable,
  joinFromInvite,
  openCharacter,
  seedNativeCharacters,
} from "./realUsers";

/** Native PF1e sheets, not imported Foundry PF1. No player-side world/package import. */
test("fresh player owns a readable spellbook, manages slots, casts, and reconnects with persisted state", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const table = await freshTable(browser);
  const { gm, player } = table;
  try {
    await seedNativeCharacters(gm);
    await joinFromInvite(gm, player);
    const userId = await assignWizard(gm, player);
    const mine = await openCharacter(player, "Journey Wizard", true);
    const host = await openCharacter(gm, "Journey Wizard");
    await expect(
      mine.getByRole("progressbar", { name: "Hit points" }),
    ).toHaveAttribute("value", "18");
    await expect(
      mine.getByRole("progressbar", { name: "Hit points" }),
    ).toHaveAttribute("max", "24");
    await mine.getByRole("button", { name: "spells", exact: true }).click();
    await host.getByRole("button", { name: "spells", exact: true }).click();
    const row = mine.locator('[data-spell-slot-level="1"]');
    const hostRow = host.locator('[data-spell-slot-level="1"]');
    await expect(row.locator("[data-slot-total]")).toHaveText("5");
    await expect(mine.locator('[data-prepared-row="0"]')).toContainText(
      "Magic Missile",
    );
    await row.getByRole("button", { name: "Spend", exact: true }).click();
    await expect(row.locator("[data-slot-spent]")).toHaveText("1");
    await expect(hostRow.locator("[data-slot-spent]")).toHaveText("1");
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(hostRow.locator("[data-slot-spent]")).toHaveText("0");

    await mine.locator("[data-prepare-name]").fill("Detect Magic");
    await mine.locator("[data-prepare-level]").selectOption("0");
    await mine.getByRole("button", { name: "Prepare", exact: true }).click();
    await expect(
      host.locator("[data-prepared-row]").filter({ hasText: "Detect Magic" }),
    ).toBeVisible();
    // Self-target avoids claiming authority over another user's actor. 1d2 uses
    // real host dice; assert the legal range and exact agreement between replicas.
    await mine
      .locator('[data-prepared-row="0"]')
      .getByRole("button", { name: "Cast", exact: true })
      .click();
    await mine.locator("[data-cast-target]").selectOption("journey-wizard");
    await mine.locator("[data-cast-severity]").selectOption("none");
    await mine.locator("[data-cast-damage]").fill("1d2");
    await mine.locator("[data-cast-submit]").click();
    await expect
      .poll(() => mine.locator("[data-cast-error]").allTextContents())
      .toEqual([]);
    await expect(hostRow.locator("[data-slot-spent]")).toHaveText("1");
    await expect(host.locator('[data-prepared-expended="0"]')).toBeChecked();
    await expect(mine.locator('[data-prepared-expended="0"]')).toBeChecked();
    await expect
      .poll(() =>
        playerCall<string[]>(player, "aisChatTexts").then((rows) =>
          rows.join("\n"),
        ),
      )
      .toContain("casts Magic Missile");
    await mine.getByRole("button", { name: "summary", exact: true }).click();
    await host.getByRole("button", { name: "summary", exact: true }).click();
    await expect(
      mine.getByRole("progressbar", { name: "Hit points" }),
    ).toHaveAttribute("value", /^(16|17)$/);
    const hpAfter = await mine
      .getByRole("progressbar", { name: "Hit points" })
      .getAttribute("value");
    if (hpAfter === null) throw new Error("Player sheet has no HP value");
    await expect(
      host.getByRole("progressbar", { name: "Hit points" }),
    ).toHaveAttribute("value", hpAfter);

    // A reload destroys the live client/sheet; a new welcome must restore the
    // authoritative state, not a screenshot or an optimistic local-only change.
    await player.reload();
    await completeManualJoin(gm, player);
    expect(await playerCall<string>(player, "userId")).toBe(userId);
    const reopened = await openCharacter(player, "Journey Wizard", true);
    await expect(
      reopened.getByRole("progressbar", { name: "Hit points" }),
    ).toHaveAttribute("value", hpAfter);
    await reopened.getByRole("button", { name: "spells", exact: true }).click();
    await expect(
      reopened.locator('[data-spell-slot-level="1"] [data-slot-spent]'),
    ).toHaveText("1");
    await expect(
      reopened.locator('[data-prepared-expended="0"]'),
    ).toBeChecked();
    await expect(
      reopened
        .locator("[data-prepared-row]")
        .filter({ hasText: "Detect Magic" }),
    ).toBeVisible();
    expect(table.errors).toEqual([]);
    expect(await playerCall<unknown>(player, "lastRejected")).toBeNull();
  } finally {
    await table.close();
  }
});

test("observer sheets are read-only, GM secrets never arrive, and revoking ownership removes an open sheet", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const table = await freshTable(browser);
  const { gm, player } = table;
  try {
    await seedNativeCharacters(gm);
    await joinFromInvite(gm, player);
    const userId = await assignWizard(gm, player);
    const observer = await openCharacter(player, "Companion Wizard", true);
    await expect(observer).toContainText("Read-only (no ownership)");
    await expect(observer.locator("[data-heal-submit]")).toBeDisabled();
    await observer.getByRole("button", { name: "spells", exact: true }).click();
    await expect(observer.locator('[data-prepared-row="0"]')).toContainText(
      "Magic Missile",
    );
    await expect(
      observer.locator(
        "[data-slot-spend], [data-prepare-submit], [data-cast-prepared]",
      ),
    ).toHaveCount(0);
    await expect(observer.locator("[data-cast-submit]")).toBeDisabled();
    const replica = await playerCall<{
      actors: Array<{ id: string; name: string }>;
    }>(player, "codexReplicaSummary");
    expect(replica.actors.some((actor) => actor.id === "journey-secret")).toBe(
      false,
    );
    await expect(player.locator("#sheet-list")).not.toContainText(
      "GM Secret Villain",
    );

    const owned = await openCharacter(player, "Journey Wizard", true);
    await expect(owned.locator("[data-heal-submit]")).toBeEnabled();
    await chromeAction(gm, "gm-perms");
    await gm.locator("[data-perm-coll]").selectOption("actors");
    await gm.locator("[data-perm-doc]").selectOption("journey-wizard");
    await gm.locator(`[data-perm-owner="${userId}"]`).selectOption("0");
    await expect(
      player.locator('[data-window="pf1e-sheet:journey-wizard"]'),
    ).toContainText("Actor unavailable");
    await expect(owned).toHaveCount(0);
    await expect
      .poll(() =>
        playerCall<{ actors: Array<{ id: string }> }>(
          player,
          "codexReplicaSummary",
        ).then((summary) =>
          summary.actors.some((actor) => actor.id === "journey-wizard"),
        ),
      )
      .toBe(false);
    expect(table.errors).toEqual([]);
  } finally {
    await table.close();
  }
});
