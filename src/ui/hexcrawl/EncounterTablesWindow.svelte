<script lang="ts">
  /**
   * D-272 (plan §5.4/§5.5) — the **tables list**: every encounter table in the world, with the
   * two jobs the wizard cannot do on its own.
   *
   * - **Browse/author** (the *Tables* button in the GM toolbar): New, Edit, Duplicate, Delete.
   *   Deleting detaches the table from every cell that names it (`detachTableFromCellsOps`) — a
   *   dangling id paints a row in the hex window for a table that no longer exists.
   * - **Attach to a hex** (`sceneId` + `key` in the window data — the canvas menu's *Attach
   *   encounter table…* and the hex window's own button): each row is a checkbox, and *New table…*
   *   opens the wizard with the hex as its save target. The requirement's "several tables per hex"
   *   is the checkbox list; which of them may fire is the *tags* on each table.
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { EncounterTableDocument, SceneDocument } from "../../core/documents";
  import type { WindowManager } from "../../core/windows";
  import { encounterTagsOf, TAG_KEYS } from "../../core/hexcrawl/tables";
  import {
    deleteEncounterTableOps,
    detachTableFromCellsOps,
    duplicateEncounterTableOps,
    newEncounterTableId,
  } from "../../core/hexcrawl/tableOps";
  import { attachTableOps, detachTableOps } from "./tableEditor";

  let {
    client,
    bus,
    manager,
    sceneId = "",
    cellKey = "",
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    manager: WindowManager;
    sceneId?: string;
    cellKey?: string;
  } = $props();

  let tables = $state<EncounterTableDocument[]>([]);
  let scene = $state<SceneDocument | null>(null);
  let attached = $state<string[]>([]);

  const attachMode = $derived(sceneId !== "" && cellKey !== "");

  function refresh(): void {
    tables = [...client.store.getAll("encounterTables")];
    const doc = sceneId ? (client.store.get("scenes", sceneId) ?? null) : null;
    scene = doc;
    attached = (doc?.cells ?? []).find((c) => c.key === cellKey)?.tables ?? [];
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

  const rows = $derived(
    [...tables].sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** One window per table, so editing two tables at once is two windows (§10's rule). */
  function openWizard(tableId: string | null): void {
    const id = tableId ? `encounter-table:${tableId}` : `encounter-table:new:${crypto.randomUUID()}`;
    manager.open({
      id,
      title: tableId ? "Encounter table" : "New encounter table",
      kind: "encounterTable",
      x: 80 + (manager.list().length % 5) * 24,
      y: 64 + (manager.list().length % 5) * 24,
      width: 620,
      height: 520,
      data: {
        ...(tableId ? { tableId } : {}),
        // `key` is the host's own data name for a hex (App.svelte's `openHexWindow`, WindowHost's
        // `hex` branch); carrying it as `cellKey` here would silently drop the attach target.
        ...(attachMode ? { sceneId, key: cellKey } : {}),
      },
    });
  }

  function toggleAttach(table: EncounterTableDocument, on: boolean): void {
    if (!scene || !attachMode) return;
    const ops = on
      ? attachTableOps(scene, cellKey, table._id)
      : detachTableOps(scene, cellKey, table._id);
    if (ops.length > 0) client.submit(ops);
  }

  function duplicate(table: EncounterTableDocument): void {
    const copy = client.submit(
      duplicateEncounterTableOps(
        table,
        newEncounterTableId(`${table.name} copy`),
        `${table.name} (copy)`,
      ),
    );
    void copy;
  }

  function remove(table: EncounterTableDocument): void {
    const ops = [
      ...detachTableFromCellsOps(
        client.store.getAll("scenes").map((s) => ({
          _id: s._id,
          cells: (s.cells ?? []).map((c) => ({ _id: c._id, key: c.key, tables: c.tables ?? [] })),
        })),
        table._id,
      ),
      ...deleteEncounterTableOps(table._id),
    ];
    if (ops.length > 0) client.submit(ops);
  }

  const summaryOf = (table: EncounterTableDocument): string => {
    const rowsCount = (table.entries ?? []).length;
    const tags = encounterTagsOf(table);
    const off = TAG_KEYS.filter((t) => !tags[t]);
    const mode = table.mode === "dice" ? (table.formula || "dice") : "weighted %";
    return `${mode} · ${rowsCount} row${rowsCount === 1 ? "" : "s"}${
      off.length > 0 ? ` · off: ${off.join(", ")}` : ""
    }`;
  };
</script>

<div class="tables" data-encounter-tables>
  <header class="head">
    <h4 data-tables-title>{attachMode ? `Tables for hex ${cellKey}` : "Encounter tables"}</h4>
    <span class="spacer"></span>
    <button type="button" data-tables-new onclick={() => openWizard(null)}>New table…</button>
  </header>

  {#if rows.length === 0}
    <p class="hint" data-tables-empty>
      No encounter table exists in this world yet. <em>New table…</em> writes one; attach it to a
      hex from here or from the hex's own window.
    </p>
  {:else}
    <ul class="list">
      {#each rows as table (table._id)}
        <li data-table-list-row={table._id}>
          {#if attachMode}
            <input
              type="checkbox"
              data-tables-attach={table._id}
              checked={attached.includes(table._id)}
              onchange={(e) => toggleAttach(table, (e.target as HTMLInputElement).checked)}
            />
          {/if}
          <button
            type="button"
            class="name"
            data-tables-edit={table._id}
            onclick={() => openWizard(table._id)}>{table.name}</button
          >
          <span class="summary" data-tables-summary={table._id}>{summaryOf(table)}</span>
          <span class="spacer"></span>
          <button type="button" data-tables-duplicate={table._id} onclick={() => duplicate(table)}
            >Duplicate</button
          >
          <button type="button" data-tables-delete={table._id} onclick={() => remove(table)}
            >Delete</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tables {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    font: 12px/1.4 system-ui, sans-serif;
    color: var(--fg, #e8e8ea);
    height: 100%;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h4 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--line, #2c2c34);
    padding-bottom: 3px;
  }
  button {
    background: var(--btn-bg, #26262e);
    color: inherit;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 3px;
    padding: 2px 6px;
    cursor: pointer;
    font: inherit;
  }
  button.name {
    border: none;
    background: none;
    text-decoration: underline;
    text-align: left;
  }
  .summary {
    opacity: 0.75;
  }
  .hint {
    opacity: 0.75;
  }
</style>
