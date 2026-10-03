<script lang="ts">
  /**
   * §10 macros (GM window) — chat macros with hotbar slot assignment.
   * `flags.core.slot` (1-5) binds a macro to a hotbar key; running a chat
   * macro goes through the pure chat core (buildChatMessage). Reviewed script
   * macros use a separate host-run Worker with action grants and typed inputs.
   */
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MacroDocument } from "../../core/documents";
  import { macroResultText, macroSelectionOf, runChatMacro, runSavedMacro } from "./run";
  import {
    MACRO_COMPOSITE_LIMITS,
    macroCompositeDocumentError,
    macroCompositeMacroIds,
  } from "../../core/macroComposite";
  import { macroAutomationGraphId, macroAutomationInputs } from "../../core/macroAutomation";
  import { bindMacroArgFields, macroArgSchemaError, type MacroArgInput } from "../../core/macroArgs";
  import TaggerPanel from "./TaggerPanel.svelte";
  import FxSequencePanel from "./FxSequencePanel.svelte";
  import type { RequestCrosshairPick } from "./crosshairPicker";
  import type { PreviewFxSequence } from "./fxPreview";
  import FxAssetBrowserPanel from "./FxAssetBrowserPanel.svelte";
  import FxManagerPanel from "./FxManagerPanel.svelte";
  import AutomationPanel from "./AutomationPanel.svelte";
  import PrefabPanel from "./PrefabPanel.svelte";
  import SummonsPanel from "./SummonsPanel.svelte";
  import type { CompendiumPack } from "../../core/compendium";
  import type { RequestSummonPick } from "./summonPicker";
  import ScriptMacroPanel from "./ScriptMacroPanel.svelte";
  import type { AssetManifest } from "../../core/documents";
  import type { FxImportPermissions } from "../../core/fx";

  let {
    client,
    bus,
    onFxImport = null,
    listFxAssets = null,
    setFxAssetRights = null,
    getFxAsset = null,
    listCompendia = null,
    activeSceneId = null,
    selectedTokenId = null,
    onPickSummon = null,
    onPickAnchor = null,
    onPreviewFx = null,
    onStopFxPreview = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onFxImport?: ((file: File, permissions: FxImportPermissions) => Promise<{ hash: string; mime: string; name: string }>) | null;
    listFxAssets?: (() => Promise<AssetManifest>) | null;
    setFxAssetRights?: ((hash: string, permissions: FxImportPermissions) => Promise<void>) | null;
    getFxAsset?: ((hash: string) => Promise<Uint8Array | undefined>) | null;
    listCompendia?: (() => Promise<Array<{ packageId: string; packFile: string; pack: CompendiumPack }>>) | null;
    activeSceneId?: string | null;
    /** D-388: the caller's single selected token, the default for a `from:"selected"` input. */
    selectedTokenId?: string | null;
    onPickSummon?: RequestSummonPick | null;
    /** GM-local canvas picking/rendering for the FX tab; null on a player shell. */
    onPickAnchor?: RequestCrosshairPick | null;
    onPreviewFx?: PreviewFxSequence | null;
    onStopFxPreview?: (() => void) | null;
  } = $props();
  let tab = $state<"chat" | "fx" | "assets" | "manager" | "zones" | "tags" | "prefabs" | "summons" | "scripts" | "automations">("chat");
  let pickedAsset = $state<{ hash: string } | null>(null);

  function useAsset(hash: string): void {
    pickedAsset = { hash }; // a fresh object applies even when choosing the same file twice
    tab = "fx";
  }
  let viewerRole = $state("");
  const gm = $derived(viewerRole === "GM" || viewerRole === "ASSISTANT");

  let macros = $state<MacroDocument[]>([]);
  /** TR-12/MC-01: a macro that runs one saved graph. The binding stays with the host. */
  let automationMacros = $state<MacroDocument[]>([]);
  /** MC-01 (D-386): macros that run several automation macros, in order. */
  let compositeMacros = $state<MacroDocument[]>([]);
  let compositeEditing = $state("");
  let compositeName = $state("");
  let compositeChildren = $state<string[]>([]);
  let compositeError = $state("");
  /** MC-02: the declared-input editor (GM) and the value form a caller fills in to run. */
  let inputEditing = $state("");
  let inputDraft = $state<MacroArgInput[]>([]);
  /** The caller's live selection: what a `from: "selected"` input defaults to. */
  const callerSelection = $derived(macroSelectionOf(client, selectedTokenId));
  let inputError = $state("");
  let runEditing = $state("");
  let runValues = $state<Record<string, string>>({});
  let runError = $state("");
  let macroStatus = $state("");
  /** Request ids whose result should surface here; the host answers each one once. */
  const pendingInvokes = new SvelteSet<string>();
  let name = $state("");
  let command = $state("");

  function refresh(): void {
    viewerRole = client.user?.role ?? "";
    if (viewerRole !== "GM" && viewerRole !== "ASSISTANT" && tab !== "summons") tab = "scripts";
    macros = [...(client.store.getAll("macros") as readonly MacroDocument[])].filter((m) => m.kind === "chat");
    automationMacros = [...(client.store.getAll("macros") as readonly MacroDocument[])].filter((m) => m.kind === "automation");
    compositeMacros = [...(client.store.getAll("macros") as readonly MacroDocument[])].filter((m) => m.kind === "composite");
  }

  function create(): void {
    if (!command.trim()) return;
    const doc: MacroDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "macro",
      name: name.trim() || command.slice(0, 20),
      ownership: { default: 1 },
      flags: {},
      system: {},
      kind: "chat",
      command: command.trim(),
    };
    client.submit([{ kind: "create", coll: "macros", data: doc }]);
    name = "";
    command = "";
  }

  function assignSlot(m: MacroDocument, slot: number): void {
    client.submit([
      {
        kind: "update",
        ref: { coll: "macros", id: m._id },
        diff: {
          flags:
            slot > 0
              ? { ...(m.flags as object), core: { ...(m.flags as { core?: object }).core, slot } }
              : {},
        },
      },
    ]);
  }

  function remove(id: string): void {
    client.submit([{ kind: "delete", ref: { coll: "macros", id } }]);
  }

  /** Start a fresh composite (or load one back into the editor for an update). */
  function editComposite(macro: MacroDocument | null): void {
    compositeError = "";
    compositeEditing = macro?._id ?? "";
    compositeName = macro?.name ?? "";
    compositeChildren = macro ? [...(macroCompositeMacroIds(macro) ?? [])] : [];
  }

  function addCompositeChild(): void {
    // The first child not already chosen — a composite runs each macro once.
    const next = automationMacros.find((m) => !compositeChildren.includes(m._id));
    if (!next) { compositeError = "Every saved automation macro is already in this composite."; return; }
    if (compositeChildren.length >= MACRO_COMPOSITE_LIMITS.children) {
      compositeError = `A composite runs at most ${MACRO_COMPOSITE_LIMITS.children} macros.`;
      return;
    }
    compositeChildren = [...compositeChildren, next._id];
    compositeError = "";
  }

  function setCompositeChild(index: number, id: string): void {
    if (compositeChildren.includes(id) && compositeChildren[index] !== id) {
      compositeError = "A composite runs each macro once.";
      return;
    }
    compositeChildren = compositeChildren.map((current, i) => (i === index ? id : current));
    compositeError = "";
  }

  function removeCompositeChild(index: number): void {
    compositeChildren = compositeChildren.filter((_, i) => i !== index);
    compositeError = "";
  }

  function saveComposite(): void {
    compositeError = "";
    const doc: MacroDocument = { _id: compositeEditing || globalThis.crypto.randomUUID(),
      type: "macro", name: compositeName.trim(), ownership: { default: 1 }, flags: {}, system: {},
      kind: "composite", command: "", composite: { macroIds: [...compositeChildren] } };
    const problem = macroCompositeDocumentError(doc);
    if (problem) { compositeError = problem; return; }
    if (compositeChildren.some((id) => !automationMacros.some((m) => m._id === id))) {
      compositeError = "A composite may only run saved automation macros.";
      return;
    }
    if (compositeEditing) {
      client.submit([{ kind: "update", ref: { coll: "macros", id: compositeEditing },
        diff: { name: doc.name, composite: doc.composite as never } }]);
      macroStatus = `Requested an update to composite "${doc.name}"`;
    } else {
      client.submit([{ kind: "create", coll: "macros", data: doc }]);
      macroStatus = `Published composite "${doc.name}" — run it from this tab, a hotbar slot or /run`;
    }
    editComposite(null);
  }

  /** MC-02: declare the typed inputs a caller may send (stored on the macro's binding). */
  function editInputs(macro: MacroDocument): void {
    inputError = "";
    inputEditing = inputEditing === macro._id ? "" : macro._id;
    inputDraft = macroAutomationInputs(macro).map((field) => ({ ...field }));
  }

  function saveInputs(macro: MacroDocument): void {
    inputError = "";
    const graphId = macroAutomationGraphId(macro);
    if (!graphId) { inputError = "This macro has no graph binding."; return; }
    const problem = macroArgSchemaError($state.snapshot(inputDraft));
    if (problem) { inputError = problem; return; }
    const inputs = $state.snapshot(inputDraft).map((field) => ({ name: field.name, type: field.type,
      ...(field.required ? { required: true as const } : {}),
      ...(field.from === "selected" ? { from: "selected" as const } : {}) }));
    client.submit([{ kind: "update", ref: { coll: "macros", id: macro._id },
      diff: { automation: { graphId, ...(inputs.length > 0 ? { inputs } : {}) } as never } }]);
    macroStatus = inputs.length > 0
      ? `Declared ${inputs.length} input(s) on ${macro.name}`
      : `Cleared ${macro.name}'s declared inputs`;
    inputEditing = "";
  }

  /** The caller's value form for a macro that declares inputs. */
  function editRun(macro: MacroDocument): void {
    runError = "";
    if (runEditing === macro._id) { runEditing = ""; return; }
    runEditing = macro._id;
    runValues = Object.fromEntries(macroAutomationInputs(macro).map((field) => [field.name, ""]));
  }

  function runWithInputs(macro: MacroDocument): void {
    runError = "";
    // A blank field is "not spelled out": a `from: "selected"` input then takes the caller's
    // selection and a required one is refused with the local reason.
    const bound = bindMacroArgFields(macroAutomationInputs(macro), runValues, callerSelection);
    if (!bound.ok) { runError = bound.error; return; }
    const outcome = runSavedMacro(client, macro, bound.args);
    if (!outcome.ok) { runError = outcome.error ?? "that macro cannot run here"; return; }
    if (outcome.requestId) pendingInvokes.add(outcome.requestId);
    macroStatus = `Requested ${macro.name}…`;
    runEditing = "";
  }

  function childName(id: string): string {
    return automationMacros.find((m) => m._id === id)?.name ?? "(missing macro)";
  }

  function slotOf(m: MacroDocument): number {
    const core = (m.flags as { core?: { slot?: unknown } }).core;
    return typeof core?.slot === "number" ? core.slot : 0;
  }

  function runMacro(m: MacroDocument): void {
    if (m.kind !== "automation" && m.kind !== "composite") { runChatMacro(client, m); return; }
    // A macro that declares inputs asks for them first — never a silent default.
    if (m.kind === "automation" && macroAutomationInputs(m).length > 0) { editRun(m); return; }
    macroStatus = `Requested ${m.name}…`;
    pendingInvokes.add(client.invokeMacro(m._id));
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offResult = bus.on("macroResult", (msg) => {
      if (!pendingInvokes.has(msg.requestId)) return;
      pendingInvokes.delete(msg.requestId);
      macroStatus = macroResultText(msg);
    });
    refresh();
    return () => {
      offSnapshot();
      offOps();
      offResult();
    };
  });
