<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { AssetManifest, MacroDocument, SceneDocument } from "../../core/documents";
  import { validateFxSequence, type FxSection, type FxSequence, type FxImportPermissions } from "../../core/fx";
  import type { Json } from "../../core/documents";

  let {
    client, bus, onImport = null, listAssets = null, onAssetRights = null, pickedAsset = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onImport?: ((file: File, permissions: FxImportPermissions) => Promise<{ hash: string; mime: string; name: string }>) | null;
    listAssets?: (() => Promise<AssetManifest>) | null;
    onAssetRights?: ((hash: string, permissions: FxImportPermissions) => Promise<void>) | null;
    pickedAsset?: { hash: string } | null;
  } = $props();

  let macros = $state<MacroDocument[]>([]);
  let scenes = $state<SceneDocument[]>([]);
  let media = $state<Array<{ hash: string; name: string; mime: string;
    visibility: AssetManifest[string]["visibility"]; exportRights: AssetManifest[string]["exportRights"] }>>([]);
  let rightsHash = $state("");
  let rightsShare = $state(false);
  let rightsExport = $state(false);
  let name = $state("");
  let editing = $state("");
  let sceneId = $state("");
  let sourceId = $state("");
  let targetId = $state("");
  let playerCallable = $state(false);
  // Neither serving bytes to a connected player nor bundling bytes into a
  // world archive follows from possessing a local copy of a premium pack.
  let shareWithPlayers = $state(false);
  let includeInWorldFile = $state(false);
  let draft = $state<FxSequence>({ version: 1, audience: "scene", persistent: false, sections: [] });
  let status = $state("");
  let error = $state("");
  let busy = $state(false);
  const scene = $derived(scenes.find((s) => s._id === sceneId) ?? null);

  function refresh(): void {
    macros = [...client.store.getAll("macros")].filter((m) => m.kind === "sequence");
    scenes = [...client.store.getAll("scenes")];
    if (!scenes.some((s) => s._id === sceneId)) sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
  }
  function selectRights(hash: string): void {
    rightsHash = hash;
    const entry = media.find((asset) => asset.hash === hash);
    rightsShare = entry?.visibility === "referenced" || entry?.visibility === "world";
    rightsExport = entry?.exportRights === "granted";
  }
  async function saveRights(): Promise<void> {
    if (!rightsHash || !onAssetRights) return;
    error = ""; status = ""; busy = true;
    try {
      await onAssetRights(rightsHash, { shareWithPlayers: rightsShare, includeInWorldFile: rightsExport });
      await refreshAssets();
      status = "Media permissions updated independently of the timeline; test audience and export before sharing";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  async function refreshAssets(): Promise<void> {
    if (!listAssets) return;
    try {
      media = Object.entries(await listAssets()).filter(([, e]) =>
        /^(image\/(png|jpeg|webp|gif|avif)|video\/(webm|mp4)|audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac))$/.test(e.mime)
      ).map(([hash, e]) => ({ hash, name: e.name, mime: e.mime,
        visibility: e.visibility, exportRights: e.exportRights }));
      selectRights(media.some((asset) => asset.hash === rightsHash) ? rightsHash : media[0]?.hash ?? "");
    } catch (cause) {
      error = `Asset library: ${String(cause)}`;
    }
  }
  function pick(m: MacroDocument): void {
    editing = m._id;
    name = m.name;
    playerCallable = m.flags.core?.playerCallable === true;
    draft = { ...$state.snapshot(m.sequence ?? { version: 1, sections: [] }),
      persistent: m.sequence?.persistent === true };
    status = "Editing saved timeline";
    error = "";
  }
  function reset(): void {
    editing = "";
    name = "";
    playerCallable = false;
    draft = { version: 1, audience: "scene", persistent: false, sections: [] };
    status = "";
    error = "";
  }
  function add(kind: FxSection["kind"]): void {
    const id = `fx-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const startMs = Math.min(30_000, Math.max(0, ...draft.sections.map((s) =>
      s.startMs + s.durationMs * (s.repeatCount ?? 1) +
      ((s.repeatCount ?? 1) - 1) * (s.repeatDelayMs ?? 0) - 250)));
    const durationMs = kind === "wait" ? 500 : 1000;
    const at = { kind: "point" as const, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) };
    const section: FxSection = kind === "text" ? { id, kind, startMs, durationMs, at, text: "A dramatic moment" }
      : kind === "image" ? { id, kind, startMs, durationMs, at, assetId: media.find((m) => /^(image|video)\//.test(m.mime))?.hash ?? "" }
      : kind === "sound" ? { id, kind, startMs, durationMs, assetId: media.find((m) => m.mime.startsWith("audio/"))?.hash ?? "", volume: 0.8 }
      : { id, kind, startMs, durationMs };
    draft = { ...draft, sections: [...draft.sections, section] };
  }
  function applyPickedAsset(hash: string): void {
    const entry = client.store.world.assetManifest[hash];
    if (!entry) { error = "Selected media is no longer in this world"; return; }
    const kind = entry.mime.startsWith("audio/") ? "sound" : "image";
    const index = draft.sections.findLastIndex((section) => section.kind === kind);
    if (index < 0) add(kind);
    const selected = index < 0 ? draft.sections.length - 1 : index;
    draft = { ...draft, sections: draft.sections.map((section, i) => i === selected &&
      (section.kind === "image" || section.kind === "sound")
      ? { ...section, assetId: hash } : section) };
    status = `${entry.name} selected for the ${kind} section; save the timeline to publish`;
  }
  // The browser's "Use in timeline" action is a new object for each click.
  // Untrack the editor draft so subsequent typing never re-applies the choice.
  $effect(() => { const choice = pickedAsset; if (choice) untrack(() => applyPickedAsset(choice.hash)); });

  function changeKind(index: number, kind: FxSection["kind"]): void {
    const before = draft.sections[index];
    if (!before) return;
    const at = { kind: "point" as const, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) };
    const section: FxSection = kind === "image" ? { id: before.id, kind, at, assetId: "", startMs: before.startMs, durationMs: before.durationMs }
      : kind === "sound" ? { id: before.id, kind, assetId: "", startMs: before.startMs, durationMs: before.durationMs, volume: 0.8 }
      : kind === "text" ? { id: before.id, kind, at, text: "A dramatic moment", startMs: before.startMs, durationMs: before.durationMs }
      : { id: before.id, kind, startMs: before.startMs, durationMs: before.durationMs };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index ? section : old) };
  }
  function changeReplayCount(index: number, value: string): void {
    const section = draft.sections[index];
    if (!section || section.kind === "wait") return;
    const count = Number(value);
    if (count === 1) {
      const single = { ...section };
      Reflect.deleteProperty(single, "repeatCount");
      Reflect.deleteProperty(single, "repeatDelayMs");
      draft.sections[index] = single;
    } else draft.sections[index] = { ...section, repeatCount: count };
  }
  function changeReplayGap(index: number, value: string): void {
    const section = draft.sections[index];
    if (!section || section.kind === "wait") return;
    draft.sections[index] = { ...section, repeatDelayMs: Number(value) };
  }
  function changeAnchor(index: number, kind: "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    // Replace the entire discriminated anchor; retaining point x/y on a token anchor is rejected by the host.
    const at = kind === "point"
      ? { kind, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) }
      : { kind };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, at, follow: kind === "point" && (!before.to || before.to.kind === "point")
          ? false : before.follow } as FxSection : old) };
  }
  function changeDestination(index: number, kind: "none" | "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { to: _to, repeats: _repeats, ...remaining } = before;
    void _to; void _repeats;
    const to = kind === "point" ? { kind, x: Math.round((scene?.width ?? 500) / 2),
      y: Math.round((scene?.height ?? 500) / 2) } : kind === "none" ? null : { kind };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...remaining, ...(to ? { to } : {}),
          follow: (kind === "none" || kind === "point") && before.at.kind === "point" ? false : before.follow,
          ...(kind === "none" && before.kind === "image" ? { stretch: false } : {}) } as FxSection : old) };
  }
  function remove(index: number): void {
    draft = { ...draft, sections: draft.sections.filter((_, i) => i !== index) };
  }
  function save(): void {
    error = "";
    status = "";
    if (!name.trim()) { error = "Enter a timeline name"; return; }
    const checked = validateFxSequence(draft);
    if (!checked.ok) { error = checked.error; return; }
    if (editing) {
      const existing = macros.find((m) => m._id === editing);
      if (!existing) { error = "Saved macro was deleted"; return; }
      client.submit([{ kind: "update", ref: { coll: "macros", id: editing }, diff: {
        name: name.trim(), sequence: $state.snapshot(draft) as unknown as Json,
        flags: { ...existing.flags, core: { ...existing.flags.core, playerCallable } },
      } }]);
      status = "Timeline update submitted";
    } else {
      const doc: MacroDocument = { _id: globalThis.crypto.randomUUID(), type: "macro", name: name.trim(),
        ownership: { default: 1 }, flags: { core: { playerCallable } }, system: {},
        kind: "sequence", command: "", sequence: $state.snapshot(draft) };
      client.submit([{ kind: "create", coll: "macros", data: doc }]);
      editing = doc._id;
      status = "Timeline submitted; use Run once it appears in the list";
    }
  }
  function run(macroId: string): void {
    if (!sceneId) { error = "Choose a scene"; return; }
    client.requestSequence(macroId, sceneId, sourceId || undefined, targetId || undefined);
    status = "Requested saved timeline from host";
  }
  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !onImport) return;
    error = "";
    busy = true;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error("Media file exceeds 200 MiB");
      const item = await onImport(file, { shareWithPlayers, includeInWorldFile });
      await refreshAssets();
      selectRights(item.hash);
      status = `Imported ${item.name} (${item.mime}) — ${shareWithPlayers ? "eligible scene viewers may fetch it" : "GM-only playback"}; ${includeInWorldFile ? "world export enabled" : "world ZIP export blocked until rights are confirmed"}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      input.value = "";
    }
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", (reason) => { error = `${reason.reason}: ${reason.detail}`; });
    refresh();
    void refreshAssets();
    return () => { offSnapshot(); offOps(); offRejected(); };
  });
