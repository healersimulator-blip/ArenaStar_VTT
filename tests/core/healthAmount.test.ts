import { expect, test } from "vitest";
import { healthAmountError, resolveHealthAmount } from "../../src/core/healthAmount";

test.each([-100000, -1, 1, 100000])("fixed HP %s never consumes randomness", (amount) => {
  expect(resolveHealthAmount({ amount }, () => { throw new Error("unexpected roll"); })).toEqual({ ok: true, value: amount });
});
test.each([{}, { amount: 0 }, { amount: 0.5 }, { amount: Infinity }, { amount: 100001 },
  { amount: 1, formula: "1d6" }, { formula: "@actor.hp" }, { formula: "{{hp}}" },
  { formula: "globalThis.alert(1)" }, { formula: "" }, { formula: "1".repeat(129) }])("reject invalid HP schema %j", (value) => {
  expect(healthAmountError(value)).not.toBeNull();
});
test.each([["-2d6", 0, -2], ["-2d6", 0.999, -12], ["floor(5 / 2)", 0, 2], ["1d4 + 1", 0.5, 4]] as const)
  ("resolves signed dice/math %s", (formula, rng, value) => {
    expect(resolveHealthAmount({ formula }, () => rng)).toEqual({ ok: true, value });
  });
test.each(["0", "1/2", "1/0", "100001", "-100001", "sqrt(-1)"])("reject invalid resolved HP %s", (formula) => {
  expect(resolveHealthAmount({ formula }, () => 0).ok).toBe(false);
});
test.each([NaN, Infinity, -0.01, 1])("reject invalid host RNG %s", (rng) => {
  expect(resolveHealthAmount({ formula: "1d6" }, () => rng)).toMatchObject({ ok: false, error: expect.stringContaining("RNG") });
});
test.each(["65d1", "1d2x"])("bounds dice work for %s", (formula) => {
  let rolls = 0;
  expect(resolveHealthAmount({ formula }, () => { rolls++; return 0.999; })).toMatchObject({ ok: false, error: expect.stringContaining("64 random draws") });
  expect(rolls).toBe(64);
});
