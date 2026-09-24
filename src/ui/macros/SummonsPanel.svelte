<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActorDocument, MacroDocument, SceneDocument, TokenDocument } from "../../core/documents";
  import type { CompendiumPack } from "../../core/compendium";
  import { filterSummonCatalog, indexSummonCatalog } from "../../core/summonCatalog";
  import type { RequestSummonPick } from "./summonPicker";
  import { can } from "../../core/permissions";
  import { summonMarker, validateSummon, type SummonDefinition, type SummonSource } from "../../core/summons";

  type Pack = { packageId: string; packFile: string; pack: CompendiumPack };
  let { client, bus, listCompendia = null, activeSceneId = null, onPickSummon = null }: {
    client: ClientSync; bus: EventBus<ClientEvents>;
    listCompendia?: (() => Promise<Pack[]>) | null;
    activeSceneId?: string | null;
    onPickSummon?: RequestSummonPick | null;
  } = $props();
  const gm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  let scenes = $state<SceneDocument[]>([]);
  let actors = $state<ActorDocument[]>([]);
  let presets = $state<MacroDocument[]>([]);
  let packs = $state<Pack[]>([]);
  let packProblem = $state("");
  let sceneId = $state("");
  let presetId = $state("");
  let sourceKey = $state("");
  let sourceSearch = $state("");
  let sourceSort = $state<"asc" | "desc" | "crAsc" | "crDesc">("asc");
  let showWorld = $state(true), showPacks = $state(true), sourcePack = $state("");
  let sourceSize = $state("");
  let crMin = $state<number | undefined>(undefined), crMax = $state<number | undefined>(undefined);
  let selectedRef = $state("");
  let name = $state("");
  let range = $state(30);
  let size = $state(1);
  let duration = $state(0);
  let publish = $state(false);
  let requireLoS = $state(false);
  let editId = $state("");
  let x = $state(250), y = $state(250);
  let summonerId = $state("");
  let pending = $state("");
  let status = $state(""), error = $state("");
  const scene = $derived(scenes.find((s) => s._id === sceneId) ?? null);
  const visiblePresets = $derived(presets.filter((m) => m.summon?.sceneId === sceneId));
  const selected = $derived(presets.find((m) => m._id === presetId));
  const catalog = $derived(indexSummonCatalog(actors, packs));
  const sizes = $derived([...new Set(catalog.flatMap((row) => row.size ? [row.size] : []))]
    .sort((a, b) => a.localeCompare(b)));
  const choices = $derived(filterSummonCatalog(catalog, { search: sourceSearch,
    showWorld, showPacks, ...(sourcePack ? { packKey: sourcePack } : {}),
    ...(sourceSize ? { size: sourceSize } : {}),
    ...(typeof crMin === "number" && Number.isFinite(crMin) ? { minCr: crMin } : {}),
    ...(typeof crMax === "number" && Number.isFinite(crMax) ? { maxCr: crMax } : {}),
    sort: sourceSort }));
  // A chosen source remains selected even if the GM narrows the catalog; the
  // independent ref can be returned without ever cloning/importing an actor.
  const source = $derived(catalog.find((row) => row.key === sourceKey));
  const summoners = $derived(scene?.tokens.filter((t) =>
    client.user && can(client.user, "update", t, "tokens", { parent: scene })) ?? []);
  function instanceStatus(token: TokenDocument): { ownerId: string; expiresAt?: number } | null {
    const privateMarker = gm ? summonMarker(token) : null;
    if (privateMarker) return { ownerId: privateMarker.ownerId,
      ...(privateMarker.expiresAt !== undefined ? { expiresAt: privateMarker.expiresAt } : {}) };
    const safe = token.flags?.summonStatus as { ownerId?: unknown; expiresAt?: unknown } | undefined;
    return typeof safe?.ownerId === "string" &&
      (safe.expiresAt === undefined || typeof safe.expiresAt === "number")
      ? { ownerId: safe.ownerId, ...(safe.expiresAt !== undefined ? { expiresAt: safe.expiresAt as number } : {}) }
      : null;
  }
  const instances = $derived(scene?.tokens.filter((t) => instanceStatus(t) !== null) ?? []);

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")];
    actors = gm ? [...client.store.getAll("actors")] : []; // no pack/source enumeration for players
    presets = [...client.store.getAll("macros")].filter((m) => m.kind === "summon");
    if (!sceneId || !scenes.some((sc) => sc._id === sceneId))
      sceneId = scenes.find((sc) => sc._id === activeSceneId)?._id ?? scenes.find((sc) => sc.active)?._id ?? scenes[0]?._id ?? "";
    if (!presets.some((p) => p._id === presetId && p.summon?.sceneId === sceneId))
      presetId = presets.find((p) => p.summon?.sceneId === sceneId)?._id ?? "";
    if (!summoners.some((t) => t._id === summonerId))
      summonerId = summoners[0]?._id ?? "";
  }
  async function loadPacks(): Promise<void> {
    if (!gm || !listCompendia) return;
    try { packs = await listCompendia(); packProblem = ""; }
    catch { packProblem = "Actor compendium index unavailable. Import/repair the package before authoring a pack preset."; }
  }
  function keyOf(source: SummonSource): string {
    return source.kind === "world" ? `world:${source.actorId}` :
      `pack:${source.packageId}:${source.packFile}:${source.entryId}`;
  }
  function edit(preset: MacroDocument): void {
    if (!gm || !preset.summon || !("source" in preset.summon)) return;
    editId = preset._id;
    name = preset.name;
    sceneId = preset.summon.sceneId;
    sourceKey = keyOf(preset.summon.source);
    publish = preset.summon.playerCallable;
    requireLoS = preset.summon.requireLoS ?? false;
    range = preset.summon.maxDistance;
    size = preset.summon.size ?? 1;
    duration = Math.round((preset.summon.durationMs ?? 0) / 60_000 * 100) / 100;
    status = `Editing ${preset.name}`;
  }
  function clear(): void {
    editId = ""; name = ""; sourceKey = ""; publish = false; range = 30; size = 1; duration = 0; requireLoS = false;
  }
  function save(): void {
    if (!gm || !scene || !name.trim()) { error = "Choose a scene and a preset name."; return; }
    // Look up the source from the FULL indexed catalog, not just the currently filtered list.
    const world = actors.find((a) => sourceKey === `world:${a._id}`);
    const pack = packs.find((p) => sourceKey.startsWith(`pack:${p.packageId}:${p.packFile}:`));
    const entryId = pack ? sourceKey.slice(`pack:${pack.packageId}:${pack.packFile}:`.length) : "";
    const entry = pack?.pack.entries.find((e) => e.id === entryId && e.data.type === "actor");
    const selectedSource: SummonSource | null = world ? { kind: "world", actorId: world._id } :
      pack && entry ? { kind: "compendium", packageId: pack.packageId,
        packFile: pack.packFile, entryId } : null;
    if (!selectedSource) { error = "Actor source unavailable. Reload the package index or select an actor."; return; }
    const definition: SummonDefinition = {
      version: 1, sceneId, source: selectedSource,
      playerCallable: publish, maxDistance: Number(range), size: Number(size), requireLoS,
      ...(Number(duration) > 0 ? { durationMs: Math.round(Number(duration) * 60_000) } : {}),
    };
    const check = validateSummon(definition);
    if (!check.ok) { error = check.error; return; }
    const id = editId || crypto.randomUUID();
    if (editId) {
      client.submit([{ kind: "update", ref: { coll: "macros", id },
        diff: { name: name.trim(), summon: definition as unknown as import("../../core/documents").Json,
          ownership: { default: publish ? 1 : 0 } } }]);
    } else {
      const doc: MacroDocument = { _id: id, type: "macro", kind: "summon", name: name.trim(),
        command: "", ownership: { default: publish ? 1 : 0 }, flags: {}, system: {}, summon: definition };
      client.submit([{ kind: "create", coll: "macros", data: doc }]);
    }
    status = `${editId ? "Updated" : "Saved"} ${name.trim()} · ${publish ? "player callable" : "GM only"}`;
    error = ""; presetId = id; clear();
  }
  function deletePreset(preset: MacroDocument): void {
    if (!gm || !confirm(`Delete summon preset ${preset.name}? Existing summons remain until dismissed or expired.`)) return;
    client.submit([{ kind: "delete", ref: { coll: "macros", id: preset._id } }]);
    if (editId === preset._id) clear();
  }
  function snapToGrid(): void {
    if (!scene) return;
    const grid = scene.grid.size;
    x = Math.round((Number(x) - grid / 2) / grid) * grid + grid / 2;
    y = Math.round((Number(y) - grid / 2) / grid) * grid + grid / 2;
  }
  let alive = true;
  async function pickOnMap(): Promise<void> {
    if (!scene || !selected?.summon || !onPickSummon) return;
    if (!gm && !summonerId) { error = "Choose a token you control before using the crosshair."; return; }
    const chosenId = selected._id;
    const picked = await onPickSummon({ sceneId: scene._id,
      maxDistance: selected.summon.maxDistance, size: selected.summon.size,
      ...(selected.summon.requireLoS !== undefined ? { requireLoS: selected.summon.requireLoS } : {}),
      ...(summonerId ? { summonerTokenId: summonerId } : {}), ...(gm ? { gmManual: true } : {}) });
    if (!alive) return;
    if (!picked) { status = "Summon placement cancelled"; return; }
    if (selected?._id !== chosenId || scene?._id !== selected.summon.sceneId) {
      error = "Preset or scene changed while selecting the point. Choose it again."; return;
    }
    x = picked.x; y = picked.y;
    place();
  }
  function place(): void {
    if (!selected || !scene || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      error = "Choose a published preset, scene and valid placement coordinates."; return;
    }
    if (!gm && !summonerId) { error = "You need a token you control in this scene."; return; }
    pending = client.requestSummonPlace(selected._id, scene._id,
      { x: Number(x), y: Number(y) }, summonerId || undefined);
    status = "Awaiting host placement…"; error = "";
  }
  function dismiss(token: TokenDocument): void {
    if (!scene || !confirm(`Dismiss ${token.name}?`)) return;
    pending = client.requestSummonDismiss(scene._id, token._id);
    status = "Requesting dismissal…"; error = "";
  }
  onMount(() => {
    const offSnap = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offResult = bus.on("summonResult", (res) => {
      if (res.requestId !== pending) return;
      status = res.ok ? `${res.detail} · seq ${res.seq ?? "?"}` : "";
      error = res.ok ? "" : res.detail;
      pending = "";
    });
    const offRejected = bus.on("rejected", (res) => { error = `${res.reason}: ${res.detail}`; });
    refresh(); void loadPacks();
    return () => { alive = false; offSnap(); offOps(); offResult(); offRejected(); };
  });