</script>

<div class="macros">
  <nav aria-label="Macros and FX wizard sections">
    {#if gm}
      <button type="button" aria-pressed={tab === "chat"} onclick={() => tab = "chat"}>Chat macros</button>
      <button type="button" data-macro-fx-tab aria-pressed={tab === "fx"} onclick={() => tab = "fx"}>FX timelines</button>
      <button type="button" data-macro-assets-tab aria-pressed={tab === "assets"} onclick={() => tab = "assets"}>Assets / preview</button>
      <button type="button" data-macro-fx-manager-tab aria-pressed={tab === "manager"} onclick={() => tab = "manager"}>Live FX</button>
      <button type="button" data-macro-zones-tab aria-pressed={tab === "zones"} onclick={() => tab = "zones"}>Active zones</button>
      <button type="button" data-macro-tags-tab aria-pressed={tab === "tags"} onclick={() => tab = "tags"}>Tags</button>
      <button type="button" data-macro-prefabs-tab aria-pressed={tab === "prefabs"} onclick={() => tab = "prefabs"}>Prefabs</button>
    {/if}
    <button type="button" data-macro-summons-tab aria-pressed={tab === "summons"} onclick={() => tab = "summons"}>Summons</button>
    <button type="button" data-macro-script-tab aria-pressed={tab === "scripts"} onclick={() => tab = "scripts"}>Script macros</button>
    <button type="button" data-macro-automations-tab aria-pressed={tab === "automations"} onclick={() => tab = "automations"}>Automation macros</button>
  </nav>
  <div class="tab-page" hidden={tab !== "chat"}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      create();
    }}
  >
    <input data-macro-name type="text" bind:value={name} placeholder="Name" />
    <input
      data-macro-command
      type="text"
      bind:value={command}
      placeholder="/me waves — or hello [[1d6]]"
    />
    <button data-macro-create type="submit">Create</button>
  </form>
  <ul>
    {#each macros as m (m._id)}
      <li data-macro={m._id}>
        <span class="name" title={m.command}>{m.name}</span>
        <select
          data-macro-slot
          value={slotOf(m)}
          aria-label={`Hotbar slot for ${m.name}`}
          onchange={(e) => assignSlot(m, Number((e.target as HTMLSelectElement).value))}
        >
          <option value={0}>—</option>
          {#each [1, 2, 3, 4, 5] as s (s)}
            <option value={s}>{s}</option>
          {/each}
        </select>
        <button data-macro-run type="button" onclick={() => runMacro(m)}>Run</button>
        <button type="button" onclick={() => remove(m._id)}>✕</button>
      </li>
    {/each}
  </ul>
  </div>
  <div class="tab-page" hidden={tab !== "fx"}>
    <FxSequencePanel {client} {bus} onImport={onFxImport} listAssets={listFxAssets}
      onAssetRights={setFxAssetRights} {pickedAsset} {activeSceneId} {onPickAnchor}
      onPreview={onPreviewFx} onStopPreview={onStopFxPreview} />
  </div>
  <div class="tab-page" hidden={tab !== "assets"}>
    {#if gm}<FxAssetBrowserPanel {client} {bus} getAsset={getFxAsset} {useAsset} />{/if}
  </div>
  <div class="tab-page" hidden={tab !== "manager"}>
    <FxManagerPanel {client} {bus} />
  </div>
  <div class="tab-page" hidden={tab !== "zones"}>
    <AutomationPanel {client} {bus} getAsset={getFxAsset} />
  </div>
  <div class="tab-page" hidden={tab !== "tags"}>
    <TaggerPanel {client} {bus} />
  </div>
  <div class="tab-page" hidden={tab !== "prefabs"}>
    <PrefabPanel {client} {bus} />
  </div>
  <div class="tab-page" hidden={tab !== "summons"}>
    <SummonsPanel {client} {bus} {listCompendia} {activeSceneId} {onPickSummon} />
  </div>
  <div class="tab-page" hidden={tab !== "scripts"}>
    <ScriptMacroPanel {client} {bus} />
  </div>
  <div class="tab-page" hidden={tab !== "automations"}>
    <ul>
      {#each automationMacros as m (m._id)}
        <li data-automation-macro={m._id}>
          <span class="name">{m.name}</span>
          {#if gm}
            <select
              data-macro-slot
              value={slotOf(m)}
              aria-label={`Hotbar slot for ${m.name}`}
              onchange={(e) => assignSlot(m, Number((e.target as HTMLSelectElement).value))}
            >
              <option value={0}>—</option>
              {#each [1, 2, 3, 4, 5] as s (s)}
                <option value={s}>{s}</option>
              {/each}
            </select>
            <button type="button" onclick={() => remove(m._id)}>✕</button>
          {/if}
          {#if gm}
            <button type="button" data-automation-inputs={m._id} onclick={() => editInputs(m)}>
              Inputs{macroAutomationInputs(m).length > 0 ? ` (${macroAutomationInputs(m).length})` : ""}
            </button>
          {/if}
          <button data-automation-macro-run type="button" onclick={() => runMacro(m)}>Run</button>
        </li>
        {#if inputEditing === m._id}
          <li class="inputs-editor" data-automation-inputs-editor={m._id}>
            {#each inputDraft as field, i (i)}
              <input value={field.name} aria-label={`Input ${i + 1} name`} maxlength={32}
                onchange={(e) => { inputDraft = inputDraft.map((f, at) => at === i ? { ...f, name: e.currentTarget.value } : f); }} />
              <select value={field.type} aria-label={`Input ${i + 1} type`}
                onchange={(e) => { inputDraft = inputDraft.map((f, at) => at === i
                  ? { ...f, type: e.currentTarget.value as MacroArgInput["type"] } : f); }}>
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="token">token</option>
                <option value="actor">actor</option>
              </select>
              <label><input type="checkbox" checked={field.required ?? false}
                aria-label={`Input ${i + 1} required`}
                onchange={(e) => { inputDraft = inputDraft.map((f, at) => at === i
                  ? (e.currentTarget.checked ? { ...f, required: true } : { name: f.name, type: f.type }) : f); }} /> req</label>
              <label><input type="checkbox" checked={field.from === "selected"}
                disabled={field.type !== "token" && field.type !== "actor"}
                aria-label={`Input ${i + 1} from selection`}
                onchange={(e) => { inputDraft = inputDraft.map((f, at) => at === i
                  ? (e.currentTarget.checked ? { ...f, from: "selected" } : { name: f.name, type: f.type }) : f); }} /> selected</label>
              <button type="button" aria-label={`Remove input ${i + 1}`}
                onclick={() => { inputDraft = inputDraft.filter((_, at) => at !== i); }}>✕</button>
            {/each}
            <button type="button" data-automation-input-add disabled={inputDraft.length >= 16}
              onclick={() => { inputDraft = [...inputDraft, { name: `arg${inputDraft.length + 1}`, type: "string" }]; }}>Add input</button>
            <button type="button" data-automation-input-save onclick={() => saveInputs(m)}>Save inputs</button>
            {#if inputError}<small data-automation-input-error role="alert">{inputError}</small>{/if}
          </li>
        {/if}
        {#if runEditing === m._id}
          <li class="inputs-editor" data-automation-run-editor={m._id}>
            {#each macroAutomationInputs(m) as field (field.name)}
              <label>{field.name}{field.required ? " *" : ""}
                {#if field.type === "boolean"}
                  <select aria-label={field.name} onchange={(e) => { runValues = { ...runValues, [field.name]: e.currentTarget.value }; }}>
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                {:else}
                  <input aria-label={field.name}
                    placeholder={field.from === "selected" ? "selected token" : field.type}
                    oninput={(e) => { runValues = { ...runValues, [field.name]: e.currentTarget.value }; }} />
                {/if}
              </label>
            {/each}
            <button type="button" data-automation-run-with onclick={() => runWithInputs(m)}>Run</button>
            {#if macroAutomationInputs(m).some((field) => field.from === "selected")}
              <small data-automation-run-selected>
                {callerSelection ? "a blank selection field uses your selected token" : "select a token for the blank fields"}
              </small>
            {/if}
            {#if runError}<small data-automation-run-error role="alert">{runError}</small>{/if}
          </li>
        {/if}
      {/each}
    </ul>
    {#if automationMacros.length === 0}
      <small>No automation macros yet — a GM publishes one from a saved graph in Active zones.</small>
    {/if}
    <hr />
    <h4>Composites</h4>
    <ul>
      {#each compositeMacros as m (m._id)}
        <li data-composite-macro={m._id}>
          <span class="name">{m.name}</span>
          <small data-composite-children>{macroCompositeMacroIds(m)?.length ?? 0} macro(s)</small>
          {#if gm}
            <button type="button" data-composite-edit onclick={() => editComposite(m)}>Edit</button>
            <button type="button" onclick={() => remove(m._id)}>✕</button>
          {/if}
          <button data-composite-run type="button" onclick={() => runMacro(m)}>Run</button>
        </li>
      {/each}
    </ul>
    {#if compositeMacros.length === 0}
      <small>No composites yet — a composite runs several automation macros in order.</small>
    {/if}
    {#if gm}
      <div class="composite-editor" data-composite-editor>
        <input bind:value={compositeName} data-composite-name
          aria-label="Composite name" placeholder="Composite name" maxlength={MACRO_COMPOSITE_LIMITS.name} />
        <ol data-composite-children-list>
          {#each compositeChildren as id, i (i)}
            <li>
              <select data-composite-child value={id} aria-label={`Macro ${i + 1}`}
                onchange={(e) => setCompositeChild(i, e.currentTarget.value)}>
                {#each automationMacros as child (child._id)}
                  <option value={child._id}>{child.name}</option>
                {/each}
              </select>
              <small>#{i + 1} · {childName(id)}</small>
              <button type="button" aria-label={`Remove macro ${i + 1}`}
                onclick={() => removeCompositeChild(i)}>✕</button>
            </li>
          {/each}
        </ol>
        <div class="row">
          <button type="button" data-composite-add onclick={addCompositeChild}
            disabled={compositeChildren.length >= MACRO_COMPOSITE_LIMITS.children}>Add macro</button>
          <button type="button" data-composite-save onclick={saveComposite}>
            {compositeEditing ? "Update composite" : "Create composite"}
          </button>
          {#if compositeEditing}<button type="button" onclick={() => editComposite(null)}>Cancel</button>{/if}
        </div>
        <small data-composite-hint>Runs {MACRO_COMPOSITE_LIMITS.minimum}–{MACRO_COMPOSITE_LIMITS.children} automation macros in order, each in its own undo step.</small>
        {#if compositeError}<small data-composite-error role="alert">{compositeError}</small>{/if}
      </div>
    {/if}
    {#if macroStatus}<small data-automation-status role="status">{macroStatus}</small>{/if}
  </div>
</div>

<style>
  .macros {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  nav, form {
    display: flex;
    gap: 4px;
  }
  nav button[aria-pressed="true"] { border-color: #e0b341; color: #e0b341; }
  .tab-page[hidden] { display: none; }
  form input {
    flex: 1;
    min-width: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 0.875rem;
    text-transform: uppercase;
  }
  hr {
    border: 0;
    border-top: 1px solid #344957;
    margin: 4px 0;
  }
  .composite-editor {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .inputs-editor {
    flex-wrap: wrap;
    background: #16222c;
    padding: 4px;
    border-radius: 3px;
  }
  .composite-editor .row {
    display: flex;
    gap: 4px;
  }
  .composite-editor ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .composite-editor ol li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name {
    flex: 1;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
