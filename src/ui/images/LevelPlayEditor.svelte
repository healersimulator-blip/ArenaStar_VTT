<script lang="ts">
  import type { SceneDocument, RegionDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import { LEVEL_PLAY_FEATURE } from "../../core/levelPlay";
  let { scene, client, draftDirty }: { scene: SceneDocument; client: ClientSync; draftDirty: boolean } = $props();
  let busy = $state(false), message = $state("");
  let from = $state(""), to = $state(""), x = $state(0), y = $state(0), width = $state(100), height = $state(100), both = $state(true);
  const parent = $derived({ coll: "scenes" as const, id: scene._id });
  async function enable(enabled: boolean) {
    busy = true; message = "";
    try {
      await client.submitAndWait([{ kind: "update", ref: parent, diff: enabled ? { levelMode: "isolated" } : { "-=levelMode": null } }]);
      message = enabled ? "Floor play enabled. Players follow their token through stairs; unassigned artwork is not drawn." : "Legacy scene view restored.";
    } catch (error) { message = String(error); } finally { busy = false; }
  }
  async function stairs() {
    busy = true; message = "";
    const make = (a: string, b: string): RegionDocument => ({ _id: `stairs-${crypto.randomUUID()}`, type: "region", name: `Stairs ${scene.levels?.find((l) => l._id === a)?.name} → ${scene.levels?.find((l) => l._id === b)?.name}`,
      ownership: { default: 0 }, flags: {}, system: {}, hidden: true, x, y, width, height, rotation: 0,
      shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: { from: a, to: b } });
    try {
      const regions = [make(from, to), ...(both ? [make(to, from)] : [])];
      await client.submitAndWait(regions.map((data) => ({ kind: "create", coll: "regions", parent, data })));
      message = "Stair regions saved. Finish a token move inside the region to travel. Leave and re-enter to return; no automatic bounce.";
    } catch (error) { message = String(error); } finally { busy = false; }
  }
  async function remove(id: string) {
    busy = true; message = "";
    try { await client.submitAndWait([{ kind: "delete", ref: { coll: "regions", id, parent } }]); message = "Stairs removed."; }
    catch (error) { message = String(error); } finally { busy = false; }
  }
</script>
<details data-level-play>
  <summary>Floor artwork &amp; stair travel</summary>
  <p>Assign map tiles to each level above, and walls/lights under Membership. Unassigned layers, global foreground, drawings and notes are not drawn in floor play. Each floor gets separate remembered fog. This separates the canvas, not all network data, sheets or FX.</p>
  <fieldset disabled={busy || draftDirty || !client.supportsFeature(LEVEL_PLAY_FEATURE)}>
    <label><input aria-label="Enable isolated floor play" type="checkbox" checked={scene.levelMode === "isolated"} disabled={!scene.levels?.length} onchange={(e) => enable(e.currentTarget.checked)} />Enable isolated floor play · follow tokens through stairs</label>
    <h4>Create stair region</h4>
    <label>From<select aria-label="Stairs source floor" bind:value={from}><option value="">Choose floor</option>{#each scene.levels ?? [] as l (l._id)}<option value={l._id}>{l.name}</option>{/each}</select></label>
    <label>To<select aria-label="Stairs destination floor" bind:value={to}><option value="">Choose floor</option>{#each scene.levels ?? [] as l (l._id)}<option value={l._id}>{l.name}</option>{/each}</select></label>
    <div class="bounds">
      <label>X<input aria-label="Stairs X" type="number" bind:value={x} /></label><label>Y<input aria-label="Stairs Y" type="number" bind:value={y} /></label>
      <label>Width<input aria-label="Stairs width" type="number" min="1" bind:value={width} /></label><label>Height<input aria-label="Stairs height" type="number" min="1" bind:value={height} /></label>
    </div>
    <label><input aria-label="Create return stairs" type="checkbox" bind:checked={both} />Create return stairs at the same XY</label>
    <p>Bounds use scene pixels. Entry uses the token center. XY stays at the accepted endpoint; membership and feet Z change together. Edit polygons/rotation in Active Zones. For a return trip, leave the region before entering it again.</p>
    <button type="button" disabled={!from || !to || from === to || ![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0} onclick={stairs}>Create stairs</button>
    {#each (scene.regions ?? []).filter((r) => r.stairs) as r (r._id)}
      <p data-stair-region={r._id}>{r.name} · ({r.x}, {r.y}), {r.width} × {r.height} <button type="button" onclick={() => remove(r._id)}>Remove stairs</button></p>
    {/each}
  </fieldset>
  {#if message}<p role="status">{message}</p>{/if}
</details>
<style>
  details { margin-top:12px; border-top:1px solid #435067; padding-top:8px; }
  summary { cursor:pointer; font-weight:600; } label { display:block; margin:8px 0; }
  .bounds { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  fieldset { border:0; padding:0; min-width:0; } input:not([type=checkbox]),select { width:100%; box-sizing:border-box; background:#131b25; color:#edf3fb; border:1px solid #435067; padding:5px; }
  button { padding:5px; background:#253549; color:#edf3fb; border:1px solid #52657a; cursor:pointer; } button:disabled { opacity:.5; }
  p { font-size:11px; line-height:1.5; color:#b2bdca; }
</style>
