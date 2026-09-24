<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { FxInstanceDocument, SceneDocument } from "../../core/documents";
  import { validateFxInstanceFilter } from "../../core/fxInstances";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let scenes = $state<SceneDocument[]>([]);
  let instances = $state<FxInstanceDocument[]>([]);
  let sceneId = $state("");
  let filter = $state("");
  let stopName = $state("");
  let stopMacro = $state("");
  let stopSource = $state("");
  let stopTarget = $state("");
  let status = $state("");
  let error = $state("");
  const rows = $derived(instances.filter((instance) =>
    instance.sceneId === sceneId && instance.name.toLowerCase().includes(filter.trim().toLowerCase())));

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")];
    instances = [...client.store.getAll("fxInstances")];
    if (!scenes.some((s) => s._id === sceneId)) {
      sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
    }
  }
  function stop(id: string): void {
    client.requestFxStop(id);
    error = "";
    status = "Stop requested; the host will end playback for its recipients.";
  }
  function stopMatching(): void {
    error = ""; status = "";
    if (client.user?.role !== "GM" && client.user?.role !== "ASSISTANT") {
      error = "Only a GM/assistant can filter and end multiple FX.";
      return;
    }
    const candidate = {
      ...(stopName.trim() ? { name: stopName.trim() } : {}),
      ...(stopMacro.trim() ? { macroId: stopMacro.trim() } : {}),
      ...(stopSource.trim() ? { sourceTokenId: stopSource.trim() } : {}),
      ...(stopTarget.trim() ? { targetTokenId: stopTarget.trim() } : {}),
    };
    const checked = validateFxInstanceFilter(candidate, true);
    if (!checked.ok) { error = checked.error; return; }
    if (!sceneId) { error = "Choose a scene before stopping FX."; return; }
    client.requestFxStopMatching(sceneId, checked.filter);
    status = "Host is matching the live scene and will end up to 16 instances in one undoable transaction; a wider match is rejected without stopping any.";
  }
  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", (reason) => { error = `${reason.reason}: ${reason.detail}`; });
    refresh();
    return () => { offSnapshot(); offOps(); offRejected(); };
  });
</script>

<section class="fx-manager" aria-label="Live FX manager" data-fx-manager>
  <h3>Live FX instances</h3>
  <p class="hint">Host-owned looping image, video, text and sound cues. Stop an instance here, or end its source token, scene or saved macro. Recipients are rechecked when visibility or media rights change.</p>
  <div class="filters">
    <label>Scene <select bind:value={sceneId} data-fx-manager-scene>
      {#each scenes as scene (scene._id)}<option value={scene._id}>{scene.name}</option>{/each}
    </select></label>
    <label>Name <input aria-label="Find live FX" placeholder="Filter by name" bind:value={filter} /></label>
  </div>
  {#if client.user?.role === "GM" || client.user?.role === "ASSISTANT"}
    <fieldset data-fx-stop-matching>
      <legend>Stop matching live FX (atomic, max 16)</legend>
      <label>Name pattern <input aria-label="Stop name pattern" placeholder="Ward* (case-insensitive)" bind:value={stopName} /></label>
      <label>Sequence ID <input aria-label="Stop sequence ID" placeholder="optional exact ID" bind:value={stopMacro} /></label>
      <label>Source token ID <input aria-label="Stop source token ID" placeholder="optional exact ID" bind:value={stopSource} /></label>
      <label>Target token ID <input aria-label="Stop target token ID" placeholder="optional exact ID" bind:value={stopTarget} /></label>
      <button type="button" data-fx-stop-bulk onclick={stopMatching}>Stop matching in scene</button>
      <small>Choose at least one selector. Name supports * and ?; IDs match exactly. Unlike the preview search above, the host re-evaluates this filter against live instances. Undo restores the entire stop together.</small>
    </fieldset>
  {/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  <ul>
    {#each rows as instance (instance._id)}
      <li data-fx-instance={instance._id}>
        <strong>{instance.name}</strong>
        <small>origin {instance.ownerId.slice(0, 12)} · {instance.sections.filter((s) => s.kind !== "wait").length} lanes</small>
        <button type="button" aria-label={`Stop ${instance.name}`} onclick={() => stop(instance._id)}>Stop</button>
      </li>
    {/each}
  </ul>
  {#if rows.length === 0}<p>No live FX instances match this scene/filter.</p>{/if}
</section>

<style>
  .fx-manager { display: grid; gap: 8px; font-size: .8rem; }
  h3, p { margin: 0; }
  .hint { color: #b4bdc8; }
  .filters, li { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  label { display: flex; align-items: center; gap: 4px; }
  fieldset { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; border: 1px solid #4e5262; border-radius: 4px; }
  fieldset small { width: 100%; color: #aab6c6; }
  input, select { min-width: 110px; max-width: 210px; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 5px; max-height: 300px; overflow: auto; }
  li { padding: 5px; border: 1px solid #4e5262; border-radius: 4px; }
  li strong { flex: 1; }
  li small { color: #aab6c6; }
  .error { color: #ff9e9e; }
</style>
