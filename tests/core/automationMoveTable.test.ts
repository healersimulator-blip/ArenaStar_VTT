import { expect, test } from "vitest";
import { planAutomation, validateAutomation, type AutomationStep } from "../../src/core/automation";
import { moveTableLocation } from "../../src/core/moveDestination";
import type { AutomationDocument, RollTableDocument, SceneDocument, TileDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
import { environmentPlaceables } from "../fixtures/automationPlaceables";
const common={name:"Fixture",ownership:{default:0 as const},flags:{},system:{}};
const roll:AutomationStep={id:"roll",kind:"rollTable",tableId:"table",audience:"gm"};
const move:AutomationStep={id:"move",kind:"move",destinationResult:"rollTable",x:0,y:0,targets:"current"};
function fixture(text='{"x":600,"y":400}') {
  const tile:TileDocument={...common,_id:"tile",type:"tile",x:100,y:100,width:100,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}};
  const scene:SceneDocument={...common,_id:"s",type:"scene",active:true,img:null,width:1000,height:1000,darkness:0,
    grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},tokens:[],tiles:[tile],walls:[],drawings:[],notes:[],...environmentPlaceables()};
  const table:RollTableDocument={...common,_id:"table",type:"rollTable",formula:"1d1",results:[{range:[1,1],text,documentRef:null}]};
  const graph:AutomationDocument={...common,_id:"graph",type:"automation",definition:{version:1,sceneId:"s",tileId:"tile",methods:["manual"],steps:[
    {id:"self",kind:"select",selector:{kind:"tile"}},structuredClone(roll),structuredClone(move),
  ]}};
  const world=emptyWorld();world.scenes.push(scene);world.rollTables.push(table);world.automations.push(graph);
  let draws=0;const event={scene,tile,method:"manual" as const,caller:{id:"gm",role:"GM" as const},at:1000,rng:()=>{draws++;return 0;}};
  const run=()=>planAutomation(world,graph,event,"gm");
  const plan=()=>{const result=run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan;};
  return {world,scene,tile,table,graph,event,run,plan,draws:()=>draws};
}
test.each(['{"x":600,"y":400}',' { "y": 4e2, "x": 600.0 }\n'])('strict coordinate result accepts %s',(text)=>{
  expect(moveTableLocation(text)).toEqual({x:600,y:400});
});
test("coordinate result accepts its numeric/text bounds",()=>{
  const base='{"x":0,"y":1e9}';expect(moveTableLocation(base.padEnd(256," "))).toEqual({x:0,y:1e9});expect(moveTableLocation(base.padEnd(257," "))).toBeNull();
});
test.each([
  null,undefined,{},[],0,"",'{"x":1}', '[1,2]', '{"x":"1","y":2}', '{"x":-1,"y":0}', '{"x":1e10,"y":0}',
  '{"x":1e999,"y":0}', '{"x":NaN,"y":0}', '{"x":1,"x":2}', '{"x":1,"x":2,"y":3}',
  '{"x":1,"y":2,"sceneId":"other"}', '{"x":1,"y":2,"__proto__":{}}', '{"x":1+2,"y":2}',
  '{"x":01,"y":2}', '{"x":1,"y":2,}', '{{x}}', '{"x":1,\u00a0"y":2}',
].map((text)=>({text})))('rejects malformed coordinate text $text',({text})=>expect(moveTableLocation(text)).toBeNull());
test("Roll Table location preserves selected movers, posts the GM roll, then applies offsets/snap/duration",()=>{
  const f=fixture();f.graph.definition.steps[2]={...move,xFormula:"-1d1 * 25",y:40,snapToGrid:true,durationMs:500};
  const step=f.graph.definition.steps[2];if(step?.kind!=="move")throw new Error("missing move");delete step.x;
  const before=structuredClone(f.world),plan=f.plan();
  expect(plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles")).toMatchObject({diff:{x:500,y:400,"flags.arenaMove":{x:500,y:400,durationMs:500}}});
  expect(plan.ops.find((op)=>op.kind==="create"&&op.coll==="messages")).toMatchObject({data:{content:'{&quot;x&quot;:600,&quot;y&quot;:400}',whisper:["gm"]}});
  expect(f.draws()).toBe(2);expect(f.world).toEqual(before);
});
test("one result point moves multiple environment placeables without extra table rolls",()=>{
  const f=fixture();f.graph.definition.steps[0]={id:"select",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["lights","sounds","templates"]}};
  const ops=f.plan().ops.filter((op)=>op.kind==="update"&&op.ref.parent?.coll==="scenes");
  expect(ops).toHaveLength(3);for(const op of ops)expect(op).toMatchObject({diff:{x:600,y:400}});expect(f.draws()).toBe(1);
});
test.each(["missing","missed","malformed","outside","wall","later"])("table location %s rejects all staged writes and messages",(reason)=>{
  const f=fixture();
  if(reason==="missing")f.graph.definition.steps.splice(1,1);
  if(reason==="missed")f.table.results[0]={range:[2,2],text:'{"x":600,"y":400}',documentRef:null};
  if(reason==="malformed")f.table.results[0]={range:[1,1],text:"not coordinates",documentRef:null};
  if(reason==="outside")f.table.results[0]={range:[1,1],text:'{"x":2000,"y":400}',documentRef:null};
  if(reason==="wall") {f.scene.walls.push({...common,_id:"wall",type:"wall",c:[300,0,300,1000],door:0,oneWay:false,move:0,sight:0,light:0,sound:0});f.graph.definition.steps[2]={...move,wallCollision:"block"};}
  if(reason==="later")f.graph.definition.steps.push({id:"max",kind:"sceneLighting",mode:"set",darkness:1},{id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
  f.graph.definition.steps.unshift({id:"early",kind:"sceneLighting",mode:"set",darkness:0.5});
  const before=structuredClone(f.world);expect(f.run().ok).toBe(false);expect(f.world).toEqual(before);
});
test.each(["valid","missed","malformed"])("the latest executed roll replaces earlier text, including a %s result",(kind)=>{
  const f=fixture();f.world.rollTables.push({...f.table,_id:"second",results:[{range:kind==="missed"?[2,2]:[1,1],text:kind==="malformed"?"bad":'{"x":400,"y":600}',documentRef:null}]});
  f.graph.definition.steps.splice(2,0,{...roll,id:"second-roll",tableId:"second"});
  if(kind==="valid")expect(f.plan().ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles")).toMatchObject({diff:{x:350,y:550}});
  else expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("Roll Table result")});
});
test.each(["parent","child","neither"])("table result scope belongs to each invocation (%s)",(where)=>{
  const f=fixture();f.scene.tiles.push({...f.tile,_id:"child"});
  const child:AutomationDocument={...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[
    {id:"self",kind:"select",selector:{kind:"tile"}},...(where==="child"?[structuredClone(roll)]:[]),structuredClone(move),
  ]}};
  f.world.automations.push(child);if(where!=="parent")f.graph.definition.steps.splice(1,1);
  f.graph.definition.steps.splice(f.graph.definition.steps.length-1,0,{id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"});
  // A parent roll is not inherited by the child, and a child roll is not returned to the parent.
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("this graph invocation")});
});
test("a child's independent roll cannot overwrite the parent's latest result",()=>{
  const f=fixture();f.scene.tiles.push({...f.tile,_id:"child"});f.world.rollTables.push({...f.table,_id:"other",results:[{range:[1,1],text:'{"x":200,"y":200}',documentRef:null}]});
  f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[{...roll,tableId:"other"}]}});
  f.graph.definition.steps.splice(2,0,{id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"});
  expect(f.plan().ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles")).toMatchObject({diff:{x:550,y:350}});
});
test("last-table location does not survive between runs or come from a named variable",()=>{
  const f=fixture();f.plan();f.graph.definition.steps[1]={id:"fake",kind:"set",name:"location",value:'{"x":600,"y":400}'};
  expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("this graph invocation")});
});
test("nested table draws share a bounded budget and reject without partial messages",()=>{
  const f=fixture();f.table.formula="1000d1";f.table.results=[{range:[1000,1000],text:'{"x":600,"y":400}',documentRef:null}];
  f.scene.tiles.push({...f.tile,_id:"child"});f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[structuredClone(roll)]}});
  f.graph.definition.steps.push({id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"});
  const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("1024 random draws")});expect(f.draws()).toBe(1024);expect(f.world).toEqual(before);
});
test.each([-0.1,1,Infinity,NaN])("table RNG %s fails closed",(value)=>{
  const f=fixture();f.event.rng=()=>value;expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("invalid host RNG")});
});
test.each([
  {destinationResult:"chat"},{destinationResult:null},{destinationResult:"rollTable",mode:"add"},
  {destinationResult:"rollTable",xMode:"set"},{destinationResult:"rollTable",destinationChoice:"random"},
  {destinationResult:"rollTable",destinationPosition:"random"},{destinationResult:"rollTable",destination:{coll:"tiles",id:"tile"}},
  {destinationResult:"rollTable",destinationTag:{kind:"tag",query:"a"}},
])("result destination rejects conflicting/invalid fields %j",(extra)=>{
  const f=fixture();expect(validateAutomation({...f.graph.definition,steps:[{...move,...extra}]}).ok).toBe(false);
});
