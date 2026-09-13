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
  import {
    rollSelectedInitiative,
    manualInitiative,
    rollHiddenInitiative,
    hiddenInitiativeDisplay,
    verifyHiddenInitiativeReceipt,
  } from "./initiative";
  import {
    combatantBudget,
    isPf1eEncounter,
    spendCombatantActionAuthorized,
  } from "./actionBudget";
  import {
    activePF1eCombatant,
    isFlatFootedByRound,
    pf1eEndCombat,
    pf1eNextTurn,
    readCombatantState,
    readRoundState,
    startWithSurprise,
    type InitiativeRoll,
    type PF1eReadyTrigger,
  } from "../../packages/pf1e/combatState";
  import {
    delayTo,
    findReadied,
    readyCombatant,
  } from "../../packages/pf1e/readyDelay";
  import { resolveReadiedAction } from "./pf1eReadyAction";
  import { planDyingTick } from "./pf1eDyingTick";
  import { planFirstAid } from "./pf1eFirstAid";
  import { planCoupGrace } from "./pf1eCoupGrace";
  import { deriveFromDocuments } from "../../packages/pf1e/actor";
  import {
    healFirstAid,
    stabilizationCheck,
  } from "../../packages/pf1e/injury";
  import {
    awaitRollMessage,
    dieFaceOf,
  } from "../sheets/pf1eResolveFlow";
  import { resolveActionProvokes } from "./pf1eActionProvoke";
  import { autoResolveAoosOf } from "../../packages/pf1e/aooSettings";
  import { worldSettingsFrom as worldSettingsFromProvoke } from "../../core/worldSettings";
  import type { PF1eActionSpend } from "../../packages/pf1e/actions";
  import {
    advanceClockOnRoundOf,
    worldSettingsFrom,
  } from "../../core/worldSettings";
  import { wrapAdvanceOps } from "../../packages/pf1e/worldClock";
  import {
    selectedTokens,
    editSelectedRoster,
    type TokenSelection,
  } from "./tokenSelection";
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
  let actors = $state.raw<readonly ActorDocument[]>([]);
  let encounters = $state.raw<CombatDocument[]>([]);
  let error = $state("");
  let encounterName = $state("");
  const tokenChoice = $derived(
    scene
      ? selectedTokens(scene, selection, true)
      : { tokens: [], error: null },
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
    encounters = scene
      ? encounterList(state.combats, scene, state.legacySceneId)
      : [];
    const selected = scene
      ? selectedEncounter(state.combats, scene, state.legacySceneId)
      : null;
    if ((selected?._id ?? "") !== marksFor) {
      marksFor = selected?._id ?? "";
      unawareMarks = [];
    }
    combat = selected;
    actors = client.store.getAll("actors") as readonly ActorDocument[];
  }
  function activate(id: string): void {
    const state = context();
    const target = state.combats.find((c) => c._id === id);
    if (!state.scene || !target) {
      error = "Encounter is no longer available.";
      refresh();
      return;
    }
    const result = activateEncounter(
      state.scene,
      target,
      client.user,
      state.legacySceneId,
    );
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
    const activation = activateEncounter(
      state.scene,
      doc,
      client.user,
      state.legacySceneId,
    );
    if (activation.error) {
      error = activation.error;
      return;
    }
    client.submit([
      { kind: "create", coll: "combats", data: doc },
      ...activation.ops,
    ]);
    encounterName = "";
    error = "";
    if (start)
      for (const hook of startCombat(doc).hooks) globalHooks.callAll(hook, doc);
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
    for (const hook of transition.hooks)
      globalHooks.callAll(hook, transition.combat);
    if (!combat) return;
    client.submit([
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: {
          round: combat.round,
          turn: combat.turn,
          combatants: combat.combatants,
          flags: combat.flags,
        },
      },
    ]);
  }

  /** §10 "next turn". PF1e encounters route through pf1eNextTurn; when its transition wraps a
   * round it also reports clockDeltaSeconds, and this is where the replicated world clock
   * (E05, D-146) advances by it — if the world has advance-clock-on-round enabled. */
  function advanceTurn(): void {
    if (!combat) return;
    const snapshot = $state.snapshot(combat);
    if (!pf1e) {
      push(nextTurn(snapshot));
      return;
    }
    const result = pf1eNextTurn(snapshot, {
      actors: $state.snapshot(actors),
    });
    push(result);
    // D-205 — a dying creature's turn started: the panel rolls the round's
    // Constitution check publicly and writes the outcome (the transition
    // itself rolls no die).
    if (result.dyingChecks.length > 0) {
      dyingNotes = [];
      for (const check of result.dyingChecks) {
        void rollDyingCheck(check);
      }
    }
    if (result.clockDeltaSeconds > 0) {
      const settingsDocs = client.store.getAll("settings");
      if (advanceClockOnRoundOf(worldSettingsFrom(settingsDocs))) {
        const ops = wrapAdvanceOps(settingsDocs, result.clockDeltaSeconds);
        if (ops.length > 0) client.submit(ops);
      }
    }
  }

  function beginCombat(): void {
    refresh();
    if (!combat) {
      createEncounter(true);
      return;
    }
    if (!pf1e) {
      push(startCombat($state.snapshot(combat)));
      return;
    }
    // PF1e: the round structure starts through the surprise-aware transition. The GM's
    // awareness marks decide who is caught flat-footed; initiative must already be
    // rolled and its ties resolved.
    const roster = $state.snapshot(combat);
    if (roster.combatants.some((c) => c.initiative === null)) {
      error = "Roll initiative before starting a PF1e encounter.";
      return;
    }
    const rolls: InitiativeRoll[] = roster.combatants.map((c) => ({
      combatantId: c._id,
      value: c.initiative ?? 0,
      dexMod: 0,
    }));
    const started = startWithSurprise(roster, {
      initiative: rolls,
      unaware: unawareMarks,
    });
    if (started.state.ties.some((tie) => tie.resolvedBy === "reroll-needed")) {
      error = "Initiative ties are unresolved — use Roll all before starting.";
      return;
    }
    error =
      started.surprise?.note && !started.surprise.surpriseRound
        ? started.surprise.note
        : "";
    push({ combat: started.combat, hooks: started.hooks, expired: [] });
    unawareMarks = [];
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

  /** T02: GM-only hidden rolls — hidden members get real order, GM receipts, no public receipt. */
  function rollHidden(): void {
    refresh();
    const state = context();
    if (!combat || !state.scene) return;
    const result = rollHiddenInitiative(
      $state.snapshot(combat),
      state.scene,
      client.store.getAll("actors") as readonly ActorDocument[],
      client.user,
      () => {
        const roll = evaluateFormula("1d20");
        return roll.ok ? roll.value.total : NaN;
      },
      selection,
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

  const pf1e = $derived(combat ? isPf1eEncounter(combat, actors) : false);
  /** Spend from a combatant's PF1e action budget (T05); refusals land as panel errors. */
  function spendAction(id: string, spendKind: PF1eActionSpend): void {
    refresh();
    const state = context();
    const current = state.scene
      ? selectedEncounter(state.combats, state.scene, state.legacySceneId)
      : null;
    if (!current) {
      error = "Active encounter or permissions changed. Try again.";
      refresh();
      return;
    }
    const result = spendCombatantActionAuthorized(
      current,
      id,
      spendKind,
      client.user,
      client.store.getAll("actors") as readonly ActorDocument[],
    );
    error = result.error ?? "";
    if (!result.combat) return;
    combat = result.combat;
    for (const hook of result.hooks) globalHooks.callAll(hook, result.combat);
    client.submit([
      {
        kind: "update",
        ref: { coll: "combats", id: result.combat._id },
        diff: { combatants: result.combat.combatants },
      },
    ]);
  }

  const ordered = $derived(combat ? sortCombatants(combat.combatants) : []);
  const current = $derived(combat ? activePF1eCombatant(combat) : null);
  const pf1eState = $derived(combat ? readRoundState(combat) : null);
  /** A surprise round runs before core has started round 1 — it is a running tracker state. */
  const running = $derived(
    Boolean(combat && (combat.round >= 1 || pf1eState?.phase === "surprise")),
  );
  /** GM awareness marks for the surprise round (pre-start input, cleared on encounter switch). */
  let unawareMarks = $state<string[]>([]);
  let marksFor = $state("");
  function toggleUnaware(id: string): void {
    unawareMarks = unawareMarks.includes(id)
      ? unawareMarks.filter((x) => x !== id)
      : [...unawareMarks, id];
  }
  const effects = $derived(combat ? activeEffects(combat) : []);

  // ---- P07 (D-194): delay / ready controls. --------------------------------
  // `delayTo`/`readyCombatant`/`resolveReady` are the pure transitions from
  // `pf1e/readyDelay`; these fields just hold the GM's inline-form input, and the
  // handlers turn the result into the same `push` every other control uses.
  let delayFor = $state<string | null>(null);
  let delayValue = $state("");
  let readyFor = $state<string | null>(null);
  let readyAction = $state<"standard" | "move" | "swift" | "free">("standard");
  let readyTrigger = $state<PF1eReadyTrigger["kind"]>("attack");
  let readyTarget = $state("");
  let readyNote = $state("");
  let fireFor = $state<string | null>(null);
  let fireTarget = $state("");
  /** The declared trigger event kind the fire form matches readied actions against. */
  let fireTrigger = $state<PF1eReadyTrigger["kind"]>("attack");
  /** The last fired readied action, so the GM knows to resolve it now. */
  let firedNote = $state("");
  /** D-205 — the last dying round's stabilization lines, one per check. */
  let dyingNotes = $state<string[]>([]);
  // D-206 — first aid (DC 15 Heal, standard, provokes) and coup de grâce
  // (full-round, provokes, auto crit + Fort DC 10+damage).
  let firstAidHelperId = $state("");
  let firstAidTargetId = $state("");
  let firstAidHealBonus = $state("");
  let firstAidNote = $state("");
  let firstAidBusy = $state(false);
  let coupAttackerId = $state("");
  let coupTargetId = $state("");
  let coupWeaponIndex = $state(0);
  let coupDamage = $state("");
  let coupNote = $state("");
  let coupBusy = $state(false);

  /**
   * D-205 — roll one dying creature's stabilization check through the host,
   * apply `injury.ts`'s verdict, and write the outcome (the Stable condition
   * on a success, the lost hit point on a failure, the death annotation when
   * the loss crosses negative Constitution).
   */
  async function rollDyingCheck(check: {
    combatantId: string;
    actorId: string;
    actorName: string;
    hp: number;
    conMod: number;
  }): Promise<void> {
    const rollId = client.roll(
      `1d20 + ${String(check.conMod)}`,
      "roll",
      undefined,
      `${check.actorName} dying stabilization check (DC 10, penalty for negative HP)`,
    );
    const message = await awaitRollMessage(client, rollId);
    const die = message === null ? null : dieFaceOf(message);
    if (die === null) {
      dyingNotes = [
        ...dyingNotes,
        `${check.actorName} — the stabilization roll never arrived`,
      ];
      return;
    }
    const verdict = stabilizationCheck({
      die,
      conMod: check.conMod,
      hp: check.hp,
      purpose: "stabilize",
    });
    const actor = client.store.get("actors", check.actorId) as
      | ActorDocument
      | undefined;
    if (actor === undefined) {
      dyingNotes = [
        ...dyingNotes,
        `${check.actorName} — the actor is no longer available`,
      ];
      return;
    }
    const conScore = readConScore(actor);
    const plan = planDyingTick({
      actor,
      verdict,
      conScore,
    });
    if (plan.ops.length > 0) client.submit(plan.ops);
    dyingNotes = [...dyingNotes, plan.note];
  }

  /** The authored Constitution score, for the death annotation. */
  function readConScore(actor: ActorDocument): number {
    const abilities = (
      actor.system as { pf1e?: { abilities?: Record<string, unknown> } }
    ).pf1e?.abilities;
    const con = abilities?.con;
    return typeof con === "number" && Number.isFinite(con) ? con : 0;
  }

  function doDelay(id: string): void {
    refresh();
    if (!combat || !pf1e) return;
    const result = delayTo($state.snapshot(combat), id, Number(delayValue));
    error = result.ok ? "" : result.error;
    if (!result.ok) return;
    delayFor = null;
    delayValue = "";
    push(result.value);
  }

  function doReady(id: string): void {
    refresh();
    if (!combat || !pf1e) return;
    const action: PF1eActionSpend =
      readyAction === "move"
        ? { kind: "move" }
        : readyAction === "swift"
          ? { kind: "swift" }
          : readyAction === "free"
            ? { kind: "free" }
            : { kind: "standard", action: "attack" };
    const trigger: PF1eReadyTrigger = {
      kind: readyTrigger,
      ...(readyTarget ? { targetId: readyTarget } : {}),
      ...(readyNote.trim() ? { note: readyNote.trim() } : {}),
    };
    const result = readyCombatant($state.snapshot(combat), id, {
      action,
      trigger,
    });
    error = result.ok ? "" : result.error;
    if (!result.ok) return;
    readyFor = null;
    readyNote = "";
    readyTarget = "";
    push(result.value);
  }

  async function doFireReady(readiedId: string): Promise<void> {
    refresh();
    if (!combat || !pf1e) return;
    const triggererId = fireTarget || current?._id || "";
    const outcome = await resolveReadiedAction({
      client,
      user: client.user,
      combat: $state.snapshot(combat),
      readiedCombatantId: readiedId,
      triggererCombatantId: triggererId,
    });
    error = outcome.error ?? "";
    if (!outcome.ok || outcome.combat === null) return;
    const name =
      outcome.combat.combatants.find((c) => c._id === readiedId)?.name ??
      readiedId;
    firedNote = outcome.resolved
      ? `${name}'s readied ${outcome.action?.kind ?? "action"} action fires — ${outcome.lines.join(" ")}`
      : outcome.lines.join(" ");
    fireFor = null;
    fireTarget = "";
    push({ combat: outcome.combat, hooks: outcome.hooks, expired: [] });
  }

  function healBonusOf(actorId: string): number {
    const actor = actors.find((a) => a._id === actorId);
    if (!actor) return 0;
    return deriveFromDocuments({
      actor: { system: actor.system as Record<string, unknown> },
    }).abilityMods.wis;
  }

  function fortBonusOf(actorId: string): number {
    const actor = actors.find((a) => a._id === actorId);
    if (!actor) return 0;
    return deriveFromDocuments({
      actor: { system: actor.system as Record<string, unknown> },
    }).saves.fort;
  }

  function tokenIdOfCombatant(combatantId: string): string | null {
    if (!combat) return null;
    return (
      combat.combatants.find((c) => c._id === combatantId)?.tokenId ?? null
    );
  }

  async function doFirstAid(): Promise<void> {
    firstAidNote = "";
    error = "";
    if (!firstAidHelperId || !firstAidTargetId) {
      error = "Pick a helper and a dying target for first aid.";
      return;
    }
    const helper = combat?.combatants.find((c) => c._id === firstAidHelperId);
    const target = client.store.get("actors", firstAidTargetId) as
      | ActorDocument
      | undefined;
    if (!helper || !target) {
      error = "The helper or target is no longer available.";
      return;
    }
    const parsedBonus = firstAidHealBonus.trim();
    const healMod =
      parsedBonus !== ""
        ? Number.parseInt(parsedBonus, 10)
        : healBonusOf(
            combat?.combatants.find((c) => c._id === firstAidHelperId)
              ?.actorId ?? "",
          );
    if (!Number.isFinite(healMod)) {
      error = "Heal bonus must be a number.";
      return;
    }
    // Standard action that provokes (A.13) — the AoO queue is shown before the die.
    const tokenId = tokenIdOfCombatant(firstAidHelperId);
    let provokeLines: string[] = [];
    if (tokenId !== null && combat) {
      const provoke = await resolveActionProvokes({
        client: client as unknown as Parameters<
          typeof resolveActionProvokes
        >[0]["client"],
        user: client.user,
        provokerTokenId: tokenId,
        provokes: [{ actionId: "stabilize-friend" }],
        autoResolve: autoResolveAoosOf(
          worldSettingsFromProvoke(client.store.getAll("settings")),
        ),
        combat: $state.snapshot(combat),
      });
      provokeLines = provoke.lines;
    }
    firstAidBusy = true;
    try {
      const flavor = `${helper.name} Heal check to stabilize ${target.name} (DC 15, standard action — provokes)`;
      const rollId = client.roll(
        `1d20 + ${String(healMod)}`,
        "roll",
        undefined,
        flavor,
      );
      const message = await awaitRollMessage(client, rollId);
      const die = message === null ? null : dieFaceOf(message);
      if (die === null) {
        firstAidNote = `${target.name} — the Heal roll never arrived`;
        return;
      }
      const verdict = healFirstAid({ die, healMod });
      const plan = planFirstAid({ actor: target, verdict });
      if (plan.ops.length > 0) client.submit(plan.ops);
      const prefix = provokeLines.length > 0 ? `${provokeLines.join(" · ")} · ` : "";
      firstAidNote = `${prefix}${plan.note}`;
    } finally {
      firstAidBusy = false;
    }
  }

  async function doCoupGrace(): Promise<void> {
    coupNote = "";
    error = "";
    if (!coupAttackerId || !coupTargetId) {
      error = "Pick an attacker and a helpless target for the coup de grâce.";
      return;
    }
    const attacker = combat?.combatants.find((c) => c._id === coupAttackerId);
    const defender = client.store.get("actors", coupTargetId) as
      | ActorDocument
      | undefined;
    if (!attacker || !defender) {
      error = "The attacker or target is no longer available.";
      return;
    }
    const defendersCon = readConScore(defender);
    // Damage: either the typed number or, when empty, roll the attacker's
    // first weapon's critical damage via the host (same dice-authority as
    // every other resolution).
    let damageDealt = Number.parseInt(coupDamage.trim(), 10);
    let rolledDamageNote = "";
    if (coupDamage.trim() === "" || Number.isNaN(damageDealt)) {
      const atkActor = actors.find((a) => a._id === attacker.actorId);
      if (atkActor) {
        const drv = deriveFromDocuments({
          actor: { system: atkActor.system as Record<string, unknown> },
        });
        const line = drv.attacks[coupWeaponIndex] ?? drv.attacks[0];
        if (line && line.damageDice) {
          const critFormula =
            line.damageBonus !== 0
              ? `${line.damageDice} + ${line.damageBonus} + ${line.damageDice} + ${line.damageBonus}`
              : `${line.damageDice} + ${line.damageDice}`;
          const rollId = client.roll(
            critFormula,
            "roll",
            undefined,
            `${attacker.name} coup de grâce critical damage vs ${defender.name}`,
          );
          const message = await awaitRollMessage(client, rollId);
          if (
            message?.roll !== null &&
            message?.roll !== undefined &&
            typeof message.roll.total === "number"
          ) {
            damageDealt = message.roll.total;
            rolledDamageNote = `rolled ${String(damageDealt)} (${critFormula}) — `;
          }
        }
      }
    }
    if (!Number.isFinite(damageDealt) || damageDealt < 0) {
      error = "Coup damage must be a non-negative number (or leave empty to roll the attacker's crit).";
      return;
    }
    const defenderFort = fortBonusOf(coupTargetId);
    const tokenId = tokenIdOfCombatant(coupAttackerId);
    let provokeLines: string[] = [];
    if (tokenId !== null && combat) {
      const provoke = await resolveActionProvokes({
        client: client as unknown as Parameters<
          typeof resolveActionProvokes
        >[0]["client"],
        user: client.user,
        provokerTokenId: tokenId,
        provokes: [{ actionId: "coup-de-grace" }],
        autoResolve: autoResolveAoosOf(
          worldSettingsFromProvoke(client.store.getAll("settings")),
        ),
        combat: $state.snapshot(combat),
      });
      provokeLines = provoke.lines;
    }
    coupBusy = true;
    try {
      const fortRollId = client.roll(
        `1d20 + ${String(defenderFort)}`,
        "roll",
        undefined,
        `${defender.name} Fort save vs coup de grâce (DC ${String(10 + damageDealt)})`,
      );
      const fortMessage = await awaitRollMessage(client, fortRollId);
      const saveDie = fortMessage === null ? null : dieFaceOf(fortMessage);
      if (saveDie === null) {
        coupNote = `${defender.name} — the Fort save never arrived`;
        return;
      }
      const result = planCoupGrace({
        attackerName: attacker.name,
        defender,
        damageDealt,
        saveDie,
        fortBonus: defenderFort,
        conScore: defendersCon,
      });
      if (!result.ok) {
        error = result.error;
        return;
      }
      if (result.plan.ops.length > 0) client.submit(result.plan.ops);
      const prefix =
        provokeLines.length > 0 ? `${provokeLines.join(" · ")} · ` : "";
      coupNote = `${prefix}${rolledDamageNote}${result.plan.note}`;
    } finally {
      coupBusy = false;
    }
  }

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
    >Click a token or drag a marquee from empty canvas to select. Middle/right
    drag or Shift-drag pans.</small
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
  {#if firedNote}<p role="status" data-fired-note>{firedNote}</p>{/if}
  {#if dyingNotes.length > 0}
    <p role="status" data-dying-note>{dyingNotes.join(" · ")}</p>
  {/if}
  <label
    >Encounter
    <select
      data-encounter-select
      value={combat?._id ?? ""}
      onchange={(e) => activate(e.currentTarget.value)}
    >
      <option value="" disabled>Select an encounter</option>
      {#each encounters as item (item._id)}<option value={item._id}
          >{item.name}</option
        >{/each}
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
    >{scene?.name ?? "No active scene"} · New encounters use selected tokens, or all
    scene tokens if none are selected; switching preserves progress.</small
  >
  {#if !combat || !running}
    <button
      id="combat-start"
      type="button"
      onclick={beginCombat}
      disabled={!combat && tokens.length === 0}
    >
      Start combat ({combat?.combatants.length ?? tokens.length} combatants)
    </button>
    {#if combat && pf1e}
      <div class="prestart-rolls" data-prestart-rolls>
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
        <button
          data-roll-hidden-initiative
          type="button"
          title="Roll initiative for hidden combatants only (GM). Real order, GM-only receipts, no public breakdown."
          onclick={() => rollHidden()}>Roll hidden</button
        >
        <small
          >PF1e encounters start through the surprise-aware transition: roll
          initiative (and resolve ties) before Start.</small
        >
      </div>
      <div class="unaware" data-unaware-setup>
        <span class="budget-title"
          >Surprise setup — mark who starts unaware (CRB p.178):</span
        >
        {#each ordered as c (c._id)}
          <button
            type="button"
            data-unaware-toggle={c._id}
            class:marked={unawareMarks.includes(c._id)}
            onclick={() => toggleUnaware(c._id)}
          >
            {c.name}: {unawareMarks.includes(c._id) ? "unaware" : "aware"}
          </button>
        {/each}
        <small
          >A surprise round happens when some but not all combatants are aware;
          the aware ones each take one standard or move action, the unaware
          don't act and are flat-footed. Marks are input for the start, not
          replicated state.</small
        >
      </div>
    {/if}
  {:else}
    <div class="bar">
      <button
        id="combat-prev"
        type="button"
        onclick={() => combat && push(previousTurn(combat))}
        aria-label="Previous turn">◀</button
      >
      <span class="round"
        >{pf1eState?.phase === "surprise"
          ? `Surprise round · ${
              pf1eState.surpriseOrder.length
                ? `${pf1eState.surpriseTurn + 1}/${pf1eState.surpriseOrder.length} aware`
                : "no aware combatants"
            }`
          : `Round ${combat.round} · ${
              ordered.length
                ? `Turn ${combat.turn + 1}/${ordered.length}`
                : "No combatants"
            }`}</span
      >
      <button
        id="combat-next"
        type="button"
        onclick={advanceTurn}
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
      <button
        data-roll-hidden-initiative
        type="button"
        title="Roll initiative for hidden combatants only (GM). Real order, GM-only receipts, no public breakdown."
        onclick={() => rollHidden()}>Roll hidden</button
      >
      <button
        id="combat-end"
        type="button"
        onclick={() =>
          combat &&
          push(
            pf1e
              ? { ...pf1eEndCombat($state.snapshot(combat)), expired: [] }
              : endCombat($state.snapshot(combat)),
          )}>End</button
      >
    </div>
    {#if pf1e && current}
      {@const budget = combatantBudget(combat, current._id, actors)}
      {#if budget}
        <div class="budget" data-action-budget={current._id}>
          <span class="budget-title">{current.name} actions:</span>
          <span
            class="chip"
            class:spent={budget.ledger.standardUsed}
            data-budget-standard
            >Std {budget.ledger.standardUsed ? "✓" : "○"}</span
          >
          <span
            class="chip"
            class:spent={budget.ledger.moveUsed}
            data-budget-move>Move {budget.ledger.moveUsed ? "✓" : "○"}</span
          >
          <span
            class="chip"
            class:spent={budget.ledger.swiftUsed || budget.ledger.swiftReserved}
            data-budget-swift
            >Swift {budget.ledger.swiftUsed || budget.ledger.swiftReserved
              ? "✓"
              : "○"}</span
          >
          <span
            class="chip"
            class:spent={budget.ledger.fiveFootStepUsed}
            data-budget-five-foot
            >5-ft {budget.ledger.fiveFootStepUsed ? "✓" : "○"}</span
          >
          {#if budget.ledger.movementFt > 0}
            <span class="chip spent" data-budget-moved
              >moved {budget.ledger.movementFt} ft</span
            >
          {/if}
          {#if budget.ledger.restriction !== "none"}
            <span
              class="chip pending"
              data-budget-restricted
              title="Surprise round / staggered: a single standard or move action, plus free and swift actions"
              >restricted: 1 std or move</span
            >
          {/if}
          {#if budget.ledger.fullRoundPending}
            <span
              class="chip pending"
              data-budget-pending={budget.ledger.fullRoundPending}
              >pending: {budget.ledger.fullRoundPending}</span
            >
          {/if}
          <button
            data-action-spend="standard"
            type="button"
            disabled={budget.refusals.standard !== null}
            title={budget.refusals.standard ?? "Spend the standard action"}
            onclick={() =>
              current && spendAction(current._id, { kind: "standard" })}
            >Std</button
          >
          <button
            data-action-spend="move"
            type="button"
            disabled={budget.refusals.move !== null}
            title={budget.refusals.move ?? "Spend the move action"}
            onclick={() =>
              current && spendAction(current._id, { kind: "move" })}
            >Move</button
          >
          <button
            data-action-spend="move-as-standard"
            type="button"
            disabled={budget.refusals.moveAsStandard !== null}
            title={budget.refusals.moveAsStandard ??
              "Move action in place of the standard"}
            onclick={() =>
              current &&
              spendAction(current._id, { kind: "move", asStandard: true })}
            >Move→Std</button
          >
          <button
            data-action-spend="swift"
            type="button"
            disabled={budget.refusals.swift !== null}
            title={budget.refusals.swift ?? "Spend the swift action"}
            onclick={() =>
              current && spendAction(current._id, { kind: "swift" })}
            >Swift</button
          >
          <button
            data-action-spend="full-round"
            type="button"
            disabled={budget.refusals.fullRound !== null}
            title={budget.refusals.fullRound ?? "Spend the full-round action"}
            onclick={() =>
              current && spendAction(current._id, { kind: "full-round" })}
            >Full-round</button
          >
          <button
            data-action-spend="five-foot-step"
            type="button"
            disabled={budget.refusals.fiveFootStep !== null}
            title={budget.refusals.fiveFootStep ?? "Take the 5-foot step"}
            onclick={() =>
              current && spendAction(current._id, { kind: "five-foot-step" })}
            >5-ft step</button
          >
          <button
            data-action-spend="start-full-round"
            type="button"
            disabled={budget.refusals.startFullRound !== null}
            title={budget.refusals.startFullRound ??
              "Start a full-round action with the standard action (complete it next round)"}
            onclick={() =>
              current &&
              spendAction(current._id, {
                kind: "start-full-round",
                action: "full-round",
              })}>Start full</button
          >
          <button
            data-action-spend="complete-full-round"
            type="button"
            disabled={budget.refusals.completeFullRound !== null}
            title={budget.refusals.completeFullRound ??
              "Complete the pending full-round action with the standard action"}
            onclick={() =>
              current &&
              spendAction(current._id, { kind: "complete-full-round" })}
            >Complete full</button
          >
        </div>
      {/if}
    {/if}
    <p class="initiative-note">
      Public rolls use linked PF1e sheet modifiers; generic actors use a flat
      d20. PF1e-containing roll batches resolve ties by total modifier, then
      recorded d20 roll-offs. Generic-only rolls and manual overrides retain
      stable ties. Selected rolls leave other results untouched; ties against
      unselected results keep stable order. Roll all is optional for full tie
      resolution. Initial rolls establish the first combatant; rerolls preserve
      the current combatant. Hidden rolls are blocked.
    </p>
    <ol class="order">
      {#each ordered as c (c._id)}
        <li
          class:active={current?._id === c._id}
          class:defeated={c.defeated}
          class:delayed={Boolean(
            (c.flags as { core?: { delayed?: boolean } })?.core?.delayed,
          )}
          class:hidden-row={c.hidden}
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
            value={hiddenInitiativeDisplay(c, client.user) === "?"
              ? ""
              : (c.initiative ?? "")}
            placeholder={c.hidden ? "?" : ""}
            disabled={c.hidden}
            title={c.hidden
              ? "Hidden combatant — value concealed (GM: see receipt)"
              : ""}
            onchange={(e) => setInit(c, (e.target as HTMLInputElement).value)}
            aria-label={`Initiative for ${c.name}`}
          />
          {#if c.hidden && (client.user?.role === "GM" || client.user?.role === "ASSISTANT")}
            {@const receipt = (
              c.flags as { pf1e?: { hiddenInitiative?: unknown } }
            )?.pf1e?.hiddenInitiative}
            {#if receipt}
              {@const verified = verifyHiddenInitiativeReceipt(receipt)}
              <details data-hidden-initiative-receipt>
                <summary
                  >Hidden roll {verified.ok
                    ? "✓ verified"
                    : "✗ invalid"}</summary
                >
                <pre>{JSON.stringify(receipt, null, 2)}</pre>
              </details>
            {/if}
          {/if}
          {#if !pf1e}
            <button
              type="button"
              title="Manual marker only; does not advance or reschedule a turn. Clears on turn start or round wrap."
              onclick={() => combat && push(delayCombatant(combat, c._id))}
              >Mark delayed</button
            >
          {/if}
          <button
            type="button"
            onclick={() =>
              combat && push(setDefeated(combat, c._id, !c.defeated))}
          >
            {c.defeated ? "Revive" : "Defeat"}
          </button>
          {#if pf1e && current?._id === c._id && !c.defeated}
            <button
              type="button"
              data-delay={c._id}
              title="Delay: act later at a lower initiative count — your initiative becomes that count permanently."
              onclick={() => {
                delayFor = delayFor === c._id ? null : c._id;
                delayValue = String(Math.max(0, (c.initiative ?? 0) - 1));
              }}>Delay</button
            >
            <button
              type="button"
              data-ready={c._id}
              title="Ready: spend your standard action to prepare an action with a trigger (does not provoke)."
              onclick={() => {
                readyFor = readyFor === c._id ? null : c._id;
              }}>Ready</button
            >
          {/if}
          {#if pf1e && readCombatantState(c).ready !== null}
            <span
              class="effect"
              data-readied={c._id}
              title={`Readied ${readCombatantState(c).ready?.action.kind} action — trigger: ${readCombatantState(c).ready?.trigger.kind}${readCombatantState(c).ready?.trigger.note ? ` (${readCombatantState(c).ready?.trigger.note})` : ""}`}
              >readied</span
            >
            {#if current && current._id !== c._id && !c.defeated}
              <button
                type="button"
                data-fire-ready={c._id}
                title="Fire the readied action now — it resolves just before the chosen combatant's action."
                onclick={() => {
                  fireFor = fireFor === c._id ? null : c._id;
                  fireTarget = current._id;
                  fireTrigger = readCombatantState(c).ready?.trigger.kind ?? "attack";
                }}>Fire ready</button
              >
            {/if}
          {/if}
          {#if pf1e && current?._id !== c._id}
            <button
              type="button"
              data-immediate-spend={c._id}
              title="Off-turn immediate action; consumes this combatant's next swift action."
              disabled={readCombatantState(c).swiftReserved}
              onclick={() =>
                spendAction(c._id, { kind: "immediate", onTurn: false })}
              >Immediate</button
            >
          {/if}
          {#if pf1e}
            {@const ff = isFlatFootedByRound(combat, c)}
            {#if ff.flatFooted}
              <span
                class="effect"
                data-flat-footed={ff.why}
                title={ff.why === "surprise"
                  ? "Caught unaware — flat-footed until they act"
                  : "Has not acted yet — flat-footed until their first turn"}
                >flat-footed</span
              >
            {/if}
          {/if}
          {#each effects.filter((e) => e.combatantId === c._id) as e (e.id)}
            <span class="effect" title={e.effect.name}
              >{e.effect.name}{e.duration !== null
                ? ` (${e.duration})`
                : ""}</span
            >
          {/each}
          {#if pf1e && delayFor === c._id}
            <div class="row-form" data-delay-form={c._id}>
              <label
                >Delay to
                <input
                  type="number"
                  bind:value={delayValue}
                  aria-label={`Delay ${c.name} to initiative`}
                /></label
              >
              <button
                type="button"
                data-confirm-delay={c._id}
                onclick={() => doDelay(c._id)}>Confirm delay</button
              >
              <button type="button" onclick={() => (delayFor = null)}
                >Cancel</button
              >
            </div>
          {/if}
          {#if pf1e && readyFor === c._id}
            <div class="row-form" data-ready-form={c._id}>
              <label
                >Action
                <select bind:value={readyAction} data-ready-action>
                  <option value="standard">standard</option>
                  <option value="move">move</option>
                  <option value="swift">swift</option>
                  <option value="free">free</option>
                </select></label
              >
              <label
                >Trigger
                <select bind:value={readyTrigger} data-ready-trigger>
                  <option value="attack">attack</option>
                  <option value="move">move</option>
                  <option value="cast">cast</option>
                  <option value="custom">custom</option>
                </select></label
              >
              <label
                >Target
                <select bind:value={readyTarget} data-ready-target>
                  <option value="">anyone</option>
                  {#each combat.combatants.filter((o) => o._id !== c._id && !o.defeated) as o (o._id)}
                    <option value={o._id}>{o.name}</option>
                  {/each}
                </select></label
              >
              <label
                >Note
                <input
                  bind:value={readyNote}
                  maxlength="120"
                  placeholder="when the orc enters the doorway"
                  data-ready-note
                /></label
              >
              <button
                type="button"
                data-confirm-ready={c._id}
                onclick={() => doReady(c._id)}>Confirm ready</button
              >
              <button type="button" onclick={() => (readyFor = null)}
                >Cancel</button
              >
            </div>
          {/if}
          {#if pf1e && fireFor === c._id}
            {@const matches = findReadied(combat, {
              kind: fireTrigger,
              triggererId: fireTarget,
            })}
            {@const selfMatch = matches.some((m) => m.combatantId === c._id)}
            <div class="row-form" data-fire-form={c._id}>
              <label
                >Trigger
                <select bind:value={fireTrigger} data-fire-trigger>
                  <option value="attack">attack</option>
                  <option value="move">move</option>
                  <option value="cast">cast</option>
                  <option value="custom">custom</option>
                </select></label
              >
              <label
                >Interrupts
                <select bind:value={fireTarget} data-fire-target>
                  {#each combat.combatants.filter((o) => o._id !== c._id && !o.defeated) as o (o._id)}
                    <option value={o._id}>{o.name}</option>
                  {/each}
                </select></label
              >
              <button
                type="button"
                data-confirm-fire={c._id}
                onclick={() => doFireReady(c._id)}>Fire</button
              >
              <button type="button" onclick={() => (fireFor = null)}
                >Cancel</button
              >
              <small
                class:match-ok={selfMatch}
                class:match-no={!selfMatch}
                data-fire-match={selfMatch ? c._id : undefined}
                data-fire-mismatch={selfMatch ? undefined : c._id}
              >
                {#if selfMatch}
                  ✓ {c.name}'s readied {readCombatantState(c).ready?.action.kind
                    ?? "action"} action matches this {fireTrigger} trigger — it
                  fires just before
                  {combat.combatants.find((o) => o._id === fireTarget)?.name ??
                    fireTarget}.
                {:else}
                  ✗ {c.name}'s readied {readCombatantState(c).ready?.action.kind
                    ?? "action"} action is armed for
                  {readCombatantState(c).ready?.trigger.kind ?? "?"}, not this
                  {fireTrigger} event — firing is the GM's call.
                {/if}
                {#if matches.length > (selfMatch ? 1 : 0)}
                  · also matching:
                  {matches
                    .filter((m) => m.combatantId !== c._id)
                    .map((m) => combat.combatants.find((o) => o._id === m.combatantId)?.name ?? m.combatantId)
                    .join(", ")}
                {/if}
              </small>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
  {#if pf1e && combat}
    <section class="resolve" data-first-aid aria-label="First aid (Heal DC 15)">
      <h4>First aid — stabilize a dying creature (DC 15 Heal, standard action — provokes)</h4>
      <label
        >Helper
        <select bind:value={firstAidHelperId} data-first-aid-helper>
          <option value="">— pick a helper —</option>
          {#each ordered as c (c._id)}
            <option value={c._id}>{c.name}</option>
          {/each}
        </select></label
      >
      <label
        >Dying target
        <select bind:value={firstAidTargetId} data-first-aid-target>
          <option value="">— pick a target —</option>
          {#each actors.filter((a) => {
            const pf1eBlock = (a.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
            const hp = typeof pf1eBlock.hp === "number" ? pf1eBlock.hp : null;
            return hp !== null && hp < 0;
          }) as actor (actor._id)}
            <option value={actor._id}>{actor.name}</option>
          {/each}
        </select></label
      >
      <label
        >Heal bonus
        <input
          bind:value={firstAidHealBonus}
          placeholder={firstAidHelperId
            ? String(healBonusOf(combat.combatants.find((c) => c._id === firstAidHelperId)?.actorId ?? ""))
            : "Wis mod"}
          size="4"
          data-first-aid-bonus
        /></label
      >
      <button
        type="button"
        disabled={firstAidBusy || !firstAidHelperId || !firstAidTargetId}
        onclick={() => void doFirstAid()}
        data-first-aid-submit>{firstAidBusy ? "Rolling…" : "First aid (DC 15)"}</button
      >
      {#if firstAidNote}<p class="note" data-first-aid-note>{firstAidNote}</p>{/if}
      <p class="note">On a success the target gains the Stable condition — the hourly wake check then applies instead of the round checks.</p>
    </section>
    <section class="resolve" data-coup-grace aria-label="Coup de grâce">
      <h4>Coup de grâce — helpless target (full-round action — provokes, auto hit & crit, Fort DC 10 + damage)</h4>
      <label
        >Attacker
        <select bind:value={coupAttackerId} data-coup-attacker>
          <option value="">— pick attacker —</option>
          {#each ordered as c (c._id)}
            <option value={c._id}>{c.name}</option>
          {/each}
        </select></label
      >
      <label
        >Helpless target
        <select bind:value={coupTargetId} data-coup-target>
          <option value="">— pick a target —</option>
          {#each actors.filter((a) => {
            const pf1eBlock = (a.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
            const hp = typeof pf1eBlock.hp === "number" ? pf1eBlock.hp : 0;
            const conds = Array.isArray(pf1eBlock.conditions) ? pf1eBlock.conditions as string[] : [];
            const helpless = conds.some((x) => ["helpless","paralyzed","unconscious","petrified","stable"].includes(x.toLowerCase()));
            const con = typeof (pf1eBlock.abilities as Record<string, unknown> | undefined)?.con === "number" ? (pf1eBlock.abilities as Record<string, unknown>).con as number : 10;
            const dying = hp < 0 && !(con > 0 && -hp >= con);
            return helpless || dying || hp <= 0;
          }) as actor (actor._id)}
            <option value={actor._id}>{actor.name}</option>
          {/each}
        </select></label
      >
      <label
        >Damage (crit, auto-hit)
        <input
          bind:value={coupDamage}
          placeholder="leave empty to roll crit"
          size="6"
          data-coup-damage
        /></label
      >
      {#if coupAttackerId}
        {@const atkActor = actors.find((a) => a._id === combat.combatants.find((c) => c._id === coupAttackerId)?.actorId)}
        {#if atkActor}
          {@const drv = deriveFromDocuments({ actor: { system: atkActor.system as Record<string, unknown> } })}
          <label
            >Weapon
            <select bind:value={coupWeaponIndex} data-coup-weapon>
              {#each drv.attacks as line, i (i)}
                <option value={i}>{line.name} {line.damageDice ?? ""} +{line.damageBonus}</option>
              {/each}
            </select></label
          >
        {/if}
      {/if}
      <button
        type="button"
        disabled={coupBusy || !coupAttackerId || !coupTargetId}
        onclick={() => void doCoupGrace()}
        data-coup-submit>{coupBusy ? "Resolving…" : "Deliver coup de grâce"}</button
      >
      {#if coupNote}<p class="note" data-coup-note>{coupNote}</p>{/if}
      <p class="note">A bow or crossbow may be used only while adjacent. Crit-immune creatures (e.g. construct) waive the damage and the save.</p>
    </section>
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
    flex-wrap: wrap;
  }
  .row-form {
    flex-basis: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .row-form .match-ok {
    color: #8fd68f;
  }
  .row-form .match-no {
    color: #d68f8f;
  }
  .order li.active {
    background: #2c4a6e;
  }
  .order li.hidden-row .name::after {
    content: " 🙈";
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
  .prestart-rolls {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .unaware {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .unaware button.marked {
    background: #5e2c2c;
  }
  .budget {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .budget .chip {
    border: 1px solid #3c4a5e;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
  }
  .budget .chip.spent {
    opacity: 0.55;
    text-decoration: line-through;
  }
  .budget .chip.pending {
    background: #463a2c;
  }
  .effect {
    background: #463a2c;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 11px;
  }
</style>
