import { expect, test } from "vitest";
import { planAutomation, sweptTileEvents, validateAutomation, type AutomationEvent, type AutomationStep } from "../../src/core/automation";
import { moveDestinationPoint, snapshotMoveDestination, snapshotMoveEntry } from "../../src/core/moveDestination";
import type { AutomationDocument, SceneDocument, TileDocument, TokenDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
const common={name:"Fixture",ownership:{default:0 as const},flags:{},system:{}};
const tile=(id:string,x=100,y=100):TileDocument=>({...common,_id:id,type:"tile",x,y,width:200,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}});
function fixture() {
  const source=tile("source"),destination={...tile("destination",500,400),width:400,height:200,rotation:90,taggerTags:["destination"]};
  const token:TokenDocument={...common,_id:"token",type:"token",x:250,y:150,width:40,height:40,rotation:0,img:"",hidden:false,vision:false,disposition:"neutral",light:{radius:0,color:"#ffffff",alpha:0}};
  const scene:SceneDocument={...common,_id:"s",type:"scene",width:1000,height:1000,active:true,img:null,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},tokens:[token],tiles:[source,destination],walls:[],lights:[],sounds:[],drawings:[],templates:[],notes:[]};
  const move:Extract<AutomationStep,{kind:"move"}>={id:"move",kind:"move",destination:{coll:"tiles",id:"destination"},destinationPosition:"entry",x:0,y:0,targets:"triggering",triggerTiles:false};
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"source",methods:["enter","manual","click","exit","stop","create","rotate"],steps:[move]}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  let draws=0;
  const event:AutomationEvent={scene,tile:source,token,method:"enter",caller:{id:"gm",role:"GM"},at:1000,rng:()=>{draws++;return 0;},movementEntry:{tileId:"source",tokenId:"token",u:0,v:0.25}};
  const run=()=>planAutomation(world,graph,event,"gm");
  const plan=()=>{const result=run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan;};
  return {world,scene,source,destination,token,move,graph,event,run,plan,draws:()=>draws};
}
test.each([0,90,-90,45,450])("entry contact is normalized through source rotation %s",rotation=>{
  const source={...tile("source",300,300),rotation};
  const angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const p={x:400-100*c+25*s,y:350-100*s-25*c};
  const entry=snapshotMoveEntry(source,p);expect(entry?.u).toBeCloseTo(0);expect(entry?.v).toBeCloseTo(0.25);
});
test.each([{u:0,v:0},{u:1,v:1},{u:0.5,v:0},{u:1,v:0.25}])("scaled destination maps local entry $u/$v without RNG",entry=>{
  const snapshot=snapshotMoveDestination({...tile("d",500,300),width:400,height:200,rotation:90});if(!snapshot)throw new Error("snapshot");
  const point=moveDestinationPoint(snapshot,"entry",()=>{throw new Error("unexpected draw");},entry);
  expect(point.x).toBeCloseTo(700-(entry.v-0.5)*200);expect(point.y).toBeCloseTo(400+(entry.u-0.5)*400);
});
test("entry normalization absorbs numerical edge error only, refuses bad source geometry and outside points",()=>{
  const source=tile("s");expect(snapshotMoveEntry(source,{x:100-1e-8,y:125})).toEqual({u:0,v:0.25});
  expect(snapshotMoveEntry(source,{x:99,y:125})).toBeNull();expect(snapshotMoveEntry(source,{x:NaN,y:125})).toBeNull();
  expect(snapshotMoveEntry({...source,width:0},{x:100,y:125})).toBeNull();
});
test("swept diagonal crossing uses the boundary, not the final token location, including pass-through",()=>{
  const f=fixture(),before={...f.token,x:0,y:100},after={...f.token,x:400,y:150};
  const hit=sweptTileEvents(f.source,before,after).find(hit=>hit.method==="enter");expect(hit?.fraction).toBe(0.2);
  if(!hit)throw new Error("no hit");const entry=snapshotMoveEntry(f.source,{x:before.x+(after.x-before.x)*hit.fraction,y:before.y+(after.y-before.y)*hit.fraction},true);
  expect(entry?.u).toBe(0);expect(entry?.v).toBeCloseTo(0.1);
});
test("entry preserves an immutable source snapshot while staged destination geometry and offsets/snap apply",()=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"self",kind:"select",selector:{kind:"tile"}},
    {id:"source-move",kind:"move",targets:"current",x:200,y:200},
    {id:"dest",kind:"select",selector:{kind:"tag",query:"destination",collections:["tiles"]}},
    {id:"rotate",kind:"rotate",targets:"current",angle:0});
  f.move.xFormula="1d1 * 25";delete f.move.x;f.move.y=50;f.move.snapToGrid=true;f.move.durationMs=500;
  const before=structuredClone(f.world),plan=f.plan();
  // Staged rotation 0: local (0,.25) -> (500,450), offset -> (525,500), snap -> (550,550).
  expect(plan.ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:550,y:550,"flags.arenaMove":{x:550,y:550,durationMs:500}}});
  expect(f.world).toEqual(before);expect(f.draws()).toBe(1);
});
test("random tag destination choice combines with entry placement but consumes no area draws",()=>{
  const f=fixture();delete f.move.destination;f.move.destinationTag={kind:"tag",query:"destination",collections:["tiles"]};f.move.destinationChoice="random";
  f.scene.tiles.push({...f.destination,_id:"another",x:400});
  expect(f.plan().ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:750,y:300}});expect(f.draws()).toBe(1);
});
test("all movers share the triggering token's contact, including the destination itself",()=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"select",kind:"select",selector:{kind:"ids",refs:["source","destination"].map(id=>({coll:"tiles",id,parent:{coll:"scenes",id:"s"}}))}});
  f.move.targets="current";const ops=f.plan().ops.filter(op=>op.kind==="update"&&op.ref.coll==="tiles");
  expect(ops).toHaveLength(2);expect(ops[0]).toMatchObject({diff:{x:650,y:250}});expect(ops[1]).toMatchObject({diff:{x:550,y:200}});expect(f.draws()).toBe(0);
});
test("token destination ignores entry policy even without a movement context",()=>{
  const f=fixture();f.scene.tokens.push({...f.token,_id:"anchor",x:600,y:700});f.move.destination={coll:"tokens",id:"anchor"};f.event.method="manual";delete f.event.movementEntry;
  expect(f.plan().ops.find(op=>op.kind==="update"&&op.ref.coll==="tokens")).toMatchObject({diff:{x:600,y:700}});expect(f.draws()).toBe(0);
});
test.each(["manual","click","exit","stop","create","rotate"] as const)("%s does not borrow enter context",method=>{
  const f=fixture();f.event.method=method;expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed enter")});
});
test.each(["absent","wrong tile","wrong token","nan","outside","wall","bounds","later"])("entry %s rejects all staged writes",kind=>{
  const f=fixture();f.graph.definition.steps.unshift({id:"early",kind:"sceneLighting",mode:"set",darkness:0.5},{id:"chat",kind:"chat",audience:"gm",content:"must roll back"});
  if(kind==="absent")delete f.event.movementEntry;
  if(kind==="wrong tile"&&f.event.movementEntry)f.event.movementEntry.tileId="other";
  if(kind==="wrong token"&&f.event.movementEntry)f.event.movementEntry.tokenId="other";
  if(kind==="nan"&&f.event.movementEntry)f.event.movementEntry.u=NaN;
  if(kind==="outside"&&f.event.movementEntry)f.event.movementEntry.v=1.1;
  if(kind==="wall"){f.move.wallCollision="block";f.scene.walls.push({...common,_id:"w",type:"wall",c:[400,0,400,1000],door:0,oneWay:false,move:0,sight:0,light:0,sound:0});}
  if(kind==="bounds")f.move.x=1000;
  if(kind==="later")f.graph.definition.steps.push({id:"fail",kind:"sceneLighting",mode:"add",darkness:1});
  const before=structuredClone(f.world);expect(f.run().ok).toBe(false);expect(f.world).toEqual(before);
});
test("nested Trigger Tile cannot reuse a different tile's entry contact",()=>{
  const f=fixture();const child:AutomationDocument={...common,_id:"child",type:"automation",definition:{version:1,sceneId:"s",tileId:"destination",methods:["manual"],steps:[{...f.move}]}};
  f.world.automations.push(child);f.graph.definition.steps=[{id:"child",kind:"triggerTile",target:{kind:"id",tileId:"destination"},tokens:"triggering"}];
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("host-observed enter")});
});
test("entry is not retained by a later invocation",()=>{
  const f=fixture();expect(f.run().ok).toBe(true);delete f.event.movementEntry;expect(f.run().ok).toBe(false);
});
test.each(["coordinates","result","unknown"])("entry positioning refuses incompatible %s schema",kind=>{
  const f=fixture();if(kind==="unknown")Object.assign(f.move,{destinationPosition:"something"});
  else {delete f.move.destination;if(kind==="result")f.move.destinationResult="rollTable";}
  expect(validateAutomation(f.graph.definition).ok).toBe(false);
});