</script>

<section class="summons" aria-label="Summon presets and instances" data-summons-panel>
  <header><h3>Summons · independent actor instances</h3></header>
  {#if gm}
    <p class="hint">Publish only actors you permit this table to summon. A preset references a world actor or an imported actor pack; placement clones it without importing/mutating the source. Pack media is only shown when its owned hash is shareable.</p>
    {#if packProblem}<p class="error" role="alert">{packProblem}</p>{/if}
    <div class="row"><label>Preset name <input data-summon-name bind:value={name} maxlength="128" placeholder="Summon wolf" /></label>
      <label>Scene <select data-summon-scene bind:value={sceneId}><option value="">Select scene</option>
        {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
      </select></label></div>
    <div class="row"><label>Find actor <input data-summon-search bind:value={sourceSearch} placeholder="Search world actors and packs" /></label>
      <label>Sort <select data-summon-source-sort bind:value={sourceSort}>
        <option value="asc">Name A–Z</option><option value="desc">Name Z–A</option>
        <option value="crAsc">CR low–high</option><option value="crDesc">CR high–low</option>
      </select></label>
      <button type="button" onclick={() => void loadPacks()}>Refresh packs</button></div>
    <div class="row" data-summon-source-filters>
      <label><input data-summon-show-world type="checkbox" bind:checked={showWorld} />World actors</label>
      <label><input data-summon-show-packs type="checkbox" bind:checked={showPacks} />Actor packs</label>
      <label>Source pack <select data-summon-pack bind:value={sourcePack}>
        <option value="">All installed packs</option>
        {#each packs.filter((p) => p.pack.type === "actors") as p (`${p.packageId}:${p.packFile}`)}
          <option value={`${p.packageId}:${p.packFile}`}>{p.pack.name} · {p.packageId}</option>
        {/each}
      </select></label>
      <label>Size <select data-summon-size-filter bind:value={sourceSize}>
        <option value="">All sizes</option>{#each sizes as size (size)}<option value={size}>{size}</option>{/each}
      </select></label>
      <label>CR from <input data-summon-cr-min type="number" min="0" max="1000" step="0.25" bind:value={crMin} /></label>
      <label>to <input data-summon-cr-max type="number" min="0" max="1000" step="0.25" bind:value={crMax} /></label>
    </div>
    <label>Actor source <select data-summon-source bind:value={sourceKey}><option value="">Choose actor…</option>
      {#each choices.slice(0, 250) as choice (choice.key)}<option value={choice.key}>{choice.label}</option>{/each}
    </select></label>
    <div class="row"><button data-summon-select-only type="button" disabled={!source}
      onclick={() => { selectedRef = source ? JSON.stringify(source.source) : "";
        status = "Selected an actor reference without importing or placing it."; }}>
      Select reference only</button>
      {#if selectedRef}<input data-summon-selected-ref aria-label="Selected actor reference" readonly value={selectedRef} onclick={(e) => e.currentTarget.select()} />{/if}
    </div>
    {#if source}
      <small data-summon-source-info>{source.source.kind === "world" ? "World actor" : "Installed actor pack"}
        {source.cr !== undefined ? ` · CR ${source.cr}` : " · CR not indexed"}
        {source.size ? ` · ${source.size}` : " · size not indexed"} · selecting does not import.</small>
    {/if}
    {#if source && source.actor && !source.actor.items?.length}<small>This world actor has no embedded items; its system state will still be copied.</small>{/if}
    <div class="row"><label>Max range (scene units) <input data-summon-range type="number" min="0" max="10000" bind:value={range} /></label>
      <label>Footprint (grid cells) <input data-summon-size type="number" min="0.25" max="8" step="0.25" bind:value={size} /></label>
      <label>Lifetime (minutes; 0 = until dismissed) <input data-summon-duration type="number" min="0" max="1440" step="0.01" bind:value={duration} /></label></div>
    <label><input data-summon-los type="checkbox" bind:checked={requireLoS} /> Require line of sight from player caster (closed/locked doors block)</label>
    <div class="row"><label><input data-summon-publish type="checkbox" bind:checked={publish} /> Permit players to invoke with a controlled token</label>
      <button data-summon-save type="button" onclick={save}>{editId ? "Save changes" : "Save preset"}</button>
      {#if editId}<button type="button" onclick={clear}>Cancel edit</button>{/if}</div>
  {/if}
  <h4>Place a saved summon</h4>
  <div class="row"><label>Scene <select bind:value={sceneId}><option value="">Select scene</option>
      {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
    </select></label>
    <label>Preset <select data-summon-preset bind:value={presetId}><option value="">Select a preset…</option>
      {#each visiblePresets as preset (preset._id)}<option value={preset._id}>{preset.name}</option>{/each}
    </select></label>
    <label>Summoner <select data-summon-caster bind:value={summonerId}>
      {#if gm}<option value="">GM placement (no caster)</option>{/if}
      {#each summoners as token (token._id)}<option value={token._id}>{token.name}</option>{/each}
    </select></label></div>
  <div class="row"><label>X <input data-summon-x type="number" bind:value={x} /></label>
    <label>Y <input data-summon-y type="number" bind:value={y} /></label>
    <button type="button" onclick={snapToGrid}>Snap center to grid</button>
    {#if onPickSummon}<button data-summon-pick type="button" onclick={() => void pickOnMap()}
      disabled={!selected || !scene || (!gm && !summonerId) || (activeSceneId !== null && activeSceneId !== scene?._id)}>Pick on map…</button>{/if}
    <button data-summon-place type="button" onclick={place} disabled={!selected || !scene || (!gm && !summonerId)}>Summon at point</button></div>
  {#if selected?.summon}<p class="hint">Footprint {selected.summon.size ?? 1} grid cells · range {selected.summon.maxDistance} {scene?.grid.units ?? "units"} · {selected.summon.requireLoS ? "sight required" : "no sight gate"}{selected.summon.durationMs ? ` · ${(selected.summon.durationMs / 60_000).toFixed(1)} min` : ""}</p>{/if}
  <p class="hint">Point is the token center in scene pixels. The crosshair previews footprint, range and walls; the host repeats checks. PF1e casting costs are not yet wired.</p>
  {#if gm && visiblePresets.length}
    <details><summary>Manage presets ({visiblePresets.length})</summary>
      {#each visiblePresets as preset (preset._id)}<div class="row" data-summon-preset-row={preset._id}>
        <span>{preset.name} · {preset.summon?.playerCallable ? "published" : "GM only"}</span>
        <button type="button" onclick={() => edit(preset)}>Edit</button>
        <button type="button" onclick={() => deletePreset(preset)}>Delete</button>
      </div>{/each}
    </details>
  {/if}
  <h4>Instances ({instances.length})</h4>
  {#each instances as token (token._id)}
    {@const meta = instanceStatus(token)}
    <div class="row" data-summon-instance={token._id}>
      <span>{token.name} · {Math.round(token.x)}, {Math.round(token.y)}
        {#if meta?.expiresAt} · expires {new Date(meta.expiresAt).toLocaleTimeString()}{/if}</span>
      {#if gm || meta?.ownerId === client.user?.id}<button type="button" onclick={() => dismiss(token)}>Dismiss</button>{/if}
    </div>
  {:else}<p>No summons in this scene.</p>{/each}
  {#if status}<p class="hint" role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .summons { display: grid; gap: 7px; padding: 9px; max-height: 60vh; overflow-y: auto; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  label { display: grid; gap: 2px; font-size: 0.86em; min-width: 100px; }
  input, select { max-width: 235px; }
  .hint { color: #aaa9ae; font-size: 0.84em; margin: 4px 0; }
  .error { color: #ec8686; }
  h3, h4 { margin: 4px 0; }
</style>
