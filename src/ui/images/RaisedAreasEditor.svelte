<script lang="ts">
  import type { Json, RegionDocument, SceneDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { Op } from "../../core/ops";
  import { drawnRaisedArea, raisedEditDiff, raisedFitError, type RaisedEdit } from "../../core/raisedAreas";
  /**
   * D-453: raised areas inside a floor, such as crate stacks, a dais or a scaffold. Walking tokens
   * climb onto them. Solid ones hide what is behind them from eyes below their top. Each change is
   * one undoable region create, update or delete. The Raised area tool on the map's tool rail makes
   * them by dragging.
   */
  let { scene, client }: { scene: SceneDocument; client: ClientSync } = $props();
  let busy = $state(false), message = $state("");
  let name = $state(""), height = $state(5), solid = $state(true), floor = $state(""), source = $state("");
  let x = $state(0), y = $state(0), width = $state(200), depth = $state(200);
  let editing = $state<string | null>(null), edit = $state<RaisedEdit | null>(null);
  const parent = $derived({ coll: "scenes" as const, id: scene._id });
  const units = $derived(scene.grid?.units ? ` ${scene.grid.units}` : "");
  const levels = $derived([...(scene.levels ?? [])].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || a._id.localeCompare(b._id)));
  const areas = $derived((scene.regions ?? []).filter((r) => r.raised));
  const plainRegions = $derived((scene.regions ?? []).filter((r) => !r.raised && !r.stairs && !r.fauxOverhead));
  const where = (region: RegionDocument) => {
    if (!levels.length) return "on the ground";
    const scope = region.levelScope;
    if (!scope || scope.mode === "all") return "on every floor";
    return `on ${scope.ids.map((id) => levels.find((l) => l._id === id)?.name ?? id).join(", ")}`;
  };
  async function submit(ops: Op[], done: string): Promise<boolean> {
    busy = true; message = "";
    try {
      if (ops.length) await client.submitAndWait(ops);
      message = ops.length ? done : "Nothing to change.";
      return true;
    } catch (error) { message = error instanceof Error ? error.message : String(error); return false; }
    finally { busy = false; }
  }
  async function create() {
    const from = plainRegions.find((r) => r._id === source);
    if (from) {
      const fit = raisedFitError(scene, floor || null, height);
      if (fit) { message = fit; return; }
      const scope = floor ? { levelScope: { mode: "levels", ids: [floor] } as unknown as Json } : {};
      if (await submit([{ kind: "update", ref: { coll: "regions", id: from._id, parent }, diff: { raised: { height, solid }, ...scope } }],
        `${from.name} is now a raised area.`)) source = "";
      return;
    }
    const region = drawnRaisedArea(scene, { x, y, width, height: depth }, { id: `raised-${crypto.randomUUID()}`, levelId: floor || null, name, height, solid });
    if (typeof region === "string") { message = region; return; }
    if (await submit([{ kind: "create", coll: "regions", parent, data: region }], `${region.name} added.`)) name = "";
  }
  function startEdit(region: RegionDocument) {
    if (!region.raised) return;
    editing = region._id; message = "";
    edit = { name: region.name, height: region.raised.height, solid: region.raised.solid, area: { x: region.x, y: region.y, width: region.width, height: region.height } };
  }
  async function saveEdit(region: RegionDocument) {
    if (!edit) return;
    const diff = raisedEditDiff(region, scene, edit);
    if (typeof diff === "string") { message = diff; return; }
    if (await submit([{ kind: "update", ref: { coll: "regions", id: region._id, parent }, diff: { ...diff, raised: diff.raised as unknown as Json } }], `${diff.name} updated.`)) {
      editing = null; edit = null;
    }
  }
  function setSolid(region: RegionDocument, next: boolean) {
    if (!region.raised) return;
    void submit([{ kind: "update", ref: { coll: "regions", id: region._id, parent }, diff: { raised: { height: region.raised.height, solid: next } } }],
      next ? `${region.name} is solid: it hides what is behind it.` : `${region.name} is open: it hides nothing.`);
  }
