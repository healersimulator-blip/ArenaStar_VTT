<script lang="ts">
  import { onMount } from "svelte";
  import { can } from "../../core/permissions";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { BaseDocument, Json, UserDocument } from "../../core/documents";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
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

  function users(): UserDocument[] {
    return client.store.getAll("users") as readonly UserDocument[] as UserDocument[];
  }

  function ownedByMe(doc: BaseDocument): boolean {
    return doc.ownership[client.user?.id ?? ""] === 3;
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
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
    {/if}
  </div>

  <div id="sheet-list">
    {#each docs as doc (doc._id)}
      <button
        class="sheet-row"
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
            void update({ name: (event.currentTarget as HTMLInputElement).value })}
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
                onchange={(event) => setField(key, (event.currentTarget as HTMLInputElement).value)}
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
    font-size: 12px;
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
    font-size: 11px;
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
    font-size: 12.5px;
  }
  .sheet-row.selected {
    border-color: #4a7ec4;
    background: #1a2536;
  }
  .badge {
    font-size: 10px;
    color: #7fe0a7;
    border: 1px solid #2e8b57;
    border-radius: 999px;
    padding: 0 5px;
  }
  .empty {
    color: #8b93a3;
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 11px;
  }
  .hint {
    margin: 0;
    color: #8b93a3;
    font-size: 11px;
  }
</style>
