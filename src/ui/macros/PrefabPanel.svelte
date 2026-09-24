<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { AutomationDocument, PrefabDocument, SceneDocument } from "../../core/documents";
  import type { Op } from "../../core/ops";
  import { listTaggable } from "../../core/tags";
  import { PREFAB_COLLECTIONS, planPrefabPlacement, validatePrefab,
    type PrefabCollection, type PrefabDefinition, type PrefabPart, type PrefabPlaceable } from "../../core/prefabs";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  const canEdit = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  let scenes = $state<SceneDocument[]>([]);
  let prefabs = $state<PrefabDocument[]>([]);
  let graphs = $state<AutomationDocument[]>([]);
  let sceneId = $state("");
  let name = $state("");
  let rootId = $state("");
  let selected = new SvelteSet<string>();
  let parents = $state<Record<string, string>>({});
  let locked = new SvelteSet<string>();
  let placeId = $state("");
  let x = $state(400), y = $state(400), rotation = $state(0), scale = $state(1);
  let status = $state(""), error = $state("");
  const scene = $derived(scenes.find((sc) => sc._id === sceneId) ?? null);
  const options = $derived(scene ? listTaggable(client.store.world, { sceneId,
    collections: [...PREFAB_COLLECTIONS] }).filter((row) =>
      PREFAB_COLLECTIONS.includes(row.collection as PrefabCollection)) : []);
  const chosen = $derived(options.filter((row) => selected.has(row.doc._id)));
  const instances = $derived.by(() => {
    if (!scene) return [] as Array<{ id: string; rootId: string; parts: number }>;
    const found = new SvelteMap<string, { id: string; rootId: string; parts: number }>();
    for (const coll of PREFAB_COLLECTIONS) for (const doc of scene[coll]) {
      const marker = doc.flags?.prefab as { instanceId?: string; rootId?: string } | undefined;
      if (!marker?.instanceId || !marker.rootId) continue;
      const row = found.get(marker.instanceId) ?? { id: marker.instanceId, rootId: marker.rootId, parts: 0 };
      row.parts++;
      found.set(row.id, row);
    }
    return [...found.values()];
  });

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")];
    prefabs = [...client.store.getAll("prefabs")];
    graphs = [...client.store.getAll("automations")];
    if (!scenes.some((sc) => sc._id === sceneId)) sceneId = scenes.find((sc) => sc.active)?._id ?? scenes[0]?._id ?? "";
    if (!prefabs.some((p) => p._id === placeId)) placeId = prefabs[0]?._id ?? "";
  }
  function toggle(id: string): void {
    if (selected.has(id)) {
      selected.delete(id);
      if (rootId === id) rootId = [...selected][0] ?? "";
      locked.delete(id);
      parents = Object.fromEntries(Object.entries(parents).filter(([child, parent]) => child !== id && parent !== id));
    } else {
      selected.add(id);
      if (!rootId) rootId = id;
      const existing = options.find((row) => row.doc._id === id)?.doc.flags?.prefab as
        { parentId?: string; locked?: boolean } | undefined;
      if (existing?.parentId && selected.has(existing.parentId)) parents[id] = existing.parentId;
      if (existing?.locked) locked.add(id);
    }
  }
  function anchor(doc: PrefabPlaceable, coll: PrefabCollection): { x: number; y: number } {
    if (coll === "walls") {
      const c = (doc as Extract<PrefabPlaceable, { type: "wall" }>).c;
      return { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 };
    }
    if (coll === "drawings") {
      const d = doc as Extract<PrefabPlaceable, { type: "drawing" }>;
      return d.box ? { x: d.box[0], y: d.box[1] } :
        { x: d.points[0] ?? 0, y: d.points[1] ?? 0 };
    }
    return { x: (doc as Extract<PrefabPlaceable, { x: number; y: number }>).x,
      y: (doc as Extract<PrefabPlaceable, { x: number; y: number }>).y };
  }
  function draft(): PrefabDefinition | null {
    if (!scene || !rootId || !chosen.length) { error = "Choose a scene, at least one object and a root."; return null; }
    const root = chosen.find((row) => row.doc._id === rootId);
    if (!root) { error = "Select a root from the included objects."; return null; }
    const parts: PrefabPart[] = chosen.map((row) => {
      const choice = parents[row.doc._id];
      const parentId = row.doc._id === rootId ? undefined :
        choice && selected.has(choice) && choice !== row.doc._id ? choice : rootId;
      return { id: row.doc._id, coll: row.collection as PrefabCollection,
        ...(parentId ? { parentId } : {}), ...(locked.has(row.doc._id) ? { locked: true } : {}),
        doc: $state.snapshot(row.doc) as PrefabPlaceable };
    });
    const tileIds = new Set(parts.filter((p) => p.coll === "tiles").map((p) => p.id));
    const linked = graphs.filter((g) => g.definition?.sceneId === sceneId && tileIds.has(g.definition.tileId))
      .map((g) => {
        const doc = $state.snapshot(g);
        delete doc.state; // graph copies start with fresh once/cooldown history
        return { id: doc._id, doc };
      });
    const definition: PrefabDefinition = { version: 1, sourceSceneId: sceneId, gridSize: scene.grid.size,
      origin: anchor(root.doc as PrefabPlaceable, root.collection as PrefabCollection), parts, graphs: linked };
    const checked = validatePrefab(definition);
    if (!checked.ok) { error = checked.error; return null; }
    error = "";
    return definition;
  }
  function save(): void {
    if (!canEdit || !name.trim()) { error = "Enter a prefab name."; return; }
    const definition = draft();
    if (!definition) return;
    const preflight = planPrefabPlacement(client.store.world, definition, sceneId,
      { at: definition.origin }, () => crypto.randomUUID());
    if (!preflight.ok) { error = `Cannot publish this template: ${preflight.error}`; return; }
    const doc: PrefabDocument = { _id: crypto.randomUUID(), type: "prefab", name: name.trim(),
      ownership: { default: 0 }, flags: {}, system: {}, definition };
    client.submit([{ kind: "create", coll: "prefabs", data: doc }]);
    status = `Submitted prefab ${doc.name} (${definition.parts.length} objects, ${definition.graphs.length} graphs)`;
    placeId = doc._id;
  }
  function despawn(instanceId: string): void {
    if (!canEdit || !scene || !confirm("Despawn all scene objects and linked graphs in this prefab instance?")) return;
    const ops: Op[] = [];
    for (const graph of graphs) if ((graph.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId)
      ops.push({ kind: "delete", ref: { coll: "automations", id: graph._id } });
    for (const coll of PREFAB_COLLECTIONS) for (const doc of scene[coll]) {
      if ((doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId)
        ops.push({ kind: "delete", ref: { coll, id: doc._id, parent: { coll: "scenes", id: scene._id } } });
    }
    if (!ops.length) { error = "Instance no longer exists."; return; }
    client.submit(ops);
    status = `Requested atomic despawn of ${ops.length} instance objects`;
  }
  function place(preview: boolean): void {
    error = "";
    const prefab = prefabs.find((p) => p._id === placeId);
    if (!prefab || !scene) { error = "Choose a saved prefab and destination scene."; return; }
    const position = { at: { x: Number(x), y: Number(y) }, rotation: Number(rotation), scale: Number(scale) };
    if (preview) {
      let i = 0;
      const planned = planPrefabPlacement(client.store.world, $state.snapshot(prefab.definition), sceneId, position,
        () => `preview_${i++}`);
      status = planned.ok ? `Ready: ${planned.plan.ops.length} atomic creates. Tags: ${planned.plan.tags.join(", ") || "none"}` : "";
      error = planned.ok ? "" : planned.error;
      return;
    }
    client.requestPrefabPlace(prefab._id, sceneId, position.at, position.rotation, position.scale);
    status = "Requesting authoritative placement…";
  }
  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offResult = bus.on("prefabResult", (result) => {
      status = result.ok ? `Placed prefab ${result.instanceId} at seq ${result.seq}` : "";
      error = result.ok ? "" : result.detail;
    });
    const offRejected = bus.on("rejected", (rejection) => { error = `${rejection.reason}: ${rejection.detail}`; });
    refresh();
    return () => { offSnapshot(); offOps(); offResult(); offRejected(); };
  });
