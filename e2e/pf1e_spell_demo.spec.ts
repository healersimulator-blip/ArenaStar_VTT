/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  manualFragment,
  playerCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
const starterZip = (): string => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((candidate) => /^pf1e-mass-battles-starter-.*\.zip$/.test(candidate));
  if (!name) throw new Error("no PF1e starter world under dist/worlds — run `pnpm build:worlds` first");
  return join(distWorlds, name);
};

const assetHash = (path: string): string =>
  createHash("sha256").update(readFileSync(fileURLToPath(new URL(path, import.meta.url)))).digest("hex");
const lightningCrosshairHash = assetHash("../Assets/VisualEffects/Crosshair_Line_Generic_01_White_90ft.webm");
const lightningEffectHash = assetHash("../Assets/VisualEffects/Lightning_Bolt_Blue_90ft.webm");
const entangleCrosshairHash = assetHash("../Assets/VisualEffects/Crosshair_Circle_Fantasy_01_White_30ft.webm");
const entangleAreaHash = assetHash("../Assets/VisualEffects/Nature_Vine_Normal_Circle_01_Physical_Green_30ft.webm");
const entangledVinesHash = assetHash("../Assets/VisualEffects/Nature_Vine_Normal_Token_01_Physical_Green.webm");

async function importStarter(page: Page): Promise<void> {
  await page.setInputFiles("#role-import", starterZip());
  const dialog = page.locator("[data-open-dialog]");
  await expect(dialog).toHaveAttribute("data-open-kind", "world");
  await dialog.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText("Mass Battles", { timeout: 60_000 });
}

function screenPoint(
  box: { x: number; y: number },
  point: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): { x: number; y: number } {
  return {
    x: box.x + (point.x - camera.x) * camera.scale,
    y: box.y + (point.y - camera.y) * camera.scale,
  };
}

async function worldScreenPoint(
  page: Page,
  point: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): Promise<{ x: number; y: number }> {
  // Use the mounted canvas's own e2e projection so browser zoom, CSS offsets, and
  // canvas layout cannot make the pointer land beside the Pixi overlay.
  const screen = await surfaceCallArg<{ x: number; y: number } | null>(
    page, "playerCanvas", "screenOf", point,
  );
  if (screen) return screen;
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  return screenPoint(box, point, camera);
}

async function moveWorld(
  page: Page,
  point: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): Promise<void> {
  const screen = await worldScreenPoint(page, point, camera);
  await page.mouse.move(screen.x, screen.y);
}

async function clickWorld(
  page: Page,
  point: { x: number; y: number },
  camera: { x: number; y: number; scale: number },
): Promise<void> {
  const screen = await worldScreenPoint(page, point, camera);
  await page.mouse.click(screen.x, screen.y);
}

async function waitForFxVisual(page: Page, expectedScale: number | null = null): Promise<void> {
  const handle = await page.waitForFunction((scale) => {
    const global = window as unknown as {
      __stage?: { getFxLayer?: () => { count?: number; inspect?: () => Array<{ scale: number }> } };
      __canvasStage?: { getFxLayer?: () => { count?: number; inspect?: () => Array<{ scale: number }> } };
    };
    const stage = global.__stage ?? global.__canvasStage;
    const layer = stage?.getFxLayer?.();
    if (!layer) return false;
    return scale === null
      ? (layer.count ?? 0) > 0
      : (layer.inspect?.() ?? []).some((visual) => Math.abs(visual.scale - scale) < 0.005);
  }, expectedScale, { timeout: expectedScale === null ? 10_000 : 20_000 });
  await handle.dispose();
}

const fxVisualsForRun = (page: Page, runId: string): Promise<number> => page.evaluate((id) => {
  const global = globalThis as unknown as {
    __stage?: { getFxLayer?: () => { inspect?: (runId?: string) => unknown[] } };
    __canvasStage?: { getFxLayer?: () => { inspect?: (runId?: string) => unknown[] } };
  };
  const stage = global.__stage ?? global.__canvasStage;
  return stage?.getFxLayer?.().inspect?.(id).length ?? 0;
}, runId);

