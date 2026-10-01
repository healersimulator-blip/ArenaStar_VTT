import { expect, test } from "vitest";
import { RotationAnimation, rotationDuration, type RotationDocument } from "../../src/canvas/rotationAnimation";
const doc=(rotation:number,durationMs?:number):RotationDocument=>({rotation,flags:durationMs===undefined?{}:{arenaRotation:{rotation,durationMs}}});
test("first appearance cuts; shortest turns cross zero; unrelated syncs never restart",()=>{
  const a=new RotationAnimation();expect(a.update(doc(350,1000),0)).toBe(350);
  expect(a.update(doc(10,1000),100)).toBe(350);expect(a.sample(600)).toBe(0);
  a.update(doc(10,1000),600);expect(a.sample(850)).toBe(5);expect(a.sample(1100)).toBe(10);
  a.update(doc(350,1000),1200);expect(a.sample(1700)).toBe(0);expect(a.sample(2200)).toBe(350);
});
test("180-degree ties turn clockwise; superseding targets start from drawn orientation",()=>{
  const a=new RotationAnimation();a.update(doc(0),0);a.update(doc(180,1000),0);
  expect(a.sample(500)).toBe(90);a.update(doc(0,1000),500);
  expect(a.sample(1000)).toBe(45);expect(a.sample(1500)).toBe(0);
});
test("instant, zero, reduced motion and cancellation cut to endpoint",()=>{
  const a=new RotationAnimation();a.update(doc(0),0);a.update(doc(90,1000),0);
  expect(a.update(doc(90,1000),200,true)).toBe(90);expect(a.sample(300)).toBe(90);
  expect(a.update(doc(180,0),400)).toBe(180);expect(a.update(doc(270),500)).toBe(270);
  a.update(doc(90,1000),600);a.cancel();expect(a.sample(700)).toBe(90);
});
test("reload snaps; manual edits away and back cannot resurrect unchanged metadata",()=>{
  const a=new RotationAnimation(),saved=doc(90,1000);a.update(doc(0),0);a.update(saved,0);
  expect(a.update({...saved,rotation:180},200)).toBe(180);
  expect(a.update(saved,300)).toBe(90);
  expect(new RotationAnimation().update(saved,500)).toBe(90);
});
test.each([-1,60001,NaN,Infinity,"1000",null])("malformed hint %s is ignored",(durationMs)=>{
  expect(rotationDuration({rotation:90,flags:{arenaRotation:{rotation:90,durationMs}}})).toBeUndefined();
});
test("endpoint checks ignore stale hints; absent legacy angle is zero",()=>{
  expect(rotationDuration({...doc(90,1000),rotation:100})).toBeUndefined();
  expect(rotationDuration(doc(90,0))).toBe(0);
  const a=new RotationAnimation();expect(a.update({flags:{}},0)).toBe(0);expect(a.update(doc(-90),1)).toBe(270);
});
