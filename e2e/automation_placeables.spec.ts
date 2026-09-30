import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { WorldFileDocuments } from "../src/host/worldFile";
import type { SceneDocument } from "../src/core/documents";
import { entry, hostCall, manualFragment, playerCall, waitForSurface } from "./lib";

async function rendered(page:Page) {
  return page.evaluate(()=>{
    type Node={x:number;y:number;visible:boolean;children:Node[];parent:Node|null;getLocalBounds():{x:number;y:number;width:number;height:number};getChildByLabel(label:string,deep:boolean):Node|null};
    const g=globalThis as unknown as {__stage?:{app:{stage:Node}};__canvasStage?:{app:{stage:Node}}};
    const root=(g.__stage??g.__canvasStage)?.app.stage;
    const light=root?.getChildByLabel("lights",true)?.children[0];
    const drawing=root?.getChildByLabel("drawingGeometry",true),template=root?.getChildByLabel("templateGeometry",true);
    const center=(node:Node|undefined|null)=>{if(!node)return null;const b=node.getLocalBounds();return {x:Math.round((b.x+b.width/2)*1e4)/1e4,y:Math.round((b.y+b.height/2)*1e4)/1e4};};
    const fog=root?.getChildByLabel("fog",true),holder=root?.getChildByLabel("drawings",true),templates=root?.getChildByLabel("templates",true);
    const below=(node:Node|undefined|null)=>!!node&&!!fog&&node.parent===fog.parent&&(node.parent?.children.indexOf(node)??-1)<(fog.parent?.children.indexOf(fog)??-1);
    return {light:light?{x:light.x,y:light.y}:null,drawing:center(drawing),template:center(template),
      labelVisible:template?.parent?.children[1]?.children[0]?.visible??false,belowFog:below(holder)&&below(templates)};
  });
}

