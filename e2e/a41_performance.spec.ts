import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { A41RuntimeSnapshot } from "../src/app/e2eHook";
import { entry, hostCall, surfaceCallArg, surfaceCallArgs, solidPng, waitForSurface } from "./lib";

const FX_PARTITION = [15, 15, 15, 15, 15, 15, 10] as const;
const FIXTURE = {
  effects: 100,
  taggedPlaceables: 1_000,
  tokens: 800,
  activeTiles: 200,
  longGraphSteps: 600,
  simpleTriggerRuns: 100,
  fxCycles: 50,
};
const BUDGETS = {
  visibleFrameP95Ms: 50,
  simpleTriggerDispatchP95Ms: 100,
  stabilizedHeapRatio: 1.1,
};

interface A41ReferenceProfile {
  schemaVersion: 1;
  id: string;
  publishedAt: string;
  hardware: {
    deviceId: string;
    cpuModel: string;
    systemMemoryGiB: number;
    logicalCpuThreads: number;
  };
  browser: {
    name: "chromium";
    version: string;
    userAgent: string;
    platform: string;
    headless: boolean;
    hardwareConcurrency: number;
    deviceMemoryGiB: number | null;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    backend: "webgl" | "webgpu";
    gpuVendor: string;
    gpuRenderer: string;
  };
  workload: {
    effects: number;
    taggedPlaceables: number;
    tokens: number;
    activeTiles: number;
    longGraphSteps: number;
    simpleTriggerRuns: number;
    fxCycles: number;
    fxSectionPartition: number[];
    media: {
      sha256: string;
      mime: "image/png";
      bytes: number;
      width: 64;
      height: 64;
      codec: "PNG";
      frames: 1;
    };
  };
  acceptance: {
    visibleFrameP95Ms: number;
    simpleTriggerDispatchP95Ms: number;
    stabilizedHeapRatio: number;
  };
}

interface LoadedProfile {
  profile: A41ReferenceProfile;
  path: string;
  relativePath: string;
  publicationCommit: string;
  publicationTime: string;
}

function readPublishedProfile(profilePath: string, runStartedAt: number): LoadedProfile {
  const root = realpathSync(process.cwd());
  const requested = isAbsolute(profilePath) ? profilePath : resolve(root, profilePath);
  if (!existsSync(requested)) throw new Error(`A41 reference profile does not exist: ${requested}`);
  const path = realpathSync(requested);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error("A41 reference profile must be a file inside this checkout");
  const gitPath = relativePath.split(sep).join("/");
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", gitPath], { cwd: root, stdio: "pipe" });
  } catch {
    throw new Error("A41 reference profile must be tracked and committed before measurement");
  }
  const status = execFileSync("git", ["status", "--porcelain", "--", gitPath], { cwd: root, encoding: "utf8" });
  if (status.trim()) throw new Error("A41 reference profile is dirty; publish it in a prior commit before measuring");
  const publication = execFileSync("git", ["log", "-1", "--format=%H%x1f%cI", "--", gitPath], {
    cwd: root,
    encoding: "utf8",
  }).trim().split("\x1f");
  const publicationCommit = publication[0] ?? "";
  const publicationTime = publication[1] ?? "";
  if (!/^[a-f0-9]{40,64}$/i.test(publicationCommit) || !Number.isFinite(Date.parse(publicationTime)))
    throw new Error("A41 reference profile has no valid publication commit");
  const published = JSON.parse(readFileSync(path, "utf8")) as A41ReferenceProfile;
  const publishedAt = Date.parse(published.publishedAt);
  const committedAt = Date.parse(publicationTime);
  if (published.schemaVersion !== 1 || !published.id || /REPLACE|TEMPLATE|EXAMPLE/i.test(published.id) ||
      !Number.isFinite(publishedAt) || publishedAt > runStartedAt || publishedAt > committedAt + 5 * 60_000 ||
      committedAt > runStartedAt + 5 * 60_000)
    throw new Error("A41 profile must have a real ID/date and be cleanly committed before this measurement");
  validateProfileFixture(published);
  return { profile: published, path, relativePath: gitPath, publicationCommit, publicationTime };
}

