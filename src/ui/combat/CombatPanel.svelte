<script lang="ts">
  /**
   * §10 combat tracker (GM panel) — initiative order, rounds/turns, delay,
   * defeat, effect-duration badges. All state changes go through the pure
   * core transitions (core/combat.ts) and land as combats-update ops; hook
   * names from each transition fire on the §3 global Hooks bus.
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import { globalHooks } from "../../core/events";
  import type {
    ActorDocument,
    CombatDocument,
    CombatantDocument,
    SceneDocument,
  } from "../../core/documents";
  import {
    activeEffects,
    currentCombatant,
    delayCombatant,
    endCombat,
    nextTurn,
    previousTurn,
    setDefeated,
    sortCombatants,
    startCombat,
    type CombatTransition,
  } from "../../core/combat";
  import { can } from "../../core/permissions";
  import {
    encounterList,
    selectedEncounter,
    activateEncounter,
    newEncounter,
  } from "./encounters";
  import { rollSelectedInitiative, manualInitiative } from "./initiative";
  import { selectedTokens, editSelectedRoster, type TokenSelection } from "./tokenSelection";
  import { evaluateFormula } from "../../dice/engine";

  let {
    client,
    bus,
    selection = { sceneId: null, ids: [] },
    onClearSelection,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    selection?: TokenSelection;
    onClearSelection?: () => void;
  } = $props();

  let combat = $state<CombatDocument | null>(null);
  let scene = $state.raw<SceneDocument | null>(null);
  let encounters = $state.raw<CombatDocument[]>([]);
  let error = $state("");
  let encounterName = $state("");
  const tokenChoice = $derived(
    scene ? selectedTokens(scene, selection, true) : { tokens: [], error: null },
  );
  const tokens = $derived(tokenChoice.tokens);

  function context() {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    return {
      scene: scenes.find((s) => s.active) ?? scenes[0] ?? null,
      legacySceneId: scenes[0]?._id ?? "",
      combats: client.store.getAll("combats") as readonly CombatDocument[],
    };
  }
  function refresh(): void {
    const state = context();
    scene = state.scene;
    encounters = scene ? encounterList(state.combats, scene, state.legacySceneId) : [];
    combat = scene ? selectedEncounter(state.combats, scene, state.legacySceneId) : null;
  }
  function activate(id: string): void {
    const state = context();
    const target = state.combats.find((c) => c._id === id);
    if (!state.scene || !target) {
      error = "Encounter is no longer available.";
      refresh();
      return;
    }
    const result = activateEncounter(state.scene, target, client.user, state.legacySceneId);
    error = result.error ?? "";
    if (result.ops.length) client.submit(result.ops);
    refresh();
  }
  function createEncounter(start = false): void {
    const state = context();
    if (
      !state.scene ||
      !client.user ||
      !can(client.user, "create", state.scene, "combats") ||
      !can(client.user, "update", state.scene, "scenes")
    )
      return;
    const name =
      encounterName.trim() ||
      `Encounter ${encounterList(state.combats, state.scene, state.legacySceneId).length + 1}`;
    if (name.length > 120) {
      error = "Use at most 120 characters.";
      return;
    }
    const chosen = selectedTokens(state.scene, selection, true);
    if (chosen.error) {
      error = chosen.error;
      return;
    }
    let doc = newEncounter(
      { ...state.scene, tokens: chosen.tokens },
      globalThis.crypto.randomUUID(),
      name,
      () => globalThis.crypto.randomUUID(),
    );
    if (start) doc = startCombat(doc).combat;
    const activation = activateEncounter(state.scene, doc, client.user, state.legacySceneId);
    if (activation.error) {
      error = activation.error;
      return;
    }
    client.submit([{ kind: "create", coll: "combats", data: doc }, ...activation.ops]);
    encounterName = "";
    error = "";
    if (start) for (const hook of startCombat(doc).hooks) globalHooks.callAll(hook, doc);
    refresh();
  }

  function push(transition: CombatTransition): void {
    const state = context();
    const current = state.scene
      ? selectedEncounter(state.combats, state.scene, state.legacySceneId)
      : null;
    if (
      !current ||
      current._id !== transition.combat._id ||
      !client.user ||
      !can(client.user, "update", current, "combats")
    ) {
      error = "Active encounter or permissions changed. Try again.";
      refresh();
      return;
    }
    combat = transition.combat;
    for (const hook of transition.hooks) globalHooks.callAll(hook, transition.combat);
    if (!combat) return;
    client.submit([
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: {
          round: combat.round,
          turn: combat.turn,
          combatants: combat.combatants,
        },
      },
    ]);
  }

  function beginCombat(): void {
    refresh();
    if (combat) push(startCombat($state.snapshot(combat)));
    else createEncounter(true);
  }

  function updateRoster(action: "add" | "remove"): void {
    refresh();
    const state = context();
    if (!combat || !state.scene) return;
    const result = editSelectedRoster(
      $state.snapshot(combat),
      state.scene,
      selection,
      client.user,
      action,
      () => globalThis.crypto.randomUUID(),
    );
    error = result.error ?? "";
    if (result.transition) push(result.transition);
  }

  function rollInitiative(all = false): void {
    refresh();
    const state = context();
    if (!combat || !state.scene) return;
    const result = rollSelectedInitiative(
      $state.snapshot(combat),
      state.scene,
      client.store.getAll("actors") as readonly ActorDocument[],
      client.user,
      () => {
        const roll = evaluateFormula("1d20");
        return roll.ok ? roll.value.total : NaN;
      },
      all ? { sceneId: state.scene._id, ids: [] } : selection,
    );
    error = result.error ?? "";
    if (result.transition) push(result.transition);
  }

  function setInit(c: CombatantDocument, raw: string): void {
    refresh();
    if (!combat || !raw.trim() || !Number.isSafeInteger(Number(raw))) {
      error = "Enter a finite whole-number initiative.";
      return;
    }
    error = "";
    push(manualInitiative($state.snapshot(combat), c._id, Number(raw)));
  }

  const ordered = $derived(combat ? sortCombatants(combat.combatants) : []);
  const current = $derived(combat ? currentCombatant(combat) : null);
  const effects = $derived(combat ? activeEffects(combat) : []);

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", (event) => {
      error = event.detail || event.reason;
      refresh();
    });
    refresh();
    return () => {
      offSnapshot();
      offOps();
      offRejected();
    };
  });
</script>

<section class="combat" aria-label="Combat tracker">
  <h3>Combat</h3>
  <p data-combat-selection>
    {selection.ids.length} selected · {selection.ids.length
      ? "selected tokens only"
      : "all scene tokens for new encounters"}
  </p>
  {#if selection.ids.length}<button
      data-clear-combat-selection
      type="button"
      onclick={onClearSelection}>Clear selection</button
    >{/if}
  {#if selection.ids.length && !tokenChoice.error}<p data-selected-token-names>
      {tokenChoice.tokens.map((t) => t.name).join(", ")}
    </p>{/if}
  <small
    >Click a token or drag a marquee from empty canvas to select. Middle/right drag or
    Shift-drag pans.</small
  >
  {#if tokenChoice.error}<p role="status">{tokenChoice.error}</p>{/if}
  {#if combat}
    <button
      data-add-selected
      type="button"
      disabled={!selection.ids.length}
      onclick={() => updateRoster("add")}>Add selected</button
    >
    <button
      data-remove-selected
      type="button"
      disabled={!selection.ids.length}
      onclick={() => updateRoster("remove")}>Remove selected</button
    >
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <label
    >Encounter
    <select
      data-encounter-select
      value={combat?._id ?? ""}
      onchange={(e) => activate(e.currentTarget.value)}
    >
      <option value="" disabled>Select an encounter</option>
      {#each encounters as item (item._id)}<option value={item._id}>{item.name}</option>{/each}
    </select>
  </label>
  <label
    >New encounter name <input
      data-encounter-name
      maxlength="120"
      bind:value={encounterName}
    /></label
  >
  <button
    data-encounter-create
    type="button"
    disabled={!scene}
    onclick={() => createEncounter()}>Create encounter</button
  >
  <small
    >{scene?.name ?? "No active scene"} · New encounters use selected tokens, or all scene tokens
    if none are selected; switching preserves progress.</small
  >
  {#if !combat || combat.round < 1}
    <button
      id="combat-start"
      type="button"
      onclick={beginCombat}
      disabled={!combat && tokens.length === 0}
    >
      Start combat ({combat?.combatants.length ?? tokens.length} combatants)
    </button>
  {:else}
    <div class="bar">
      <button
        id="combat-prev"
        type="button"
        onclick={() => combat && push(previousTurn(combat))}
        aria-label="Previous turn">◀</button
      >
      <span class="round"
        >Round {combat.round} · {ordered.length
          ? `Turn ${combat.turn + 1}/${ordered.length}`
          : "No combatants"}</span
      >
      <button
        id="combat-next"
        type="button"
        onclick={() => combat && push(nextTurn(combat))}
        aria-label="Next turn">▶</button
      >
      <button id="combat-init" type="button" onclick={() => rollInitiative()}
        >{selection.ids.length
          ? `Roll selected (${selection.ids.length})`
          : "Roll init"}</button
      >
      {#if selection.ids.length}<button
          data-roll-all-initiative
          type="button"
          onclick={() => rollInitiative(true)}>Roll all</button
        >{/if}
      <button id="combat-end" type="button" onclick={() => combat && push(endCombat(combat))}
        >End</button
      >
    </div>
    <p class="initiative-note">
      Public rolls use linked PF1e sheet modifiers; generic actors use a flat d20.
      PF1e-containing roll batches resolve ties by total modifier, then recorded d20 roll-offs.
      Generic-only rolls and manual overrides retain stable ties. Selected rolls leave other
      results untouched; ties against unselected results keep stable order. Roll all is optional
      for full tie resolution. Initial rolls establish the first combatant; rerolls preserve the
      current combatant. Hidden rolls are blocked.
    </p>
    <ol class="order">
      {#each ordered as c (c._id)}
        <li
          class:active={current?._id === c._id}
          class:defeated={c.defeated}
          class:delayed={Boolean((c.flags as { core?: { delayed?: boolean } })?.core?.delayed)}
        >
          <span class="name">{c.name}</span>
          {#if c.flags.core?.initiativeRoll}
            <details data-initiative-receipt>
              <summary>Recorded initiative roll</summary>
              <pre>{JSON.stringify(c.flags.core.initiativeRoll, null, 2)}</pre>
            </details>
          {/if}
          <input
            class="init"
            type="number"
            value={c.initiative ?? ""}
            onchange={(e) => setInit(c, (e.target as HTMLInputElement).value)}
            aria-label={`Initiative for ${c.name}`}
          />
          <button
            type="button"
            title="Manual marker only; does not advance or reschedule a turn. Clears on turn start or round wrap."
            onclick={() => combat && push(delayCombatant(combat, c._id))}>Mark delayed</button
          >
          <button
            type="button"
            onclick={() => combat && push(setDefeated(combat, c._id, !c.defeated))}
          >
            {c.defeated ? "Revive" : "Defeat"}
          </button>
          {#each effects.filter((e) => e.combatantId === c._id) as e (e.id)}
            <span class="effect" title={e.effect.name}
              >{e.effect.name}{e.duration !== null ? ` (${e.duration})` : ""}</span
            >
          {/each}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .combat {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .round {
    font-size: 12px;
    opacity: 0.85;
  }
  .order {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .order li {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 12px;
  }
  .order li.active {
    background: #2c4a6e;
  }
  .order li.defeated .name {
    text-decoration: line-through;
    opacity: 0.5;
  }
  .order li.delayed .name::after {
    content: " ⏳";
  }
  .init {
    width: 3.5em;
  }
  .effect {
    background: #463a2c;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
  }
</style>
