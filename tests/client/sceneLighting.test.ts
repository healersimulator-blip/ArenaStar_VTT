import { expect, test, vi } from "vitest";
import { SceneLightingPlayer } from "../../src/client/sceneLighting";
import type { SceneDocument } from "../../src/core/documents";
import type { LightView } from "../../src/canvas/layers/LightingLayer";
import type { AmbientLighting } from "../../src/canvas/vision/lights";
import { InlineVisionWorker } from "../../src/workers/visionWorkerClient";
import { pointInPolygon } from "../../src/canvas/vision/polygon";
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const scene=():SceneDocument=>({_id:"s",type:"scene",name:"s",ownership:{default:2},flags:{},system:{},active:true,
  width:1000,height:1000,img:null,darkness:0.5,grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},
  tokens:[],tiles:[],walls:[],sounds:[],drawings:[],templates:[],notes:[],
  lights:[{_id:"l",type:"light",name:"l",ownership:{default:2},flags:{},system:{},x:100,y:100,bright:50,dim:100,color:"#ffffff",alpha:0.8}]});
function surface() {
  const sync=vi.fn<(views:readonly LightView[],ambient:AmbientLighting)=>void>();
  let frame: ((deltaMs:number)=>void)|undefined;const unframe=vi.fn();
  const view={camera:{x:0,y:0,scale:1},viewport:{width:800,height:600},getLightingLayer:()=>({sync}),
    onFrame:(fn:(deltaMs:number)=>void)=>{frame=fn;return unframe;}};
  return {view,sync,unframe,tick:()=>frame?.(16)};
}
test("production lighting draws wall-clipped placed lights, invalidates door changes and caches unrelated edits", async()=>{
  const computer=new InlineVisionWorker(), compute=vi.spyOn(computer,"compute");
  const p=new SceneLightingPlayer(computer),s=scene(),f=surface();
  s.walls.push({_id:"w",type:"wall",name:"w",ownership:{default:0},flags:{},system:{},c:[125,0,125,300],sight:2,move:1,sound:1,light:1,oneWay:false,door:0});
  p.sync(s,f.view);await flush();
  const closed=f.sync.mock.calls.at(-1)?.[0][0]?.poly;
  if(!closed)throw new Error("missing closed-wall light");expect(pointInPolygon(closed,150,100)).toBe(false);
  p.sync({...s,name:"renamed"},f.view);await flush();expect(compute).toHaveBeenCalledTimes(1);
  const wall=s.walls[0];if(!wall)throw new Error("missing wall");wall.door=1;
  p.sync(s,f.view);expect(f.sync.mock.calls.at(-1)?.[0]).toEqual([]);await flush();
  const open=f.sync.mock.calls.at(-1)?.[0][0]?.poly;
  if(!open)throw new Error("missing open-wall light");expect(pointInPolygon(open,150,100)).toBe(true);
  expect(compute).toHaveBeenCalledTimes(2);p.destroy();expect(f.unframe).toHaveBeenCalledTimes(1);
});
test("late polygons cannot light a different scene, failed polygons stay absent, destroy terminates", async()=>{
  const pending:Array<{resolve:(v:Float32Array)=>void;reject:(e:Error)=>void}>=[];
  const computer={compute:vi.fn(()=>new Promise<Float32Array>((resolve,reject)=>pending.push({resolve,reject}))),terminate:vi.fn()};
  const p=new SceneLightingPlayer(computer),f=surface(),s=scene();
  p.sync(s,f.view);p.sync({...s,_id:"next",darkness:0.8},f.view);
  pending[0]?.resolve(new Float32Array([0,0,1,0,0,1]));await flush();
  expect(f.sync.mock.calls.at(-1)?.[0]).toEqual([]);
  pending[1]?.reject(new Error("failed"));await flush();f.tick();
  expect(f.sync.mock.calls.at(-1)?.[0]).toEqual([]);expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(0.8);
  p.sync(null,f.view);await flush();expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(0);
  p.destroy();expect(computer.terminate).toHaveBeenCalledOnce();
  const count=f.sync.mock.calls.length;p.sync(s,f.view);expect(f.sync.mock.calls).toHaveLength(count);
});
test("hidden token lights are not drawn; visible carried lights use the replica position", async()=>{
  const s=scene();s.lights=[];
  s.tokens.push({_id:"t",type:"token",name:"t",ownership:{default:2},flags:{},system:{},x:300,y:400,width:100,height:100,
    rotation:0,img:"",disposition:"neutral",vision:true,hidden:true,light:{radius:150,color:"#ffffff",alpha:1}});
  const f=surface(),computer=new InlineVisionWorker(),compute=vi.spyOn(computer,"compute"),p=new SceneLightingPlayer(computer);
  p.sync(s,f.view);await flush();expect(compute).not.toHaveBeenCalled();
  const token=s.tokens[0];if(!token)throw new Error("missing token");token.hidden=false;
  p.sync(s,f.view);await flush();expect(f.sync.mock.calls.at(-1)?.[0][0]?.light).toMatchObject({_id:"token:t",x:300,y:400,dim:150});
  p.destroy();
});
test("malformed polygons never fall back to unclipped glows; replacing the canvas cuts rather than replays", async()=>{
  const computer={compute:vi.fn(async()=>new Float32Array()),terminate:vi.fn()};
  const p=new SceneLightingPlayer(computer),s=scene(),first=surface(),second=surface();
  p.sync(s,first.view);await flush();expect(first.sync.mock.calls.at(-1)?.[0]).toEqual([]);
  s.darkness=1;s.flags.arenaDarkness={darkness:1,durationMs:60000};p.sync(s,first.view);
  p.sync(s,second.view);expect(second.sync.mock.calls.at(-1)?.[1].darkness).toBe(1);
  expect(first.unframe).toHaveBeenCalledOnce();p.destroy();expect(second.unframe).toHaveBeenCalledOnce();
});