function validateProfileFixture(profile: A41ReferenceProfile): void {
  const workload = profile.workload;
  if (workload.effects !== FIXTURE.effects || workload.taggedPlaceables !== FIXTURE.taggedPlaceables ||
      workload.tokens !== FIXTURE.tokens || workload.activeTiles !== FIXTURE.activeTiles ||
      workload.longGraphSteps !== FIXTURE.longGraphSteps || workload.simpleTriggerRuns !== FIXTURE.simpleTriggerRuns ||
      workload.fxCycles !== FIXTURE.fxCycles || workload.fxSectionPartition.join(",") !== FX_PARTITION.join(",") ||
      workload.media.mime !== "image/png" || workload.media.width !== 64 || workload.media.height !== 64 ||
      workload.media.codec !== "PNG" || workload.media.frames !== 1)
    throw new Error("A41 profile workload differs from the executable A41 fixture");
  if (profile.acceptance.visibleFrameP95Ms !== BUDGETS.visibleFrameP95Ms ||
      profile.acceptance.simpleTriggerDispatchP95Ms !== BUDGETS.simpleTriggerDispatchP95Ms ||
      profile.acceptance.stabilizedHeapRatio !== BUDGETS.stabilizedHeapRatio)
    throw new Error("A41 reference profile may not relax or redefine the published acceptance budgets");
  if (!profile.hardware.deviceId || /REPLACE|TEMPLATE|EXAMPLE/i.test(profile.hardware.deviceId) ||
      !profile.hardware.cpuModel || /REPLACE|TEMPLATE|EXAMPLE/i.test(profile.hardware.cpuModel) ||
      !Number.isFinite(profile.hardware.systemMemoryGiB) || profile.hardware.systemMemoryGiB <= 0 ||
      !Number.isInteger(profile.hardware.logicalCpuThreads) || profile.hardware.logicalCpuThreads < 1)
    throw new Error("A41 reference profile has incomplete device identity");
  if (profile.browser.name !== "chromium" || !profile.browser.version ||
      !profile.browser.userAgent || !profile.browser.platform ||
      !Number.isInteger(profile.browser.hardwareConcurrency) || profile.browser.hardwareConcurrency < 1 ||
      !Number.isInteger(profile.browser.viewport.width) || !Number.isInteger(profile.browser.viewport.height) ||
      profile.browser.viewport.width < 1 || profile.browser.viewport.height < 1 ||
      !Number.isFinite(profile.browser.viewport.deviceScaleFactor) || profile.browser.viewport.deviceScaleFactor <= 0 ||
      !profile.browser.gpuVendor || !profile.browser.gpuRenderer ||
      /REPLACE|TEMPLATE|EXAMPLE/i.test(profile.browser.gpuVendor + profile.browser.gpuRenderer))
    throw new Error("A41 reference profile has incomplete browser/GPU identity");
}

function requireHostIdentity(profile: A41ReferenceProfile): void {
  const deviceId = process.env.A41_DEVICE_ID;
  const cpuModel = process.env.A41_CPU_MODEL;
  const memoryGiB = Number(process.env.A41_RAM_GIB);
  const logicalCpuThreads = Number(process.env.A41_CPU_THREADS);
  if (!deviceId || !cpuModel || !Number.isFinite(memoryGiB) || !Number.isInteger(logicalCpuThreads))
    throw new Error("Set A41_DEVICE_ID, A41_CPU_MODEL, A41_RAM_GIB and A41_CPU_THREADS for the reference-device preflight");
  if (deviceId !== profile.hardware.deviceId || cpuModel !== profile.hardware.cpuModel ||
      memoryGiB !== profile.hardware.systemMemoryGiB || logicalCpuThreads !== profile.hardware.logicalCpuThreads)
    throw new Error("A41 runner host identity does not match the pre-published reference profile");
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function distribution(values: readonly number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : 0,
  };
}

