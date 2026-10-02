import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

test("an authored active-zone graph branches on a reviewed script result and opted-in failure", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");

  await page.locator("#add-token").click();
  await expect.poll(async () => (await hostCall<{
    tokens: Array<{ id: string; name: string }>;
  }>(page, "sceneChildren")).tokens.length).toBeGreaterThan(0);
  const sceneId = await hostCall<string>(page, "activeSceneId");
  const scene = await hostCall<{ tokens: Array<{ id: string; name: string }> }>(page, "sceneChildren");
  const origin = scene.tokens[0];
  if (!origin) throw new Error("The authored branch needs an origin token");

  const scriptName = "A26 result branch probe";
  const graphName = "A26 reviewed result branch";
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const scripts = page.locator("[data-script-wizard]");
  await scripts.locator("[data-script-name]").fill(scriptName);
  await scripts.locator("[data-script-source]").fill("return { hit: true };");
  await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
  await scripts.locator("[data-script-save]").click();
  await expect(scripts.getByRole("status")).toContainText("Script revision published");

  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("A26 branch source");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "A26 branch source" })).toHaveCount(1);

  await zones.locator("[data-zone-name]").fill(graphName);
  await zones.getByLabel("Origin token").selectOption(origin.id);
  await zones.locator(".methods label").filter({ hasText: /^click$/ }).locator("input").check();
  await zones.getByRole("button", { name: "Remove step 2" }).click(); // keep the triggering-token collection
  await zones.locator('[data-zone-add="script"]').click();

  const scriptStep = zones.locator("[data-zone-step]").nth(1);
  const scriptStepId = await scriptStep.getAttribute("data-zone-step");
  if (!scriptStepId) throw new Error("The reviewed script step has no stable graph ID");
  await scriptStep.getByLabel("Reviewed script").selectOption({ label: `${scriptName} (GM only)` });
  await scriptStep.locator('input[aria-label^="Expose script result "]').check();
  await scriptStep.getByLabel(/^On failure /).selectOption("continue");

  await zones.locator('[data-zone-add="checkScriptResult"]').click();
  const resultCheck = zones.locator("[data-zone-step]").nth(2);
  await resultCheck.getByLabel("Check Script Result source").selectOption(scriptStepId);
  await resultCheck.getByLabel("Check Script Result path").fill("value.hit");
  await resultCheck.getByLabel("Check Script Result comparison").selectOption("eq");
  await resultCheck.getByLabel("Check Script Result value", { exact: true }).selectOption("true");
  await resultCheck.getByLabel("Check Script Result failure landing").fill("script-error");

  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Tags").fill("a26-script-success");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("A26 result branch: script succeeded");
  await zones.locator('[data-zone-add="stop"]').click();
  await zones.locator('[data-zone-add="landing"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Landing name").fill("script-error");
  await zones.locator('[data-zone-add="tags"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Tags").fill("a26-script-error");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("A26 result branch: ordinary failure captured");
  await zones.locator('[data-zone-add="stop"]').click();

  await zones.getByLabel("Simulate method").selectOption("click");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  await expect(zones.locator("li").filter({ hasText: graphName })).toHaveCount(1);

  // Reopen the saved graph after a real reload: the branch and result-capture flag
  // must come from the persisted, host-approved definition, not transient editor state.
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const savedZones = page.locator("[data-active-zones]");
  await savedZones.locator("li").filter({ hasText: graphName }).getByRole("button", { name: "Edit" }).click();
  const savedScriptStep = savedZones.locator("[data-zone-step]").nth(1);
  await expect(savedScriptStep.locator('input[aria-label^="Expose script result "]')).toBeChecked();
  await expect(savedZones.getByLabel("Check Script Result path")).toHaveValue("value.hit");
  await expect(savedScriptStep.getByLabel(/^On failure /)).toHaveValue("continue");
  await savedZones.getByLabel("Origin token").selectOption(origin.id);
  await savedZones.getByLabel("Simulate method").selectOption("click");

  const beforeSuccess = await hostCall<number>(page, "seq");
  await savedZones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(beforeSuccess);
  await expect(page.locator("#chat-log")).toContainText("A26 result branch: script succeeded");
  const successTrace = savedZones.locator("details").filter({ hasText: "Host trace:" });
  await expect(successTrace).toContainText("value.hit: true eq true -> pass");

  await page.locator("[data-macro-tags-tab]").click();
  const tags = page.locator("[data-tagger]");
  await tags.getByLabel("Tag scene").selectOption(sceneId);
  await tags.getByLabel("Taggable object type").selectOption("tokens");
  const tokenRow = tags.locator(`.result[data-document-id="${origin.id}"]`);
  await expect(tokenRow).toContainText("a26-script-success");

  // Publish a new, separately reviewed revision that fails ordinarily. The saved
  // graph explicitly opts into continuing, and its false/missing JSON path must
  // land on the GM-authored error branch rather than silently stopping.
  await page.locator("[data-macro-script-tab]").click();
  const revisedScripts = page.locator("[data-script-wizard]");
  await revisedScripts.locator("[data-script-pick]").filter({ hasText: scriptName }).click();
  await revisedScripts.locator("[data-script-source]").fill("throw new Error('intentional A26 branch failure');");
  await revisedScripts.getByLabel("I reviewed this exact revision and its host grants").check();
  await revisedScripts.locator("[data-script-save]").click();
  await expect(revisedScripts.getByRole("status")).toContainText("Script revision published");

  await page.locator("[data-macro-zones-tab]").click();
  const resumedZones = page.locator("[data-active-zones]");
  await resumedZones.locator("li").filter({ hasText: graphName }).getByRole("button", { name: "Edit" }).click();
  await resumedZones.getByLabel("Origin token").selectOption(origin.id);
  await resumedZones.getByLabel("Simulate method").selectOption("click");
  const beforeFailure = await hostCall<number>(page, "seq");
  await resumedZones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(beforeFailure);
  await expect(page.locator("#chat-log")).toContainText("A26 result branch: ordinary failure captured");
  const failureTrace = resumedZones.locator("details").filter({ hasText: "Host trace:" });
  await expect(failureTrace).toContainText("continuing with remaining authorized actions");
  await expect(failureTrace).toContainText("Check Script Result");
  await expect(failureTrace).toContainText("value.hit: missing eq true -> fail");

  await page.locator("[data-macro-tags-tab]").click();
  const finalTags = page.locator("[data-tagger]");
  await finalTags.getByLabel("Tag scene").selectOption(sceneId);
  await finalTags.getByLabel("Taggable object type").selectOption("tokens");
  const finalTokenRow = finalTags.locator(`.result[data-document-id="${origin.id}"]`);
  await expect(finalTokenRow).toContainText("a26-script-success");
  await expect(finalTokenRow).toContainText("a26-script-error");
});
