import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

for (const targeting of ["legacy","pins","tag-destination","random-destination"] as const) test(`GM captures and places two atomic prefabs, then despawns one (${targeting})`, async ({ page }) => {
  const pinned=targeting!=="legacy",randomDestination=targeting==="random-destination",tagDestination=targeting==="tag-destination"||randomDestination;
  if(pinned)test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Prefab bell");
  await tile.getByLabel("X", { exact: true }).fill("350");
  await tile.getByLabel("Y", { exact: true }).fill("400");
  await tile.getByLabel("Width").fill("160");
  await tile.getByLabel("Height").fill("160");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Prefab bell" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Bell graph");
  const sourceTile=await zones.locator("[data-zone-tile]").inputValue();
  if(pinned) {
    await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("ids");
    const pins=zones.getByLabel("Pinned entities",{exact:true});
    const value=await pins.locator("option").filter({hasText:"Prefab bell"}).getAttribute("value");if(!value)throw new Error("missing pin option");
    await pins.selectOption(value);
    await zones.locator('[data-zone-add="collection"]').click();
    const collection=zones.locator("[data-zone-step]").last();
    await collection.getByLabel("Change current collection").selectOption("replace");
    await collection.getByRole("combobox",{name:"Entities",exact:true}).selectOption("ids");
    await collection.getByLabel("Pinned collection entities",{exact:true}).selectOption(value);
    await zones.locator('[data-zone-add="rotate"]').click();
    await zones.getByLabel("Rotation angle",{exact:true}).fill("90");
    if(tagDestination) {
      await zones.locator('[data-zone-add="move"]').click();
      await zones.getByLabel("Move destination source",{exact:true}).selectOption("tag");
      await zones.getByLabel("Move destination tags",{exact:true}).fill("follow-{id}");
      await zones.getByLabel("Include Move destination refs",{exact:true}).selectOption(value);
      await zones.getByLabel("Move X",{exact:true}).fill("100");
      if(randomDestination) {
        await zones.getByLabel("Move destination choice",{exact:true}).selectOption("random");
        await zones.getByLabel("Move destination positioning",{exact:true}).selectOption("random");
      }
    }
  }
  await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Bell graph" })).toHaveCount(1);

  if(tagDestination) {
    await page.locator("[data-macro-tags-tab]").click();
    const tags=page.locator("[data-tagger]");await tags.getByLabel("Taggable object type").selectOption("tiles");
    const row=tags.locator(".result").filter({hasText:"Prefab bell"});
    await row.locator('input[type="checkbox"]').check();await tags.getByLabel("Tags to edit").fill("follow-{id}");
    await tags.getByRole("button",{name:"Add",exact:true}).click();await expect(row).toContainText("follow-{id}");
  }
  await page.locator("[data-macro-prefabs-tab]").click();
  const panel = page.locator("[data-prefab-panel]");
  await panel.locator("[data-prefab-name]").fill("Two bells");
  await panel.locator("[data-prefab-parts]").getByText("Prefab bell").click();
  await expect(panel.locator("[data-prefab-root]")).not.toHaveValue("");
  await panel.locator("[data-prefab-save]").click();
  await expect(panel.getByRole("status")).toContainText("1 graphs");
  await expect(panel.locator("[data-prefab-list] option").filter({ hasText: "Two bells" })).toHaveCount(1);
  await panel.getByLabel("X", { exact: true }).fill("500");
  await panel.getByLabel("Y", { exact: true }).fill("450");
  await panel.locator("[data-prefab-preview]").click();
  await expect(panel.getByRole("status")).toContainText("2 atomic creates");
  const before = await hostCall<number>(page, "seq");
  await panel.locator("[data-prefab-place]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(panel.locator("[data-prefab-instances] summary")).toContainText("1");
  await panel.getByLabel("X", { exact: true }).fill("720");
  await panel.locator("[data-prefab-place]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 2);
  await expect(panel.locator("[data-prefab-instances] summary")).toContainText("2");
  if(pinned) {
    await page.locator("[data-macro-zones-tab]").click();
    await zones.locator("li").filter({hasText:/Bell graph · [a-f0-9]{8} ·/}).first().getByRole("button",{name:"Edit"}).click();
    await expect(zones.locator("[data-zone-tile]")).not.toHaveValue(sourceTile);
    const cloneTile=await zones.locator("[data-zone-tile]").inputValue();
    const sceneId=await hostCall<string>(page,"activeSceneId");
    await expect(zones.getByLabel("Pinned entities",{exact:true})).toHaveValues([JSON.stringify([sceneId,"tiles",cloneTile])]);
    await expect(zones.getByLabel("Pinned collection entities",{exact:true})).toHaveValues([JSON.stringify([sceneId,"tiles",cloneTile])]);
    const angles=()=>page.evaluate(()=>{
      type Node={rotation:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
      const stage=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage;
      return stage?.getChildByLabel("tilesBelow",true)?.children.map((child)=>Math.round(child.rotation*180/Math.PI)).sort((a,b)=>a-b);
    });
    const positions=()=>page.evaluate(()=>{
      type Node={x:number;y:number;rotation:number;children:Node[];getChildByLabel(label:string,deep:boolean):Node|null};
      const stage=(globalThis as unknown as {__stage?:{app:{stage:Node}}}).__stage?.app.stage;
      return stage?.getChildByLabel("tilesBelow",true)?.children.map((child)=>({x:child.x,y:child.y,angle:Math.round(child.rotation*180/Math.PI)}))??[];
    });
    const beforePositions=await positions();
    if(tagDestination) {
      await expect(zones.getByLabel("Move destination tags",{exact:true})).toHaveValue(`follow-${cloneTile}`);
      if(randomDestination) {
        await expect(zones.getByLabel("Move destination choice",{exact:true})).toHaveValue("random");
        await expect(zones.getByLabel("Move destination positioning",{exact:true})).toHaveValue("random");
      }
      await expect(zones.getByLabel("Include Move destination refs",{exact:true})).toHaveValues([JSON.stringify([sceneId,"tiles",cloneTile])]);
    }
    const seq=await hostCall<number>(page,"seq");await zones.locator("[data-zone-run]").click();await expect.poll(()=>hostCall<number>(page,"seq")).toBe(seq+1);
    if(tagDestination) await expect.poll(async()=>{
      const after=await positions();
      // Only the rotated clone moves; source and sibling keep their drawn centers.
      return after.length===3&&after.every((view,index)=>{
        const before=beforePositions[index];if(!before)return false;
        if(randomDestination&&view.angle===90)return Math.abs(view.x-before.x-100)<=80+1e-6&&Math.abs(view.y-before.y)<=80+1e-6;
        return view.y===before.y&&view.x===before.x+(view.angle===90?100:0);
      });
    }).toBe(true);
    await expect.poll(angles).toEqual([0,0,90]);
    await page.getByRole("button",{name:/Undo \(Ctrl\+Z\)/}).click();await expect.poll(angles).toEqual([0,0,0]);
    if(tagDestination)await expect.poll(positions).toEqual(beforePositions);
    await page.locator("[data-macro-prefabs-tab]").click();
  }
  const beforeDespawn=await hostCall<number>(page,"seq");
  await panel.locator("[data-prefab-instances] summary").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await panel.locator("[data-prefab-instances] button").first().click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeDespawn + 1);
  await expect(panel.locator("[data-prefab-instances] summary")).toContainText("1");
});