</script>

<section class="fx-wizard" aria-label="FX sequence wizard" data-fx-wizard>
  <header><h3>FX timeline wizard</h3><button type="button" onclick={reset}>New</button></header>
  <p class="hint">Author overlapping image/video/text/audio sections. One-shot sections can replay at a fixed interval; host-approved cues stay beneath fog. Persistent timelines loop until stopped in Live FX or their source disappears (they cannot also use section replays). This is a subset of the full Sequencer action library.</p>
  <div class="library">
    <label>Import licensed media <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/webm,video/mp4,audio/ogg,audio/mpeg,audio/wav,audio/webm" disabled={busy || !onImport} onchange={(e) => void importFile(e)} /></label>
    <label><input type="checkbox" data-fx-share bind:checked={shareWithPlayers} /> I have permission to serve this file to players</label>
    <label><input type="checkbox" data-fx-export bind:checked={includeInWorldFile} /> I have separate rights to redistribute this file in world archives</label>
    <span>{media.length} media file(s) in this world. Uploading or purchasing a pack does not grant sharing/redistribution rights.</span>
  </div>
  <details data-fx-rights>
    <summary>Review existing media permissions (including imported worlds)</summary>
    <div class="controls">
      <label>Media <select value={rightsHash} onchange={(event) => selectRights(event.currentTarget.value)}>
        {#each media as asset (asset.hash)}
          <option value={asset.hash}>{asset.name} ({asset.mime})</option>
        {/each}
      </select></label>
      <label><input type="checkbox" data-fx-rights-share bind:checked={rightsShare} /> I may serve this file to players</label>
      <label><input type="checkbox" data-fx-rights-export bind:checked={rightsExport} /> I may redistribute this file in a world archive</label>
      <button type="button" data-fx-update-rights disabled={busy || !rightsHash || !onAssetRights}
        onclick={() => void saveRights()}>Save media permissions</button>
    </div>
    <p class="hint">Restored files require this GM to review sharing and export rights again. A playable pack is not a redistribution license.</p>
  </details>
  <label>Name <input data-fx-name bind:value={name} placeholder="e.g. Arcane ward" /></label>
  <div class="controls">
    <label>Scene <select data-fx-scene bind:value={sceneId}>
      {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
    </select></label>
    <label>Source <select bind:value={sourceId}><option value="">None</option>
      {#each scene?.tokens ?? [] as t (t._id)}<option value={t._id}>{t.name}</option>{/each}
    </select></label>
    <label>Target <select bind:value={targetId}><option value="">None</option>
      {#each scene?.tokens ?? [] as t (t._id)}<option value={t._id}>{t.name}</option>{/each}
    </select></label>
    <label>Audience <select bind:value={draft.audience}>
      <option value="scene">Entitled scene viewers</option><option value="gm">GM only</option><option value="caller">Caller only</option>
    </select></label>
    <label><input type="checkbox" bind:checked={playerCallable} /> Published for player invocation</label>
    <label><input type="checkbox" data-fx-persistent checked={draft.persistent === true}
      onchange={(e) => draft = { ...draft, persistent: e.currentTarget.checked }} /> Persist / loop until stopped</label>
  </div>
  <div class="sections">
    {#each draft.sections as section, i (section.id)}
      <fieldset data-fx-section={section.id}>
        <legend>{i + 1}. {section.kind}</legend>
        <div class="controls">
          <label>Step <select value={section.kind} onchange={(e) => changeKind(i, (e.target as HTMLSelectElement).value as FxSection["kind"])}>
            <option value="text">Text</option><option value="image">Image / video</option><option value="sound">Sound</option><option value="wait">Wait</option>
          </select></label>
          <label>Start ms <input type="number" min="0" max="60000" step="50" bind:value={section.startMs} /></label>
          <label>Duration ms <input type="number" min="0" max="30000" step="50" bind:value={section.durationMs} /></label>
          <button type="button" aria-label={`Remove section ${i + 1}`} onclick={() => remove(i)}>×</button>
        </div>
        {#if section.kind !== "wait"}
          <div class="controls" data-fx-replay>
            <label>Section play count <input type="number" min="1" max="8" step="1" disabled={draft.persistent}
              value={section.repeatCount ?? 1} oninput={(e) => changeReplayCount(i, e.currentTarget.value)} /></label>
            {#if (section.repeatCount ?? 1) > 1}
              <label>Pause between plays ms <input type="number" min="0" max="30000" step="50" disabled={draft.persistent}
                value={section.repeatDelayMs ?? 0} onchange={(e) => changeReplayGap(i, e.currentTarget.value)} /></label>
            {/if}
            <small>Separate clock-aligned plays (not motion cycles). One-shot only; 2–8 plays, ≤64 cues total, end before 60 s.</small>
          </div>
        {/if}
        {#if section.kind === "image" || section.kind === "sound"}
          <label>Media <select bind:value={section.assetId}>
            <option value="">Choose imported file…</option>
            {#each media.filter((m) => section.kind === "sound" ? m.mime.startsWith("audio/") : !m.mime.startsWith("audio/")) as asset (asset.hash)}
              <option value={asset.hash}>{asset.name} ({asset.mime})</option>
            {/each}
          </select></label>
        {/if}
        {#if section.kind === "text"}
          <label>Text <input maxlength="256" bind:value={section.text} /></label>
          <label>Color <input type="color" bind:value={section.color} /></label>
        {/if}
        {#if section.kind === "sound"}<label>Volume <input type="number" min="0" max="1" step="0.05" bind:value={section.volume} /></label>{/if}
        {#if section.kind === "image" || section.kind === "text"}
          <div class="controls">
            <label>Anchor <select value={section.at.kind} onchange={(e) => changeAnchor(i, (e.target as HTMLSelectElement).value as "point" | "source" | "target")}>
              <option value="point">Point</option><option value="source">Source token</option><option value="target">Target token</option>
            </select></label>
            {#if section.at.kind === "point"}
              <label>X <input type="number" min="0" bind:value={section.at.x} /></label>
              <label>Y <input type="number" min="0" bind:value={section.at.y} /></label>
            {/if}
            <label>Destination <select value={section.to?.kind ?? "none"} onchange={(event) =>
                changeDestination(i, event.currentTarget.value as "none" | "point" | "source" | "target")}>
              <option value="none">Stay</option><option value="point">Point</option>
              <option value="source">Source token</option><option value="target">Target token</option>
            </select></label>
            {#if section.to?.kind === "point"}
              <label>To X <input type="number" min="0" bind:value={section.to.x} /></label>
              <label>To Y <input type="number" min="0" bind:value={section.to.y} /></label>
            {/if}
            {#if section.to}
              <label>Easing <select bind:value={section.easing}>
                <option value="linear">Linear</option><option value="easeIn">Ease in</option>
                <option value="easeOut">Ease out</option><option value="easeInOut">Ease in/out</option>
              </select></label>
              {#if section.kind === "image"}
                <label><input type="checkbox" bind:checked={section.stretch}
                  onchange={() => { if (section.stretch) section.repeats = undefined; }} />Stretch toward destination</label>
              {/if}
              {#if section.kind !== "image" || !section.stretch}
                <label>Motion cycles <input type="number" min="1" max="20" bind:value={section.repeats} /></label>
              {/if}
            {/if}
            {#if section.kind === "image"}
              <label>Tint <input type="color" bind:value={section.tint} /></label>
            {/if}
            {#if section.at.kind !== "point" || section.to && section.to.kind !== "point"}
              <label><input type="checkbox" data-fx-follow bind:checked={section.follow} />Follow visible token anchors</label>
            {/if}
            <label>Layer <select bind:value={section.layer}>
              <option value="aboveTokens">Above tokens, beneath fog</option><option value="belowTokens">Below tokens</option>
            </select></label>
            <label>Scale <input type="number" min="0.05" max="10" step="0.1" bind:value={section.scale} /></label>
            <label>Opacity <input type="number" min="0" max="1" step="0.1" bind:value={section.opacity} /></label>
            <label>Fade in <input type="number" min="0" step="50" bind:value={section.fadeInMs} /></label>
            <label>Fade out <input type="number" min="0" step="50" bind:value={section.fadeOutMs} /></label>
          </div>
        {/if}
      </fieldset>
    {/each}
  </div>
  <div class="controls">
    <span>Add section:</span>
    <button type="button" onclick={() => add("text")}>Text</button>
    <button type="button" onclick={() => add("image")}>Image / video</button>
    <button type="button" onclick={() => add("sound")}>Sound</button>
    <button type="button" onclick={() => add("wait")}>Wait</button>
    <button type="button" data-fx-save onclick={save}>Save timeline</button>
    {#if editing}<button type="button" data-fx-run onclick={() => run(editing)}>Run saved</button>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  <h4>Saved timelines</h4>
  <ul>{#each macros as macro (macro._id)}
    <li data-fx-macro-id={macro._id}><strong>{macro.name}</strong> <small>{macro.sequence?.sections.length ?? 0} sections</small>
      <button type="button" onclick={() => pick(macro)}>Edit</button>
      <button type="button" onclick={() => run(macro._id)}>Run</button>
    </li>
  {/each}</ul>
</section>

<style>
  .fx-wizard { display: grid; gap: 8px; font-size: .8rem; }
  header, .controls, .library, li { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  header { justify-content: space-between; } h3, h4 { margin: 0; }
  label { display: inline-flex; align-items: center; gap: 4px; }
  input:not([type="checkbox"]):not([type="file"]), select { min-width: 72px; max-width: 220px; }
  input[type="number"] { width: 70px; }
  .hint { margin: 0; color: #aab6c6; }
  .sections { display: grid; gap: 6px; max-height: 270px; overflow: auto; }
  fieldset { border: 1px solid #53586a; border-radius: 4px; padding: 6px; min-width: 0; display: grid; gap: 5px; }
  legend { color: #e6d6a1; }
  li { margin: 4px 0; } li small { color: #aaa; }
  .error { color: #ff9e9e; }
</style>
