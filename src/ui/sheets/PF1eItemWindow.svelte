<!--
  Plan §1.3 item 2 — the **item sheet window**: the description, the properties, the
  `changes[]` preview and the two verbs the item owns (make an attack line from a weapon;
  cast the spell out of a wand/scroll/potion/staff). Reads the live document through the
  client's projected store and writes only through `client.submit`, like every other window.
-->
<script lang="ts">
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActorDocument, ItemDocument } from "../../core/documents";
  import type { Op } from "../../core/ops";
  import { renderMarkdown } from "../../core/markdown";
  import { can } from "../../core/permissions";
  import { worldSettingsFrom } from "../../core/worldSettings";
  import { consumableCastAuthored, spendUse, restoreUse } from "../../packages/pf1e/consumables";
  import { pf1eSheetView } from "./pf1eSheetModel";
  import {
    createAttackFromWeaponOp,
    pf1eItemView,
    setItemFlagOp,
    setItemUsesOp,
  } from "./pf1eItemsTab";
  import { resolveCastFlow } from "./pf1eCastFlow";
  import { boundCueFor, fireBoundItemCue, fxCastOutcome } from "./fxItemCue";
  import { observePF1eItem } from "./pf1eItemWindow";

  let {
    client,
    bus,
    actorId,
    itemId,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    actorId: string;
    itemId: string;
  } = $props();

  let held = $state<{ actor: ActorDocument; item: ItemDocument } | null>(null);
  let error = $state("");
  let note = $state("");
  let busy = $state(false);
  let targetId = $state("");

  $effect(() =>
    observePF1eItem(client, bus, actorId, itemId, (value) => {
      // A fresh identity re-renders after a rename/charge write; a permission change clears it.
      held = value === null ? null : { actor: { ...value.actor }, item: { ...value.item } };
    }),
  );

  const view = $derived(held === null ? null : pf1eItemView(held.actor, held.item._id));
  /**
   * D-311: the timeline bound to *this* item, as this reader may see it. The lookup is the
   * same one the use path fires, so the line can never describe a cue the cast would not
   * ask for — and a player simply sees nothing when the bound timeline is GM-only.
   */
  const boundCue = $derived(held === null ? null : boundCueFor(client, held.actor._id, held.item._id));
  const editable = $derived(
    held !== null && client.user !== null && can(client.user, "update", held.actor, "actors"),
  );
  /** Every actor the reader may see — the cast panel's target list. */
  const targets = $derived(
    (client.store.getAll("actors") as ActorDocument[]).filter(
      (a) => client.user !== null && can(client.user, "read", a, "actors"),
    ),
  );

  function submit(ops: Op[]): void {
    error = "";
    client.submit(ops);
  }

  function toggleEquipped(): void {
    if (view === null) return;
    submit([setItemFlagOp(actorId, view.item.id, "equipped", !view.item.equipped)]);
  }

  function useCharge(direction: "spend" | "restore"): void {
    if (view === null) return;
    const outcome = direction === "spend" ? spendUse(view.item) : restoreUse(view.item);
    if (!outcome.ok) {
      error = outcome.error ?? "refused";
      return;
    }
    if (outcome.uses) submit([setItemUsesOp(actorId, view.item.id, outcome.uses)]);
    note = outcome.notes.join(" · ");
  }

  function makeAttack(): void {
    if (held === null || view === null) return;
    const built = createAttackFromWeaponOp(held.actor, view.item);
    if ("error" in built) {
      error = built.error;
      return;
    }
    submit([built.op]);
    note = "attack line created on the actor sheet";
  }

  /**
   * Cast the item's spell at a target: the same `resolveCastFlow` the sheet uses, with the
   * flow's `source` set, so the charge is spent (and written) instead of a slot.
   */
  async function castFromItem(): Promise<void> {
    if (held === null || view === null || view.consumable === null) return;
    error = "";
    note = "";
    const target =
      targets.find((a) => a._id === targetId) ??
      (client.store.get("actors", targetId) as ActorDocument | undefined);
    if (!target) {
      error = "Pick a target.";
      return;
    }
    const source = view.consumable;
    const casterView = pf1eSheetView(held.actor, {
      settings: worldSettingsFrom(client.store.getAll("settings")),
    });
    const targetView = pf1eSheetView(target, {
      settings: worldSettingsFrom(client.store.getAll("settings")),
    });
    busy = true;
    try {
      const outcome = await resolveCastFlow(client, client.user, {
        casterActor: held.actor,
        casterDerived: casterView.derived,
        spell: { name: source.spellName, level: source.spellLevel },
        authored: consumableCastAuthored(source.spell),
        targetName: target.name,
        targetActor: target,
        targetDerived: targetView.derived,
        castingTime: "standard",
        source: {
          kind: source.kind,
          itemId: view.item.id,
          itemName: view.item.name,
          casterLevel: source.casterLevel,
          saveDc: source.saveDc,
          charges: source.charges,
        },
      });
      if (!outcome.ok) {
        error = outcome.error;
      } else {
        if (outcome.held) {
          note = `the charge is spent — the spell is held for delivery (DC ${outcome.dc})`;
        } else {
          note = `${source.spellName} cast from ${view.item.name} — DC ${outcome.dc}, ${Math.max(0, source.charges - 1)} charge(s) left`;
        }
        // D-311: the cue is requested *after* the commit — the branch follows the result the
        // host just wrote, and a use the flow refused above plays nothing at all.
        const cue = fireBoundItemCue({ client, actor: held.actor, item: held.item,
          outcome: fxCastOutcome(outcome), targetActor: target });
        if (cue.fired) note += ` · ${cue.note}`;
        else if (cue.reason === "disabled") note += " · the item's bound cue is disabled";
        else if (cue.reason === "no-branch") note += " · the item has no cue for that outcome";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

{#if view === null || held === null}
  <p role="status">Item unavailable. It may have been deleted or your access may have changed.</p>
{:else}
  <section class="item-window" data-pf1e-item-window={view.item.id}>
    <header class="head">
      <strong data-pf1e-item-window-name>{view.item.name}</strong>
      <span class="note">on {held.actor.name}</span>
      {#if editable}
        <button type="button" data-pf1e-item-window-equip onclick={toggleEquipped}
          >{view.item.equipped ? "Unequip" : "Equip"}</button
        >
      {/if}
    </header>

    {#if view.item.uses}
      <div class="uses" data-pf1e-item-window-uses>
        <span class="label">Charges</span>
        <strong>{view.item.uses.value}</strong>
        <span class="note">/ {view.item.uses.max ?? "—"} {view.item.uses.per ?? "uses"}</span>
        {#if editable}
          <button type="button" data-pf1e-item-window-use onclick={() => useCharge("spend")}>Use one</button>
          <button type="button" onclick={() => useCharge("restore")}>Recharge</button>
        {/if}
      </div>
    {/if}

    {#if view.weaponLine !== null}
      <p class="line" data-pf1e-item-window-weapon>{view.weaponLine}</p>
      {#if editable}
        <button type="button" data-pf1e-item-window-make-attack onclick={makeAttack}
          >Create attack line</button
        >
      {/if}
    {/if}

    {#each view.notes as line (line)}
      <p class="line">{line}</p>
    {/each}

    <dl class="props" data-pf1e-item-window-props>
      {#each view.properties as p (p.label)}
        <dt>{p.label}</dt>
        <dd>{p.value}</dd>
      {/each}
    </dl>

    <details
      class="changes"
      data-pf1e-item-window-changes
      open={view.changes.applied.length + view.changes.unmapped.length > 0}
    >
      <summary>
        Item changes ({view.changes.applied.length} applied{view.changes.unmapped.length > 0
          ? `, ${view.changes.unmapped.length} not applied`
          : ""})
      </summary>
      {#if view.changes.applied.length + view.changes.unmapped.length === 0}
        <p class="note">This item carries no `changes[]` block.</p>
      {:else}
        <ul>
          {#each view.changes.applied as entry (entry.key)}
            <li data-pf1e-item-window-change={entry.key}>
              <span class="badge">applied</span>
              <span data-pf1e-item-window-change-target>{entry.target}</span>
              <span class="note">{entry.type} +{entry.value}</span>
            </li>
          {/each}
          {#each view.changes.unmapped as entry (entry.target + entry.formula + entry.reason)}
            <li>
              <span class="badge refused">kept, not applied</span>
              <span>{entry.target}</span>
              {#if entry.formula !== ""}<span class="note">{entry.formula}</span>{/if}
              <span class="warn">{entry.reason}</span>
            </li>
          {/each}
        </ul>
        <p class="note">
          Only the mapped subset is applied; an unsupported target is shown, never silently
          dropped (D-112).
        </p>
      {/if}
      {#each view.changes.notes as line (line)}
        <p class="note">{line}</p>
      {/each}
    </details>

    {#if boundCue}
      <p class="note" data-pf1e-item-window-fx>
        Bound cue: <strong>{boundCue.name}</strong>
        {#if boundCue.fxItem?.onFailureId}
          · a failed use plays the bound failure cue
        {/if}
        {#if boundCue.fxItem?.recognition === "success" || boundCue.fxItem?.recognition === "failure"}
          · recognition forced to {boundCue.fxItem.recognition}
        {/if}
        {#if boundCue.fxItem?.enabled === false}
          · <span class="warn">disabled</span>
        {/if}
      </p>
    {/if}

    {#if view.consumable}
      <section class="cast" data-pf1e-item-window-cast>
        <h4>
          {view.consumable.kind}: {view.consumable.spellName} (level {view.consumable.spellLevel})
        </h4>
        <p class="note">
          Item caster level {view.consumable.casterLevel} · save DC {view.consumable.saveDc}
          (the item's own DC, never the wielder's)
        </p>
        {#if view.consumable.noLedger}
          <p class="warn">No charge ledger on this item — cast it from the sheet's spell tab.</p>
        {:else}
          <div class="cast-row">
            <label>
              Target
              <select bind:value={targetId} data-pf1e-item-window-target disabled={!editable}>
                <option value="">— target —</option>
                {#each targets as t (t._id)}
                  <option value={t._id}>{t.name}</option>
                {/each}
              </select>
            </label>
            <button
              type="button"
              data-pf1e-item-window-cast-apply
              disabled={!editable || busy || !view.consumable.castable}
              onclick={() => void castFromItem()}
              >{busy ? "Casting…" : `Cast (${view.consumable.charges} charge${view.consumable.charges === 1 ? "" : "s"} left)`}</button
            >
          </div>
        {/if}
      </section>
    {/if}

    {#if error}<p class="warn" role="alert" data-pf1e-item-window-error>{error}</p>{/if}
    {#if note && error === ""}<p class="note" data-pf1e-item-window-note>{note}</p>{/if}

    {#if view.item.description.trim() !== ""}
      <div class="description" data-pf1e-item-window-description>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown -->
        {@html renderMarkdown(view.item.description)}
      </div>
    {:else}
      <p class="note">No description on this item.</p>
    {/if}
  </section>
{/if}

<style>
  .item-window {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .label {
    font-weight: 600;
  }
  .uses,
  .cast-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .line {
    margin: 0;
  }
  .props {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 10px;
    margin: 4px 0;
  }
  .props dt {
    color: #8f9db3;
  }
  .props dd {
    margin: 0;
  }
  .changes ul {
    list-style: none;
    margin: 4px 0;
    padding: 0;
  }
  .changes li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .badge {
    border: 1px solid #2f6b3a;
    background: #16301c;
    color: #8fd8a0;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 0.82em;
  }
  .badge.refused {
    border-color: #6b5a2f;
    background: #302a16;
    color: #d9c06a;
  }
  .note {
    color: #9eafc5;
  }
  .warn {
    color: #d9a441;
  }
  .description :global(p) {
    margin: 4px 0;
  }
</style>