test.describe("JungleEntrance2 spell demo in the browser", () => {
  test("players aim and cast Lightning Bolt and Entangle through the live canvas", async ({ browser }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const [label, page] of [["host", host], ["player", player]] as const)
      page.on("pageerror", (error) => errors.push(`${label}: ${error.stack ?? String(error)}`));

    try {
      // Import the built starter, then explicitly open its separate demonstration scene.
      // e2e=1 installs the same readback hooks used by other browser specs; close its disposable
      // empty table first so the real archive can be imported through the visible start screen.
      await host.goto(entry + "?e2e=1");
      await waitForSurface(host, "app");
      await host.click("#close-world");
      await importStarter(host);
      const demoScene = host.locator('[data-scene="scene-jungle"]');
      await expect(demoScene).toBeVisible();
      await demoScene.click();
      await expect(demoScene).toHaveClass(/active/);
      await expect(host.locator("#status")).toContainText("tokens 7");

      // Make failed saves deterministic for the browser acceptance of Entangle's condition rider.
      for (const actorId of ["hobgoblin-fighter-1", "hobgoblin-fighter-2", "hobgoblin-fighter-3",
        "troll", "tyrannosaur"]) {
        const authored = await surfaceCallArg<{ ok: boolean; error: string | null }>(
          host, "app", "pf1eAuthorActor", { actorId,
            patch: { saves: { fort: 0, ref: -100, will: 0 }, savesAsTotal: true } },
        );
        expect(authored.ok, authored.error ?? "enemy save fixture was refused").toBe(true);
      }

      // A real player joins; their two controlled character tokens drive the same quickbar.
      await host.click("#share");
      const inviteLink = await host.locator("#invite-link").inputValue();
      await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
      await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
      await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
      await host.click("#code-apply");
      await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
      await player.fill("#answer-input", await host.locator("#share-out").inputValue());
      await player.click("#answer-apply");
      await waitForSurface(player, "playerCanvas");
      await expect(player.locator('[data-quickbar-actor="hosilla"]')).toBeVisible({ timeout: 20_000 });

      // Hosilla: first click opens aiming mode. It does not spend the third-level slot or damage.
      await expect(player.locator('[data-quickbar-actor="hosilla"]')).toBeVisible();
      const hpBefore = await surfaceCallArg<{ hp: number } | null>(host, "app", "pf1eDerivedHp", "hobgoblin-fighter-1");
      const hpBeforeTwo = await surfaceCallArg<{ hp: number } | null>(host, "app", "pf1eDerivedHp", "hobgoblin-fighter-2");
      const hpBeforeThree = await surfaceCallArg<{ hp: number } | null>(host, "app", "pf1eDerivedHp", "hobgoblin-fighter-3");
      const hosillaBefore = await surfaceCallArg<Record<string, unknown> | null>(
        host, "app", "pf1eActorSystem", "hosilla");
      expect(hpBefore).not.toBeNull();
      expect(((hosillaBefore?.spells as Record<string, unknown>)?.slotsUsed as Record<string, number>)?.["3"] ?? 0)
        .toBe(0);
      await player.click('[data-quickbar-slot="1"]');
      const lineAim = player.locator('[data-crosshair][data-crosshair-label*="Lightning Bolt"]');
      await expect(lineAim).toBeVisible();
      await expect.poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", lightningCrosshairHash),
        { timeout: 20_000 }).toBe(true);
      await expect(lineAim.locator("[data-crosshair-media]")).toHaveCount(1, { timeout: 5_000 });
      await expect.poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", lightningEffectHash),
        { timeout: 15_000 }).toBe(true);
      const camera = await playerCall<{ x: number; y: number; scale: number }>(player, "camera");
      // Hovering previews a 30° snapped line through all three Hobgoblin footprints; the
      // following canvas click is the second click (after the spell button) and confirms it.
      const aimPoint = await worldScreenPoint(player, { x: 650, y: 550 }, camera);
      await player.mouse.move(aimPoint.x, aimPoint.y);
      await expect(lineAim.locator("[data-crosshair-area]")).toBeVisible();
      await expect(lineAim.locator("[data-crosshair-readout]")).toBeVisible({ timeout: 5_000 });
      await expect(lineAim.locator("[data-crosshair-angle]")).toHaveText("30°");
      expect(await surfaceCallArg<{ hp: number } | null>(host, "app", "pf1eDerivedHp", "hobgoblin-fighter-1"))
        .toMatchObject({ hp: hpBefore?.hp });
      expect(((await surfaceCallArg<Record<string, unknown> | null>(
        host, "app", "pf1eActorSystem", "hosilla"))?.spells as Record<string, unknown>)?.slotsUsed)
        .toMatchObject({ "3": 0 });
      const hostLightningPlayback = waitForFxVisual(host);
      const playerLightningPlayback = waitForFxVisual(player);
      await clickWorld(player, { x: 650, y: 550 }, camera);
      await Promise.all([hostLightningPlayback, playerLightningPlayback]);
      await expect(player.locator("[data-quickbar-status]")).toContainText("Lightning Bolt — 90-ft line", { timeout: 30_000 });
      await expect.poll(() => hostCall(host, "lastFxCue"), { timeout: 5_000 })
        .toMatchObject({ macroId: "macro-lightning-bolt-effect" });
      await expect.poll(() => playerCall(player, "lastFxCue"), { timeout: 5_000 })
        .toMatchObject({ macroId: "macro-lightning-bolt-effect" });
      const boltCard = await hostCall<{ action: Record<string, unknown> } | null>(host, "pf1eLastActionCard");
      await expect.poll(async () => (await surfaceCallArg<{ hp: number } | null>(
        host, "app", "pf1eDerivedHp", "hobgoblin-fighter-1"))?.hp ?? 11).toBeLessThan(hpBefore?.hp ?? 11);
      await expect.poll(async () => (await surfaceCallArg<{ hp: number } | null>(
        host, "app", "pf1eDerivedHp", "hobgoblin-fighter-2"))?.hp ?? 11).toBeLessThan(hpBeforeTwo?.hp ?? 11);
      await expect.poll(async () => (await surfaceCallArg<{ hp: number } | null>(
        host, "app", "pf1eDerivedHp", "hobgoblin-fighter-3"))?.hp ?? 11).toBeLessThan(hpBeforeThree?.hp ?? 11);
      expect(boltCard?.action).toMatchObject({ label: "Lightning Bolt", area: { shape: "line", length: 90, width: 5 },
        targets: [expect.objectContaining({ provenance: "host", state: "resolved" })] });

      // Vacorg is the second player-controlled character. Selecting his token changes the bar,
      // and the supplied 30-ft circle is shown at the requested 40-ft radius before confirmation.
      await clickWorld(player, { x: 450, y: 350 }, camera);
      await expect(player.locator('[data-quickbar-actor="vacorg"]')).toBeVisible();
      await player.click('[data-quickbar-slot="1"]');
      const entangleAim = player.locator('[data-crosshair][data-crosshair-label*="Entangle"]');
      await expect(entangleAim).toBeVisible();
      await expect.poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", entangleCrosshairHash),
        { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => {
        const [areaReady, vinesReady] = await Promise.all([
          surfaceCallArg<boolean>(player, "player", "cacheHas", entangleAreaHash),
          surfaceCallArg<boolean>(player, "player", "cacheHas", entangledVinesHash),
        ]);
        return areaReady && vinesReady;
      }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
      // Entangle's origin is the hovered point, so the 30-ft supplied media has no
      // bounds to stretch into the 40-ft preview until the player moves over the map.
      await moveWorld(player, { x: 750, y: 550 }, camera);
      await expect(entangleAim.locator("[data-crosshair-area]")).toBeVisible();
      await expect(entangleAim.locator("[data-crosshair-media]")).toHaveCount(1, { timeout: 5_000 });
      await expect(entangleAim.locator("[data-crosshair-length]")).toHaveValue("40");
      // The click after the spell-button click confirms the 40-ft circle and starts the cast.
      const hostEntangleAreaPlayback = waitForFxVisual(host, 1.333);
      const playerEntangleAreaPlayback = waitForFxVisual(player, 1.333);
      await clickWorld(player, { x: 750, y: 550 }, camera);
      await Promise.all([
        hostEntangleAreaPlayback,
        playerEntangleAreaPlayback,
        expect(player.locator("[data-quickbar-status]")).toContainText(
          "Entangle — 40-ft-radius spread", { timeout: 30_000 }),
      ]);
      await expect.poll(() => hostCall(host, "lastFxCue"), { timeout: 5_000 })
        .toMatchObject({ macroId: "macro-entangle-area" });
      await expect.poll(() => playerCall(player, "lastFxCue"), { timeout: 5_000 })
        .toMatchObject({ macroId: "macro-entangle-area" });

      const entangleCard = await hostCall<{ messageId: string; action: {
        label: string;
        area?: { shape: string; radius?: number; units?: string };
        targets: Array<{ key: string; outcome: string; provenance?: string }>;
      } } | null>(host, "pf1eLastActionCard");
      expect(entangleCard?.action).toMatchObject({ label: "Entangle",
        area: { shape: "spread", radius: 40, units: "ft" } });
      // D-408 — one card carries every affected footprint as its own host-verified row.
      expect(entangleCard?.action.targets.length).toBeGreaterThanOrEqual(2);
      expect(entangleCard?.action.targets.every((row) => row.provenance === "host")).toBe(true);
      // D-408 — the zone derives atomically with its card: catalogue duration × Vacorg's CL 6.
      await expect.poll(async () => (await surfaceCallArg<Array<{ id: string }>>(
        host, "app", "pf1eSpellAreas", "scene-jungle")).length, { timeout: 10_000 }).toBe(1);
      const zones = await surfaceCallArg<Array<{
        id: string; effectId: string; actionId: string; sceneId: string; casterActorId: string;
        dc: number; casterLevel: number; spellLevel: number;
        origin: { x: number; y: number }; radiusFt: number;
        startsAt: number; endsAt: number; difficultTerrain: boolean;
      }>>(host, "app", "pf1eSpellAreas", "scene-jungle");
      expect(zones[0]).toMatchObject({ id: `spellarea-${entangleCard?.messageId}`,
        effectId: "entangle", actionId: entangleCard?.messageId, sceneId: "scene-jungle",
        casterActorId: "vacorg", dc: 15, casterLevel: 6, spellLevel: 1,
        radiusFt: 40, difficultTerrain: true });
      expect(zones[0]!.endsAt - zones[0]!.startsAt).toBe(6 * 60_000);
      const macros = JSON.parse(await hostCall<string>(host, "worldMacros")) as Array<{
        _id: string;
        sequence?: { sections?: Array<{ scale?: number }> };
      }>;
      expect(macros.find((macro) => macro._id === "macro-entangle-area")?.sequence?.sections?.[0]?.scale)
        .toBeCloseTo(4 / 3, 2);
      const conditionApps = await surfaceCallArg<Array<{
        id: string;
        condition: string;
        removal: string;
      }>>(host, "app", "pf1eConditionApps", "hobgoblin-fighter-1");
      const entangled = conditionApps.find((application) => application.condition === "Entangled");
      expect(entangled, "failed save should apply Entangled to Hobgoblin Fighter 1").toBeDefined();
      expect(entangled?.removal).toBe("manual");
      const vine = (await hostCall<Array<{
        id: string;
        macroId: string;
        targetTokenId: string | null;
        conditionApplicationId: string | null;
      }>>(host, "fxInstances")).find((instance) =>
        instance.conditionApplicationId === entangled?.id);
      expect(vine, "Entangled condition should own a persistent token-vine FX instance")
        .toMatchObject({ macroId: "macro-entangled-vines", targetTokenId: "tok-hobgoblin-1" });
      await expect.poll(() => fxVisualsForRun(host, vine!.id),
        { timeout: 5_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
      await expect.poll(() => fxVisualsForRun(player, vine!.id),
        { timeout: 5_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);

      // Remove the condition through the real GM actor-sheet control, then verify that
      // its exact host-owned instance and the attached video visual stop on both clients.
      await host.getByRole("button", { name: "Actors", exact: true }).click();
      const goblinRow = host.locator("#sheet-list .sheet-row")
        .filter({ hasText: "Hobgoblin Fighter 1" });
      await expect(goblinRow).toBeVisible();
      await goblinRow.click();
      const actorSheet = host.locator("[data-pf1e-sheet]");
      await actorSheet.getByRole("button", { name: "effects", exact: true }).click();
      const conditionRow = actorSheet.locator(`[data-pf1e-condition-app="${entangled!.id}"]`);
      await expect(conditionRow).toContainText("Entangled");
      await conditionRow.getByRole("button", { name: "Remove condition", exact: true }).click();
      await expect.poll(() => surfaceCallArg<Array<{ id: string }>>(
        host, "app", "pf1eConditionApps", "hobgoblin-fighter-1"),
      { timeout: 10_000 }).toEqual([]);
      await expect.poll(async () => (await hostCall<Array<{ id: string }>>(host, "fxInstances"))
        .some((instance) => instance.id === vine!.id), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => fxVisualsForRun(host, vine!.id),
        { timeout: 10_000, intervals: [25, 50, 100] }).toBe(0);
      await expect.poll(() => fxVisualsForRun(player, vine!.id),
        { timeout: 10_000, intervals: [25, 50, 100] }).toBe(0);
      expect(errors, "no browser runtime errors").toEqual([]);
    } finally {
      await playerCtx.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});
