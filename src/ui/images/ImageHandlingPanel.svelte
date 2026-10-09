<script lang="ts">
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { JournalDocument } from "../../core/documents";
  import type { ImageAction, ImageHandlingPreferences } from "../../core/imageHandling";
  import { IMAGE_ACTIONS } from "../../core/imageHandling";
  import type { ImageSource } from "./imageSources";
  import ImageLibraryPanel from "./ImageLibraryPanel.svelte";

  let {
    client,
    bus,
    preferences,
    onPreferencesChange,
    onRequestImages,
    fetchAsset,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    preferences: ImageHandlingPreferences;
    onPreferencesChange: (next: ImageHandlingPreferences) => void;
    onRequestImages: (sources: ImageSource[], action?: ImageAction, origin?: "file" | "paste" | "url") => void;
    fetchAsset?: (hash: string) => Promise<Uint8Array>;
  } = $props();

  let journals = $state<JournalDocument[]>([]);
  let urlDraft = $state("");
  let picker = $state<HTMLInputElement | null>(null);
  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");

  function refresh(): void {
    journals = [...(client.store.getAll("journals") as readonly JournalDocument[])].filter((journal) => journal.codex === undefined);
  }

  function update(patch: Partial<ImageHandlingPreferences>): void {
    onPreferencesChange({ ...preferences, ...patch });
  }

  function chooseFiles(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length) onRequestImages(files.map((file) => ({ kind: "file", file, name: file.name || "Image" })), undefined, "file");
    input.value = "";
  }

  function addUrl(): void {
    const url = urlDraft.trim();
    if (!url) return;
    const name = (() => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "Image") || "Image"; } catch { return "Image"; } })();
    onRequestImages([{ kind: "url", url, name }], undefined, "url");
    urlDraft = "";
  }

  function updateHistory(value: string): void {
    const recent = value.trim();
    const history = recent ? [recent, ...preferences.uploadFolderHistory.filter((folder) => folder !== recent)].slice(0, 10) : preferences.uploadFolderHistory;
    update({ defaultUploadFolder: recent || preferences.defaultUploadFolder, uploadFolderHistory: history });
  }

  $effect(() => {
    void bus;
    refresh();
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    return () => { offSnapshot(); offOps(); };
  });

  function actionLabel(action: ImageAction): string {
    return ({
      newScene: "New scene",
      replaceBackground: "Replace background",
      replaceForeground: "Replace foreground",
      tileNatural: "Centered tile · natural size",
      tileFit: "Centered tile · fit scene",
      tileGrid: "Tile · Asset Grid Size",
      journalPage: "Journal image page",
      tokenArt: "Apply to selected token(s)",
      showPlayers: "Show to players",
      preview: "Preview only",
    } as Record<ImageAction, string>)[action];
  }
</script>