test("level lighting isolates scoped sources and stale same-scene polygons; flat view remains unchanged", async () => {
  const { draftLevel } = await import("../../src/core/levels");
  const { sceneLightingForLevel } = await import("../../src/canvas/vision/darkness");
  const s = scene(), light = s.lights[0]; if (!light) throw new Error("light");
  s.levels = [draftLevel("a", "A"), draftLevel("b", "B", 10, 20)];
  s.lights = [light, { ...light, _id: "a", levelScope: { mode: "levels", ids: ["a"] } }, { ...light, _id: "b", levelScope: { mode: "levels", ids: ["b"] } }, { ...light, _id: "all", levelScope: { mode: "all" } }];
  expect(sceneLightingForLevel(s, "a").lights.map((l) => l.id)).toEqual(["a", "all"]);
  expect(sceneLightingForLevel(s, "b").lights.map((l) => l.id)).toEqual(["b", "all"]);
  expect(() => sceneLightingForLevel(s, "missing")).toThrow();
  const pending: Array<(poly: Float32Array) => void> = [];
  const p = new SceneLightingPlayer({ compute: () => new Promise((resolve) => pending.push(resolve)), terminate: () => {} }), f = surface();
  p.sync(s, f.view, "a"); p.sync(s, f.view, "b");
  const poly = new Float32Array([0, 0, 100, 0, 0, 100]); pending[0]?.(poly); pending[1]?.(poly); await flush();
  expect(f.sync.mock.calls.at(-1)?.[0]).toEqual([]);
  pending[2]?.(poly); pending[3]?.(poly); await flush();
  expect(f.sync.mock.calls.at(-1)?.[0].map((v) => v.light._id)).toEqual(["b", "all"]);
  p.sync(s, f.view); expect(pending).toHaveLength(8); p.destroy();
});

test("ambient overrides are shared by fog and rendering, preserve source scene, and never tween across floors", async () => {
  const { draftLevel } = await import("../../src/core/levels");
  const { sceneForLevelPerception, sceneLightingForLevel } = await import("../../src/canvas/vision/darkness");
  const { fogViewers } = await import("../../src/core/fogExploration");
  const s = scene(); s.darkness = 0.25; s.flags.arenaDarkness = { darkness: 1, durationMs: 60000 };
  s.levels = [{ ...draftLevel("a", "Dark"), darkness: 1 }, { ...draftLevel("b", "Lit", 10, 20), darkness: 0 }, draftLevel("c", "Inherited", 20, 30)];
  s.tokens.push({ _id: "t", type: "token", name: "T", ownership: { default: 3 }, flags: {}, system: {}, x: 100, y: 100, width: 100, height: 100, rotation: 0, img: "", disposition: "neutral", vision: true, hidden: false, levelId: "a", light: { radius: 0, color: "#fff", alpha: 0 } });
  const before = structuredClone(s), f = surface(), p = new SceneLightingPlayer(new InlineVisionWorker());
  expect(sceneLightingForLevel(s, "a").darkness).toBe(1); expect(sceneLightingForLevel(s, "b").darkness).toBe(0); expect(sceneLightingForLevel(s, "c").darkness).toBe(0.25);
  const dark = sceneForLevelPerception(s, "a");
  expect(dark.flags).not.toHaveProperty("arenaDarkness");
  expect(fogViewers(dark, { id: "gm", role: "GM" }, { actors: [] }).every((v) => v.radiusPx === 0)).toBe(true);
  p.sync(s, f.view, "b"); expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(0);
  p.sync(s, f.view, "a"); expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(1);
  p.sync(s, f.view, "c"); expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(0.25);
  p.sync(s, f.view); expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(0.25);
  p.sync(s, f.view, "b");
  p.sync({ ...s, darkness: 1 }, f.view, "c"); expect(f.sync.mock.calls.at(-1)?.[1].darkness).toBe(1);
  expect(s).toEqual(before); p.destroy();
});
