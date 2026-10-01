import { expect, test } from "vitest";
import type { WallDocument } from "../../src/core/documents";
import { movementWallBlocked } from "../../src/core/movementPolicy";
const wall = (move: 0|1|2, door: 0|1|2): WallDocument => ({ _id: "w", type: "wall", name: "w", ownership: { default: 0 }, flags: {}, system: {}, c: [50,0,50,100], move, door, oneWay: false, sight: 2, light: 2, sound: 2 });
test.each([[0,0,true],[0,1,true],[1,0,true],[1,1,false],[1,2,true],[2,0,false]] as const)("movement restriction %s door %s blocks=%s", (move, door, blocks) => {
  expect(movementWallBlocked({ x: 0, y: 50 }, { x: 100, y: 50 }, [wall(move,door)])).toBe(blocks);
});
test.each([
  [0,0,50,0,true], [50,20,50,70,true], [0,101,100,101,false], [0,50,0,50,false],
  [0,50,20,50,false], [50,50,70,50,true],
] as const)("path (%s,%s)-(%s,%s) conservative intersection=%s", (x,y,u,v,blocked) => {
  expect(movementWallBlocked({x,y},{x:u,y:v},[wall(0,0)])).toBe(blocked);
});

import { movementFootprintBlocked, movementSpeedDuration } from "../../src/core/movementPolicy";
test.each([[100,100,1,1000],[500,100,2,2500],[0,100,1,0],[100,0,1,null],[100,100,0,null],
  [100,100,0.01,null],[6000,100,1,60000],[6001,100,1,null],[NaN,100,1,null]] as const)
  ("speed duration distance=%s grid=%s speed=%s", (distance,size,speed,expected) => {
    expect(movementSpeedDuration(distance,size,speed)).toBe(expected);
  });
test("footprint catches parallel walls the center line misses", () => {
  const obstacle = {...wall(0,0), c:[20,40,80,40] as [number,number,number,number]};
  const from = {x:0,y:0}, to = {x:100,y:0};
  expect(movementWallBlocked(from,to,[obstacle])).toBe(false);
  expect(movementFootprintBlocked(from,to,100,100,0,[obstacle])).toBe(true);
  expect(movementFootprintBlocked(from,to,20,20,0,[obstacle])).toBe(false);
});
test("rotated tile footprints, endpoints inside sweep, and conditional doors are respected", () => {
  const obstacle = {...wall(1,0), c:[40,20,60,20] as [number,number,number,number]};
  const from = {x:0,y:0}, to = {x:100,y:0};
  expect(movementFootprintBlocked(from,to,60,10,0,[obstacle])).toBe(false);
  expect(movementFootprintBlocked(from,to,60,10,90,[obstacle])).toBe(true);
  expect(movementFootprintBlocked(from,to,60,10,90,[{...obstacle,door:1}])).toBe(false);
  expect(movementFootprintBlocked(from,from,60,10,90,[obstacle])).toBe(false);
});
test.each([[-1,10],[10,0],[NaN,10]])("malformed moving footprint %s,%s fails closed", (w,h) => {
  expect(movementFootprintBlocked({x:0,y:0},{x:1,y:1},w,h,0,[])).toBe(true);
});
