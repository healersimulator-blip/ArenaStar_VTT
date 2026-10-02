import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

test.describe("reviewed script macros in the production single-file build", () => {
  test("reviewed code lists and atomically stops two named persistent FX, then undo restores both", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-fx-tab]").click();
    const wizard = page.locator("[data-fx-wizard]");
    await wizard.locator("[data-fx-name]").fill("Ward Loop");
    await wizard.getByRole("button", { name: "Text", exact: true }).click();
    await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("Spellward");
    await wizard.locator("[data-fx-persistent]").check();
    await wizard.locator("[data-fx-save]").click();
    await expect(wizard.locator("li")).toContainText(["Ward Loop"]);
    await wizard.locator("[data-fx-run]").click();
    await wizard.locator("[data-fx-run]").click();
    await page.locator("[data-macro-fx-manager-tab]").click();
    const manager = page.locator("[data-fx-manager]");
    await expect(manager.locator("[data-fx-instance]")).toHaveCount(2);
    const active = () => page.evaluate(() => (
      globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
    ).__stage?.getFxLayer().count ?? 0);
    await expect.poll(active).toBe(2);

    await page.locator("[data-macro-script-tab]").click();
    const scripts = page.locator("[data-script-wizard]");
    await scripts.locator("[data-script-name]").fill("End named wards");
    await scripts.locator("[data-script-source]").fill(
      "const owned = await api.fx.list({ name: 'ward*' }); const done = await api.fx.stopMatching({ name: 'Ward Loop' }); return { before: owned.length, stopped: done.stopped };",
    );
    await scripts.locator(".grants label").filter({ hasText: "fx" }).locator("input").check();
    await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
    await scripts.locator("[data-script-save]").click();
    await expect(scripts.getByRole("status")).toContainText("Script revision published");
    const before = await hostCall<number>(page, "seq");
    await scripts.locator("[data-script-run]").click();
    await expect(scripts.getByRole("status")).toContainText("Script completed");
    await expect(scripts.locator("details pre")).toContainText('"before": 2');
    await expect(scripts.locator("details pre")).toContainText('"stopped": 2');
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 2); // marker + one stop envelope
    await page.locator("[data-macro-fx-manager-tab]").click();
    await expect(manager.locator("[data-fx-instance]")).toHaveCount(0);
    await expect.poll(active).toBe(0);
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect(manager.locator("[data-fx-instance]")).toHaveCount(2);
    await expect.poll(active).toBe(2);
  });

  test("reviewed Sequencer chain overlaps host-approved FX, awaits its cue window, then runs code", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-fx-tab]").click();
    const fx = page.locator("[data-fx-wizard]");
    await fx.locator("[data-fx-name]").fill("Chain pulse");
    await fx.getByRole("button", { name: "Text", exact: true }).click();
    await fx.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("Parallel cue");
    await fx.locator("[data-fx-section]").getByLabel("Duration ms").fill("900");
    await fx.locator("[data-fx-save]").click();
    const saved = fx.locator("[data-fx-macro-id]").filter({ hasText: "Chain pulse" });
    await expect(saved).toHaveCount(1);
    const macroId = await saved.getAttribute("data-fx-macro-id");
    if (!macroId) throw new Error("Saved FX ID missing");
    await page.locator("[data-macro-script-tab]").click();
    const scripts = page.locator("[data-script-wizard]");
    await scripts.locator("[data-script-name]").fill("Await three pulses");
    await scripts.locator("[data-script-source]").fill(`const id = ${JSON.stringify(macroId)};
return await api.fx.sequence()
  .parallel(api => api.fx.play(id), api => api.fx.play(id))
  .playAndWait(id)
  .thenDo(api => api.chat.say('Cues finished', 'gm'))
  .run();`);
    await scripts.locator(".grants label").filter({ hasText: "fx" }).locator("input").check();
    await scripts.locator(".grants label").filter({ hasText: "chat" }).locator("input").check();
    await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
    await scripts.locator("[data-script-save]").click();
    await expect(scripts.getByRole("status")).toContainText("Script revision published");
    await scripts.locator("[data-script-run]").click();
    const active = () => page.evaluate(() => (
      globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
    ).__stage?.getFxLayer().count ?? 0);
    await expect.poll(active, { timeout: 5_000, intervals: [50, 100] }).toBeGreaterThanOrEqual(2);
    await expect(scripts.getByRole("status")).toContainText("Script completed");
    await expect(scripts.locator("details pre")).toContainText('"kind": "parallel"');
    await expect(scripts.locator("details pre")).toContainText('"kind": "callback"');
    await expect(page.locator("#chat-log")).toContainText("Cues finished");
    await expect.poll(active, { timeout: 5_000 }).toBe(0);
  });

  test("Sequencer section replays render as separate host-clock cues and reviewed code awaits the last play", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-fx-tab]").click();
    const fx = page.locator("[data-fx-wizard]");
    await fx.locator("[data-fx-name]").fill("Triple pulse");
    await fx.getByRole("button", { name: "Text", exact: true }).click();
    const section = fx.locator("[data-fx-section]");
    await section.getByLabel("Text", { exact: true }).fill("Tick");
    await section.getByLabel("Duration ms").fill("220");
    await section.getByLabel("Section play count").fill("3");
    await expect(section.getByLabel("Pause between plays ms")).toBeVisible();
    await section.getByLabel("Pause between plays ms").fill("350");
    await section.getByLabel("Pause between plays ms").press("Tab");
    await fx.locator("[data-fx-save]").click();
    await expect(fx.getByRole("alert")).toHaveCount(0);
    const saved = fx.locator("[data-fx-macro-id]").filter({ hasText: "Triple pulse" });
    const macroId = await saved.getAttribute("data-fx-macro-id");
    if (!macroId) throw new Error("Repeated sequence ID missing");
    await fx.getByRole("button", { name: "New", exact: true }).click();
    await saved.getByRole("button", { name: "Edit" }).click();
    await expect(section.getByLabel("Section play count")).toHaveValue("3");
    await expect(section.getByLabel("Pause between plays ms")).toHaveValue("350");
    await page.evaluate(() => {
      const stage = (globalThis as unknown as { __stage?: { getFxLayer: () => {
        count: number; spawn: (...args: unknown[]) => void;
      } } }).__stage;
      if (!stage) throw new Error("FX stage missing");
      const layer = stage.getFxLayer();
      const spawn = layer.spawn.bind(layer);
      const global = globalThis as unknown as { __replaySpawns?: Array<{ id: string; time: number; active: number }> };
      global.__replaySpawns = [];
      layer.spawn = (...args: unknown[]) => {
        spawn(...args); // observe the real Pixi layer, not just a received network cue
        global.__replaySpawns?.push({ id: (args[1] as { id: string }).id,
          time: performance.now(), active: layer.count });
      };
    });
    await page.locator("[data-macro-script-tab]").click();
    const scripts = page.locator("[data-script-wizard]");
    await scripts.locator("[data-script-name]").fill("Await pulse echoes");
    await scripts.locator("[data-script-source]").fill(`const result = await api.fx.sequence()
  .playAndWait(${JSON.stringify(macroId)})
  .thenDo(api => api.chat.say('Repeated pulses completed', 'gm'))
  .run(); return result;`);
    await scripts.locator(".grants label").filter({ hasText: "fx" }).locator("input").check();
    await scripts.locator(".grants label").filter({ hasText: "chat" }).locator("input").check();
    await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
    await scripts.locator("[data-script-save]").click();
    await expect(scripts.getByRole("status")).toContainText("Script revision published");
    await scripts.locator("[data-script-run]").click();
    const spawns = () => page.evaluate(() => (
      (globalThis as unknown as { __replaySpawns?: Array<{ id: string; time: number; active: number }> }).__replaySpawns ?? []
    ));
    await expect.poll(async () => (await spawns()).length, { timeout: 5_000, intervals: [50, 100] }).toBe(3);
    const played = await spawns();
    const [first, second, third] = played;
    if (!first || !second || !third) throw new Error("Three Pixi playback events not observed");
    expect(first.id).toMatch(/^fx-[\w-]+$/);
    expect(played.map((entry) => entry.id)).toEqual([first.id, `${first.id}@2`, `${first.id}@3`]);
    expect(played.every((entry) => entry.active === 1)).toBe(true);
    expect(second.time - first.time).toBeGreaterThan(400);
    expect(third.time - second.time).toBeGreaterThan(400);
    await expect(scripts.getByRole("status")).toContainText("Script completed");
    expect(await page.evaluate(() => performance.now()) - third.time).toBeGreaterThan(160);
    await expect(page.locator("#chat-log")).toContainText("Repeated pulses completed");
    await expect.poll(() => page.evaluate(() => (
      globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
    ).__stage?.getFxLayer().count ?? 0)).toBe(0);
  });

  test("a real reviewed Worker reads and edits a tagged non-active scene through explicit Tagger refs", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const first = await hostCall<string>(page, "activeSceneId");
    await page.locator("#scene-add").click();
    await page.locator("#scene-new-blank").click();
    const secondScene = page.locator('[data-testid="scene-nav"] [data-scene]').last();
    await expect(secondScene).toContainText("Scene 2");
    const second = await secondScene.getAttribute("data-scene");
    if (!second) throw new Error("Remote scene missing ID");
    await secondScene.click();
    await expect.poll(() => hostCall<string>(page, "activeSceneId")).toBe(second);
    await page.locator("#add-token").click();
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    const tags = page.locator("[data-tagger]");
    await tags.getByLabel("Tag scene").selectOption(second);
    await tags.getByLabel("Taggable object type").selectOption("tokens");
    const token = tags.locator(".result").filter({ hasText: "Token 1" });
    await expect(token).toHaveCount(1);
    await token.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("remote-ward");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(token).toContainText("remote-ward");
    await page.locator("[data-macro-script-tab]").click();
    const wizard = page.locator("[data-script-wizard]");
    await wizard.locator("[data-script-name]").fill("Look in another scene");
    await wizard.locator("[data-script-scene]").selectOption(first);
    await wizard.locator("[data-script-source]").fill(`const remote = ${JSON.stringify(second)};
const rows = await api.tags.getByTag('remote-ward', { sceneId: remote, collections: ['tokens'] });
const groups = await api.tags.getByTag('remote-ward', { allScenes: true, groupByScene: true });
const tags = await api.tags.getTags(rows[0].ref);
const has = await api.tags.hasTags(rows[0].ref, 'remote-ward');
const change = await api.tags.addTags([rows[0].ref], ['remote-script']);
const after = await api.tags.getTags(rows[0].ref);
return { scenes: Object.keys(groups), rows: rows.length, scene: rows[0].sceneId, tags, has,
  changed: change.changed, after };`);
    await wizard.locator(".grants label").filter({ hasText: "tags.write" }).locator("input").check();
    await wizard.getByLabel("I reviewed this exact revision and its host grants").check();
    await wizard.locator("[data-script-save]").click();
    await expect(wizard.getByRole("status")).toContainText("Script revision published");
    await wizard.locator("[data-script-run]").click();
    await expect(wizard.getByRole("status")).toContainText("Script completed");
    const result = wizard.locator("details pre");
    await expect(result).toContainText(`"scene": "${second}"`);
    await expect(result).toContainText(`"scenes": [\n    "${second}"`);
    await expect(result).toContainText('"rows": 1');
    await expect(result).toContainText('"remote-ward"');
    await expect(result).toContainText('"has": true');
    await expect(result).toContainText('"changed": 1');
    await expect(result).toContainText('"remote-script"');
    await expect(wizard.locator("details")).toContainText("tags.get");
    await expect(wizard.locator("details")).toContainText("tags.find");
    await expect(wizard.locator("details")).toContainText("tags.edit");
    await page.locator("[data-macro-tags-tab]").click();
    await expect(token).toContainText("remote-script");
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect(token).not.toContainText("remote-script");
    await expect(token).toContainText("remote-ward");
  });

  test("GM Tags explorer applies live rules across scenes, undoes and persists the next allocation", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const first = await hostCall<string>(page, "activeSceneId");
    await page.locator("#add-token").click();
    await page.locator("#scene-add").click();
    await page.locator("#scene-new-blank").click();
    const secondScene = page.locator('[data-testid="scene-nav"] [data-scene]').last();
    const second = await secondScene.getAttribute("data-scene");
    if (!second) throw new Error("Remote scene missing ID");
    await secondScene.click();
    await expect.poll(() => hostCall<string>(page, "activeSceneId")).toBe(second);
    await page.locator("#add-token").click();
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    let tags = page.locator("[data-tagger]");
    await tags.getByLabel("Taggable object type").selectOption("tokens");
    let local = tags.locator(`.result[data-tag-scope="scene"][data-scene-id="${first}"][data-tag-collection="tokens"]`);
    let remote = tags.locator(`.result[data-tag-scope="scene"][data-scene-id="${second}"][data-tag-collection="tokens"]`);
    await expect(local).toHaveCount(1);
    await expect(remote).toHaveCount(1);
    await local.locator('input[type="checkbox"]').check();
    await remote.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("ward-{#}, anchor-{id}");
    await tags.getByRole("button", { name: "Replace" }).click();
    await expect(local).toContainText("ward-{#}");
    await expect(remote).toContainText("ward-{#}");
    await local.locator('input[type="checkbox"]').check();
    await remote.locator('input[type="checkbox"]').check();
    const before = await hostCall<number>(page, "seq");
    await tags.locator("[data-tagger-apply-rules]").click();
    await expect(tags.getByRole("status")).toContainText("2 target(s) expanded on the host");
    await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
    await expect(local).toContainText("ward-1");
    await expect(remote).toContainText("ward-1"); // numbering is per scene, not per browser batch
    await expect(local).toContainText(/anchor-[\w-]+/);
    await expect(remote).toContainText(/anchor-[\w-]+/);
    // Undo belongs to the live GM host session, not a promise that the undo
    // stack survives a browser restart. Reapply before checking IDB recovery.
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect(local).toContainText("ward-{#}");
    await expect(remote).toContainText("ward-{#}");
    await local.locator('input[type="checkbox"]').check();
    await remote.locator('input[type="checkbox"]').check();
    await tags.locator("[data-tagger-apply-rules]").click();
    await expect(tags.getByRole("status")).toContainText("2 target(s) expanded on the host");
    await hostCall<number>(page, "drainOps"); // ensure the host IDB log has persisted before reload
    await page.reload();
    await waitForSurface(page, "app");
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    tags = page.locator("[data-tagger]");
    await tags.getByLabel("Taggable object type").selectOption("tokens");
    local = tags.locator(`.result[data-tag-scope="scene"][data-scene-id="${first}"][data-tag-collection="tokens"]`);
    remote = tags.locator(`.result[data-tag-scope="scene"][data-scene-id="${second}"][data-tag-collection="tokens"]`);
    await expect(local).toContainText("ward-1");
    await expect(remote).toContainText("ward-1");
  });

  test("reviewed Worker applies Tagger rules on a live token and undo restores its templates", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#add-token").click();
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    const tags = page.locator("[data-tagger]");
    await tags.getByLabel("Taggable object type").selectOption("tokens");
    const token = tags.locator(".result").filter({ hasText: "Token 1" });
    await expect(token).toHaveCount(1);
    await token.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("ward-{#}, anchored-{id}");
    await tags.getByRole("button", { name: "Replace" }).click();
    await expect(token).toContainText("ward-{#}");
    await page.locator("[data-macro-script-tab]").click();
    const wizard = page.locator("[data-script-wizard]");
    await wizard.locator("[data-script-name]").fill("Number ward tags");
    await wizard.locator("[data-script-source]").fill(`const rows = await api.tags.getByTag('ward-{#}', { collections: ['tokens'] });
const applied = await api.tags.applyTagRules(rows.map(row => row.ref));
const after = await api.tags.getTags(rows[0].ref);
return { changed: applied.changed, after };`);
    await wizard.locator(".grants label").filter({ hasText: "tags.write" }).locator("input").check();
    await wizard.getByLabel("I reviewed this exact revision and its host grants").check();
    await wizard.locator("[data-script-save]").click();
    await expect(wizard.getByRole("status")).toContainText("Script revision published");
    await wizard.locator("[data-script-run]").click();
    await expect(wizard.getByRole("status")).toContainText("Script completed");
    await expect(wizard.locator("details pre")).toContainText('"changed": 1');
    await expect(wizard.locator("details pre")).toContainText("ward-1");
    await expect(wizard.locator("details pre")).toContainText(/anchored-[\w-]+/);
    await expect(wizard.locator("details")).toContainText("tags.rules");
    await page.locator("[data-macro-tags-tab]").click();
    await expect(token).toContainText("ward-1");
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect(token).toContainText("ward-{#}");
    await expect(token).toContainText("anchored-{id}");
  });

  test("GM reviews a script, blob Worker passes CSP and host RPCs execute in sequence", async ({ page }) => {
    // This exercises the shipped file:// CSP and the real classic Worker, unlike
    // the VM-backed unit harness. Nothing from the script executes during editing.
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-script-tab]").click();
    const wizard = page.locator("[data-script-wizard]");
    await wizard.locator("[data-script-name]").fill("Worker CSP check");
    await wizard.locator("[data-script-source]").fill(
      "const ref = { coll: 'scenes', id: context.sceneId }; const tags = await api.tags.getTags(ref); const has = await api.tags.hasTags(ref, 'unmatched'); const hits = await api.tags.getByTag('unmatched'); await api.chat.say('Worker RPC succeeded', 'gm'); return { count: hits.length, tagCount: tags.length, has };",
    );
    await wizard.locator(".grants label").filter({ hasText: "chat" }).locator("input").check();
    await wizard.getByLabel("I reviewed this exact revision and its host grants").check();
    await wizard.locator("[data-script-save]").click();
    await expect(wizard.getByRole("status")).toContainText("Script revision published");
    await wizard.locator("[data-script-run]").click();
    await expect(wizard.getByRole("status")).toContainText("Script completed");
    await expect(wizard.locator("details")).toContainText("tags.find");
    await expect(wizard.locator("details")).toContainText("tags.get");
    await expect(wizard.locator("details")).toContainText("chat.say");
    await expect(wizard.locator("details pre")).toContainText('"count": 0');
    await expect(wizard.locator("details pre")).toContainText('"tagCount": 0');
    await expect(wizard.locator("details pre")).toContainText('"has": false');
    await expect(page.locator("#chat-log")).toContainText("Worker RPC succeeded");
  });

  test("global Tagger discovers world actors/items and the reviewed API reads/edits them", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    await page.locator('[data-tab="actors"]').click();
    const sheet = page.locator("#sheets");
    await sheet.locator("#new-doc").click();
    const actorEditor = sheet.locator('[data-document-tags="actor"]');
    await expect(actorEditor).toBeVisible();
    await actorEditor.getByLabel("New actor tag").fill("world-party");
    await actorEditor.getByRole("button", { name: "Add tag", exact: true }).click();
    await actorEditor.locator("[data-tag-save]").click();
    await expect(actorEditor.getByRole("status")).toHaveText("Tags saved.");
    const prototypeEditor = sheet.locator('[data-document-tags="prototypeToken"]');
    await expect(prototypeEditor).toBeVisible();
    await prototypeEditor.getByLabel("New prototype token tag").fill("world-prototype");
    await prototypeEditor.getByRole("button", { name: "Add tag", exact: true }).click();
    await prototypeEditor.locator("[data-tag-save]").click();
    await expect(prototypeEditor.getByRole("status")).toHaveText("Tags saved.");

    await sheet.locator(".tabs").getByRole("button", { name: "Items", exact: true }).click();
    await sheet.locator("#new-doc").click();
    const itemEditor = sheet.locator('[data-document-tags="item"]');
    await expect(itemEditor).toBeVisible();
    await itemEditor.getByLabel("New item tag").fill("world-map");
    await itemEditor.getByRole("button", { name: "Add tag", exact: true }).click();
    await itemEditor.locator("[data-tag-save]").click();
    await expect(itemEditor.getByRole("status")).toHaveText("Tags saved.");

    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    const tags = page.locator("[data-tagger]");
    const kind = tags.getByLabel("Taggable object type");
    const search = tags.locator("[data-tag-search]");
    await kind.selectOption("actors");
    await search.fill("world-party");
    const actor = tags.locator('.result[data-tag-scope="world"][data-tag-collection="actors"]')
      .filter({ hasText: "world-party" });
    await expect(actor).toHaveCount(1);
    await expect(actor).toContainText("World · actors");
    await expect(tags.locator("[data-tagger-apply-rules]")).toBeDisabled();
    await actor.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("bulk-party");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(tags.getByRole("status")).toContainText("1 object(s) added on host at seq");
    await expect(actor).toContainText("bulk-party");

    await kind.selectOption("prototypeTokens");
    await search.fill("world-prototype");
    const prototype = tags.locator('.result[data-tag-scope="world"][data-tag-collection="prototypeTokens"]')
      .filter({ hasText: "world-prototype" });
    await expect(prototype).toHaveCount(1);
    await expect(prototype).toContainText("prototype token");
    await prototype.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("bulk-prototype");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(tags.getByRole("status")).toContainText("1 object(s) added on host at seq");
    await expect(prototype).toContainText("bulk-prototype");
    const prototypeActorId = await prototype.getAttribute("data-document-id");
    expect(prototypeActorId).toBeTruthy();
    await prototype.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("spawn-{#}, owner-{id}");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(tags.getByRole("status")).toContainText("1 object(s) added on host at seq");
    await prototype.locator('input[type="checkbox"]').check();
    await expect(tags.locator("[data-tagger-apply-rules]")).toBeEnabled();
    await tags.locator("[data-tagger-apply-rules]").click();
    await expect(tags.getByRole("status")).toContainText("1 target(s) expanded on the host at seq");
    await expect(prototype).toContainText("spawn-1");
    await expect(prototype).toContainText(`owner-${prototypeActorId}`);

    await kind.selectOption("items");
    await search.fill("world-map");
    const item = tags.locator('.result[data-tag-scope="world"][data-tag-collection="items"]')
      .filter({ hasText: "world-map" });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("World · items");
    await item.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("bulk-map");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(tags.getByRole("status")).toContainText("1 object(s) added on host at seq");
    await expect(item).toContainText("bulk-map");

    await kind.selectOption("");
    await search.fill("world-");
    const suggestions = tags.getByRole("listbox", { name: "Tag suggestions" });
    await expect(suggestions.getByRole("option", { name: "world-party" })).toBeVisible();
    await expect(suggestions.getByRole("option", { name: "world-prototype" })).toBeVisible();
    await expect(suggestions.getByRole("option", { name: "world-map" })).toBeVisible();

    await page.locator("[data-macro-script-tab]").click();
    const scripts = page.locator("[data-script-wizard]");
    await scripts.locator("[data-script-name]").fill("Read and edit world Tagger refs");
    await scripts.locator("[data-script-source]").fill(`const actors = await api.tags.find('world-party', {
  allScenes: true, includeWorldDocs: true, collections: ['actors']
});
const items = await api.tags.getByTag('world-map', {
  allScenes: true, includeWorldDocs: true, collections: ['items']
});
const prototypes = await api.tags.getByTag('bulk-prototype', {
  allScenes: true, includeWorldDocs: true, collections: ['prototypeTokens']
});
const actorRef = actors[0]?.ref, itemRef = items[0]?.ref, prototypeRef = prototypes[0]?.ref;
if (!actorRef || !itemRef || !prototypeRef) throw new Error('Global targets missing');
const before = await api.tags.getTags(actorRef);
const hasMap = await api.tags.hasTags(itemRef, 'bulk-map');
const hasPrototype = await api.tags.hasTags(prototypeRef, 'bulk-prototype');
await api.tags.addTags([actorRef, itemRef, prototypeRef], ['script-world']);
return { scope: actors[0].scope, before, hasMap, hasPrototype,
  actorTags: await api.tags.getTags(actorRef), itemTags: await api.tags.getTags(itemRef),
  prototypeTags: await api.tags.getTags(prototypeRef) };`);
    await scripts.locator(".grants label").filter({ hasText: "tags.read" }).locator("input").check();
    await scripts.locator(".grants label").filter({ hasText: "tags.write" }).locator("input").check();
    await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
    await scripts.locator("[data-script-save]").click();
    await expect(scripts.getByRole("status")).toContainText("Script revision published");
    await scripts.locator("[data-script-run]").click();
    await expect(scripts.getByRole("status")).toContainText("Script completed");
    await expect(scripts.locator("details pre")).toContainText('"scope": "world"');
    await expect(scripts.locator("details pre")).toContainText('"hasMap": true');
    await expect(scripts.locator("details pre")).toContainText('"hasPrototype": true');
    await expect(scripts.locator("details pre")).toContainText("script-world");
    await expect(scripts.locator("details pre")).toContainText("prototypeTags");
  });

  test("Tag search autocomplete completes the final comma term from visible tags", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#add-token").click();
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-tags-tab]").click();
    const tags = page.locator("[data-tagger]");
    await tags.getByLabel("Taggable object type").selectOption("tokens");
    const token = tags.locator(".result").filter({ hasText: "Token 1" });
    await expect(token).toHaveCount(1);
    await token.locator('input[type="checkbox"]').check();
    await tags.getByLabel("Tags to edit").fill("trap-door, trap-light, boss fight");
    await tags.getByRole("button", { name: "Add", exact: true }).click();
    await expect(token).toContainText("trap-light");
    await expect(token).toContainText("boss fight");

    const sidebarQuery = tags.locator("[data-tagger-sidebar-query]");
    await sidebarQuery.fill("Token 1");
    await expect(token).toHaveCount(1);
    await sidebarQuery.fill('Token 1 tag:"BOSS FIGHT"');
    await expect(token).toHaveCount(1);
    await sidebarQuery.fill('Token 1 tag:"BOSS FIGHT" tag:TRAP-*');
    await expect(token).toHaveCount(1);
    await expect(tags.locator('[data-tag-search-mode="lenient"]'))
      .toContainText("case-insensitive substring");
    await sidebarQuery.fill('Token 1 tag:"boss fight" tag:missing');
    await expect(token).toHaveCount(0);
    await sidebarQuery.fill("");

    const search = tags.locator("[data-tag-search]");
    await search.fill("BOSS FIGHT");
    await expect(token).toHaveCount(0); // The API remains case-sensitive and exact by default.
    await search.fill("boss fight");
    await expect(token).toHaveCount(1);
    await search.fill("trap-");
    const listbox = tags.getByRole("listbox", { name: "Tag suggestions" });
    await expect(listbox.getByRole("option")).toHaveText(["trap-door", "trap-light"]);
    await listbox.getByRole("option", { name: "trap-door" }).click();
    await expect(search).toHaveValue("trap-door");

    await search.fill("trap-door, trap-l");
    await expect(listbox.getByRole("option")).toHaveText(["trap-light"]);
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(search).toHaveValue("trap-door, trap-light");
    await expect(tags.locator(".result").filter({ hasText: "Token 1" })).toHaveCount(1);
  });
});
