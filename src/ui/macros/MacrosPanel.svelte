<script lang="ts">
  /**
   * §10 macros (GM window) — chat macros with hotbar slot assignment.
   * `flags.core.slot` (1-5) binds a macro to a hotbar key; running a chat
   * macro goes through the pure chat core (buildChatMessage). Reviewed script
   * macros use a separate host-run Worker with action grants and typed inputs.
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { MacroDocument } from "../../core/documents";
  import { runChatMacro } from "./run";
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
    onPickSummon?: RequestSummonPick | null;
    /** GM-local canvas picking/rendering for the FX tab; null on a player shell. */
    onPickAnchor?: RequestCrosshairPick | null;
    onPreviewFx?: PreviewFxSequence | null;
    onStopFxPreview?: (() => void) | null;
  } = $props();
  let tab = $state<"chat" | "fx" | "assets" | "manager" | "zones" | "tags" | "prefabs" | "summons" | "scripts">("chat");
  let pickedAsset = $state<{ hash: string } | null>(null);

  function useAsset(hash: string): void {
    pickedAsset = { hash }; // a fresh object applies even when choosing the same file twice
    tab = "fx";
  }
  let viewerRole = $state("");
  const gm = $derived(viewerRole === "GM" || viewerRole === "ASSISTANT");

  let macros = $state<MacroDocument[]>([]);
  let name = $state("");
  let command = $state("");

  function refresh(): void {
    viewerRole = client.user?.role ?? "";
    if (viewerRole !== "GM" && viewerRole !== "ASSISTANT" && tab !== "summons") tab = "scripts";
    macros = [...(client.store.getAll("macros") as readonly MacroDocument[])].filter((m) => m.kind === "chat");
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

  function slotOf(m: MacroDocument): number {
    const core = (m.flags as { core?: { slot?: unknown } }).core;
    return typeof core?.slot === "number" ? core.slot : 0;
  }

  function runMacro(m: MacroDocument): void {
    runChatMacro(client, m);
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
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
    <AutomationPanel {client} {bus} />
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
  .name {
    flex: 1;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
