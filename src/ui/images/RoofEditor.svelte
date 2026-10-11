<script lang="ts">
  import type { SceneDocument, TileDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { FlatDiff } from "../../core/ops";
  import { ROOF_RADIUS_DEFAULT, ROOF_RADIUS_MAX, ROOF_RADIUS_MIN, describeRoof, roofGroupError, roofRadius, type RoofMode } from "../../core/roofs";
  /**
   * Slice E (D-438): the roof controls for a scene's tiles. A tile can be made overhead, its
   * fade mode, open opacity and radius set, its roof group and role chosen, and "show through
   * fog" switched on. Each change is one ordinary undoable tile update.
   */
  let { scene, client }: { scene: SceneDocument; client: ClientSync } = $props();
  let busy = $state(false), message = $state("");
  const roofs = $derived(scene.tiles.filter((tile) => tile.above).length);
  const groups = $derived([...new Set(scene.tiles.flatMap((tile) => tile.roofGroup ? [tile.roofGroup.id] : []))].sort());
  const nameOf = (tile: TileDocument) => tile.name || tile._id;

  async function save(tile: TileDocument, diff: FlatDiff, done: string): Promise<void> {
    busy = true; message = "";
    try {
      await client.submitAndWait([{ kind: "update", ref: { coll: "tiles", id: tile._id, parent: { coll: "scenes", id: scene._id } }, diff }]);
      message = `${nameOf(tile)}: ${done}`;
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
  function occlusion(tile: TileDocument, patch: Partial<TileDocument["occlusion"]>): TileDocument["occlusion"] {
    const next = { ...tile.occlusion, ...patch };
    if (next.mode !== "radial") { const { radius: _radius, ...rest } = next; void _radius; return rest; }
    return { ...next, radius: next.radius ?? ROOF_RADIUS_DEFAULT };
  }
  const setOverhead = (tile: TileDocument, above: boolean) =>
    save(tile, { above }, above ? "now a roof above tokens." : "back on the floor below tokens.");
  const setMode = (tile: TileDocument, mode: RoofMode) =>
    save(tile, { occlusion: occlusion(tile, { mode }) }, `fade set to ${mode}.`);
  function setAlpha(tile: TileDocument, percent: number) {
    if (!Number.isFinite(percent)) return;
    const alpha = Math.min(1, Math.max(0, Math.round(percent) / 100));
    void save(tile, { occlusion: occlusion(tile, { alpha }) }, `open opacity ${Math.round(alpha * 100)}%.`);
  }
  function setRadius(tile: TileDocument, radius: number) {
    if (!Number.isFinite(radius)) return;
    const r = Math.min(ROOF_RADIUS_MAX, Math.max(ROOF_RADIUS_MIN, radius));
    void save(tile, { occlusion: occlusion(tile, { radius: r }) }, `opening radius ${r} cells.`);
  }
  function setGroup(tile: TileDocument, raw: string) {
    const id = raw.trim();
    if (!id) { void save(tile, { "-=roofGroup": null }, "left its roof group."); return; }
    const roofGroup = { id, role: tile.roofGroup?.role ?? "source" as const };
    const error = roofGroupError(roofGroup);
    if (error) { message = error; return; }
    void save(tile, { roofGroup }, `joined roof group ${id}.`);
  }
  const setRole = (tile: TileDocument, role: "source" | "follower") =>
    tile.roofGroup && save(tile, { roofGroup: { id: tile.roofGroup.id, role } },
      role === "source" ? "opens its group when a token is under it." : "only follows its group.");
  const setReveal = (tile: TileDocument, reveal: boolean) =>
    save(tile, reveal ? { revealInFog: true } : { "-=revealInFog": null },
      reveal ? "shows through fog once any part of it is in sight." : "stays under the fog.");
</script>

<details class="roof-editor" data-roof-editor>
  <summary>Tiles &amp; roofs · {roofs} roof{roofs === 1 ? "" : "s"} of {scene.tiles.length} tile{scene.tiles.length === 1 ? "" : "s"}</summary>
  <p>A roof is a tile drawn above tokens. It opens for <em>your own</em> tokens with vision whose centre is on its art (or its outline when the art can't be read). A selected token narrows which of them count. Give a building's tiles one group so they open together. Use "Show through fog" so players see a roof from outside. Radial and vision openings need WebGL; the Canvas2D fallback fades the whole roof instead. "Peek under roofs" on the canvas fades the roof under your pointer, on your screen only.</p>
  {#if scene.tiles.length === 0}<p class="empty">No tiles on this scene yet. Place one from the image library.</p>{/if}
  {#each scene.tiles as tile (tile._id)}
    <div class="row" data-roof-row={tile._id}>
      <div class="head"><strong>{nameOf(tile)}</strong> <small data-roof-summary>{describeRoof(tile)}</small></div>
      <label class="check"><input type="checkbox" aria-label={`Roof ${nameOf(tile)}`} checked={tile.above} disabled={busy}
        onchange={(e) => setOverhead(tile, e.currentTarget.checked)} /> Overhead (roof)</label>
      {#if tile.above}
        <div class="grid">
          <label>Fade
            <select aria-label={`Roof fade ${nameOf(tile)}`} value={tile.occlusion.mode} disabled={busy}
              onchange={(e) => setMode(tile, e.currentTarget.value as RoofMode)}>
              <option value="roof">Whole roof</option>
              <option value="radial">Circle round token</option>
              <option value="vision">Token's sight</option>
              <option value="fade">Always faded</option>
            </select>
          </label>
          <label>Open opacity %
            <input type="number" min="0" max="100" step="5" aria-label={`Roof opacity ${nameOf(tile)}`} disabled={busy}
              value={Math.round(tile.occlusion.alpha * 100)} onchange={(e) => setAlpha(tile, Number(e.currentTarget.value))} />
          </label>
          {#if tile.occlusion.mode === "radial"}
            <label>Radius (cells)
              <input type="number" min={ROOF_RADIUS_MIN} max={ROOF_RADIUS_MAX} step="0.25" aria-label={`Roof radius ${nameOf(tile)}`} disabled={busy}
                value={roofRadius(tile)} onchange={(e) => setRadius(tile, Number(e.currentTarget.value))} />
            </label>
          {/if}
          <label>Group
            <input aria-label={`Roof group ${nameOf(tile)}`} placeholder="none" maxlength="64" list={`roof-groups-${scene._id}`} disabled={busy}
              value={tile.roofGroup?.id ?? ""} onchange={(e) => setGroup(tile, e.currentTarget.value)} />
          </label>
          {#if tile.roofGroup}
            <label>Role
              <select aria-label={`Roof role ${nameOf(tile)}`} value={tile.roofGroup.role} disabled={busy}
                onchange={(e) => setRole(tile, e.currentTarget.value as "source" | "follower")}>
                <option value="source">Opens group</option>
                <option value="follower">Follows only</option>
              </select>
            </label>
          {/if}
        </div>
        <label class="check"><input type="checkbox" aria-label={`Roof shows through fog ${nameOf(tile)}`} checked={tile.revealInFog === true} disabled={busy}
          onchange={(e) => setReveal(tile, e.currentTarget.checked)} /> Show through fog once any part is in sight</label>
      {/if}
    </div>
  {/each}
  <datalist id={`roof-groups-${scene._id}`}>{#each groups as id (id)}<option value={id}></option>{/each}</datalist>
  {#if message}<p role="status" data-roof-message>{message}</p>{/if}
</details>

<style>
  .roof-editor { border:1px solid #303944; border-radius:7px; padding:6px 8px; font-size:11px; color:#d8dee8; }
  summary { cursor:pointer; font-weight:700; }
  p { margin:5px 0; color:#9ca8b8; font-size:10.5px; }
  .row { border-top:1px solid #2a323c; padding:6px 0; display:flex; flex-direction:column; gap:4px; }
  .head small { color:#8fa1b5; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 8px; }
  label { display:flex; flex-direction:column; gap:2px; color:#bdc8d7; font-size:11px; }
  label.check { flex-direction:row; align-items:center; gap:5px; }
  input:not([type=checkbox]), select { min-width:0; width:100%; padding:3px 4px; font-size:11px; color:#e7edf6; background:#151a21; border:1px solid #394553; border-radius:4px; }
  .empty { font-style:italic; }
</style>
