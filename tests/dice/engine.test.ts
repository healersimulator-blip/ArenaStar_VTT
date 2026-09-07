import { describe, expect, test } from "vitest";
import { evaluateFormula, substituteData, validateFormula, type RngFn } from "../../src/dice";
import type { RollEvaluation } from "../../src/dice";
import type { Result } from "../../src/core/result";

/** Deterministic rng cycling through a fixed value list (repeats last). */
function seqRng(values: number[]): RngFn {
  let i = 0;
  return () => {
    const v = i < values.length ? (values[i] as number) : (values[values.length - 1] as number);
    i++;
    return v;
  };
}

/** rng always yielding v. */
const r =
  (v: number): RngFn =>
  () =>
    v;

function expectTotal(formula: string, expected: number, rng: RngFn = r(0)): void {
  const res: Result<RollEvaluation> = evaluateFormula(formula, undefined, rng);
  expect(res).toMatchObject({ ok: true, value: { total: expected } });
}

function evalOk(formula: string, rng: RngFn, data?: Record<string, never>): RollEvaluation {
  const res = evaluateFormula(formula, data, rng);
  expect(res.ok, formula).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

describe("substituteData (@path, §11)", () => {
  const data = {
    abilities: { str: { mod: 5 }, dex: { mod: 2 } },
    level: 3,
    flag: true,
    name: "Rex",
    numeric: "7",
  };

  test("substitutes nested paths, numbers, booleans, numeric strings", () => {
    expect(substituteData("@abilities.str.mod + 1", data)).toMatchObject({
      ok: true,
      value: "5 + 1",
    });
    expect(substituteData("@level d6", data)).toMatchObject({ ok: true, value: "3 d6" });
    expect(substituteData("@flag", data)).toMatchObject({ ok: true, value: "1" });
    expect(substituteData("@numeric+1", data)).toMatchObject({ ok: true, value: "7+1" });
  });

  test("missing or non-numeric paths are errors", () => {
    expect(substituteData("@abilities.cha.mod", data).ok).toBe(false);
    expect(substituteData("@name attacks", data).ok).toBe(false);
    expect(substituteData("@nothing", data).ok).toBe(false);
  });
});

describe("validateFormula", () => {
  test("accepts the §11 grammar surface", () => {
    for (const f of [
      "1d20+5",
      "2d6kh1",
      "4d6dl1",
      "3d6x",
      "3d6xo",
      "4d6r1",
      "4d6ro2",
      "1d20min1",
      "1d20max10",
      "8d6cs>4",
      "8d6cf<=2",
      "floor(1d6/2)",
      "(1d6+1d4)*2",
      "min(1d6, 3)",
      "pow(2, 3)",
      "sqrt(16)",
      "-3+1d4",
      "1d20+@abilities.str.mod",
    ]) {
      expect(validateFormula(f), f).toEqual({ ok: true });
    }
  });

  test("rejects malformed formulas", () => {
    for (const f of [
      "",
      "   ",
      "1d",
      "d",
      "foo(1)",
      "(1+2",
      "1+",
      "2**3",
      "d0",
      "1d-4",
      "sum(1,2)",
    ]) {
      expect(validateFormula(f).ok, f).toBe(false);
    }
  });

  test("rejects over-long formulas and absurd dice counts", () => {
    expect(validateFormula("1+1".repeat(200)).ok).toBe(false);
    expect(validateFormula("2000d6").ok).toBe(false);
  });
});

describe("evaluateFormula (deterministic under injected rng)", () => {
  test("plain rolls: r=0 → 1, r→max → sides", () => {
    expectTotal("1d20", 1, r(0));
    expectTotal("1d20", 20, r(0.999));
    expectTotal("d6", 4, r(0.5));
  });

  test("arithmetic precedence and parentheses", () => {
    expectTotal("2+3*4", 14);
    expectTotal("(2+3)*4", 20);
    expectTotal("10/4", 2.5);
    expectTotal("-(1+1)", -2);
  });

  test("keep/drop kh/kl/dh/dl (D-024)", () => {
    // seqRng([0.9, 0.8, 0.5, 0.4]) on d6 → 6, 5, 4, 3
    expectTotal("4d6kh2", 6 + 5, seqRng([0.9, 0.8, 0.5, 0.4]));
    expectTotal("4d6dl1", 6 + 5 + 4, seqRng([0.9, 0.8, 0.5, 0.4]));
    expectTotal("3d6kl1", 4, seqRng([0.9, 0.8, 0.5])); // 6,5,4 → lowest 4
    expectTotal("3d6dh2", 4, seqRng([0.9, 0.8, 0.5])); // drop 6,5 → 4
    expectTotal("4d6kh", 6, seqRng([0.9, 0.8, 0.5, 0.4])); // default n=1
  });

  test("exploding dice x / xo", () => {
    expectTotal("1d6x", 8, seqRng([0.99, 0.3])); // 6 explodes → 2
    expectTotal("1d6xo", 12, seqRng([0.99, 0.99])); // explode once, no chain
    expectTotal("1d6x", 19, seqRng([0.99, 0.99, 0.99, 0.1])); // 6→6→6→1
  });

  test("rerolls r / ro", () => {
    expectTotal("2d6r1", 4 + 5, seqRng([0.1, 0.8, 0.6])); // 1 → 4, 5 stays
    expectTotal("3d6ro1", 4 + 1 + 5, seqRng([0.1, 0.1, 0.8, 0.6])); // only first 1 rerolled
    expectTotal("3d6r>4", 3, seqRng([0.99, 0.8, 0.99, 0, 0, 0])); // 6,5,6 all rerolled to 1s
  });

  test("min/max clamps", () => {
    expectTotal("1d20max10", 10, r(0.99));
    expectTotal("1d20min5", 5, r(0));
  });

  test("success counting cs / cf", () => {
    // d6 seq 0.99,0.8,0.3,0.3 → 6,5,2,2
    expectTotal("4d6cs>4", 2, seqRng([0.99, 0.8, 0.3, 0.3]));
    expectTotal("4d6cs>4cf<=2", 0, seqRng([0.99, 0.8, 0.3, 0.3])); // 2 succ − 2 fail
    expectTotal("4d6cf<=2", 2, seqRng([0.99, 0.8, 0.3, 0.3]));
    expectTotal("4d6cs=6", 1, seqRng([0.99, 0.8, 0.3, 0.3]));
  });

  test("math functions", () => {
    expectTotal("floor(1.9)", 1);
    expectTotal("ceil(1.1)", 2);
    expectTotal("round(2.5)", 3);
    expectTotal("abs(-4)", 4);
    expectTotal("sqrt(16)", 4);
    expectTotal("min(3, 1, 2)", 1);
    expectTotal("max(3, 1, 2)", 3);
    expectTotal("pow(2, 10)", 1024);
  });

  test("dice pools combine terms", () => {
    expectTotal("(1d6+1d4)*2", (6 + 4) * 2, seqRng([0.99, 0.99]));
  });

  test("@substitution flows into evaluation", () => {
    const res = evaluateFormula(
      "1d20+@abilities.str.mod",
      { abilities: { str: { mod: 5 } } },
      r(0),
    );
    expect(res).toMatchObject({ ok: true, value: { total: 6 } });
  });

  test("terms carry rolls/kept for roll cards", () => {
    const e = evalOk("4d6kh3", seqRng([0.9, 0.8, 0.5, 0.4]));
    const diceTerm = e.terms.find((t) => (t as { kind: string }).kind === "dice") as
      { rolls: number[]; kept: number[]; total: number } | undefined;
    expect(diceTerm?.rolls).toEqual([6, 5, 4, 3]);
    expect(diceTerm?.kept).toEqual([6, 5, 4]);
    expect(diceTerm?.total).toBe(6 + 5 + 4);
  });

  test("errors: division by zero, bad substitution, malformed", () => {
    expect(evaluateFormula("1/0").ok).toBe(false);
    expect(evaluateFormula("1d20+@ghost.mod", {}).ok).toBe(false);
    expect(evaluateFormula("1d20+", undefined, r(0)).ok).toBe(false);
    expect(evaluateFormula("sqrt(-1)").ok).toBe(false);
    expect(evaluateFormula("1d6x + 1", undefined, r(0.2)).ok).toBe(true); // d6 may explode
  });

  test("rng is the only randomness source (same rng sequence ⇒ same result)", () => {
    const a = evalOk("6d6kh3x", seqRng([0.9, 0.2, 0.4, 0.6, 0.8, 0.1, 0.99]));
    const b = evalOk("6d6kh3x", seqRng([0.9, 0.2, 0.4, 0.6, 0.8, 0.1, 0.99]));
    expect(a.total).toBe(b.total);
    expect(a.terms).toEqual(b.terms);
  });
});