</script>
<details data-raised-areas={scene._id}>
  <summary>Raised areas · GM only ({areas.length})</summary>
  <p>Crate stacks, a dais, a scaffold: a box standing on its floor. A token that walks onto one stands on its top, and walking off brings it back down. A <strong>solid</strong> one hides what is behind it from eyes below its top; an open one (a scaffold, a platform) hides nothing. Or pick the <strong>Raised area</strong> tool on the map's tool rail and drag.</p>
  <fieldset disabled={busy}>
    {#each areas as r (r._id)}
      <div class="area" data-raised-area={r._id}>
        <span><strong>{r.name}</strong> · {r.raised?.height}{units} · {r.raised?.solid ? "solid" : "open"} · {where(r)} · ({r.x}, {r.y}), {r.width} × {r.height}</span>
        <label class="check"><input type="checkbox" aria-label={`Solid ${r.name}`} checked={r.raised?.solid === true} onchange={(e) => setSolid(r, e.currentTarget.checked)} />Solid</label>
        <button type="button" aria-label={`Edit raised area ${r.name}`} aria-expanded={editing === r._id}
          onclick={() => { if (editing === r._id) { editing = null; edit = null; } else startEdit(r); }}>{editing === r._id ? "Close editor" : "Edit"}</button>
        <button type="button" aria-label={`Remove raised area ${r.name}`} onclick={() => submit([{ kind: "delete", ref: { coll: "regions", id: r._id, parent } }], `${r.name} removed.`)}>Remove</button>
        {#if editing === r._id && edit}
          <div class="edit" role="group" aria-label={`Edit raised area ${r.name}`} data-raised-edit>
            <label>Name<input aria-label="Raised area name" maxlength="128" bind:value={edit.name} /></label>
            <label>Height ({units.trim() || "units"})<input aria-label="Edit raised area height" type="number" min="1" max="1000" step="1" bind:value={edit.height} /></label>
            <label class="check"><input type="checkbox" aria-label="Edit raised area solid" bind:checked={edit.solid} />Solid: hides what is behind it</label>
            <div class="bounds">
              <label>X<input aria-label="Edit raised area X" type="number" bind:value={edit.area.x} /></label><label>Y<input aria-label="Edit raised area Y" type="number" bind:value={edit.area.y} /></label>
              <label>Width<input aria-label="Edit raised area width" type="number" min="1" bind:value={edit.area.width} /></label><label>Depth<input aria-label="Edit raised area depth" type="number" min="1" bind:value={edit.area.height} /></label>
            </div>
            <button type="button" onclick={() => saveEdit(r)}>Save raised area</button>
            <button type="button" onclick={() => { editing = null; edit = null; }}>Cancel</button>
          </div>
        {/if}
      </div>
    {/each}
    <h4>Add a raised area</h4>
    <label>Name (optional)<input aria-label="New raised area name" maxlength="128" bind:value={name} placeholder="Crates" /></label>
    <label>Height ({units.trim() || "units"})<input aria-label="New raised area height" type="number" min="1" max="1000" step="1" bind:value={height} /></label>
    <label class="check"><input type="checkbox" aria-label="New raised area solid" bind:checked={solid} />Solid: hides what is behind it</label>
    {#if levels.length}
      <label>Stands on<select aria-label="New raised area floor" bind:value={floor}><option value="">Every floor</option>{#each levels as l (l._id)}<option value={l._id}>{l.name}</option>{/each}</select></label>
    {/if}
    <label>Area<select aria-label="New raised area shape" bind:value={source}><option value="">Rectangle below</option>{#each plainRegions as r (r._id)}<option value={r._id}>Region: {r.name}</option>{/each}</select></label>
    {#if !source}
      <div class="bounds">
        <label>X<input aria-label="New raised area X" type="number" bind:value={x} /></label><label>Y<input aria-label="New raised area Y" type="number" bind:value={y} /></label>
        <label>Width<input aria-label="New raised area width" type="number" min="1" bind:value={width} /></label><label>Depth<input aria-label="New raised area depth" type="number" min="1" bind:value={depth} /></label>
      </div>
    {/if}
    <button type="button" onclick={create}>Add raised area</button>
  </fieldset>
  {#if message}<p role="status">{message}</p>{/if}
</details>
<style>
  details { margin-top:12px; border-top:1px solid #435067; padding-top:8px; }
  summary { cursor:pointer; font-weight:600; } label { display:block; margin:8px 0; }
  .bounds { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .edit { margin:6px 0 4px; padding:6px 8px; border-left:2px solid #7a5a3a; }
  .check { display:flex; align-items:center; gap:6px; margin:4px 0; }
  fieldset { border:0; padding:0; min-width:0; } input:not([type=checkbox]),select { width:100%; box-sizing:border-box; background:#131b25; color:#edf3fb; border:1px solid #435067; padding:5px; }
  button { padding:5px; background:#253549; color:#edf3fb; border:1px solid #52657a; cursor:pointer; margin:2px 4px 2px 0; } button:disabled { opacity:.5; }
  p { font-size:11px; line-height:1.5; color:#b2bdca; } h4 { margin:10px 0 4px; }
  .area { font-size:11px; color:#b2bdca; border-top:1px dashed #33405a; padding:4px 0; overflow-wrap:anywhere; }
</style>
