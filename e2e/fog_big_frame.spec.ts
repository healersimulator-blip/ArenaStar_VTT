/**
 * D-488 — transport frame hardening, the user-visible half.
 *
 * One WebRTC user message caps at 256 KiB and `dc.send` throws above it, which used to kill the
 * session. `fog.state` answers a player's `fog.get` with that player's whole stored explored map
 * — a payload the host accepts up to 1 MiB (`MAX_FOG_PNG_BYTES`), i.e. already 4× the wire cap
 * before this fix. The D-487 module-profile defect was the same shape; this spec pins the fog
 * path that a real table hits: a player whose explored map is larger than one user message
 * reconnects, and the map arrives intact instead of dropping the connection.
 *
 * The general transport proof (any frame, both directions, ordered + unordered channels) lives
 * in `e2e/webrtc.spec.ts` → `runWebrtcLoopback().shard`.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, gmCall, manualFragment, playerCall, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

const CAP = 256 * 1024;
/** Comfortably over the per-message cap, and under the 1 MiB the host accepts for a stored map. */
const BIG_BYTES = 600 * 1024;

/** Manual signalling, as in ais_player.spec.ts / e2e/join.spec.ts. */
async function joinPlayer(gm: Page, player: Page): Promise<void> {
  await gm.locator("#share").click();
  const fragment = manualFragment(await gm.locator("#invite-link").inputValue());
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 30_000 }).not.toBe("");
  await gm.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
  await gm.locator("#code-apply").click();
  await expect.poll(() => gm.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await player.locator("#answer-input").fill(await gm.locator("#share-out").inputValue());
  await player.locator("#answer-apply").click();
  await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
  await waitForSurface(player, "playerCanvas");
}

// The fog loop lives on the player's canvas surface (as in fog_player.spec.ts).
const playerFog = (player: Page) =>
  surfaceCall<{ sceneId: string | null; restored: boolean; restoredBytes: number; enabled: boolean }>(
    player,
    "playerCanvas",
    "fogState",
  );

test("a stored explored map larger than one WebRTC user message reaches the player intact", async ({ browser }) => {
  test.setTimeout(300_000);
  const gmContext = await browser.newContext();
  const playerContext = await browser.newContext();
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  try {
    // ── GM: world open, fog still OFF (the default) ──
    await gm.goto(entry + "?e2e=1");
    await waitForSurface(gm, "gm");

    // ── a player joins ──
    await joinPlayer(gm, player);
    const playerId = await playerCall<string>(player, "userId");
    expect(playerId).not.toBe("");
    expect((await playerFog(player)).enabled).toBe(false);

    // ── seed a stored explored map for that player that no single user message can carry ──
    const seeded = await surfaceCallArg<number>(gm, "gm", "fogSeedBig", {
      sceneId: "scene-1",
      userId: playerId,
      bytes: BIG_BYTES,
    });
    expect(seeded).toBeGreaterThan(CAP);
    // The host's own store holds it — exactly the bytes fog.get must answer with.
    await expect.poll(
      async () =>
        surfaceCallArg<number>(gm, "gm", "fogStoredBytesFor", { sceneId: "scene-1", userId: playerId }),
      { timeout: 15_000 },
    ).toBe(seeded);

    // ── fog ON: the player enters the explored map for the first time and asks for it ──
    // Switching the scene switch replicates the scene update, the player's fog loop enters the
    // scene, and `fog.get` is answered with the oversized stored map. Before D-488 that frame
    // exceeded the per-message cap, `dc.send` threw and the session died.
    await gm.locator("#gm-settings").click();
    const settings = gm.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-scene-fog]").check();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(gm, "fogState")).enabled).toBe(true);
    // It arrives as shard envelopes and reassembles to the exact stored bytes.
    await expect.poll(() => playerFog(player).then((s) => s.restoredBytes), { timeout: 30_000 }).toBe(seeded);
    expect((await playerFog(player)).restored).toBe(true);

    // The connection survived the oversized frame — the symptom of the bug was a dead session.
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => playerCall<{ txId: string } | null>(player, "lastRejected")).toBeNull();
    // The big map is a real explored map as far as the player is concerned, not a broken blob.
    const restored = await playerFog(player);
    expect(restored.sceneId).toBe("scene-1");
    expect(restored.enabled).toBe(true);
  } finally {
    await gmContext.close();
    await playerContext.close();
  }
});
