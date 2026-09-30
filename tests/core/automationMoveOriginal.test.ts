import { expect, test } from "vitest";
import { planAutomation, validateAutomation, type AutomationEvent, type AutomationStep } from "../../src/core/automation";
import type { AutomationDocument, SceneDocument, TileDocument, TokenDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
const common={name:"Fixture",ownership:{default:0 as const},flags:{},system:{}};
const tile=(id:string):TileDocument=>({...common,_id:id,type:"tile",x:100,y:100,width:200,height:200,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}});
const token=(id:string,x=250,y=200):TokenDocument=>({...common,_id:id,type:"token",x,y,width:40,height:40,rotation:0,img:"",hidden:false,vision:false,disposition:"neutral",light:{radius:0,color:"#fff",alpha:0}});
function fixture() {
  const source=tile("source"),mover=token("mover"),other=token("other",350,250);
  const scene:SceneDocument={...common,_id:"s",type:"scene",width:1000,height:1000,active:true,img:null,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},tokens:[mover,other],tiles:[source],walls:[],lights:[],sounds:[],drawings:[],templates:[],notes:[]};
  const move:Extract<AutomationStep,{kind:"move"}>={id:"move",kind:"move",destinationOriginal:true,x:25,y:-50,targets:"triggering"};
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"source",methods:["enter","exit","stop","manual","click"],steps:[move]}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  const event:AutomationEvent={scene,tile:source,token:mover,method:"enter",originMethod:"enter",movementOriginal:{tokenId:"mover",x:700,y:600},caller:{id:"gm",role:"GM"},at:1000,rng:()=>0.5};
  const run=()=>planAutomation(world,graph,event,"gm");
  return {world,scene,source,mover,other,move,graph,event,run};
}
test("Original Destination is the immutable host-observed movement endpoint plus offsets",()=>{
  const f=fixture(),before=structuredClone(f.world),result=f.run();expect(result.ok).toBe(true);
  if(!result.ok||!("plan" in result))return;
  expect(result.plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens"&&op.ref.id==="mover")).toMatchObject({diff:{x:725,y:550}});
  expect(f.world).toEqual(before);
});
test("destination remains the original endpoint after an earlier staged move; target set shares endpoint",()=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"select",kind:"select",selector:{kind:"ids",refs:["mover","other"].map(id=>({coll:"tokens",id,parent:{coll:"scenes",id:"s"}}))}},
    {id:"first",kind:"move",x:25,y:25,targets:"current",triggerTiles:false});
  f.move.targets="current";
  const result=f.run();expect(result.ok).toBe(true);if(!result.ok||!("plan" in result))return;
  const moves=result.plan.ops.filter(op=>op.kind==="update"&&op.ref.coll==="tokens");
  expect(moves).toHaveLength(4);expect(moves.at(-2)).toMatchObject({ref:{id:"mover"},diff:{x:725,y:550}});expect(moves.at(-1)).toMatchObject({ref:{id:"other"},diff:{x:725,y:550}});
});
test.each(["manual","click"] as const)("%s has no Original Destination event context",method=>{
  const f=fixture();f.event.method=method;delete f.event.originMethod;expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed movement event")});
});
test("a movement trigger cannot use another token's original endpoint",()=>{
  const f=fixture();f.event.movementOriginal={tokenId:"other",x:700,y:600};expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed movement event")});
});
test("nested Trigger Tile preserves only the original triggering token endpoint",()=>{
  const f=fixture(),childTile={...f.source,_id:"child-tile",x:700},child:AutomationDocument={...common,_id:"child",type:"automation",definition:{version:1,sceneId:"s",tileId:"child-tile",methods:["manual"],steps:[{...f.move}]}};
  f.scene.tiles.push(childTile);f.world.automations.push(child);f.graph.definition.steps=[{id:"child",kind:"triggerTile",target:{kind:"id",tileId:"child-tile"},tokens:"triggering"}];
  expect(f.run()).toMatchObject({ok:true});
  f.graph.definition.steps=[{id:"child",kind:"triggerTile",target:{kind:"id",tileId:"child-tile"},tokens:"current"}];
  f.graph.definition.steps.unshift({id:"other",kind:"select",selector:{kind:"ids",refs:[{coll:"tokens",id:"other",parent:{coll:"scenes",id:"s"}}]}});
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed movement event")});
});
test("Original Destination and staged chat/world edits fail atomically when later actions reject",()=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"chat",kind:"chat",audience:"gm",content:"rolled back"},{id:"light",kind:"sceneLighting",mode:"set",darkness:0.5});
  f.graph.definition.steps.push({id:"fail",kind:"sceneLighting",mode:"add",darkness:1});
  const before=structuredClone(f.world);expect(f.run().ok).toBe(false);expect(f.world).toEqual(before);
});
test("missing, stale or invalid endpoint context rejects rather than choosing current coordinates",()=>{
  for(const setup of [(e:AutomationEvent)=>delete e.movementOriginal,(e:AutomationEvent)=>{if(e.movementOriginal)e.movementOriginal.x=NaN;},(e:AutomationEvent)=>{if(e.movementOriginal)e.movementOriginal.y=-1;}]){
    const f=fixture();setup(f.event);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed movement event")});
  }
});
test.each([{destinationOriginal:false},{destinationOriginal:"true"},{destinationOriginal:true,destination:{coll:"tiles",id:"source"}},
  {destinationOriginal:true,destinationTag:{kind:"tag",query:"x"}},{destinationOriginal:true,destinationResult:"rollTable"},
  {destinationOriginal:true,destinationChoice:"random"},{destinationOriginal:true,destinationPosition:"center"},
  {destinationOriginal:true,mode:"set"},{destinationOriginal:true,extra:true}])("schema rejects malformed or conflicting Original Destination policy %#",extra=>{
  const f=fixture(),step=f.graph.definition.steps[0];if(step?.kind!=="move")throw new Error("missing move");Object.assign(step,extra);
  expect(validateAutomation(f.graph.definition).ok).toBe(false);
});
test("destination policy remains optional and legacy coordinates keep existing semantics",()=>{
  const f=fixture(),step=f.graph.definition.steps[0];if(step?.kind!=="move")throw new Error("missing move");delete step.destinationOriginal;step.mode="set";step.x=500;step.y=600;
  expect(validateAutomation(f.graph.definition).ok).toBe(true);
});
