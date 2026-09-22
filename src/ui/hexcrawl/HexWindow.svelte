<script lang="ts">
  /**
   * D-271 (plan §5.3) — the `hex` window: one cell, everything the table knows about it.
   *
   * The Phase 2 slice of the plan's list: the terrain select, the GM's description, the player
   * description, the attached encounter tables as rows with their **tag chips** (a chip that is
   * off looks off — that is requirement 5's "the GM can turn Night off for this table", visible
   * from the hex that uses it), the feature rows with their reveal rule and the GM's reveal
   * checkbox (requirement 8's manual path), and the roll button — disabled here, because rolling
   * from a table is Phase 3's results window.
   *
   * D-273 adds the one thing the window was still promising: the table rows roll. In `manual`
   * mode those rows are the *only* trigger (plan §6 rule 6), and in the other two modes they are
   * the GM's override — the ledger write is the same either way, so a table rolled by hand cannot
   * also fire on the next footstep.
   *
   * D-274 adds the other half of requirement 5d: the encounters this hex remembers. The results
   * window writes a log row on the cell (`core/hexcrawl/encounter.ts`'s `encounterLogOf`), the
   * linked battle scene's id and all — and a log nobody can read is a log that does not exist, so
   * the window lists the last few and the scene row is the click back (plan §5.6's "the return trip
   * is one click"). The rows are GM-only, like the rest of the encounter block: the log names tables
   * and rolls, which is exactly what a player must not read.
   *
   * D-275 finishes the feature half of requirement 8 in the same section: every row states its
   * rule in plain words (a GM who cannot read the rule cannot rule on it), carries the **automatic
   * reveal** switch that lets the engine apply it while the party is away, shows the art the GM
   * attached (and the time the party has spent in the hex, which is what a `time` rule counts), and
   * the GM's reveal checkbox stays the manual path it has always been. The *art* is imported
   * through the app's own asset pipeline — the same `importImage` the scene wizard uses for the
   * map — and read back through `resolveAsset`, so an unrevealed feature's picture is never
   * fetched by a client that does not hold the feature (projection strips it; D-271's security
   * rule, unchanged here).
   *
   * Every write goes through `core/hexcrawl/scene.ts`'s op builders, and the terrain row goes
   * through the *same* `applyHexMenuEntry` the canvas menu calls, so the window and the menu
   * cannot disagree about what "make this hex forest" means. A cell that has never been authored
   * is created by the first edit — one envelope, with the edit inside the create, because the
   * host refuses an op that references a document created beside it (D-270's lesson).
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type {
    CellDocument,
    CellFeature,
    EncounterTableDocument,
    SceneDocument,
  } from "../../core/documents";
  import {
    addFeatureOps,
    createCellOps,
    patchFeatureOps,
    removeFeatureOps,
    revealCellsOps,
    revealFeatureOps,
    updateCellOps,
  } from "../../core/hexcrawl/scene";
  import { encounterLogOf } from "../../core/hexcrawl/encounter";
  import {
    exploredSecondsOf,
    featureRuleLabel,
    formatDuration,
  } from "../../core/hexcrawl/features";
  import type { EncounterLogEntry } from "../../core/hexcrawl/encounter";
  import { encounterTagsOf, TAG_KEYS } from "../../core/hexcrawl/tables";
  import type { EncounterMode } from "../../core/hexcrawl/types";
  import type { TerrainCatalog } from "../../core/hexcrawl/terrain";
  import { terrainCatalogOrDefault } from "../../core/hexcrawl/terrain";
  import { hexcrawlProfileOf } from "../../core/hexcrawl/types";
  import { worldSettingsFrom } from "../../core/worldSettings";
  import { applyHexMenuEntry, terrainEntryId } from "./hexContextMenu";

  let {
    client,
    bus,
    sceneId,
    cellKey,
    onAttachTable = null,
    onRollTable = null,
    onOpenScene = null,
    importImage = null,
    resolveAsset = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    sceneId: string;
    cellKey: string;
    /** D-272: the window's *Attach encounter table…* button; the shell owns window opening. */
    onAttachTable?: (() => void) | null;
    /** D-273: roll one of this hex's tables by hand — the shell owns the draw and the ledger. */
    onRollTable?: ((tableId: string) => void) | null;
    /** D-274: open the battle scene an encounter was played on — the shell owns scene activation. */
    onOpenScene?: ((sceneId: string) => void) | null;
    /** D-275: the app's asset pipeline, for a hidden feature's own picture (as the wizard's map). */
    importImage?: ((file: File) => Promise<{ hash: string }>) | null;
    /** D-275: an asset hash (or URL) → something an `<img>` can load, when the app has it ready. */
    resolveAsset?: ((hash: string) => string | null) | null;
  } = $props();

  let scene = $state<SceneDocument | null>(null);
  let cell = $state<CellDocument | null>(null);
  let catalog = $state<TerrainCatalog>(terrainCatalogOrDefault(undefined));
  let closed = $state(true);
  let isGM = $state(false);
  let tables = $state<EncounterTableDocument[]>([]);
  let log = $state<EncounterLogEntry[]>([]);
  let spentSeconds = $state(0);
  /** The image import's own error line (a failed import is the one thing that must be visible). */
  let featureError = $state("");
  let sceneNames = $state<Record<string, string>>({});
  let mode = $state<EncounterMode>("prompt");
  let textDraft = $state({ description: "", playerText: "" });
  let newFeature = $state({
    name: "",
    text: "",
    rule: "manual" as "manual" | "perception" | "time" | "dice",
    dc: 15,
    seconds: 3600,
    formula: "1d20",
    target: 15,
    /** The automatic half of requirement 8: revealed by the rule itself, on the client holding it. */
    auto: false,
  });

  function refresh(): void {
    const doc = client.store.get("scenes", sceneId);
    scene = doc ?? null;
    cell = (doc?.cells ?? []).find((c) => c.key === cellKey) ?? null;
    catalog = terrainCatalogOrDefault(
      worldSettingsFrom(client.store.getAll("settings"))["hexTerrain"],
    );
    const profile = doc ? hexcrawlProfileOf(doc) : null;
    closed = !(profile?.revealed ?? []).includes(cellKey);
    mode = profile?.encounterMode ?? "prompt";
    isGM = client.user?.role === "GM";
    const ids = new Set(cell?.tables ?? []);
    tables = client.store
      .getAll("encounterTables")
      .filter((t) => ids.has(t._id)) as EncounterTableDocument[];
    log = encounterLogOf(doc, cellKey);
    // D-275: the counter a `time` rule reads (a march through this hex, hours of exploring).
    spentSeconds = exploredSecondsOf(cell);
    // A scene can be deleted out from under a log row, so the name is resolved per row, not stored.
    sceneNames = Object.fromEntries(
      client.store.getAll("scenes").map((sc) => [sc._id, sc.name]),
    );
    textDraft = {
      description: cell?.description ?? "",
      playerText: cell?.playerText ?? "",
    };
  }

  onMount(() => {
    refresh();
    const offOps = bus.on("ops", refresh);
    const offSnapshot = bus.on("snapshot", refresh);
    return () => {
      offOps();
      offSnapshot();
    };
  });

  const nextId = () => globalThis.crypto.randomUUID();

  /** One write path for every field: patch an existing cell, or create it with the patch. */
  function writeCell(patch: Partial<Omit<CellDocument, "_id" | "type" | "key">>): void {
    if (!scene) return;
    const ops = cell
      ? updateCellOps(scene, cellKey, patch)
      : createCellOps(scene, nextId(), { key: cellKey, ...patch });
    if (ops.length) client.submit(ops);
  }

  function setTerrain(id: string): void {
    if (!scene) return;
    const result = applyHexMenuEntry({
      scene,
      key: cellKey,
      entryId: terrainEntryId(id),
      user: client.user ?? null,
      nextId,
    });
    if (result.ops.length) client.submit(result.ops);
  }

  function toggleReveal(): void {
    if (!scene) return;
    const ops = closed
      ? revealCellsOps(scene, [cellKey])
      : revealCellsOps(scene, [], [cellKey]);
    if (ops.length) client.submit(ops);
  }

  function commitText(): void {
    const patch: Partial<CellDocument> = {};
    if (textDraft.description !== (cell?.description ?? ""))
      patch.description = textDraft.description;
    if (textDraft.playerText !== (cell?.playerText ?? ""))
      patch.playerText = textDraft.playerText;
    if (Object.keys(patch).length === 0) return;
    writeCell(patch);
  }

  function addFeature(): void {
    if (!scene || newFeature.name.trim() === "") return;
    const reveal: CellFeature["reveal"] =
      newFeature.rule === "perception"
        ? { kind: "perception", dc: Math.max(0, Math.trunc(newFeature.dc)) }
        : newFeature.rule === "time"
          ? { kind: "time", seconds: Math.max(0, Math.trunc(newFeature.seconds)) }
          : newFeature.rule === "dice"
            ? {
                kind: "dice",
                formula: newFeature.formula,
                target: Math.trunc(newFeature.target),
              }
            : { kind: "manual" };
    const feature: CellFeature = {
      id: nextId(),
      name: newFeature.name.trim(),
      text: newFeature.text,
      reveal,
      // D-275: the rule is evaluated by the client that holds the feature whenever time passes in
      // this hex (a march through it, an hour of exploring). Off = the GM's checkbox is the switch,
      // and the rule is a note to rule on — the "automatic or checkbox" of requirement 8.
      autoReveal: newFeature.auto,
      state: { revealed: false },
    };
    if (cell) {
      client.submit(addFeatureOps(scene, cellKey, feature));
    } else {
      client.submit(
        createCellOps(scene, nextId(), { key: cellKey, features: [feature] }),
      );
    }
    newFeature = { ...newFeature, name: "", text: "" };
  }

  /** The automatic half (requirement 8): the rule is applied by the client that holds it. */
  function setFeatureAuto(id: string, autoReveal: boolean): void {
    if (!scene) return;
    client.submit(patchFeatureOps(scene, cellKey, id, { autoReveal }));
  }

  /** Attach a picture to a hidden feature — the map wizard's own import path, one feature down. */
  async function pickFeatureImage(id: string, files: FileList | null | undefined): Promise<void> {
    const file = files?.[0];
    if (!file || !scene) return;
    if (!importImage) {
      featureError = "The world's asset pipeline is not ready yet.";
      return;
    }
    featureError = "";
    try {
      const { hash } = await importImage(file);
      client.submit(patchFeatureOps(scene, cellKey, id, { img: hash }));
    } catch (err) {
      featureError = `image import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The rule as a form: the same three fields the add row uses, for a feature already authored. */
  function setFeatureRule(id: string, patch: Partial<CellFeature["reveal"]>): void {
    if (!scene) return;
    const feature = (cell?.features ?? []).find((f) => f.id === id);
    if (!feature) return;
    client.submit(
      patchFeatureOps(scene, cellKey, id, {
        reveal: { ...feature.reveal, ...patch } as CellFeature["reveal"],
      }),
    );
  }

  function toggleFeature(id: string, revealed: boolean): void {
    if (!scene) return;
    const ops = revealFeatureOps(scene, cellKey, id, revealed, { by: client.user?.id });
    if (ops.length) client.submit(ops);
  }

  function removeFeature(id: string): void {
    if (!scene) return;
    client.submit(removeFeatureOps(scene, cellKey, id));
  }

  const FEATURE_RULES = [
    { id: "manual", label: "GM reveals" },
    { id: "perception", label: "Perception DC" },
    { id: "time", label: "Time spent" },
    { id: "dice", label: "Dice roll" },
  ] as const;
</script>

<div class="hex-window" data-hex-window={cellKey} data-hex-key={cellKey}>
  <header>
    <strong data-hex-name>{cell?.name && cell.name !== "" ? cell.name : cellKey}</strong>
    <span class="state" data-hex-state>{closed ? "closed to players" : "open to players"}</span>
    {#if isGM}
      <button type="button" data-hex-reveal onclick={toggleReveal}>
        {closed ? "Open to players" : "Close to players"}
      </button>
    {/if}
  </header>

  {#if isGM}
    <label class="field">
      Terrain
      <select
        data-hex-terrain
        value={cell?.terrain ?? ""}
        onchange={(e) => setTerrain((e.target as HTMLSelectElement).value)}
      >
        <option value="" disabled>— pick terrain —</option>
        {#each catalog.terrains as terrain (terrain.id)}
          <option value={terrain.id}>{terrain.name}</option>
        {/each}
      </select>
    </label>
    <label class="field">
      What is really here (GM only)
      <textarea
        data-hex-gm-text
        rows="3"
        value={textDraft.description}
        oninput={(e) => (textDraft.description = (e.target as HTMLTextAreaElement).value)}
        onblur={commitText}
      ></textarea>
    </label>
  {/if}

  <label class="field">
    {isGM ? "What players read when this hex is open" : "What the party knows"}
    <textarea
      data-hex-player-text
      rows="3"
      value={textDraft.playerText}
      oninput={(e) => (textDraft.playerText = (e.target as HTMLTextAreaElement).value)}
      onblur={commitText}
    ></textarea>
  </label>

  <h4>Encounter tables here</h4>
  {#if isGM}
    <p class="hint" data-hex-encounter-mode={mode}>
      {#if mode === "auto"}
        This scene rolls by itself when the party enters, moves or fights here — a row below rolls
        one by hand.
      {:else if mode === "manual"}
        This scene is <strong>manual</strong>: nothing rolls on its own, and these rows are the
        trigger.
      {:else}
        This scene <strong>asks the GM</strong>: an eligible table posts a pending card in the log
        instead of rolling. A row below rolls one right now.
      {/if}
    </p>
  {/if}
  {#if isGM}
    <button type="button" data-hex-attach-table onclick={() => onAttachTable?.()}>
      Attach encounter table…
    </button>
  {/if}
  {#if tables.length === 0}
    <p class="hint" data-hex-tables-empty>
      No table is attached to this hex yet — <em>Attach encounter table…</em> opens the tables
      window, where a new table can be written for this hex.
    </p>
  {:else}
    {#each tables as table (table._id)}
      {@const tags = encounterTagsOf(table)}
      <div class="table-row" data-hex-table-row={table._id}>
        <span class="table-name">{table.name}</span>
        {#each TAG_KEYS as tag (tag)}
          <span class="chip" class:off={!tags[tag]} data-hex-tag={`${table._id}:${tag}`}>
            {tag}
          </span>
        {/each}
        <button
          type="button"
          data-hex-roll={table._id}
          title={mode === "manual"
            ? "this scene is manual — this button is the trigger"
            : "roll it by hand; the table's cooldown starts either way"}
          onclick={() => onRollTable?.(table._id)}
          >Roll…</button
        >
      </div>
    {/each}
  {/if}

  {#if isGM && log.length > 0}
    <h4>Encounters here</h4>
    {#each log as row, i (i)}
      <div class="table-row" data-hex-encounter-row={i}>
        <span class="table-name">{row.tableName}</span>
        <span class="hint" data-hex-encounter-roll={i}>{row.roll}</span>
        <span class="hint">{row.text}</span>
        {#if row.sceneId && sceneNames[row.sceneId]}
          <button
            type="button"
            data-hex-encounter-open={i}
            title="open the battle scene this encounter was played on"
            onclick={() => onOpenScene?.(row.sceneId ?? "")}>{sceneNames[row.sceneId]}</button
          >
        {/if}
      </div>
    {/each}
  {/if}

  <h4>Hidden features</h4>
  {#if isGM && spentSeconds > 0}
    <p class="hint" data-hex-explored={spentSeconds}>
      {formatDuration(spentSeconds)} spent in this hex so far.
    </p>
  {/if}
  {#if (cell?.features ?? []).length === 0}
    <p class="hint" data-hex-features-empty>Nothing hidden here yet.</p>
  {/if}
  {#each cell?.features ?? [] as feature (feature.id)}
    <div class="feature-row" data-hex-feature-row={feature.id}>
      <label class="reveal">
        <input
          type="checkbox"
          data-hex-feature-reveal={feature.id}
          checked={feature.state.revealed}
          disabled={!isGM}
          onchange={(e) =>
            toggleFeature(feature.id, (e.target as HTMLInputElement).checked)}
        />
        <span>{feature.name}</span>
      </label>
      <span class="rule" data-hex-feature-rule={feature.id}>{featureRuleLabel(feature)}</span>
      {#if isGM && feature.reveal.kind !== "manual"}
        <input
          class="rule-value"
          type="number"
          min="0"
          data-hex-feature-rule-value={feature.id}
          value={feature.reveal.kind === "perception"
            ? feature.reveal.dc
            : feature.reveal.kind === "time"
              ? feature.reveal.seconds
              : feature.reveal.target}
          onchange={(e) => {
            const value = Math.max(0, Math.trunc(Number((e.target as HTMLInputElement).value)));
            if (feature.reveal.kind === "perception") setFeatureRule(feature.id, { dc: value });
            else if (feature.reveal.kind === "time") setFeatureRule(feature.id, { seconds: value });
            else if (feature.reveal.kind === "dice") setFeatureRule(feature.id, { target: value });
          }}
        />
      {/if}
      {#if feature.img}
        {@const art = resolveAsset?.(feature.img) ?? null}
        {#if art}
          <img class="feature-art" data-hex-feature-art={feature.id} src={art} alt={feature.name} />
        {/if}
      {/if}
      {#if isGM}
        <label class="auto" title="let the rule reveal it on its own">
          <input
            type="checkbox"
            data-hex-feature-auto={feature.id}
            checked={feature.autoReveal}
            onchange={(e) =>
              setFeatureAuto(feature.id, (e.target as HTMLInputElement).checked)}
          />
          auto
        </label>
        <label class="auto">
          Art…
          <input
            type="file"
            accept="image/*"
            data-hex-feature-image={feature.id}
            onchange={(e) =>
              void pickFeatureImage(feature.id, (e.target as HTMLInputElement).files)}
          />
        </label>
        <button
          type="button"
          data-hex-feature-remove={feature.id}
          onclick={() => removeFeature(feature.id)}>Remove</button
        >
      {/if}
    </div>
  {/each}
  {#if featureError}<p class="error" data-hex-feature-error>{featureError}</p>{/if}

  {#if isGM}
    <div class="add-feature">
      <input
        data-hex-feature-name
        placeholder="New feature (a shrine, a lair…)"
        value={newFeature.name}
        oninput={(e) => (newFeature.name = (e.target as HTMLInputElement).value)}
      />
      <select
        data-hex-feature-rule-input
        value={newFeature.rule}
        onchange={(e) =>
          (newFeature.rule = (e.target as HTMLSelectElement).value as typeof newFeature.rule)}
      >
        {#each FEATURE_RULES as rule (rule.id)}
          <option value={rule.id}>{rule.label}</option>
        {/each}
      </select>
      {#if newFeature.rule === "perception"}
        <input
          type="number"
          data-hex-feature-dc
          min="0"
          value={newFeature.dc}
          oninput={(e) => (newFeature.dc = Number((e.target as HTMLInputElement).value))}
        />
      {:else if newFeature.rule === "time"}
        <input
          type="number"
          data-hex-feature-seconds
          min="0"
          step="600"
          value={newFeature.seconds}
          oninput={(e) =>
            (newFeature.seconds = Number((e.target as HTMLInputElement).value))}
        />
      {:else if newFeature.rule === "dice"}
        <input
          data-hex-feature-formula
          value={newFeature.formula}
          oninput={(e) =>
            (newFeature.formula = (e.target as HTMLInputElement).value)}
        />
        <input
          type="number"
          data-hex-feature-target
          value={newFeature.target}
          oninput={(e) =>
            (newFeature.target = Number((e.target as HTMLInputElement).value))}
        />
      {/if}
      <label class="auto" title="revealed by its own rule, the moment it is met">
        <input type="checkbox" data-hex-feature-auto-new checked={newFeature.auto} onchange={(e) => (newFeature.auto = (e.target as HTMLInputElement).checked)} />
        auto
      </label>
      <button type="button" data-hex-feature-add onclick={addFeature}>Add</button>
    </div>
  {/if}
</div>

<style>
  .hex-window {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px;
    font-size: 0.9rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  header .state {
    flex: 1;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.92;
  }
  textarea,
  input,
  select {
    min-height: 30px;
    padding: 4px 8px;
    border: 1px solid #3c5169;
    border-radius: 6px;
    background: #131c27;
    color: inherit;
    font-size: 0.9rem;
    text-transform: none;
    letter-spacing: normal;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.75;
  }
  .hint {
    margin: 0;
    font-size: 0.82rem;
    opacity: 0.7;
  }
  .table-row,
  .feature-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .table-name {
    flex: 1;
    min-width: 120px;
  }
  .chip {
    padding: 1px 6px;
    border: 1px solid #4d7f5a;
    border-radius: 999px;
    font-size: 0.7rem;
    text-transform: uppercase;
  }
  .chip.off {
    border-color: #6b4d4d;
    opacity: 0.55;
    text-decoration: line-through;
  }
  .feature-row .reveal {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }
  .feature-row .rule {
    font-size: 0.78rem;
    opacity: 0.7;
  }
  .add-feature {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  button {
    min-height: 30px;
    padding: 4px 10px;
    border: 1px solid #3c5169;
    border-radius: 6px;
    background: #1b2027;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
