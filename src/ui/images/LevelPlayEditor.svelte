<script lang="ts">
  import { isDoorWall, type SceneDocument, type RegionDocument, type Json, type WallDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { Op } from "../../core/ops";
  import { LEVEL_PLAY_FEATURE, STAIRS_V2_FEATURE, stairDoor, stairSpec, type StairBehaviorV2, type StairEdge } from "../../core/levelPlay";
  import { levelAuditFixOps, levelPlayAudit, type LevelAuditFinding, type LevelAuditFix } from "../../core/levelAudit";
  import { stairDirectionsOf, stairEdgesFor, stairEditDiff, type StairEdit } from "../../core/stairAuthoring";
  let { scene, client, draftDirty }: { scene: SceneDocument; client: ClientSync; draftDirty: boolean } = $props();
  let busy = $state(false), message = $state("");
  let floors = $state<string[]>([]), directions = $state<"both" | "up" | "down">("both"), mode = $state<"auto" | "prompt">("auto");
  let label = $state(""), secret = $state(false), source = $state(""), x = $state(0), y = $state(0), width = $state(100), height = $state(100);
  /** G-09/G-11 (D-437): pass-through trigger and an optional linked door. */
  let cross = $state(false), door = $state("");
  /** G-15 (D-433): pending activation, shown until the GM fixes, acknowledges or cancels. */
  let preflight = $state<LevelAuditFinding[] | null>(null);
  /** G-14 (D-450): the stairwell being edited in place. */
  let editing = $state<string | null>(null), edit = $state<StairEdit | null>(null);
  const parent = $derived({ coll: "scenes" as const, id: scene._id });
  const levels = $derived([...(scene.levels ?? [])].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || a._id.localeCompare(b._id)));
  const findings = $derived(levelPlayAudit(scene));
  const warnings = $derived(findings.filter((f) => f.severity !== "info"));
  const stairs = $derived((scene.regions ?? []).filter((r) => r.stairs));
  const plainRegions = $derived((scene.regions ?? []).filter((r) => !r.stairs && !r.fauxOverhead));
  const doors = $derived(scene.walls.filter((w) => isDoorWall(w)));
  const doorState = (w: WallDocument) => w.door === 1 ? "open" : w.door === 2 ? "locked" : "closed";
  const doorName = (w: WallDocument) => `${w.name && w.name !== "wall" && w.name !== w._id ? w.name : "Door"} at (${Math.round((w.c[0] + w.c[2]) / 2)}, ${Math.round((w.c[1] + w.c[3]) / 2)})`;
  const v2 = $derived(client.supportsFeature(STAIRS_V2_FEATURE));
  const levelName = (id: string) => scene.levels?.find((l) => l._id === id)?.name ?? id;
  const fixLabel: Record<LevelAuditFix, string> = {
    "walls-all": "Put these walls on every floor", "lights-all": "Put these lights on every floor",
    "tokens-by-band": "Assign tokens by elevation", "merge-stairs": "Merge into one stairwell", "drop-tokens": "Drop them to the floor below",
  };
  async function submit(ops: Op[], done: string): Promise<boolean> {
    busy = true; message = "";
    try {
      if (ops.length) await client.submitAndWait(ops);
      message = ops.length ? done : "Nothing to change.";
      return true;
    } catch (error) { message = error instanceof Error ? error.message : String(error); return false; }
    finally { busy = false; }
  }
  async function setEnabled(enabled: boolean) {
    await submit([{ kind: "update", ref: parent, diff: enabled ? { levelMode: "isolated" } : { "-=levelMode": null } }],
      enabled ? "Floor play enabled. Players follow their token through stairs; anything not on a floor is not drawn." : "Legacy scene view restored.");
    preflight = null;
  }
  async function toggle(event: Event & { currentTarget: HTMLInputElement }) {
    const enabled = event.currentTarget.checked;
    if (!enabled) { await setEnabled(false); return; }
    event.currentTarget.checked = false; // stays off until the check passes or the GM acknowledges it
    const blocking = findings.filter((f) => f.severity === "error");
    if (blocking.length) { message = blocking.map((f) => f.message).join(" "); return; }
    if (warnings.length) { preflight = warnings; message = ""; return; }
    await setEnabled(true);
  }
  async function fix(kind: LevelAuditFix) {
    const current = client.store.get("scenes", scene._id) as SceneDocument | undefined;
    if (!current) return;
    const ops = levelAuditFixOps(current, kind);
    if (await submit(ops, `${fixLabel[kind]}: ${ops.length} change${ops.length === 1 ? "" : "s"} saved. Undo is available.`) && preflight) {
      const after = client.store.get("scenes", scene._id) as SceneDocument | undefined;
      preflight = after ? levelPlayAudit(after).filter((f) => f.severity !== "info") : preflight;
      if (preflight && !preflight.length) await setEnabled(true);
    }
  }
  const floorZ = (id: string) => scene.levels?.find((l) => l._id === id)?.floorZ ?? 0;
  function edgesFor(ids: readonly string[]): StairEdge[] | undefined {
    return stairEdgesFor(ids, directions, floorZ);
  }
  function startEdit(region: RegionDocument) {
    if (!region.stairs || !("version" in region.stairs)) return;
    editing = region._id; message = "";
    edit = { name: region.name, label: region.stairs.label ?? "", levels: [...region.stairs.levels], directions: stairDirectionsOf(region.stairs, floorZ),
      area: { x: region.x, y: region.y, width: region.width, height: region.height } };
  }
  async function saveEdit(region: RegionDocument) {
    if (!edit) return;
    const diff = stairEditDiff(region, scene, edit);
    if (typeof diff === "string") { message = diff; return; }
    if (await submit([{ kind: "update", ref: { coll: "regions", id: region._id, parent }, diff: { ...diff, stairs: diff.stairs as unknown as Json } }], "Stairs updated.")) { editing = null; edit = null; }
  }
  async function createStairwell() {
    const ids = levels.map((l) => l._id).filter((id) => floors.includes(id));
    const edges = edgesFor(ids);
    if (ids.length < 2) { message = "Choose at least two floors."; return; }
    if (edges && !edges.length) { message = "Those floors have no up/down direction between them."; return; }
    const behavior: StairBehaviorV2 = { version: 2, levels: ids, mode, ...(edges ? { edges } : {}), ...(label.trim() ? { label: label.trim() } : {}), ...(secret ? { secret: true } : {}),
      ...(cross ? { trigger: "cross" as const } : {}), ...(door && doors.some((w) => w._id === door) ? { door } : {}) };
    const from = plainRegions.find((r) => r._id === source);
    const name = label.trim() || `Stairs ${ids.map(levelName).join(" ↔ ")}`;
    const ops: Op[] = from
      ? [{ kind: "update", ref: { coll: "regions", id: from._id, parent }, diff: { stairs: behavior as unknown as Json, hidden: true } }]
      : [{ kind: "create", coll: "regions", parent, data: { _id: `stairs-${crypto.randomUUID()}`, type: "region", name, ownership: { default: 0 }, flags: {}, system: {}, hidden: true,
          x, y, width, height, rotation: 0, shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: behavior } satisfies RegionDocument }];
    if (await submit(ops, cross ? "Stairwell saved. A token that passes through it or ends its move inside it travels, or its player is asked which floor."
      : "Stairwell saved. A token that ends its move inside it travels, or its player is asked which floor.")) { floors = []; label = ""; secret = false; source = ""; cross = false; door = ""; }
  }
  type StairPatch = { [K in keyof StairBehaviorV2]?: StairBehaviorV2[K] | undefined };
  function update(region: RegionDocument, patch: StairPatch, done: string) {
    if (!region.stairs || !("version" in region.stairs)) return;
    const next = { ...region.stairs, ...patch } as StairBehaviorV2;
    if (next.locked === false) delete next.locked;
    if (next.secret === false) delete next.secret;
    if (next.trigger !== "cross") delete next.trigger;
    if (!next.door) delete next.door;
    void submit([{ kind: "update", ref: { coll: "regions", id: region._id, parent }, diff: { stairs: next as unknown as Json } }], done);
  }
  function upgrade(region: RegionDocument) {
    if (!region.stairs || "version" in region.stairs) return;
    const behavior: StairBehaviorV2 = { version: 2, levels: [region.stairs.from, region.stairs.to], mode: "auto", edges: [{ from: region.stairs.from, to: region.stairs.to }] };
    void submit([{ kind: "update", ref: { coll: "regions", id: region._id, parent }, diff: { stairs: behavior as unknown as Json } }], "Converted to a stairwell. Lock, labels and choices are now available.");
  }
  function describe(region: RegionDocument): string {
    if (!region.stairs) return "";
    const spec = stairSpec(region.stairs);
    const all = spec.edges.length === spec.levels.length * (spec.levels.length - 1);
    const route = spec.legacy || !all ? spec.edges.map((e) => `${levelName(e.from)} → ${levelName(e.to)}`).join(", ") : spec.levels.map(levelName).join(" ↔ ");
    const linked = stairDoor(scene, spec);
    const doorNote = spec.door ? linked ? ` · door ${doorState(linked)}` : " · linked door missing" : "";
    return `${route}${spec.mode === "prompt" ? " · always asks" : ""}${spec.trigger === "cross" ? " · pass-through" : ""}${spec.locked ? " · locked" : ""}${doorNote}${spec.secret ? " · hidden" : ""}`;
  }
