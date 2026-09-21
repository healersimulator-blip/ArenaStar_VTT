<!--
  Plan §1.3 (G-03/G-04) — the **Items tab**: the inventory surface over
  `ActorDocument.items` (embedded since the core contract, never rendered until now).

  Every number on this tab comes from `pf1eItemsTab.ts` → `packages/pf1e/inventory.ts`
  (Table 7-4 capacity, Table 7-5 encumbrance effects, coin weight, stack weights); every
  write is an ordinary embedded-document Op the sheet's client submits, so host
  authorization stays decisive. The tab owns no rules arithmetic of its own.
-->
<script lang="ts">
  import type { ActorDocument } from "../../core/documents";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { Op } from "../../core/ops";
  import { worldSettingsFrom } from "../../core/worldSettings";
  import {
    addWorldItemOp,
    authoredSpellRows,
    createAttackFromWeaponOp,
    generatedConsumableItem,
    observeWorldItems,
    pf1eItemsView,
    setCurrencyOp,
    setItemContainerOp,
    setItemFlagOp,
    setItemQuantityOp,
    setItemUsesOp,
    worldItemRows,
    type PF1eWorldItemRow,
  } from "./pf1eItemsTab";
  import { spendUse, restoreUse, type PF1eConsumableKind } from "../../packages/pf1e/consumables";
  import type { PF1eInventoryItem, PF1eCurrency } from "../../packages/pf1e/inventory";

  let {
    doc,
    client,
    bus,
    editable,
    onOpenItem,
  }: {
    doc: ActorDocument;
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    editable: boolean;
    /** Opens the item window (WindowHost owns the manager; the sheet only asks). */
    onOpenItem?: ((itemId: string) => void) | undefined;
  } = $props();

  const view = $derived(
    pf1eItemsView(doc, worldSettingsFrom(client.store.getAll("settings"))),
  );
  let notice = $state("");
  let error = $state("");
  let spellName = $state("");
  let spellKind = $state<PF1eConsumableKind>("wand");

  const spells = $derived(authoredSpellRows(doc.system));

  /**
   * The world's imported items (a compendium *Item* import lands there), refreshed on every
   * store event. Adding one embeds a copy on this actor — the sheet gesture for a conversion
   * pack's weapon, without a drag-and-drop channel the window host does not have.
   */
  let worldItems = $state<unknown[]>([]);
  const worldRows = $derived(worldItemRows(worldItems));
  $effect(() => observeWorldItems(client, bus, (next) => (worldItems = next)));

  /** Every write goes through the host's op pipeline — a refusal surfaces in the log. */
  function submit(ops: Op[]): void {
    error = "";
    client.submit(ops);
    notice = "saved";
  }

  function toggleEquipped(item: PF1eInventoryItem): void {
    submit([setItemFlagOp(doc._id, item.id, "equipped", !item.equipped)]);
  }
  function toggleCarried(item: PF1eInventoryItem): void {
    submit([setItemFlagOp(doc._id, item.id, "carried", !item.carried)]);
  }
  function setQuantity(item: PF1eInventoryItem, value: number): void {
    submit([setItemQuantityOp(doc._id, item.id, value)]);
  }
  function setContainer(item: PF1eInventoryItem, containerId: string): void {
    submit([setItemContainerOp(doc._id, item.id, containerId === "" ? null : containerId)]);
  }
  function uses(item: PF1eInventoryItem, direction: "spend" | "restore"): void {
    const outcome = direction === "spend" ? spendUse(item) : restoreUse(item);
    if (!outcome.ok) {
      error = outcome.error ?? "refused";
      return;
    }
    error = "";
    if (outcome.uses) submit([setItemUsesOp(doc._id, item.id, outcome.uses)]);
  }
  function makeAttack(item: PF1eInventoryItem): void {
    const built = createAttackFromWeaponOp(doc, item);
    if ("error" in built) {
      error = built.error;
      return;
    }
    error = "";
    submit([built.op]);
    notice = `attack line created for ${item.name}`;
  }
  function setCurrency(key: keyof PF1eCurrency, value: string): void {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    submit([setCurrencyOp(doc._id, { ...view.currency, [key]: n })]);
  }
  function makeConsumable(): void {
    const spell = spells.find((s) => s.name === spellName);
    if (!spell) {
      error = "Pick a spell to store in the item first.";
      return;
    }
    const generated = generatedConsumableItem(spell, spellKind, doc._id);
    error = "";
    submit([
      {
        kind: "create",
        coll: "items",
        parent: { coll: "actors", id: doc._id },
        data: generated.data,
      } as unknown as Op,
    ]);
    notice = `${generated.name} created`;
  }

  /** Embed one of the world's imported items on this actor (a converted pack's weapon). */
  function addWorldItem(row: PF1eWorldItemRow): void {
    const source = worldItems.find(
      (w) => typeof (w as { _id?: unknown })._id === "string" && (w as { _id: string })._id === row.id,
    );
    if (source === undefined) {
      error = `"${row.name}" is no longer in the world's items.`;
      return;
    }
    const built = addWorldItemOp(doc, source);
    if ("error" in built) {
      error = built.error;
      return;
    }
    error = "";
    submit([built.op]);
    notice = `${built.row.name} added to ${doc.name}`;
  }
