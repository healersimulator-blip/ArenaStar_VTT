import { expect, test } from "vitest";
import { DarknessAnimation, darknessDuration, type DarknessScene } from "../../src/canvas/darknessAnimation";
const scene = (darkness:number, durationMs?:number, id="s"): DarknessScene => ({_id:id,darkness,
  flags:durationMs === undefined ? {} : {arenaDarkness:{darkness,durationMs}}});
test("first appearance cuts; later fades sample elapsed time and unrelated sync does not restart", () => {
  const a=new DarknessAnimation();a.update(scene(0,1000),0);expect(a.sample(1)).toBe(0);
  a.update(scene(1,1000),100);expect(a.sample(600)).toBe(0.5);
  a.update(scene(1,1000),600);expect(a.sample(850)).toBe(0.75);
  expect(a.sample(1100)).toBe(1);expect(a.sample(1200)).toBe(1);
});
test("interruptions start at the drawn value; legacy and zero transitions cut", () => {
  const a=new DarknessAnimation();a.update(scene(0),0);a.update(scene(1,1000),0);
  a.update(scene(0,1000),500);expect(a.sample(1000)).toBe(0.25);
  a.update(scene(0.75,0),1000);expect(a.sample(1001)).toBe(0.75);
  a.update(scene(1),1100);expect(a.sample(1101)).toBe(1);
});
test("reduced motion cuts an active fade and does not resume when disabled", () => {
  const a=new DarknessAnimation();a.update(scene(0),0);a.update(scene(1,1000),0);
  expect(a.sample(200,true)).toBe(1);expect(a.sample(300)).toBe(1);
  a.update(scene(0,1000),400,true);expect(a.sample(500)).toBe(0);
});
test("scene changes, clearing and reload never replay saved metadata", () => {
  const a=new DarknessAnimation();a.update(scene(0),0);a.update(scene(1,1000),0);
  a.update(scene(0.8,1000,"other"),500);expect(a.sample(501)).toBe(0.8);
  a.update(null,600);expect(a.sample(601)).toBe(0);
  const reload=new DarknessAnimation();reload.update(scene(1,1000),700);expect(reload.sample(701)).toBe(1);
});
test("manual edits away and back cannot resurrect stale endpoint hints", () => {
  const a=new DarknessAnimation();const saved=scene(1,1000);
  a.update(scene(0),0);a.update(saved,0);a.update({...saved,darkness:0.5},200);
  expect(a.sample(201)).toBe(0.5);a.update(saved,300);expect(a.sample(301)).toBe(1);
});
test.each([-1,60001,NaN,Infinity,"1000",null])("ignores malformed hint duration %s", (durationMs) => {
  expect(darknessDuration({_id:"s",darkness:0.5,flags:{arenaDarkness:{darkness:0.5,durationMs}}})).toBeUndefined();
});
test("endpoint mismatch ignores hint", () => {
  expect(darknessDuration({...scene(0.5,1000),darkness:0.8})).toBeUndefined();
  expect(darknessDuration(scene(0.5,0))).toBe(0);
});
