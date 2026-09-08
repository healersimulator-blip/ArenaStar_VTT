<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ActorDocument } from "../../core/documents";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import PF1eAcConversion from "./PF1eAcConversion.svelte";
  import { previewAcConversion, type AcRequest } from "./pf1eAcConversion";
  import PF1eAttackEditor from "./PF1eAttackEditor.svelte";
  import { pf1eAttackEdit, type AttackEdit } from "./pf1eAttackEditor";
  import PF1eDetailsEditor from "./PF1eDetailsEditor.svelte";
  import { can } from "../../core/permissions";
  import {
    SHEET_FIELDS,
    sheetRecord,
    pf1eDetailEdit,
    type DetailEdit,
    authoredNumber,
    pf1eSheetEdit,
    pf1eSheetView,
    type SheetField,
  } from "./pf1eSheetModel";

  let {
    doc,
    client,
    bus,
  }: { doc: ActorDocument; client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  let tab = $state<
    | "summary"
    | "attributes"
    | "combat"
    | "weapons"
    | "armor"
    | "features"
    | "monster"
    | "details"
  >("summary");
  let error = $state("");
  const pending = new SvelteSet<string>();
  let view = $derived(pf1eSheetView(doc));
  let d = $derived(view.derived);
  let editable = $derived(client.user !== null && can(client.user, "update", doc, "actors"));
  let fields = $derived(
    SHEET_FIELDS.filter(([key]) =>
      tab === "attributes" ? key.startsWith("abilities.") : !key.startsWith("abilities."),
    ),
  );

  function applyAcSource(request: AcRequest): void {
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = previewAcConversion(current, client.user, request);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function updateAttack(edit: AttackEdit): void {
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = pf1eAttackEdit(current, client.user, edit);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function updateDetail(edit: DetailEdit): void {
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = pf1eDetailEdit(current, client.user, edit);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function update(field: SheetField, raw: string): void {
    // Read the latest projected document so a stale UI cannot restore old ownership/data.
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = pf1eSheetEdit(current, client.user, field, raw);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }
  onMount(() => {
    const offRejected = bus.on("rejected", (event) => {
      if (pending.delete(event.txId)) error = `Edit rejected: ${event.detail || event.reason}`;
    });
    const offOps = bus.on("ops", (event) => {
      if (event.reconciled) pending.delete(event.reconciled);
    });
    return () => {
      offRejected();
      offOps();
    };
  });
</script>

<section class="pf1e-sheet" aria-label="PF1e character sheet" data-pf1e-sheet>
  <header>
    <h3>{doc.name}</h3>
    <span>PF1e · {d.size}</span>
  </header>
  <nav aria-label="PF1e sheet tabs">
    {#each ["summary", "attributes", "combat", "weapons", "armor", "features", ...(sheetRecord(view.authored.creature) ? ["monster"] : []), "details"] as name (name)}
      <button
        type="button"
        class:active={tab === name}
        onclick={() => {
          tab = name as typeof tab;
          error = "";
        }}>{name}</button
      >
    {/each}
  </nav>
  {#if !editable}<p>Read-only (no ownership)</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if tab === "summary"}
    {#if d.hpMax > 0}
      <progress
        aria-label="Hit points"
        value={Math.max(0, Math.min(d.hp, d.hpMax))}
        max={d.hpMax}
      ></progress>
    {/if}
    <dl>
      <dt>HP</dt>
      <dd>{d.hp} / {d.hpMax} · {d.nonlethalDamage} nonlethal</dd>
      <dt>Temporary HP (manual)</dt>
      <dd data-temp-hp>{d.tempHp} · separate from current/max HP</dd>
      <dt>Energy resistance (manual)</dt>
      <dd data-energy-resistance>
        {Object.entries(d.energyResistance)
          .map(([type, value]) => `${type} ${value}`)
          .join(" · ")}
      </dd>
      <dt>AC / touch / flat-footed</dt>
      <dd data-pf1e-ac>{d.ac.normal} / {d.ac.touch} / {d.ac.flatFooted}</dd>
      <dt>Initiative</dt>
      <dd>{d.initiative}</dd>
      <dt>Fort / Ref / Will</dt>
      <dd>{d.saves.fort} / {d.saves.ref} / {d.saves.will}</dd>
      <dt>CMB / CMD</dt>
      <dd>{d.cmb} / {d.cmd}</dd>
      <dt>Speed</dt>
      <dd>{d.speedFt} ft</dd>
      <dt>DR</dt>
      <dd>{d.dr} / {d.drBypass.join(", ") || "—"}</dd>
      <dt>Spell resistance</dt>
      <dd>{d.spellResistance}</dd>
      <dt>Fast healing / regeneration</dt>
      <dd>{d.fastHealing} / {d.regeneration} (recorded; recovery is not automated)</dd>
      <dt>Conditions</dt>
      <dd>{d.conditions.join(", ") || "None"}</dd>
    </dl>
    <p class="note">
      Temporary HP and energy resistance are manually adjudicated records; absorption, source
      stacking and expiration are not automated. Ability damage is not yet modeled. Derived
      values are read-only. Editing a score does not roll initiative or resolve combat.
    </p>
  {:else if tab === "attributes" || tab === "combat"}
    {#if tab === "combat"}
      <p class="note">
        Saves are {view.authored.savesAsTotal === true
          ? "published totals (ability already included)"
          : "base values (ability added in summary)"}.
      </p>
    {/if}
    {#each fields as [key, label] (key)}
      <label
        >{label}
        <input
          type="number"
          step="1"
          data-pf1e-field={key}
          value={authoredNumber(doc, key) ?? ""}
          placeholder="Not authored"
          disabled={!editable}
          onchange={(e) => update(key, e.currentTarget.value)}
        />
      </label>
    {/each}
    {#if tab === "attributes"}
      <p>
        Effective scores: {Object.entries(d.abilities)
          .map(([key, score]) => `${key.toUpperCase()} ${score}`)
          .join(" · ")}
      </p>
      <p>
        Modifiers: {Object.entries(d.abilityMods)
          .map(([key, mod]) => `${key.toUpperCase()} ${mod}`)
          .join(" · ")}
      </p>
    {:else}
      <h4>Attack readout</h4>
      {#each d.attacks as attack, i (i)}
        <p>
          <strong>{attack.name}</strong>
          {attack.attackBonuses.join(" / ")} · {attack.damageDice ?? "—"}
          {attack.damageBonus >= 0 ? "+" : ""}{attack.damageBonus} · {attack.critThreatMin}–20/×{attack.critMultiplier}
        </p>
      {/each}
      <p class="note">
        Edit authored lines in Weapons. Attack rolls and damage application are not implemented
        in this slice.
      </p>
    {/if}
  {:else if tab === "weapons"}
    <PF1eAttackEditor {doc} {editable} derivedAttacks={d.attacks} onEdit={updateAttack} />
  {:else if tab === "armor" || tab === "features" || tab === "monster"}
    <PF1eDetailsEditor
      {doc}
      {editable}
      mode={tab}
      publishedAc={d.acFromTotals}
      onEdit={updateDetail}
    />
    {#if tab === "armor" && editable}
      <PF1eAcConversion {doc} user={client.user} onApply={applyAcSource} />
    {/if}
  {:else}
    <h4>Calculation breakdown</h4>
    <dl>
      {#each Object.entries(d.explain) as [key, text] (key)}<dt>{key}</dt>
        <dd>{text}</dd>{/each}
    </dl>
    <h4>Import and validation notes</h4>
    {#each [...d.issues, ...d.converted, ...d.unsupported, ...view.effectErrors] as note, i (i)}<p
      >
        {note}
      </p>{/each}
    <details>
      <summary>Defaults used ({d.defaults.length})</summary>{#each d.defaults as note, i (i)}<p>
          {note}
        </p>{/each}
    </details>
    <h4>Authored details (read-only)</h4>
    <pre>{JSON.stringify(
        {
          tempHp: view.authored.tempHp,
          energyResistance: view.authored.energyResistance,
          creature: view.authored.creature,
          feats: view.authored.feats,
          traits: view.authored.traits,
          spells: view.authored.spells,
        },
        null,
        2,
      )}</pre>
  {/if}
</section>

<style>
  .pf1e-sheet {
    padding: 8px;
    background: #121820;
    color: #e0e5ed;
    font-size: 12px;
    border: 1px solid #3a4656;
    border-radius: 6px;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
  }
  h3,
  h4 {
    margin: 8px 0;
  }
  header span,
  .note {
    color: #9eafc5;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 8px 0;
  }
  button {
    text-transform: capitalize;
    background: #202b3a;
    color: #e0e5ed;
    border: 1px solid #435773;
    border-radius: 4px;
    padding: 5px;
    cursor: pointer;
  }
  button.active {
    background: #315781;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 6px;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  dt {
    color: #9eafc5;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  input {
    min-width: 0;
    width: 100px;
    background: #202b3a;
    color: #e0e5ed;
    border: 1px solid #435773;
    border-radius: 4px;
    padding: 5px;
  }
  input:disabled {
    opacity: 0.6;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  [role="alert"] {
    color: #ffb5a5;
  }
</style>
