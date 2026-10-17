import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const source = readFileSync("modules/ais-foundry-v13/runtime/roll.js", "utf8");
function realm() {
  const context = vm.createContext(
    {},
    { codeGeneration: { strings: false, wasm: false } },
  );
  vm.runInContext(
    source +
      `
    const { Roll } = __aisFoundryRoll.install({
      clone: (v) => JSON.parse(JSON.stringify(v)),
      getProperty: (obj, path) => path.split('.').reduce((v, p) => v?.[p], obj),
      postMessage: async (data) => data,
    });
  `,
    context,
  );
  return (code: string) => vm.runInContext(code, context) as unknown;
}

describe("CSP-safe Foundry Roll", () => {
  test("factory, term factory and clone preserve the upstream Roll subclass", () => {
    expect(realm()(`(() => {
      class SystemRoll extends Roll {}
      const roll = SystemRoll.create("2+3", { bonus: 7 });
      return roll instanceof SystemRoll && roll.clone() instanceof SystemRoll
        && SystemRoll.fromTerms([{ formula: "2" }, { formula: "+" }, { formula: "3" }]) instanceof SystemRoll;
    })()`)).toBe(true);
  });
  test("parse preserves supported terms without evaluating dice", () => {
    const run = realm();
    expect(run(`(() => {
      Math.random = () => { throw new Error('must not consume randomness'); };
      return JSON.stringify(Roll.parse('2d6 + floor(5/2) - 1').map(t => [t.formula, t.isDeterministic]));
    })()`)).toBe(JSON.stringify([["2d6", false], ["+", true], ["floor(5/2)", true], ["-", true], ["1", true]]));
    expect(run("Roll.parse(undefined).length")).toBe(0);
    expect(run("Roll.parse('').length")).toBe(0);
    expect(() => run("Roll.parse('globalThis.secret()')")).toThrow();
    expect(() => run("Roll.parse('9'.repeat(20000))")).toThrow();
  });
  test("computed dice and conditional rule formulas evaluate with Foundry terms", () => {
    const run = realm();
    expect(run(`new Roll('(min(10,@cl))d6[fire]', {cl:5}).evaluateSync({maximize:true}).total`)).toBe(30);
    expect(run(`new Roll('@rank >= 10 ? 4 : 2', {rank:2}).evaluateSync().total`)).toBe(2);
    expect(run(`new Roll('@rank >= 10 ? 4 : 2', {rank:10}).evaluateSync().total`)).toBe(4);
    expect(run(`Roll.parse('1 + 1').map(t=>t.total).join('')`)).toBe('1+1');
  });
  test("nested dice and registered function child rolls consume RNG only once and retain dice metadata", () => {
    const run = realm();
    expect(run(`(() => {
      let calls = 0, functions = 0;
      Math.random = () => { calls++; return 0.5; };
      globalThis.CONFIG = { Dice: { functions: {
        scaled: function(n) { functions++; this.rolls.push(new Roll(n+'d6')); return 0; }
      } } };
      if (!Roll.validate('scaled(2)+1') || calls || functions) return false;
      const roll = new Roll('(1d6 + 2) + scaled(2) + max(1d6, 2)').evaluateSync({strict:false});
      roll.evaluateSync({strict:false});
      return calls === 4 && functions === 1 && roll.total === 18 && roll.dice.length === 3
        && roll.dice.reduce((sum, die) => sum + die.results.length, 0) === 4;
    })()`)).toBe(true);
  });
  test("subclasses may inspect and replace parsed dice before evaluation", () => {
    expect(realm()(`(() => {
      // Use terms from the same engine as Roll, like an unmodified system does.
      class Check extends Roll { constructor(formula, data) {
        super(formula, data);
        const first = this.terms[0];
        if (first.faces !== 20) throw new Error('dice were not parsed');
        first.results = [{result:1, active:true}]; first._evaluated = true;
      } }
      const check = new Check('1d20 + @bonus', {bonus:3});
      return check.evaluateSync({strict:false}).total === 4 && Check.getFormula(check.terms).includes('d20');
    })()`)).toBe(true);
  });
  test("formula replacement preserves expressions and supports explicit missing values", () => {
    expect(realm()(`Roll.replaceFormulaData('@bonus + @missing', {bonus: '2+3'}, {missing: 7})`)).toBe('2+3 + 7');
  });

  test.each([
    ["2+3*4", 14],
    ["(2+3)*4", 20],
    ["-2 + +3", 1],
    ["floor(5/2) + min(8, 3)", 5],
    ["max(1, abs(-9)) % 4", 1],
    ["2 ** 3 ** 2", 512],
    ["pow(2,3) + ceil(0.2)", 9],
    [".5 + 1e2", 100.5],
  ])("evaluates %s without unsafe-eval", async (formula, total) => {
    expect(
      await realm()(
        `new Roll(${JSON.stringify(formula)}).evaluate().then(r => r.total)`,
      ),
    ).toBe(total);
  });
  test("interpolates numeric data preserving negative values and treats missing data as zero", async () => {
    expect(
      await realm()(
        `new Roll('2*@mod + @missing', {mod:-3}).evaluate().then(r => r.total)`,
      ),
    ).toBe(-6);
  });
  test.each(["4d6kh0", "4d6kl0", "4d6dh4", "4d6dl4"])(
    "handles zero kept dice: %s",
    async (formula) => {
      expect(
        await realm()(
          `new Roll(${JSON.stringify(formula)}).evaluate().then(r => r.total)`,
        ),
      ).toBe(0);
    },
  );
  test("dice totals match results, repeated evaluation does not reroll, and toMessage posts the total", async () => {
    const run = realm();
    expect(
      await run(`(async () => {
      const roll = new Roll('5d6+2');
      await roll.evaluate();
      const total = roll.total;
      await roll.evaluate();
      const message = await roll.toMessage();
      return total === roll.dice[0].results.reduce((a,b)=>a+b.result,0)+2 && total === roll.total &&
        roll.dice.length === 1 && message.roll.total === total;
    })()`),
    ).toBe(true);
  });
  test.each([
    "garbage",
    "2 +",
    "1/0",
    "1d0",
    "1001d6",
    "1d6r1",
    "alert(1)",
    "floor(1,2)",
    "2;3",
  ])("rejects unsupported/invalid syntax: %s", async (formula) => {
    const run = realm();
    expect(run(`Roll.validate(${JSON.stringify(formula)})`)).toBe(false);
    await expect(
      run(`new Roll(${JSON.stringify(formula)}).evaluate()`),
    ).rejects.toThrow();
  });
  test("validate consumes no random values and bounds recursive expressions", () => {
    const run = realm();
    run(`Math.random = () => { throw new Error('validation consumed RNG'); };`);
    expect(run(`Roll.validate('min(@cl,10) + 5d6')`)).toBe(true);
    expect(run(`Roll.validate('('.repeat(129) + '1' + ')'.repeat(129))`)).toBe(
      false,
    );
  });
});
