<script lang="ts">
  /** Reviewed, version-pinned async JavaScript macros — not a text-only macro stub. */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { Json, MacroDocument, PrefabDocument, SceneDocument } from "../../core/documents";
  import { SCRIPT_GRANTS, scriptApprovalHash, validateScriptMacro,
    type ScriptGrant, type ScriptInput, type ScriptPolicy } from "../../core/scriptMacros";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let role = $state("");
  const canEdit = $derived(role === "GM" || role === "ASSISTANT");
  let macros = $state<MacroDocument[]>([]);
  let scenes = $state<SceneDocument[]>([]);
  let prefabs = $state<PrefabDocument[]>([]);
  let summons = $state<MacroDocument[]>([]);
  let prefabIds = $state<string[]>([]);
  let summonIds = $state<string[]>([]);
  let selected = $state("");
  let name = $state("");
  let source = $state("// Script code runs on the host after GM review.\nconst matches = await api.tags.find('door-*', { pattern: 'wildcard', collections: ['tokens'] });\nreturn { count: matches.length };");
  let sceneId = $state("");
  let playerCallable = $state(false);
  let runAs = $state<"caller" | "gm">("caller");
  let grants = $state<ScriptGrant[]>(["tags.read"]);
  let inputs = $state<ScriptInput[]>([]);
  let slot = $state(0);
  let reviewed = $state(false);
  let busy = $state(false);
  let status = $state("");
  let error = $state("");
  let response = $state<ClientEvents["macroResult"] | null>(null);
  let runArgs = $state<Record<string, string | boolean>>({});
  let pendingRun = $state("");
  let pendingSave = $state("");
  const chosen = $derived(macros.find((m) => m._id === selected) ?? null);
  const formInputs = $derived(chosen?.script?.inputs ?? []);
  // A player's callable catalog intentionally redacts its scene ID. Offer
  // visible token choices from the active scene; the host rechecks every ID.
  const inputScene = $derived(scenes.find((sc) => sc._id === chosen?.script?.sceneId)
    ?? scenes.find((sc) => sc.active) ?? scenes[0] ?? null);

  function refresh(): void {
    role = client.user?.role ?? "";
    macros = [...client.store.getAll("macros")].filter((m) => m.kind === "script");
    scenes = [...client.store.getAll("scenes")];
    prefabs = [...client.store.getAll("prefabs")];
    summons = [...client.store.getAll("macros")].filter((m) => m.kind === "summon");
    if (!scenes.some((s) => s._id === sceneId)) sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
  }
  function pick(m: MacroDocument): void {
    selected = m._id;
    name = m.name;
    runArgs = {};
    response = null;
    if (!canEdit) return;
    source = m.command;
    if (m.script) {
      sceneId = m.script.sceneId;
      playerCallable = m.script.playerCallable;
      runAs = m.script.runAs;
      grants = [...m.script.grants];
      inputs = m.script.inputs.map((input) => ({ ...input }));
      prefabIds = [...m.script.prefabIds ?? []];
      summonIds = [...m.script.summonIds ?? []];
    }
    const raw = m.flags?.core;
    slot = raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.slot === "number" ? raw.slot : 0;
    reviewed = false; error = ""; status = "Editing saved source — review again before publishing a new revision.";
  }
  function reset(): void {
    selected = ""; name = ""; source = "// Paste reviewed JavaScript here.\nreturn { ok: true };";
    grants = []; inputs = []; prefabIds = []; summonIds = []; playerCallable = false; runAs = "caller";
    slot = 0; reviewed = false; error = ""; status = ""; response = null;
  }
  function toggleGrant(grant: ScriptGrant): void {
    grants = grants.includes(grant) ? grants.filter((g) => g !== grant) : [...grants, grant];
    reviewed = false;
  }
  function updateInput(index: number, patch: Partial<ScriptInput>): void {
    inputs = inputs.map((old, at) => at === index ? { ...old, ...patch } : old);
    reviewed = false;
  }
  async function save(): Promise<void> {
    error = ""; status = "";
    if (!canEdit || busy) return;
    if (!reviewed) { error = "Review the exact source, grants, scene, run-as and inputs before approving this revision."; return; }
    if (!sceneId || !name.trim()) { error = "Select a scene and enter a name."; return; }
    busy = true;
    try {
      const policyWithoutHash: Omit<ScriptPolicy, "approvedHash"> = { version: 1,
        sceneId, runAs, playerCallable, grants: [...grants], inputs: $state.snapshot(inputs),
        ...(grants.includes("prefabs.place") && prefabIds.length ? { prefabIds: [...prefabIds] } : {}),
        ...(grants.includes("summons") && summonIds.length ? { summonIds: [...summonIds] } : {}) };
      const policy: ScriptPolicy = { ...policyWithoutHash,
        approvedHash: await scriptApprovalHash(source, policyWithoutHash) };
      const existing = macros.find((m) => m._id === selected);
      const doc: MacroDocument = { _id: existing?._id ?? crypto.randomUUID(), type: "macro",
        name: name.trim(), command: source, kind: "script", script: policy,
        ownership: { default: playerCallable ? 1 : 0 },
        flags: { core: { playerCallable, ...(slot ? { slot } : {}) } }, system: {} };
      const checked = validateScriptMacro(doc);
      if (!checked.ok) { error = checked.error; return; }
      const txId = existing ? client.submit([{ kind: "update", ref: { coll: "macros", id: existing._id },
        diff: { name: doc.name, command: doc.command, script: policy as unknown as Json,
          ownership: doc.ownership, flags: doc.flags } }])
        : client.submit([{ kind: "create", coll: "macros", data: doc }]);
      pendingSave = txId;
      selected = doc._id;
      status = "Submitted reviewed revision to host. Run after it is committed.";
      reviewed = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  function invoke(macro: MacroDocument): void {
    const args: Record<string, Json> = {};
    for (const field of macro.script?.inputs ?? []) {
      const raw = runArgs[field.name];
      if (field.type === "boolean") { if (raw !== undefined) args[field.name] = raw === true; continue; }
      if (raw === undefined || raw === "") { if (field.required) { error = `Enter ${field.name}.`; return; } continue; }
      args[field.name] = field.type === "number" ? Number(raw) : String(raw);
    }
    error = ""; response = null;
    pendingRun = client.requestMacro(macro._id, args);
    status = "Host is validating and executing the saved revision…";
  }
  function remove(id: string): void {
    if (!canEdit) return;
    client.submit([{ kind: "delete", ref: { coll: "macros", id } }]);
    if (selected === id) reset();
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", ({ envelope }) => { refresh();
      if (envelope.txId === pendingSave) { pendingSave = ""; status = "Script revision published."; }
    });
    const offResult = bus.on("macroResult", (msg) => {
      if (msg.requestId !== pendingRun && !canEdit) return;
      response = msg; status = msg.detail; pendingRun = "";
    });
    const offRejected = bus.on("rejected", (msg) => {
      if (msg.txId !== pendingRun && msg.txId !== pendingSave) return;
      error = `${msg.reason}: ${msg.detail}`; pendingSave = ""; pendingRun = "";
    });
    refresh();
    return () => { offSnapshot(); offOps(); offResult(); offRejected(); };
  });
