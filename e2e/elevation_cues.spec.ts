/**
 * G-32 (D-440): token elevation cues through the real UI. The GM lifts a token from its menu, every
 * canvas draws the height badge, the optional size cue shrinks tokens at other heights relative to
 * the player's selected token, and the world setting can hide the cues from players or turn them off.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Stage } from "../src/canvas/stage";
import { entry, gmCall, hostCall, manualFragment, playerCall, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

type Cue = { id: string; label: string | null; scale: number };
const gmCues = (page: Page) => gmCall<Cue[]>(page, "tokenElevationCues");
const playerCues = (page: Page) => surfaceCall<Cue[]>(page, "playerCanvas", "tokenElevationCues");
const screenOf = (page: Page, x: number, y: number) => page.evaluate(([wx, wy]) => {
  const stage = (globalThis as unknown as { __stage: Stage }).__stage;
  const rect = stage.app.canvas.getBoundingClientRect();
  return { x: rect.left + ((wx ?? 0) - stage.camera.x) * stage.camera.scale, y: rect.top + ((wy ?? 0) - stage.camera.y) * stage.camera.scale };
}, [x, y]);

test("elevation badges, the size cue and who sees them", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext(), playerCtx = await browser.newContext();
  const host = await hostCtx.newPage(), player = await playerCtx.newPage();
  const errors: string[] = [];
  for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));

  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "gm");
  expect(await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1ePlaceTokens", [
    { id: "hero", col: 1, row: 1 }, { id: "orc", col: 3, row: 1, owner: "gm" },
  ])).toMatchObject({ ok: true });
  await expect.poll(async () => (await gmCues(host)).map((c) => c.id)).toEqual(["hero", "orc"]);
  expect((await gmCues(host)).every((c) => c.label === null && c.scale === 1)).toBe(true);

  // The GM lifts the orc 15 ft from its token menu (a scene without floors: height above the ground).
  const orcAt = await screenOf(host, 350, 150);
  await host.mouse.click(orcAt.x, orcAt.y, { button: "right" });
  const menu = host.locator('[data-token-menu="orc"]'); await expect(menu).toBeVisible();
  const feet = menu.getByLabel("Token feet elevation", { exact: true });
  await feet.fill("15"); await feet.press("Tab");
  await expect.poll(async () => (await gmCues(host)).find((c) => c.id === "orc")?.label).toBe("+15 ft");
  await host.keyboard.press("Escape");

  // A player joins and sees the badge (the default is "everyone").
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
  await expect.poll(async () => await playerCues(player)).toEqual([
    { id: "hero", label: null, scale: 1 }, { id: "orc", label: "+15 ft", scale: 1 },
  ]);

  // The GM turns on the size cue; the player's selected hero is the reference height.
  await host.click("#gm-settings");
  const settings = host.locator('[data-window="settings"]');
  await settings.locator("[data-world-token-elevation-scale]").check();
  await expect.poll(async () => (await hostCall<Record<string, unknown>>(host, "pf1eWorldSettings")).tokenElevationScale).toBe(true);
  const box = await player.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("player canvas not mounted");
  const camera = await playerCall<{ x: number; y: number; scale: number }>(player, "camera");
  await player.mouse.click(box.x + (150 - camera.x) * camera.scale, box.y + (150 - camera.y) * camera.scale);
  await expect.poll(async () => (await playerCues(player)).find((c) => c.id === "orc")?.scale).toBe(0.769);
  expect((await playerCues(player)).find((c) => c.id === "hero")?.scale).toBe(1);

  // "GM only" hides every cue from the player (the size included); the GM keeps the badge.
  await settings.locator("[data-world-token-elevation]").selectOption("gm");
  await expect.poll(async () => await playerCues(player)).toEqual([
    { id: "hero", label: null, scale: 1 }, { id: "orc", label: null, scale: 1 },
  ]);
  expect((await gmCues(host)).find((c) => c.id === "orc")?.label).toBe("+15 ft");
  // "Off" removes the GM's badge too.
  await settings.locator("[data-world-token-elevation]").selectOption("off");
  await expect.poll(async () => (await gmCues(host)).find((c) => c.id === "orc")?.label ?? null).toBeNull();

  expect(errors).toEqual([]);
  await hostCtx.close(); await playerCtx.close();
});
