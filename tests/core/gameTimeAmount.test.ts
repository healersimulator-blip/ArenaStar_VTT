import { describe, expect, test, vi } from "vitest";
import { gameTimeAmountError, resolveGameTimeAmount } from "../../src/core/gameTimeAmount";

describe("Game Time amounts", () => {
  test.each([-525600, -30, 0, 30, 525600])("keeps fixed %s minutes without RNG", (minutes) => {
    const rng = vi.fn();
    expect(resolveGameTimeAmount({minutes}, rng)).toEqual({ok:true,value:minutes});
    expect(rng).not.toHaveBeenCalled();
  });
  test.each([{}, {minutes:1.5}, {minutes:Infinity}, {minutes:525601}, {minutes:-525601},
    {minutes:"60"}, {minutes:1,formula:"1d1"}, {formula:""}, {formula:" ",minutes:0},
    {formula:"1".repeat(129)}, {formula:"@token.hp"}, {formula:"{{minutes}}"}, {formula:"Math.random()"}, {formula:null}])("rejects invalid authoring %j", (value) => {
    expect(gameTimeAmountError(value)).not.toBeNull();
  });
  test.each([["-1d1 * 30",-30],["(1d1 + 2) * 30",90],["1 - 1",0],["525600",525600],["-525600",-525600]])("resolves %s once", (formula, value) => {
    expect(resolveGameTimeAmount({formula:String(formula)},()=>0)).toEqual({ok:true,value});
  });
  test.each(["1/0", "1/2", "525601", "-525601", "65d1", "1d2x"]) ("rejects invalid result or budget %s", (formula) => {
    expect(resolveGameTimeAmount({formula},()=>0.999).ok).toBe(false);
  });
  test.each([NaN, Infinity, -0.1, 1])("rejects invalid RNG %s", (draw) => {
    expect(resolveGameTimeAmount({formula:"1d6"},()=>draw).ok).toBe(false);
  });
  test("validation does not execute result math; resolver limits RNG and catches exceptions", () => {
    expect(gameTimeAmountError({formula:"1/0"})).toBeNull();
    const rng=vi.fn(()=>0);
    expect(resolveGameTimeAmount({formula:"64d1"},rng)).toEqual({ok:true,value:64});
    expect(rng).toHaveBeenCalledTimes(64);
    expect(resolveGameTimeAmount({formula:"1d6"},()=>{throw new Error("RNG failed");})).toEqual({ok:false,error:"RNG failed"});
  });
});
