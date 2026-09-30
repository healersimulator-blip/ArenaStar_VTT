import { expect, test } from "vitest";
import { planAutomation, type AutomationStep } from "../../src/core/automation";
import type { AutomationDocument, DrawingDocument, SceneDocument, TileDocument } from "../../src/core/documents";
import { moveGeometry } from "../../src/core/movePlaceable";
import type { Op } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";
import { environmentPlaceables } from "../fixtures/automationPlaceables";

const common={name:"Mover",ownership:{default:0 as const},flags:{},system:{},taggerTags:["move"]};
const drawing=(kind:DrawingDocument["kind"]="rect"):DrawingDocument=>({...common,_id:"drawing",type:"drawing",kind,
  points:["line","poly","freehand"].includes(kind)?[100,150,200,150,200,210]:[],
  box:["rect","ellipse","text"].includes(kind)?[100,150,100,60]:null,stroke:"#ffffff",fill:"none",strokeWidth:2,text:kind==="text"?"Label":null});
const select:AutomationStep={id:"sel",kind:"select",selector:{kind:"tag",query:"move",collections:["drawings","lights","sounds","templates"]}};
function fixture(extra:AutomationStep[]=[{id:"move",kind:"move",x:600,y:650,targets:"current"}]) {
  const tile:TileDocument={...common,_id:"tile",type:"tile",x:100,y:100,width:100,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}};
  const scene:SceneDocument={...common,_id:"s",type:"scene",active:true,img:null,width:1000,height:1000,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},
    tokens:[],tiles:[tile],walls:[],drawings:[drawing()],notes:[],...environmentPlaceables()};
  for(const coll of ["lights","sounds","templates"] as const)for(const doc of scene[coll])doc.taggerTags=["move"];
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"tile",methods:["manual"],steps:[select,...extra]}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  const event={scene,tile,method:"manual" as const,caller:{id:"gm",role:"GM" as const},at:1000,rng:()=>0};
  const run=()=>planAutomation(world,graph,event,"gm");
  const changes=()=>{const result=run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan.ops.filter((op):op is Extract<Op,{kind:"update"}>=>op.kind==="update"&&op.ref.coll!=="automations");};
  return {world,scene,tile,graph,event,run,changes};
}
test("Move atomically positions four additional placeable types without animation hints or input mutation",()=>{
  const f=fixture([{id:"move",kind:"move",x:600,y:650,targets:"current",durationMs:60000,speed:0.01}]);
  const before=structuredClone(f.world),ops=f.changes();expect(ops).toHaveLength(4);
  for(const op of ops)expect(op.diff).toEqual(op.ref.coll==="drawings"?{points:[],box:[550,620,100,60]}:{x:600,y:650});
  expect(f.world).toEqual(before);
});
test.each(["rect","ellipse","text","line","poly","freehand"] as const)("Move preserves %s geometry/style in staged relative moves",(kind)=>{
  const f=fixture([{id:"first",kind:"move",mode:"add",xFormula:"1d1 * 50",y:-25,targets:"current"},
    {id:"second",kind:"move",mode:"add",x:-10,y:5,targets:"current"}]);
  f.scene.drawings=[drawing(kind)];
  const ops=f.changes().filter((op)=>op.ref.coll==="drawings");expect(ops).toHaveLength(2);
  const expected=kind==="rect"||kind==="ellipse"||kind==="text"?{points:[],box:[140,130,100,60]}:{points:[140,130,240,130,240,190],box:null};
  expect(ops[1]?.diff).toEqual(expected);expect(f.scene.drawings[0]).toEqual(drawing(kind));
});
test("Move can mix all six placeable types and only token/tile endpoints get animation hints",()=>{
  const f=fixture([{id:"move",kind:"move",mode:"add",x:100,y:0,durationMs:1000,targets:"current"}]);
  f.scene.tokens.push({...common,_id:"token",type:"token",x:200,y:200,width:40,height:40,rotation:0,img:"",hidden:false,
    vision:false,disposition:"neutral",light:{radius:0,color:"#ffffff",alpha:0}});
  f.graph.definition.steps[0]={id:"sel",kind:"select",selector:{kind:"tag",query:"move",collections:["tokens","tiles","drawings","lights","sounds","templates"]}};
  const ops=f.changes();expect(ops).toHaveLength(6);
  expect(ops.filter((op)=>op.diff["flags.arenaMove"])).toHaveLength(2);
});
test.each(["entity","tag"] as const)("additional placeables move to %s centers plus offsets and grid snap",(source)=>{
  const f=fixture([{id:"move",kind:"move",...(source==="entity"?{destination:{coll:"tiles" as const,id:"tile"}}:
    {destinationTag:{kind:"tag" as const,query:"anchor",collections:["tiles" as const]}}),x:-25,yFormula:"1d1 * 125",snapToGrid:true,targets:"current"}]);
  f.tile.taggerTags=["anchor"];
  for(const op of f.changes())expect(op.diff).toEqual(op.ref.coll==="drawings"?{points:[],box:[100,220,100,60]}:{x:150,y:250});
});
test.each(["block","footprint"] as const)("Move %s wall policy rejects point emitters and restores earlier writes",(wallCollision)=>{
  const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},{id:"move",kind:"move",x:600,y:300,targets:"current",wallCollision}]);
  f.scene.walls.push({...common,_id:"wall",type:"wall",c:[450,0,450,900],door:0,oneWay:false,move:1,sight:1,light:1,sound:1});
  f.scene.drawings=[];const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("blocked")});expect(f.world).toEqual(before);
  const wall=f.scene.walls[0];if(!wall)throw new Error("missing wall");wall.door=1;expect(f.changes()).toHaveLength(4); // lighting plus three movers
});
test("drawing footprint uses bounding rectangle, including a horizontal line",()=>{
  const f=fixture([{id:"move",kind:"move",mode:"add",x:300,y:0,wallCollision:"footprint",targets:"current"}]);
  f.scene.drawings=[{...drawing("line"),points:[100,150,200,150]}];
  f.scene.walls.push({...common,_id:"wall",type:"wall",c:[350,100,350,200],door:0,oneWay:false,move:0,sight:0,light:0,sound:0});
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("footprint")});
});
test.each(["bounds","missing","later","unsupported"])("Move %s failure rolls back a mixed placeable plan",(reason)=>{
  const f=fixture(),before=structuredClone(f.world);
  if(reason==="bounds")f.graph.definition.steps.push({id:"outside",kind:"move",x:990,y:990,targets:"current"});
  if(reason==="later")f.graph.definition.steps.push({id:"first",kind:"sceneLighting",mode:"add",darkness:1},{id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
  if(reason==="missing")f.graph.definition.steps.splice(1,0,{id:"delete",kind:"delete"});
  if(reason==="unsupported")f.graph.definition.steps[0]={id:"select",kind:"select",selector:{kind:"tag",query:"move",collections:["scenes","drawings"]}};
  expect(f.run().ok).toBe(false);expect(f.scene).toEqual(before.scenes[0]);
});
test("nonanimated no-ops emit no geometry updates, changed points clear stale motion hints",()=>{
  const f=fixture([{id:"move",kind:"move",mode:"add",x:0,y:0,targets:"current",durationMs:1000}]);
  expect(f.changes()).toEqual([]);
  const light=f.scene.lights[0];if(!light)throw new Error("missing light");light.flags.arenaMove={x:300,y:300,durationMs:500};
  f.graph.definition.steps.push({id:"changed",kind:"move",mode:"add",x:25,y:0,targets:"current"});
  expect(f.changes().find((op)=>op.ref.coll==="lights")?.diff).toEqual({x:325,y:300,"flags.arenaMove":{}});
});
test.each([
  {points:[1,2,3],box:null,kind:"line"},{points:[0,0,NaN,5],box:null,kind:"poly"},
  {points:[],box:null},{points:[],box:[0,0,-1,50]},{points:Array(2050).fill(1),box:null,kind:"line"},
].map((extra)=>({extra})))("Move refuses malformed drawing geometry $extra",({extra})=>{
  expect(moveGeometry({...drawing(),...extra} as DrawingDocument)).toBeNull();
});

test("speed does not impose a visual duration limit on nonanimated emitters/drawings",()=>{
  const f=fixture([{id:"move",kind:"move",x:800,y:800,speed:0.01,targets:"current"}]);
  expect(f.changes()).toHaveLength(4);
});
test("malformed later geometry rejects all earlier staged movement",()=>{
  const f=fixture();f.scene.drawings=[{...drawing("poly"),points:[0,0,10,10]}];
  const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("invalid committed geometry")});expect(f.world).toEqual(before);
});