</script>

<section class="scripts" data-script-wizard aria-label="Script macro wizard">
  <header><h3>Script macros · programmable actions</h3>{#if canEdit}<button type="button" onclick={reset}>New</button>{/if}</header>
  <p class="hint">Async JavaScript can query live scene tags, edit authorized targets, send chat, play a saved FX timeline, place/dismiss an approved summon, fire a published zone or await a nested macro. The host validates and commits each authorized world action; a multi-action script is not atomic. This is not yet the full parity action API.</p>
  {#if canEdit}
    <p class="warning">Trusted GM code only. Workers isolate the canvas, but cannot reliably sandbox hostile network code. Never approve pasted code you have not reviewed. Changing source, authority or grants invalidates the revision approval.</p>
    <label>Name <input data-script-name bind:value={name} oninput={() => reviewed = false} placeholder="e.g. Open tagged gates" /></label>
    <div class="row">
      <label>Fixed scene <select data-script-scene bind:value={sceneId} onchange={() => reviewed = false}>{#each scenes as scene (scene._id)}<option value={scene._id}>{scene.name}</option>{/each}</select></label>
      <label>Run as <select bind:value={runAs} onchange={() => reviewed = false}><option value="caller">Invoking user</option><option value="gm">GM (reviewed elevation)</option></select></label>
      <label><input type="checkbox" bind:checked={playerCallable} onchange={() => reviewed = false} />Allow players to invoke</label>
      <label>Hotbar slot <select bind:value={slot}><option value={0}>—</option>{#each [1, 2, 3, 4, 5] as n (n)}<option value={n}>{n}</option>{/each}</select></label>
    </div>
    <label class="source">JavaScript source <textarea data-script-source spellcheck="false" rows="11" bind:value={source} oninput={() => reviewed = false}></textarea></label>
    <div class="grants">Host API grants:
      {#each SCRIPT_GRANTS as grant (grant)}<label><input type="checkbox" checked={grants.includes(grant)} onchange={() => toggleGrant(grant)} />{grant}</label>{/each}
    </div>
    {#if grants.includes("tags.read")}
      <p class="hint">Tagger reads: <code>await api.tags.getTags(ref)</code>, <code>await api.tags.hasTags(ref, query, options)</code> and <code>await api.tags.getByTag(query, options)</code> (alias: <code>find</code>). Queries default to this script's scene; pass <code>{`{ sceneId: 'other-scene' }`}</code> or <code>{`{ allScenes: true, groupByScene: true }`}</code> for explicit projected cross-scene reads (max 100 hits / 16 KiB). Every ref identifies its scene. GM elevation cannot read a hidden placeable or private scene for a player.</p>
    {/if}
    {#if grants.includes("tags.write")}
      <p class="hint">Tagger writes: <code>api.tags.setTags(refs, tags)</code>, <code>addTags</code>, <code>removeTags</code>, <code>toggleTags</code> and <code>clearAllTags(refs)</code>, and <code>applyTagRules(refs)</code> for scene-unique <code>{"{#}"}</code>/<code>{"{id}"}</code> expansion (or <code>edit(refs, mode, tags)</code>). Each awaited edit (up to 32 explicitly scene-qualified refs, including scene documents) is one undoable host transaction, even across scenes. Every target must be in the actual caller's current projected view; caller-run code additionally needs update ownership, while GM-elevated player code can edit only visible targets under the reviewed grant. Only an actual GM/assistant caller can expand <code>{"{#}"}</code>: numbering against hidden scene tags would otherwise reveal their occupancy to a player, even through a reviewed GM script. Player callers may expand <code>{"{id}"}</code>. No implicit all-scene write.</p>
    {/if}
    {#if grants.includes("fx")}
      <p class="hint">FX manager API: <code>await api.fx.play(macroId)</code> returns a cue with <code>runId</code> and host-clock times; <code>await api.fx.list({`{ name: 'ward*', macroId }`})</code> returns this scene's entitled, caller-owned instances (GM may inspect all). <code>await api.fx.stop(runId)</code> or <code>await api.fx.stopMatching({`{ name: 'ward*' }`})</code> ends matching persistent instances in one undoable commit (at most 16). Names match case-insensitively with * and ?; empty stop filters are rejected. GM-reviewed player code never inherits the GM's FX viewing rights.</p>
    {/if}
    {#if grants.includes("fx")}
      <p class="hint">Reviewed FX chains: <code>await api.fx.sequence().play('intro').parallel(api =&gt; api.fx.play('left'), api =&gt; api.fx.play('right')).playAndWait('outro').thenDo(api =&gt; api.chat.say('Finished', 'gm')).run()</code>. Chain steps can also <code>wait(ms)</code> or <code>call(scriptId, args)</code> with the separately reviewed <code>macros</code> grant. <code>playAndWait</code> requires a nonpersistent sequence finishing within 7 seconds; it waits for the host-clock cue window, not client media decode. The Worker has a 10-second timeout and 32-step/8-parallel-job bounds. Earlier starts are not rolled back if a later callback fails.</p>
    {/if}
    {#if grants.includes("prefabs.place")}
      <fieldset data-script-prefab-allowlist><legend>Prefab placement grant</legend>
        <p class="hint">Code: <code>await api.prefabs.place(prefabId, x, y, rotation, scale)</code>. Player-callable scripts must run as reviewed GM authority and may place only the checked saved templates in this scene. A player caller cannot place a prefab containing <code>{"{#}"}</code> numbered tags: hidden scene tags could otherwise be inferred from numbering gaps. GM/assistant callers can place them. Input positions are bounds-checked on the host.</p>
        {#each prefabs as prefab (prefab._id)}
          <label><input type="checkbox" checked={prefabIds.includes(prefab._id)}
            onchange={() => { prefabIds = prefabIds.includes(prefab._id)
              ? prefabIds.filter((id) => id !== prefab._id) : [...prefabIds, prefab._id]; reviewed = false; }} />{prefab.name}</label>
        {/each}
        {#if !prefabs.length}<small>Save a template in the Prefabs tab first.</small>{/if}
      </fieldset>
    {/if}
    {#if grants.includes("summons")}
      <fieldset data-script-summon-allowlist><legend>Summon grant</legend>
        <p class="hint">Code: <code>await api.summons.place(presetId, x, y, summonerTokenId)</code> and <code>await api.summons.dismiss(tokenId)</code>. A player must control their caster. Caller-run code can use published presets; elevated player-callable code requires an exact reviewed allowlist. Every placement is host-revalidated, returns a token ID and clones a fresh instance.</p>
        {#each summons.filter((s) => s.summon?.sceneId === sceneId) as preset (preset._id)}
          <label><input type="checkbox" checked={summonIds.includes(preset._id)}
            onchange={() => { summonIds = summonIds.includes(preset._id)
              ? summonIds.filter((id) => id !== preset._id) : [...summonIds, preset._id]; reviewed = false; }} />{preset.name} · {preset.summon?.playerCallable ? "published" : "GM only"}</label>
        {/each}
        {#if !summons.length}<small>Save a preset in the Summons tab first.</small>{/if}
      </fieldset>
    {/if}
    <div class="inputs"><span>Declared inputs (callers cannot send undeclared keys):</span>
      {#each inputs as field, i (i)}
        <div class="row"><input aria-label={`Input ${i + 1} name`} value={field.name} oninput={(e) => updateInput(i, { name: (e.target as HTMLInputElement).value })} placeholder="name" />
          <select aria-label={`Input ${i + 1} type`} value={field.type} onchange={(e) => updateInput(i, { type: (e.target as HTMLSelectElement).value as ScriptInput["type"] })}>
            <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="token">Visible token ID</option>
          </select><label><input type="checkbox" checked={field.required ?? false} onchange={(e) => updateInput(i, { required: (e.target as HTMLInputElement).checked })} />Required</label>
          <button type="button" aria-label={`Remove input ${i + 1}`} onclick={() => { inputs = inputs.filter((_, at) => at !== i); reviewed = false; }}>×</button>
        </div>
      {/each}
      <button type="button" disabled={inputs.length >= 16} onclick={() => { inputs = [...inputs, { name: `arg${inputs.length + 1}`, type: "string" }]; reviewed = false; }}>Add input</button>
    </div>
    <label class="review"><input type="checkbox" bind:checked={reviewed} />I reviewed this exact revision and its host grants</label>
    <button type="button" data-script-save disabled={busy} onclick={() => void save()}>Approve &amp; save revision</button>
  {/if}
  <h4>{canEdit ? "Saved scripts" : "Published scripts"}</h4>
  {#if macros.length === 0}<p class="hint">No script macros are available.</p>{/if}
  <ul>{#each macros as m (m._id)}<li>
    <button type="button" data-script-pick={m._id} aria-pressed={selected === m._id} onclick={() => pick(m)}>{m.name}</button>
    {#if canEdit}<span class="hint">{m.script?.runAs ?? "legacy"} · {m.scriptState?.recent.length ?? 0} request(s)</span>
      <button type="button" aria-label={`Delete ${m.name}`} onclick={() => remove(m._id)}>×</button>{/if}
  </li>{/each}</ul>
  {#if chosen && (canEdit || chosen.script?.playerCallable)}
    <fieldset data-script-invoke><legend>Invoke {chosen.name}</legend>
      {#each formInputs as field (field.name)}
        {#if field.type === "boolean"}
          <label><input type="checkbox" checked={runArgs[field.name] === true} onchange={(e) => runArgs[field.name] = (e.target as HTMLInputElement).checked} />{field.name}</label>
        {:else if field.type === "token"}
          <label>{field.name} <select data-script-token-arg={field.name} value={String(runArgs[field.name] ?? "")}
            onchange={(e) => runArgs[field.name] = (e.target as HTMLSelectElement).value}>
              <option value="">{field.required ? "Select a visible token" : "No token"}</option>
              {#each inputScene?.tokens ?? [] as token (token._id)}
                <option value={token._id}>{token.name}</option>
              {/each}
            </select></label>
        {:else}
          <label>{field.name} <input type={field.type === "number" ? "number" : "text"} value={String(runArgs[field.name] ?? "")}
            placeholder={field.type} oninput={(e) => runArgs[field.name] = (e.target as HTMLInputElement).value} /></label>
        {/if}
      {/each}
      <button type="button" data-script-run disabled={!!pendingRun || !!pendingSave} onclick={() => invoke(chosen)}>Run saved script</button>
    </fieldset>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  {#if canEdit && response?.trace}<details open><summary>Host audit · {response.callerId} · {response.ok ? "completed" : "failed"}</summary>
    <ol>{#each response.trace as entry, i (i)}<li>{entry}</li>{/each}</ol>
    {#if response.result !== undefined}<pre>{JSON.stringify(response.result, null, 2)}</pre>{/if}
  </details>{/if}
</section>

<style>
  .scripts { display: grid; gap: 8px; font-size: .83rem; }
  header, .row, .grants, .inputs, fieldset { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  header { justify-content: space-between; } h3, h4 { margin: 0; }
  .hint { margin: 0; color: #aab6c6; }
  .warning { margin: 0; padding: 6px; border-left: 3px solid #e0b341; color: #efdab1; }
  label { display: inline-flex; gap: 5px; align-items: center; }
  .source { display: grid; width: 100%; } textarea { width: 100%; box-sizing: border-box; font: 12px/1.5 ui-monospace, monospace; background: #111824; color: #e7e9f0; border: 1px solid #606a81; }
  .inputs { display: grid; } .row { display: flex; } input:not([type="checkbox"]) { max-width: 160px; }
  .grants { padding: 6px; border: 1px solid #50586a; }
  .review { color: #efd49b; } .error { color: #ff9e9e; }
  ul { list-style: none; padding: 0; margin: 0; max-height: 125px; overflow: auto; }
  li { display: flex; align-items: center; gap: 8px; }
  fieldset { border: 1px solid #50586a; } details { max-height: 180px; overflow: auto; }
  pre { overflow: auto; white-space: pre-wrap; } button[aria-pressed="true"] { border-color: #e0b341; }
</style>
