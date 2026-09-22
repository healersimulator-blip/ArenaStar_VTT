<script lang="ts">
  /**
   * D-272 (plan §5.4) — the encounter-table wizard: one screen, no steps.
   *
   * A form over `./tableEditor.ts`, which owns every decision (what a typed weight means, what a
   * mode switch converts, what a paste reads, what the save writes). The component paints it and
   * submits the ops; it does not compute table semantics, so the `%` column the GM sees comes from
   * the *compiled ladder* (`rowPercents`) and can never disagree with the die.
   *
   * Three doors lead here, and the difference is only the `data` it is opened with:
   * - the tables list, **New** — a blank draft;
   * - the tables list, **Edit** — `tableId`, the stored document;
   * - a hex's *Attach encounter table… → New…* — `sceneId` + `cellKey`, so Save also attaches.
   *
   * *Test roll* draws with the real engine (`drawEncounter`) and opens the results window in
   * preview: nothing is created, no ledger entry is written, no card is posted. That is the whole
   * reason the wizard does not need a "weights must total 100" validation wall — a GM checks the
   * ladder by rolling on it.
   */
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type {
    ActorDocument,
    EncounterEntry,
    EncounterTableDocument,
  } from "../../core/documents";
  import { TAG_KEYS } from "../../core/hexcrawl/tables";
  import type { WindowManager } from "../../core/windows";
  import { newEncounterTableId } from "../../core/hexcrawl/tableOps";
  import PF1eCompendiumPicker from "../sheets/PF1eCompendiumPicker.svelte";
  import {
    addRow,
    battleSceneChoices,
    draftOf,
    draftView,
    emptyTableDraft,
    moveRow,
    pasteRows,
    removeRow,
    savePlan,
    switchMode,
    testRoll,
    withCooldown,
    withRowCount,
    withRowRange,
    withRowRefs,
    withRowText,
    withRowWeight,
    withScene,
    withTags,
    type RowView,
    type TableDraft,
  } from "./tableEditor";
  import { openEncounterResult } from "./encounterResult";

  let {
    client,
    bus,
    manager,
    tableId = "",
    sceneId = "",
    cellKey = "",
    onClose,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    /** Needed only by *Test roll*, which opens the results window (plan §5.5). */
    manager: WindowManager;
    tableId?: string;
    sceneId?: string;
    cellKey?: string;
    onClose?: () => void;
  } = $props();

  let draft = $state<TableDraft>(emptyTableDraft());
  let stored = $state<EncounterTableDocument | null>(null);
  let scenes = $state<Array<{ _id: string; name: string }>>([]);
  let actors = $state<ActorDocument[]>([]);
  let error = $state("");
  let notes = $state<string[]>([]);
  /** Which row has its reference picker open (`null` = none). */
  let pickerRow = $state<number | null>(null);
  /** The world-actor chooser for a row (`null` = closed). */
  let actorRow = $state<number | null>(null);
  let pasteOpen = $state(false);
  let pasteText = $state("");
  let attachers = $state<Array<{ sceneId: string; key: string }>>([]);

  const nextId = () => globalThis.crypto.randomUUID();

  function refresh(): void {
    const doc = tableId ? (client.store.get("encounterTables", tableId) ?? null) : null;
    stored = doc;
    draft = doc ? draftOf(doc) : emptyTableDraft();
    scenes = client.store
      .getAll("scenes")
      .map((s) => ({ _id: s._id, name: s.name }));
    actors = [...client.store.getAll("actors")];
    attachers = sceneId && cellKey ? [{ sceneId, key: cellKey }] : [];
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

  const view = $derived(draftView(draft));
  const choices = $derived(battleSceneChoices(scenes, sceneId));

  const setDraft = (next: TableDraft): void => {
    draft = next;
  };

  function changeMode(mode: "dice" | "weighted"): void {
    const changed = switchMode(draft, mode);
    error = changed.error ?? "";
    notes = changed.notes;
    if (changed.error === null) draft = changed.draft;
  }

  function doPaste(): void {
    const pasted = pasteRows(draft, pasteText);
    error = pasted.error ?? "";
    notes = pasted.notes;
    if (pasted.error === null) {
      draft = pasted.draft;
      pasteText = "";
      pasteOpen = false;
    }
  }

  function testRollNow(): void {
    const roll = testRoll(draft, Math.random);
    openEncounterResult(manager, `encounter-result:test:${nextId()}`, {
      roll,
      preview: true,
      sceneId: sceneId || null,
      cellKey: cellKey || null,
    });
  }

  function save(): void {
    const scene =
      sceneId && cellKey ? (client.store.get("scenes", sceneId) ?? null) : null;
    const plan = savePlan(draft, {
      mintId: () => newEncounterTableId(draft.name),
      existing: stored,
      attach: scene && cellKey ? { scene, key: cellKey } : null,
    });
    if (plan.error !== null) {
      error = plan.error;
      return;
    }
    error = "";
    if (plan.ops.length > 0) client.submit(plan.ops);
    onClose?.();
  }

  function pickCompendium(entry: { id: string; name: string }, pack: { name: string }): void {
    if (pickerRow === null) return;
    const refs: EncounterEntry["refs"] = [
      { kind: "compendium", packId: pack.name, entryId: entry.id },
    ];
    draft = withRowRefs(draft, pickerRow, refs);
    pickerRow = null;
  }

  function pickActor(actorId: string): void {
    if (actorRow === null) return;
    draft = withRowRefs(draft, actorRow, [{ kind: "actor", actorId }]);
    actorRow = null;
  }

  const rangeTextOf = (row: RowView): string =>
    row.entry.range ? `${row.entry.range[0]}-${row.entry.range[1]}` : "";

  const rowCount = (row: RowView): string => `${row.index + 1}`;
</script>

<div class="wizard" data-table-wizard>
  <header class="head">
    <label class="name"
      >Name
      <input
        data-table-name
        value={draft.name}
        placeholder="Forest road — day"
        oninput={(e) => (draft = { ...draft, name: (e.target as HTMLInputElement).value })}
      />
    </label>
    <fieldset class="mode">
      <legend>Roll type</legend>
      <label>
        <input
          type="radio"
          name="table-mode"
          data-table-mode-dice
          checked={draft.mode === "dice"}
          onchange={() => changeMode("dice")}
        /> Dice
      </label>
      <label>
        <input
          type="radio"
          name="table-mode"
          data-table-mode-weighted
          checked={draft.mode === "weighted"}
          onchange={() => changeMode("weighted")}
        /> Weighted %
      </label>
    </fieldset>
  </header>

  {#if draft.mode === "dice"}
    <label class="formula"
      >Formula
      <input
        data-table-formula
        value={draft.formula}
        placeholder="1d20"
        oninput={(e) => (draft = { ...draft, formula: (e.target as HTMLInputElement).value })}
      />
    </label>
  {/if}

  <table class="rows">
    <thead>
      <tr>
        <th>#</th>
        {#if draft.mode === "weighted"}
          <th>weight</th>
          <th>%</th>
        {:else}
          <th>rolls</th>
        {/if}
        <th>entry</th>
        <th>count</th>
        <th>ref</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each view.rows as row (row.index)}
        <tr data-table-row={row.index}>
          <td class="num">{rowCount(row)}</td>
          {#if draft.mode === "weighted"}
            <td>
              <input
                class="weight"
                data-table-weight={row.index}
                value={String(row.entry.weight)}
                oninput={(e) =>
                  setDraft(withRowWeight(draft, row.index, (e.target as HTMLInputElement).value))}
              />
            </td>
            <td class="pct" data-table-percent={row.index}>{row.percent} %</td>
          {:else}
            <td>
              <input
                class="weight"
                data-table-range={row.index}
                value={rangeTextOf(row)}
                placeholder="3-5"
                oninput={(e) =>
                  setDraft(withRowRange(draft, row.index, (e.target as HTMLInputElement).value))}
              />
            </td>
          {/if}
          <td>
            <input
              data-table-text={row.index}
              value={row.entry.text}
              oninput={(e) =>
                setDraft(withRowText(draft, row.index, (e.target as HTMLInputElement).value))}
            />
            {#if row.refLabel}
              <span class="refline" data-table-ref-line={row.index}>{row.refLabel}</span>
            {/if}
          </td>
          <td>
            <input
              class="count"
              data-table-count={row.index}
              value={String(row.entry.count)}
              oninput={(e) =>
                setDraft(withRowCount(draft, row.index, (e.target as HTMLInputElement).value))}
            />
          </td>
          <td class="reftools">
            <button
              type="button"
              data-table-ref-bestiary={row.index}
              onclick={() => (pickerRow = row.index)}>▸ bestiary</button
            >
            <button
              type="button"
              data-table-ref-world={row.index}
              onclick={() => (actorRow = actorRow === row.index ? null : row.index)}
              >▸ world</button
            >
            {#if (row.entry.refs ?? []).length > 0}
              <button
                type="button"
                data-table-ref-clear={row.index}
                onclick={() => setDraft(withRowRefs(draft, row.index, []))}>clear</button
              >
            {/if}
          </td>
          <td class="rowtools">
            <button
              type="button"
              data-table-row-up={row.index}
              onclick={() => setDraft(moveRow(draft, row.index, -1))}>↑</button
            >
            <button
              type="button"
              data-table-row-down={row.index}
              onclick={() => setDraft(moveRow(draft, row.index, 1))}>↓</button
            >
            <button
              type="button"
              data-table-row-remove={row.index}
              onclick={() => setDraft(removeRow(draft, row.index))}>×</button
            >
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="rowfoot">
    <span class="total" data-table-total>
      {draft.mode === "weighted" ? `total ${view.totalPercent} %` : `die ${draft.formula || "—"}`}
    </span>
    <button type="button" data-table-add-row onclick={() => setDraft(addRow(draft))}
      >＋ Add row</button
    >
    <button type="button" data-table-paste-open onclick={() => (pasteOpen = !pasteOpen)}
      >⤒ paste rows</button
    >
  </div>

  {#if pasteOpen}
    <div class="paste">
      <textarea
        data-table-paste-text
        rows="3"
        placeholder="30, Goblin bandits, 2&#10;25, A merchant caravan, wary"
        value={pasteText}
        oninput={(e) => (pasteText = (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <button type="button" data-table-paste-apply onclick={doPaste}>Read rows</button>
    </div>
  {/if}

  {#if view.check.errors.length > 0}
    <p class="note error" data-table-error>{view.check.errors.join(" ")}</p>
  {/if}
  {#if view.check.warnings.length > 0}
    <p class="note warn" data-table-warning>{view.check.warnings.join(" ")}</p>
  {/if}
  {#if error}
    <p class="note error" data-table-convert-error>{error}</p>
  {/if}
  {#each notes as note, i (i)}
    <p class="note" data-table-note={i}>{note}</p>
  {/each}

  <h4>Activates</h4>
  <div class="tags">
    {#each TAG_KEYS as tag (tag)}
      <label class="chip" class:off={!draft.tags[tag]}>
        <input
          type="checkbox"
          data-table-tag={tag}
          checked={draft.tags[tag]}
          onchange={() =>
            setDraft(withTags(draft, { [tag]: !draft.tags[tag] }))}
        /> {tag}
      </label>
    {/each}
  </div>

  <div class="extras">
    <label
      >Linked battle scene
      <select
        data-table-scene
        value={draft.sceneId}
        onchange={(e) => setDraft(withScene(draft, (e.target as HTMLSelectElement).value))}
      >
        <option value="">(none)</option>
        {#each choices as choice (choice.id)}
          <option value={choice.id}>{choice.name}</option>
        {/each}
      </select>
    </label>
    <label
      >Cooldown
      <select
        data-table-cooldown
        value={draft.cooldownSeconds === null ? "phase" : String(draft.cooldownSeconds)}
        onchange={(e) =>
          setDraft(withCooldown(draft, (e.target as HTMLSelectElement).value === "phase"
            ? null
            : Number((e.target as HTMLSelectElement).value)))}
      >
        <option value="phase">1 phase</option>
        <option value="3600">1 hour</option>
        <option value="21600">6 hours</option>
        <option value="86400">24 hours</option>
      </select>
    </label>
  </div>

  <footer class="foot">
    <button type="button" data-table-test onclick={testRollNow}>Test roll</button>
    {#if attachers.length > 0 && !tableId}
      <span class="attach" data-table-attach-note>attaches to hex {cellKey} on save</span>
    {/if}
    <span class="spacer"></span>
    <button type="button" data-table-cancel onclick={() => onClose?.()}>Cancel</button>
    <button type="button" class="primary" data-table-save onclick={save}>Save</button>
  </footer>
</div>

{#if pickerRow !== null}
  <div class="overlay" data-table-picker>
    <PF1eCompendiumPicker
      kind="actor"
      worldId={client.world?.id}
      onSelect={pickCompendium}
      onClose={() => (pickerRow = null)}
    />
  </div>
{/if}

{#if actorRow !== null}
  <div class="overlay" data-table-actor-picker>
    <div class="actorlist">
      <p>An entity from this world</p>
      {#if actors.length === 0}
        <p class="hint">This world has no actors yet.</p>
      {/if}
      {#each actors as actor (actor._id)}
        <button
          type="button"
          data-table-actor-option={actor._id}
          onclick={() => pickActor(actor._id)}
          >{actor.name}</button
        >
      {/each}
      <button type="button" data-table-actor-cancel onclick={() => (actorRow = null)}
        >Cancel</button
      >
    </div>
  </div>
{/if}

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    font: 12px/1.4 system-ui, sans-serif;
    color: var(--fg, #e8e8ea);
    overflow: auto;
    height: 100%;
  }
  .head {
    display: flex;
    gap: 12px;
    align-items: flex-end;
  }
  .name {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mode {
    display: flex;
    gap: 8px;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 4px;
    padding: 2px 6px 4px;
  }
  .mode legend {
    padding: 0 4px;
  }
  input,
  textarea,
  select {
    background: var(--input-bg, #1c1c22);
    color: inherit;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 3px;
    padding: 3px 5px;
    font: inherit;
  }
  table.rows {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-weight: 500;
    opacity: 0.7;
    padding: 2px 3px;
  }
  td {
    padding: 1px 3px;
    vertical-align: top;
  }
  .num {
    opacity: 0.6;
    width: 18px;
  }
  .weight,
  .count {
    width: 54px;
  }
  .count {
    width: 44px;
  }
  .pct {
    width: 46px;
    opacity: 0.8;
  }
  .refline {
    display: block;
    opacity: 0.7;
    font-size: 11px;
  }
  .reftools,
  .rowtools {
    white-space: nowrap;
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
  button.primary {
    border-color: #6c8;
  }
  .rowfoot {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .total {
    opacity: 0.85;
  }
  .note {
    margin: 0;
    opacity: 0.85;
  }
  .note.error {
    color: #f88;
  }
  .note.warn {
    color: #fc8;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 10px;
    padding: 1px 7px;
  }
  .chip.off {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .extras {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .extras label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
    border-top: 1px solid var(--line, #3a3a44);
    padding-top: 6px;
  }
  .spacer {
    flex: 1;
  }
  .attach {
    opacity: 0.7;
  }
  .overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
  }
  .actorlist {
    background: var(--panel-bg, #14141a);
    border: 1px solid var(--line, #3a3a44);
    border-radius: 5px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 70%;
    overflow: auto;
    min-width: 220px;
  }
  .hint {
    opacity: 0.7;
  }
</style>