</script>
<details data-level-play>
  <summary>Floor play &amp; stairs</summary>
  <p>Assign map tiles to each level above, and walls/lights under Membership. In floor play, walls, lights and map art that are on no floor are not drawn; drawings, templates and notes without a floor appear on every floor. Each floor keeps its own remembered fog. This separates the canvas, not all network data, sheets or FX.</p>
  <fieldset disabled={busy || draftDirty || !client.supportsFeature(LEVEL_PLAY_FEATURE)}>
    <label><input aria-label="Enable isolated floor play" type="checkbox" checked={scene.levelMode === "isolated"} disabled={!scene.levels?.length} onchange={toggle} />Enable isolated floor play · follow tokens through stairs</label>
    {#if preflight}
      <div class="preflight" role="alertdialog" aria-label="Floor play check before enabling" data-level-preflight>
        <p><strong>Check before enabling floor play.</strong> Players would notice these:</p>
        <ul>{#each preflight as finding (finding.code + (finding.ids?.join() ?? ""))}<li data-audit-code={finding.code}>{finding.message}{#if finding.fix} <button type="button" onclick={() => fix(finding.fix as LevelAuditFix)}>{fixLabel[finding.fix]}</button>{/if}</li>{/each}</ul>
        <button type="button" data-level-enable-anyway onclick={() => setEnabled(true)}>Enable anyway</button>
        <button type="button" onclick={() => { preflight = null; }}>Cancel</button>
      </div>
    {/if}
    <details class="audit" data-level-audit open={warnings.length > 0 && scene.levelMode === "isolated"}>
      <summary>Floor play check · {warnings.length ? `${warnings.length} to review` : "no problems"}{findings.length > warnings.length ? ` · ${findings.length - warnings.length} note${findings.length - warnings.length === 1 ? "" : "s"}` : ""}</summary>
      {#if !findings.length}<p>Every wall, light and token is on a floor, every floor has map art and every stair has a way back.</p>{/if}
      <ul>{#each findings as finding (finding.code + (finding.ids?.join() ?? ""))}<li class={finding.severity} data-audit-code={finding.code}>{finding.message}{#if finding.fix} <button type="button" onclick={() => fix(finding.fix as LevelAuditFix)}>{fixLabel[finding.fix]}</button>{/if}</li>{/each}</ul>
    </details>
    <h4>Create stairwell</h4>
    {#if !v2}<p role="alert">Upgrade required: the host must support stairwells (scene-level-stairs-v2).</p>{/if}
    <div class="floors" role="group" aria-label="Floors this stairwell connects">
      {#each levels as l (l._id)}<label class="check"><input type="checkbox" aria-label={`Stairwell floor ${l.name}`} checked={floors.includes(l._id)} onchange={(e) => { floors = e.currentTarget.checked ? [...floors, l._id] : floors.filter((id) => id !== l._id); }} />{l.name}</label>{/each}
    </div>
    <label>Directions<select aria-label="Stair directions" bind:value={directions}><option value="both">Both ways</option><option value="up">Up only</option><option value="down">Down only</option></select></label>
    <label>On arrival<select aria-label="Stair mode" bind:value={mode}><option value="auto">Travel at once when only one floor is possible</option><option value="prompt">Always ask the player</option></select></label>
    <label>Label for players (optional)<input aria-label="Stair label" maxlength="64" bind:value={label} placeholder="Spiral stair" /></label>
    <label class="check"><input type="checkbox" aria-label="Hidden passage" bind:checked={secret} />Hidden passage: no stair marker for players</label>
    <label class="check"><input type="checkbox" aria-label="Stair trigger on pass-through" bind:checked={cross} />Also when a move passes through (stops there, or continues on the new floor)</label>
    <label>Works only while this door is open (optional)<select aria-label="Stair door" bind:value={door}><option value="">No door</option>{#each doors as w (w._id)}<option value={w._id}>{doorName(w)} · {doorState(w)}</option>{/each}</select></label>
    <label>Area<select aria-label="Stair area" bind:value={source}><option value="">Rectangle below</option>{#each plainRegions as r (r._id)}<option value={r._id}>Region: {r.name}</option>{/each}</select></label>
    {#if !source}
      <div class="bounds">
        <label>X<input aria-label="Stairs X" type="number" bind:value={x} /></label><label>Y<input aria-label="Stairs Y" type="number" bind:value={y} /></label>
        <label>Width<input aria-label="Stairs width" type="number" min="1" bind:value={width} /></label><label>Height<input aria-label="Stairs height" type="number" min="1" bind:value={height} /></label>
      </div>
      <p>Or pick the Stairs tool on the map's tool rail and drag over the stairs: they join the floor you are viewing and the next one up. Bounds use scene pixels; draw a polygon in Active Zones and pick it above for other shapes. Entry uses the token center. With several destinations, the mover chooses; "Take stairs" on the floor chip asks again while standing on them.</p>
    {/if}
    <button type="button" disabled={!v2 || floors.length < 2 || (!source && (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0))} onclick={createStairwell}>Create stairwell</button>
    {#each stairs as r (r._id)}
      {@const spec = r.stairs ? stairSpec(r.stairs) : null}
      <div class="stair" data-stair-region={r._id}>
        <span><strong>{spec?.label ?? r.name}</strong> · {describe(r)} · ({r.x}, {r.y}), {r.width} × {r.height}</span>
        {#if spec && !spec.legacy}
          <button type="button" aria-label={`${spec.locked ? "Unlock" : "Lock"} stairs ${spec.label ?? r.name}`} disabled={!v2} onclick={() => update(r, { locked: !spec.locked }, spec.locked ? "Stairs unlocked." : "Stairs locked: tokens can stand on them but not travel.")}>{spec.locked ? "Unlock" : "Lock"}</button>
          <button type="button" disabled={!v2} onclick={() => update(r, { mode: spec.mode === "auto" ? "prompt" : "auto" }, "Stair choice updated.")}>{spec.mode === "auto" ? "Always ask" : "Travel at once"}</button>
          <button type="button" disabled={!v2} onclick={() => update(r, { secret: !spec.secret }, spec.secret ? "Stairs are marked for players." : "Stairs hidden from players' markers.")}>{spec.secret ? "Show marker" : "Hide marker"}</button>
          <button type="button" aria-label={`${spec.trigger === "cross" ? "Only on ending inside" : "Pass-through"} stairs ${spec.label ?? r.name}`} disabled={!v2}
            onclick={() => update(r, { trigger: spec.trigger === "cross" ? undefined : "cross" }, spec.trigger === "cross" ? "Stairs now work only when a move ends inside." : "Stairs now also work when a move passes through.")}>{spec.trigger === "cross" ? "Only on ending inside" : "Also on pass-through"}</button>
          <label class="inline">Door<select aria-label={`Door for stairs ${spec.label ?? r.name}`} disabled={!v2} value={spec.door ?? ""}
            onchange={(e) => update(r, { door: e.currentTarget.value || undefined }, e.currentTarget.value ? "Stairs now work only while that door is open." : "Door link removed.")}>
            <option value="">No door</option>{#if spec.door && !stairDoor(scene, spec)}<option value={spec.door}>Missing door</option>{/if}{#each doors as w (w._id)}<option value={w._id}>{doorName(w)} · {doorState(w)}</option>{/each}</select></label>
        {:else if spec}
          <button type="button" disabled={!v2} onclick={() => upgrade(r)}>Convert to stairwell</button>
        {/if}
        {#if spec && !spec.legacy}
          <button type="button" aria-label={`Edit stairs ${spec.label ?? r.name}`} aria-expanded={editing === r._id} disabled={!v2}
            onclick={() => { if (editing === r._id) { editing = null; edit = null; } else startEdit(r); }}>{editing === r._id ? "Close editor" : "Edit"}</button>
        {/if}
        <button type="button" onclick={() => submit([{ kind: "delete", ref: { coll: "regions", id: r._id, parent } }], "Stairs removed.")}>Remove stairs</button>
        {#if editing === r._id && edit}
          <div class="stair-edit" role="group" aria-label={`Edit stairs ${spec?.label ?? r.name}`} data-stair-edit>
            <label>Name<input aria-label="Stairs name" maxlength="128" bind:value={edit.name} /></label>
            <label>Label for players (optional)<input aria-label="Stairs player label" maxlength="64" bind:value={edit.label} placeholder="Spiral stair" /></label>
            <div class="floors" role="group" aria-label="Floors these stairs connect">
              {#each levels as l (l._id)}<label class="check"><input type="checkbox" aria-label={`Stairs floor ${l.name}`} checked={edit.levels.includes(l._id)}
                onchange={(e) => { if (edit) edit.levels = e.currentTarget.checked ? [...edit.levels, l._id] : edit.levels.filter((id) => id !== l._id); }} />{l.name}</label>{/each}
            </div>
            <label>Directions<select aria-label="Stairs directions" bind:value={edit.directions}>
              <option value="both">Both ways</option><option value="up">Up only</option><option value="down">Down only</option>
              {#if edit.directions === "custom"}<option value="custom">Keep the current one-way moves</option>{/if}
            </select></label>
            <div class="bounds">
              <label>X<input aria-label="Edit stairs X" type="number" bind:value={edit.area.x} /></label><label>Y<input aria-label="Edit stairs Y" type="number" bind:value={edit.area.y} /></label>
              <label>Width<input aria-label="Edit stairs width" type="number" min="1" bind:value={edit.area.width} /></label><label>Height<input aria-label="Edit stairs height" type="number" min="1" bind:value={edit.area.height} /></label>
            </div>
            <button type="button" onclick={() => saveEdit(r)}>Save stairs</button>
            <button type="button" onclick={() => { editing = null; edit = null; }}>Cancel</button>
          </div>
        {/if}
      </div>
    {/each}
  </fieldset>
  {#if message}<p role="status">{message}</p>{/if}
</details>
<style>
  details { margin-top:12px; border-top:1px solid #435067; padding-top:8px; }
  summary { cursor:pointer; font-weight:600; } label { display:block; margin:8px 0; }
  .bounds { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .stair-edit { margin:6px 0 4px; padding:6px 8px; border-left:2px solid #52657a; }
  .floors { display:flex; flex-wrap:wrap; gap:4px 12px; } .check { display:flex; align-items:center; gap:6px; margin:4px 0; }
  fieldset { border:0; padding:0; min-width:0; } input:not([type=checkbox]),select { width:100%; box-sizing:border-box; background:#131b25; color:#edf3fb; border:1px solid #435067; padding:5px; }
  button { padding:5px; background:#253549; color:#edf3fb; border:1px solid #52657a; cursor:pointer; margin:2px 4px 2px 0; } button:disabled { opacity:.5; }
  p, li { font-size:11px; line-height:1.5; color:#b2bdca; } ul { padding-left:16px; margin:4px 0; }
  .audit { border-top:0; margin-top:4px; } li.warning, li.error { color:#f0c789; }
  .preflight { border:1px solid #8c7542; border-radius:4px; padding:6px 8px; background:#221d12; margin:6px 0; }
  .stair { font-size:11px; color:#b2bdca; border-top:1px dashed #33405a; padding:4px 0; overflow-wrap:anywhere; }
  .inline { display:inline-flex; align-items:center; gap:4px; margin:2px 4px 2px 0; } .inline select { width:auto; max-width:180px; }
</style>
