import { expect, test } from "vitest";
import { rotationAngleError, resolveRotationAngle } from "../../src/core/rotationAngle";

test.each([-1000000, -1, 0, 0.5, 1000000])("fixed angle %s consumes no randomness", (angle) => {
  expect(resolveRotationAngle({ angle }, () => { throw new Error("unexpected roll"); })).toEqual({ ok: true, value: angle });
});
test.each([{}, { angle: Infinity }, { angle: NaN }, { angle: 1000001 }, { angle: -1000001 },
  { angle: 1, formula: "1d6" }, { formula: "@entity.rotation" }, { formula: "{{rotation}}" },
  { formula: "globalThis.alert(1)" }, { formula: "" }, { formula: "1".repeat(129) }])("reject invalid angle schema %j", (value) => {
  expect(rotationAngleError(value)).not.toBeNull();
  expect(resolveRotationAngle(value, () => 0).ok).toBe(false);
});
test.each([["-2d6", 0, -2], ["1d4 * 90", 0.999, 360], ["5 / 2", 0, 2.5], ["1d1 - 1", 0, 0], ["-1000000", 0, -1000000]] as const)
  ("resolves signed dice/math %s before normalization", (formula, rng, value) => {
    expect(resolveRotationAngle({ formula }, () => rng)).toEqual({ ok: true, value });
  });
test.each(["1/0", "1000001", "-1000001", "sqrt(-1)"])("reject invalid resolved angle %s", (formula) => {
  expect(resolveRotationAngle({ formula }, () => 0).ok).toBe(false);
});
test.each([NaN, Infinity, -0.01, 1])("reject invalid host RNG %s", (rng) => {
  expect(resolveRotationAngle({ formula: "1d6" }, () => rng)).toMatchObject({ ok: false, error: expect.stringContaining("RNG") });
});
test.each(["65d1", "1d2x"])("bounds dice work for %s", (formula) => {
  let rolls = 0;
  expect(resolveRotationAngle({ formula }, () => { rolls++; return 0.999; })).toMatchObject({ ok: false, error: expect.stringContaining("64 random draws") });
  expect(rolls).toBe(64);
});
