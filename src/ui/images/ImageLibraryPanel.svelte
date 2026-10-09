<script lang="ts">
  import type { ClientSync, AssetLibraryItem } from "../../client/sync";

  /**
   * §6.8 GM-only library: lists stored images, downloads them, and runs the confirmed clean-up of
   * images that no live document or undo step still uses. Players never see this panel.
   */
  let {
    client,
    fetchAsset,
  }: {
    client: ClientSync;
    fetchAsset?: (hash: string) => Promise<Uint8Array>;
  } = $props();

  const isGm = $derived(client.user?.role === "GM");
  let items = $state<AssetLibraryItem[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let confirming = $state(false);
  let status = $state("");
  let error = $state("");
  let filter = $state<"all" | "unused" | "inUse">("all");

  const unused = $derived(items.filter((item) => !item.inUse));
  const unusedBytes = $derived(unused.reduce((sum, item) => sum + item.size, 0));
  const visible = $derived(items.filter((item) =>
    filter === "all" ? true : filter === "unused" ? !item.inUse : item.inUse));

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function load(): Promise<void> {
    if (!isGm) return;
    busy = true;
    error = "";
    try {
      items = await client.requestAssetLibrary();
      loaded = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function download(item: AssetLibraryItem): Promise<void> {
    if (!fetchAsset) return;
    error = "";
    try {
      const bytes = await fetchAsset(item.hash);
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: item.mime }));
      const link = document.createElement("a");
      link.href = url;
      link.download = item.name || "image";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      error = `Could not download ${item.name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function cleanUp(): Promise<void> {
    if (unused.length === 0) return;
    busy = true;
    error = "";
    status = "";
    try {
      const result = await client.requestAssetCleanup(unused.map((item) => item.hash));
      const parts = [`Removed ${result.removed.length} unused image${result.removed.length === 1 ? "" : "s"} (${formatBytes(result.bytes)}).`];
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped because they are in use now.`);
      status = parts.join(" ");
      confirming = false;
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

{#if isGm}
  <section class="library" aria-label="Stored image library">
    <header>
      <div>
        <h4>Stored images</h4>
        <p>Images that no scene, token, journal, or undo step uses can be removed. Download first if you want to keep a copy.</p>
      </div>
      <button type="button" onclick={load} disabled={busy}>{loaded ? "Refresh" : "Load library"}</button>
    </header>

    {#if loaded}
      <p class="summary">{items.length} stored · {unused.length} unused ({formatBytes(unusedBytes)})</p>
      <label>Show
        <select bind:value={filter}>
          <option value="all">All images</option>
          <option value="unused">Unused only</option>
          <option value="inUse">In use only</option>
        </select>
      </label>
      <ul class="items" aria-label="Stored images">
        {#each visible as item (item.hash)}
          <li data-library-item data-in-use={item.inUse ? "yes" : "no"}>
            <span class="name" title={item.hash}>{item.name}</span>
            <span class="meta">{item.mime} · {formatBytes(item.size)}{item.derived ? " · variant" : ""}</span>
            <span class="state" class:unused={!item.inUse}>{item.inUse ? "In use" : "Unused"}</span>
            {#if fetchAsset}<button type="button" onclick={() => download(item)} disabled={busy}>Download</button>{/if}
          </li>
        {:else}
          <li class="empty">No images in this view.</li>
        {/each}
      </ul>

      {#if !confirming}
        <button type="button" class="danger" onclick={() => { confirming = true; status = ""; }} disabled={busy || unused.length === 0}>
          Clean up unused images…
        </button>
      {:else}
        <div class="confirm" role="alertdialog" aria-label="Confirm clean-up">
          <p>Delete {unused.length} unused image{unused.length === 1 ? "" : "s"} ({formatBytes(unusedBytes)})? This cannot be undone: Undo can no longer bring these images back.</p>
          <div class="row">
            <button type="button" class="danger" onclick={cleanUp} disabled={busy}>Delete unused images</button>
            <button type="button" onclick={() => { confirming = false; }} disabled={busy}>Cancel</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if status}<p class="ok" role="status">{status}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .library { display:flex; flex-direction:column; gap:8px; border:1px solid #303944; border-radius:7px; padding:8px; color:#d9e0e9; font-size:11px; }
  header { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
  h4 { margin:0; font-size:13px; }
  p { margin:3px 0; color:#9da9b7; }
  .summary { color:#bbc6d4; }
  button { padding:5px 8px; color:#e2fff7; border:1px solid #3d8b7f; background:#173c36; border-radius:4px; cursor:pointer; }
  button:disabled { opacity:0.5; cursor:default; }
  button.danger { border-color:#8b4a3d; background:#3c1f19; color:#ffe2da; }
  select { padding:4px; color:#e7edf6; background:#151a21; border:1px solid #394553; border-radius:4px; }
  .items { list-style:none; margin:0; padding:0; max-height:260px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
  .items li { display:grid; grid-template-columns:1fr auto; gap:2px 8px; align-items:center; padding:5px; border:1px solid #29313b; border-radius:5px; }
  .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { color:#8592a3; grid-column:1; }
  .state { grid-column:2; grid-row:1; justify-self:end; color:#9fd7c8; }
  .state.unused { color:#f0b9a8; }
  .items li > button { grid-column:2; grid-row:2; justify-self:end; }
  .empty { color:#8592a3; display:block !important; }
  .confirm { border:1px solid #8b4a3d; border-radius:6px; padding:8px; background:#2a1a16; }
  .row { display:flex; gap:6px; }
  .ok { color:#9fd7c8; }
  .error { color:#f5a3a3; }
</style>
