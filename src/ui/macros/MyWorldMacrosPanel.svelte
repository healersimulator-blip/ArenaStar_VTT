<script lang="ts">
  /** D-394: original personal drafts, not the GM's executable source or local hotbar layout. */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MacroDocument, SceneDocument } from "../../core/documents";
  import type { PermissionUser } from "../../core/ownership";
  import type { ScriptInput } from "../../core/scriptMacros";
  import { canSaveWorldMacros, ownsPlayerMacro, playerMacroAuthoring, validatePlayerMacroDraft,
    type PlayerMacroDraft } from "../../core/playerMacros";
  import { runChatMacro } from "./run";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let viewer = $state<PermissionUser | null>(null);
  let enabled = $state(false);
  let macros = $state<MacroDocument[]>([]);
  let scenes = $state<SceneDocument[]>([]);
  let revision = $state(0);
  let editing = $state("");
  let kind = $state<"chat" | "script">("chat");
  let name = $state("");
  let command = $state("/roll 1d20");
  let sceneId = $state("");
  let inputs = $state<ScriptInput[]>([]);
  let pending = $state<{ requestId: string; macroId: string; action: "save" | "delete" } | null>(null);
  let status = $state("");
  let error = $state("");
  const chosen = $derived.by(() => {
    void revision;
    return editing ? client.store.get("macros", editing) ?? null : null;
  });
  const canManage = $derived(enabled && (!editing || !!viewer && !!chosen && ownsPlayerMacro(viewer, chosen)));

  function refresh(): void {
    viewer = client.user;
    enabled = canSaveWorldMacros(viewer, client.store.getAll("users"));
    macros = [...client.store.getAll("macros")].filter((macro) =>
      playerMacroAuthoring(macro)?.userId === viewer?.id && ["chat", "script"].includes(macro.kind));
    scenes = [...client.store.getAll("scenes")];
    revision++;
    if (!sceneId && !editing) sceneId = scenes.find((scene) => scene.active)?._id ?? scenes[0]?._id ?? "";
    // Never reload the form on ops: permission revocation and GM review must not erase a draft.
  }

  function pick(macro: MacroDocument): void {
    if (pending) return;
    const original = playerMacroAuthoring(macro);
    if (!original || original.userId !== viewer?.id) return;
    editing = macro._id;
    kind = original.draft.kind;
    name = original.draft.name;
    command = original.draft.command;
    sceneId = original.draft.kind === "script" ? original.draft.sceneId : scenes.find((scene) => scene.active)?._id ?? "";
    inputs = original.draft.kind === "script" ? original.draft.inputs.map((input) => ({ ...input })) : [];
    error = ""; status = "Editing your original draft. Saving a script revision requires new GM review.";
  }

  function fresh(): void {
    if (pending) return;
    editing = ""; kind = "chat"; name = ""; command = "/roll 1d20"; inputs = [];
    sceneId = scenes.find((scene) => scene.active)?._id ?? scenes[0]?._id ?? "";
    status = ""; error = "";
  }

  function changeInput(index: number, patch: Partial<ScriptInput>): void {
    inputs = inputs.map((input, at) => at === index ? { ...input, ...patch } : input);
  }

  function save(): void {
    if (!canManage || pending) return;
    error = ""; status = "";
    const draft: PlayerMacroDraft = kind === "chat" ? { kind, name, command }
      : { kind, name, command, sceneId, inputs };
    const checked = validatePlayerMacroDraft(draft);
    if (!checked.ok) { error = checked.error; return; }
    const macroId = editing || globalThis.crypto.randomUUID();
    pending = { requestId: client.saveWorldMacro(macroId, checked.draft), macroId, action: "save" };
    status = "Requesting save in the GM world…";
  }

  function remove(macro: MacroDocument): void {
    if (!enabled || pending || !viewer || !ownsPlayerMacro(viewer, macro)) return;
    error = "";
    pending = { requestId: client.deleteWorldMacro(macro._id), macroId: macro._id, action: "delete" };
    status = "Requesting deletion from the GM world…";
  }

  function run(macro: MacroDocument): void {
    const result = runChatMacro(client, macro);
    error = result.ok ? "" : result.error ?? "Saved chat macro could not run.";
    if (result.ok) status = "Ran the saved world chat macro (not the unsaved editor text).";
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offResult = bus.on("macroResult", (message) => {
      if (!pending || message.requestId !== pending.requestId) return;
      const completed = pending;
      pending = null;
      if (!message.ok) { error = message.detail; status = ""; return; }
      if (completed.action === "save") editing = completed.macroId;
      else if (editing === completed.macroId) fresh();
      status = message.detail;
      error = "";
      refresh();
    });
    refresh();
    return () => { offSnapshot(); offOps(); offResult(); };
  });
</script>

