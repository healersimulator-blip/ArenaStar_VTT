<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    pf1eAttackRollGroups,
    pf1eInitiativeRollSpec,
    pf1eSaveRollSpecs,
    type PF1eRollSpec,
  } from "../../packages/pf1e/rollData";
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
    isPF1eActor,
    sheetRecord,
    pf1eDetailEdit,
    type DetailEdit,
    authoredNumber,
    pf1eSheetEdit,
    pf1eSheetView,
    type SheetField,
  } from "./pf1eSheetModel";
  import { resolveAttackFlow } from "./pf1eResolveFlow";
  import type { PF1eDefenseChoice } from "../../packages/pf1e/resolve";

  let {
    doc,
    client,
    bus,
  }: { doc: ActorDocument; client: ClientSync; bus: EventBus<ClientEvents> } =
    $props();
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
  let attackRolls = $derived(
    pf1eAttackRollGroups(d, {
      authoredAttacksCount: Array.isArray(view.authored.attacks)
        ? view.authored.attacks.length
        : 0,
      feats: Array.isArray(view.authored.feats) ? view.authored.feats : [],
      hasNaturalAttacks: Array.isArray(view.authored.attacks)
        ? view.authored.attacks.some(
            (a) =>
              typeof a === "object" &&
              a !== null &&
              ((a as Record<string, unknown>).natural === true ||
                (a as Record<string, unknown>).secondary === true),
          )
        : false,
    }),
  );
  let saveRolls = $derived(pf1eSaveRollSpecs(d));
  let initiativeRoll = $derived(pf1eInitiativeRollSpec(d));
  function rollSpec(spec: PF1eRollSpec): void {
    // §11: the host evaluates the formula and posts the card; the flavor line
    // is the breakdown ("Longsword +10 = BAB 6 + Str +3, size +0").
    client.roll(spec.formula, "roll", undefined, spec.flavor);
  }
  function rollAll(specs: readonly PF1eRollSpec[]): void {
    for (const spec of specs) rollSpec(spec);
  }

  // A06b — resolve one attack against a target actor: public rolls, the
  // resolution card, and HP writes through the sheet's own op path.
  let resolveTargetId = $state("");
  let resolveAttackIndex = $state(0);
  let resolveDefense = $state<PF1eDefenseChoice>("normal");
  let resolveFlanking = $state(false);
  let resolveCharging = $state(false);
  let resolveNonlethal = $state(false);
  let resolveVerifiable = $state(false);
  let resolveBusy = $state(false);
  let resolveError = $state("");
  let authoredAttacksCount = $derived(
    Array.isArray(view.authored.attacks) ? view.authored.attacks.length : 0,
  );

  function pf1eTargetActors(): ActorDocument[] {
    return (client.store.getAll("actors") as readonly ActorDocument[]).filter(
      (a) => a._id !== doc._id && isPF1eActor(a),
    );
  }

  function resolveTargetInfo(): {
    actor: ActorDocument;
    derived: ReturnType<typeof pf1eSheetView>["derived"];
  } | null {
    if (!resolveTargetId) return null;
    const actor = client.store.get("actors", resolveTargetId) as
      ActorDocument | undefined;
    if (!actor) return null;
    return { actor, derived: pf1eSheetView(actor).derived };
  }

  /** The defense dropdown label, with the picked target's derived AC appended. */
  function defenseOptionLabel(kind: PF1eDefenseChoice): string {
    const name =
      kind === "normal" ? "Normal" : kind === "touch" ? "Touch" : "Flat-footed";
    const info = resolveTargetInfo();
    if (!info) return name;
    const ac =
      kind === "normal"
        ? info.derived.ac.normal
        : kind === "touch"
          ? info.derived.ac.touch
          : info.derived.ac.flatFooted;
    return `${name} ${String(ac)}`;
  }

  async function resolveVsTarget(): Promise<void> {
    resolveError = "";
    const info = resolveTargetInfo();
    const group = attackRolls[resolveAttackIndex];
    const line = d.attacks[resolveAttackIndex];
    if (!info || !group || !line) {
      resolveError = "Pick an attack and a target.";
      return;
    }
    resolveBusy = true;
    try {
      const outcome = await resolveAttackFlow(client, client.user, {
        attackerName: doc.name,
        line,
        iterative: 0,
        attackFormula: group.attack.formula,
        damageFormula: group.damage?.formula ?? "0",
        critDamageFormula: group.critDamage?.formula ?? null,
        targetName: info.actor.name,
        targetActor: info.actor,
        targetDerived: info.derived,
        defense: resolveDefense,
        ...(resolveFlanking || resolveCharging
          ? {
              situational: {
                ...(resolveFlanking ? { flanking: true } : {}),
                ...(resolveCharging ? { charging: true } : {}),
              },
            }
          : {}),
        ...(resolveNonlethal ? { nonlethalDamage: true } : {}),
        // Only the derived unarmed fallback (no authored attack lines) counts
        // as the unarmed strike for the natural nonlethal bucket and IUS waiver.
        ...(authoredAttacksCount === 0 ? { unarmed: true } : {}),
        ...(Array.isArray(view.authored.feats)
          ? { feats: view.authored.feats as string[] }
          : {}),
        ...(group.provokes ? { provokes: true } : {}),
        ...(resolveVerifiable ? { verifiable: true } : {}),
      });
      if (!outcome.ok) resolveError = outcome.error;
      else if (outcome.hpWriteError !== null) {
        resolveError = outcome.hpWriteError;
      }
    } finally {
      resolveBusy = false;
    }
  }
  let editable = $derived(
    client.user !== null && can(client.user, "update", doc, "actors"),
  );
  let fields = $derived(
    SHEET_FIELDS.filter(([key]) => {
      const isAbilityBlock =
        key.startsWith("abilities.") ||
        key.startsWith("abilitiesDamage.") ||
        key.startsWith("abilitiesDrain.");
      return tab === "attributes" ? isAbilityBlock : !isAbilityBlock;
    }),
  );

  function applyAcSource(request: AcRequest): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = previewAcConversion(current, client.user, request);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function updateAttack(edit: AttackEdit): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const result = pf1eAttackEdit(current, client.user, edit);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function updateDetail(edit: DetailEdit): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
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
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
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
      if (pending.delete(event.txId))
        error = `Edit rejected: ${event.detail || event.reason}`;
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
      <dd>
        {d.fastHealing} / {d.regeneration} (recorded; recovery is not automated)
      </dd>
      <dt>Conditions</dt>
      <dd>{d.conditions.join(", ") || "None"}</dd>
    </dl>
    <p class="note">
      Temporary HP and energy resistance are manually adjudicated records;
      absorption, source stacking and expiration are not automated. Ability
      damage is not yet modeled. Derived values are read-only. Editing a score
      does not roll initiative or resolve combat.
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
        Effective modifiers: {Object.entries(d.abilityMods)
          .map(([key, mod]) => `${key.toUpperCase()} ${mod}`)
          .join(" · ")}
      </p>
      {#if Object.values(d.abilityDamageTaken).some((n) => n > 0) || Object.values(d.abilityDrainTaken).some((n) => n > 0)}
        <p class="note" data-pf1e-ability-damage>
          Ability damage/drain (CRB p.555 — damage never reduces the score; –1
          per 2 points):<br />
          {Object.entries(d.abilityDamageTaken)
            .filter(([, n]) => n > 0)
            .map(
              ([key, n]) =>
                `${key.toUpperCase()} damage ${n} (−${d.abilityDamagePenalty[key as keyof typeof d.abilityDamagePenalty]})`,
            )
            .join(" · ")}
          {Object.entries(d.abilityDrainTaken)
            .filter(([, n]) => n > 0)
            .map(([key, n]) => `${key.toUpperCase()} drain ${n}`)
            .join(" · ")}
        </p>
      {/if}
    {:else}
      <h4>Attacks</h4>
      {#each attackRolls as group, i (i)}
        <div class="attack-line" data-pf1e-attack={group.label}>
          <p>
            <strong>{group.label}</strong>
            {group.attack.formula}
            {#if group.provokes}<span class="warn" data-pf1e-provokes
                >⚠ provokes an AoO</span
              >{/if}
          </p>
          <div class="rolls">
            <button type="button" onclick={() => rollSpec(group.attack)}
              >Attack</button
            >
            {#if group.fullAttack.length > 1}
              <button type="button" onclick={() => rollAll(group.fullAttack)}
                >Full attack</button
              >
            {/if}
            {#if group.damage}
              <button type="button" onclick={() => rollSpec(group.damage)}
                >Damage</button
              >
            {/if}
            {#if group.critDamage}
              <button type="button" onclick={() => rollSpec(group.critDamage)}
                >Crit ×{d.attacks[i]?.critMultiplier}</button
              >
            {/if}
          </div>
          {#if group.notes.length > 0}
            <p class="note">{group.notes.join(" · ")}</p>
          {/if}
        </div>
      {/each}
      <h4>Resolve vs target</h4>
      <div class="resolve" data-pf1e-resolve>
        <label
          >Attack
          <select bind:value={resolveAttackIndex}>
            {#each attackRolls as group, i (i)}
              <option value={i}>{group.label} {group.attack.formula}</option>
            {/each}
          </select>
        </label>
        <label
          >Target
          <select bind:value={resolveTargetId} data-pf1e-resolve-target>
            <option value="">— pick a target —</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name}</option>
            {/each}
          </select>
        </label>
        <label
          >Defense
          <select bind:value={resolveDefense} data-pf1e-resolve-defense>
            <option value="normal">{defenseOptionLabel("normal")}</option>
            <option value="touch">{defenseOptionLabel("touch")}</option>
            <option value="flatFooted"
              >{defenseOptionLabel("flatFooted")}</option
            >
          </select>
        </label>
        <label
          ><input type="checkbox" bind:checked={resolveFlanking} /> Flanking +2</label
        >
        <label
          ><input type="checkbox" bind:checked={resolveCharging} /> Charge +2</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolveNonlethal}
            data-pf1e-resolve-nonlethal
          /> Nonlethal (−4 with a lethal weapon)</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolveVerifiable}
            data-pf1e-resolve-verifiable
          /> Commit-reveal rolls (verifiable)</label
        >
        <button
          type="button"
          disabled={resolveBusy || !resolveTargetId}
          onclick={() => void resolveVsTarget()}
          data-pf1e-resolve-attack
          >{resolveBusy ? "Resolving…" : "Attack"}</button
        >
        {#if resolveError}<p class="warn" data-pf1e-resolve-error>
            {resolveError}
          </p>{/if}
      </div>
      <p class="note">
        Rolls post to chat with their breakdown; resolution rolls attack (+
        confirmation on a threat) and damage publicly and writes hp through the
        sheet's op path. The AoO interrupt queue is P6.
      </p>
      <h4>Saves & checks</h4>
      <div class="rolls">
        {#each saveRolls as spec (spec.label)}
          <button type="button" onclick={() => rollSpec(spec)}
            >{spec.label} {spec.formula}</button
          >
        {/each}
        <button type="button" onclick={() => rollSpec(initiativeRoll)}
          >{initiativeRoll.label} {initiativeRoll.formula}</button
        >
      </div>
    {/if}
  {:else if tab === "weapons"}
    <PF1eAttackEditor
      {doc}
      {editable}
      derivedAttacks={d.attacks}
      onEdit={updateAttack}
    />
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
      <summary>Defaults used ({d.defaults.length})</summary
      >{#each d.defaults as note, i (i)}<p>
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
  .resolve {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 6px;
    border: 1px solid #3a4656;
    border-radius: 6px;
  }
  .resolve label {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .attack-line {
    border-top: 1px solid #2a3547;
    padding-top: 4px;
  }
  .rolls {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .warn {
    color: #d9a441;
  }
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
