<script lang="ts">
  /**
   * §10 Tables panel — roll tables with editable results; Draw evaluates the
   * table formula client-side (pure core) and posts the result to chat.
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { RollTableDocument } from "../../core/documents";
  import { drawFromTable } from "../../core/rollTable";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
  } = $props();

  let tables = $state<RollTableDocument[]>([]);
  let selectedId = $state<string | null>(null);
  const table = $derived(tables.find((t) => t._id === selectedId) ?? null);
  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");

  function refresh(): void {
    tables = [...(client.store.getAll("rollTables") as readonly RollTableDocument[])];
    if (selectedId && !tables.some((t) => t._id === selectedId))
      selectedId = tables[0]?._id ?? null;
    if (!selectedId && tables[0]) selectedId = tables[0]._id;
  }

  function createTable(): void {
    const doc: RollTableDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "rollTable",
      name: `Table ${tables.length + 1}`,
      ownership: { default: 1 },
      flags: {},
      system: {},
      formula: "1d6",
      results: [
        { range: [1, 2], text: "nothing happens", documentRef: null },
        { range: [3, 4], text: "a door slams", documentRef: null },
        { range: [5, 6], text: "guards approach", documentRef: null },
      ],
    };
    client.submit([{ kind: "create", coll: "rollTables", data: doc }]);
  }

  function draw(): void {
    if (!table) return;
    const d = drawFromTable(table);
    const content = d.missed
      ? `⟨table "${table.name}" missed — check ranges⟩`
      : `${d.roll.total} on ${table.formula} → **${d.result?.text ?? ""}**`;
    client.submit([
      {
        kind: "create",
        coll: "messages",
        data: {
          _id: globalThis.crypto.randomUUID(),
          type: "message",
          name: "table-draw",
          ownership: { default: 1 },
          flags: {},
          system: {},
          author: client.user?.id ?? "",
          content,
          whisper: [],
          roll: d.missed ? null : { ...d.roll, seedClient: null, seedHost: null },
          flavor: "table",
        },
      },
    ]);
  }

  function updateResult(i: number, text: string): void {
    if (!table) return;
    const results = table.results.map((r, idx) => (idx === i ? { ...r, text } : r));
    client.submit([
      { kind: "update", ref: { coll: "rollTables", id: table._id }, diff: { results } },
    ]);
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

<section class="tables" aria-label="Roll tables">
  <h3>Tables</h3>
  {#if isGm}
    <button id="table-create" type="button" onclick={createTable}>New table</button>
  {/if}
  <ul class="list">
    {#each tables as t (t._id)}
      <li>
        <button type="button" class:sel={t._id === selectedId} onclick={() => (selectedId = t._id)}>
          {t.name} <small>({t.formula})</small>
        </button>
      </li>
    {/each}
  </ul>
  {#if table}
    <button id="table-draw" type="button" onclick={draw}>Draw from {table.name}</button>
    {#if isGm}
      <ul class="results">
        {#each table.results as r, i (i)}
          <li>
            <span class="range">{r.range[0]}–{r.range[1]}</span>
            <input
              type="text"
              value={r.text}
              onchange={(e) => updateResult(i, (e.target as HTMLInputElement).value)}
              aria-label={`Result ${r.range[0]}–${r.range[1]}`}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .tables {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  button.sel {
    background: #2c4a6e;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .results li {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .range {
    font-size: 11px;
    opacity: 0.75;
    min-width: 3.2em;
    text-align: right;
  }
  input {
    flex: 1;
  }
</style>
