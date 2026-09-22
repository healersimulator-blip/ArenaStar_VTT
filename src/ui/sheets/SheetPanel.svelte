<script lang="ts">
  import { onMount } from "svelte";
  import PF1eActorSheet from "./PF1eActorSheet.svelte";
  import { isPF1eActor } from "./pf1eSheetModel";
  import { can } from "../../core/permissions";
  import {
    characterImportActorId,
    characterImportOps,
    characterImportReport,
    formatLabel,
    importCharacter,
    type CharacterImportReport,
  } from "../../packages/pf1e/import";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { BaseDocument, Json, UserDocument } from "../../core/documents";

  let {
    client,
    bus,
    onOpenActor,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onOpenActor?: (actorId: string) => void;
  } = $props();

  type SheetColl = "actors" | "items";
  let coll = $state<SheetColl>("actors");
  let selectedId = $state<string | null>(null);
  let fieldKey = $state("");
  let fieldValue = $state("");
  let docs = $state<BaseDocument[]>([]);
  let selected = $state<BaseDocument | null>(null);
  let editable = $state(false);

  function refresh(): void {
    docs = [...(client.store.getAll(coll) as readonly BaseDocument[])];
    selected = selectedId ? (client.store.get(coll, selectedId) ?? null) : null;
    editable =
      selected !== null && client.user !== null && can(client.user, "update", selected, coll);
  }

  function pick(id: string): void {
    selectedId = id;
    refresh();
  }

  function update(diff: Record<string, Json>): void {
    if (!selected || !editable) return;
    client.submit([{ kind: "update", ref: { coll, id: selected._id }, diff: diff as never }]);
  }

  function createDoc(): void {
    const id = `d-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const base: Record<string, Json> =
      coll === "actors" ? { items: [], effects: [] } : { effects: [] };
    client.submit([
      {
        kind: "create",
        coll,
        data: {
          _id: id,
          type: coll === "actors" ? "actor" : "item",
          name: coll === "actors" ? "New actor" : "New item",
          ownership: { default: 0, gm: 3 },
          flags: {},
          system: { hp: 10 },
          ...base,
        } as never,
      },
    ]);
    selectedId = id;
    refresh();
  }

  function assignOwner(userId: string): void {
    if (!selected || !userId) return;
    void update({ ownership: { ...selected.ownership, [userId]: 3 } as never });
  }

  function coerce(raw: string): Json {
    if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }

  function addField(): void {
    const key = fieldKey.trim();
    if (!key) return;
    void update({ [`system.${key}`]: coerce(fieldValue) });
    fieldKey = "";
    fieldValue = "";
  }

  function setField(key: string, value: Json): void {
    void update({ [`system.${key}`]: value });
  }

  /**
   * §3.1 (G-39/D-264): read a character export and create the actor it describes. The whole
   * character — items and authored attack lines included — arrives as *one* create op, so the
   * table sees one document appear rather than a character and then its gear, and an undo takes
   * the whole thing back. The report stays on screen afterwards: an import that dropped a
   * wizard's spellbook has to say so where the person who ran it is still looking.
   */
  let importReport = $state<{ ok: boolean; name: string; lines: string[]; warnings: string[] } | null>(
    null,
  );
  let importBusy = $state(false);

  /**
   * G-08 (D-267): the same read, from text the GM pasted instead of a file. A stat block has no
   * file behind it — it is copied out of a PDF, a wiki page or another table's handout — so the
   * Actors tab also takes text, and everything after `importCharacter` is the path above
   * unchanged: one create op, one report, the same list.
   */
  let pasteOpen = $state(false);
  let pasteText = $state("");
  /** What the box shows before anything is typed: the head of a real SRD block. */
  const PASTE_EXAMPLE = [
    "Goblin Warrior CR 1/3",
    "NE Small humanoid (goblinoid)",
    "Init +6; Senses darkvision 60 ft.; Perception -1",
    "",
    "DEFENSE",
    "",
    "AC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)",
    "hp 6 (1d10+1)",
    "Fort +3, Ref +4, Will -1",
    "",
    "OFFENSE",
    "",
    "Speed 30 ft.",
    "Melee short sword +2 (1d4/19-20)",
    "Ranged short bow +4 (1d4/\u00d73)",
    "",
    "STATISTICS",
    "",
    "Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6",
    "Base Atk +1; CMB +1; CMD 12",
    "Feats Improved Initiative",
    "Languages Goblin",
  ].join("\n");

  function importPasted(): void {
    const text = pasteText;
    if (!text.trim()) return;
    const source = text.trim().split(/\r?\n/, 1)[0]?.trim() || "pasted text";
    const parsed = importCharacter(text, { fileName: source });
    if (!parsed.ok) {
      importReport = { ok: false, name: source, lines: [], warnings: [parsed.error] };
      return;
    }
    const id = characterImportActorId(globalThis.crypto.randomUUID());
    const report: CharacterImportReport = characterImportReport(parsed.value);
    client.submit(characterImportOps(parsed.value, { id, gmId: client.user?.id ?? undefined }));
    importReport = {
      ok: true,
      name: `${report.name} (${formatLabel(report.format)})`,
      lines: report.read,
      warnings: report.warnings,
    };
    pasteText = "";
    pasteOpen = false;
    coll = "actors";
    selectedId = id;
    globalThis.setTimeout(refresh, 50);
  }

  async function importFile(file: File | undefined | null): Promise<void> {
    if (!file) return;
    importBusy = true;
    try {
      const text = await file.text();
      const parsed = importCharacter(text, { fileName: file.name });
      if (!parsed.ok) {
        importReport = { ok: false, name: file.name, lines: [], warnings: [parsed.error] };
        return;
      }
      const id = characterImportActorId(globalThis.crypto.randomUUID());
      const report: CharacterImportReport = characterImportReport(parsed.value);
      client.submit(
        characterImportOps(parsed.value, { id, gmId: client.user?.id ?? undefined }),
      );
      importReport = {
        ok: true,
        name: `${report.name} (${formatLabel(report.format)})`,
        lines: report.read,
        warnings: report.warnings,
      };
      coll = "actors";
      selectedId = id;
      // the create lands through the store's own round trip, so the list refreshes with the op
      globalThis.setTimeout(refresh, 50);
    } finally {
      importBusy = false;
    }
  }

  function users(): UserDocument[] {
    return client.store.getAll("users") as readonly UserDocument[] as UserDocument[];
  }

  function ownedByMe(doc: BaseDocument): boolean {
    return doc.ownership[client.user?.id ?? ""] === 3;
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
      offRejected();
    };
  });
</script>

<section class="sheets" id="sheets" aria-label="Sheets">
  <h3>Sheets</h3>
  <div class="tabs">
    <button
      class="tab"
      class:active={coll === "actors"}
      onclick={() => {
        coll = "actors";
        selectedId = null;
        refresh();
      }}
    >
      Actors
    </button>
    <button
      class="tab"
      class:active={coll === "items"}
      onclick={() => {
        coll = "items";
        selectedId = null;
        refresh();
      }}
    >
      Items
    </button>
    {#if client.user?.role === "GM" || client.user?.role === "ASSISTANT"}
      <button id="new-doc" class="tab" onclick={() => createDoc()}>+ New</button>
      {#if coll === "actors"}
        <button
          type="button"
          class="tab import"
          id="statblock-toggle"
          data-import-paste-trigger
          title="Paste a Pathfinder 1e monster stat block as text"
          onclick={() => {
            pasteOpen = !pasteOpen;
            coll = "actors";
          }}>{pasteOpen ? "Cancel" : "Stat block"}</button
        >
        <label
          class="tab import"
          for="character-import"
          data-import-character-trigger
          title="Foundry PF1e actor JSON, Hero Lab XML, or a Roll20 sheet export"
          >{importBusy ? "Reading…" : "Import"}
          <input
            id="character-import"
            data-import-character
            type="file"
            accept=".json,.xml,.txt"
            hidden
            onchange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              void importFile(input.files?.[0] ?? null);
              input.value = "";
            }}
          />
        </label>
      {/if}
    {/if}
  </div>

  {#if pasteOpen}
    <div class="paste">
      <textarea
        id="statblock-text"
        data-import-paste
        rows="8"
        placeholder={PASTE_EXAMPLE}
        bind:value={pasteText}
        onkeydown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            importPasted();
          }
        }}></textarea>
      <div class="paste-actions">
        <button
          type="button"
          id="statblock-import"
          data-import-paste-run
          disabled={pasteText.trim() === ""}
          onclick={() => importPasted()}>Import stat block</button
        >
        <span class="hint">or paste the block and press Ctrl/⌘+Enter</span>
      </div>
    </div>
  {/if}

  {#if importReport}
    <div class="import-report" data-import-report data-import-ok={importReport.ok ? "true" : "false"}>
      <div class="import-head">
        <strong>{importReport.ok ? `Imported ${importReport.name}` : `Could not import ${importReport.name}`}</strong>
        <button type="button" class="dismiss" data-import-dismiss onclick={() => (importReport = null)}>✕</button>
      </div>
      {#each importReport.lines as line, index (index)}
        <p class="import-line">{line}</p>
      {/each}
      {#if importReport.warnings.length > 0}
        <p class="import-note">
          {importReport.warnings.length} thing{importReport.warnings.length === 1 ? "" : "s"} could not be
          placed — author them on the sheet:
        </p>
        {#each importReport.warnings as warning, index (index)}
          <p class="import-warning" data-import-warning>{warning}</p>
        {/each}
      {/if}
    </div>
  {/if}

  <div id="sheet-list">
    {#each docs as doc (doc._id)}
      <button
        class="sheet-row"
        data-doc-id={doc._id}
        class:selected={doc._id === selectedId}
        onclick={() => pick(doc._id)}
      >
        <span class="doc-name">{doc.name}</span>
        {#if ownedByMe(doc)}<span class="badge">you</span>{/if}
      </button>
    {/each}
    {#if docs.length === 0}
      <p class="empty">no {coll} visible</p>
    {/if}
  </div>

  {#if selected}
    <div class="editor">
      <label class="edrow">
        name
        <input
          id="sheet-name"
          type="text"
          value={selected.name}
          disabled={!editable}
          onchange={(event) =>
            void update({
              name: (event.currentTarget as HTMLInputElement).value,
            })}
        />
      </label>

      {#if client.user?.role === "GM" || client.user?.role === "ASSISTANT"}
        <label class="edrow">
          owner
          <select
            id="assign-owner"
            onchange={(event) => assignOwner((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">— assign —</option>
            {#each users() as user (user._id)}
              {#if user.role === "PLAYER"}
                <option value={user._id}>{user.name}</option>
              {/if}
            {/each}
          </select>
        </label>
      {/if}

      {#if coll === "actors" && isPF1eActor(selected)}
        {#if onOpenActor}
          <button type="button" data-open-pf1e-sheet onclick={() => onOpenActor?.(selected._id)}
            >Open character sheet window</button
          >
        {/if}
        {#key selected._id}
          <PF1eActorSheet doc={selected} {client} {bus} />
        {/key}
      {:else}
        <div id="sheet-fields">
          {#each Object.entries(selected.system) as [key, value] (key)}
            <label class="edrow">
              {key}
              {#if typeof value === "boolean"}
                <input
                  class="sys-field"
                  data-key={key}
                  type="checkbox"
                  checked={value}
                  disabled={!editable}
                  onchange={(event) =>
                    setField(key, (event.currentTarget as HTMLInputElement).checked)}
                />
              {:else if typeof value === "number"}
                <input
                  class="sys-field"
                  data-key={key}
                  type="number"
                  {value}
                  disabled={!editable}
                  onchange={(event) =>
                    setField(key, Number((event.currentTarget as HTMLInputElement).value))}
                />
              {:else}
                <input
                  class="sys-field"
                  data-key={key}
                  type="text"
                  value={String(value)}
                  disabled={!editable}
                  onchange={(event) =>
                    setField(key, (event.currentTarget as HTMLInputElement).value)}
                />
              {/if}
            </label>
          {/each}
        </div>

        {#if editable && (client.user?.role === "GM" || client.user?.role === "ASSISTANT")}
          <div class="edrow addfield">
            <input id="field-key" type="text" placeholder="field" bind:value={fieldKey} />
            <input id="field-value" type="text" placeholder="value" bind:value={fieldValue} />
            <button id="add-field" type="button" onclick={() => addField()}>Add field</button>
          </div>
        {/if}
      {/if}
      {#if !editable}
        <p class="hint">read-only (no ownership)</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .sheets {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h3 {
    margin: 0;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b93a3;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    flex: 1;
    padding: 4px 6px;
    font-size: 0.8125rem;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #cfd3dc;
    cursor: pointer;
  }
  .tab.active {
    background: #2b3a55;
    color: #fff;
  }
  .tab.import {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  .paste {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .paste textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    line-height: 1.35;
    color: #cfd3dc;
    background: #14171c;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    padding: 6px;
    resize: vertical;
  }
  .paste-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .paste-actions button {
    padding: 4px 8px;
    font-size: 0.8125rem;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #1d2127;
    color: #cfd3dc;
    cursor: pointer;
  }
  .paste-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .paste-actions .hint {
    font-size: 0.6875rem;
    color: #77808f;
  }
  .import-report {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid #3a3f4a;
    border-left: 3px solid #63d471;
    border-radius: 6px;
    background: #1d2127;
    font-size: 0.75rem;
    max-height: 180px;
    overflow-y: auto;
  }
  .import-report[data-import-ok="false"] {
    border-left-color: #e06c75;
  }
  .import-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
  }
  .import-line {
    margin: 0;
    color: #cfd3dc;
  }
  .import-note {
    margin: 4px 0 0;
    color: #8b93a3;
  }
  .import-warning {
    margin: 0;
    color: #ffd479;
  }
  .dismiss {
    border: none;
    background: transparent;
    color: #8b93a3;
    cursor: pointer;
    font-size: 0.75rem;
  }
  #sheet-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 140px;
    overflow-y: auto;
  }
  .sheet-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: #cfd3dc;
    cursor: pointer;
    text-align: left;
    font-size: 0.9rem;
  }
  .sheet-row.selected {
    border-color: #4a7ec4;
    background: #1a2536;
  }
  .badge {
    font-size: 0.8125rem;
    color: #7fe0a7;
    border: 1px solid #2e8b57;
    border-radius: 999px;
    padding: 0 5px;
  }
  .empty {
    color: #8b93a3;
    font-size: 0.875rem;
    margin: 0;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border: 1px solid #3a3f4a;
    border-radius: 6px;
    background: #101216;
  }
  .edrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 0.875rem;
    color: #aab2c0;
  }
  input,
  select {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    border: 1px solid #3a3f4a;
    border-radius: 5px;
    background: #16181d;
    color: #e8e8ee;
    font-size: 0.875rem;
  }
  input:disabled {
    opacity: 0.5;
  }
  .addfield {
    gap: 4px;
  }
  .addfield button {
    padding: 3px 8px;
    border: 1px solid #3a3f4a;
    border-radius: 5px;
    background: #1d2127;
    color: #e8e8ee;
    cursor: pointer;
    font-size: 0.8125rem;
  }
  .hint {
    margin: 0;
    color: #8b93a3;
    font-size: 0.8125rem;
  }
</style>
