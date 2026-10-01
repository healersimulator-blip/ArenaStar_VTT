import { expect, test } from "vitest";
import { MovementAnimation, movementDuration } from "../../src/canvas/movementAnimation";
test("first appearances cut, subsequent movement samples time rather than frame rate; unrelated sync does not restart", () => {
  const a = new MovementAnimation();
  a.update({ x: 0, y: 0 }, { x: -100, y: -100 }, 1000, 0);
  expect(a.sample(100)).toBeNull();
  a.update({ x: 100, y: 200 }, { x: 0, y: 0 }, 1000, 100);
  expect(a.sample(600)).toEqual({ x: 50, y: 100 });
  a.update({ x: 100, y: 200 }, { x: 50, y: 100 }, 1000, 600);
  expect(a.sample(850)).toEqual({ x: 75, y: 150 });
  expect(a.isRunning(1099)).toBe(true);
  expect(a.sample(1100)).toEqual({ x: 100, y: 200 });
  expect(a.isRunning(1100)).toBe(false);
  expect(a.sample(1101)).toBeNull();
});
test("superseding move starts at drawn position; zero/legacy/Stop cancel; reload cannot replay", () => {
  const a = new MovementAnimation();
  a.update({x:0,y:0},{x:0,y:0},undefined,0);
  a.update({x:100,y:0},{x:0,y:0},1000,0);
  expect(a.isRunning(499)).toBe(true);
  a.update({x:0,y:100},{x:50,y:0},1000,500);
  expect(a.sample(1000)).toEqual({x:25,y:50});
  a.update({x:0,y:0},{x:25,y:50},0,1000); expect(a.sample(1001)).toBeNull();
  a.update({x:100,y:0},{x:0,y:0},1000,1100); a.cancel(); expect(a.sample(1200)).toBeNull();
  const reloaded = new MovementAnimation(); reloaded.update({x:100,y:0},{x:0,y:0},1000,1200);
  expect(reloaded.sample(1300)).toBeNull();
});
test.each([-1, 60001, NaN, Infinity, "1000"])("invalid duration %s ignored", (durationMs) => {
  expect(movementDuration({x:1,y:2,flags:{arenaMove:{x:1,y:2,durationMs}}})).toBeUndefined();
});
test("stale endpoint hints cannot animate unrelated position edits", () => {
  expect(movementDuration({x:1,y:2,flags:{arenaMove:{x:1,y:2,durationMs:200}}})).toBe(200);
  expect(movementDuration({x:3,y:2,flags:{arenaMove:{x:1,y:2,durationMs:200}}})).toBeUndefined();
});

test("unchanged metadata cannot replay a stale animation after a manual move away and back", () => {
  const a = new MovementAnimation();
  a.update({x:0,y:0},{x:0,y:0},undefined,0,"none");
  a.update({x:100,y:0},{x:0,y:0},1000,0,"hint-to-100");
  expect(a.sample(500)).toEqual({x:50,y:0});
  a.update({x:200,y:0},{x:50,y:0},undefined,500,"hint-to-100");
  a.update({x:100,y:0},{x:200,y:0},1000,600,"hint-to-100");
  expect(a.sample(700)).toBeNull();
});
