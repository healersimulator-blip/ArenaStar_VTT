<script lang="ts">
  /**
   * New-world wizard (D-249, proposal §6.3): name → strategic ruleset → content packs →
   * Create. The one place a GM chooses rules for a campaign; the choice lands in the world
   * row + package rows before the first boot, so nothing has to be activated or reloaded.
   *
   * Scope stated on screen: the ruleset only drives strategic-scale scenes (heroes + units).
   * Scenes start tactical (heroes only) and are switched per scene under Settings → Scale,
   * so one world mixes both kinds under one ruleset (D-248).
   */
  import {
    checkRecipe,
    createWorldFromRecipe,
    describeRecipePackage,
    loadRecipePackage,
    type RecipePackage,
    type WorldRecipe,
  } from "../../app/worldRecipe";
  import { openVttDb } from "../../storage/idb";

  let {
    initialPackage = null,
    onCancel,
    onCreated,
  }: {
    /** A package zip the start screen sniffed (Open file → "New world with it…"). */
    initialPackage?: Uint8Array | null;
    onCancel: () => void;
    onCreated: (worldId: string) => void;
  } = $props();

  let name = $state("New world");
  let rulesetChoice = $state<"builtin" | "package">("builtin");
  // $state.raw: loaded packages go straight into IndexedDB (structured clone), which refuses
  // Svelte's deep-reactive proxies — and nothing mutates them in place anyway.
  let ruleset = $state.raw<RecipePackage | null>(null);
  let content = $state.raw<RecipePackage[]>([]);
  let error = $state("");
  let busy = $state(false);
  let rulesetInput = $state<HTMLInputElement | null>(null);
  let contentInput = $state<HTMLInputElement | null>(null);

  const recipe = $derived<WorldRecipe>({
    name,
    ruleset:
      rulesetChoice === "package" && ruleset ? { kind: "package", pkg: ruleset } : { kind: "builtin" },
    content,
  });
  const check = $derived(checkRecipe(recipe));
  const rulesetInfo = $derived(ruleset ? describeRecipePackage(ruleset) : null);

  /** Place a loaded package where its kind says it belongs. */
  function accept(pkg: RecipePackage): void {
    if (pkg.manifest.type === "system") {
      ruleset = pkg;
      rulesetChoice = "package";
    } else {
      content = [...content.filter((p) => p.manifest.id !== pkg.manifest.id), pkg];
    }
  }

  async function loadFiles(files: FileList | null | undefined, slot: "ruleset" | "content"): Promise<void> {
    if (!files || files.length === 0) return;
    busy = true;
    error = "";
    try {
      for (const file of Array.from(files)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const loaded = await loadRecipePackage(bytes);
        if (!loaded.ok) {
          error = `${file.name}: ${loaded.error}`;
          continue;
        }
        const info = describeRecipePackage(loaded.pkg);
        if (slot === "ruleset" && loaded.pkg.manifest.type !== "system") {
          error = `${info.name} is a ${info.kind}, not a strategic ruleset — it was added under Content instead.`;
        } else if (slot === "content" && loaded.pkg.manifest.type === "system") {
          error = `${info.name} is a strategic ruleset, not a content pack — it was set as the ruleset instead.`;
        }
        accept(loaded.pkg);
      }
    } finally {
      if (rulesetInput) rulesetInput.value = "";
      if (contentInput) contentInput.value = "";
      busy = false;
    }
  }

  function removeContent(id: string): void {
    content = content.filter((p) => p.manifest.id !== id);
  }

  async function create(): Promise<void> {
    if (check.errors.length > 0) {
      error = check.errors.join("; ");
      return;
    }
    busy = true;
    error = "";
    try {
      const db = await openVttDb();
      const created = await createWorldFromRecipe(recipe, { db });
      db.close();
      onCreated(created.worldId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }

  $effect(() => {
    if (!initialPackage) return;
    const bytes = initialPackage;
    void loadRecipePackage(bytes).then((loaded) => {
      if (loaded.ok) accept(loaded.pkg);
      else error = loaded.error;
    });
  });
</script>

<section class="wizard" aria-labelledby="wizard-h" data-wizard>
  <h2 id="wizard-h">New world</h2>

  <label class="field">
    <span>Name</span>
    <input id="wizard-name" type="text" bind:value={name} maxlength="80" />
  </label>

  <fieldset>
    <legend>Strategic ruleset</legend>
    <p class="hint">
      Drives <b>strategic</b> scenes (heroes + units) only. Scenes start tactical (heroes only);
      switch any scene under Settings → Scale. The ruleset can be changed until the first
      strategic turn is resolved.
    </p>
    <label class="choice">
      <input
        id="wizard-ruleset-builtin"
        type="radio"
        name="ruleset"
        value="builtin"
        bind:group={rulesetChoice}
      />
      <span>Built-in Mass Battle Basic</span>
    </label>
    <label class="choice">
      <input
        id="wizard-ruleset-package"
        type="radio"
        name="ruleset"
        value="package"
        bind:group={rulesetChoice}
        disabled={!ruleset}
      />
      <span>
        {#if rulesetInfo}
          <b data-wizard-ruleset>{rulesetInfo.name} v{rulesetInfo.version}</b>
          {#if rulesetInfo.dependencies.length > 0}
            <small data-wizard-ruleset-deps
              >declares companions: {rulesetInfo.dependencies.join(", ")}</small
            >
          {/if}
        {:else}
          From a ruleset file
        {/if}
      </span>
    </label>
    <label class="file">
      {ruleset ? "Replace ruleset file (.zip)" : "Choose ruleset file (.zip)"}
      <input
        id="wizard-ruleset-file"
        type="file"
        accept=".zip,application/zip"
        bind:this={rulesetInput}
        disabled={busy}
        onchange={() => void loadFiles(rulesetInput?.files, "ruleset")}
      />
    </label>
  </fieldset>

  <fieldset>
    <legend>Content packs</legend>
    <p class="hint">
      Compendia (bestiary, spells, …) for this world. Optional; more can be added later under
      Settings → Strategic ruleset &amp; content.
    </p>
    {#each content as pkg (pkg.manifest.id)}
      {@const info = describeRecipePackage(pkg)}
      <div class="row" data-wizard-content-row data-pkg-id={info.id}>
        <span>{info.name} v{info.version} · {info.packCount} pack(s)</span>
        <button type="button" data-wizard-content-remove onclick={() => removeContent(info.id)}>
          Remove
        </button>
      </div>
    {/each}
    <label class="file">
      Add content pack(s) (.zip)
      <input
        id="wizard-content-file"
        type="file"
        accept=".zip,application/zip"
        multiple
        bind:this={contentInput}
        disabled={busy}
        onchange={() => void loadFiles(contentInput?.files, "content")}
      />
    </label>
  </fieldset>

  {#each check.warnings as w (w)}
    <p class="warn" data-wizard-warning>{w}</p>
  {/each}
  {#if error}<p class="error" role="alert" data-wizard-error>{error}</p>{/if}

  <div class="actions">
    <button id="wizard-cancel" type="button" onclick={onCancel} disabled={busy}>Cancel</button>
    <button
      id="wizard-create"
      type="button"
      class="primary"
      onclick={() => void create()}
      disabled={busy || check.errors.length > 0}
    >
      Create world
    </button>
  </div>
</section>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(100%, 560px);
    padding: 20px 22px;
    border: 1px solid #293a4d;
    border-radius: 12px;
    background: #111a25cc;
    color: #f2f5f8;
  }
  h2 {
    margin: 0;
    font-size: 1.4rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.9rem;
  }
  .field input {
    padding: 8px 10px;
    border: 1px solid #49627d;
    border-radius: 8px;
    background: #182331;
    color: inherit;
    font-size: 1rem;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 10px 12px 12px;
    border: 1px solid #293a4d;
    border-radius: 10px;
  }
  legend {
    padding: 0 6px;
    font-weight: 700;
  }
  .hint {
    margin: 0;
    color: #aebdcb;
    font-size: 0.85rem;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.95rem;
  }
  .choice small {
    display: block;
    color: #aebdcb;
  }
  .file {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85rem;
    color: #c1ccd8;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.9rem;
  }
  .warn {
    margin: 0;
    color: #ffd166;
    font-size: 0.85rem;
  }
  .error {
    margin: 0;
    color: #ffb4b4;
    font-size: 0.9rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  button {
    min-height: 40px;
    padding: 8px 16px;
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
