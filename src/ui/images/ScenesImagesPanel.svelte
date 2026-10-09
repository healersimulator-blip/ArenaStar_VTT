<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { SceneDocument } from "../../core/documents";
  import { DEFAULT_SCENE_EXPRESS_DEFAULTS, sceneExpressDefaultsOf, type ImageAction, type SceneExpressDefaults } from "../../core/imageHandling";
  import { playerUploadQuotaMBOf } from "../../core/imageHandling";
  import { sceneSizeFromImage } from "../../core/imageSizing";
  import { worldSettingsFrom, worldSettingsOps } from "../../core/worldSettings";
  import { imageSourcesFromTransfer, type ImageSource } from "./imageSources";

  let {
    client,
    bus,
    resolveAsset,
    onActivate,
    onRequestImages,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    resolveAsset: (image: string | null | undefined) => string | null;
    onActivate: (sceneId: string) => void;
    onRequestImages: (sources: ImageSource[], action: ImageAction) => void;
  } = $props();

  let scenes = $state<SceneDocument[]>([]);
  let defaults = $state<SceneExpressDefaults>({ ...DEFAULT_SCENE_EXPRESS_DEFAULTS });
  let quotaDraft = $state<number | "">("");
  let saveStatus = $state("");
  let error = $state("");
  let picker = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  let dragDepth = 0;

  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");

  function refresh(): void {
    scenes = [...(client.store.getAll("scenes") as readonly SceneDocument[])].sort((a, b) => a.name.localeCompare(b.name));
    const settings = worldSettingsFrom(client.store.getAll("settings"));
    defaults = sceneExpressDefaultsOf(settings.sceneExpressDefaults);
    const quota = playerUploadQuotaMBOf(settings);
    quotaDraft = quota ?? "";
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => { offSnapshot(); offOps(); };
  });

  function saveWorld(patch: Record<string, unknown>): void {
    const ops = worldSettingsOps(client.store.getAll("settings"), patch);
    if (ops.length) {
      client.submit(ops);
      saveStatus = "Saved";
      setTimeout(() => (saveStatus = ""), 1600);
    }
  }

  function saveDefaults(next: SceneExpressDefaults): void {
    defaults = sceneExpressDefaultsOf(next);
    saveWorld({ sceneExpressDefaults: defaults });
  }

  function saveQuota(): void {
    const quota = quotaDraft === "" ? undefined : Number(quotaDraft);
    if (quota !== undefined && (!Number.isFinite(quota) || quota < 0)) {
      error = "Enter a non-negative upload quota in megabytes, or leave it blank for unlimited.";
      return;
    }
    error = "";
    saveWorld({ playerUploadQuotaMB: quota ?? null });
  }

  function saveRestrictedMode(value: boolean): void {
    saveWorld({ restrictedPlayerImageMode: value });
  }

  function onFilePicker(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length) onRequestImages(files.map((file) => ({ kind: "file", file, name: file.name || "Image" })), "newScene");
    input.value = "";
  }

  function hasImages(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? []);
    return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/html") || types.includes("text/plain");
  }

  function dragEnter(event: DragEvent): void {
    if (!hasImages(event)) return;
    dragDepth++;
    dragging = true;
  }
  function dragLeave(event: DragEvent): void {
    if (!hasImages(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dragging = false;
  }
  function dragOver(event: DragEvent): void {
    if (hasImages(event)) event.preventDefault();
  }
  function drop(event: DragEvent): void {
    const sources = imageSourcesFromTransfer(event.dataTransfer);
    if (!sources.length) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
    dragDepth = 0;
    if (!defaults.enabled) {
      error = "Scene image drops are disabled for this world. Enable the Scenes drop zone below, or drop elsewhere to use your image default.";
      return;
    }
    onRequestImages(sources, "newScene");
  }

  function alignmentHint(scene: SceneDocument): string {
    if (!scene.width || !scene.height) return "";
    try {
      const result = sceneSizeFromImage({ width: scene.width, height: scene.height });
      return `${result.width} × ${result.height}`;
    } catch { return `${scene.width} × ${scene.height}`; }
  }
</script>

<section class="scenes-images" aria-label="Scenes and image drop zone">
  <header class="heading-row">
    <div><h3>Scenes</h3><p>Switch scenes or create maps from images.</p></div>
    <button type="button" class="primary" disabled={!isGm} onclick={() => picker?.click()}>Create scenes</button>
    <input bind:this={picker} type="file" accept="image/*" multiple hidden onchange={onFilePicker} />
  </header>

  <div
    class="drop-zone"
    class:dragging
    class:disabled={!defaults.enabled}
    role="button"
    tabindex="0"
    aria-label="Drop one or more images here to create scenes"
    ondragenter={dragEnter}
    ondragleave={dragLeave}
    ondragover={dragOver}
    ondrop={drop}
    onkeydown={(event) => { if ((event.key === "Enter" || event.key === " ") && isGm) picker?.click(); }}
  >
    <strong>{dragging ? "Release to create one scene per image" : "Drop images here to create scenes"}</strong>
    <span>{defaults.enabled ? "PNG · JPEG · WebP · GIF · AVIF · multiple images supported" : "Drop-zone action is disabled in world settings"}</span>
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if isGm}
    <details class="settings" open>
      <summary>Scene Express defaults and upload permissions</summary>
      <label class="check"><input type="checkbox" checked={defaults.enabled} onchange={(event) => saveDefaults({ ...defaults, enabled: event.currentTarget.checked })} /> Enable the Scenes drop zone</label>
      <label>Scene destination folder <input value={defaults.destinationLogicalFolder} maxlength="240" onchange={(event) => saveDefaults({ ...defaults, destinationLogicalFolder: event.currentTarget.value })} /></label>
      <label>Logical file-name collisions
        <select value={defaults.duplicateFileBehavior} onchange={(event) => saveDefaults({ ...defaults, duplicateFileBehavior: event.currentTarget.value as SceneExpressDefaults["duplicateFileBehavior"] })}>
          <option value="stop">Stop on collision</option><option value="reuse">Reuse existing file</option><option value="overwrite">Replace folder entry</option><option value="ask">Ask each time</option>
        </select>
      </label>
      <label>Scene-name collisions
        <select value={defaults.duplicateSceneBehavior} onchange={(event) => saveDefaults({ ...defaults, duplicateSceneBehavior: event.currentTarget.value as SceneExpressDefaults["duplicateSceneBehavior"] })}>
          <option value="stop">Stop on collision</option><option value="reuse">Reuse existing scene</option><option value="overwrite">Replace existing scene background</option><option value="ask">Ask each time</option>
        </select>
      </label>
      <div class="row">
        <label>Grid type
          <select value={defaults.gridType} onchange={(event) => saveDefaults({ ...defaults, gridType: event.currentTarget.value as SceneExpressDefaults["gridType"] })}>
            <option value="square">Square</option><option value="hex">Hex</option><option value="gridless">Gridless</option>
          </select>
        </label>
        <label>Grid size (px)
          <input type="number" min="50" max="1000" step="1" value={defaults.gridSize} disabled={defaults.gridType === "gridless"} onchange={(event) => saveDefaults({ ...defaults, gridSize: Number(event.currentTarget.value) })} />
        </label>
      </div>
      <div class="suggestions" aria-label="Suggested grid sizes">
        {#each [70, 100, 140, 200] as size (size)}<button type="button" disabled={defaults.gridType === "gridless"} aria-pressed={defaults.gridSize === size} onclick={() => saveDefaults({ ...defaults, gridSize: size })}>{size}px</button>{/each}
      </div>
      <div class="row">
        <label>Scene ownership
          <select value={defaults.ownership} onchange={(event) => saveDefaults({ ...defaults, ownership: event.currentTarget.value as SceneExpressDefaults["ownership"] })}>
            <option value="gm">GM only</option><option value="all">All players</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" checked={defaults.navigation} onchange={(event) => saveDefaults({ ...defaults, navigation: event.currentTarget.checked })} /> Show in navigation</label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" checked={defaults.tokenVision} onchange={(event) => saveDefaults({ ...defaults, tokenVision: event.currentTarget.checked })} /> Token vision</label>
        <label class="check"><input type="checkbox" checked={defaults.fogExploration} onchange={(event) => saveDefaults({ ...defaults, fogExploration: event.currentTarget.checked })} /> Fog exploration</label>
        <label class="check"><input type="checkbox" checked={defaults.activateImmediately} onchange={(event) => saveDefaults({ ...defaults, activateImmediately: event.currentTarget.checked })} /> Activate immediately</label>
      </div>
      <label>Trusted-player upload quota (MB per user, blank = unlimited)
        <input type="number" min="0" step="any" value={quotaDraft} oninput={(event) => (quotaDraft = event.currentTarget.value === "" ? "" : Number(event.currentTarget.value))} onblur={saveQuota} onkeydown={(event) => { if (event.key === "Enter") saveQuota(); }} />
      </label>
      <label class="check"><input type="checkbox" checked={client.store.get("settings", "world-settings")?.system.restrictedPlayerImageMode === true} onchange={(event) => saveRestrictedMode(event.currentTarget.checked)} /> Restrict players to preview only</label>
      <p class="fine">Trusted players can upload images when this is off. Scene, tile and journal document edits remain GM-only.</p>
      {#if saveStatus}<span role="status" class="saved">{saveStatus}</span>{/if}
    </details>
  {/if}

  <div class="scene-list" aria-label="Scenes">
    {#if scenes.length === 0}<p class="empty">No scenes yet.</p>{/if}
    {#each scenes as scene (scene._id)}
      {@const image = resolveAsset(scene.thumbnail ?? scene.img)}
      <button type="button" class="scene-card" class:active={scene.active} data-scene-card={scene._id} onclick={() => onActivate(scene._id)}>
        {#if image}<img src={image} alt="" loading="lazy" />{:else}<span class="thumb-placeholder">✦</span>{/if}
        <span class="scene-title"><strong>{scene.name}</strong><small>{alignmentHint(scene)}{scene.active ? " · Active" : ""}</small></span>
      </button>
    {/each}
  </div>
</section>

<style>
  .scenes-images { display:flex; flex-direction:column; gap:10px; padding:10px; color:#d8dee8; }
  .heading-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  h3 { margin:0; font-size:15px; } p { margin:3px 0 0; color:#9ca8b8; font-size:11px; }
  .primary { border:1px solid #3d8b7f; background:#173c36; color:#e5fff8; border-radius:6px; padding:7px 10px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .drop-zone { border:1px dashed #42a99a; background:#15241f; border-radius:9px; min-height:76px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:10px; gap:4px; cursor:pointer; }
  .drop-zone.dragging { border-style:solid; background:#1b493f; box-shadow:0 0 0 2px #42a99a44; }
  .drop-zone.disabled { border-color:#5c626a; background:#202329; color:#9da4ae; cursor:not-allowed; }
  .drop-zone span,.fine { color:#91a0b1; font-size:10px; }
  .error { color:#ffc0b4; border:1px solid #8e453e; padding:7px; border-radius:5px; font-size:11px; }
  .settings { border:1px solid #303944; border-radius:7px; padding:8px; font-size:11px; }
  summary { cursor:pointer; font-weight:700; margin-bottom:8px; }
  .settings label { display:flex; flex-direction:column; gap:4px; margin:7px 0; color:#bdc8d7; }
  .settings label.check { flex-direction:row; align-items:center; }
  .settings input:not([type=checkbox]), .settings select { min-width:0; width:100%; padding:6px; color:#e7edf6; background:#151a21; border:1px solid #394553; border-radius:4px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:7px; align-items:center; }
  .checks { display:flex; flex-wrap:wrap; gap:2px 10px; }
  .suggestions { display:flex; gap:5px; }
  .suggestions button { padding:3px 5px; color:#cbd7e5; background:#202a34; border:1px solid #3a4654; border-radius:4px; }
  .saved { color:#8dd6c7; font-size:10px; }
  .scene-list { display:flex; flex-direction:column; gap:5px; }
  .scene-card { display:flex; width:100%; align-items:center; gap:9px; text-align:left; padding:5px; background:#171c23; border:1px solid #303944; border-radius:6px; color:#d8dee8; cursor:pointer; }
  .scene-card.active { border-color:#54a89b; background:#1b2929; }
  .scene-card img,.thumb-placeholder { width:60px; height:38px; object-fit:cover; flex:none; border-radius:3px; background:#282e36; }
  .thumb-placeholder { display:grid; place-items:center; color:#8da1b5; }
  .scene-title { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .scene-title strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
  .scene-title small { color:#98a5b5; font-size:10px; }
  .empty { color:#96a0ae; }
</style>