<section class="images-panel" aria-label="Image handling preferences">
  <header><div><h3>Images</h3><p>Drop, paste or choose an image. Every import opens with a preview.</p></div></header>
  <div class="actions">
    <button type="button" class="primary" onclick={() => picker?.click()}>Choose images…</button>
    <input bind:this={picker} type="file" accept="image/*" multiple hidden onchange={chooseFiles} />
    <label class="url">Image URL
      <span><input type="url" placeholder="https://…" bind:value={urlDraft} onkeydown={(event) => { if (event.key === "Enter") addUrl(); }} /><button type="button" onclick={addUrl} disabled={!urlDraft.trim()}>Preview</button></span>
    </label>
  </div>
  <p class="permission" class:gm={isGm}>{isGm ? "GM permissions: image documents can be created." : client.user?.role === "TRUSTED" ? "Trusted upload: preview and sharing are available when enabled by the GM; document destinations remain GM-only." : "Player mode: preview only unless the GM grants Trusted image upload."}</p>

  <details open>
    <summary>Input and action defaults</summary>
    <label class="check"><input type="checkbox" checked={preferences.dropEnabled} onchange={(event) => update({ dropEnabled: event.currentTarget.checked })} /> Enable image drop anywhere</label>
    <label class="check"><input type="checkbox" checked={preferences.pasteEnabled} onchange={(event) => update({ pasteEnabled: event.currentTarget.checked })} /> Enable Ctrl+V image/URL paste outside text fields</label>
    <label>Default action
      <select value={preferences.defaultAction} onchange={(event) => update({ defaultAction: event.currentTarget.value as ImageAction })}>
        {#each IMAGE_ACTIONS as action (action)}<option value={action}>{actionLabel(action)}</option>{/each}
      </select>
    </label>
    <label class="check"><input type="checkbox" checked={preferences.rememberLastAction} onchange={(event) => update({ rememberLastAction: event.currentTarget.checked })} /> Remember last successful action</label>
    {#if preferences.lastUsedAction}<p class="hint">Last successful: {actionLabel(preferences.lastUsedAction)}</p>{/if}
    <label class="check"><input type="checkbox" checked={preferences.defaultShareToPlayers} disabled={!isGm} onchange={(event) => update({ defaultShareToPlayers: event.currentTarget.checked })} /> Share stored images with players by default</label>
    <label class="check"><input type="checkbox" checked={preferences.activateNewScene} disabled={!isGm} onchange={(event) => update({ activateNewScene: event.currentTarget.checked })} /> Activate new scenes</label>
    <label class="check"><input type="checkbox" checked={preferences.defaultNavigation} disabled={!isGm} onchange={(event) => update({ defaultNavigation: event.currentTarget.checked })} /> Add new scenes to navigation by default</label>
  </details>

  <details open>
    <summary>Storage and journals</summary>
    <label>Default upload directory
      <input value={preferences.defaultUploadFolder} maxlength="240" onchange={(event) => updateHistory(event.currentTarget.value)} />
    </label>
    <label>Recent directories
      <select value={preferences.defaultUploadFolder} onchange={(event) => updateHistory(event.currentTarget.value)}>
        {#each preferences.uploadFolderHistory as folder (folder)}<option value={folder}>{folder}</option>{/each}
      </select>
    </label>
    <label>Target journal
      <select value={preferences.targetJournal} disabled={!isGm} onchange={(event) => update({ targetJournal: event.currentTarget.value })}>
        <option value="">Auto-create / choose in preview</option>
        {#each journals as journal (journal._id)}<option value={journal._id}>{journal.name}</option>{/each}
      </select>
    </label>
    <label class="check"><input type="checkbox" checked={preferences.autoCreateJournal} disabled={!isGm} onchange={(event) => update({ autoCreateJournal: event.currentTarget.checked })} /> Auto-create journal when no target is selected</label>
    <label>Auto-created journal name<input value={preferences.autoCreateJournalName} maxlength="160" disabled={!preferences.autoCreateJournal || !isGm} onchange={(event) => update({ autoCreateJournalName: event.currentTarget.value })} /></label>
  </details>

  <details>
    <summary>Image quality and preview size</summary>
    <label class="check"><input type="checkbox" checked={preferences.webpConvert} onchange={(event) => update({ webpConvert: event.currentTarget.checked })} /> Convert stored originals to WebP</label>
    <label>WebP quality <output>{preferences.webpQuality.toFixed(2)}</output>
      <input type="range" min="0.1" max="1" step="0.05" value={preferences.webpQuality} disabled={!preferences.webpConvert} oninput={(event) => update({ webpQuality: Number(event.currentTarget.value) })} />
    </label>
    <label>Default URL mode
      <select value={preferences.urlMode} onchange={(event) => update({ urlMode: event.currentTarget.value as ImageHandlingPreferences["urlMode"] })}>
        <option value="store">Store a copy (default)</option><option value="link">Link to the external HTTPS source</option>
      </select>
    </label>
    <div class="row">
      <label>Window width<input type="number" min="420" max="1600" value={preferences.dialogWindowSizes.width} onchange={(event) => update({ dialogWindowSizes: { ...preferences.dialogWindowSizes, width: Number(event.currentTarget.value) } })} /></label>
      <label>Window height<input type="number" min="420" max="1400" value={preferences.dialogWindowSizes.height} onchange={(event) => update({ dialogWindowSizes: { ...preferences.dialogWindowSizes, height: Number(event.currentTarget.value) } })} /></label>
    </div>
    <p class="hint">Original bytes are kept unless WebP conversion is enabled. Previews never write to the world.</p>
  </details>

  <ImageLibraryPanel {client} {fetchAsset} />
</section>

<style>
  .images-panel { display:flex; flex-direction:column; gap:10px; padding:10px; color:#d9e0e9; }
  h3 { margin:0; font-size:15px; } p { margin:3px 0; color:#9da9b7; font-size:11px; }
  .actions { display:flex; flex-direction:column; gap:8px; }
  .primary { border:1px solid #3d8b7f; background:#173c36; color:#e5fff8; border-radius:6px; padding:8px 10px; cursor:pointer; }
  label { display:flex; flex-direction:column; gap:4px; margin:6px 0; font-size:11px; color:#bbc6d4; }
  input:not([type=checkbox]),select { min-width:0; padding:6px; color:#e7edf6; background:#151a21; border:1px solid #394553; border-radius:4px; }
  .url span { display:flex; gap:5px; }
  .url input { flex:1; }
  .url button { padding:4px 8px; color:#e2fff7; border:1px solid #3d8b7f; background:#173c36; border-radius:4px; }
  .permission { padding:7px; border:1px solid #665b3d; border-radius:5px; background:#27241a; color:#e6d8af; }
  .permission.gm { border-color:#316c5c; background:#172a25; color:#b4e2d3; }
  details { border:1px solid #303944; border-radius:7px; padding:8px; font-size:11px; }
  summary { cursor:pointer; font-weight:700; margin-bottom:8px; }
  .check { flex-direction:row; align-items:center; }
  .hint { font-size:10px; color:#8592a3; }
  output { float:right; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
</style>
