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
    CombatDocument,
    CombatantDocument,
    SceneDocument,
    TokenDocument,
  } from "../../core/documents";
  import {
    activeEffects,
    applyInitiative,
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
  import { evaluateFormula } from "../../dice/engine";

  let {
    client,
    bus,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
  } = $props();

  let combat = $state<CombatDocument | null>(null);
  let tokens = $state<readonly TokenDocument[]>([]);

  function refresh(): void {
    combat = (client.store.getAll("combats") as readonly CombatDocument[])[0] ?? null;
    // tokens are embedded in the (single, bootstrap) scene — §4
    const scene = (client.store.getAll("scenes") as readonly SceneDocument[])[0];
    tokens = scene?.tokens ?? [];
  }

  function push(transition: CombatTransition): void {
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
    const existing = client.store.getAll("combats") as readonly CombatDocument[];
    if (existing.length > 0) {
      push(startCombat(existing[0] as CombatDocument));
      return;
    }
    const doc: CombatDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "combat",
      name: "Combat",
      ownership: { default: 1 },
      flags: {},
      system: {},
      round: 0,
      turn: 0,
      combatants: tokens.map((t): CombatantDocument => ({
        _id: globalThis.crypto.randomUUID(),
        type: "combatant",
        name: t.name,
        ownership: { default: 1 },
        flags: {},
        system: {},
        tokenId: t._id,
        actorId: null,
        initiative: null,
        hidden: false,
        defeated: false,
      })),
    };
    client.submit([{ kind: "create", coll: "combats", data: doc }]);
    push(startCombat(doc));
  }

  function rollInitiative(): void {
    if (!combat) return;
    const rolls: Record<string, number> = {};
    for (const c of combat.combatants) {
      const r = evaluateFormula("1d20");
      if (r.ok) rolls[c._id] = r.value.total;
    }
    push(applyInitiative(combat, rolls));
  }

  function setInit(c: CombatantDocument, value: number): void {
    if (!combat || !Number.isFinite(value)) return;
    push(applyInitiative(combat, { [c._id]: value }));
  }

  const ordered = $derived(combat ? sortCombatants(combat.combatants) : []);
  const current = $derived(combat ? currentCombatant(combat) : null);
  const effects = $derived(combat ? activeEffects(combat) : []);

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

<section class="combat" aria-label="Combat tracker">
  <h3>Combat</h3>
  {#if !combat || combat.round < 1}
    <button id="combat-start" type="button" onclick={beginCombat} disabled={tokens.length === 0}>
      Start combat ({tokens.length} tokens)
    </button>
  {:else}
    <div class="bar">
      <button
        id="combat-prev"
        type="button"
        onclick={() => combat && push(previousTurn(combat))}
        aria-label="Previous turn">◀</button
      >
      <span class="round">Round {combat.round} · Turn {combat.turn + 1}/{ordered.length}</span>
      <button
        id="combat-next"
        type="button"
        onclick={() => combat && push(nextTurn(combat))}
        aria-label="Next turn">▶</button
      >
      <button id="combat-init" type="button" onclick={rollInitiative}>Roll init</button>
      <button id="combat-end" type="button" onclick={() => combat && push(endCombat(combat))}
        >End</button
      >
    </div>
    <ol class="order">
      {#each ordered as c (c._id)}
        <li
          class:active={current?._id === c._id}
          class:defeated={c.defeated}
          class:delayed={Boolean((c.flags as { core?: { delayed?: boolean } })?.core?.delayed)}
        >
          <span class="name">{c.name}</span>
          <input
            class="init"
            type="number"
            value={c.initiative ?? ""}
            onchange={(e) => setInit(c, Number((e.target as HTMLInputElement).value))}
            aria-label={`Initiative for ${c.name}`}
          />
          <button type="button" onclick={() => combat && push(delayCombatant(combat, c._id))}
            >Delay</button
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
