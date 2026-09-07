import { expect, test, type Page } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

/**
 * §5A realtime mode end-to-end: GM starts a realtime campaign, the host clock
 * ticks at 5 Hz with coalesced delta flushes and 1 Hz reports, models move
 * along their orders, the client interpolates positions between flushes,
 * pause freezes the sim (with a tick checkpoint) and resume/rate adjust the
 * clock live.
 */

const gmCall = <T>(page: Page, method: string, args?: unknown[]): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (globalThis as { __vttE2E?: { gm?: Record<string, (...x: unknown[]) => T> } })
        .__vttE2E;
      const fn = surface?.gm?.[m];
      if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
      return fn(...(a ?? []));
    },
    { m: method, a: args ?? [] },
  );

interface RealtimeInfo {
  running: boolean;
  phase: string;
  simHz: number;
  flushHz: number;
  tick: number;
  ticksTotal: number;
  deltaFrames: number;
  coalescedMax: number;
  reports: number;
  checkpoints: number;
  version: number;
  pushes: number;
  interpolatedMoves: number;
  interpolating: boolean;
  replicaVersion: number;
  models: number;
  probeRaw: [number, number] | null;
  probeSampled: [number, number] | null;
}

test.describe("realtime mode (§5A)", () => {
  test("5 Hz ticks, coalesced flushes, 1 Hz reports, interpolation, pause/resume/rate", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = (globalThis as { __vttE2E?: { gm?: Record<string, () => unknown> } }).__vttE2E;
          return typeof s?.gm?.["realtimeInfo"] === "function";
        }),
      )
      .toBe(true);

    // ── world: one faction, one army of 12 models ──────────────────────────
    await page.click("#gm-extras");
    const win = page.locator('[data-window="gmextras"]');
    await expect(win).toBeVisible();
    await page.fill("#faction-name", "Ironhost");
    await page.click("#faction-create");
    await expect
      .poll(() => gmCall<{ factions: number }>(page, "armySnapshot").then((s) => s.factions))
      .toBe(1);
    const spawnFaction = win.locator("[data-spawn-faction]");
    await spawnFaction.selectOption({ index: 0 });
    await page.fill("[data-spawn-name]", "Vanguard");
    await page.fill("[data-spawn-count]", "12");
    await page.click("#mass-spawn");
    await expect
      .poll(() => gmCall<{ units: number }>(page, "armySnapshot").then((s) => s.units))
      .toBe(1);

    // point the unit across the map so movement runs for the whole test
    const order = await gmCall<{ ok: boolean; unitId: string | null }>(
      page,
      "setFirstUnitMoveOrder",
      [4000, 4000],
    );
    expect(order.ok).toBe(true);

    // ── start realtime ─────────────────────────────────────────────────────
    await page.click("#campaign-start-rt");
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.running), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.models))
      .toBe(12);

    // ~3 s: ≥8 ticks at 5 Hz, ≥3 coalesced delta frames, ≥1 report
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.ticksTotal), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(8);
    const mid = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    expect(mid.deltaFrames).toBeGreaterThanOrEqual(3);
    expect(mid.reports).toBeGreaterThanOrEqual(1);
    expect(mid.replicaVersion).toBeGreaterThanOrEqual(8); // replica applied flushes

    // models actually moved toward the waypoint
    const probe1 = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    expect(probe1.probeRaw).not.toBeNull();
    await page.waitForTimeout(1_200);
    const probe2 = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    expect(probe2.probeRaw).not.toBeNull();
    const moved =
      Math.abs((probe2.probeRaw?.[0] ?? 0) - (probe1.probeRaw?.[0] ?? 0)) +
      Math.abs((probe2.probeRaw?.[1] ?? 0) - (probe1.probeRaw?.[1] ?? 0));
    expect(moved).toBeGreaterThan(0.5); // ≥1 grid unit over 1.2 s at 5 u/s

    // client-side interpolation sampled mid-interval positions
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.interpolatedMoves))
      .toBeGreaterThanOrEqual(1);

    // ── pause: clock freezes, chip shows paused, a tick checkpoint lands ──
    await page.click("#campaign-pause");
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.running))
      .toBe(false);
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.checkpoints))
      .toBeGreaterThanOrEqual(1);
    const frozen = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    await page.waitForTimeout(1_200);
    const still = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    expect(still.ticksTotal).toBe(frozen.ticksTotal);
    expect(still.version).toBe(frozen.version);
    await expect(page.locator("[data-campaign-phase]")).toContainText("paused");

    // ── resume + live rate change ──────────────────────────────────────────
    await page.click("#campaign-resume");
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.running))
      .toBe(true);
    await page.selectOption("#campaign-rate", "10");
    await expect
      .poll(() => gmCall<RealtimeInfo>(page, "realtimeInfo").then((s) => s.simHz))
      .toBe(10);
    const resumed = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    await page.waitForTimeout(1_500);
    const faster = await gmCall<RealtimeInfo>(page, "realtimeInfo");
    expect(faster.ticksTotal - resumed.ticksTotal).toBeGreaterThanOrEqual(10); // ~15 at 10 Hz
  });
});
