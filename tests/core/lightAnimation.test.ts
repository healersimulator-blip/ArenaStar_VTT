import { describe, expect, test } from "vitest";
import { lightAnimationAlpha, parseLightAnimation } from "../../src/core/lightAnimation";

describe("declarative light animation metadata", () => {
  test("accepts the bounded built-in effects and keeps only the typed contract", () => {
    expect(parseLightAnimation({ type: "torch", speed: 4.1, intensity: 0.32 })).toEqual({
      ok: true,
      value: { type: "torch", speed: 4.1, intensity: 0.32 },
    });
    expect(parseLightAnimation({ type: "pulse", speed: 0, intensity: 1, reverse: true })).toEqual({
      ok: true,
      value: { type: "pulse", speed: 0, intensity: 1, reverse: true },
    });
    expect(parseLightAnimation(null)).toEqual({ ok: true, value: null });
  });

  test.each([
    [{ type: "arbitrary-js", speed: 1, intensity: 1 }, "light animation type must be torch or pulse"],
    [{ type: "torch", speed: 10.1, intensity: 0.5 }, "light animation speed must be between 0 and 10 cycles per second"],
    [{ type: "pulse", speed: 1, intensity: 1.1 }, "light animation intensity must be between 0 and 1"],
    [{ type: "pulse", speed: 1, intensity: 0.5, reverse: "yes" }, "light animation reverse must be a boolean"],
    [{ type: "pulse", speed: 1, intensity: 0.5, script: "run()" }, "light animation contains an unsupported field"],
  ])("rejects invalid or executable metadata %#", (value, error) => {
    expect(parseLightAnimation(value)).toMatchObject({ ok: false, error });
  });

  test("pulse animates presentation deterministically, while reduced motion and zero depth stay static", () => {
    const animation = { type: "pulse" as const, speed: 1, intensity: 1 };
    expect(lightAnimationAlpha(animation, 0)).toBeCloseTo(0.81);
    expect(lightAnimationAlpha(animation, 0.25)).toBe(1);
    expect(lightAnimationAlpha(animation, 0, true)).toBe(1);
    expect(lightAnimationAlpha({ ...animation, intensity: 0 }, 0.25)).toBe(1);
    expect(lightAnimationAlpha({ ...animation, reverse: true }, 0.25)).toBeCloseTo(0.62);
  });
});
