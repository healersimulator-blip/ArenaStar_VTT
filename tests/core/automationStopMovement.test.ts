import { expect, test } from "vitest";
import { planAutomation, validateAutomation, type AutomationEvent, type AutomationStep } from "../../src/core/automation";
import type { AutomationDocument, SceneDocument, TileDocument, TokenDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
const common={name:"Fixture",ownership:{default:0 as const},flags:{},system:{}};
const source:TileDocument={...common,_id:"source",type:"tile",x:200,y:400,width:200,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}};
const mover:TokenDocument={...common,_id:"mover",type:"token",x:650,y:450,width:100,height:100,rotation:0,img:"",hidden:false,vision:false,disposition:"neutral",light:{radius:0,color:"#fff",alpha:0}};
function fixture() {
  const scene:SceneDocument={...common,_id:"s",type:"scene",width:1000,height:1000,active:true,img:null,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},tokens:[structuredClone(mover)],tiles:[structuredClone(source)],walls:[],lights:[],sounds:[],drawings:[],templates:[],notes:[]};
  const action:AutomationStep={id:"stop",kind:"stopMovement",snapToGrid:false};
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"source",methods:["enter","exit","manual","click","stop","create","rotate"],steps:[action]}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  const tileDoc=scene.tiles[0],tokenDoc=scene.tokens[0];if(!tileDoc||!tokenDoc)throw new Error("missing stop fixture documents");
  const event:AutomationEvent={scene,tile:tileDoc,token:tokenDoc,method:"enter",movementCrossing:{tileId:"source",tokenId:"mover",method:"enter",fraction:0.1,x:400,y:450},caller:{id:"gm",role:"GM"},at:10,rng:()=>0.5};
  const run=()=>planAutomation(world,graph,event,"gm");
  return {world,scene,graph,action,event,run};
}
test("Stop action stages one token endpoint at the unrounded enter crossing",()=>{
  const f=fixture(),before=structuredClone(f.world),result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  expect(result.plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:400,y:450}});
  expect(result.plan.suppressedMovement).toContain("s\u0000mover");expect(result.plan.stoppedMovement).toContain("s\u0000mover");expect(f.world).toEqual(before);
});
test("optional grid snap settles at the nearest square cell center",()=>{
  const f=fixture();f.action.snapToGrid=true;f.event.movementCrossing={tileId:"source",tokenId:"mover",method:"enter",fraction:0.1,x:200,y:100};
  const result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  expect(result.plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:250,y:150}});
});
test("hex snap uses the native cell-center helper",()=>{
  const f=fixture();f.action.snapToGrid=true;f.scene.grid={...f.scene.grid,type:"hex",size:100,hexLayout:"oddQ"};
  f.event.movementCrossing={tileId:"source",tokenId:"mover",method:"enter",fraction:0.1,x:200,y:100};
  const result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  const op=result.plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens");expect(op?.kind==="update"&&op.ref.coll==="tokens").toBe(true);
  if(op?.kind==="update")expect([op.diff.x,op.diff.y]).not.toEqual([200,100]);
});
test("Exit is supported and stops at the host-observed exit contact",()=>{
  const f=fixture();f.event.method="exit";f.event.movementCrossing={tileId:"source",tokenId:"mover",method:"exit",fraction:0.8,x:400,y:450};
  const result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  expect(result.plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:400,y:450}});
});
test.each(["manual","click","stop","create","rotate"] as const)("%s cannot stop movement without a crossing context",method=>{
  const f=fixture();f.event.method=method;expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed enter/exit crossing")});
});
test.each(["absent","wrong-tile","wrong-token","wrong-method","bad-fraction","non-finite","out-of-scene"])("invalid %s crossing context fails closed",bad=>{
  const f=fixture();if(bad==="absent")delete f.event.movementCrossing;
  if(bad==="wrong-tile"&&f.event.movementCrossing)f.event.movementCrossing.tileId="other";
  if(bad==="wrong-token"&&f.event.movementCrossing)f.event.movementCrossing.tokenId="other";
  if(bad==="wrong-method"&&f.event.movementCrossing)f.event.movementCrossing.method="exit";
  if(bad==="bad-fraction"&&f.event.movementCrossing)f.event.movementCrossing.fraction=1.1;
  if(bad==="non-finite"&&f.event.movementCrossing)f.event.movementCrossing.x=NaN;
  if(bad==="out-of-scene"&&f.event.movementCrossing)f.event.movementCrossing.x=1001;
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed enter/exit crossing")});
});
test("Original Destination after Stop restores the captured endpoint plus offset",()=>{
  const f=fixture();f.graph.definition.steps.push({id:"continue",kind:"move",destinationOriginal:true,x:25,y:-25,targets:"triggering"});
  f.event.movementOriginal={tokenId:"mover",x:650,y:450};
  const result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  const tokenOps=result.plan.ops.filter(op=>op.kind==="update"&&op.ref.coll==="tokens");
  expect(tokenOps).toMatchObject([{kind:"update",diff:{x:400,y:450}},{kind:"update",diff:{x:675,y:425}}]);
  expect(result.plan.suppressedMovement).toEqual([]); // the explicit continuation enables its own committed path
  expect(result.plan.stoppedMovement).toContain("s\u0000mover"); // records execution even after resumption
});
test("a later failure discards a prior stop, private chat and staged changes",()=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"chat",kind:"chat",audience:"gm",content:"private"},{id:"light",kind:"sceneLighting",mode:"set",darkness:0.5});
  f.graph.definition.steps.push({id:"bad",kind:"sceneLighting",mode:"add",darkness:1});const before=structuredClone(f.world);
  expect(f.run()).toMatchObject({ok:false});expect(f.world).toEqual(before);
});
test("strict schema supports only optional boolean Snap to Grid",()=>{
  const f=fixture();expect(validateAutomation(f.graph.definition).ok).toBe(true);
  Object.assign(f.action,{snapToGrid:"yes"});expect(validateAutomation(f.graph.definition).ok).toBe(false);
  delete (f.action as unknown as Record<string,unknown>).unsupported;Object.assign(f.action,{other:true});expect(validateAutomation(f.graph.definition).ok).toBe(false);
});
test("legacy graphs without Stop Token Movement remain valid",()=>{
  const f=fixture();f.graph.definition.steps=[{id:"chat",kind:"chat",audience:"gm",content:"legacy"}];expect(validateAutomation(f.graph.definition).ok).toBe(true);
});
