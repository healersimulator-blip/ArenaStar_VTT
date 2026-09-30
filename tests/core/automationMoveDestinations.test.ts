import { expect, test } from "vitest";
import { planAutomation, validateAutomation, type AutomationStep } from "../../src/core/automation";
import { snapshotMoveDestination, moveDestinationPoint } from "../../src/core/moveDestination";
import type { AutomationDocument, SceneDocument, TileDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
const common={name:"Tile",ownership:{default:0 as const},flags:{},system:{}};
const tile=(id:string,x=100,y=100):TileDocument=>({...common,_id:id,type:"tile",x,y,width:100,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}});
const destinationTag={kind:"tag" as const,query:"destination",collections:["tiles" as const]};
function fixture(extra:Partial<Extract<AutomationStep,{kind:"move"}>>={}) {
  const mover=tile("mover"),a={...tile("a",400,300),width:200,rotation:90,taggerTags:["destination"]},b={...tile("b",700,300),taggerTags:["destination"]};
  const scene:SceneDocument={...common,_id:"s",type:"scene",width:1000,height:1000,active:true,img:null,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},tokens:[],tiles:[mover,a,b],walls:[],lights:[],sounds:[],drawings:[],templates:[],notes:[]};
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"mover",methods:["manual"],steps:[
    {id:"sel",kind:"select",selector:{kind:"tile"}},
    {id:"move",kind:"move",x:0,y:0,targets:"current",destinationTag:structuredClone(destinationTag),...extra},
  ]}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  let draws=0,random=()=>0.5;
  const run=()=>planAutomation(world,graph,{scene,tile:mover,method:"manual",caller:{id:"gm",role:"GM"},at:1000,rng:()=>{draws++;return random();}},"gm");
  const plan=()=>{const result=run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan;};
  const rng=(fn:()=>number)=>{random=fn;draws=0;};
  return {world,scene,mover,a,b,graph,run,plan,rng,draws:()=>draws};
}
test.each([0,0.499999,0.5,0.999999])("host random choice %s selects one destination uniformly and publishes only an endpoint",(roll)=>{
  const f=fixture({destinationChoice:"random",durationMs:500});f.rng(()=>roll);
  const before=structuredClone(f.world),plan=f.plan(),x=roll<0.5?450:700;
  expect(plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles")).toMatchObject({diff:{x,y:300,"flags.arenaMove":{x,y:300,durationMs:500}}});
  expect(f.draws()).toBe(1);expect(f.world).toEqual(before);
});
test("legacy and explicit unique policies retain fail-closed ambiguity without drawing randomness",()=>{
  for(const options of [{},{destinationChoice:"unique" as const}]){
    const f=fixture(options);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("matched 2")});expect(f.draws()).toBe(0);
  }
});
test("a singleton random destination consumes no choice draw, token positioning consumes no area draws",()=>{
  const f=fixture({destinationChoice:"random",destinationPosition:"random"});f.a.taggerTags=[];f.b.taggerTags=[];
  f.scene.tokens.push({...common,_id:"anchor-token",type:"token",taggerTags:["destination"],x:600,y:700,width:40,height:40,rotation:0,img:"",hidden:true,
    vision:false,disposition:"neutral",light:{radius:0,color:"#ffffff",alpha:0}});
  const step=f.graph.definition.steps[1];if(step?.kind!=="move"||!step.destinationTag)throw new Error("missing step");step.destinationTag.collections=["tokens"];
  expect(f.plan().ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles")).toMatchObject({diff:{x:550,y:650}});expect(f.draws()).toBe(0);
});
test("rotated random tile points precede X/Y offset dice and snap",()=>{
  const f=fixture({destinationChoice:"random",destinationPosition:"random",xFormula:"-1d1 * 25",y:10,snapToGrid:true});
  const move=f.graph.definition.steps[1];if(move?.kind!=="move")throw new Error("missing move");delete move.x;
  const rolls=[0,0,0.75,0.25];f.rng(()=>rolls.shift()??0);
  // choose a, point (475,250), offset (-25,+10), snap center (450,250).
  expect(f.plan().ops.find((op)=>op.kind==="update"&&op.ref.id==="mover")).toMatchObject({diff:{x:400,y:200}});expect(f.draws()).toBe(4);
});
test("destination snapshot survives moving itself; each mover gets its own placement point",()=>{
  const f=fixture({destinationChoice:"random",destinationPosition:"random"});
  f.graph.definition.steps[0]={id:"sel",kind:"select",selector:{kind:"ids",refs:["a","mover"].map((id)=>({coll:"tiles",id,parent:{coll:"scenes",id:"s"}}))}};
  const rolls=[0,0,0.75,0.75,0.25];f.rng(()=>rolls.shift()??0);
  const ops=f.plan().ops.filter((op)=>op.kind==="update"&&op.ref.coll==="tiles");
  expect(ops).toMatchObject([{ref:{id:"a"},diff:{x:375,y:200}},{ref:{id:"mover"},diff:{x:475,y:350}}]);expect(f.draws()).toBe(5);
});
test("random choice reads staged tags and staged destination geometry",()=>{
  const f=fixture({destinationChoice:"random",destinationPosition:"random"});
  f.a.taggerTags=[];f.b.taggerTags=[];
  f.graph.definition.steps.unshift({id:"anchor",kind:"select",selector:{kind:"ids",refs:[{coll:"tiles",id:"a",parent:{coll:"scenes",id:"s"}}]}},
    {id:"tag",kind:"tags",edit:"add",tags:["destination"]},{id:"advance",kind:"move",mode:"add",x:50,y:100,targets:"current"});
  expect(f.plan().ops.find((op)=>op.kind==="update"&&op.ref.id==="mover")).toMatchObject({diff:{x:500,y:400}});expect(f.draws()).toBe(2);
});
test.each(["missing","too many","wall","bounds","later"])("random placement %s fails the whole plan without retry",(reason)=>{
  const f=fixture({destinationChoice:"random",destinationPosition:"random",wallCollision:"block"});
  f.graph.definition.steps.unshift({id:"dark",kind:"sceneLighting",mode:"set",darkness:0.5});
  if(reason==="missing"){f.a.taggerTags=[];f.b.taggerTags=[];}
  if(reason==="too many")for(let i=0;i<1023;i++)f.scene.tiles.push({...f.b,_id:`extra-${i}`});
  if(reason==="wall")f.scene.walls.push({...common,_id:"wall",type:"wall",c:[300,0,300,1000],door:0,oneWay:false,move:0,sight:0,light:0,sound:0});
  if(reason==="bounds"){f.b.x=990;f.rng(()=>0.99);}
  if(reason==="later")f.graph.definition.steps.push({id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
  const before=structuredClone(f.world);expect(f.run().ok).toBe(false);expect(f.world).toEqual(before);
  expect(f.draws()).toBe(reason==="missing"||reason==="too many"?0:3);
});
test.each([NaN,Infinity,-0.01,1])("invalid random choice/placement draw %s fails closed",(roll)=>{
  for(const stage of ["choice","point"]){
    const f=fixture({destinationChoice:"random",destinationPosition:"random"});let count=0;
    f.rng(()=>stage==="choice"||count++>0?roll:0.5);
    const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("invalid host RNG")});expect(f.world).toEqual(before);
  }
});
test("placement and offset dice share the cumulative nested Move budget even for unchanged endpoints",()=>{
  const f=fixture({destinationPosition:"random"});f.b.taggerTags=[];
  // 512 placements consume 1024 draws even though their centers are unchanged.
  f.graph.definition.steps=[...Array.from({length:512},(_,i):AutomationStep=>({id:`move-${i}`,kind:"move",destination:{coll:"tiles",id:"a"},destinationPosition:"random",x:0,y:0,targets:"current"})),
    {id:"child",kind:"triggerTile",target:{kind:"id",tileId:"b"},tokens:"triggering"}];
  // Current starts empty for manual events; explicitly select the mover first.
  f.graph.definition.steps.unshift({id:"sel",kind:"select",selector:{kind:"tile"}});
  f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"b",steps:[
    {id:"sel",kind:"select",selector:{kind:"tile"}},
    {id:"extra",kind:"move",mode:"add",xFormula:"1d1 * 0",y:0,targets:"current"},
  ]}});
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("1024 random draws")});expect(f.draws()).toBe(1024);expect(f.mover.x).toBe(100);
});
test.each([
  {destinationChoice:"first"},{destinationChoice:null},{destinationChoice:"random",destinationTag:undefined},
  {destinationPosition:"unsupported"},{destinationPosition:null},{destinationPosition:"random",destinationTag:undefined},
].map((extra)=>({extra})))("rejects malformed or inapplicable destination policies $extra",({extra})=>{
  const f=fixture();const step=f.graph.definition.steps[1];expect(validateAutomation({...f.graph.definition,steps:[{...step,...extra}]}).ok).toBe(false);
});
test.each([0,90,-90,450])("random local rectangle transforms correctly at %s degrees",(rotation)=>{
  const snapshot=snapshotMoveDestination({...tile("a",400,300),width:200,rotation});if(!snapshot)throw new Error("invalid snapshot");
  const rolls=[0,0.75],point=moveDestinationPoint(snapshot,"random",()=>rolls.shift()??0);
  const angle=rotation*Math.PI/180;
  expect(point.x).toBeCloseTo(500-100*Math.cos(angle)-25*Math.sin(angle));
  expect(point.y).toBeCloseTo(350-100*Math.sin(angle)+25*Math.cos(angle));
});
test.each([{width:0},{height:-1},{rotation:NaN},{x:Infinity}])("invalid destination geometry %j refuses snapshot",(extra)=>{
  expect(snapshotMoveDestination({...tile("a"),...extra})).toBeNull();
});
