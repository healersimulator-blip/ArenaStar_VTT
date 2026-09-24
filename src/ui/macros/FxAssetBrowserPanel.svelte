<script lang="ts">
  /** GM-only preview/comparison of this world's imported, content-addressed FX media.
   * All bytes come from the local host asset store; player previews never receive
   * this callback. Playback permissions and world-file export rights are separate. */
  import { onMount } from "svelte";
  import type { AssetManifestEntry } from "../../core/documents";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";

  let { client, bus, getAsset = null, useAsset } : {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    getAsset?: ((hash: string) => Promise<Uint8Array | undefined>) | null;
    useAsset: (hash: string) => void;
  } = $props();

  type Entry = { hash: string; entry: AssetManifestEntry };
  type Preview = Entry & { url: string };
  let assets = $state<Entry[]>([]);
  let previews = $state<Preview[]>([]);
  let query = $state("");
  let kind = $state<"all" | "image" | "video" | "audio">("all");
  let busy = $state("");
  let error = $state("");
  let disposed = false;
  const filtered = $derived(assets.filter(({ hash, entry }) => {
    const text = `${entry.name} ${entry.mime} ${hash}`.toLocaleLowerCase();
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return (kind === "all" || entry.mime.startsWith(`${kind}/`)) && terms.every((term) => text.includes(term));
  }));

  function refresh(): void {
    assets = Object.entries(client.store.world.assetManifest).filter(([, entry]) =>
      /^(image\/(png|jpeg|webp|gif|avif)|video\/(webm|mp4)|audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac))$/.test(entry.mime)
    ).map(([hash, entry]) => ({ hash, entry })).sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    const known = new Set(assets.map((asset) => asset.hash));
    for (const preview of previews) if (!known.has(preview.hash)) URL.revokeObjectURL(preview.url);
    previews = previews.filter((preview) => known.has(preview.hash));
  }

  function remove(hash: string): void {
    for (const preview of previews) if (preview.hash === hash) URL.revokeObjectURL(preview.url);
    previews = previews.filter((preview) => preview.hash !== hash);
  }

  async function inspect(asset: Entry): Promise<void> {
    if (previews.some((preview) => preview.hash === asset.hash)) { remove(asset.hash); return; }
    error = "";
    if (previews.length >= 6) { error = "Compare at most six files at once"; return; }
    if (asset.entry.size > 20 * 1024 * 1024) {
      error = "Preview is limited to 20 MiB per file; the saved timeline can still stream this media";
      return;
    }
    if (!getAsset) { error = "Media preview is unavailable in this host"; return; }
    busy = asset.hash;
    try {
      const bytes = await getAsset(asset.hash);
      if (!bytes) throw new Error("Local media bytes are missing; re-import or rebind this file");
      if (disposed) return;
      if (previews.length >= 6) throw new Error("Compare at most six files at once");
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: asset.entry.mime }));
      previews = [...previews, { ...asset, url }];
    } catch (cause) {
      if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = ""; }
  }

  onMount(() => {
    disposed = false;
    const offWelcome = bus.on("welcome", refresh);
    const offManifest = bus.on("assetManifest", refresh);
    refresh();
    return () => {
      disposed = true;
      offWelcome(); offManifest();
      for (const preview of previews) URL.revokeObjectURL(preview.url);
      previews = [];
    };
  });
</script>

<section class="fx-assets" aria-label="FX asset browser" data-fx-assets>
  <h3>World media browser</h3>
  <p class="hint">Search the GM's imported visual and sound files, compare up to six and send one to the FX timeline. A preview proves neither playback permission for players nor rights to redistribute a paid pack.</p>
  <div class="controls">
    <label>Find <input data-fx-asset-search bind:value={query} placeholder="Name, MIME or hash" /></label>
    <label>Type <select bind:value={kind}>
      <option value="all">All</option><option value="image">Images</option>
      <option value="video">Video</option><option value="audio">Sound</option>
    </select></label>
    <span>{filtered.length} of {assets.length} files</span>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if assets.length === 0}<p>Import your own licensed media in FX timelines first.</p>{/if}
  <ul class="library">
    {#each filtered as asset (asset.hash)}
      <li data-fx-asset={asset.hash}>
        <strong>{asset.entry.name}</strong> <small>{asset.entry.mime} · {(asset.entry.size / 1024).toFixed(1)} KiB</small>
        <small>{asset.entry.visibility === "gm" ? "GM-only playback" : "reference-gated playback"}
          · {asset.entry.exportRights === "restricted" ? "world export blocked" : asset.entry.exportRights === "granted" ? "world export approved" : "legacy export policy"}</small>
        <button type="button" disabled={busy === asset.hash}
          onclick={() => void inspect(asset)}>{previews.some((preview) => preview.hash === asset.hash) ? "Remove preview" : "Compare"}</button>
        <button type="button" onclick={() => useAsset(asset.hash)}>Use in timeline</button>
      </li>
    {/each}
  </ul>
  {#if previews.length}
    <div class="comparisons" aria-label="Media comparison">
      {#each previews as preview (preview.hash)}
        <figure data-fx-preview={preview.hash}>
          {#if preview.entry.mime.startsWith("image/")}
            <img src={preview.url} alt={`Preview of ${preview.entry.name}`} onerror={() => error = `Cannot decode ${preview.entry.name} in this browser`} />
          {:else if preview.entry.mime.startsWith("video/")}
            <video src={preview.url} muted loop playsinline controls onerror={() => error = `Cannot decode ${preview.entry.name} in this browser`}></video>
          {:else}
            <audio src={preview.url} controls onerror={() => error = `Cannot decode ${preview.entry.name} in this browser`}></audio>
          {/if}
          <figcaption>{preview.entry.name} <button type="button" aria-label={`Close preview ${preview.entry.name}`}
            onclick={() => remove(preview.hash)}>×</button></figcaption>
        </figure>
      {/each}
    </div>
  {/if}
</section>

<style>
  .fx-assets { display: grid; gap: 7px; font-size: .8rem; }
  .fx-assets h3, .fx-assets p { margin: 0; }
  .hint { color: #adbdcc; }
  .controls { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
  .controls label { display: inline-flex; gap: 4px; align-items: center; }
  .library { list-style: none; display: grid; gap: 4px; padding: 0; margin: 0;
    max-height: 195px; overflow: auto; }
  .library li { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; border-bottom: 1px solid #414654; padding: 4px; }
  .library small { color: #b0b9c4; }
  .comparisons { display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); gap: 6px;
    max-height: 240px; overflow-y: auto; }
  figure { margin: 0; min-width: 0; border: 1px solid #656779; padding: 3px; }
  img, video { width: 100%; height: 95px; object-fit: contain; }
  audio { width: 100%; }
  figcaption { display: flex; justify-content: space-between; overflow-wrap: anywhere; }
  .error { color: #ff9e9e; }
</style>
