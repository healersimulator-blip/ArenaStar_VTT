<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { workspaceUi } from "./state";
  export interface DirectoryItem { id: string; name: string; kind: string; detail?: string; hidden?: boolean }
  let { kind, items = [], onAction, onLayout, isGM = true }:
    { kind: string; items?: DirectoryItem[]; onAction: (action: string, id?: string) => void; onLayout: () => void; isGM?: boolean } = $props();
  let search = $state("");
  const visible = $derived(items.filter((item) => (item.name + " " + item.kind).toLowerCase().includes(search.toLowerCase())));
</script>
<section class="workspace-directory" data-workspace-directory={kind}>
  {#if kind === "settings"}
    <h3>{$workspaceUi.profile === "roll20" ? "My Settings" : "Game Settings"}</h3>
    <div class="settings-summary"><span class="summary-mark">✦</span><div><strong>ArenaStar VTT</strong><small>Your world stays local. Your UI stays yours.</small></div></div>
    <div class="directory-actions">
      <button type="button" onclick={() => onAction("settings")}><Icon name="settings" size={17}/>Configure settings</button>
      <button type="button" onclick={onLayout}><Icon name="layout" size={17}/>Workspace layout</button>
      {#if isGM}<button type="button" onclick={() => onAction("packages")}><Icon name="compendia" size={17}/>Manage packages & modules</button>
      <button type="button" onclick={() => onAction("permissions")}><Icon name="actors" size={17}/>Configure players</button>{/if}
      <button type="button" onclick={() => onAction("help")}><Icon name="help" size={17}/>Help & keyboard controls</button>
      {#if isGM}<button type="button" onclick={() => onAction("export")}><Icon name="export" size={17}/>Export world</button>{/if}
      <button type="button" onclick={() => onAction("session")}><Icon name="share" size={17}/>Session & invitation</button>
    </div>
  {:else}
    <div class="directory-top"><button type="button" onclick={() => onAction(kind === "macros" ? "macros" : "scenes")}><Icon name={kind === "macros" ? "macro" : "settings"} size={16}/>{kind === "macros" ? "Create / edit macro" : "Scene configuration"}</button></div>
    <label class="directory-search"><Icon name="search" size={16}/><input aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} bind:value={search}/></label>
    <p class="directory-count">{visible.length} {kind === "macros" ? "macros" : "scene objects"}</p>
    <ul>{#each visible as item (item.id)}<li>
      <button type="button" draggable={kind === "macros"}
        ondragstart={(event) => { if (kind === "macros") { event.dataTransfer?.setData("application/x-arenastar-macro", item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"; } }}
        onclick={() => onAction(kind === "macros" ? "macros" : "focus", item.id)} data-directory-item={item.id}>
        <span class="document-icon"><Icon name={kind === "macros" ? "macro" : item.kind} size={18}/></span>
        <span><strong>{item.name}</strong><small>{item.detail ?? item.kind}{item.hidden ? " · GM only" : ""}</small></span>
        <Icon name="chevronRight" size={12}/>
      </button>
    </li>{/each}</ul>
    {#if visible.length === 0}<div class="directory-empty"><Icon name={kind === "macros" ? "macro" : "placeables"} size={28}/><p>{search ? "No matching entries." : kind === "macros" ? "Create a macro, then drag it onto the hotbar." : "This scene has no placeables yet."}</p></div>{/if}
  {/if}
</section>