</script>

<section class="prefabs" aria-label="Prefabs and template placement" data-prefab-panel>
  <header><h3>Layered prefabs · Tagger rules</h3></header>
  <p class="hint">Capture scene placeables and their saved tile graphs, then stamp an atomic copy. Author linked selectors with tags like <code>door-{'{#}'}</code> or <code>door-{'{id}'}</code>; the host allocates and rebinds them per instance. Referenced media must already be imported.</p>
  {#if !canEdit}<p>Prefab definitions and placements are GM-only.</p>{:else}
    <div class="row"><label>Prefab name <input data-prefab-name bind:value={name} placeholder="Gate trap" /></label>
      <label>Capture scene <select bind:value={sceneId} onchange={() => { selected.clear(); locked.clear(); parents = {}; rootId = ""; }} data-prefab-scene>
        {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
      </select></label>
    </div>
    <div class="capture" data-prefab-parts>
      {#each options.slice(0, 200) as row (`${row.collection}:${row.doc._id}`)}
        <label><input type="checkbox" checked={selected.has(row.doc._id)} onchange={() => toggle(row.doc._id)} />
          {row.collection} · {row.doc.name} <small>{row.tags.join(", ")}</small>
        </label>
      {/each}
    </div>
    <div class="row"><label>Root <select bind:value={rootId} data-prefab-root><option value="">Choose root…</option>
        {#each chosen as row (row.doc._id)}<option value={row.doc._id}>{row.collection} · {row.doc.name}</option>{/each}
      </select></label>
      <button type="button" data-prefab-save onclick={save}>Save selected + linked graphs</button>
    </div>
    {#if chosen.length > 1}
      <details><summary>Attachment hierarchy / locks ({chosen.length} parts)</summary>
        <div class="hierarchy">
          {#each chosen as row (row.doc._id)}
            <div class="row"><span>{row.collection} · {row.doc.name}</span>
              {#if row.doc._id !== rootId}
                <label>Parent <select value={parents[row.doc._id] ?? rootId}
                    onchange={(event) => { parents[row.doc._id] = event.currentTarget.value; }}>
                  {#each chosen.filter((other) => other.doc._id !== row.doc._id) as parent (parent.doc._id)}
                    <option value={parent.doc._id}>{parent.collection} · {parent.doc.name}</option>
                  {/each}
                </select></label>
                <label><input type="checkbox" checked={locked.has(row.doc._id)}
                    onchange={() => { if (locked.has(row.doc._id)) locked.delete(row.doc._id); else locked.add(row.doc._id); }} /> Lock child</label>
              {:else}<small>Root / drag to move descendants</small>{/if}
            </div>
          {/each}
        </div>
      </details>
    {/if}
    <p class="hint">Use the Tags tab to add source placeable tags first; select every target object. Included graphs must be saved on included tiles. Parent transforms carry all descendants in one undoable host transaction; a locked child cannot be edited directly by players. A cyclic hierarchy is rejected at save.</p>
    <h4>Place saved prefab</h4>
    <div class="row"><label>Template <select bind:value={placeId} data-prefab-list><option value="">Select…</option>
      {#each prefabs as prefab (prefab._id)}<option value={prefab._id}>{prefab.name} ({prefab.definition.parts.length} parts)</option>{/each}
    </select></label>
      <label>X <input type="number" bind:value={x} /></label><label>Y <input type="number" bind:value={y} /></label>
      <label>Rotation ° <input type="number" min="-360" max="360" bind:value={rotation} /></label>
      <label>Scale <input type="number" min="0.25" max="4" step="0.1" bind:value={scale} /></label>
      <button type="button" data-prefab-preview onclick={() => place(true)}>Preview checks</button>
      <button type="button" data-prefab-place onclick={() => place(false)}>Place atomically</button>
    </div>
    {#if instances.length}
      <details data-prefab-instances><summary>Placed instances ({instances.length})</summary>
        {#each instances as instance (instance.id)}
          <div class="row"><span>{instance.id.slice(0, 12)} · {instance.parts} parts · root {instance.rootId.slice(0, 12)}</span>
            <button type="button" onclick={() => despawn(instance.id)}>Despawn atomically</button></div>
        {/each}
      </details>
    {/if}
    {#if status}<p role="status">{status}</p>{/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <p class="hint">Token/tile roots move, uniformly resize and rotate their nested descendants atomically; other root geometries and attach/detach, nested persistent FX and summon hooks are still being implemented. This is not full Token Attacher parity.</p>
  {/if}
</section>

<style>
  .prefabs { display: grid; gap: 7px; font-size: .8rem; }
  header, .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  h3, h4, p { margin: 0; }
  label { display: inline-flex; align-items: center; gap: 4px; }
  input:not([type="checkbox"]), select { min-width: 75px; max-width: 210px; }
  input[type="number"] { width: 75px; }
  .capture { max-height: 155px; overflow: auto; border: 1px solid #4e5767; display: flex; flex-direction: column; gap: 3px; padding: 4px; }
  .capture label { justify-content: flex-start; }
  .hierarchy { display: grid; gap: 4px; max-height: 190px; overflow: auto; }
  small, .hint { color: #abb6c6; }
  .error { color: #ff9e9e; }
</style>
