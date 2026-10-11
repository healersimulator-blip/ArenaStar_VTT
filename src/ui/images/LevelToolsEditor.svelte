<script lang="ts">
  /**
   * G-31 (D-439): merge, reorder and rescale floors; G-29 (D-441): import another scene as a floor.
   * Each tool is one undoable change applied at once from the live scene (never through the
   * draft), with a preview of what it will do.
   */
  import type { SceneDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import { defaultMergeTarget, mergeLevelPlan, moveLevelPlan, rescaleLevelsPlan, stackOrder, type LevelPlan } from "../../core/levelRestack";
  import { importFloorPlan, type ImportFloorInput } from "../../core/levelImport";
  let { scene, client, draftDirty }: { scene: SceneDocument; client: ClientSync; draftDirty: boolean } = $props();
  let busy = $state(false), message = $state("");
  let mergeFrom = $state(""), mergeInto = $state(""), moveId = $state("");
  let factor = $state(1), withGrid = $state(false), open = $state(false);
  const gm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  /** Top floor first, the way a building is read. */
  const stack = $derived(stackOrder(scene.levels ?? []).reverse());
  $effect(() => {
    const ids = stack.map((l) => l._id);
    if (!ids.includes(mergeFrom)) mergeFrom = ids[0] ?? "";
    if (!ids.includes(mergeInto) || mergeInto === mergeFrom) mergeInto = defaultMergeTarget(scene.levels ?? [], mergeFrom) ?? "";
    if (!ids.includes(moveId)) moveId = ids[0] ?? "";
  });
  // Previews only while the panel is open, from a plain copy (plans clone documents), without the
  // staged check; submitting recomputes from the live store and validates.
  const plain = $derived(open ? $state.snapshot(scene) as SceneDocument : null);
  const preview = { validate: false };
  const mergePlan = $derived(plain && mergeFrom && mergeInto ? mergeLevelPlan(plain, mergeFrom, mergeInto, preview) : null);
  const upPlan = $derived(plain && moveId ? moveLevelPlan(plain, moveId, "up", preview) : null);
  const downPlan = $derived(plain && moveId ? moveLevelPlan(plain, moveId, "down", preview) : null);
  const rescalePlan = $derived(plain ? rescaleLevelsPlan(plain, Number(factor), { gridDistance: withGrid, ...preview }) : null);
  // G-29: import another scene's map, tiles, walls and lights as a floor.
  let importFrom = $state(""), importLevel = $state(""), importInto = $state(""), importName = $state(""), importHeight = $state(10);
  let importX = $state(0), importY = $state(0), importMatch = $state(true);
  const sources = $derived(open ? (client.store.getAll("scenes") as SceneDocument[]).filter((s) => s._id !== scene._id).map((s) => ({ id: s._id, name: s.name })) : []);
  const importSource = $derived(open && importFrom ? client.store.get("scenes", importFrom) as SceneDocument | undefined : undefined);
  $effect(() => {
    if (!sources.some((s) => s.id === importFrom)) importFrom = sources[0]?.id ?? "";
    const floors = importSource?.levels ?? [];
    if (floors.length && !floors.some((l) => l._id === importLevel)) importLevel = stackOrder(floors)[0]?._id ?? "";
    if (importInto && !stack.some((l) => l._id === importInto)) importInto = "";
  });
  $effect(() => { if (importSource) importName = importSource.name.slice(0, 64); });
  $effect(() => {
    const top = stack[0];
    if (top && top.top !== null && top.bottom !== null) importHeight = Math.max(1, top.top - top.bottom);
  });
  function importInput(target: SceneDocument, source: SceneDocument, levelId: string): ImportFloorInput {
    const asset = source.img ? client.store.world.assetManifest[source.img] : undefined;
    const cell = target.grid.size > 0 ? target.grid.size : 100;
    return {
      target, source, ...(source.levels?.length ? { sourceLevelId: importLevel } : {}),
      into: importInto ? { levelId: importInto } : { newLevel: { id: levelId, name: importName, height: Number(importHeight) } },
      offset: { x: Number(importX) * cell, y: Number(importY) * cell }, matchGrid: importMatch,
      backgroundSize: asset?.width && asset.height ? { width: asset.width, height: asset.height } : null,
      nextId: (kind) => `${kind}-${crypto.randomUUID().slice(0, 12)}`,
    };
  }
  const importPlan = $derived(plain && importSource ? importFloorPlan({ ...importInput(plain, importSource, "level-preview"), validate: false }) : null);
  const blocked = $derived(!gm || busy || draftDirty);
  async function run(make: (current: SceneDocument) => LevelPlan) {
    if (blocked) return;
    const stored = client.store.get("scenes", scene._id) as SceneDocument | undefined;
    if (!stored) return;
    const current = structuredClone(stored);
    const plan = make(current); // recomputed from the live scene: the preview may be a moment old
    if (plan.error) { message = plan.error; return; }
    busy = true; message = "";
    try {
      await client.submitAndWait(plan.ops);
      message = `${plan.summary.join(" ")} Undo is available.`;
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
</script>

<details class="level-tools" data-level-tools={scene._id} ontoggle={(e) => { open = e.currentTarget.open; }}>
  <summary>Merge, reorder, rescale or import floors</summary>
  <p>Each tool is applied at once as one undoable change, carrying tokens, scopes, stairs and elevation ranges with their floor.</p>
  {#if draftDirty}<p role="alert">Apply or reload the draft levels first.</p>{/if}
  {#if stack.length >= 2}
    <section data-level-merge>
      <strong>Merge</strong>
      <div class="row">
        <label>Floor<select aria-label="Merge floor" bind:value={mergeFrom} disabled={blocked}>
          {#each stack as l (l._id)}<option value={l._id}>{l.name}</option>{/each}
        </select></label>
        <label>into<select aria-label="Merge into floor" bind:value={mergeInto} disabled={blocked}>
          {#each stack.filter((l) => l._id !== mergeFrom) as l (l._id)}<option value={l._id}>{l.name}</option>{/each}
        </select></label>
      </div>
      {#if mergePlan}
        <ul class="plan" data-plan="merge">{#each mergePlan.summary as line, i (i)}<li>{line}</li>{/each}{#each mergePlan.notes as line, i (i)}<li class="note">{line}</li>{/each}</ul>
        {#if mergePlan.error}<p role="alert">{mergePlan.error}</p>{/if}
      {/if}
      <button type="button" disabled={blocked || !mergePlan || !!mergePlan.error} onclick={() => run((s) => mergeLevelPlan(s, mergeFrom, mergeInto))}>Merge floors</button>
    </section>
    <section data-level-move>
      <strong>Reorder</strong>
      <div class="row">
        <label>Floor<select aria-label="Floor to move" bind:value={moveId} disabled={blocked}>
          {#each stack as l (l._id)}<option value={l._id}>{l.name}</option>{/each}
        </select></label>
      </div>
      <div class="buttons">
        <button type="button" title={upPlan?.error ?? upPlan?.summary[0] ?? ""} disabled={blocked || !upPlan || !!upPlan.error} onclick={() => run((s) => moveLevelPlan(s, moveId, "up"))}>Move up</button>
        <button type="button" title={downPlan?.error ?? downPlan?.summary[0] ?? ""} disabled={blocked || !downPlan || !!downPlan.error} onclick={() => run((s) => moveLevelPlan(s, moveId, "down"))}>Move down</button>
      </div>
      <small>Swaps the floor with its neighbour; each keeps its height, contents and fog.</small>
    </section>
  {/if}
  <section data-level-rescale>
    <strong>Rescale</strong>
    <label>Multiply every elevation by<input aria-label="Elevation scale factor" type="number" min="0.001" max="1000" step="any" bind:value={factor} disabled={blocked} /></label>
    <label class="check"><input type="checkbox" aria-label="Also scale the grid distance" bind:checked={withGrid} disabled={blocked} />Also set the grid distance ({scene.grid.distance} → {Math.round(scene.grid.distance * (Number(factor) || 0) * 1e6) / 1e6} {scene.grid.units || "units"})</label>
    {#if rescalePlan && (Number(factor) !== 1 || withGrid)}
      <ul class="plan" data-plan="rescale">{#each rescalePlan.summary as line, i (i)}<li>{line}</li>{/each}{#each rescalePlan.notes as line, i (i)}<li class="note">{line}</li>{/each}</ul>
      {#if rescalePlan.error}<p role="alert">{rescalePlan.error}</p>{/if}
    {/if}
    <button type="button" disabled={blocked || !rescalePlan || !!rescalePlan.error} onclick={() => run((s) => rescaleLevelsPlan(s, Number(factor), { gridDistance: withGrid }))}>Rescale elevations</button>
    <small>For example 0.3 when a 5 ft grid becomes 1.5 m.</small>
  </section>
  <section data-level-import>
    <strong>Import a scene as a floor</strong>
    {#if sources.length === 0}
      <small>There is no other scene to import.</small>
    {:else}
      <div class="row">
        <label>Scene<select aria-label="Import source scene" bind:value={importFrom} disabled={blocked}>
          {#each sources as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
        </select></label>
        {#if importSource?.levels?.length}
          <label>Its floor<select aria-label="Import source floor" bind:value={importLevel} disabled={blocked}>
            {#each stackOrder(importSource.levels).reverse() as l (l._id)}<option value={l._id}>{l.name}</option>{/each}
          </select></label>
        {/if}
      </div>
      <div class="row">
        <label>Into<select aria-label="Import into floor" bind:value={importInto} disabled={blocked}>
          <option value="">New floor</option>
          {#each stack as l (l._id)}<option value={l._id}>{l.name}</option>{/each}
        </select></label>
        {#if !importInto}
          <label>Height<input aria-label="New floor height" type="number" min="0.1" step="any" bind:value={importHeight} disabled={blocked} /></label>
        {/if}
      </div>
      {#if !importInto}
        <label>New floor name<input aria-label="New floor name" maxlength="64" bind:value={importName} disabled={blocked} /></label>
      {/if}
      <div class="row">
        <label>Offset x (cells)<input aria-label="Import offset x" type="number" step="any" bind:value={importX} disabled={blocked} /></label>
        <label>Offset y (cells)<input aria-label="Import offset y" type="number" step="any" bind:value={importY} disabled={blocked} /></label>
      </div>
      <label class="check"><input type="checkbox" aria-label="Match the source grid" bind:checked={importMatch} disabled={blocked} />Scale so grid cells match</label>
      {#if importPlan}
        <ul class="plan" data-plan="import">{#each importPlan.summary as line, i (i)}<li>{line}</li>{/each}{#each importPlan.notes as line, i (i)}<li class="note">{line}</li>{/each}</ul>
        {#if importPlan.error}<p role="alert">{importPlan.error}</p>{/if}
      {/if}
      <button type="button" disabled={blocked || !importPlan || !!importPlan.error} onclick={() => run((s) => {
        const source = client.store.get("scenes", importFrom) as SceneDocument | undefined;
        if (!source) return { ops: [], summary: [], notes: [], error: "That scene no longer exists" };
        return importFloorPlan(importInput(s, structuredClone(source), `level-${crypto.randomUUID()}`));
      })}>Import as floor</button>
      <small>Copies the map (as a floor map tile), tiles, walls and lights with new ids, stamped with the floor. Tokens and regions stay behind.</small>
    {/if}
  </section>
  {#if message}<p role="status" data-level-tools-message>{message}</p>{/if}
</details>

<style>
  .level-tools { border-top:1px solid #354052; padding:8px 0; margin-top:8px; font-size:11px; color:#d8dee8; }
  summary { cursor:pointer; font-weight:600; }
  p { line-height:1.5; margin:6px 0; color:#b2bdca; }
  section { display:flex; flex-direction:column; gap:4px; padding:6px 0; border-top:1px dashed #354052; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .buttons { display:flex; flex-wrap:wrap; }
  label { display:flex; flex-direction:column; gap:3px; min-width:0; }
  label.check { flex-direction:row; align-items:center; gap:6px; }
  /* Control text size follows the product-wide readability floor (global.css). */
  select, input { box-sizing:border-box; width:100%; min-width:0; color:#edf3fb; background:#131b25; border:1px solid #435067; border-radius:4px; padding:4px; }
  input[type="checkbox"] { width:auto; }
  .plan { margin:2px 0; padding-left:16px; color:#c9d3df; line-height:1.45; }
  .plan .note { color:#9dabbc; }
  small { color:#9dabbc; overflow-wrap:anywhere; }
  button { align-self:flex-start; padding:4px 7px; margin:2px 4px 0 0; border:1px solid #52657a; border-radius:4px; background:#253549; color:#e6eef9; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  [role=alert] { color:#f0c789; }
</style>