</script>

<section class="items" aria-label="Inventory" data-pf1e-items>
  <div class="currency" data-pf1e-currency>
    <span class="label">Currency</span>
    {#each [["pp", "pp"], ["gp", "gp"], ["sp", "sp"], ["cp", "cp"]] as [key, label] (key)}
      <label>
        {label}
        <input
          type="number"
          min="0"
          step="1"
          data-pf1e-coin={key}
          value={view.currency[key as keyof PF1eCurrency]}
          disabled={!editable}
          onchange={(e) => setCurrency(key as keyof PF1eCurrency, (e.currentTarget as HTMLInputElement).value)}
        />
      </label>
    {/each}
    <span class="note" data-pf1e-currency-value>= {view.currencyGp} gp in coin</span>
  </div>

  <div class="load" data-pf1e-load={view.load.level}>
    <span class="label">Load</span>
    <progress
      aria-label="Carried weight"
      value={view.carriedLb}
      max={Math.max(1, view.capacityLb.heavy)}
    ></progress>
    <strong data-pf1e-carried-weight>{view.carriedLb} lb</strong>
    <span class="note">
      light {view.capacityLb.light} · medium {view.capacityLb.medium} · heavy {view.capacityLb.heavy}
    </span>
    {#if view.load.encumbered}
      <span class="warn" data-pf1e-load-effect>
        {view.load.level} load — max Dex {view.load.maxDexBonus ?? "—"}, check penalty −{view.load.checkPenalty},
        speed {view.load.speedFt} ft{#if view.load.slowAndSteady} (speed unaffected: Slow and Steady){/if}
      </span>
    {:else if view.load.level === "overloaded"}
      <span class="warn">over the heavy column: a character can lift, not carry, this much</span>
    {:else}
      <span class="note">light load — no penalty</span>
    {/if}
    {#if view.encumbranceOff}<span class="note">(encumbrance is switched off in world settings)</span>{/if}
  </div>

  <div class="totals">
    <span class="note" data-pf1e-inventory-value>value {view.totalValueGp} gp</span>
    <span class="note" data-pf1e-item-count>{view.items.length} item(s)</span>
    {#if view.unpriced.length > 0}
      <span class="note">unpriced: {view.unpriced.join(", ")}</span>
    {/if}
  </div>

  {#if error}<p class="warn" role="alert" data-pf1e-items-error>{error}</p>{/if}
  {#if notice && error === ""}<p class="note" data-pf1e-items-notice>{notice}</p>{/if}

  {#if view.items.length === 0}
    <p class="note">No items yet. Import one from the compendium, or create a consumable below.</p>
  {:else}
    <ul class="item-list">
      {#each view.roots as node (node.item.id)}
        <li data-pf1e-item={node.item.id} data-pf1e-item-name={node.item.name} class:unequipped={!node.item.equipped}>
          <div class="row">
            <span class="cat" data-pf1e-item-category={node.item.category}>{node.item.category}</span>
            {#if onOpenItem}
              <button type="button" class="name" data-pf1e-item-open onclick={() => onOpenItem(node.item.id)}
                >{node.item.name}</button
              >
            {:else}
              <span class="name">{node.item.name}</span>
            {/if}
            <span class="note" data-pf1e-item-weight>
              {node.item.totalWeightLb} lb{node.item.quantity > 1 ? ` (${node.item.quantity} × ${node.item.weightLb ?? 0})` : ""}
            </span>
            <span class="note" data-pf1e-item-price>
              {node.item.priceGp === null ? "—" : `${node.item.priceGp * node.item.quantity} gp`}
            </span>
            {#if node.item.uses}
              <span class="note" data-pf1e-item-uses>
                {node.item.uses.value}{node.item.uses.max === null ? "" : `/${node.item.uses.max}`}
                {node.item.uses.per ?? "uses"}
              </span>
            {/if}
            {#if node.item.armor}
              <span class="note" data-pf1e-item-armor>
                {node.item.armor.slot === "shield" ? `shield +${node.item.armor.shieldBonus}` : `armor +${node.item.armor.armorBonus}`}
                {#if node.item.armor.maxDexBonus !== null}· max Dex +{node.item.armor.maxDexBonus}{/if}
                {#if node.item.armor.checkPenalty > 0}· ACP −{node.item.armor.checkPenalty}{/if}
              </span>
            {/if}
            {#if editable}
              <span class="actions">
                <button
                  type="button"
                  data-pf1e-item-equip
                  onclick={() => toggleEquipped(node.item)}
                  >{node.item.equipped ? "Unequip" : "Equip"}</button
                >
                <button
                  type="button"
                  data-pf1e-item-qty={node.item.id}
                  onclick={() => setQuantity(node.item, node.item.quantity + 1)}
                  title="Add one"
                  >+1</button
                >
                <button
                  type="button"
                  onclick={() => setQuantity(node.item, node.item.quantity - 1)}
                  title="Remove one"
                  >−1</button
                >
                {#if node.item.uses}
                  <button type="button" data-pf1e-item-use onclick={() => uses(node.item, "spend")}>Use</button>
                  <button type="button" onclick={() => uses(node.item, "restore")}>Recharge</button>
                {/if}
                {#if node.item.weapon}
                  <button type="button" data-pf1e-item-make-attack onclick={() => makeAttack(node.item)}
                    >Attack</button
                  >
                {/if}
                <button
                  type="button"
                  data-pf1e-item-carry
                  onclick={() => toggleCarried(node.item)}
                  >{node.item.carried ? "Stow" : "Carry"}</button
                >
                <select
                  aria-label="Container"
                  data-pf1e-item-container={node.item.id}
                  value={node.item.containerId ?? ""}
                  onchange={(e) => setContainer(node.item, (e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">— top level —</option>
                  {#each view.items.filter((i) => i.id !== node.item.id) as other (other.id)}
                    <option value={other.id}>{other.name}</option>
                  {/each}
                </select>
              </span>
            {/if}
          </div>
          {#if node.children.length > 0}
            <ul class="contents" data-pf1e-container={node.item.id}>
              {#each node.children as child (child.id)}
                <li data-pf1e-item={child.id} data-pf1e-item-name={child.name}>
                  <span class="cat">{child.category}</span>
                  {#if onOpenItem}
                    <button type="button" class="name" onclick={() => onOpenItem(child.id)}>{child.name}</button>
                  {:else}
                    <span class="name">{child.name}</span>
                  {/if}
                  <span class="note">{child.totalWeightLb} lb</span>
                  {#if editable}
                    <button type="button" onclick={() => setContainer(child, "")}>Take out</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if editable && worldRows.length > 0}
    <!-- Imported items: the world's `items` collection (a compendium Item import) → this actor. -->
    <div class="import" data-pf1e-item-import>
      <span class="label">Imported items</span>
      <ul>
        {#each worldRows as row (row.id)}
          <li data-pf1e-item-world={row.id}>
            <span class="cat">{row.category}</span>
            <span class="name">{row.name}</span>
            <span class="note">
              {row.weightLb === null ? "— lb" : `${row.weightLb} lb`}{row.priceGp === null
                ? ""
                : ` · ${row.priceGp} gp`}
            </span>
            <button type="button" data-pf1e-item-add onclick={() => addWorldItem(row)}>Add</button>
          </li>
        {/each}
      </ul>
      <span class="note">
        Import an item pack from the Compendia tab, then add it here — the document is embedded
        on this actor as a copy (the world original stays where it is).
      </span>
    </div>
  {/if}

  {#if editable}
    <div class="make" data-pf1e-make-consumable>
      <span class="label">Store a spell</span>
      <select aria-label="Spell" bind:value={spellName} disabled={spells.length === 0}>
        <option value="">— spell —</option>
        {#each spells as s (s.name)}
          <option value={s.name}>{s.name} (level {s.level})</option>
        {/each}
      </select>
      <select aria-label="Item kind" bind:value={spellKind}>
        <option value="wand">Wand (50 charges)</option>
        <option value="scroll">Scroll (single use)</option>
        <option value="potion">Potion (single use)</option>
        <option value="staff">Staff (10 charges)</option>
      </select>
      <button
        type="button"
        data-pf1e-make-consumable-apply
        disabled={spellName === ""}
        onclick={makeConsumable}>Create item</button
      >
      <span class="note">
        The item's DC is its own (10 + spell level + the minimum ability modifier) and its caster
        level is the item's, not the wielder's.
      </span>
    </div>
  {/if}

  {#if view.issues.length > 0}
    <details class="diagnostics">
      <summary>{view.issues.length} data note(s)</summary>
      {#each view.issues as issue (issue)}<p class="note">{issue}</p>{/each}
    </details>
  {/if}
</section>

<style>
  .items {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-weight: 600;
  }
  .currency,
  .load,
  .totals,
  .make {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .import {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px dashed #3a4656;
    border-radius: 4px;
    padding: 6px;
  }
  .import ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .import li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .currency label {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .currency input {
    width: 56px;
    background: #171a22;
    border: 1px solid #2c3242;
    color: #e8e8ee;
    border-radius: 4px;
    padding: 2px 4px;
  }
  .load progress {
    width: 120px;
  }
  .item-list,
  .contents {
    list-style: none;
    margin: 2px 0;
    padding: 0;
  }
  .item-list > li {
    border-top: 1px solid #2a3547;
    padding: 3px 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .cat {
    min-width: 66px;
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #8f9db3;
  }
  button.name {
    background: none;
    border: none;
    color: #9fd0ff;
    cursor: pointer;
    padding: 0;
    font: inherit;
    text-align: left;
  }
  .contents {
    margin-left: 18px;
    border-left: 1px dashed #3a4656;
    padding-left: 8px;
  }
  .contents li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .note {
    color: #9eafc5;
  }
  .warn {
    color: #d9a441;
  }
  .diagnostics summary {
    cursor: pointer;
    color: #9eafc5;
  }
</style>
