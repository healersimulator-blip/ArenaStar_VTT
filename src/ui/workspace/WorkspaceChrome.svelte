<script lang="ts">
  import { workspaceUi } from "./state";
  import Icon from "../icons/Icon.svelte";
  import { isTypingTarget } from "../../core/keys";
  export interface WorkspaceAction { id: string; label: string; icon: string; run: () => void; disabled?: boolean }
  let { worldName, sceneName, seq, tokenCount, actions, isGM = true, connected = true, statusId = "status", rulesStatus = "", onLayout, onPages, onInvite = null, onAppearance = null }:
    { worldName: string; sceneName: string; seq: number; tokenCount: number; actions: WorkspaceAction[]; isGM?: boolean; connected?: boolean;
      statusId?: string; rulesStatus?: string; onLayout: () => void; onPages?: (() => void) | undefined; onInvite?: (() => void) | null; onAppearance?: (() => void) | null } = $props();
  let menu = $state(false), searching = $state(false), query = $state("");
  const modernPrimary = new Set(["add-token", "gm-undo", "gm-redo", "gm-macros", "gm-settings", "export-world", "player-macros", "player-handouts", "player-setup"]);
  const visible = $derived(actions.filter((action) => $workspaceUi.profile === "modern" && modernPrimary.has(action.id)));
  const menuActions = $derived(actions.filter((action) => !visible.includes(action)));
  const results = $derived(actions.filter((action) => action.label.toLowerCase().includes(query.toLowerCase())));
  function onKey(event: KeyboardEvent) {
    if (document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); searching = !searching; menu = false;
    } else if (event.key === "Escape") {
      if (menu || searching) { event.preventDefault(); menu = false; searching = false; }
      else if ($workspaceUi.profile === "foundry" && !isTypingTarget(event.target) &&
        !document.querySelector("[data-tool-options], [data-token-menu], .wm-window, [data-session-panel]")) menu = true;
    }
  }
</script>

<svelte:window onkeydown={onKey} />
<header class="workspace-chrome app-header" data-workspace-chrome>
  <div class="chrome-world">
    <button class="wordmark" type="button" aria-label="Main menu" title="ArenaStar menu" data-workspace-menu
      aria-expanded={menu} onclick={() => { menu = !menu; searching = false; }}><span class="modern-mark">a<span>✦</span></span><Icon name="menu" /></button>
    <div class="chrome-title"><span class="product-name">ARENASTAR</span><h1 title={worldName}>{worldName}</h1></div>
    <span class="world-divider"></span>
    <button class="scene-crumb" type="button" data-workspace-pages title="Scenes and pages" onclick={() => onPages?.()}><Icon name="scenes" size={15} /><span>{sceneName || "Your tabletop"}</span><Icon name="chevronDown" size={13} /></button>
  </div>
  <div class="chrome-center"><button class="command-trigger" type="button" aria-label="Find a tool or command" onclick={() => { searching = !searching; menu = false; }}><Icon name="search" size={15} /><span>Find a tool…</span><kbd>⌘ K</kbd></button></div>
  <div class="chrome-utilities">
    <div id={statusId} class="workspace-status" aria-live="polite"><span class="online-dot"></span><span>{isGM ? "GM" : connected ? "Connected" : "Disconnected"}</span>{#if rulesStatus}<span class="rules-status" data-rules-status title="Strategic ruleset — applies to strategic-scale scenes; tactical scenes are heroes only">{rulesStatus}</span>{/if}<span class="sr-only">{worldName}. seq {seq} · tokens {tokenCount}</span></div>
    <div class="chrome-primary">
      {#each visible as action (action.id)}<button id={action.id} data-player-macros={action.id === "player-macros" ? true : undefined} data-player-handouts={action.id === "player-handouts" ? true : undefined} data-player-setup={action.id === "player-setup" ? true : undefined} data-icon-button type="button" class="chrome-action" aria-label={action.label} title={action.label} disabled={action.disabled} onclick={action.run}><Icon name={action.icon} size={17} /></button>{/each}
    </div>
    {#if onAppearance}<button id={isGM ? "gm-appearance" : "player-appearance"} data-icon-button type="button" class="chrome-action appearance-trigger" aria-label="Interface appearance" title="Interface appearance" onclick={onAppearance}><Icon name="palette" size={17} /></button>{/if}
    <button id={isGM ? "gm-workspace" : "player-workspace"} data-icon-button type="button" class="workspace-trigger" aria-label="Choose workspace" title="Choose workspace" onclick={onLayout}><Icon name="layout" size={18} /></button>
    {#if onInvite}<button id="share" class="chrome-invite" type="button" aria-label="Invite players" title="Invite players" onclick={onInvite}><Icon name="share" size={16} /><span>Invite</span></button>{/if}
  </div>
  {#if menu}
    <div class="workspace-menu" role="menu" aria-label="ArenaStar menu" data-workspace-menu-panel>
      <div class="menu-product">ArenaStar <span>{isGM ? "Game master" : "Player"}</span></div>
      {#each menuActions as action (action.id)}<button id={action.id} data-player-macros={action.id === "player-macros" ? true : undefined} data-player-handouts={action.id === "player-handouts" ? true : undefined} data-player-setup={action.id === "player-setup" ? true : undefined} role="menuitem" type="button" disabled={action.disabled} onclick={() => { menu = false; action.run(); }}><Icon name={action.icon} size={17} /><span>{action.label}</span></button>{/each}
      {#if onInvite}<button role="menuitem" type="button" onclick={() => { menu = false; onInvite?.(); }}><Icon name="share" size={17}/>Invite players</button>{/if}
      <div class="menu-separator"></div>
      <button role="menuitem" type="button" onclick={() => { menu = false; onLayout(); }}><Icon name="layout" size={17} /> Workspace layout</button>
      {#if onAppearance}<button role="menuitem" type="button" onclick={() => { menu = false; onAppearance?.(); }}><Icon name="palette" size={17} /> Interface appearance</button>{/if}
      <button role="menuitem" type="button" onclick={() => { menu = false; searching = true; }}><Icon name="search" size={17} /> Find a command <kbd>Ctrl K</kbd></button>
    </div>
  {/if}
  {#if searching}
    <div class="command-palette" role="dialog" aria-label="Command search" data-command-palette>
      <div class="command-field"><Icon name="search" size={18} /><input aria-label="Search commands" placeholder="Search tools and commands…" bind:value={query} /><button aria-label="Close command search" onclick={() => searching = false}><Icon name="x" size={16}/></button></div>
      <div class="command-results">{#each results as action (action.id)}<button type="button" disabled={action.disabled} onclick={() => { searching = false; query = ""; action.run(); }}><Icon name={action.icon} size={17} /><span>{action.label}</span><span class="enter">↵</span></button>{/each}
      {#if results.length === 0}<p>No matching command.</p>{/if}</div>
    </div>
  {/if}
</header>
