import { describe, expect, test, vi } from "vitest";
import { AdaptiveQualityController } from "../../src/canvas/adaptiveQuality";

describe("adaptive canvas resolution", () => {
  test("reduces backing-store resolution when successive p95 windows exceed budget", () => {
    const changed = vi.fn<(resolution: number) => void>();
    const quality = new AdaptiveQualityController({
      baseResolution: 1,
      evaluateEvery: 20,
      windowSize: 40,
      onResolutionChange: changed,
    });

    for (let i = 0; i < 40; i += 1) quality.sample(60);

    expect(quality.snapshot()).toMatchObject({
      resolution: 0.75,
      level: 1,
      samples: 40,
      resolutionChanges: 1,
      recentP95FrameMs: 60,
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith(0.75);
  });

  test("recovers only after sustained frames below the hysteresis threshold", () => {
    const changed = vi.fn<(resolution: number) => void>();
    const quality = new AdaptiveQualityController({
      baseResolution: 1,
      evaluateEvery: 20,
      windowSize: 20,
      recoverAfterWindows: 2,
      onResolutionChange: changed,
    });
    for (let i = 0; i < 40; i += 1) quality.sample(60);
    expect(quality.snapshot().resolution).toBe(0.75);

    for (let i = 0; i < 20; i += 1) quality.sample(30);
    expect(quality.snapshot().resolution).toBe(0.75);
    for (let i = 0; i < 20; i += 1) quality.sample(30);

    expect(quality.snapshot()).toMatchObject({ resolution: 1, level: 0, resolutionChanges: 2 });
    expect(changed.mock.calls.map(([resolution]) => resolution)).toEqual([0.75, 1]);
  });

  test("ignores non-frame values and stays inside configured resolution levels", () => {
    const quality = new AdaptiveQualityController({
      baseResolution: 1,
      resolutions: [1, 0.8, 0.6],
      evaluateEvery: 10,
      windowSize: 20,
    });
    quality.sample(Number.NaN);
    quality.sample(0);
    quality.sample(-1);
    expect(quality.snapshot().samples).toBe(0);

    for (let i = 0; i < 80; i += 1) quality.sample(100);
    expect(quality.snapshot().resolution).toBe(0.6);
    expect(quality.snapshot().levels).toEqual([1, 0.8, 0.6]);
  });
});
