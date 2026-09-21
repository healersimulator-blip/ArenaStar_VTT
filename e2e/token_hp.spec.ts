/**
 * §2.2 item 1 (G-10a, D-261) — token hit-point bars, end to end through the real UI.
 *
 * The bar is the sheet's own derivation rendered under the token: the GM sees it by default, a
 * table can opt into "everyone" or "on hover" through the Settings window, and a player's canvas
 * follows the *replicated* world setting — read back from their own stage, never from the GM's
 * component state. The orc takes real damage through its character sheet (`[data-pf1e-field="hp"]`
 * → the sheet's own op), and both the host replica's derivation and the GM's canvas label must
 * agree on the new number, which is the whole point of driving the bar from the derivation instead
 * of a second bookkeeping.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  gmCall,
  hostCall,
  manualFragment,
  playerCall,
  surfaceCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface HpBarReadback {
  id: string;
  hp: number;
  hpMax: number;
  tempHp: number;
  nonlethalDamage: number;
  label: string;
}

interface DerivedHp {
  hp: number;
  hpMax: number;
  tempHp: number;
  nonlethalDamage: number;
}

const gmBars = (page: Page): Promise<HpBarReadback[]> => gmCall<HpBarReadback[]>(page, "tokenHpBars");
const playerBars = (page: Page): Promise<HpBarReadback[]> =>
  surfaceCall<HpBarReadback[]>(page, "playerCanvas", "tokenHpBars");
const derivedHp = (page: Page, actorId: string): Promise<DerivedHp | null> =>
  surfaceCallArg<DerivedHp | null>(page, "app", "pf1eDerivedHp", actorId);

const canvasBox = async (page: Page) => {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  return box;
};

test.describe("token hit-point bars (§2.2/G-10a)", () => {
  test("the derived bar follows a real sheet edit, and the world setting decides who sees it", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(180_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));

    // ── host: a party hero and a GM-owned orc, both with authored hit points ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
      { id: "hero", col: 1, row: 1 },
      { id: "orc", col: 3, row: 1, owner: "gm" },
    ]);
    expect(placed).toMatchObject({ ok: true, placed: 2 });
    for (const [id, hp] of [
      ["a-hero", 10],
      ["a-orc", 12],
    ] as const) {
      const authored = await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
        actorId: id,
        patch: { hp, hpMax: hp },
      });
      expect(authored.ok).toBe(true);
    }

    // ── the GM's canvas draws both bars, from the derivation, with the sheet's numbers ──
    await expect
      .poll(async () => (await gmBars(host)).map((b) => `${b.id} ${b.label}`))
      .toEqual(["hero 10/10", "orc 12/12"]);
    expect((await gmBars(host))[0]).toMatchObject({ hp: 10, hpMax: 10, tempHp: 0, nonlethalDamage: 0 });
    expect(await derivedHp(host, "a-orc")).toEqual({ hp: 12, hpMax: 12, tempHp: 0, nonlethalDamage: 0 });

    // ── the orc takes 8 damage through its own sheet ──
    await host.click('[data-tab="actors"]');
    const orcRow = host.locator("#sheet-list .sheet-row").filter({ hasText: "orc (actor)" });
    await orcRow.click();
    await host.click("[data-open-pf1e-sheet]");
    const sheet = host.locator(".wm-window [data-pf1e-sheet]");
    await expect(sheet).toBeVisible();
    // the hp editor lives on the combat/attributes tabs, not on the sheet's summary default
    await sheet.getByRole("button", { name: "combat", exact: true }).click();
    const hpField = sheet.locator('[data-pf1e-field="hp"]');
    await hpField.fill("4");
    await hpField.dispatchEvent("change");
    await expect.poll(async () => (await derivedHp(host, "a-orc"))?.hp).toBe(4);
    await expect.poll(async () => (await gmBars(host)).map((b) => b.label)).toEqual(["10/10", "4/12"]);

    // ── a player joins; the default setting keeps monster hit points off their canvas ──
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
    // the tokens are drawn — the bar is a presentation layer, not a visibility gate
    expect(await surfaceCall<string[]>(player, "playerCanvas", "drawnTokens")).toEqual(["hero", "orc"]);
    expect((await hostCall<Record<string, unknown>>(host, "pf1eWorldSettings")).tokenHpBars).toBeUndefined();
    expect(await playerBars(player)).toEqual([]);

    // ── "Everyone" through the real Settings select: the player's canvas follows the replica.
    //    The hero's actor is player-owned, so its bar reaches them; the orc's actor is GM-only,
    //    which the projection withholds — no setting can hand over hit points the replica does
    //    not hold, and the bar has nothing to derive from. ──
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    const modeSelect = settings.locator("[data-world-token-hp-bars]");
    await expect(modeSelect).toBeVisible();
    await modeSelect.selectOption("all");
    await expect
      .poll(async () => (await hostCall<Record<string, unknown>>(host, "pf1eWorldSettings")).tokenHpBars)
      .toBe("all");
    await expect
      .poll(async () => (await playerBars(player)).map((b) => `${b.id} ${b.label}`))
      .toEqual(["hero 10/10"]);
    await expect
      .poll(async () => (await gmBars(host)).map((b) => `${b.id} ${b.label}`))
      .toEqual(["hero 10/10", "orc 4/12"]);

    // ── "On hover": the player's canvas draws nothing until the pointer stands on a token ──
    await modeSelect.selectOption("hover");
    await expect
      .poll(async () => (await hostCall<Record<string, unknown>>(host, "pf1eWorldSettings")).tokenHpBars)
      .toBe("hover");
    await expect.poll(async () => (await playerBars(player)).length).toBe(0);
    const box = await canvasBox(player);
    const camera = await playerCall<{ x: number; y: number; scale: number }>(player, "camera");
    const at = (world: { x: number; y: number }) => ({
      x: box.x + (world.x - camera.x) * camera.scale,
      y: box.y + (world.y - camera.y) * camera.scale,
    });
    const heroAt = at({ x: 150, y: 150 }); // the hero's token centre (col 1, row 1, 100 px grid)
    const orcAt = at({ x: 350, y: 150 }); // the orc's token centre (col 3, row 1)
    const emptyAt = at({ x: 600, y: 400 });
    await player.mouse.move(heroAt.x, heroAt.y);
    await expect.poll(async () => (await playerBars(player)).map((b) => b.id)).toEqual(["hero"]);
    expect((await playerBars(player))[0]).toMatchObject({ hp: 10, hpMax: 10, label: "10/10" });
    // the orc's token is drawn but carries no bar: its actor never left the GM's replica
    await player.mouse.move(orcAt.x, orcAt.y);
    await expect.poll(async () => (await playerBars(player)).length).toBe(0);
    // off the tokens again — a hover bar is a pointer fact and disappears with it
    await player.mouse.move(emptyAt.x, emptyAt.y);
    await expect.poll(async () => (await playerBars(player)).length).toBe(0);

    // ── "hover" is the same rule on the GM's own canvas, and back to the default the GM is the
    //    only one drawing bars again ──
    await expect.poll(async () => (await gmBars(host)).length).toBe(0);
    await modeSelect.selectOption("gm");
    await expect
      .poll(async () => (await playerBars(player)).length, { timeout: 20_000 })
      .toBe(0);
    await expect
      .poll(async () => (await gmBars(host)).map((b) => b.id))
      .toEqual(["hero", "orc"]);

    expect(errors).toEqual([]);
    await hostCtx.close();
    await playerCtx.close();
  });
});
