<script lang="ts">
  import CloudBackupPanel from "./CloudBackupPanel.svelte";
  import type { CloudBackupController } from "../../storage/cloud/cloudBackup";
  import { onMount } from "svelte";
  import type { SaveCoordinator, SaveStatus } from "../../storage/saveCoordinator";

  let { saves, onBackup, onFolder = null, cloud = null }: {
    saves: SaveCoordinator;
    cloud?: CloudBackupController | null;
    onBackup: () => Promise<void>;
    onFolder?: (() => Promise<void>) | null;
  } = $props();
  let status = $state<SaveStatus | null>(null);
  let backupBusy = $state(false);
  let notice = $state("");
  onMount(() => saves.subscribe(next => { status = next; if (next.error) notice = ""; }));

  async function save() {
    notice = "";
    try { await saves.saveNow(); notice = "Saved on this device."; }
    catch { /* The persistent warning supplies recovery instructions, without a toast. */ }
  }
  async function backup(folder: boolean) {
    backupBusy = true;
    try { await (folder ? onFolder?.() : onBackup()); }
    finally { backupBusy = false; }
  }
</script>

<section class="saves" aria-label="Saves and backups">
  <h3>Saves & backups</h3>
  <p>Your world saves automatically on this GM device, including players’ permitted changes. No approvals needed.</p>
  <div class="save-row">
    <button type="button" data-save-now disabled={status?.saving} onclick={save}>
      {status?.saving ? "Saving…" : "Save now"}
    </button>
    <span data-save-status>
      {#if status?.error}Saving needs attention
      {:else if status?.lastSavedAt}Last saved {new Date(status.lastSavedAt).toLocaleTimeString()}
      {:else}Autosave is on{/if}
    </span>
  </div>
  {#if status?.error}
    <p class="save-error">Could not finish saving. Keep this world open, check available storage, then retry Save now. {status.error}</p>
  {/if}
  <span class="notice" role="status">{notice}</span>
  <details>
    <summary>Backups & portability</summary>
    <p>Local saves are not an off-device backup. Download a complete world ZIP regularly, especially before changing browser or device. Restore it from the start screen’s Open file option.</p>
    <div class="save-row">
      <button type="button" disabled={backupBusy || status?.saving} onclick={() => backup(false)}>Download world backup</button>
      {#if onFolder}<button type="button" disabled={backupBusy || status?.saving} onclick={() => backup(true)}>Save to folder…</button>{/if}
    </div>
    {#if cloud}<CloudBackupPanel {cloud} />{/if}
    <p class="hint">Backups include stored media subject to export permissions. Linked online media still needs its source. All chat and action history is kept; nothing is automatically deleted.</p>
  </details>
</section>

<style>
  .saves { margin-bottom: 16px; padding: 12px; border: 1px solid #465466; border-radius: 8px; }
  h3 { margin: 0 0 8px; }
  p { line-height: 1.45; margin: 8px 0; }
  .save-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  button { padding: 8px 12px; min-height: 40px; cursor: pointer; }
  button:disabled { cursor: wait; }
  summary { cursor: pointer; padding: 8px 0; }
  .save-error { color: #ffb9b9; }
  .hint, [data-save-status] { color: #bac8d8; font-size: .85rem; }
  .notice { display: block; min-height: 1.4em; font-size: .85rem; }
</style>