test("Move draws lights, line geometry and imported templates on GM/player replicas with Undo, reload and Revert",async({page,browser})=>{
  test.setTimeout(120_000);
  await page.goto(entry+"?e2e=1");await waitForSurface(page,"app");
  const box=await page.locator(".canvas-host canvas").boundingBox();if(!box)throw new Error("missing canvas");
  await page.locator('[data-canvas-tool="light"]').click();await page.locator('[data-canvas-light-radius="2"]').click();
  await page.mouse.click(box.x+300,box.y+220);await expect.poll(()=>hostCall<unknown[]>(page,"lights")).toHaveLength(1);
  await page.locator('[data-canvas-tool="draw"]').click();await page.locator('[data-canvas-shape="line"]').click();
  await page.mouse.move(box.x+200,box.y+300);await page.mouse.down();await page.mouse.move(box.x+400,box.y+320,{steps:5});await page.mouse.up();
  await expect.poll(()=>hostCall<unknown[]>(page,"drawings")).toHaveLength(1);

  // Persisted template authoring is not on the rail: import a real world-file fixture,
  // not a renderer smoke hook or direct host-store mutation.
  const [download]=await Promise.all([page.waitForEvent("download"),page.locator("#export-world").click()]);
  const path=await download.path();if(!path)throw new Error("missing world download");
  const files=unzipSync(new Uint8Array(await readFile(path))),bytes=files["documents.json"];if(!bytes)throw new Error("missing documents");
  const documents=JSON.parse(strFromU8(bytes)) as WorldFileDocuments;
  const scene=documents.docs.find((row)=>row.coll==="scenes")?.doc as SceneDocument|undefined;if(!scene)throw new Error("missing scene");
  scene.templates.push({_id:"move-template",type:"template",name:"Moving circle",ownership:{default:1},flags:{},system:{},kind:"circle",x:300,y:350,distance:50,direction:0,width:0});
  files["documents.json"]=strToU8(JSON.stringify(documents));
  await page.locator("#close-world").click();await page.locator("#role-import").setInputFiles({name:"placeable-move.world.zip",mimeType:"application/zip",buffer:Buffer.from(zipSync(files))});
  await page.locator("[data-open-dialog] [data-open-replace]").click();await waitForSurface(page,"app");
  // Light polygons arrive asynchronously from the worker; a ready template alone
  // does not mean all three rendered objects are ready for the baseline snapshot.
  await expect.poll(()=>rendered(page)).toMatchObject({labelVisible:true,belowFog:true,template:{x:300,y:350},
    light:{x:expect.any(Number),y:expect.any(Number)},drawing:{x:expect.any(Number),y:expect.any(Number)}});
  const before=await rendered(page);if(!before.light||!before.drawing)throw new Error("placeables did not render");
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  const zones=page.locator("[data-active-zones]");await zones.locator("[data-zone-tile-create] summary").click();
  await zones.locator("[data-zone-tile-create]").getByLabel("Tile name").fill("Placeable carrier");
  await zones.locator("[data-zone-create-tile]").click();await zones.locator("[data-zone-name]").fill("Placeable carrier");
  await zones.getByRole("button",{name:"Remove step 2"}).click();
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("ids");
  const pins=zones.getByLabel("Pinned entities",{exact:true});
  const refs=await pins.locator("option").filter({hasText:/^(lights|drawings|templates):/}).evaluateAll((options)=>options.map((o)=>(o as HTMLOptionElement).value));
  expect(refs).toHaveLength(3);await pins.selectOption(refs);
  await zones.locator('[data-zone-add="move"]').click();await zones.getByLabel("Move mode",{exact:true}).selectOption("add");
  await zones.getByLabel("Move X",{exact:true}).fill("125.25");await zones.getByLabel("Move Y",{exact:true}).fill("-25.5");
  // These non-token/tile placeables must still cut, not wait a minute for animation.
  await zones.getByLabel("Move duration",{exact:true}).fill("60000");
  const save=async()=>{const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-save]").click();await expect(zones.getByRole("alert")).toHaveCount(0);await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);};
  await save();
  const moved={...before,light:{x:before.light.x+125.25,y:before.light.y-25.5},drawing:{x:before.drawing.x+125.25,y:before.drawing.y-25.5},template:{x:425.25,y:324.5}};
  const context=await browser.newContext(),player=await context.newPage();
  try {
    await page.locator('[data-window="macros"] [data-window-close]').click();await page.locator("#share").click();
    const fragment=manualFragment(await page.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(()=>player.locator("#offer-out").inputValue(),{timeout:20_000}).not.toBe("");
    await page.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());await page.locator("#code-apply").click();
    await expect.poll(()=>page.locator("#share-out").inputValue(),{timeout:20_000}).not.toBe("");
    await player.locator("#answer-input").fill(await page.locator("#share-out").inputValue());await player.locator("#answer-apply").click();
    await expect.poll(()=>playerCall<boolean>(player,"connected"),{timeout:30_000}).toBe(true);await waitForSurface(player,"playerCanvas");
    await expect.poll(()=>rendered(player)).toEqual(before);
    await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
    await zones.locator("li").filter({hasText:"Placeable carrier"}).getByRole("button",{name:"Edit"}).click();
    const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);
    await expect.poll(()=>rendered(page)).toEqual(moved);await expect.poll(()=>rendered(player)).toEqual(moved);
    await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();
    await expect.poll(()=>rendered(page)).toEqual(before);await expect.poll(()=>rendered(player)).toEqual(before);
  } finally {await context.close();}
  await hostCall(page,"drainOps");await page.reload();await waitForSurface(page,"app");await expect.poll(()=>rendered(page)).toEqual(before);
  await page.locator("#gm-macros").click();await page.locator("[data-macro-zones-tab]").click();
  await zones.locator("li").filter({hasText:"Placeable carrier"}).getByRole("button",{name:"Edit"}).click();
  await expect(zones.getByLabel("Move X",{exact:true})).toHaveValue("125.25");await expect(pins).toHaveValues(refs);
  await zones.getByLabel("Move mode",{exact:true}).selectOption("set");await zones.getByLabel("Move X",{exact:true}).fill("650.125");await zones.getByLabel("Move Y",{exact:true}).fill("350.25");
  await save();await zones.locator("[data-zone-run]").click();
  await expect.poll(()=>rendered(page)).toEqual({...before,light:{x:650.125,y:350.25},drawing:{x:650.125,y:350.25},template:{x:650.125,y:350.25}});
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.getByTestId("action-revert-card").filter({hasText:"Placeable carrier"}).filter({has:page.getByTestId("action-revert")}).getByTestId("action-revert").click();
  await expect.poll(()=>rendered(page)).toEqual(before);
});