<section data-my-world-macros aria-label="My world macros">
  <h4>My world macros</h4>
  <p class="hint">Personal chat/roll macros and script drafts are saved in the GM world and included in its next save/export. This does not sync browser-local hotbar layouts.</p>
  {#if !enabled}
    <p data-my-macro-disabled class="hint">The GM has not enabled macro saving for you. Your editor draft is kept; existing macros are read-only here.</p>
  {:else if editing && !canManage}
    <p data-my-macro-unavailable class="hint">This saved macro is no longer available for you to edit. Your editor draft is kept.</p>
  {/if}
  <div class="toolbar"><button type="button" data-my-macro-new disabled={!!pending} onclick={fresh}>New draft</button></div>
  <form onsubmit={(event) => { event.preventDefault(); save(); }}>
    <fieldset disabled={!canManage || !!pending}>
      <label>Name <input data-my-macro-name maxlength="64" bind:value={name} placeholder="My initiative roll" /></label>
      <label>Kind <select data-my-macro-kind bind:value={kind}><option value="chat">Chat / roll</option><option value="script">Script draft — GM review required</option></select></label>
      <label>{kind === "script" ? "Your original script source" : "Chat / roll command"}
        <textarea data-my-macro-source rows={kind === "script" ? 8 : 3} maxlength={kind === "script" ? 16384 : 4096} bind:value={command}></textarea>
      </label>
      {#if kind === "script"}
        <p class="hint">Saving never approves code, grants host APIs or publishes execution. Use the Script macros runner only after the GM separately reviews and publishes it. GM changes to executable source are not shown in this editor.</p>
        <label>Script scene <select data-my-macro-scene bind:value={sceneId}>
          <option value="">Choose a visible scene</option>
          {#each scenes as scene (scene._id)}<option value={scene._id}>{scene.name}</option>{/each}
        </select></label>
        <div class="inputs" data-my-macro-inputs>
          <h5>Declared inputs</h5>
          {#each inputs as input, index (index)}
            <div class="input-row" data-my-macro-input>
              <input aria-label={`Input ${index + 1} name`} maxlength="32" value={input.name} onchange={(event) => changeInput(index, { name: event.currentTarget.value })} />
              <select aria-label={`Input ${index + 1} type`} value={input.type} onchange={(event) => changeInput(index, { type: event.currentTarget.value as ScriptInput["type"] })}>
                <option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="token">token</option>
              </select>
              <label><input type="checkbox" checked={input.required === true} onchange={(event) => changeInput(index, { required: event.currentTarget.checked })} />Required</label>
              <button type="button" aria-label={`Remove input ${index + 1}`} onclick={() => inputs = inputs.filter((_, at) => at !== index)}>Remove</button>
            </div>
          {/each}
          <button type="button" data-my-macro-add-input disabled={inputs.length >= 16} onclick={() => inputs = [...inputs, { name: `input${inputs.length + 1}`, type: "string" }]}>Add input</button>
        </div>
      {/if}
      <button type="submit" data-my-macro-save>{pending?.action === "save" ? "Saving…" : "Save in GM world"}</button>
    </fieldset>
  </form>
  {#if error}<p role="alert" data-my-macro-error>{error}</p>{/if}
  {#if status}<p role="status" data-my-macro-status>{status}</p>{/if}
  <ul>
    {#each macros as macro (macro._id)}
      <li data-my-macro-id={macro._id}>
        <span>{macro.name} <small>({macro.kind === "script" ? "script — separate GM review" : "chat / roll"})</small></span>
        <button type="button" data-my-macro-edit disabled={!!pending} onclick={() => pick(macro)}>Open draft</button>
        {#if macro.kind === "chat"}<button type="button" data-my-macro-run onclick={() => run(macro)}>Run saved</button>{/if}
        <button type="button" data-my-macro-delete disabled={!enabled || !!pending || !viewer || !ownsPlayerMacro(viewer, macro)} onclick={() => remove(macro)}>Delete</button>
      </li>
    {/each}
  </ul>
  {#if macros.length === 0}<p class="hint">No personal world macros yet.</p>{/if}
</section>

<style>
  section { display: flex; flex-direction: column; gap: 7px; }
  h4, h5, p { margin: 0; }
  .hint, small { color: #99b4c5; font-size: 0.8rem; }
  fieldset { display: flex; flex-direction: column; gap: 8px; border: 1px solid #354958; padding: 8px; }
  fieldset > label { display: flex; flex-direction: column; gap: 3px; }
  textarea { width: 100%; box-sizing: border-box; font-family: monospace; resize: vertical; }
  .inputs { display: flex; flex-direction: column; gap: 5px; }
  .input-row { display: flex; gap: 5px; flex-wrap: wrap; }
  .input-row input:not([type="checkbox"]) { width: 120px; }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
  li { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  li > span { flex: 1; min-width: 110px; }
  [role="alert"] { color: #ffa0a0; }
  [role="status"] { color: #a8dbb7; }
</style>
