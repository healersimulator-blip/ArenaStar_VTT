<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { SceneDocument, LevelScope } from "../../core/documents";
  import type { EventBus } from "../../core/events";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import { DRAFT_LEVELS_FEATURE, LEVEL_SCOPES_FEATURE, LEVEL_LIGHTING_FEATURE } from "../../core/capabilities";
  import { levelBindings } from "../../core/levelMembership";
  import { bindingRevision, planTokenBinding, planWallBinding, type BindingKind } from "./levelBindingEditor";
  let { scene, client, bus, draftDirty = false }: { scene: SceneDocument; client: ClientSync; bus: EventBus<ClientEvents>; draftDirty?: boolean } = $props();
  let compatible = $state(false), busy = $state(false), message = $state("");
  let kind = $state<BindingKind>("tokens"), id = $state(""), destination = $state("");
  let mode = $state<"legacy" | "all" | "levels">("legacy"), ids = $state<string[]>([]), revision = $state("");
  const levels = $derived([...(scene.levels ?? [])].sort((a, b) => a.sort - b.sort || a._id.localeCompare(b._id)));
  const selected = $derived(scene[kind].find((doc) => doc._id === id));
  const stale = $derived(!!id && revision !== bindingRevision(scene, kind, id));
  const gm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  onMount(() => {
    const refresh = () => { compatible = client.supportsFeature(DRAFT_LEVELS_FEATURE) && client.supportsFeature(LEVEL_SCOPES_FEATURE) && client.supportsFeature(LEVEL_LIGHTING_FEATURE); };
    refresh();
    const offWelcome = bus.on("welcome", refresh), offKick = bus.on("kick", () => { compatible = false; });
    return () => { offWelcome(); offKick(); };
  });
  function load() {
    revision = bindingRevision(scene, kind, id); message = "";
    destination = scene.tokens.find((t) => kind === "tokens" && t._id === id)?.levelId ?? "";
    const scope = (kind === "tokens" ? undefined : scene[kind].find((w) => w._id === id)?.levelScope);
    mode = scope?.mode ?? "legacy"; ids = scope?.mode === "levels" ? [...scope.ids] : [];
  }
  const selectionKey = $derived(JSON.stringify([scene._id, kind, id]));
  $effect(() => { void selectionKey; untrack(load); });
  function toggle(level: string, checked: boolean) { ids = checked ? [...ids, level] : ids.filter((i) => i !== level); }
  async function apply() {
    if (!gm || !compatible || busy || draftDirty || !selected || stale) return;
    const current = client.store.get("scenes", scene._id);
    if (!current || revision !== bindingRevision(current, kind, id)) { message = "Selection changed elsewhere. Reload before applying."; return; }
    busy = true; message = "";
    try {
      const scope: LevelScope | undefined = mode === "legacy" ? undefined : mode === "all" ? { mode: "all" } : { mode: "levels", ids: $state.snapshot(ids) };
      const ops = kind === "tokens" ? planTokenBinding(current, id, destination || null) : planWallBinding(current, id, scope, kind);
      if (ops.length) await client.submitAndWait(ops);
      const saved = client.store.get("scenes", scene._id);
      if (saved) revision = bindingRevision(saved, kind, id);
      message = ops.length ? "Assignment saved. Undo is available." : "No assignment changes.";
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
</script>

<details class="bindings" data-level-bindings={scene._id}>
  <summary>Membership &amp; wall scopes · experimental authoring</summary>
  <p>Assignments remain draft-only until isolated floor play is enabled above. Active floor play uses assigned walls and lights; this is not full secret-data redaction.</p>
  <p>Assigning a token explicitly moves its feet to the saved level's Floor Z. Clearing membership keeps its elevation. Scoped walls and lights participate in isolated floor play and the GM lighting diagnostic. Unassigned walls/lights stay in the legacy view.</p>
  {#if !compatible}<p role="alert">Upgrade required: host must support level scopes.</p>{/if}
  {#if draftDirty}<p role="alert">Apply or reload your draft level edits before assigning objects.</p>{/if}
  <fieldset disabled={!gm || !compatible || busy || draftDirty}>
    <label>Object type<select aria-label="Membership object type" bind:value={kind} onchange={() => { id = ""; }}><option value="tokens">Token</option><option value="walls">Wall</option><option value="lights">Light</option></select></label>
    <label>Object<select aria-label="Membership object" bind:value={id}><option value="">Select an object…</option>{#each scene[kind] as doc (doc._id)}<option value={doc._id}>{doc.name || doc.type} · {doc._id}</option>{/each}</select></label>
    {#if selected}
      {#if kind === "tokens"}
        <label>Destination level<select aria-label="Token destination level" bind:value={destination}><option value="">Unassigned · keep elevation</option>{#each levels as level (level._id)}<option value={level._id}>{level.name} · Floor Z {level.floorZ}</option>{/each}</select></label>
        <p>Current feet Z: {scene.tokens.find((t) => t._id === id)?.elevation ?? 0}. {destination ? `Apply moves feet to Z ${levels.find((l) => l._id === destination)?.floorZ ?? "missing level"}.` : "No elevation change."}</p>
      {:else}
        <label>{kind === "lights" ? "Light scope" : "Wall scope"}<select aria-label={kind === "lights" ? "Light level scope" : "Wall level scope"} bind:value={mode}><option value="legacy">Legacy / unassigned</option><option value="all">All levels · explicit</option><option value="levels">Selected levels</option></select></label>
        {#if mode === "levels"}{#each levels as level (level._id)}<label class="check"><input type="checkbox" checked={ids.includes(level._id)} onchange={(e) => toggle(level._id, e.currentTarget.checked)} />{level.name}</label>{/each}{/if}
      {/if}
      <button type="button" onclick={apply} disabled={stale || (kind !== "tokens" && mode === "levels" && !ids.length)}>{busy ? "Saving assignment…" : "Apply assignment"}</button>
    {/if}
    <button type="button" onclick={load}>Reload assignment</button>
  </fieldset>
  {#if stale}<p role="alert">Object or saved levels changed. Reload assignment before applying.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <h4>Saved binding audit</h4>
  <p>Unassigned tokens: {scene.tokens.filter((t) => t.levelId === undefined).length}. Legacy walls: {scene.walls.filter((w) => w.levelScope === undefined).length}. All-level walls: {scene.walls.filter((w) => w.levelScope?.mode === "all").length}.</p>
  {#each levels as level (level._id)}
    {@const bindings = levelBindings(scene, level._id)}
    <details data-level-binding-audit={level._id}><summary>{level.name}: {bindings.tokens.length} tokens · {bindings.walls.length} walls · {bindings.lights.length} lights</summary><p>Tokens: {bindings.tokens.join(", ") || "none"}<br />Walls: {bindings.walls.join(", ") || "none"}<br />Lights: {bindings.lights.join(", ") || "none"}</p></details>
  {/each}
</details>

<style>
  .bindings { border-top:1px solid #435067; padding-top:8px; margin-top:10px; font-size:11px; color:#d8dee8; }
  summary { cursor:pointer; font-weight:600; } p { line-height:1.5; color:#b2bdca; overflow-wrap:anywhere; }
  fieldset { border:0; padding:0; min-width:0; } label { display:flex; flex-direction:column; gap:4px; margin:8px 0; }
  select { width:100%; min-width:0; background:#131b25; color:#edf3fb; padding:5px; border:1px solid #435067; border-radius:4px; }
  .check { flex-direction:row; align-items:center; } button { background:#253549; color:#e6eef9; border:1px solid #52657a; border-radius:4px; padding:5px; margin:4px 4px 0 0; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; } [role=alert] { color:#f0c789; } h4 { margin-bottom:0; }
</style>
