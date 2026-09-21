/**
 * §2.2 item 3 (G-20, D-261) — apply / heal from an arbitrary roll card, end to end.
 *
 * The table flow this closes: somebody rolls (`/roll 1d4+4` in the real chat input), the host
 * evaluates it and commits the card, the GM or a player selects a token on the canvas and clicks
 * the card's verb. The **amount is never on the wire** — `roll.apply` names the card and the actor,
 * and the host re-reads `roll.total` from the card it committed itself, re-checks
 * `can(user, "update", actor, "actors")`, applies the PF1e rules and writes the record on the card.
 *
 * Every assertion below reads the **host replica** (`pf1eDerivedHp`, `pf1eLastRoll`) or the DOM of
 * a real click, so a broken wiring fails here rather than in a helper: the damage the card shows is
 * the damage the sheet derives, and the card cannot be counted twice.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  manualFragment,
  playerCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface DerivedHp {
  hp: number;
  hpMax: number;
  tempHp: number;
  nonlethalDamage: number;
}

interface RollCard {
  id: string;
  total: number;
  formula: string;
  applied: Record<string, { damage?: number; healing?: number }>;
}

const derivedHp = (page: Page, actorId: string): Promise<DerivedHp | null> =>
  surfaceCallArg<DerivedHp | null>(page, "app", "pf1eDerivedHp", actorId);
const lastRoll = (page: Page): Promise<RollCard | null> =>
  hostCall<RollCard | null>(page, "pf1eLastRoll");
const cardsContaining = (page: Page, needle: string): Promise<{ count: number; first: string | null }> =>
  surfaceCallArg(page, "app", "pf1eCardsContaining", needle);

/** Type in the real chat input and wait for the host to commit a *new* roll card. */
async function chatRoll(
  host: Page,
  who: Page,
  formula: string,
  previousId: string | null,
): Promise<RollCard> {
  await who.fill("#chat-input", `/roll ${formula}`);
  await who.click("#chat-send");
  await expect
    .poll(async () => (await lastRoll(host))?.id ?? null, { timeout: 20_000 })
    .not.toBe(previousId);
  const card = await lastRoll(host);
  if (!card) throw new Error("no roll card committed");
  return card;
}

/** Click a world point on a real canvas (the selection path the table uses). */
async function clickWorld(
  page: Page,
  at: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): Promise<void> {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  await page.mouse.click(
    box.x + (at.x - camera.x) * camera.scale,
    box.y + (at.y - camera.y) * camera.scale,
  );
}

const canvasBox = async (page: Page) => {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  return box;
};

