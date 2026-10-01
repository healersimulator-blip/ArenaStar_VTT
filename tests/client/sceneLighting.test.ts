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
