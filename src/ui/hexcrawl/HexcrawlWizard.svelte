<script lang="ts">
  /**
   * New-hexcrawl-scene wizard (D-270, plan §5.1) — **map → grid → party**, then two envelopes.
   *
   * The wizard is deliberately a *form with three steps*, not a general scene editor: everything
   * it needs is data the model already understands (a map asset, a `SceneGrid`, an optional party
   * token), and the ops it submits come from `newHexcrawlSceneOps` / `newHexcrawlPartyOps` in
   * core, which are the same functions the Node tests drive. So the browser path and the unit path
   * cannot drift.
   *
   * It boots a hexcrawl scene the way the plan's requirement list asks: the map can be uploaded
   * here (the file goes through the host's ordinary asset pipeline, so it is an asset like any
   * other map), the grid is chosen per scene (hex layout / square / gridless, cell size in pixels
   * and "1 cell = N units" — the reference scale), and the party token is created from the scene
   * as it landed, because the profile has to name it and the host will not validate an op that
   * references a document created in the same envelope (see `create()`).
   *
   * The step-by-step readout (`data-hx-cells`, `data-hx-scale`) is the wizard's honesty: the GM
   * sees the cell count their map will have *before* creating it, and the daily march the scale
   * implies.
   */
  import type { ClientSync } from "../../client/sync";
  import type { SceneDocument, SceneGrid } from "../../core/documents";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { Op } from "../../core/ops";
  import { planImageAction } from "../../core/imageActions";
  import {
    DEFAULT_SCENE_EXPRESS_DEFAULTS,
    uniqueSceneName,
    type SceneExpressDefaults,
  } from "../../core/imageHandling";
  import { fitImageToScene, normalizeLogicalFolder } from "../../core/imageSizing";
  import {
    DEFAULT_SPEED_PER_DAY,
    cellCensus,
    hexTerrainSettingsOps,
    newHexcrawlPartyOps,
    newHexcrawlSceneOps,
  } from "../../core/hexcrawl";

  let {
    client,
    bus,
    importImage,
    sceneDefaults = DEFAULT_SCENE_EXPRESS_DEFAULTS,
    onCreated,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    /**
     * The map-import path for a **new scene** (the same upload the Scenes & Images panel's New scene
     * uses: the destination folder, duplicate policy and WebP settings of the image system). Null
     * when boot has no host yet.
     */
    importImage:
      | ((file: File) => Promise<{ hash: string; width?: number; height?: number; thumbnail?: string | null }>)
      | null;
    /** The GM's new-scene defaults (design §5.2/SZ-13), from the world settings. */
    sceneDefaults?: SceneExpressDefaults;
    onCreated: (sceneId: string) => void;
  } = $props();

  type Step = "map" | "grid" | "party";
  const STEPS: readonly Step[] = ["map", "grid", "party"];
  const STEP_TITLE: Record<Step, string> = {
    map: "Map image",
    grid: "Grid and scale",
    party: "The party",
  };

  const DEFAULT_WIDTH = 2000;
  const DEFAULT_HEIGHT = 1500;

  let step = $state<Step>("map");
  let name = $state("Overland map");
  let busy = $state(false);
  let error = $state("");

  /** The imported asset, once the host has it (the scene is created with this image). */
  let mapImport = $state<{ hash: string; width?: number; height?: number; thumbnail?: string | null } | null>(null);
  let mapName = $state("");
  let dragging = $state(false);

  let gridType = $state<SceneGrid["type"]>("hex");
  let hexLayout = $state<SceneGrid["hexLayout"]>("oddQ");
  let cellSize = $state(100);
  let cellDistance = $state(6);
  let units = $state("mi");

  let partyOn = $state(true);
  let partyName = $state("Party");

  /**
   * Image maps only (design §6.3): **match** the scene to the picture's pixel size, or keep a chosen
   * size and **fit** the picture into it, centred with its aspect kept. Without an image the scene is
   * the usual open ground and there is nothing to choose.
   */
  let sizeMode = $state<"matchImage" | "fitImage">("matchImage");
  let fitWidth = $state(DEFAULT_WIDTH);
  let fitHeight = $state(DEFAULT_HEIGHT);

  const imagePixels = $derived(
    mapImport?.width && mapImport?.height
      ? { width: Math.round(mapImport.width), height: Math.round(mapImport.height) }
      : null,
  );

  const sceneSize = $derived.by(() => {
    if (!mapImport) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    if (sizeMode === "fitImage" && imagePixels) {
      return { width: Math.max(1, Math.round(fitWidth)), height: Math.max(1, Math.round(fitHeight)) };
    }
    return imagePixels ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  });

  /** The picture's placement inside the scene: identity when matching, the fitted rectangle otherwise. */
  const placement = $derived.by(() => {
    if (mapImport && sizeMode === "fitImage" && imagePixels) {
      return fitImageToScene(imagePixels, sceneSize);
    }
    return { scale: 1, offset: { x: 0, y: 0 } };
  });

  const grid = $derived<SceneGrid>({
    type: gridType,
    size: Math.max(1, Math.round(cellSize)),
    distance: Math.max(0, cellDistance),
    units,
    diagonals: "555",
    hexLayout,
  });

  /**
   * The scene the readout counts, built in memory: `cellsInMap`/`cellCensus` are pure and only
   * need the grid and the map size, so the wizard never has to create a document to answer
   * "how many cells is that?".
   */
  const preview = $derived<SceneDocument>({
    _id: "hx-preview",
    type: "scene",
    name,
    ownership: { default: 1 },
    flags: {},
    system: {},
    active: false,
    img: null,
    width: sceneSize.width,
    height: sceneSize.height,
    darkness: 0,
    grid,
    tokens: [],
    walls: [],
    lights: [],
    drawings: [],
    templates: [],
    notes: [],
    tiles: [],
    sounds: [],
  });
  const census = $derived(cellCensus(preview));
  const perDayCells = $derived(
    gridType === "gridless" || cellDistance <= 0
      ? null
      : Math.floor(DEFAULT_SPEED_PER_DAY / cellDistance),
  );
  const stepIndex = $derived(STEPS.indexOf(step));

  async function pickMap(files: FileList | null | undefined): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    if (!importImage) {
      error = "The world's asset pipeline is not ready yet — import the map from the sidebar instead.";
      return;
    }
    busy = true;
    error = "";
    try {
      mapImport = await importImage(file);
      mapName = file.name;
    } catch (err) {
      error = `map import failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
    }
  }

  function go(next: Step | "back"): void {
    error = "";
    if (next === "back") {
      step = STEPS[Math.max(0, stepIndex - 1)] ?? "map";
      return;
    }
    step = next;
  }

  /**
   * The ops for a scene built from a picture. The image system's own planner writes the scene (its
   * defaults, unique name, folder, thumbnail, background placement), and the hexcrawl settings ride
   * along in the same batch. Two overrides are hexcrawl's, not the image system's: the map stays
   * shared with the table (the party token is the viewer), and sight is hex-based, so token vision
   * and core fog exploration are off whatever the image defaults say.
   */
  function imageSceneOps(id: string, sceneName: string, scenes: readonly SceneDocument[]): Op[] {
    const image = mapImport;
    if (!image) return [];
    const plan = planImageAction({
      action: "newScene",
      image: image.hash,
      name: sceneName,
      width: imagePixels?.width ?? sceneSize.width,
      height: imagePixels?.height ?? sceneSize.height,
      scene: null,
      scenes,
      journals: [],
      selectedTokenIds: [],
      sceneDefaults: {
        ...sceneDefaults,
        ownership: "all",
        tokenVision: false,
        fogExploration: false,
      },
      newSceneId: id,
      newTileId: "",
      newJournalId: "",
      newPageId: "",
      targetJournalId: "",
      autoCreateJournal: false,
      autoCreateJournalName: "",
      logicalFolder: normalizeLogicalFolder(sceneDefaults.destinationLogicalFolder),
      thumbnail: image.thumbnail ?? null,
      background: { offset: placement.offset, scale: placement.scale, padding: 0, color: "#ffffff" },
      sceneSize,
      resizeChoice: "keep",
      grid,
      assetGridSize: Math.max(1, Math.round(cellSize)),
      foregroundElevation: 0,
      activateNewScene: true,
    });
    return [...plan.ops, ...hexTerrainSettingsOps(client.store.getAll("settings"))];
  }

  /**
   * Two submits, because the host refuses an op that references a document created beside it
   * (`create: parent not found` — `newHexcrawlSceneOps` explains the rule). The second batch is
   * built from the scene **as it landed**, and it waits for the commit rather than for a timer:
   * a rejected first batch keeps the window open and shows the host's own words.
   */
  function create(): void {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const id = `scene-${globalThis.crypto.randomUUID().slice(0, 6)}`;
    const sceneName = uniqueSceneName(
      name.trim() || "Overland map",
      scenes.map((existing) => existing.name),
    );
    busy = true;
    error = "";
    const offRejected = bus.on("rejected", (r) => {
      offRejected();
      offOps();
      busy = false;
      error = `the host refused the new scene — ${r.reason}: ${r.detail}`;
    });
    const offOps = bus.on("ops", () => {
      const landed = client.store.get("scenes", id) as SceneDocument | undefined;
      if (!landed) return;
      offOps();
      offRejected();
      client.submit(
        newHexcrawlPartyOps(landed, {
          party: partyOn ? { name: partyName } : null,
          profile: { speedPerDay: DEFAULT_SPEED_PER_DAY },
        }),
      );
      onCreated(id);
    });
    client.submit(
      mapImport
        ? imageSceneOps(id, sceneName, scenes)
        : newHexcrawlSceneOps({
            id,
            name: sceneName,
            width: sceneSize.width,
            height: sceneSize.height,
            grid,
            img: null,
            settingsDocs: client.store.getAll("settings"),
            scenes,
            activate: true,
          }),
    );
  }
</script>

<div class="hx-wizard" data-hexcrawl-wizard data-hx-step={step}>
  <ol class="steps">
    {#each STEPS as s, i (s)}
      <li class:active={s === step} class:done={i < stepIndex}>{STEP_TITLE[s]}</li>
    {/each}
  </ol>

  {#if step === "map"}
    <label class="field">
      <span>Scene name</span>
      <input data-hx-name type="text" bind:value={name} maxlength="80" />
    </label>
    <div
      class="drop"
      class:over={dragging}
      role="group"
      aria-label="Map image"
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={(e) => {
        e.preventDefault();
        dragging = false;
        void pickMap(e.dataTransfer?.files);
      }}
    >
      {#if mapImport}
        <p class="ok" data-hx-map>
          {mapName} · {sceneSize.width} × {sceneSize.height} px — imported into the world's assets.
        </p>
      {:else}
        <p class="hint">
          Drop a map image here, or choose a file. It becomes a world asset like any other map;
          you can also import a different one later with <b>Import map</b> (which targets the
          scene you are looking at).
        </p>
      {/if}
      <label class="file">
        {mapImport ? "Replace image" : "Choose image"}
        <input
          data-hx-map-input
          type="file"
          accept="image/*"
          disabled={busy}
          onchange={(e) => void pickMap((e.currentTarget as HTMLInputElement).files)}
        />
      </label>
    </div>
    {#if mapImport}
      <fieldset class="size-mode" data-hx-size-mode={sizeMode}>
        <legend>Scene size</legend>
        <div class="chips">
          <button
            type="button"
            class="chip"
            class:on={sizeMode === "matchImage"}
            aria-pressed={sizeMode === "matchImage"}
            data-hx-size-option="matchImage"
            onclick={() => (sizeMode = "matchImage")}>Match the scene to the image</button
          >
          <button
            type="button"
            class="chip"
            class:on={sizeMode === "fitImage"}
            aria-pressed={sizeMode === "fitImage"}
            data-hx-size-option="fitImage"
            onclick={() => (sizeMode = "fitImage")}>Fit the image to a chosen size</button
          >
        </div>
        {#if sizeMode === "fitImage"}
          <div class="row">
            <label>
              Width (px)
              <input data-hx-fit-width type="number" min="1" step="1" bind:value={fitWidth} />
            </label>
            <label>
              Height (px)
              <input data-hx-fit-height type="number" min="1" step="1" bind:value={fitHeight} />
            </label>
          </div>
          <p class="hint" data-hx-fit-readout>
            The picture is scaled to {Math.round(placement.scale * 100)}% and centred, keeping its
            shape; the rest of the scene is open ground.
          </p>
        {:else}
          <p class="hint">The scene takes the picture's own pixel size.</p>
        {/if}
      </fieldset>
    {/if}
    {#if !mapImport}
      <p class="hint">
        No image yet: the scene starts {DEFAULT_WIDTH} × {DEFAULT_HEIGHT} px of open ground.
      </p>
    {/if}
  {:else if step === "grid"}
    <div class="row">
      <label>
        Grid
        <select data-hx-grid-type bind:value={gridType}>
          {#each ["hex", "square", "gridless"] as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
      <label>
        Hex layout
        <select data-hx-layout bind:value={hexLayout} disabled={gridType !== "hex"}>
          {#each ["evenQ", "oddQ", "evenR", "oddR"] as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="row">
      <label>
        Cell size (px)
        <input data-hx-cell-size type="number" min="10" max="400" bind:value={cellSize} />
      </label>
      <label>
        1 cell =
        <input data-hx-distance type="number" min="0" step="0.5" bind:value={cellDistance} />
      </label>
      <label>
        Units
        <input data-hx-units type="text" bind:value={units} maxlength="8" />
      </label>
    </div>
    <p class="readout">
      <span data-hx-cells>{census.total}</span> cells on this map
      {#if census.gridless}· gridless: you draw the zones yourself{/if}
      · reference scale <b data-hx-scale>1 cell = {grid.distance} {grid.units}</b>
      {#if perDayCells !== null}
        · a party on open ground covers about {perDayCells} cells a {DEFAULT_SPEED_PER_DAY}
        {units} day
      {/if}
    </p>
  {:else}
    <label class="choice">
      <input data-hx-party type="checkbox" bind:checked={partyOn} />
      <span>Create the party token now</span>
    </label>
    {#if partyOn}
      <label class="field">
        <span>Party name</span>
        <input data-hx-party-name type="text" bind:value={partyName} maxlength="60" />
      </label>
    {/if}
    <p class="hint">
      The party token is the token world time moves; it is flagged as the party and the scene's
      hexcrawl profile names it. You can point the scene at another token any time under
      Settings → Hexcrawl.
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert" data-hx-error>{error}</p>
  {/if}

  <div class="actions">
    {#if stepIndex > 0}
      <button type="button" data-hx-back onclick={() => go("back")}>Back</button>
    {/if}
    {#if step === "party"}
      <button type="button" class="primary" data-hx-create disabled={busy} onclick={create}>
        Create scene
      </button>
    {:else}
      <button
        type="button"
        class="primary"
        data-hx-next
        onclick={() => go(STEPS[stepIndex + 1] ?? "party")}
      >
        Next
      </button>
    {/if}
  </div>
</div>

<style>
  .hx-wizard {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px;
    font-size: 0.92rem;
  }
  .steps {
    display: flex;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.82rem;
  }
  .steps li {
    padding: 3px 8px;
    border: 1px solid #3c5169;
    border-radius: 999px;
    opacity: 0.6;
  }
  .steps li.active {
    opacity: 1;
    border-color: #68b9f2;
  }
  .steps li.done {
    opacity: 0.85;
    border-color: #4d7f5a;
  }
  .field,
  .row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.9;
  }
  .row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  input,
  select {
    min-height: 32px;
    padding: 4px 8px;
    border: 1px solid #3c5169;
    border-radius: 6px;
    background: #131c27;
    color: inherit;
    font-size: 0.92rem;
    text-transform: none;
    letter-spacing: normal;
  }
  .drop {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px dashed #49627d;
    border-radius: 8px;
  }
  .drop.over {
    border-color: #68b9f2;
    background: #172433;
  }
  .size-mode {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 10px 12px 12px;
    border: 1px solid #2f4453;
    border-radius: 10px;
    background: #14212b;
  }
  .size-mode legend {
    padding: 0 6px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: #a3b8bf;
  }
  .size-mode .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .size-mode .chip {
    padding: 7px 11px;
    border: 1px solid #465a68;
    border-radius: 999px;
    background: #253543;
    color: #ebf3f3;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .size-mode .chip.on {
    border-color: #4fb3a4;
    background: #1f4a48;
    color: #fff;
  }
  .hint,
  .readout,
  .ok {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .ok {
    color: #9fe0a5;
  }
  .error {
    margin: 0;
    color: #ffb4b4;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .choice input {
    min-height: 0;
  }
  .file input {
    display: block;
    margin-top: 4px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  button {
    min-height: 36px;
    padding: 6px 14px;
    border: 1px solid #49627d;
    border-radius: 8px;
    background: #182331;
    color: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  button.primary {
    background: #1f5f8f;
    border-color: #68b9f2;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
