<script lang="ts">
  /**
   * G-30 (D-449): bring a Foundry scene in. The GM picks the scene's JSON (Foundry: right-click the
   * scene → Export Data), reads what will arrive, optionally picks the image files it uses, and
   * creates the scene in one undoable step. Floors arrive as drafts; floor play is turned on after
   * the floor-play check, like any other scene.
   */
  import type { ClientSync } from "../../client/sync";
  import { foundrySourceLabel, planFoundryImport } from "../../core/foundryImport";

  let {
    client,
    uploadImage,
    onActivate,
  }: {
    client: ClientSync;
    /** Stores one picked image and returns its reference (same upload gate as other map images). */
    uploadImage?: (file: File) => Promise<{ hash: string }>;
    onActivate?: (sceneId: string) => void;
  } = $props();

  const MAX_BYTES = 50 * 1024 * 1024;
  const newId = () => globalThis.crypto.randomUUID().replace(/-/g, "");

  let source = $state<unknown>(undefined);
  let fileName = $state("");
  let images = $state(new Map<string, string>());
  let sceneId = $state(newId());
  let error = $state("");
  let status = $state("");
  let busy = $state(false);
  let createdId = $state<string | null>(null);

  const result = $derived(source === undefined ? null : planFoundryImport(source, { sceneId, nextId: newId, images }));
  const linkedCount = $derived(result?.ok ? result.report.images.filter((i) => i.linked).length : 0);

  const band = (bottom: number | null, top: number | null) => `${bottom ?? "−∞"} to ${top ?? "∞"}`;

  async function pickScene(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    error = ""; status = ""; createdId = null; images = new Map(); sceneId = newId(); fileName = file.name;
    if (file.size > MAX_BYTES) { source = undefined; error = "That file is over 50 MB; a scene export is much smaller."; return; }
    try { source = JSON.parse(await file.text()); }
    catch { source = undefined; error = `${file.name} is not valid JSON.`; }
  }

  async function pickImages(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (!result?.ok || !uploadImage || !files.length) return;
    const wanted = new Set(result.report.images.map((i) => i.name));
    const matching = files.filter((f) => wanted.has(f.name.toLowerCase()));
    const unused = files.length - matching.length;
    busy = true; error = ""; status = `Storing ${matching.length} image(s)…`;
    const linked: Array<[string, string]> = [];
    let failed = 0;
    for (const file of matching) {
      try { linked.push([file.name.toLowerCase(), (await uploadImage(file)).hash]); }
      catch { failed++; }
    }
    images = new Map([...images, ...linked]); busy = false;
    status = [`${matching.length - failed} image(s) linked`, unused ? `${unused} file(s) are not used by this scene` : "", failed ? `${failed} could not be stored` : ""].filter(Boolean).join("; ") + ".";
  }

  async function create(): Promise<void> {
    if (!result?.ok) return;
    busy = true; error = "";
    try {
      await client.submitAndWait([{ kind: "create", coll: "scenes", data: result.scene }]);
      createdId = result.scene._id;
      status = `Created “${result.report.name}”. Undo removes it.`;
      source = undefined;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally { busy = false; }
  }
</script>

<details class="foundry-import" data-foundry-import>
  <summary>Import a Foundry scene</summary>
  <p class="fine">In Foundry, right-click the scene and choose Export Data, then pick the JSON file here. Floors from the Levels module (Foundry V10–V13) or Foundry V14 scene levels arrive as drafts, with wall heights, stairs and floor art.</p>
  <label>Foundry scene file (.json)
    <input type="file" accept=".json,application/json" data-foundry-file disabled={busy} onchange={pickScene} />
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if result && !result.ok}<p class="error" role="alert" data-foundry-error>{fileName}: {result.error}</p>{/if}
  {#if result?.ok}
    {@const report = result.report}
    <div class="report" data-foundry-report>
      <p class="title"><strong>{report.name}</strong> · <span data-foundry-source>{foundrySourceLabel(report.source)}</span></p>
      <p data-foundry-counts>{report.counts.walls} walls · {report.counts.lights} lights · {report.counts.tiles} tiles · {report.counts.tokens} tokens · {report.counts.stairs} stairs</p>
      {#if report.floors.length}
        <table data-foundry-floors>
          <thead><tr><th>Floor</th><th>Height</th><th>Walls</th><th>Lights</th><th>Art</th><th>Tokens</th><th>Stairs</th></tr></thead>
          <tbody>
            {#each report.floors as floor (floor.id)}
              <tr data-foundry-floor={floor.name}><td>{floor.name}</td><td>{band(floor.bottom, floor.top)}</td><td>{floor.walls}</td><td>{floor.lights}</td><td>{floor.tiles}</td><td>{floor.tokens}</td><td>{floor.stairs}</td></tr>
            {/each}
          </tbody>
        </table>
        <p class="fine" data-foundry-every-floor>On every floor: {report.everyFloor.walls} walls, {report.everyFloor.lights} lights.</p>
      {/if}
      {#if report.skipped.length}
        <p class="fine" data-foundry-skipped>Not imported: {report.skipped.map((s) => `${s.count} ${s.what}`).join(" · ")}</p>
      {/if}
      {#each report.notes as note (note)}<p class="fine note" data-foundry-note>{note}</p>{/each}
      {#if report.images.length}
        <div class="images" data-foundry-images>
          <p><strong>Images</strong> · <span data-foundry-linked>{linkedCount} of {report.images.length} have a file</span></p>
          <ul>
            {#each report.images as img (img.path)}
              <li data-foundry-image={img.name} data-linked={img.linked ? "true" : "false"} title={img.path}><span aria-hidden="true">{img.linked ? "✓" : "–"}</span> {img.name}{img.uses > 1 ? ` ×${img.uses}` : ""}</li>
            {/each}
          </ul>
          {#if uploadImage}
            <label>Pick image files (matched by file name)
              <input type="file" accept="image/*" multiple data-foundry-image-files disabled={busy} onchange={pickImages} />
            </label>
          {/if}
        </div>
      {/if}
      <button type="button" class="primary" data-foundry-create disabled={busy} onclick={create}>Create scene</button>
    </div>
  {/if}
  {#if status}
    <p class="saved" role="status" data-foundry-status>{status}
      {#if createdId && onActivate}<button type="button" class="link" onclick={() => createdId && onActivate?.(createdId)}>Open it</button>{/if}
    </p>
  {/if}
</details>

<style>
  .foundry-import { border:1px solid #303944; border-radius:7px; padding:8px; font-size:11px; color:#d8dee8; }
  summary { cursor:pointer; font-weight:700; }
  label { display:flex; flex-direction:column; gap:4px; margin:7px 0; color:#bdc8d7; font-size:11px; font-weight:400; }
  input[type=file] { color:#cbd7e5; font-size:10px; }
  p { margin:4px 0; font-size:11px; }
  .fine { color:#91a0b1; font-size:10px; }
  .note { border-left:2px solid #42a99a66; padding-left:6px; }
  .error { color:#ffc0b4; border:1px solid #8e453e; padding:7px; border-radius:5px; }
  .report { display:flex; flex-direction:column; gap:4px; margin-top:6px; padding-top:6px; border-top:1px solid #303944; }
  .report p.title { font-size:12px; }
  table { border-collapse:collapse; width:100%; font-size:10px; }
  th, td { text-align:left; padding:2px 4px; border-bottom:1px solid #262e38; }
  th { color:#98a5b5; font-weight:600; }
  ul { list-style:none; margin:2px 0; padding:0; max-height:120px; overflow:auto; }
  li { color:#bdc8d7; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  li[data-linked="true"] span { color:#8dd6c7; }
  .primary { align-self:flex-start; border:1px solid #3d8b7f; background:#173c36; color:#e5fff8; border-radius:6px; padding:6px 10px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .saved { color:#8dd6c7; font-size:10px; }
  .link { background:none; border:none; color:#9fd8ff; text-decoration:underline; cursor:pointer; padding:0 2px; font-size:10px; }
</style>
