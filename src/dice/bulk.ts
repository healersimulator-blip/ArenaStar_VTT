/**
 * §11 bulk sim dice: a PRNG-carrying dice kit for RulesModules. One instance
 * per turn (seeded from the per-turn seed): raw draws keep the §5A PRNG
 * contract (forkable sub-streams) while `roll()` drives the SAME §11 formula
 * evaluator through a compile cache — each distinct formula parses once per
 * turn, then evaluates per model/unit with varying rollData.
 */
import type { Json } from "../core/documents";
import type { PRNG } from "../core/sim";
import { XoshiroPRNG } from "../sim/prng";
import { compileFormula, type CompiledFormula, type RngFn, type RollEvaluation } from "./engine";
import type { Result } from "../core/result";

interface SharedCache {
  formulas: Map<string, CompiledFormula>;
  parses: number;
}

export class BulkDice implements PRNG {
  private readonly rng: XoshiroPRNG;
  private readonly cache: SharedCache;

  constructor(seed: number, cache?: SharedCache) {
    this.rng = new XoshiroPRNG(seed);
    this.cache = cache ?? { formulas: new Map(), parses: 0 };
  }

  // ─── PRNG surface (§5A) ──────────────────────────────────────────────────

  nextU32(): number {
    return this.rng.nextU32();
  }

  nextFloat(): number {
    return this.rng.nextFloat();
  }

  fork(substream: number): PRNG {
    return this.rng.fork(substream);
  }

  /** Fork a full BulkDice (own stream, SHARED per-turn compile cache). */
  forkDice(substream: number): BulkDice {
    const forked = new BulkDice(0, this.cache);
    // replace the fresh generator with the deterministic sub-stream
    const inner = this.rng.fork(substream) as XoshiroPRNG;
    (forked as unknown as { rng: XoshiroPRNG }).rng = inner;
    return forked;
  }

  // ─── §11 formula path ────────────────────────────────────────────────────

  /** Parses actually performed (compile-cache proof). */
  get parseCount(): number {
    return this.cache.parses;
  }

  /** Distinct formulas compiled this turn. */
  get formulaCount(): number {
    return this.cache.formulas.size;
  }

  /** Evaluate a formula with this kit's seeded stream (parse once/turn). */
  roll(formula: string, data?: Record<string, Json>): Result<RollEvaluation> {
    let compiled = this.cache.formulas.get(formula);
    if (!compiled) {
      const res = compileFormula(formula);
      if (!res.ok) return res;
      compiled = res.value;
      this.cache.formulas.set(formula, compiled);
      this.cache.parses += 1;
    }
    return compiled.evaluate(data, this.floatRng);
  }

  private readonly floatRng: RngFn = (): number => this.rng.nextFloat();
}