async function startVisibleFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __a41FrameRecorder?: { intervals: number[]; stop: () => void; read: () => number[] };
    };
    const intervals: number[] = [];
    let previous: number | null = null;
    let stopped = false;
    const sample = (now: number): void => {
      if (previous !== null) intervals.push(now - previous);
      previous = now;
      if (!stopped) requestAnimationFrame(sample);
    };
    target.__a41FrameRecorder = {
      intervals,
      stop: () => { stopped = true; },
      read: () => [...intervals],
    };
    requestAnimationFrame(sample);
  });
}

async function stopVisibleFrameRecorder(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const target = window as unknown as {
      __a41FrameRecorder?: { intervals: number[]; stop: () => void; read: () => number[] };
    };
    target.__a41FrameRecorder?.stop();
    return target.__a41FrameRecorder?.read() ?? [];
  });
}

async function writeReport(testInfo: TestInfo, report: Record<string, unknown>): Promise<void> {
  const outputPath = testInfo.outputPath("a41-performance-report.json");
  const body = JSON.stringify(report, null, 2);
  writeFileSync(outputPath, body);
  await testInfo.attach("a41-performance-report.json", {
    path: outputPath,
    contentType: "application/json",
  });
  console.log(`A41_RESULT ${body}`);
}

test("A41 performance harness uses a pre-published GPU profile and the full acceptance workload", async ({ page }, testInfo) => {
  test.setTimeout(15 * 60_000);
  const runStartedAt = Date.now();
  const diagnostic = process.env.A41_DIAGNOSTIC === "1";
  const profilePath = process.env.A41_REFERENCE_PROFILE;
  test.skip(!diagnostic && !profilePath,
    "A41 is opt-in: set A41_REFERENCE_PROFILE for qualification or A41_DIAGNOSTIC=1 for a non-qualifying sandbox run");

  const loadedProfile = profilePath ? readPublishedProfile(profilePath, runStartedAt) : null;
  if (loadedProfile) requireHostIdentity(loadedProfile.profile);
  const png = solidPng(64, 64);
  const mediaHash = createHash("sha256").update(png).digest("hex");
  if (loadedProfile && (loadedProfile.profile.workload.media.sha256 !== mediaHash ||
      loadedProfile.profile.workload.media.bytes !== png.byteLength))
    throw new Error("A41 profile test-media hash/byte count differs from the deterministic PNG fixture");

  await page.goto(`${entry}?e2e=1`);
  await waitForSurface(page, "app");
  await page.waitForFunction(() => Boolean((globalThis as unknown as { __stage?: unknown }).__stage), undefined, { timeout: 30_000 });
  const runtimeBefore = await hostCall<A41RuntimeSnapshot>(page, "a41RuntimeSnapshot");
  const actualBrowserVersion = page.context().browser()?.version() ?? runtimeBefore.browserVersion ?? "unknown";
  if (loadedProfile) {
    const profile = loadedProfile.profile;
    const softwareRenderer = /swiftshader|llvmpipe|software|lavapipe|swiftshader/i.test(runtimeBefore.renderer.gpuRenderer ?? "");
    if (softwareRenderer || !runtimeBefore.renderer.gpuVendor || !runtimeBefore.renderer.gpuRenderer ||
        !["webgl", "webgpu"].includes(runtimeBefore.renderer.backend))
      throw new Error("A41 qualification requires a hardware-accelerated WebGL/WebGPU device; software rendering is not accepted");
    expect(actualBrowserVersion, "Chromium version preflight").toBe(profile.browser.version);
    expect(runtimeBefore.userAgent, "browser user-agent preflight").toBe(profile.browser.userAgent);
    expect(runtimeBefore.platform, "browser platform preflight").toBe(profile.browser.platform);
    expect(runtimeBefore.viewport, "viewport/device-scale preflight").toEqual(profile.browser.viewport);
    expect(runtimeBefore.hardwareConcurrency, "browser CPU-thread preflight").toBe(profile.browser.hardwareConcurrency);
    expect(runtimeBefore.deviceMemoryGiB, "browser device-memory preflight").toBe(profile.browser.deviceMemoryGiB);
    expect(runtimeBefore.renderer.backend, "GPU backend preflight").toBe(profile.browser.backend);
    expect(runtimeBefore.renderer.gpuVendor, "GPU vendor preflight").toBe(profile.browser.gpuVendor);
    expect(runtimeBefore.renderer.gpuRenderer, "GPU renderer preflight").toBe(profile.browser.gpuRenderer);
    expect(runtimeBefore.userAgent.includes("HeadlessChrome"), "headless-mode preflight").toBe(profile.browser.headless);
  }

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator('input[type="file"]').setInputFiles({ name: "a41-reference-fixture.png", mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("GM-only playback", { timeout: 30_000 });
  const media = await surfaceCallArg<{ hash: string; mime: string; bytes: number; width: number | null; height: number | null; fetchMs: number }>(
    page, "app", "a41CacheMedia", mediaHash,
  );
  expect(media).toMatchObject({ hash: mediaHash, mime: "image/png", bytes: png.byteLength, width: 64, height: 64 });
  const fixture = await surfaceCallArg<{
    sceneId: string;
    tokenIds: string[];
    tileIds: string[];
    triggerTileId: string;
    clickAutomationId: string;
    longAutomationId: string;
    fxMacroIds: string[];
    tag: string;
    fxSectionPartition: number[];
    taggedPlaceables: number;
    activeTiles: number;
    longGraphSteps: number;
  }>(page, "app", "a41SeedWorkload", mediaHash);
  expect(fixture).toMatchObject({
    fxSectionPartition: [...FX_PARTITION],
    taggedPlaceables: FIXTURE.taggedPlaceables,
    activeTiles: FIXTURE.activeTiles,
    longGraphSteps: FIXTURE.longGraphSteps,
  });
  await expect.poll(
    () => hostCall<A41RuntimeSnapshot>(page, "a41RuntimeSnapshot"),
    { timeout: 90_000, intervals: [100, 250, 500] },
  ).toMatchObject({
    stage: { tokenViews: 800, tileViews: 200, renderedTileImages: 200, fxVisuals: 0 },
    fixture: { taggedTokens: 800, taggedTiles: 200, fxInstances: 0 },
  });

  // Prime the actual asset/decode path, trigger path and the long graph before measuring.
  const warmFx = await surfaceCallArgs<{ cycles: number; effectsPerCycle: number; peakVisuals: number; allStopped: boolean }>(
    page, "app", "a41RunFxCycles", [{ sceneId: fixture.sceneId, macroIds: fixture.fxMacroIds, cycles: 1 }],
  );
  const warmTrigger = await surfaceCallArgs<Array<{ result: string; selectedTargets: number | null }>>(
    page, "app", "a41RunSimpleTriggers", [{ sceneId: fixture.sceneId, tileId: fixture.triggerTileId,
      automationId: fixture.clickAutomationId, count: 1 }],
  );
  const warmLongGraph = await surfaceCallArgs<{ result: string; traceEntries: number }>(
    page, "app", "a41RunLongGraph", [{ automationId: fixture.longAutomationId, sceneId: fixture.sceneId }],
  );
  expect(warmFx).toMatchObject({ cycles: 1, effectsPerCycle: 100, peakVisuals: 100, allStopped: true });
  expect(warmTrigger[0]).toMatchObject({ result: "committed", selectedTargets: 1_000 });
  expect(warmLongGraph.result).toBe("committed");
  expect(warmLongGraph.traceEntries).toBe(601);
  await page.waitForTimeout(2_500);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const collectHeap = async (): Promise<number> => {
    await cdp.send("HeapProfiler.collectGarbage");
    const usage = await cdp.send("Runtime.getHeapUsage") as { usedSize?: number };
    if (!Number.isFinite(usage.usedSize)) throw new Error("Chromium CDP did not report V8 used heap bytes");
    return usage.usedSize as number;
  };
  const baselineSamples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    baselineSamples.push(await collectHeap());
    if (i < 2) await page.waitForTimeout(500);
  }
  const heapBaseline = percentile(baselineSamples, 0.5);

  await startVisibleFrameRecorder(page);
  const fxCycles = await surfaceCallArgs<{
    cycles: number;
    effectsPerCycle: number;
    peakVisuals: number;
    activeVisualCounts: number[];
    startStopIntentCount: number;
    durationMs: number;
    cycleDurationsMs: number[];
    allStopped: boolean;
  }>(page, "app", "a41RunFxCycles", [{ sceneId: fixture.sceneId, macroIds: fixture.fxMacroIds, cycles: 50 }]);
  const simpleTriggers = await surfaceCallArgs<Array<{
    elapsedMs: number;
    result: string;
    detail: string;
    selectedTargets: number | null;
    sequence: number | null;
    traceEntries: number;
  }>>(page, "app", "a41RunSimpleTriggers", [{ sceneId: fixture.sceneId, tileId: fixture.triggerTileId,
    automationId: fixture.clickAutomationId, count: 100 }]);
  const longGraph = await surfaceCallArgs<{
    elapsedMs: number;
    result: string;
    detail: string;
    selectedTargets: number | null;
    sequence: number | null;
    traceEntries: number;
  }>(page, "app", "a41RunLongGraph", [{ automationId: fixture.longAutomationId, sceneId: fixture.sceneId }]);
  const frameIntervals = await stopVisibleFrameRecorder(page);
  await page.waitForTimeout(3_000);
  const stabilizedHeapSamples: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    stabilizedHeapSamples.push(await collectHeap());
    if (i < 2) await page.waitForTimeout(500);
  }
  await cdp.detach();

  const finalRuntime = await hostCall<A41RuntimeSnapshot>(page, "a41RuntimeSnapshot");
  const triggerDistribution = distribution(simpleTriggers.map((sample) => sample.elapsedMs));
  const frameDistribution = distribution(frameIntervals);
  const stabilizedHeap = Math.max(...stabilizedHeapSamples);
  const heapRatio = heapBaseline > 0 ? stabilizedHeap / heapBaseline : Number.POSITIVE_INFINITY;
  const qualification = loadedProfile ? "reference-profile" : "diagnostic-non-qualifying";
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    qualification,
    runStartedAt: new Date(runStartedAt).toISOString(),
    profile: loadedProfile ? {
      id: loadedProfile.profile.id,
      path: loadedProfile.relativePath,
      publicationCommit: loadedProfile.publicationCommit,
      publicationTime: loadedProfile.publicationTime,
      publishedAt: loadedProfile.profile.publishedAt,
    } : null,
    runtime: { expected: loadedProfile?.profile.browser ?? null, before: runtimeBefore,
      browserVersion: actualBrowserVersion, after: finalRuntime },
    fixture: {
      ...FIXTURE,
      fxSectionPartition: [...FX_PARTITION],
      tag: fixture.tag,
      placedTokens: fixture.tokenIds.length,
      placedTiles: fixture.tileIds.length,
      simpleTriggerGraph: fixture.clickAutomationId,
      longGraph: fixture.longAutomationId,
      longGraphSteps: fixture.longGraphSteps,
      warmup: { fxCycles: 1, simpleTriggers: 1, longGraphTraceEntries: warmLongGraph.traceEntries },
    },
    media: { ...media, codec: "PNG", frames: 1, cacheStatus: "bytes verified against SHA-256 content address" },
    fxCycles,
    simpleTriggers: {
      runs: simpleTriggers.length,
      resultCounts: { committed: simpleTriggers.filter((sample) => sample.result === "committed").length,
        other: simpleTriggers.filter((sample) => sample.result !== "committed").length },
      selectedTargetCounts: [...new Set(simpleTriggers.map((sample) => sample.selectedTargets))],
      dispatchMs: triggerDistribution,
    },
    longGraph: { ...longGraph, expectedRunScopeSteps: 600, expectedTraceEntries: 601,
      inspectableTrace: longGraph.traceEntries === 601 },
    visibleFrameTimeMs: {
      measurement: "requestAnimationFrame interval on the visible production page; includes 50 FX cycles, 100 host triggers, and long-graph execution",
      targetP95Ms: BUDGETS.visibleFrameP95Ms,
      ...frameDistribution,
      adaptiveQuality: finalRuntime.stage.adaptiveQuality,
    },
    stabilizedHeap: {
      measurement: "V8 JavaScript usedSize from Chromium CDP after explicit GC; does not include GPU driver allocations",
      warmedBaselineSamplesBytes: baselineSamples,
      warmedBaselineMedianBytes: heapBaseline,
      stabilizedSamplesBytes: stabilizedHeapSamples,
      stabilizedMaxBytes: stabilizedHeap,
      ratio: heapRatio,
      limitRatio: BUDGETS.stabilizedHeapRatio,
    },
    assetCodecFrameBudget: {
      assetBytes: media.bytes,
      mime: media.mime,
      codec: "PNG",
      frames: 1,
      visibleFrameBudgetMs: BUDGETS.visibleFrameP95Ms,
      measuredP95VisibleFrameMs: frameDistribution.p95,
      simpleTriggerBudgetMs: BUDGETS.simpleTriggerDispatchP95Ms,
      measuredP95SimpleTriggerDispatchMs: triggerDistribution.p95,
      note: "Reference-profile run reports this fixture codec/byte count and the measured frame/dispatch budgets; PNG is static single-frame media.",
    },
    checks: {
      exact100VisualsEveryCycle: fxCycles.effectsPerCycle === 100 && fxCycles.activeVisualCounts.length === 50 &&
        fxCycles.activeVisualCounts.every((count) => count === 100) && fxCycles.peakVisuals === 100,
      allFxStopped: fxCycles.allStopped,
      all100TriggersCommitted: simpleTriggers.length === 100 && simpleTriggers.every((sample) =>
        sample.result === "committed" && sample.selectedTargets === 1_000),
      longGraphCompleted: longGraph.result === "committed" && longGraph.traceEntries === 601,
      allTilesRendered: finalRuntime.stage.tileViews === 200 && finalRuntime.stage.renderedTileImages === 200,
      adaptiveQualityActive: finalRuntime.stage.adaptiveQuality.samples > 0 &&
        finalRuntime.stage.adaptiveQuality.targetFrameMs === 50,
      frameBudgetPassed: frameDistribution.p95 <= BUDGETS.visibleFrameP95Ms,
      triggerBudgetPassed: triggerDistribution.p95 <= BUDGETS.simpleTriggerDispatchP95Ms,
      heapBudgetPassed: heapRatio <= BUDGETS.stabilizedHeapRatio,
    },
  };
  await writeReport(testInfo, report);

  expect(fxCycles.cycles).toBe(50);
  expect(fxCycles.activeVisualCounts).toHaveLength(50);
  expect(fxCycles.activeVisualCounts.every((count) => count === 100)).toBe(true);
  expect(fxCycles.peakVisuals).toBe(100);
  expect(fxCycles.allStopped).toBe(true);
  expect(simpleTriggers).toHaveLength(100);
  expect(simpleTriggers.every((sample) => sample.result === "committed" && sample.selectedTargets === 1_000)).toBe(true);
  expect(longGraph.result).toBe("committed");
  expect(longGraph.traceEntries).toBe(601);
  expect(finalRuntime.stage.tokenViews).toBe(800);
  expect(finalRuntime.stage.tileViews).toBe(200);
  expect(finalRuntime.stage.renderedTileImages).toBe(200);
  expect(finalRuntime.stage.adaptiveQuality.targetFrameMs).toBe(50);
  expect(frameDistribution.count).toBeGreaterThan(0);
  if (loadedProfile) {
    expect(frameDistribution.p95, "visible frame-time p95 ≤ 50 ms").toBeLessThanOrEqual(BUDGETS.visibleFrameP95Ms);
    expect(triggerDistribution.p95, "simple-trigger dispatch p95 ≤ 100 ms").toBeLessThanOrEqual(BUDGETS.simpleTriggerDispatchP95Ms);
    expect(heapRatio, "stabilized JS heap ≤ 110% of warmed baseline").toBeLessThanOrEqual(BUDGETS.stabilizedHeapRatio);
  }
});
