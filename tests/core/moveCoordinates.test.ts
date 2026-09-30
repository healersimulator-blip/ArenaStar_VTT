import { expect, test } from "vitest";
import { moveCoordinatesError, resolveMoveCoordinates } from "../../src/core/moveCoordinates";

test("fixed mixed-axis coordinates never roll", () => {
  expect(resolveMoveCoordinates({mode:"add",xMode:"set",x:100,y:-25},()=>{throw new Error("unexpected roll");})).toEqual({ok:true,value:{x:100,y:-25}});
});
test.each([
  {xFormula:"1d4 * 100",yFormula:"-1d1 * 10",yMode:"add" as const},
  {xFormula:"floor(450/2)",y:0}, {x:0,yFormula:"5/2"},
])("safe mixed coordinate sources %j", (value) => {
  expect(moveCoordinatesError(value)).toBeNull(); expect(resolveMoveCoordinates(value,()=>0).ok).toBe(true);
});
test.each([
  {x:1,xFormula:"1d6",y:0}, {x:0,y:1,yFormula:"1d6"}, {x:0},
  {xFormula:"@token.x",y:0}, {xFormula:"{{x}}",y:0}, {x:0,yFormula:"globalThis.alert(1)"},
  {xFormula:"",y:0}, {xFormula:"1".repeat(129),y:0}, {x:-1,y:0}, {mode:"add",xMode:"set",x:-1,y:0},
  {x:0,y:0,xMode:"invalid"}, {x:0,y:0,yMode:null}, {x:Infinity,y:0},
])("invalid coordinate schema %j", (value) => { expect(moveCoordinatesError(value)).not.toBeNull(); });
test.each(["1/0","sqrt(-1)","1000000001","-1"])("rejects invalid absolute expression result %s", (xFormula) => {
  expect(resolveMoveCoordinates({xFormula,y:0},()=>0).ok).toBe(false);
});
test("roll order is X then Y per target", () => {
  const draws=[0,0.999];
  expect(resolveMoveCoordinates({xFormula:"1d6",yFormula:"1d6"},()=>draws.shift()??0)).toEqual({ok:true,value:{x:1,y:6}});
});
test.each([NaN,Infinity,-0.01,1])("reject invalid RNG %s", (rng) => {
  expect(resolveMoveCoordinates({xFormula:"1d6",y:0},()=>rng)).toMatchObject({ok:false,error:expect.stringContaining("RNG")});
});
test.each(["65d1","1d2x"])("limits each axis formula %s", (xFormula) => {
  let draws=0;
  expect(resolveMoveCoordinates({xFormula,y:0},()=>{draws++;return 0.999;})).toMatchObject({ok:false,error:expect.stringContaining("64 random draws")});
  expect(draws).toBe(64);
});