test.describe("apply / heal from a roll card (§2.2/G-20)", () => {
  test("the host's own total lands on the selected token, once per verb, and never without permission", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));

    // ── host: a player-owned hero (20 hp, 3 nonlethal) next to a GM-owned orc ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
      { id: "hero", col: 1, row: 1 },
      { id: "orc", col: 3, row: 1, owner: "gm" },
    ]);
    expect(placed).toMatchObject({ ok: true, placed: 2 });
    for (const [actorId, patch] of [
      ["a-hero", { hp: 20, hpMax: 20, nonlethalDamage: 3 }],
      ["a-orc", { hp: 12, hpMax: 12 }],
    ] as const) {
      const authored = await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
        actorId,
        patch,
      });
      expect(authored.ok).toBe(true);
    }

    // ── the GM rolls 1d4+4 in the real chat input; the host commits the card ──
    const gmCard = await chatRoll(host, host, "1d4+4", null);
    expect(gmCard.formula).toBe("1d4+4");
    expect(gmCard.total).toBeGreaterThanOrEqual(5);
    expect(gmCard.total).toBeLessThanOrEqual(8);
    expect(gmCard.applied).toEqual({});
    const gmRow = host.locator(`#chat-log .rollcard[data-mode="roll"]`).last();
    await expect(gmRow.locator(".total")).toHaveText(String(gmCard.total));

    // ── the verbs appear once the GM selects the hero on the canvas ──
    const gmCamera = await hostCall<{ x: number; y: number; scale: number } | null>(host, "camera");
    if (!gmCamera) throw new Error("no GM camera");
    await clickWorld(host, { x: 150, y: 150 }, gmCamera);
    await expect(
      host.locator(`[data-apply-message="${gmCard.id}"][data-apply-target="a-hero"]`),
    ).toBeVisible();
    await expect(host.locator(`[data-apply-damage="${gmCard.id}"]`)).toBeVisible();

    // ── damage: the host's total comes off the hero's hit points ──
    await host.click(`[data-apply-damage="${gmCard.id}"]`);
    await expect
      .poll(async () => (await derivedHp(host, "a-hero"))?.hp, { timeout: 20_000 })
      .toBe(20 - gmCard.total);
    expect(await derivedHp(host, "a-hero")).toMatchObject({
      hpMax: 20,
      nonlethalDamage: 3, // damage never touches the nonlethal ledger
    });
    await expect
      .poll(async () => (await lastRoll(host))?.applied, { timeout: 20_000 })
      .toEqual({ "a-hero": { damage: gmCard.total } });
    // the same card cannot be counted twice: the verb is spent on every replica
    await expect(host.locator(`[data-apply-damage="${gmCard.id}"]`)).toBeDisabled();
    await expect(host.locator(`[data-apply-applied="${gmCard.id}"]`)).toContainText(String(gmCard.total));
    // the host also posts the audit line, naming the applied amount and the actor it landed on
    const note = await cardsContaining(host, `applied ${gmCard.total} damage from 1d4+4`);
    expect(note.count).toBeGreaterThanOrEqual(1);
    expect(note.first).toContain("hero");

    // ── healing is a separate verb on the same card: capped at the maximum, and it removes an
    //    equal amount of nonlethal damage (CRB p.191) ──
    await host.click(`[data-apply-healing="${gmCard.id}"]`);
    await expect
      .poll(async () => (await derivedHp(host, "a-hero")) ?? null, { timeout: 20_000 })
      .toEqual({ hp: 20, hpMax: 20, tempHp: 0, nonlethalDamage: 0 });
    await expect
      .poll(async () => (await lastRoll(host))?.applied, { timeout: 20_000 })
      .toEqual({ "a-hero": { damage: gmCard.total, healing: gmCard.total } });
    await expect(host.locator(`[data-apply-healing="${gmCard.id}"]`)).toBeDisabled();

    // ── a player joins and plays the same card flow on their own hero ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(2);
    await waitForSurface(player, "playerCanvas");

    // the player's own canvas selects their hero; without a target the card offers no verb
    await player.fill("#chat-input", "/roll 1d4+4");
    await player.click("#chat-send");
    await expect
      .poll(async () => (await lastRoll(host))?.id ?? null, { timeout: 20_000 })
      .not.toBe(gmCard.id);
    const playerCard = await lastRoll(host);
    if (!playerCard) throw new Error("no player roll card");
    await expect(player.locator(`#chat-log [data-apply-damage="${playerCard.id}"]`)).toHaveCount(0);
    const playerCamera = await playerCall<{ x: number; y: number; scale: number }>(player, "camera");
    await clickWorld(player, { x: 150, y: 150 }, playerCamera);
    await expect(
      player.locator(`[data-apply-message="${playerCard.id}"][data-apply-target="a-hero"]`),
    ).toBeVisible();

    await player.click(`[data-apply-damage="${playerCard.id}"]`);
    await expect
      .poll(async () => (await derivedHp(host, "a-hero"))?.hp, { timeout: 20_000 })
      .toBe(20 - playerCard.total);
    await expect
      .poll(async () => (await lastRoll(host))?.applied, { timeout: 20_000 })
      .toEqual({ "a-hero": { damage: playerCard.total } });
    // the record replicates back: the player's own card shows what was applied
    await expect(player.locator(`[data-apply-applied="${playerCard.id}"]`)).toContainText(
      String(playerCard.total),
    );

    // ── authorization: the player can name the GM's orc, but the host refuses ──
    await surfaceCallArg<null>(player, "player", "rollApply", {
      messageId: playerCard.id,
      actorId: "a-orc",
      mode: "damage",
    });
    await expect.poll(() => derivedHp(host, "a-orc")).toMatchObject({ hp: 12 });
    expect((await lastRoll(host))?.applied["a-orc"]).toBeUndefined();

    // ── no target, no verb: an empty-canvas click takes the row away again ──
    await player.mouse.click(
      (await canvasBox(player)).x + 40,
      (await canvasBox(player)).y + 40,
    );
    await expect(player.locator(`[data-apply-message="${playerCard.id}"]`)).toHaveCount(0);

    expect(errors).toEqual([]);
    await hostCtx.close();
    await playerCtx.close();
  });
});
