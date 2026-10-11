<script lang="ts">
  import type { SceneDocument, RegionDocument, Json } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { Op } from "../../core/ops";
  import { LEVEL_PLAY_FEATURE, STAIRS_V2_FEATURE, stairSpec, type StairBehaviorV2, type StairEdge } from "../../core/levelPlay";
  import { levelAuditFixOps, levelPlayAudit, type LevelAuditFinding, type LevelAuditFix } from "../../core/levelAudit";
  let { scene, client, draftDirty }: { scene: SceneDocument; client: ClientSync; draftDirty: boolean } = $props();
  let busy = $state(false), message = $state("");
  let floors = $state<string[]>([]), directions = $state<"both" | "up" | "down">("both"), mode = $state<"auto" | "prompt">("auto");
  let label = $state(""), secret = $state(false), source = $state(""), x = $state(0), y = $state(0), width = $state(100), height = $state(100);
  /** G-15 (D-433): pending activation, shown until the GM fixes, acknowledges or cancels. */
  let preflight = $state<LevelAuditFinding[] | null>(null);
  const parent = $derived({ coll: "scenes" as const, id: scene._id });
  const levels = $derived([...(scene.levels ?? [])].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || a._id.localeCompare(b._id)));
  const findings = $derived(levelPlayAudit(scene));
  const warnings = $derived(findings.filter((f) => f.severity !== "info"));
  const stairs = $derived((scene.regions ?? []).filter((r) => r.stairs));
  const plainRegions = $derived((scene.regions ?? []).filter((r) => !r.stairs && !r.fauxOverhead));
  const v2 = $derived(client.supportsFeature(STAIRS_V2_FEATURE));
  const levelName = (id: string) => scene.levels?.find((l) => l._id === id)?.name ?? id;
  const fixLabel: Record<LevelAuditFix, string> = {
    "walls-all": "Put these walls on every floor", "lights-all": "Put these lights on every floor",
    "tokens-by-band": "Assign tokens by elevation", "merge-stairs": "Merge into one stairwell",
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
  function edgesFor(ids: readonly string[]): StairEdge[] | undefined {
    if (directions === "both") return undefined;
    const z = (id: string) => scene.levels?.find((l) => l._id === id)?.floorZ ?? 0;
    return ids.flatMap((from) => ids.filter((to) => to !== from && (directions === "up" ? z(to) > z(from) : z(to) < z(from))).map((to) => ({ from, to })));
  }
  async function createStairwell() {
    const ids = levels.map((l) => l._id).filter((id) => floors.includes(id));
    const edges = edgesFor(ids);
    if (ids.length < 2) { message = "Choose at least two floors."; return; }
    if (edges && !edges.length) { message = "Those floors have no up/down direction between them."; return; }
    const behavior: StairBehaviorV2 = { version: 2, levels: ids, mode, ...(edges ? { edges } : {}), ...(label.trim() ? { label: label.trim() } : {}), ...(secret ? { secret: true } : {}) };
    const from = plainRegions.find((r) => r._id === source);
    const name = label.trim() || `Stairs ${ids.map(levelName).join(" ↔ ")}`;
    const ops: Op[] = from
      ? [{ kind: "update", ref: { coll: "regions", id: from._id, parent }, diff: { stairs: behavior as unknown as Json, hidden: true } }]
      : [{ kind: "create", coll: "regions", parent, data: { _id: `stairs-${crypto.randomUUID()}`, type: "region", name, ownership: { default: 0 }, flags: {}, system: {}, hidden: true,
          x, y, width, height, rotation: 0, shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: behavior } satisfies RegionDocument }];
    if (await submit(ops, "Stairwell saved. A token that ends its move inside it travels, or its player is asked which floor.")) { floors = []; label = ""; secret = false; source = ""; }
  }
  function update(region: RegionDocument, patch: Partial<StairBehaviorV2>, done: string) {
    if (!region.stairs || !("version" in region.stairs)) return;
    const next: StairBehaviorV2 = { ...region.stairs, ...patch };
    if (next.locked === false) delete next.locked;
    if (next.secret === false) delete next.secret;
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
    return `${route}${spec.mode === "prompt" ? " · always asks" : ""}${spec.locked ? " · locked" : ""}${spec.secret ? " · hidden" : ""}`;
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
    <label>Area<select aria-label="Stair area" bind:value={source}><option value="">Rectangle below</option>{#each plainRegions as r (r._id)}<option value={r._id}>Region: {r.name}</option>{/each}</select></label>
    {#if !source}
      <div class="bounds">
        <label>X<input aria-label="Stairs X" type="number" bind:value={x} /></label><label>Y<input aria-label="Stairs Y" type="number" bind:value={y} /></label>
        <label>Width<input aria-label="Stairs width" type="number" min="1" bind:value={width} /></label><label>Height<input aria-label="Stairs height" type="number" min="1" bind:value={height} /></label>
      </div>
      <p>Bounds use scene pixels; draw a polygon in Active Zones and pick it above for other shapes. Entry uses the token center. With several destinations, the mover chooses; "Take stairs" on the floor chip asks again while standing on them.</p>
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
        {:else if spec}
          <button type="button" disabled={!v2} onclick={() => upgrade(r)}>Convert to stairwell</button>
        {/if}
        <button type="button" onclick={() => submit([{ kind: "delete", ref: { coll: "regions", id: r._id, parent } }], "Stairs removed.")}>Remove stairs</button>
      </div>
    {/each}
  </fieldset>
  {#if message}<p role="status">{message}</p>{/if}
</details>
<style>
  details { margin-top:12px; border-top:1px solid #435067; padding-top:8px; }
  summary { cursor:pointer; font-weight:600; } label { display:block; margin:8px 0; }
  .bounds { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .floors { display:flex; flex-wrap:wrap; gap:4px 12px; } .check { display:flex; align-items:center; gap:6px; margin:4px 0; }
  fieldset { border:0; padding:0; min-width:0; } input:not([type=checkbox]),select { width:100%; box-sizing:border-box; background:#131b25; color:#edf3fb; border:1px solid #435067; padding:5px; }
  button { padding:5px; background:#253549; color:#edf3fb; border:1px solid #52657a; cursor:pointer; margin:2px 4px 2px 0; } button:disabled { opacity:.5; }
  p, li { font-size:11px; line-height:1.5; color:#b2bdca; } ul { padding-left:16px; margin:4px 0; }
  .audit { border-top:0; margin-top:4px; } li.warning, li.error { color:#f0c789; }
  .preflight { border:1px solid #8c7542; border-radius:4px; padding:6px 8px; background:#221d12; margin:6px 0; }
  .stair { font-size:11px; color:#b2bdca; border-top:1px dashed #33405a; padding:4px 0; overflow-wrap:anywhere; }
</style>
