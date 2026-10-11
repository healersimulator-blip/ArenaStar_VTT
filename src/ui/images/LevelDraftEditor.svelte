<script lang="ts">
  import LevelPlayEditor from "./LevelPlayEditor.svelte";
  import { LEVEL_PLAY_FEATURE } from "../../core/levelPlay";
  import LevelBindingEditor from "./LevelBindingEditor.svelte";
  import LevelToolsEditor from "./LevelToolsEditor.svelte";
  import { DRAFT_LEVELS_FEATURE, LEVEL_AMBIENT_FEATURE } from "../../core/capabilities";
  import { onMount, untrack } from "svelte";
  import type { EventBus } from "../../core/events";
  import type { ClientEvents } from "../../client/sync";
  import type { ClientSync } from "../../client/sync";
  import type { LevelDocument, SceneDocument } from "../../core/documents";
  import { draftLevel, generateLevels, levelDraftAudit, levelDraftOps, MAX_LEVELS, sceneLevelsError } from "../../core/levels";
  let { scene, client, bus }: { scene: SceneDocument; client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let compatible = $state(false), ambientCompatible = $state(false);
  onMount(() => {
    compatible = client.supportsFeature(DRAFT_LEVELS_FEATURE);
    ambientCompatible = client.supportsFeature(LEVEL_AMBIENT_FEATURE);
    const offWelcome = bus.on("welcome", () => { compatible = client.supportsFeature(DRAFT_LEVELS_FEATURE); ambientCompatible = client.supportsFeature(LEVEL_AMBIENT_FEATURE); });
    const offKick = bus.on("kick", () => { compatible = false; ambientCompatible = false; });
    return () => { offWelcome(); offKick(); };
  });
  let rows = $state<LevelDocument[]>([]);
  let baseline: LevelDocument[] = [];
  let revision = $state("");
  let dirty = $state(false), busy = $state(false), message = $state("");
  const stale = $derived(revision !== JSON.stringify(scene.levels ?? []));
  const validation = $derived(sceneLevelsError({ levels: rows, walls: scene.walls, lights: scene.lights, tokens: scene.tokens, tiles: scene.tiles, regions: scene.regions, levelMode: scene.levelMode }));
  const warnings = $derived(levelDraftAudit({ levels: rows, tokens: scene.tokens, tiles: scene.tiles }));
  const gm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  const ordered = (levels: LevelDocument[]) => levels.sort((a, b) => a.sort - b.sort || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  function reload() {
    baseline = structuredClone($state.snapshot(scene.levels ?? []));
    rows = ordered(structuredClone(baseline));
    revision = JSON.stringify(scene.levels ?? []);
    dirty = false; message = "";
  }
  $effect(() => {
    void scene.levels;
    if (!untrack(() => dirty || busy)) untrack(reload);
  });
  // G-28 (D-436): generate a whole stack into the (empty) draft; Apply still saves it.
  let genFloors = $state(2), genBasements = $state(0), genHeight = $state(10), genRoof = $state(false);
  function generate() {
    try {
      rows = generateLevels({ floors: genFloors, basements: genBasements, height: genHeight, roof: genRoof, id: () => `level-${crypto.randomUUID()}` });
      dirty = true; message = "Stack generated. Assign each floor's map tiles, then Apply draft levels.";
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
  }
  function add() {
    const highest = Math.max(0, ...rows.map((r) => r.top ?? r.floorZ));
    rows.push(draftLevel(`level-${crypto.randomUUID()}`, rows.length ? `Level ${rows.length + 1}` : "Base", highest, highest + 10, rows.length));
    dirty = true;
  }
  function remove(id: string) {
    rows = rows.filter((l) => l._id !== id).map((l) => ({ ...l, visibleLevelIds: l.visibleLevelIds.filter((target) => target !== id) }));
    dirty = true;
  }
  function number(level: LevelDocument, field: "bottom" | "top" | "floorZ" | "sort", value: string) {
    if (field === "bottom" || field === "top") level[field] = value === "" ? null : Number(value);
    else level[field] = value === "" ? NaN : Number(value);
    dirty = true;
  }
  async function save() {
    if (!gm || busy || validation) return;
    const current = client.store.get("scenes", scene._id);
    if (!current || revision !== JSON.stringify(current.levels ?? [])) { message = "Draft levels changed elsewhere. Reload before applying."; return; }
    busy = true; message = "";
    try {
      const ops = levelDraftOps(scene._id, baseline, $state.snapshot(rows), scene.tiles);
      if (ops.length) await client.submitAndWait(ops);
      dirty = false;
      const saved = client.store.get("scenes", scene._id);
      baseline = structuredClone(saved?.levels ?? []);
      rows = ordered(structuredClone(baseline)); revision = JSON.stringify(baseline);
      message = "Draft saved. Floor presentation updated; token elevations are unchanged.";
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
</script>

<details class="level-drafts" data-level-drafts={scene._id}>
  <summary>Draft levels · GM only</summary>
  <p>Drafts alone do not activate floor play. Assign maps and scopes, add stair regions, then enable floor play below. Ambient overrides apply to isolated player floors and the GM diagnostic. Units: <strong>{scene.grid.units || "scene units"}</strong>. Bands include the bottom and exclude the top.</p>
  <p>Use the same updated build for all GMs. Backups containing drafts use format 3 and cannot be opened by older builds.</p>
  {#if !compatible}<p role="alert">Upgrade required: the connected host does not support draft levels.</p>{/if}
  <fieldset disabled={!gm || busy || !compatible}>
    {#each rows as level (level._id)}
      <section class="level-row" data-level-id={level._id}>
        <label>Name<input aria-label="Level name" maxlength="128" value={level.name} oninput={(e) => { level.name = e.currentTarget.value; dirty = true; }} /></label>
        <div class="numbers">
          {#each ["bottom", "top", "floorZ", "sort"] as field (field)}
            <label>{field === "floorZ" ? "Floor Z" : field === "sort" ? "Display order" : field === "bottom" ? "Bottom" : "Top"}
              <input aria-label={field} type="number" step={field === "sort" ? "1" : "any"} min="-1000000" max="1000000" value={level[field as "bottom" | "top" | "floorZ" | "sort"] ?? ""} oninput={(e) => number(level, field as "bottom" | "top" | "floorZ" | "sort", e.currentTarget.value)} />
            </label>
          {/each}
        </div>
        <fieldset disabled={!ambientCompatible} class="ambient-settings">
          <label><input type="checkbox" aria-label="Inherit scene ambient lighting" checked={level.darkness === undefined} onchange={(e) => {
            if (e.currentTarget.checked) delete level.darkness;
            else level.darkness = Math.max(0, Math.min(1, scene.darkness ?? 0));
            dirty = true;
          }} />Inherit scene ambient lighting</label>
          {#if level.darkness !== undefined}
            <label>Level darkness (0 = lit, 1 = total darkness)<input aria-label="Level ambient darkness" type="number" min="0" max="1" step="0.01" value={level.darkness} oninput={(e) => { level.darkness = e.currentTarget.value === "" ? NaN : Number(e.currentTarget.value); dirty = true; }} /></label>
          {:else}<small>Uses scene darkness: {scene.darkness ?? 0}.</small>{/if}
          <small>Applies to the GM diagnostic and isolated player floor.</small>
          {#if !ambientCompatible}<small>Upgrade the host to edit level ambient lighting.</small>{/if}
        </fieldset>
        <fieldset disabled={!client.supportsFeature(LEVEL_PLAY_FEATURE)}>
          <label><input type="checkbox" aria-label="Use scene background on this floor" checked={level.useSceneBackground === true} onchange={(e) => { level.useSceneBackground = e.currentTarget.checked; dirty = true; }} />Use scene background on this floor</label>
          <strong>Floor map tiles</strong>
          {#each scene.tiles as tile (tile._id)}
            <label><input type="checkbox" aria-label={`Floor map tile ${tile._id}`} checked={level.tileIds?.includes(tile._id) ?? false} onchange={(e) => { level.tileIds = e.currentTarget.checked ? [...(level.tileIds ?? []), tile._id] : (level.tileIds ?? []).filter((id) => id !== tile._id); dirty = true; }} />{tile.name || tile._id}</label>
          {/each}
          <small>Place each floor map as a tile, then assign it here. No unassigned tile or global foreground appears in isolated floor play.</small>
        </fieldset>
        <small>Blank bottom/top = unbounded. ID: {level._id}</small>
        <button type="button" onclick={() => remove(level._id)}>Remove draft level</button>
      </section>
    {/each}
    {#if !rows.length}
      <details class="generator" data-level-generator open>
        <summary>Generate a stack of floors</summary>
        <div class="numbers">
          <label>Floors (incl. ground)<input aria-label="Generated floors" type="number" min="1" max="16" step="1" bind:value={genFloors} /></label>
          <label>Basements<input aria-label="Generated basements" type="number" min="0" max="8" step="1" bind:value={genBasements} /></label>
          <label>Floor height<input aria-label="Generated floor height" type="number" min="1" step="any" bind:value={genHeight} /></label>
        </div>
        <label><input type="checkbox" aria-label="Generated roof" bind:checked={genRoof} />Add a roof level</label>
        <button type="button" onclick={generate}>Generate levels</button>
      </details>
    {/if}
    <button type="button" onclick={add} disabled={rows.length >= MAX_LEVELS}>Add draft level</button>
    <button type="button" onclick={save} disabled={!dirty || !!validation || stale}>{busy ? "Saving…" : "Apply draft levels"}</button>
    <button type="button" onclick={reload}>Reload draft</button>
  </fieldset>
  {#if stale && dirty}<p role="alert">Draft levels changed elsewhere. Reload before applying.</p>{/if}
  {#if validation}<p role="alert">{validation}</p>{:else}{#each warnings as warning, index (index)}<p class="warning">{warning}</p>{/each}{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if compatible && (scene.levels?.length ?? 0) > 0}<LevelToolsEditor {scene} {client} draftDirty={dirty || busy} />{/if}
  <LevelPlayEditor {scene} {client} draftDirty={dirty || busy} />
  <LevelBindingEditor {scene} {client} {bus} draftDirty={dirty || busy} />
</details>

<style>
  .level-drafts { border:1px solid #3b4656; border-radius:6px; padding:8px; color:#d8dee8; font-size:11px; }
  summary { cursor:pointer; font-weight:600; } p { line-height:1.5; margin:8px 0; color:#b2bdca; }
  fieldset { border:0; padding:0; margin:0; min-width:0; }
  .level-row { border-top:1px solid #354052; padding:8px 0; display:flex; flex-direction:column; gap:6px; }
  label { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .numbers { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  input { box-sizing:border-box; width:100%; min-width:0; color:#edf3fb; background:#131b25; border:1px solid #435067; border-radius:4px; padding:5px; }
  .ambient-settings { border-left:2px solid #435067; padding-left:8px; }
  input[type="checkbox"] { width:auto; align-self:flex-start; }
  small { overflow-wrap:anywhere; color:#9dabbc; }
  button { padding:5px 7px; margin:4px 4px 0 0; border:1px solid #52657a; border-radius:4px; background:#253549; color:#e6eef9; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  [role=alert],.warning { color:#f0c789; }
</style>
